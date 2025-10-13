//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {OrderTypes as OT} from "./types/OrderTypes.sol";
import {PermitTypes as PT} from "./types/PermitTypes.sol";
import {OrderHashLib as OHL} from "./libraries/OrderHashLib.sol";
import {IOrderStore} from "./interfaces/IOrderStore.sol";

contract OrderStore is IOrderStore, Ownable {
    //-------Structs---------------

    //----------variables--------

    address public manager;

    //commitId to Commitment
    mapping(OT.CommitId => OT.Commitment) public commits;
    //commitId to RevealedOrder
    mapping(OT.CommitId => OT.RevealedOrder) public reveals;

    //---------Events------------------
    event ManagerUpdated(address indexed oldManager, address indexed newManager);
    event Committed(bytes32 commitId);
    event CommitmentCancelled(bytes32, address);
    event Revealed(bytes32 commitId);

    //---------Errors--------------------
    error OrderStore__BadState();
    error OrderStore__NotManager();
    error OrderStore__AddressZeroUsed();
    error OrderStore__PrevBatchNotFinalized();
    error OrderStore__BatchAlreadyFinalized();
    error OrderStore__RestrictedCommitment();
    error OrderStore__CallerNotTrader();

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
        emit ManagerUpdated(address(0), _manager);
    }

    //---------Functions--------------------
    function commit(address _trader, OT.BatchId _batchId, bytes32 _commitmentHash)
        external
        onlyManager
        returns (OT.CommitId)
    {
        OT.CommitId commitId = OHL.commitIdOf(_trader, _batchId, _commitmentHash);
        commits[commitId] = OT.Commitment({
            trader: _trader,
            batchId: _batchId,
            commitmentHash: _commitmentHash,
            revealed: false,
            executed: false,
            slashed: false,
            cancelled: false
        });
        emit Committed(OT.CommitId.unwrap(commitId));
        return commitId;
    }

    function reveal(OT.CommitId commitId, OT.Order calldata o) external onlyManager {
        OT.Commitment storage c = commits[commitId];
        if (c.revealed == true || c.executed == true || c.slashed == true || c.cancelled == true) {
            revert OrderStore__RestrictedCommitment();
        }
        c.revealed = true;
        reveals[commitId] = OT.RevealedOrder({commitId: commitId, order: o});

        emit Revealed(OT.CommitId.unwrap(commitId));
    }

    function cancelCommit(address trader, OT.CommitId commitId) external onlyManager {
        OT.Commitment storage commitment = commits[commitId];
        if (commitment.trader != trader) revert OrderStore__CallerNotTrader();
        if (commitment.cancelled || commitment.revealed || commitment.executed) {
            revert OrderStore__BadState();
        }
        commitment.cancelled = true;
        emit CommitmentCancelled(OT.CommitId.unwrap(commitId), trader);
    }

    //----------------View---------------
    function getCommited(OT.CommitId commitId) public view returns (OT.Commitment memory) {
        return commits[commitId];
    }

    //--------------------Admin--------------
    function changeManager(address newManager) public onlyOwner addressZero(newManager) {
        emit ManagerUpdated(manager, newManager);
        manager = newManager;
    }
}
