//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {CrossingManager} from "../src/CrossingManager.sol";
import {OrderStore} from "../src/OrderStore.sol";
import {OrderTypes as OT} from "../src/types/OrderTypes.sol";
import {PermitTypes as PT} from "../src/types/PermitTypes.sol";
import {OrderHashLib as OHL} from "../src/libraries/OrderHashLib.sol";

contract CrossingManagerTest is Test {
    CrossingManager cm;
    OrderStore store;

    address bonds = makeAddr("bonds");
    address vault = makeAddr("vault");
    address pg = makeAddr("pg");

    address owner = address(this);
    address trader = makeAddr("trader");
    address stranger = makeAddr("stranger");
    address bondToken = address(0xC01);
    address base = address(0xB01);
    address quote = address(0xB02);

    OT.PairId pairId;

    function setUp() public {
        store = new OrderStore(address(0xdead));
        cm = new CrossingManager("1", address(store), bonds, vault, pg);

        vm.prank(store.owner());
        store.changeManager(address(cm));

        OT.BatchConfig memory bc = OT.BatchConfig({
            exists: true,
            genesisTs: uint64(block.timestamp),
            batchLength: 30 minutes,
            commitSecs: 10 minutes,
            revealSecs: 20 minutes,
            maxBandBps: 5,
            staleSecs: 10,
            maxDevBps: 10,
            bondToken: bondToken,
            bondAmount: 10
        });

        pairId = OHL.pairIdOf(OT.Pair(base, quote));

        vm.prank(owner);
        cm.listPair(base, quote, bc);
    }

    function _permit(OT.BatchId bid) internal view returns (PT.Permit memory) {
        return PT.Permit({
            kind: PT.PermitKind.PERMIT2,
            owner: trader,
            token: base,
            spender: trader,
            maxAmount: 1e18,
            deadline: block.timestamp + 1 days,
            signature: new bytes(65),
            nonce: 0,
            orderHash: bytes32(0),
            batchId: bid
        });
    }

    function test_listPair_revertsOnDuplicate() public {
        OT.BatchConfig memory bc2 = OT.BatchConfig({
            exists: true,
            genesisTs: uint64(block.timestamp),
            batchLength: 1 hours,
            commitSecs: 20 minutes,
            revealSecs: 40 minutes,
            maxBandBps: 5,
            staleSecs: 10,
            maxDevBps: 10,
            bondToken: bondToken,
            bondAmount: 10
        });
        vm.expectRevert(CrossingManager.CrossingManager__PairAlreadyExists.selector);
        vm.prank(owner);
        cm.listPair(base, quote, bc2);
    }

    function test_domainSeparator_matchesLibrary() public {
        bytes32 expected = OHL.makeDomainSeparator(cm.NAME(), "1", address(cm), block.chainid);
        assertEq(cm.domainSeparator(), expected, "domain sep should use version=1");
    }

    function test_commit_succeedsInCommitPhase_andStoresTrader() public {
        (OT.BatchId bid,, OT.Phase phase) = cm.getCurrentBatch(pairId);
        assertEq(uint8(phase), uint8(OT.Phase.COMMIT));

        PT.Permit memory p = _permit(bid);

        vm.prank(trader);
        OT.CommitId cid = cm.commit(pairId, keccak256("commitment"), p);

        (address tr,,,,,,) = store.commits(cid);
        assertEq(tr, trader, "trader should be recorded in store");
    }

    function test_commiy_revertsOutsideCommitPhase() public {
        (, uint64 idx,) = cm.getCurrentBatch(pairId);
        (uint256 tStart, uint256 tCommitEnd,) = cm.batchTimes(pairId, idx);
        vm.warp(tCommitEnd + 1);

        (OT.BatchId bid,, OT.Phase phase) = cm.getCurrentBatch(pairId);
        assertEq(uint8(phase), uint8(OT.Phase.REVEAL));

        PT.Permit memory p = _permit(bid);
        vm.expectRevert(CrossingManager.CrossingManager__NotCommitPhase.selector);
        cm.commit(pairId, keccak256("c"), p);
    }

    function test_reveal_phaseGuard_andSuccess() public {
        (OT.BatchId bid,,) = cm.getCurrentBatch(pairId);
        PT.Permit memory p = _permit(bid);
        OT.CommitId cid = cm.commit(pairId, keccak256("c-hash"), p);

        OT.Order memory o = OT.Order({
            base: base,
            quote: quote,
            side: OT.Side.BUY,
            sizeBase: 1e18,
            bandBps: 100,
            batchId: bid,
            salt: keccak256("s1")
        });

        vm.expectRevert(CrossingManager.CrossingManager__NotRevealPhase.selector);
        vm.prank(trader);
        cm.reveal(cid, pairId, o, p);

        (, uint64 idx,) = cm.getCurrentBatch(pairId);
        (,, uint256 tClear) = cm.batchTimes(pairId, idx);
        (uint256 tStart,,) = cm.batchTimes(pairId, idx);
        vm.warp(tStart + 11 minutes);

        vm.prank(trader);
        cm.reveal(cid, pairId, o, p);
        (,,,, bool revealed,,) = store.commits(cid);
        assertTrue(revealed);
    }

    function test_cancelCommit_onlyCommitPhase_andOnlyOwner() public {
        (OT.BatchId bid,,) = cm.getCurrentBatch(pairId);
        PT.Permit memory p = _permit(bid);
        vm.prank(trader);
        OT.CommitId cid = cm.commit(pairId, keccak256("cx"), p);

        vm.prank(stranger);
        vm.expectRevert(OrderStore.OrderStore__CallerNotTrader.selector);
        cm.cancelCommit(pairId, cid);

        vm.prank(trader);
        cm.cancelCommit(pairId, cid);
        (,,, bool cancelled,,,) = store.commits(cid);
        assertTrue(cancelled);

        (, uint64 idx,) = cm.getCurrentBatch(pairId);
        (uint256 tStart, uint256 tCommitEnd,) = cm.batchTimes(pairId, idx);
        vm.warp(tCommitEnd + 1);
        vm.prank(trader);
        vm.expectRevert(CrossingManager.CrossingManager__NotCommitPhase.selector);
        cm.cancelCommit(pairId, cid);
    }
}
