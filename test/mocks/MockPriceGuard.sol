// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {OrderTypes as OT} from "../../src/types/OrderTypes.sol";
import {OrderHashLib as OHL} from "../../src/libraries/OrderHashLib.sol";
import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {AggregatorV3Interface} from "@chainlink/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @notice Minimal mock of PriceGuard for testing CrossingManager.
/// - setFeed(base, quote): marks the pair as "feed set".
/// - currentMid(pairId): returns scripted (pxX18, updatedAt) or reverts if feed not set.
/// - Helpers to script price/timestamp and unset feeds.
contract MockPriceGuard is IPriceGuard, Ownable {
    // Match real contract's error selector used by CM tests
    error PriceGuard__FeedsNotSet();

    struct Mid {
        uint256 pxX18;
        uint256 updatedAt;
        bool feedSet;
    }

    // pairId => mid state
    mapping(OT.PairId => Mid) private mids;
    address public manager;

    constructor(address _manager) Ownable(msg.sender) {
        manager = _manager;
    }

    /// @dev Called by CrossingManager.listPair(...). We just flag the pair as having a feed.
    function setFeed(address base, address quote) external {
        OT.PairId pid = OHL.pairIdOf(OT.Pair({base: base, quote: quote}));
        mids[pid].feedSet = true;
    }

    /// @dev Emulates the real PriceGuard read. Reverts if no feed set for this pair.
    function currentMid(OT.PairId pid) external view returns (uint256 pxX18, uint256 updatedAt) {
        Mid memory m = mids[pid];
        if (!m.feedSet) revert PriceGuard__FeedsNotSet();
        return (m.pxX18, m.updatedAt);
    }

    // ---------------------- Test helpers ----------------------

    /// @notice Script the mid price and timestamp for a given pairId.
    /// @dev You may call this before or after setFeed(); currentMid() still requires feedSet==true.
    function __setMid(OT.PairId pid, uint256 pxX18_, uint256 updatedAt_) external {
        mids[pid].pxX18 = pxX18_;
        mids[pid].updatedAt = updatedAt_;
    }

    /// @notice Unset the feed for a (base, quote) so currentMid() will revert again.
    function __unsetFeed(address base, address quote) external {
        OT.PairId pid = OHL.pairIdOf(OT.Pair({base: base, quote: quote}));
        delete mids[pid];
    }

    /// @notice Convenience getter for assertions in tests.
    function __isFeedSet(OT.PairId pid) external view returns (bool) {
        return mids[pid].feedSet;
    }

    function changeManager(address newManager) external onlyOwner {}

    function feeds(OT.PairId pid) external view returns (AggregatorV3Interface) {}
}
