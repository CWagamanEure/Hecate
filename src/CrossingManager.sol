//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PermitTypes as PT} from "./types/PermitTypes.sol";
import {ECDSA} from "@openzeppelin/utils/cryptography/ECDSA.sol";
import {OrderTypes as OT} from "./types/OrderTypes.sol";
import {OrderStore} from "./OrderStore.sol";
import {IOrderStore} from "./interfaces/IOrderStore.sol";
import {OrderHashLib as OHL} from "./libraries/OrderHashLib.sol";
import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {IBondVault} from "./interfaces/IBondVault.sol";
import {IPriceGuard} from "./interfaces/IPriceGuard.sol";

contract CrossingManager is Ownable {
    string public constant NAME = "HECATEX";
    bytes32 public constant VENUE_ID = keccak256(abi.encode(NAME));
    string private s_version;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;

    IOrderStore public immutable STORE;
    IBondVault public immutable BOND;
    IPriceGuard public immutable PRICE_GUARD;

    mapping(OT.PairId => OT.BatchConfig) public cfg;
    mapping(OT.PairId => OT.BatchSnapshot) public snapshots;

    //-----------Events--------------------
    event Commited(bytes32, bytes32, address);
    event Revealed(bytes32, bytes32, address);
    event PairListed(address indexed base, address indexed quote);
    event FeedUpdated(uint256 pxX18, uint256 updatedAt);

    //-----------Errors-----------------
    error CrossingManager__CommitIdsDontMatch();
    error CrossingManager__PermitTooLow();
    error CrossingManager__PermitExpired();
    error CrossingManager__BatchNotConfigured();
    error CrossingManager__NotCommitPhase();
    error CrossingManager__NotRevealPhase();
    error CrossingManager__NotClearPhase();
    error CrossingManager__NonexistentPairId();
    error CrossingManager__PairAlreadyExists();
    error CrossingManager__AddressZero();
    error CrossingManager__WrongTokenPermit();
    error CrossingManager__PriceStale();

    //--------Modifiers-----------------------
    modifier addressZero(address input) {
        if (input == address(0)) revert CrossingManager__AddressZero();
        _;
    }

    //--------------Constructor-----------------------
    constructor(string memory _version, address store_, address bonds_, address guard_) Ownable(msg.sender) {
        s_version = _version;

        STORE = IOrderStore(store_);
        BOND = IBondVault(bonds_);
        PRICE_GUARD = IPriceGuard(guard_);
        _CACHED_DOMAIN_SEPARATOR = OHL.makeDomainSeparator(NAME, _version, address(this), block.chainid);
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

    function domainSeparator() public view returns (bytes32) {
        return _CACHED_DOMAIN_SEPARATOR;
    }

    //----------Main Functionality-----------------------
    function commit(OT.PairId pairId, bytes32 commitmentHash, PT.Permit calldata bondPermit)
        external
        returns (OT.CommitId)
    {
        (OT.BatchId bid,, OT.Phase phase) = getCurrentBatch(pairId);
        if (phase != OT.Phase.COMMIT) revert CrossingManager__NotCommitPhase();

        //Get IDs
        OT.CommitId cid = OHL.commitIdOf(msg.sender, bid, commitmentHash);

        //COLLECT BOND
        OT.BatchConfig memory batchConfig = cfg[pairId];
        address bondToken = batchConfig.bondToken;
        uint96 bondAmount = batchConfig.bondAmount;
        if (bondPermit.token != bondToken) {
            revert CrossingManager__WrongTokenPermit();
        }
        if (bondPermit.deadline <= block.timestamp) {
            revert CrossingManager__PermitExpired();
        }
        if (bondPermit.maxAmount < bondAmount) {
            revert CrossingManager__PermitTooLow();
        }

        BOND.lockWithPermit(cid, msg.sender, bondToken, bondAmount, bondPermit);

        //Send to OrderStore
        OT.CommitId commitId = STORE.commit(msg.sender, bid, commitmentHash);
        if (OT.CommitId.unwrap(commitId) != OT.CommitId.unwrap(cid)) {
            revert CrossingManager__CommitIdsDontMatch();
        }
        emit Commited(OT.CommitId.unwrap(commitId), OT.BatchId.unwrap(bid), msg.sender);
        return commitId;
    }

    function reveal(OT.CommitId cid, OT.PairId pairId, OT.Order calldata o) external {
        (OT.BatchId bid,, OT.Phase phase) = getCurrentBatch(pairId);
        if (phase != OT.Phase.REVEAL) revert CrossingManager__NotRevealPhase();

        //Compute and compare
        bytes32 commitmentHash = OHL.makeCommitmentHash(o, msg.sender);
        OT.CommitId computedCommitId = OHL.commitIdOf(msg.sender, bid, commitmentHash);
        if (OT.CommitId.unwrap(cid) != OT.CommitId.unwrap(computedCommitId)) {
            revert CrossingManager__CommitIdsDontMatch();
        }

        STORE.reveal(cid, o);
        emit Revealed(OT.CommitId.unwrap(cid), OT.BatchId.unwrap(bid), msg.sender);
    }

    function clear(OT.PairId pairId) external {
        (OT.BatchId bid,, OT.Phase phase) = getCurrentBatch(pairId);
        if (phase != OT.Phase.CLEAR) revert CrossingManager__NotClearPhase();
        OT.BatchConfig memory batchConfig = cfg[pairId];

        (uint256 px, uint256 ts) = PRICE_GUARD.currentMid(pairId);

        if (block.timestamp - ts > batchConfig.staleSecs) {
            revert CrossingManager__PriceStale();
        }
    }

    function cancelCommit(OT.PairId pairId, OT.CommitId commitId) external {
        (OT.BatchId bid,, OT.Phase phase) = getCurrentBatch(pairId);
        if (phase != OT.Phase.COMMIT) revert CrossingManager__NotCommitPhase();
        STORE.cancelCommit(msg.sender, commitId);
        BOND.setClaimable(commitId, true);
    }

    function updateFeed(OT.PairId pairId) external {
        (uint256 pxX18, uint256 updatedAt) = PRICE_GUARD.currentMid(pairId);
        snapshots[pairId] = OT.BatchSnapshot(pxX18, updatedAt);
        emit FeedUpdated(pxX18, updatedAt);
    }

    //-------------------Admin-------------------

    function listPair(address base, address quote, OT.BatchConfig memory batchConfig)
        public
        onlyOwner
        addressZero(base)
        addressZero(quote)
    {
        OT.PairId pairId = OHL.pairIdOf(OT.Pair(base, quote));
        if (cfg[pairId].exists) revert CrossingManager__PairAlreadyExists();
        batchConfig.exists = true;
        cfg[pairId] = batchConfig;
        PRICE_GUARD.setFeed(base, quote);
        emit PairListed(base, quote);
    }
}
