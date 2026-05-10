// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title HecateSettlementVerifier (v1 stub)
 * @notice On-chain verifier for Hecate batch-receipt engine signatures.
 *
 * v1 signing format (see shared/crypto/signing.ts):
 *
 *   hash = keccak256(canonicalJson(batchReceiptBody))
 *   sig  = secp256k1.sign(hash, engine_private_key)
 *
 * No EIP-191 prefix, no EIP-712 domain. Off-chain callers must therefore
 * compute the canonical-JSON body hash themselves and pass the resulting
 * bytes32 plus the 65-byte signature. EIP-712 migration is on the roadmap;
 * see docs/ROADMAP.md §5 and the TODO in shared/crypto/signing.ts.
 *
 * The contract is a minimal verifier adapter. It does not reproduce
 * canonical JSON, batch matching, settlement, or conservation invariants on
 * chain. It proves only: the supplied hash was signed by the supplied
 * engine address. That is the bridge from the JS verifier to an on-chain
 * audit trail.
 *
 * @dev Hardened against the obvious abuse:
 *   - rejects wrong-length signatures
 *   - rejects v not in {27, 28} (Solidity ecrecover semantics)
 *   - rejects high-s signatures (EIP-2 malleability)
 *   - rejects address(0) recovery
 */
contract HecateSettlementVerifier {
    /// secp256k1n / 2 — the EIP-2 upper bound for low-s signatures.
    bytes32 private constant S_UPPER_BOUND =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    event ReceiptVerified(bytes32 indexed hash, address indexed signer);

    /**
     * @notice Recover the signer of a Hecate v1 batch-receipt body hash.
     * @param hash  keccak256(canonicalJson(batchReceiptBody))
     * @param sig   65-byte engine signature, r || s || v with v ∈ {27, 28}
     * @return signer The recovered address, or address(0) on malformed input.
     */
    function recoverSigner(bytes32 hash, bytes calldata sig)
        public
        pure
        returns (address signer)
    {
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
        // ecrecover returns address(0) for invalid points; caller handles.
        return ecrecover(hash, v, r, s);
    }

    /**
     * @notice True iff `sig` recovers to `expectedEngine` for `hash`.
     * @dev Pure; no state read. Suitable for off-chain calls and on-chain audits.
     */
    function verifyEngineSignature(
        bytes32 hash,
        bytes calldata sig,
        address expectedEngine
    ) external pure returns (bool) {
        if (expectedEngine == address(0)) return false;
        address signer = recoverSigner(hash, sig);
        return signer != address(0) && signer == expectedEngine;
    }

    /**
     * @notice Verify and emit a ReceiptVerified event on success.
     * @dev Non-view variant that produces an on-chain audit trail. Reverts
     *      cleanly via the bool return on failure; never throws.
     */
    function verifyAndEmit(
        bytes32 hash,
        bytes calldata sig,
        address expectedEngine
    ) external returns (bool ok) {
        if (expectedEngine == address(0)) return false;
        address signer = recoverSigner(hash, sig);
        ok = signer != address(0) && signer == expectedEngine;
        if (ok) emit ReceiptVerified(hash, expectedEngine);
    }
}
