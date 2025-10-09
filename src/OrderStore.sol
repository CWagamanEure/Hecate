//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "openzeppelin/contracts/access/Ownable.sol";
import {OrderTypes as OT} from "./types/OrderTypes.sol";
import {PermitTypes as PT} from "./types/PermitTypes.sol";

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

    address private immutable OWNER;
    address public manager;

    mapping(bytes32 => Commitment) public commits;
    mapping(bytes32 => RevealedOrder) public reveals;

    struct RevealedOrder {
        bytes32 commitId;
        OT.Order o;
        PT.Permit p;
    }

    //---------Events------------------
    event ManagerUpdated(
        address indexed oldManager,
        address indexed newManager
    );
    event commited(Commitment);

    //---------Errors--------------------
    error OrderStore__NotManager();
    error OrderStore__NotOwner();
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
    constructor(address _owner, address _manager) Ownable(_owner) {
        if (_owner == address(0)) revert OrderStore__AddressZeroUsed();
        OWNER = msg.sender;
        manager = _manager;
        emit ManagerUpdated(address(0), _manager);
    }

    //---------Functions--------------------
    function commit(
        address _trader,
        bytes32 _batchId,
        bytes32 _commitmentHash
    ) external onlyManager {
        commits[_batchId] = Commitment({
            trader: _trader,
            batchId: _batchId,
            commitmentHash: _commitmentHash,
            revealed: false,
            executed: false,
            slashed: false,
            cancelled: false
        });
        emit commited(commits[_batchId]); 
    }

    function getCommited() public view returns(commited){
        return 
    }
}
