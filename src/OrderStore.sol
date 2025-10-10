//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "openzeppelin/contracts/access/Ownable.sol";
import {OrderTypes as OT} from "./types/OrderTypes.sol";
import {PermitTypes as PT} from "./types/PermitTypes.sol";
import {OrderHashLib as OHL} from "./libraries/OrderHashLib.sol";

contract OrderStore is Ownable {
    //-------Structs---------------
    struct Commitment {
        address trader;
        bytes32 batchId;
        bytes32 commitmentHash;
        bool cancelled;
        bool revealed;
        bool executed;
        bool slashed;
    }
    //----------variables--------

    address public manager;

    //commitId to Commitment
    mapping(bytes32 => Commitment) public commits;
    //commitId to RevealedOrder
    mapping(bytes32 => RevealedOrder) public reveals;

    struct RevealedOrder {
        bytes32 commitId;
        OT.Order order;
        PT.Permit permit;
    }

    //---------Events------------------
    event ManagerUpdated(address indexed newManager);

    event commited(bytes32 commitId);
    event revealed(bytes32 commitId);

    //---------Errors--------------------
    error OrderStore__NotManager();
    error OrderStore__AddressZeroUsed();

    //---------Modifiers--------------------
    modifier addressZero(address value) {
        if (value == address(0)) revert OrderStore__AddressZeroUsed();
        _;
    }

    modifier onlyManager() {
        if (msg.sender != manager) revert OrderStore__NotManager();
        _;
    }

    //-----------Constructor------------
    constructor(address _manager) Ownable(msg.sender) {
        if (_manager == address(0)) revert OrderStore__AddressZeroUsed();
        manager = _manager;
        emit ManagerUpdated(_manager);
    }

    //---------Functions--------------------
    function commit(
        address _trader,
        bytes32 _batchId,
        bytes32 _commitmentHash
    ) external onlyManager {
        bytes32 commitId = OHL._commitId(_trader, _batchId, _commitmentHash);
        commits[commitId] = Commitment({
            trader: _trader,
            batchId: _batchId,
            commitmentHash: _commitmentHash,
            revealed: false,
            executed: false,
            slashed: false,
            cancelled: false
        });
        emit commited(commitId);
    }

    function reveal(
        bytes32 commitId,
        OT.Order calldata o,
        PT.Permit calldata p
    ) external onlyManager {
        Commitment storage c = commits[commitId];
        c.revealed = true;
        reveals[commitId] = RevealedOrder({
            commitId: commitId,
            order: o,
            permit: p
        });

        emit revealed(commitId);
    }

    function getCommited(
        bytes32 commitId
    ) public view returns (Commitment memory) {
        return commits[commitId];
    }

    function changeManager(
        address newManager
    ) public onlyOwner addressZero(newManager) {
        manager = newManager;
        emit ManagerUpdated(newManager);
    }
}
