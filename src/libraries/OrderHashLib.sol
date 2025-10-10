//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "../types/OrderTypes.sol";

library OrderHashLib {
    // ------------ EIP-712 constants -----------------
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name, string version, uint256 chainId, address verifyingContract)"
        );

    bytes32 internal constant ORDER_TYPEHASH =
        keccak256(
            "Order(address base, address quote, uint8 side, uint256 size, uint256 bandBps, bytes32 batchId, bytes32 salt, address trader)"
        );

    /// @notice Commitment hash used during the commit phase.
    function _commitmentHash(
        OT.Order memory o,
        address trader
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    o.base,
                    o.quote,
                    uint8(o.side),
                    o.size,
                    o.bandBps,
                    OT.BatchId.unwrap(o.batchId),
                    o.salt,
                    trader
                )
            );
    }

    function _commitId(
        address trader,
        bytes32 batchId,
        bytes32 commitmentHash
    ) external pure returns (bytes32) {
        keccak256(abi.encode(trader, batchId, commitmentHash));
    }

    function _orderStructHash(
        OT.Order memory o,
        address trader
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    o.base,
                    o.quote,
                    uint8(o.side),
                    o.size,
                    o.bandBps,
                    OT.BatchId.unwrap(o.batchId),
                    o.salt,
                    trader
                )
            );
    }

    function _eip712Digest(
        OT.Order memory o,
        address trader,
        bytes32 domainSeparator
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    domainSeparator,
                    _orderStructHash(o, trader)
                )
            );
    }

    function _domainSeparator(
        string memory name,
        string memory version,
        address verifyingContract,
        uint256 chainId
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    keccak256(bytes(name)),
                    keccak256(bytes(version)),
                    chainId,
                    verifyingContract
                )
            );
    }
}
