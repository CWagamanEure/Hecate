// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "../types/OrderTypes.sol";
import {AggregatorV3Interface} from "@chainlink/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

interface IPriceGuard {
    // -------- Views --------
    function manager() external view returns (address);

    function feeds(OT.PairId pid) external view returns (AggregatorV3Interface);

    function currentMid(OT.PairId pid) external view returns (uint256 pxX18, uint256 updatedAt);

    // -------- Admin --------
    function changeManager(address newManager) external;

    function setFeed(address baseToken, address quoteToken) external;
}
