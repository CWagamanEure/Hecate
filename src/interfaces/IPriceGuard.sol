//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "../types/OrderTypes.sol";

interface IPriceGuard {
    function snapshotMidPrice(OT.PairId pairId) external returns (uint256 priceX18, uint256 updatedAt);

    function currentMid(OT.PairId pairId) external returns (uint256 priceX18, uint256 updatedAt);

    function isFresh(uint256 updatedAt, uint256 staleSecs) external pure returns (bool);

    function withinDev(uint256 px, uint256 ref, uint256 maxDevBps) external pure returns (bool);
}
