// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AggregatorV3Interface} from "@chainlink/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {OrderTypes as OT} from "../types/OrderTypes.sol";

interface IPriceGuard {
    //---------------Views-------------------
    /// @notice Current manager address
    function manager() external view returns (address);

    /// @notice Accessor for public mapping `feeds`
    /// @dev Returns the configured Chainlink aggregators for a PairId
    function feeds(OT.PairId pid)
        external
        view
        returns (AggregatorV3Interface baseAgg, AggregatorV3Interface quoteAgg);

    /// @notice Get current mid price (1e18 scaled) and last update timestamp
    function currentMid(OT.PairId pid) external view returns (uint256 pxX18, uint256 updatedAt);

    //---------------Mutators----------------
    /// @notice Owner-only: change the manager address
    function changeManager(address newManager) external;

    /// @notice Owner-only: set Chainlink USD feeds for a base/quote token pair
    function setFeeds(address baseToken, address quoteToken, address baseUsdAgg, address quoteUsdAgg) external;
}
