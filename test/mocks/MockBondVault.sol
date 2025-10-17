//SPDX-License-Identifier:MIT
pragma solidity 0.8.20;

import {OrderTypes as OT} from "../../src/types/OrderTypes.sol";
import {PermitTypes as PT} from "../../src/types/PermitTypes.sol";
import {IBondVault} from "../../src/interfaces/IBondVault.sol";

contract MockBondVault is IBondVault {
    event Locked(bytes32 cid, address trader, address token, uint96 amount);

    function lockWithPermit(OT.CommitId cid, address trader, address token, uint96 amount, PT.Permit calldata p)
        external
    {
        emit Locked(OT.CommitId.unwrap(cid), trader, token, amount);
    }

    function changeManager() external view returns (address) {}

    function getBond(OT.CommitId commitId) external view returns (OT.Bond memory) {}

    function isLocked(OT.CommitId commitId) external view returns (bool) {}

    function isClaimed(OT.CommitId commitId) external view returns (bool) {}

    function isClaimable(OT.CommitId commitId) external view returns (bool) {}

    // -------- User --------
    function claim(OT.CommitId commitId) external {}

    // -------- Owner/Admin --------
    function changeManager(address newManager) external {}

    function setSlashRecipient(address recipient) external {}

    function lockFrom(OT.CommitId commitId, address bondToken, uint96 bondAmount, address trader) external {}

    function slash(OT.CommitId commitId, address to, uint8 reason) external {}

    function setClaimable(OT.CommitId cid, bool on) external {}
}
