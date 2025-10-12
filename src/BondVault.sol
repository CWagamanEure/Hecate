//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "./types/OrderTypes.sol";
import {PermitTypes as PT} from "./types/PermitTypes.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {PermitExecutor} from "./libraries/PermitExecutor.sol";

contract BondVault is Ownable, ReentrancyGuard {
    //---------------Structs-------------------
    struct Bond {
        address trader;
        address token;
        uint96 amount;
        bool locked;
        bool claimed;
    }
    //--------------Variables---------------------

    address private s_manager;
    address private s_slashRecipient;
    address public immutable PERMIT2;

    mapping(OT.CommitId => Bond) public bonds;
    mapping(OT.CommitId => bool) public claimable;

    //-------------Events--------------------------
    event ManagerUpdated(address indexed oldManager, address indexed newManager);
    event BondLocked(bytes32 commitId, address indexed trader);
    //--------------Errors----------------------

    error BondVault__NotManager();
    error BondVault__BadState();

    //---------------Modifiers-----------------
    modifier onlyManager() {
        if (msg.sender != s_manager) revert BondVault__NotManager();
        _;
    }

    //-------------Constructor------------------

    constructor(address _manager, address _slashRecipient) Ownable(msg.sender) {
        s_manager = _manager;
        s_slashRecipient = _slashRecipient;
        emit ManagerUpdated(address(0), _manager);
    }

    //--------------------Functions----------------------

    function getBond(OT.CommitId commitId) external view returns (Bond memory) {
        return bonds[commitId];
    }

    function isLocked(OT.CommitId commitId) external view returns (bool) {
        return (bonds[commitId].locked);
    }

    function isClaimed(OT.CommitId commitId) external view returns (bool) {
        return (bonds[commitId].claimed);
    }

    //-----------Admin---------------------

    function changeManager(address newManager) external onlyOwner {
        address temp = s_manager;
        s_manager = newManager;
        emit ManagerUpdated(temp, newManager);
    }

    function setSlashRecipient(address recipient) external onlyOwner {}

    //---------Manager-----------------------

    //Lock a bond by pulling tokens with Permit2/EIP-2612
    function lockWithPermit(
        OT.CommitId commitId,
        address trader,
        address bondToken,
        uint96 bondAmount,
        PT.Permit calldata p
    ) external onlyManager nonReentrant {
        Bond storage b = bonds[commitId];
        if (b.locked) revert BondVault__BadState();
        PermitExecutor.pull(PERMIT2, trader, bondToken, address(this), bondAmount, p);
        b.trader = trader;
        b.token = bondToken;
        b.amount = bondAmount;
        b.locked = true;
        emit BondLocked(OT.CommitId.unwrap(commitId), trader);
    }

    //Lock a bond using ERC20 allowance to this vault
    function lockFrom(OT.CommitId commitId, address bondToken, uint96 bondAmount, address trader)
        external
        onlyManager
    {
        Bond storage b = bonds[commitId];
        if (b.locked) revert BondVault__BadState();

        SafeTransferLib.safeTransferFrom(bondToken, trader, address(this), bondAmount);
        b.trader = trader;
        b.token = bondToken;
        b.amount = bondAmount;
        b.locked = true;
        emit BondLocked(OT.CommitId.unwrap(commitId), trader);
    }

    function release(OT.CommitId commitId, address to) external onlyManager {}

    function slash(OT.CommitId commitId, address to, uint8 reason) external onlyManager {}

    //---------------------Internal----------------------
}
