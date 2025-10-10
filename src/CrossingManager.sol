//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PermitTypes as PT} from "./types/PermitTypes.sol";
import {ECDSA} from "openzeppelin/utils/cryptography/ECDSA.sol";
import {OrderTypes as OT} from "./types/OrderTypes.sol";
import {OrderStore} from "./OrderStore.sol";
import {IOrderStore} from "./interfaces/IOrderStore.sol";
import {OrderHashLib as OHL} from "./libraries/OrderHashLib.sol";

contract CrossingManager {
    string private s_name;
    string private s_version;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR =
        OHL._domainSeparator(s_name, s_version, address(this), block.chainid);
    IOrderStore public immutable STORE;

    constructor(
        string memory _name,
        string memory _version,
        address store_,
        address bonds_,
        address vault_,
        address pg_
    ) {
        s_name = _name;
        s_version = _version;

        STORE = IOrderStore(store_);
    }

    function commit(bytes32 commitmentHash, bytes32 batchId, PT.Permit calldata bondPermit) external {
        STORE.commit(msg.sender, batchId, commitmentHash);
    }

    function reveal(OT.Order calldata o, PT.Permit calldata p) public {}

    function clear(bytes32 batchId) public {}

    function cancelCommit(bytes32 batchId) public {}

    function domainSeparator() public view returns (bytes32) {
        return _CACHED_DOMAIN_SEPARATOR;
    }

    function _isValidSig(bytes32 digest, bytes calldata sig, address expected) internal pure returns (bool) {
        return ECDSA.recover(digest, sig) == expected;
    }
}
