//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {OrderTypes as OT} from "../src/types/OrderTypes.sol";
import "../src/libraries/OrderHashLib.sol";

contract Exposed {
    function commitmentHash(
        OT.Order memory o,
        address trader
    ) external pure returns (bytes32) {
        return OrderHashLib._commitmentHash(o, trader);
    }

    function orderStructHash(
        OT.Order memory o,
        address trader
    ) external pure returns (bytes32) {
        return OrderHashLib._orderStructHash(o, trader);
    }

    function eip712Digest(
        OT.Order memory o,
        address trader,
        bytes32 domainSeparator
    ) external pure returns (bytes32) {
        return OrderHashLib._eip712Digest(o, trader, domainSeparator);
    }

    function callDomainSeparator(
        string memory name,
        string memory version,
        address verifyingContract,
        uint256 chainId
    ) external pure returns (bytes32) {
        return
            OrderHashLib._domainSeparator(
                name,
                version,
                verifyingContract,
                chainId
            );
    }
}

contract OrderHashLibTest is Test {
    Exposed internal exposed;
    OT.Order internal order;
    address internal trader = address(0xBEEF);

    function setUp() public {
        exposed = new Exposed();
        order = OT.Order({
            base: address(0x1),
            quote: address(0x2),
            side: OT.Side.BUY,
            size: 1e18,
            bandBps: 100,
            batchId: OT.BatchId.wrap(keccak256("batch")),
            salt: keccak256("order-1"),
            trader: trader
        });
    }

    function testCommitmentHashConsistency() public {
        bytes32 h1 = exposed.commitmentHash(order, trader);
        bytes32 h2 = exposed.commitmentHash(order, trader);
        assertEq(h1, h2, "Hash should be deterministic");
    }

    function testOrderStructHasTypehash() public {
        bytes32 structHash = exposed.orderStructHash(order, trader);
        bytes32 typeHash = keccak256(
            "Order(address base, address quote, uint8 side, uint256 size, uint256 bandBps, bytes32 batchId, bytes32 salt, address trader)"
        );

        assertNotEq(structHash, bytes32(0), "Struct hash should not be zero");

        bytes32 recomputed = keccak256(
            abi.encode(
                typeHash,
                order.base,
                order.quote,
                uint8(order.side),
                order.size,
                order.bandBps,
                OT.BatchId.unwrap(order.batchId),
                order.salt,
                trader
            )
        );
        assertEq(
            structHash,
            recomputed,
            "Struct hash should match manual encoding"
        );
    }

    function testEIP712DigestComposition() public view {
        bytes32 dom = keccak256("domain");
        bytes32 digest = exposed.eip712Digest(order, trader, dom);
        bytes32 expected = keccak256(
            abi.encodePacked(
                "\x19\x01",
                dom,
                exposed.orderStructHash(order, trader)
            )
        );
        assertEq(
            digest,
            expected,
            "EIP-712 digest must contain domain and strict hash"
        );
    }

    function testDomainSeparatorMatchesEIP712Spec() public {
        bytes32 sep = exposed.callDomainSeparator(
            "CrossNet",
            "1",
            address(this),
            31337
        );
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name, string version, uint256 chainId, address verifyingContract)"
                ),
                keccak256(bytes("CrossNet")),
                keccak256(bytes("1")),
                uint256(31337),
                address(this)
            )
        );

        assertEq(sep, expected, "Domain Separator should follow spec");
    }
}
