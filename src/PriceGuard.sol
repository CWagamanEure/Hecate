//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {PriceConverterLib as PCL} from "./libraries/PriceConverterLib.sol";
import {AggregatorV3Interface} from "@chainlink/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {IPriceGuard} from "./interfaces/IPriceGuard.sol";
import {OrderTypes as OT} from "./types/OrderTypes.sol";
import {OrderHashLib as OHL} from "./libraries/OrderHashLib.sol";
import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {ChainlinkFeedResolver as CFR} from "./ChainlinkFeedResolver.sol";

contract PriceGuard is IPriceGuard, Ownable {
    //----------------Variables-----------------

    address public manager;
    CFR public immutable FEED_RESOLVER;
    mapping(OT.PairId => AggregatorV3Interface) public feeds;

    //---------------Events-----------------
    event ManagerUpdated(address indexed oldManager, address indexed newManager);
    event FeedsSet(bytes32 indexed pairId, address agg);

    //---------------Errors------------------
    error PriceGuard__AddressZero();
    error PriceGuard__NotManager();
    error PriceGuard__FeedsNotSet();

    //-----------------Modifiers------------------
    modifier addressZero(address addy1, address addy2) {
        if (addy1 == address(0) || addy2 == address(0)) {
            revert PriceGuard__AddressZero();
        }
        _;
    }

    modifier onlyManager() {
        if (msg.sender != manager) revert PriceGuard__NotManager();
        _;
    }

    //---------------Constructor----------------
    constructor(address _manager, address registry) Ownable(msg.sender) {
        if (_manager == address(0)) revert PriceGuard__AddressZero();
        manager = _manager;
        FEED_RESOLVER = CFR(registry);

        emit ManagerUpdated(address(0), _manager);
    }

    //----------------Functions--------------------
    function changeManager(address newManager) external onlyOwner {
        if (newManager == address(0)) revert PriceGuard__AddressZero();
        emit ManagerUpdated(manager, newManager);
        manager = newManager;
    }

    function setFeed(address baseToken, address quoteToken) external onlyOwner {
        OT.PairId pid = OHL.pairIdOf(OT.Pair({base: baseToken, quote: quoteToken}));
        address agg = FEED_RESOLVER.resolveAgg(baseToken, quoteToken);
        if (agg == address(0)) revert PriceGuard__AddressZero();
        AggregatorV3Interface v3 = AggregatorV3Interface(agg);
        feeds[pid] = v3;
        emit FeedsSet(OT.PairId.unwrap(pid), agg);
    }

    function currentMid(OT.PairId pid) public view returns (uint256 pxX18, uint256 updatedAt) {
        AggregatorV3Interface v3 = feeds[pid];
        if (address(feeds[pid]) == address(0)) revert PriceGuard__FeedsNotSet();
        (pxX18, updatedAt) = PCL.getCurrentMid(v3);
    }
}
