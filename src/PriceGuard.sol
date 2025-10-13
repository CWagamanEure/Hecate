//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {PriceConverterLib as PCL} from "./libraries/PriceConverterLib.sol";
import {AggregatorV3Interface} from "@chainlink/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {IPriceGuard} from "./interfaces/IPriceGuard.sol";
import {OrderTypes as OT} from "./types/OrderTypes.sol";
import {OrderHashLib as OHL} from "./libraries/OrderHashLib.sol";
import {Ownable} from "@openzeppelin/access/Ownable.sol";

contract PriceGuard is IPriceGuard, Ownable {
    //--------------Structs----------------
    struct PairFeed {
        AggregatorV3Interface baseAgg;
        AggregatorV3Interface quoteAgg;
    }
    //----------------Variables-----------------

    address public manager;
    mapping(OT.PairId => PairFeed) public feeds;

    //---------------Events-----------------
    event ManagerUpdated(address indexed oldManager, address indexed newManager);
    event FeedsSet(bytes32 indexed pairId, address baseAgg, address quoteAgg);

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
    constructor(address _manager) Ownable(msg.sender) {
        if (_manager == address(0)) revert PriceGuard__AddressZero();
        manager = _manager;
        emit ManagerUpdated(address(0), _manager);
    }

    //----------------Functions--------------------
    function changeManager(address newManager) external onlyOwner {
        if (newManager == address(0)) revert PriceGuard__AddressZero();
        emit ManagerUpdated(manager, newManager);
        manager = newManager;
    }

    function setFeeds(address baseToken, address quoteToken, address baseUsdAgg, address quoteUsdAgg)
        external
        onlyOwner
        addressZero(baseUsdAgg, quoteUsdAgg)
    {
        OT.PairId pid = OHL.pairIdOf(OT.Pair({base: baseToken, quote: quoteToken}));
        feeds[pid] =
            PairFeed({baseAgg: AggregatorV3Interface(baseUsdAgg), quoteAgg: AggregatorV3Interface(quoteUsdAgg)});
        emit FeedsSet(OT.PairId.unwrap(pid), baseUsdAgg, quoteUsdAgg);
    }

    function currentMid(OT.PairId pid) public view returns (uint256 pxX18, uint256 updatedAt) {
        PairFeed storage pf = feeds[pid];
        if (address(pf.baseAgg) == address(0) || address(pf.quoteAgg) == address(0)) revert PriceGuard__FeedsNotSet();
        (pxX18, updatedAt) = PCL.getCurrentMid(pf.baseAgg, pf.quoteAgg);
    }
}
