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
        address owner;
        address token;
        address spender;
        uint256 maxAmount;
        uint256 deadline;
        bytes signature;
        bytes32 nonce;
        bytes32 orderHash;
        OT.BatchId batchId;
    }
}
