//SPDX-License-Identifier:MIT
pragma solidity 0.8.20;

import {OrderTypes as OT} from "../../src/types/OrderTypes.sol";
import {PermitTypes as PT} from "../../src/types/PermitTypes.sol";

contract MockBondVault {
    event Locked(bytes32 cid, address trader, address token, uint96 amount);

    function lockWithPermit(OT.CommitId cid, address trader, address token, uint96 amount, PT.Permit calldata p)
        external
    {
        emit Locked(OT.CommitId.unwrap(cid), trader, token, amount);
    }

    function lockFrom(OT.CommitId, address, address, uint96) external {}

    function release(OT.CommitId, address) external {}

    function slash(OT.CommitId, address, uint8) external {}
}
