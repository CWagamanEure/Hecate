//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {AggregatorV3Interface} from "@chainlink/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

library PriceConverterLib {
    error PriceConverterLib__BadPrice();

    function getCurrentMid(AggregatorV3Interface baseUsd, AggregatorV3Interface quoteUsd)
        internal
        view
        returns (uint256 pxX18, uint256 updatedAt)
    {
        (, int256 b,, uint256 tb,) = baseUsd.latestRoundData();
        (, int256 q,, uint256 tq,) = quoteUsd.latestRoundData();
        if (!(b > 0 && q > 0)) revert PriceConverterLib__BadPrice();
        uint8 db = baseUsd.decimals();
        uint8 dq = quoteUsd.decimals();
        uint256 b18 = _to1e18(uint256(b), db);
        uint256 q18 = _to1e18(uint256(q), dq);
        pxX18 = (b18 * 1e18) / q18;
        updatedAt = tb < tq ? tb : tq;
    }

    function _to1e18(uint256 x, uint8 d) internal pure returns (uint256) {
        return d == 18 ? x : (d < 18 ? x * 10 ** (18 - d) : x / 10 ** (d - 18));
    }
}
