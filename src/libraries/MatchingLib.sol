// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "../types/OrderTypes.sol";

library MatchingLib {
    /// @notice Greedy FIFO match: walks buys and sells once and produces fills.
    /// @dev Assumes all orders belong to the same batch and arrays are side-partitioned.
    function resolve(OT.RevealedOrder[] memory buys, OT.RevealedOrder[] memory sells)
        internal
        pure
        returns (OT.Match[] memory fills)
    {
        uint256 nB = buys.length;
        uint256 nS = sells.length;
        if (nB == 0 || nS == 0) {
            return new OT.Match[](0);
        }

        OT.Match[] memory tmp = new OT.Match[](nB + nS);

        uint256 i; // buys index
        uint256 j; // sells index
        uint256 k; // fills written

        uint256 buyRem; // remaining base on current buy
        uint256 sellRem; // remaining base on current sell

        while (i < nB && j < nS) {
            if (buyRem == 0) {
                uint256 szB = buys[i].order.sizeBase;
                if (szB == 0) {
                    unchecked {
                        ++i;
                    }
                    continue;
                }
                buyRem = szB;
            }

            if (sellRem == 0) {
                uint256 szS = sells[j].order.sizeBase;
                if (szS == 0) {
                    unchecked {
                        ++j;
                    }
                    continue;
                }
                sellRem = szS;
            }

            uint256 traded = buyRem < sellRem ? buyRem : sellRem;

            tmp[k++] =
                OT.Match({buyerCommitId: buys[i].commitId, sellerCommitId: sells[j].commitId, baseFilled: traded});

            unchecked {
                buyRem -= traded;
                sellRem -= traded;
                if (buyRem == 0) ++i;
                if (sellRem == 0) ++j;
            }
        }

        fills = new OT.Match[](k);
        for (uint256 t; t < k;) {
            fills[t] = tmp[t];
            unchecked {
                ++t;
            }
        }
    }

    /// @notice Computes total buy/sell base, dominance, and net base imbalance.
    function imbalance(OT.RevealedOrder[] memory buys, OT.RevealedOrder[] memory sells)
        internal
        pure
        returns (bool buyDominant, uint256 buyBase, uint256 sellBase, uint256 netBase)
    {
        for (uint256 x; x < buys.length;) {
            buyBase += buys[x].order.sizeBase;
            unchecked {
                ++x;
            }
        }
        for (uint256 y; y < sells.length;) {
            sellBase += sells[y].order.sizeBase;
            unchecked {
                ++y;
            }
        }
        if (buyBase >= sellBase) {
            buyDominant = true;
            netBase = buyBase - sellBase;
        } else {
            buyDominant = false;
            netBase = sellBase - buyBase;
        }
    }
}
