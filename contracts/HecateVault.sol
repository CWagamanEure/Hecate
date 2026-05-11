// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/security/ReentrancyGuard.sol";

/**
 * @title HecateVault (v1, Sepolia-demo)
 * @notice Prefunded custody for the Hecate batch-crossing engine.
 *
 * Agents deposit ETH + MockUSDC. The engine produces signed settlements
 * (delta-list per agent, signed with the engine's secp256k1 key). Anyone
 * can submit a settlement to this contract; the contract verifies the
 * signature, enforces conservation (Σ ETH delta = 0, Σ USDC delta = 0),
 * applies deltas, and emits a Settled event. Each batchId is single-use
 * to prevent replay.
 *
 * Per-agent balances and deltas are publicly observable on chain. This is
 * a deliberate v1 design choice that re-exposes inventory information
 * Hecate's pre-match privacy was designed to mitigate; see
 * docs/ROADMAP.md §3.2.a for the tradeoff and §3.2.b for a confidential
 * future direction (ZK / encrypted balances).
 *
 * Two distinct engine-signature formats exist in the system:
 *   - canonicalJson(batchReceiptBody) hash, signed for off-chain receipts
 *   - keccak256(abi.encode(batchId, agents, ethDeltas, usdcDeltas)),
 *     signed for THIS contract. Solidity cannot recompute canonical JSON,
 *     so the on-chain settlement uses a compact ABI-encoded preimage.
 *   The engine signs both with the same secp256k1 key, so the same
 *   address recovers from either signature.
 *
 * @dev v1 Sepolia demo only. Unaudited. Not for mainnet, not for real
 *      funds. ENGINE address is immutable; redeploy to change it.
 */
contract HecateVault is ReentrancyGuard {
    // ---- immutables ------------------------------------------------------

    /// @notice The engine address whose signature authorizes settleBatch.
    /// @dev    For the Hecate demo: 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
    ///         (derived from the published LOCAL_DEV_KEY).
    address public immutable ENGINE;

    /// @notice The ERC-20 used for the "USDC" leg of every market. Decimals
    ///         are not enforced here; the engine encodes amounts in the
    ///         token's native units.
    IERC20 public immutable USDC;

    // ---- balances --------------------------------------------------------

    mapping(address => uint256) public ethBalances;
    mapping(address => uint256) public usdcBalances;
    mapping(bytes32 => bool)    public consumedBatchIds;

    // ---- events ----------------------------------------------------------

    event Deposited(address indexed agent, address indexed token, uint256 amount);
    event Withdrawn(address indexed agent, address indexed token, uint256 amount);
    event Settled(bytes32 indexed batchId, uint256 numAgents);

    // ---- signature constants ---------------------------------------------

    /// @dev secp256k1n / 2 — EIP-2 low-s upper bound.
    bytes32 private constant S_UPPER_BOUND =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @dev Sentinel token for ETH in the Deposited/Withdrawn events.
    address private constant ETH_TOKEN = address(0);

    /// @notice Upper bound on agents per `settleBatch` call.
    /// @dev    Guards against a pathological batch that would exceed the
    ///         block gas limit. Real Hecate batches are O(10) agents; this
    ///         is several orders of magnitude over expected load.
    uint256 public constant MAX_AGENTS = 1000;

    // ---- constructor -----------------------------------------------------

    constructor(address engine, address usdc) {
        require(engine != address(0), "engine = 0");
        require(usdc   != address(0), "usdc = 0");
        ENGINE = engine;
        USDC   = IERC20(usdc);
    }

    // ---- deposits --------------------------------------------------------

    function depositETH() external payable {
        require(msg.value > 0, "amount = 0");
        ethBalances[msg.sender] += msg.value;
        emit Deposited(msg.sender, ETH_TOKEN, msg.value);
    }

    function depositUSDC(uint256 amount) external {
        require(amount > 0, "amount = 0");
        // pull first, increment after (defensive against ERC-20 returning false)
        bool ok = USDC.transferFrom(msg.sender, address(this), amount);
        require(ok, "USDC transferFrom failed");
        usdcBalances[msg.sender] += amount;
        emit Deposited(msg.sender, address(USDC), amount);
    }

    // ---- withdrawals -----------------------------------------------------

    function withdrawETH(uint256 amount) external nonReentrant {
        require(amount > 0, "amount = 0");
        uint256 bal = ethBalances[msg.sender];
        require(bal >= amount, "insufficient ETH");
        ethBalances[msg.sender] = bal - amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH send failed");
        emit Withdrawn(msg.sender, ETH_TOKEN, amount);
    }

    function withdrawUSDC(uint256 amount) external nonReentrant {
        require(amount > 0, "amount = 0");
        uint256 bal = usdcBalances[msg.sender];
        require(bal >= amount, "insufficient USDC");
        usdcBalances[msg.sender] = bal - amount;
        bool ok = USDC.transfer(msg.sender, amount);
        require(ok, "USDC transfer failed");
        emit Withdrawn(msg.sender, address(USDC), amount);
    }

    // ---- settlement ------------------------------------------------------

    /**
     * @notice Apply a batch of engine-signed deltas.
     * @param batchId       Unique batch identifier. Single-use.
     * @param agents        Agent addresses receiving deltas.
     * @param ethDeltas     Signed wei deltas; positive = credit, negative = debit.
     * @param usdcDeltas    Signed micro-USDC deltas (6 decimals).
     * @param engineSig     65-byte secp256k1 signature over
     *                      keccak256(abi.encode(batchId, agents, ethDeltas, usdcDeltas))
     *                      from the engine key whose address == ENGINE.
     *
     * Reverts on:
     *   - batchId previously consumed
     *   - empty batch / agents.length > MAX_AGENTS
     *   - array length mismatch
     *   - any agents[i] == address(0)
     *   - Σ ethDeltas != 0 or Σ usdcDeltas != 0 (conservation)
     *   - signature recovery != ENGINE
     *   - any resulting agent balance < 0 (insolvent debit)
     */
    function settleBatch(
        bytes32 batchId,
        address[] calldata agents,
        int256[]  calldata ethDeltas,
        int256[]  calldata usdcDeltas,
        bytes     calldata engineSig
    ) external {
        require(!consumedBatchIds[batchId], "batch already settled");
        require(agents.length > 0,                       "empty batch");
        require(agents.length <= MAX_AGENTS,             "too many agents");
        require(agents.length == ethDeltas.length,       "len mismatch eth");
        require(agents.length == usdcDeltas.length,      "len mismatch usdc");

        // Conservation. Solidity 0.8+ checked arithmetic catches overflow.
        int256 ethSum;
        int256 usdcSum;
        for (uint256 i = 0; i < agents.length; i++) {
            ethSum  += ethDeltas[i];
            usdcSum += usdcDeltas[i];
        }
        require(ethSum  == 0, "eth conservation violated");
        require(usdcSum == 0, "usdc conservation violated");

        // Signature.
        bytes32 hash = keccak256(abi.encode(batchId, agents, ethDeltas, usdcDeltas));
        address signer = _recover(hash, engineSig);
        require(signer == ENGINE, "bad signer");

        // Apply.
        for (uint256 i = 0; i < agents.length; i++) {
            require(agents[i] != address(0), "zero agent");
            _applyEthDelta (agents[i], ethDeltas[i]);
            _applyUsdcDelta(agents[i], usdcDeltas[i]);
        }

        consumedBatchIds[batchId] = true;
        emit Settled(batchId, agents.length);
    }

    // ---- internal --------------------------------------------------------

    function _applyEthDelta(address agent, int256 delta) internal {
        if (delta == 0) return;
        if (delta > 0) {
            ethBalances[agent] += uint256(delta);
        } else {
            uint256 mag = uint256(-delta);
            uint256 bal = ethBalances[agent];
            require(bal >= mag, "insolvent eth delta");
            ethBalances[agent] = bal - mag;
        }
    }

    function _applyUsdcDelta(address agent, int256 delta) internal {
        if (delta == 0) return;
        if (delta > 0) {
            usdcBalances[agent] += uint256(delta);
        } else {
            uint256 mag = uint256(-delta);
            uint256 bal = usdcBalances[agent];
            require(bal >= mag, "insolvent usdc delta");
            usdcBalances[agent] = bal - mag;
        }
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > uint256(S_UPPER_BOUND)) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
