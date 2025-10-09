//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library OrderTypes {
    enum Side {
        BUY,
        SELL
    }

    type BatchId is bytes32;

    struct Order {
        address base; //Base asset being traded
        address quote; //Pair asset
        Side side;
        uint256 size;
        uint256 bandBps;
        BatchId batchId;
        bytes32 salt;
        address trader;
    }

    struct Match {
        address buyer;
        address seller;
        uint256 price;
        uint256 size;
        BatchId batchId;
    }

    struct BatchConfig {
        uint256 batchLength;
        uint256 commitSecs;
        uint256 revealSecs;
        uint256 maxBandBps;
        address bondToken;
        uint256 bondAmount;
    }
}
