//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {FeedRegistryInterface} from "@chainlink/src/v0.8/interfaces/FeedRegistryInterface.sol";
import {AggregatorV3Interface} from "@chainlink/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {AggregatorV2V3Interface} from "@chainlink/src/v0.8/shared/interfaces/AggregatorV2V3Interface.sol";

contract ChainlinkFeedResolver {
    FeedRegistryInterface public immutable REG;

    //---------Constructor-----------
    constructor(address _registry) {
        REG = FeedRegistryInterface(_registry);
    }

    function resolveAgg(address base, address quote) external view returns (address agg) {
        try REG.getFeed(base, quote) returns (AggregatorV2V3Interface a) {
            agg = address(a);
        } catch {
            agg = address(0);
        }
    }
}
