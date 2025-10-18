// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IBondVault} from "../../src/interfaces/IBondVault.sol";
import {OrderTypes as OT} from "../../src/types/OrderTypes.sol";
import {PermitTypes as PT} from "../../src/types/PermitTypes.sol";
import {Ownable} from "@openzeppelin/access/Ownable.sol";

/// @notice Lightweight mock of BondVault for testing CrossingManager flows.
/// - No actual ERC20 transfers or Permit2 validation.
/// - Records locked bonds and claimable flags.
/// - Emits the same events as the real vault for event assertions.
/// - By default, does NOT gate calls with onlyManager to keep unit tests simple.
///   If you want to enforce manager-only calls in some tests, call __setManager(...)
///   and uncomment the `onlyManager` modifier uses.
contract MockBondVault is IBondVault, Ownable {
    // -------- Storage (parity-friendly) --------
    address public manager;
    address private _slashRecipient;
    address public immutable PERMIT2 = address(0); // unused in mock

    mapping(OT.CommitId => OT.Bond) public bonds;
    mapping(OT.CommitId => bool) public claimable;

    // For optional introspection in tests
    struct LastLock {
        OT.CommitId cid;
        address trader;
        address token;
        uint96 amount;
        PT.Permit permit; // beware: copies entire struct; fine for tests
    }

    LastLock public lastLock;

    // -------- Events (match real) --------
    event SlashRecipientUpdated(address indexed newRecipient, address indexed oldRecipient);
    event ManagerUpdated(address indexed oldManager, address indexed newManager);
    event BondLocked(bytes32 commitId, address indexed trader);
    event BondClaimable(bytes32 indexed commitId, bool on);
    event BondReleased(bytes32 commitId, address trader, uint256 amount);
    event BondSlashed(bytes32 commitId, address sink, uint256 amount, uint8 reason);

    // -------- Errors (match real) --------
    error BondVault__AddressZero();
    error BondVault__NotTrader();
    error BondVault__NotManager();
    error BondVault__BadState();

    // -------- Modifiers (opt-in) --------
    modifier onlyManager() {
        if (manager != address(0) && msg.sender != manager) {
            revert BondVault__NotManager();
        }
        _;
    }

    modifier addressZero(address a) {
        if (a == address(0)) revert BondVault__AddressZero();
        _;
    }

    // -------- Constructor --------
    constructor(address _manager) Ownable(msg.sender) {
        if (_manager == address(0)) revert BondVault__AddressZero();
        manager = _manager;
        emit ManagerUpdated(address(0), _manager);
    }

    // -------- IBondVault API (mirrors real signatures) --------

    /// @dev Simulate locking via Permit2; just records the bond.
    function lockWithPermit(
        OT.CommitId commitId,
        address trader,
        address bondToken,
        uint96 bondAmount,
        PT.Permit calldata p
    ) external /*onlyManager*/ {
        OT.Bond storage b = bonds[commitId];
        if (b.locked) revert BondVault__BadState();

        b.trader = trader;
        b.token = bondToken;
        b.amount = bondAmount;
        b.locked = true;

        lastLock = LastLock({cid: commitId, trader: trader, token: bondToken, amount: bondAmount, permit: p});

        emit BondLocked(OT.CommitId.unwrap(commitId), trader);
    }

    /// @dev Simulate locking via allowance; same behavior as lockWithPermit.
    function lockFrom(OT.CommitId commitId, address bondToken, uint96 bondAmount, address trader)
        external /*onlyManager*/
    {
        OT.Bond storage b = bonds[commitId];
        if (b.locked) revert BondVault__BadState();

        b.trader = trader;
        b.token = bondToken;
        b.amount = bondAmount;
        b.locked = true;

        lastLock = LastLock({
            cid: commitId,
            trader: trader,
            token: bondToken,
            amount: bondAmount,
            permit: PT.Permit({
                kind: PT.PermitKind.PERMIT2, // placeholder
                token: bondToken,
                maxAmount: bondAmount,
                deadline: type(uint256).max,
                signature: new bytes(0),
                nonce: 0,
                orderHash: bytes32(0),
                batchId: OT.BatchId.wrap(bytes32(0))
            })
        });

        emit BondLocked(OT.CommitId.unwrap(commitId), trader);
    }

    /// @dev Manager toggles claimable; CM calls this on cancel.
    function setClaimable(OT.CommitId cid, bool on) external /*onlyManager*/ {
        claimable[cid] = on;
        emit BondClaimable(OT.CommitId.unwrap(cid), on);
    }

    /// @dev Simulate user claim; enforces same basic state checks.
    function claim(OT.CommitId commitId) external /*nonReentrant*/ {
        OT.Bond storage b = bonds[commitId];
        if (!b.locked || b.claimed || !claimable[commitId]) {
            revert BondVault__BadState();
        }
        if (msg.sender != b.trader) revert BondVault__NotTrader();

        b.claimed = true;
        // no actual transfer in mock
        emit BondReleased(OT.CommitId.unwrap(commitId), b.trader, b.amount);
    }

    /// @dev Simulate slash; marks claimed and emits event.
    function slash(OT.CommitId commitId, address to, uint8 reason) external /*onlyManager nonReentrant*/ {
        OT.Bond storage b = bonds[commitId];
        if (!b.locked || b.claimed) revert BondVault__BadState();

        b.claimed = true;
        address sink = to == address(0) ? _slashRecipient : to;
        emit BondSlashed(OT.CommitId.unwrap(commitId), sink, b.amount, reason);
    }

    // -------- Views (test helpers) --------
    function getBond(OT.CommitId commitId) external view returns (OT.Bond memory) {
        return bonds[commitId];
    }

    function isLocked(OT.CommitId commitId) external view returns (bool) {
        return bonds[commitId].locked;
    }

    function isClaimed(OT.CommitId commitId) external view returns (bool) {
        return bonds[commitId].claimed;
    }

    function isClaimable(OT.CommitId commitId) external view returns (bool) {
        return claimable[commitId];
    }

    function setSlashRecipient(address newRecipient) external addressZero(newRecipient) onlyOwner {
        address old = _slashRecipient;
        _slashRecipient = newRecipient;
        emit SlashRecipientUpdated(newRecipient, old);
    }

    function changeManager(address newManager) external onlyOwner {
        emit ManagerUpdated(manager, newManager);
        manager = newManager;
    }
}
