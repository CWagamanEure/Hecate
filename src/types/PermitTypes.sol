//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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
        bytes32 nonce;
        bytes32 orderHash;
        bytes32 batchId;
    }
}
