//SPDX-License-IdenfifierL: MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "../types/OrderTypes.sol";
import {PermitTypes as PT} from "../types/PermitTypes.sol";

interface IBondVault {
    // -------- Views --------
    function manager() external view returns (address);

    function PERMIT2() external view returns (address);

    function getBond(OT.CommitId commitId) external view returns (OT.Bond memory);

    function isLocked(OT.CommitId commitId) external view returns (bool);

    function isClaimed(OT.CommitId commitId) external view returns (bool);

    function isClaimable(OT.CommitId commitId) external view returns (bool);

    // -------- User --------
    function claim(OT.CommitId commitId) external;

    // -------- Owner/Admin --------
    function changeManager(address newManager) external;

    function setSlashRecipient(address recipient) external;

    // -------- Manager --------
    function lockWithPermit(
        OT.CommitId commitId,
        address trader,
        address bondToken,
        uint96 bondAmount,
        PT.Permit calldata p
    ) external;

    function lockFrom(OT.CommitId commitId, address bondToken, uint96 bondAmount, address trader) external;

    function slash(OT.CommitId commitId, address to, uint8 reason) external;

    function setClaimable(OT.CommitId cid, bool on) external;
}
