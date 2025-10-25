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

    struct Bond {
        address trader;
        address token;
        uint96 amount;
        bool locked;
        bool claimed;
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

    struct Commitment {
        address trader;
        BatchId batchId;
        bytes32 commitmentHash;
        bool cancelled;
        bool revealed;
        bool executed;
        bool slashed;
    }

    struct RevealedOrder {
        CommitId commitId;
        Order order;
    }

    struct Match {
        CommitId buyerCommitId;
        CommitId sellerCommitId;
        uint256 baseFilled;
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

    struct BatchSnapshot {
        uint256 priceX18;
        uint256 feedUpdatedAt;
    }
}
