//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "./OrderTypes.sol";

library PermitTypes {
    enum PermitKind {
        EIP2612,
        PERMIT2
    }

    struct Permit {
        PermitKind kind;
        address token;
        uint256 maxAmount;
        uint256 deadline;
        bytes signature;
        uint256 nonce;
        bytes32 orderHash;
        OT.BatchId batchId;
    }

    function witness(bytes32 orderHash, OT.BatchId bid) internal pure returns (bytes32) {
        return keccak256(abi.encode(orderHash, OT.BatchId.unwrap(bid)));
    }
}
