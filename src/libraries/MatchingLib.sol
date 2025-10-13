//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "../types/OrderTypes.sol";

library MatchingLib {
    function resolve(OT.RevealedOrder[] memory buys, OT.RevealedOrder[] memory sells, uint256 priceX18)
        internal
        pure
        returns (OT.Match[] memory fills)
    {}
}
