// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {IOrderStore} from "../../src/interfaces/IOrderStore.sol";
import {OrderTypes as OT} from "../../src/types/OrderTypes.sol";
import {OrderHashLib as OHL} from "../../src/libraries/OrderHashLib.sol";

/// @notice Mock that faithfully mirrors OrderStore's surface for testing CrossingManager.
/// - Same events & errors (so revert selectors match).
/// - Same manager/owner pattern (so your tests calling changeManager(...) still work).
/// - Same storage exposures for assertions: commits(...) and reveals(...).
contract MockOrderStore is IOrderStore, Ownable {
    // -------- Storage --------
    address public manager;

    // commitId => Commitment
    mapping(OT.CommitId => OT.Commitment) public commits;
    // commitId => RevealedOrder
    mapping(OT.CommitId => OT.RevealedOrder) public reveals;

    // -------- Events (match real) --------
    event ManagerUpdated(address indexed oldManager, address indexed newManager);
    event Committed(bytes32 commitId);
    event CommitmentCancelled(bytes32 commitId, address trader);
    event Revealed(bytes32 commitId);

    // -------- Errors (match real) --------
    error OrderStore__BadState();
    error OrderStore__NotManager();
    error OrderStore__AddressZeroUsed();
    error OrderStore__PrevBatchNotFinalized(); // kept for selector parity (unused here)
    error OrderStore__BatchAlreadyFinalized(); // kept for selector parity (unused here)
    error OrderStore__RestrictedCommitment();
    error OrderStore__CallerNotTrader();

    // -------- Modifiers --------
    modifier onlyManager() {
        if (msg.sender != manager) revert OrderStore__NotManager();
        _;
    }

    modifier addressZero(address value) {
        if (value == address(0)) revert OrderStore__AddressZeroUsed();
        _;
    }

    // -------- Constructor --------
    constructor(address _manager) Ownable(msg.sender) {
        if (_manager == address(0)) revert OrderStore__AddressZeroUsed();
        manager = _manager;
        emit ManagerUpdated(address(0), _manager);
    }

    // -------- IOrderStore API (mirrors real) --------

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

        if (c.revealed || c.executed || c.slashed || c.cancelled) {
            revert OrderStore__RestrictedCommitment();
        }

        c.revealed = true;
        reveals[commitId] = OT.RevealedOrder({commitId: commitId, order: o});

        emit Revealed(OT.CommitId.unwrap(commitId));
    }

    function clear(OT.BatchId) external onlyManager returns (OT.Match[] memory) {
        return new OT.Match[](0);
    }

    function cancelCommit(address trader, OT.CommitId commitId) external onlyManager {
        OT.Commitment storage c = commits[commitId];

        if (c.trader != trader) revert OrderStore__CallerNotTrader();
        if (c.cancelled || c.revealed || c.executed) {
            revert OrderStore__BadState();
        }

        c.cancelled = true;
        emit CommitmentCancelled(OT.CommitId.unwrap(commitId), trader);
    }

    // -------- Views (helper parity) --------
    function getCommited(OT.CommitId commitId) external view returns (OT.Commitment memory) {
        return commits[commitId];
    }

    // -------- Admin (parity with real) --------
    function changeManager(address newManager) external onlyOwner addressZero(newManager) {
        emit ManagerUpdated(manager, newManager);
        manager = newManager;
    }
}
