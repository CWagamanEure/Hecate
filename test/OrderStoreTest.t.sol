//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";
import {OrderStore} from "../src/OrderStore.sol";
import {IOrderStore} from "../src/interfaces/IOrderStore.sol";
import {OrderTypes as OT} from "../src/types/OrderTypes.sol";
import {PermitTypes as PT} from "../src/types/PermitTypes.sol";
import {OrderHashLib as OHL} from "../src/libraries/OrderHashLib.sol";

contract OrderStoreTest is Test {
    OrderStore store;
    address owner = makeAddr("owner");
    address manager = makeAddr("manager");
    address trader = makeAddr("trader");
    address stranger = makeAddr("stranger");

    function _dummyOrder(OT.BatchId batchId) internal view returns (OT.Order memory) {
        return OT.Order({
            base: address(0xB01),
            quote: address(0xB02),
            side: OT.Side.BUY,
            sizeBase: 1e18,
            bandBps: 100,
            batchId: batchId,
            salt: keccak256("salt-1")
        });
    }

    function _dummyPermit(OT.BatchId batchId, bytes32 orderHash) internal view returns (PT.Permit memory) {
        return PT.Permit({
            kind: PT.PermitKind.PERMIT2,
            token: address(0xB01),
            maxAmount: 1e18,
            deadline: block.timestamp + 7 days,
            signature: new bytes(65),
            nonce: 0,
            orderHash: orderHash,
            batchId: batchId
        });
    }

    function setUp() public {
        vm.prank(owner);
        store = new OrderStore(manager);
    }

    function testConstructor_SetsOwnerAndManager() public {
        assertEq(store.owner(), owner);
        assertEq(store.manager(), manager);
    }

    function testConstructor_RevertsWhenAddressZero() public {
        vm.expectRevert();
        new OrderStore(address(0));
    }

    function testChangeManager_OnlyOwner() public {
        address newManager = makeAddr("newManager");
        vm.expectRevert();
        store.changeManager(newManager);
    }

    function testChangeManager_RevertWhenZero() public {
        vm.expectRevert(OrderStore.OrderStore__AddressZeroUsed.selector);
        vm.prank(owner);
        store.changeManager(address(0));
    }

    function testCommit_StoresAndEmits() public {
        OT.BatchId batchId = OT.BatchId.wrap(keccak256("b2"));
        bytes32 chash = keccak256("c2");
        OT.CommitId cid = OHL.commitIdOf(trader, batchId, chash);

        vm.prank(manager);
        vm.expectEmit(address(store));
        emit OrderStore.Commited(cid);
        store.commit(trader, batchId, chash);
        (address tr, OT.BatchId b, bytes32 h, bool cancelled, bool revealed, bool executed, bool slashed) =
            store.commits(cid);

        assertEq(tr, trader);
        assertEq(OT.BatchId.unwrap(b), OT.BatchId.unwrap(batchId));
        assertEq(h, chash);
        assertFalse(cancelled);
        assertFalse(revealed);
        assertFalse(executed);
        assertFalse(slashed);
    }

    function testCommit_OnlyManager() public {
        OT.BatchId batchId = OT.BatchId.wrap(keccak256("batch-1"));
        bytes32 chash = keccak256("commitment");

        vm.expectRevert(OrderStore.OrderStore__NotManager.selector);
        store.commit(trader, batchId, chash);
    }

    function testCommit_OverwriteSameIdAllowed_LastWriteWins() public {
        OT.BatchId batchId = OT.BatchId.wrap(keccak256("b3"));
        bytes32 chash1 = keccak256("c3a");
        bytes32 chash2 = keccak256("c3b");

        vm.prank(manager);
        store.commit(trader, batchId, chash1);

        OT.CommitId cid = OHL.commitIdOf(trader, batchId, chash1);

        vm.prank(manager);
        store.commit(trader, batchId, chash1);

        (,, bytes32 h,, bool revealed,,) = store.commits(cid);
        assertEq(h, chash1);
        assertFalse(revealed);
    }

    function testReveal_OnlyManagerGuard() public {
        OT.BatchId batchId = OT.BatchId.wrap(keccak256("b3"));
        bytes32 chash = keccak256("c3a");
        OT.Order memory o = _dummyOrder(batchId);
        bytes32 orderHash = OHL.makeOrderStructHash(o);

        PT.Permit memory p = _dummyPermit(batchId, orderHash);

        OT.CommitId cid = OHL.commitIdOf(trader, batchId, chash);
        vm.prank(manager);
        store.commit(trader, batchId, chash);

        vm.prank(stranger);
        vm.expectRevert(OrderStore.OrderStore__NotManager.selector);
        store.reveal(cid, o, p);
    }

    function testReveal_SetsRevealedAndEmits() public {
        OT.BatchId batchId = OT.BatchId.wrap(keccak256("b3"));
        bytes32 chash = keccak256("c3a");
        OT.CommitId cid = OHL.commitIdOf(trader, batchId, chash);
        OT.Order memory o = _dummyOrder(batchId);
        bytes32 orderHash = OHL.makeOrderStructHash(o);

        PT.Permit memory p = _dummyPermit(batchId, orderHash);

        vm.prank(manager);
        store.commit(trader, batchId, chash);

        vm.prank(manager);
        vm.expectEmit(address(store));
        emit OrderStore.Revealed(cid);
        store.reveal(cid, o, p);

        (,,,, bool revealed,,) = store.commits(cid);
        assertTrue(revealed, "revealed should be true");
    }
}
