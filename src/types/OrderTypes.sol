//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library OrderTypes {
    type BatchId is bytes32;
    type PairId is bytes32;
    type CommitId is bytes32;

    enum Side {
        BUY,
        SELL
    }

    enum Phase {
        COMMIT,
        REVEAL,
        CLEAR
    }

    struct Pair {
        address base;
        address quote;
    }

    struct Order {
        address base;
        address quote;
        Side side;
        uint256 sizeBase;
        uint256 bandBps;
        BatchId batchId;
        bytes32 salt;
    }

    struct Match {
        address buyer;
        address seller;
        uint256 price;
        uint256 sizeBase;
        Pair pair;
    }

    struct BatchConfig {
        bool exists;
        uint64 genesisTs;
        uint256 batchLength;
        uint256 commitSecs;
        uint256 revealSecs;
        uint256 maxBandBps;
        uint256 staleSecs;
        uint256 maxDevBps;
        address bondToken;
        uint96 bondAmount;
    }
}
