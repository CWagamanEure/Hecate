//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MockERC20Permit} from "../mocks/MockERC20Permit.sol";
import {OrderTypes as OT} from "../../src/types/OrderTypes.sol";
import {PermitTypes as PT} from "../../src/types/PermitTypes.sol";
import {BondVault} from "../../src/BondVault.sol";

contract BondVaultTest is Test {
    BondVault vault;
    MockERC20Permit token;

    address owner = address(this);
    address trader = makeAddr("trader");
    address manager = makeAddr("manager");
    address trader2 = makeAddr("trader2");
    address treasury = makeAddr("treasury");

    event ManagerUpdated(address indexed oldManager, address indexed newManager);
    event BondLocked(bytes32 commitId, address indexed trader);
    event BondClaimable(bytes32 indexed commitId, bool on);
    event BondReleased(bytes32 commitId, address trader, uint256 amount);
    event BondSlashed(bytes32 commitId, address sink, uint256 amount, uint8 reason);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    uint256 constant ONE = 1e18;

    //----------------Helpers-------------------------------
    function _cid(bytes32 salt) internal pure returns (OT.CommitId) {
        return OT.CommitId.wrap(keccak256(abi.encode(salt)));
    }

    function _bondOf(OT.CommitId cid)
        internal
        view
        returns (address trader_, address token_, uint96 amount_, bool locked_, bool claimed_)
    {
        (trader_, token_, amount_, locked_, claimed_) = vault.bonds(cid);
    }

    function setUp() public {
        token = new MockERC20Permit();
        vault = new BondVault(manager, treasury, address(0));

        token.mint(trader, 1_000 * ONE);
        token.mint(trader2, 1_000 * ONE);
    }

    function test_constructor_setsManager_andEmits() public {
        BondVault bondVault2;
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(address(0), address(this));

        vm.expectEmit(true, true, false, false);
        emit ManagerUpdated(address(0), manager);
        bondVault2 = new BondVault(manager, treasury, address(0));
        assertEq(bondVault2.manager(), manager);
    }

    function test_changeManager_onlyOwner() public {
        address newManager = makeAddr("newManager");

        vm.prank(manager);
        vm.expectRevert();
        vault.changeManager(newManager);

        vm.expectEmit(true, true, false, false, address(vault));
        emit ManagerUpdated(manager, newManager);
        vm.prank(owner);
        vault.changeManager(newManager);
        assertEq(vault.manager(), newManager);
    }

    //-------------LockFrom---------------------------
    function test_lockFrom_stores_andEmits() public {
        OT.CommitId cid = _cid("c1");
        uint96 amount = 10;

        vm.prank(trader);
        token.approve(address(vault), amount);

        vm.prank(manager);
        vm.expectEmit(false, true, false, false, address(vault));
        emit BondLocked(OT.CommitId.unwrap(cid), trader);
        vault.lockFrom(cid, address(token), amount, trader);

        (address tr, address tk, uint96 am, bool locked, bool claimed) = _bondOf(cid);

        assertEq(tr, trader);
        assertEq(tk, address(token));
        assertEq(am, amount);
        assertTrue(locked);
        assertFalse(claimed);
        assertEq(token.balanceOf(address(vault)), amount);
    }

    function test_lockFrom_onlyManager_guard() public {
        OT.CommitId cid = _cid("c2");
        vm.expectRevert(BondVault.BondVault__NotManager.selector);
        vault.lockFrom(cid, address(token), 5, trader);
    }

    function test_lockFrom_reverts_when_already_locked() public {
        OT.CommitId cid = _cid("c3");
        uint96 amount = 7;

        vm.prank(trader);
        token.approve(address(vault), amount);

        vm.prank(manager);
        vault.lockFrom(cid, address(token), amount, trader);

        vm.prank(manager);
        vm.expectRevert(BondVault.BondVault__BadState.selector);
        vault.lockFrom(cid, address(token), amount, trader);
    }

    //----------------EIP-2612 Path----------------------------
    function test_lockWIthPermit_EIP2612_path_moves_funds_and_stores() public {
        OT.CommitId cid = _cid("p1");
        uint96 amount = 11;

        PT.Permit memory p = PT.Permit({
            kind: PT.PermitKind.EIP2612,
            token: address(token),
            maxAmount: amount,
            deadline: block.timestamp + 1 days,
            signature: new bytes(65),
            nonce: 0,
            orderHash: bytes32(0),
            batchId: OT.BatchId.wrap(bytes32(0))
        });

        vm.prank(manager);
        vault.lockWithPermit(cid, trader, address(token), amount, p);

        (address tr, address tk, uint96 am, bool locked,) = _bondOf(cid);
        assertEq(tr, trader);
        assertEq(tk, address(token));
        assertEq(am, amount);
        assertTrue(locked);
        assertEq(token.balanceOf(address(vault)), amount);
    }

    //-----------------Claim---------------------------
    function test_claim_after_manager_sets_claimable_transfers_and_flags() public {
        OT.CommitId cid = _cid("cl1");
        uint96 amount = 9;

        vm.prank(trader);
        token.approve(address(vault), amount);
        vm.prank(manager);
        vault.lockFrom(cid, address(token), amount, trader);

        vm.prank(trader);
        vm.expectRevert(BondVault.BondVault__BadState.selector);
        vault.claim(cid);

        vm.prank(manager);
        vm.expectEmit(true, false, false, true, address(vault));
        emit BondClaimable(OT.CommitId.unwrap(cid), true);
        vault.setClaimable(cid, true);

        uint256 balBefore = token.balanceOf(trader);

        vm.prank(trader);
        vm.expectEmit(false, false, false, true, address(vault));
        emit BondReleased(OT.CommitId.unwrap(cid), trader, amount);
        vault.claim(cid);

        assertEq(token.balanceOf(trader), balBefore + amount);
        (,,,, bool claimed) = _bondOf(cid);
        assertTrue(claimed);

        vm.prank(trader);
        vm.expectRevert(BondVault.BondVault__BadState.selector);
        vault.claim(cid);
    }

    function test_claim_only_trader_can_withdraw() public {
        OT.CommitId cid = _cid("c12");
        uint96 amount = 5;

        vm.prank(trader);
        token.approve(address(vault), amount);
        vm.prank(manager);
        vault.lockFrom(cid, address(token), amount, trader);

        vm.prank(manager);
        vault.setClaimable(cid, true);

        vm.prank(trader2);
        vm.expectRevert(BondVault.BondVault__NotTrader.selector);
        vault.claim(cid);
    }

    //-------------Slash---------------------------------------
    function test_slash_sends_to_treasury_and_marks_claimed() public {
        OT.CommitId cid = _cid("sl1");
        uint96 amount = 13;

        vm.prank(trader);
        token.approve(address(vault), amount);
        vm.prank(manager);
        vault.lockFrom(cid, address(token), amount, trader);

        uint256 balBefore = token.balanceOf(treasury);

        vm.prank(manager);
        vm.expectEmit(true, false, false, true, address(vault));
        emit BondSlashed(OT.CommitId.unwrap(cid), treasury, amount, 1);
        vault.slash(cid, treasury, 1);

        assertEq(token.balanceOf(treasury), balBefore + amount);
        (,,,, bool claimed) = _bondOf(cid);
        assertTrue(claimed);

        vm.prank(manager);
        vm.expectRevert(BondVault.BondVault__BadState.selector);
        vault.slash(cid, treasury, 1);
    }

    function test_slash_uses_default_sink_when_to_zero() public {
        OT.CommitId cid = _cid("sl2");
        uint96 amount = 4;

        vm.prank(trader);
        token.approve(address(vault), amount);
        vm.prank(manager);
        vault.lockFrom(cid, address(token), amount, trader);

        uint256 beforeT = token.balanceOf(treasury);
        vm.prank(manager);
        vault.slash(cid, address(0), 7);
        assertEq(token.balanceOf(treasury), beforeT + amount);
    }

    //---------------------Batch Claimable----------------------------
}
