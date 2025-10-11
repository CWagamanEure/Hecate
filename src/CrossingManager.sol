//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PermitTypes as PT} from "./types/PermitTypes.sol";
import {ECDSA} from "openzeppelin/utils/cryptography/ECDSA.sol";
import {OrderTypes as OT} from "./types/OrderTypes.sol";
import {OrderStore} from "./OrderStore.sol";
import {IOrderStore} from "./interfaces/IOrderStore.sol";
import {OrderHashLib as OHL} from "./libraries/OrderHashLib.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";

contract CrossingManager is Ownable {
    string public constant NAME = "HECATEX";
    bytes32 public constant VENUE_ID = keccak256(abi.encode(NAME));
    string private s_version;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR =
        OHL.makeDomainSeparator(NAME, s_version, address(this), block.chainid);

    IOrderStore public immutable STORE;

    mapping(OT.PairId => OT.BatchConfig) public cfg;

    //-----------Events--------------------
    event Commited(bytes32);

    //-----------Errors-----------------
    error CrossingManager__BatchNotConfigured();
    error CrossingManager__NotCommitPhase();
    error CrossingManager__NotRevealPhase();
    error CrossingManager__NotClearPhase();
    error CrossingManager__NonexistentPairId();
    error CrossingManager__PairAlreadyExists();

    //--------Modifiers-----------------------

    //--------------Constructor-----------------------
    constructor(string memory _version, address store_, address bonds_, address vault_, address pg_)
        Ownable(msg.sender)
    {
        s_version = _version;

        STORE = IOrderStore(store_);
    }

    //---------time math-----------------------
    function currentIndex(OT.PairId pairId) public view returns (uint64 idx) {
        OT.BatchConfig storage c = cfg[pairId];
        if (c.batchLength == 0) revert CrossingManager__BatchNotConfigured();
        uint256 since = block.timestamp - c.genesisTs;
        return uint64(since / c.batchLength);
    }

    function batchTimes(OT.PairId pairId, uint64 idx)
        public
        view
        returns (uint256 tStart, uint256 tCommitEnd, uint256 tClear)
    {
        OT.BatchConfig storage c = cfg[pairId];
        if (c.batchLength == 0) revert CrossingManager__BatchNotConfigured();
        tStart = uint256(c.genesisTs) + uint256(idx) * c.batchLength;
        tCommitEnd = tStart + c.commitSecs;
        tClear = tStart + c.batchLength;
    }

    function phaseFor(OT.PairId pairId, uint64 idx) public view returns (OT.Phase) {
        (uint256 tStart, uint256 tCommitEnd, uint256 tClear) = batchTimes(pairId, idx);
        if (block.timestamp < tCommitEnd) return OT.Phase.COMMIT;
        if (block.timestamp < tClear) return OT.Phase.REVEAL;
        return OT.Phase.CLEAR;
    }

    //------------helpers----------------
    function getCurrentBatch(OT.PairId pairId) public view returns (OT.BatchId bid, uint64 idx, OT.Phase p) {
        idx = currentIndex(pairId);
        p = phaseFor(pairId, idx);
        bid = OHL.batchIdOf(VENUE_ID, block.chainid, pairId, idx);
    }

    //----------Main Functionality-----------------------
    function commit(OT.PairId pairId, bytes32 commitmentHash, PT.Permit calldata bondPermit)
        external
        returns (OT.CommitId)
    {
        (OT.BatchId bid,, OT.Phase phase) = getCurrentBatch(pairId);
        if (phase != OT.Phase.COMMIT) revert CrossingManager__NotCommitPhase();
        //COLLECT BOND

        address trader = bondPermit.spender;
        OT.CommitId commitId = STORE.commit(trader, bid, commitmentHash);
        emit Commited(OT.CommitId.unwrap(commitId));
        return commitId;
    }

    function reveal(OT.CommitId cid, OT.PairId pairId, OT.Order calldata o, PT.Permit calldata p) external {
        (OT.BatchId bid,, OT.Phase phase) = getCurrentBatch(pairId);
        if (phase != OT.Phase.REVEAL) revert CrossingManager__NotRevealPhase();

        STORE.reveal(cid, o, p);
    }

    function clear(OT.PairId pairId) external {
        (OT.BatchId bid,, OT.Phase phase) = getCurrentBatch(pairId);
        if (phase != OT.Phase.CLEAR) revert CrossingManager__NotClearPhase();
    }

    function cancelCommit(OT.PairId pairId, OT.CommitId commitId) public {
        (OT.BatchId bid,, OT.Phase phase) = getCurrentBatch(pairId);
        if (phase != OT.Phase.COMMIT) revert CrossingManager__NotCommitPhase();
        STORE.cancelCommit(msg.sender, commitId);
    }

    function domainSeparator() public view returns (bytes32) {
        return _CACHED_DOMAIN_SEPARATOR;
    }

    function listPair(address base, address quote, OT.BatchConfig memory batchConfig) public onlyOwner {
        OT.PairId pairId = OHL.pairIdOf(OT.Pair(base, quote));
        if (cfg[pairId].exists) revert CrossingManager__PairAlreadyExists();

        cfg[pairId] = batchConfig;
    }

    function _isValidSig(bytes32 digest, bytes calldata sig, address expected) internal pure returns (bool) {
        return ECDSA.recover(digest, sig) == expected;
    }
}
