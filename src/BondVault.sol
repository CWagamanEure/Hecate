//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "./types/OrderTypes.sol";
import {PermitTypes as PT} from "./types/PermitTypes.sol";
import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {PermitExecutor} from "./libraries/PermitExecutor.sol";
import {IBondVault} from "./interfaces/IBondVault.sol";

contract BondVault is IBondVault, Ownable, ReentrancyGuard {
    //---------------Variables-------------------

    address public manager;
    address private s_slashRecipient;
    address public immutable PERMIT2;

    mapping(OT.CommitId => OT.Bond) public bonds;
    mapping(OT.CommitId => bool) public claimable;

    //-------------Events--------------------------
    event SlashRecipientUpdated(address indexed newRecipient, address indexed oldRecipient);
    event ManagerUpdated(address indexed oldManager, address indexed newManager);
    event BondLocked(bytes32 commitId, address indexed trader);
    event BondClaimable(bytes32 indexed commitId, bool on);
    event BondReleased(bytes32 commitId, address trader, uint256 amount);
    event BondSlashed(bytes32 commitId, address sink, uint256 amount, uint8 reason);
    //--------------Errors----------------------

    error BondVault__AddressZero();
    error BondVault__NotTrader();
    error BondVault__NotManager();
    error BondVault__BadState();

    //---------------Modifiers-----------------
    modifier onlyManager() {
        if (msg.sender != manager) revert BondVault__NotManager();
        _;
    }

    modifier addressZero(address addy) {
        if (addy == address(0)) revert BondVault__AddressZero();
        _;
    }

    //-------------Constructor------------------

    constructor(address _manager, address _slashRecipient, address _permit2)
        addressZero(_manager)
        Ownable(msg.sender)
    {
        manager = _manager;
        s_slashRecipient = _slashRecipient;
        PERMIT2 = _permit2;
        emit ManagerUpdated(address(0), _manager);
    }

    //--------------------Functions----------------------

    //---------------------User-------------------------
    function claim(OT.CommitId commitId) external nonReentrant {
        OT.Bond storage b = bonds[commitId];
        if (!b.locked || b.claimed || !claimable[commitId]) {
            revert BondVault__BadState();
        }
        if (msg.sender != b.trader) revert BondVault__NotTrader();

        b.claimed = true;
        SafeTransferLib.safeTransfer(b.token, b.trader, b.amount);

        emit BondReleased(OT.CommitId.unwrap(commitId), b.trader, b.amount);
    }

    //----------------View-----------------------
    function getBond(OT.CommitId commitId) external view returns (OT.Bond memory) {
        return bonds[commitId];
    }

    function isLocked(OT.CommitId commitId) external view returns (bool) {
        return (bonds[commitId].locked);
    }

    function isClaimed(OT.CommitId commitId) external view returns (bool) {
        return (bonds[commitId].claimed);
    }

    function isClaimable(OT.CommitId commitId) external view returns (bool) {
        return claimable[commitId];
    }

    //-----------Admin---------------------

    function changeManager(address newManager) external onlyOwner addressZero(newManager) {
        address temp = manager;
        manager = newManager;
        emit ManagerUpdated(temp, newManager);
    }

    function setSlashRecipient(address newRecipient) external onlyOwner addressZero(newRecipient) {
        emit SlashRecipientUpdated(newRecipient, s_slashRecipient);
        s_slashRecipient = newRecipient;
    }

    //---------Manager-----------------------

    //Lock a bond by pulling tokens with Permit2/EIP-2612
    function lockWithPermit(
        OT.CommitId commitId,
        address trader,
        address bondToken,
        uint96 bondAmount,
        PT.Permit calldata p
    ) external onlyManager nonReentrant {
        OT.Bond storage b = bonds[commitId];
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
        OT.Bond storage b = bonds[commitId];
        if (b.locked) revert BondVault__BadState();

        SafeTransferLib.safeTransferFrom(bondToken, trader, address(this), bondAmount);
        b.trader = trader;
        b.token = bondToken;
        b.amount = bondAmount;
        b.locked = true;
        emit BondLocked(OT.CommitId.unwrap(commitId), trader);
    }

    function slash(OT.CommitId commitId, address to, uint8 reason) external onlyManager nonReentrant {
        OT.Bond storage b = bonds[commitId];
        if (!b.locked || b.claimed) revert BondVault__BadState();

        b.claimed = true;
        address sink = (to == address(0) ? s_slashRecipient : to);
        SafeTransferLib.safeTransfer(b.token, sink, b.amount);

        emit BondSlashed(OT.CommitId.unwrap(commitId), sink, b.amount, reason);
    }

    function setClaimable(OT.CommitId cid, bool on) external onlyManager {
        claimable[cid] = on;
        emit BondClaimable(OT.CommitId.unwrap(cid), on);
    }
}
