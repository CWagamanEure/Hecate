//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "../types/OrderTypes.sol";

library OrderHashLib {
    // ------------ EIP-712 constants -----------------
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name, string version, uint256 chainId, address verifyingContract)");

    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "Order(address base, address quote, uint8 side, uint256 size, uint256 bandBps, bytes32 batchId, bytes32 salt, address trader)"
    );

    /// Commitment hash used during the commit phase. Calculated off-chain and compared on reveal
    function makeCommitmentHash(OT.Order memory o, address trader) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                o.base, o.quote, uint8(o.side), o.sizeBase, o.bandBps, OT.BatchId.unwrap(o.batchId), o.salt, trader
            )
        );
    }

    function makeOrderStructHash(OT.Order memory o) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                o.base,
                o.quote,
                uint8(o.side),
                o.sizeBase,
                o.bandBps,
                OT.BatchId.unwrap(o.batchId),
                o.salt
            )
        );
    }

    function makeEip712Digest(OT.Order memory o, address trader, bytes32 domainSeparator)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, makeOrderStructHash(o)));
    }

    function makeDomainSeparator(string memory name, string memory version, address verifyingContract, uint256 chainId)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifyingContract
            )
        );
    }

    //-----------IDs----------------------------------

    /**
     * Deterministic pair identifier used to look up per-pair config
     */
    function pairIdOf(OT.Pair memory p) public pure returns (OT.PairId) {
        return OT.PairId.wrap(keccak256(abi.encode(p.base, p.quote)));
    }

    /**
     * Deterministic pair identifier for a (pairId, index) on the specific chain and venue
     */
    function batchIdOf(bytes32 domainSeparator, OT.PairId pairId, uint64 index) internal view returns (OT.BatchId) {
        return OT.BatchId.wrap(keccak256(abi.encode(domainSeparator, OT.PairId.unwrap(pairId), index)));
    }

    /**
     * Deterministic pair identifier for commitment row in storage, used as primary key in OrderStore
     */
    function commitIdOf(address trader, OT.BatchId batchId, bytes32 commitmentHash)
        external
        pure
        returns (OT.CommitId)
    {
        OT.CommitId.wrap(keccak256(abi.encode(trader, OT.BatchId.unwrap(batchId), commitmentHash)));
    }
}
