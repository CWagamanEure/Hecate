//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PermitTypes as PT} from "./types/PermitTypes.sol";
import {OrderTypes as OT} from "./types/OrderTypes.sol";
import {OrderStore} from "./OrderStore.sol";
import {IOrderStore} from "./interfaces/IOrderStore.sol";

contract CrossingManager {
    IOrderStore public immutable STORE;

    //IBondManager public immutable BONDS;
    //ISettlementVault public immutable VAULT;
    //IPriceGuard public immutable pg;

    constructor(address store_, address bonds_, address vault_, address pg_) {
        STORE = IOrderStore(store_);
        //   bonds = IBondManager(bonds_);
        //  vault = ISettlementVault(vault_);
        //   pg = IPriceGuard(pg_);
    }

    function commit(
        bytes32 commitmentHash,
        bytes32 batchId,
        PT.Permit calldata bondPermit
    ) external {
        STORE.commit(msg.sender, batchId, commitmentHash);
    }

    function reveal(OT.Order calldata o, PT.Permit calldata p) public {}

    function clear(bytes32 batchId) public {}

    function cancelCommit(bytes32 batchId) public {}
}
