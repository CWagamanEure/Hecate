//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {AggregatorV3Interface} from "@chainlink/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

library PriceConverterLib {
    error PriceConverterLib__BadPrice();

    function getCurrentMid(AggregatorV3Interface pairAgg) internal view returns (uint256, uint256) {
        (, int256 b,, uint256 tb,) = pairAgg.latestRoundData();
        if (!(b > 0)) revert PriceConverterLib__BadPrice();
        uint8 db = pairAgg.decimals();
        uint256 pxX18 = _to1e18(uint256(b), db);
        return (pxX18, tb);
    }

    function _to1e18(uint256 x, uint8 d) internal pure returns (uint256) {
        return d == 18 ? x : (d < 18 ? x * 10 ** (18 - d) : x / 10 ** (d - 18));
    }
}
