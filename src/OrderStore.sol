//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MatchingLib} from "./libraries/MatchingLib.sol";
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
    mapping(OT.BatchId => OT.CommitId[]) private _revealedByBatch;

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
        _revealedByBatch[c.batchId].push(commitId);

        emit Revealed(OT.CommitId.unwrap(commitId));
    }

    function clear(OT.BatchId bid) external onlyManager returns (OT.Match[] memory matches) {
        OT.CommitId[] storage ids = _revealedByBatch[bid];
        uint256 n = ids.length;
        if (n == 0) return new OT.Match[](0);

        // Count
        uint256 nB;
        uint256 nS;
        for (uint256 i; i < n;) {
            OT.CommitId cid = ids[i];

            OT.Commitment storage c = commits[cid];
            if (!c.cancelled && !c.executed && !c.slashed) {
                if (reveals[cid].order.side == OT.Side.BUY) ++nB;
                else ++nS;
            }
            unchecked {
                ++i;
            }
        }
        // Populate
        OT.RevealedOrder[] memory buys = new OT.RevealedOrder[](nB);
        OT.RevealedOrder[] memory sells = new OT.RevealedOrder[](nS);

        uint256 bi;
        uint256 si;
        for (uint256 i; i < n;) {
            OT.CommitId cid = ids[i];
            OT.Commitment storage c = commits[cid];
            if (!c.cancelled && !c.executed && !c.slashed) {
                //put into revealed order
                OT.Order memory o = reveals[cid].order;
                if (o.side == OT.Side.BUY) {
                    buys[bi++] = OT.RevealedOrder({commitId: cid, order: o});
                } else {
                    sells[si++] = OT.RevealedOrder({commitId: cid, order: o});
                }
            }
            unchecked {
                ++i;
            }
        }
        //Match
        matches = MatchingLib.resolve(buys, sells);
        for (uint256 k; k < matches.length;) {
            commits[matches[k].buyerCommitId].executed = true;
            commits[matches[k].sellerCommitId].executed = true;
            unchecked {
                ++k;
            }
        }
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
