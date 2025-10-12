//SPDX-License-IdenfifierL: MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "../types/OrderTypes.sol";
import {PermitTypes as PT} from "../types/PermitTypes.sol";

interface IBondVault {
    struct BondView {
        address trader;
        address token;
        uint96 amount;
        bool locked;
        bool claimed;
    }

    function getBond(OT.CommitId commitId) external view returns (BondView memory);

    function isLocked(OT.CommitId commitId) external view returns (bool);

    function isClaimed(OT.CommitId commitId) external view returns (bool);

    //-----------Admin---------------------

    function changeManager(address newManager) external;

    function setSlashRecipient(address recipient) external;

    //---------Manager-----------------------

    //Lock a bond by pulling tokens with Permit2/EIP-2612
    function lockWithPermit(OT.CommitId commitId, address trader, address token, uint96 amount, PT.Permit calldata p)
        external;

    //Lock a bond using ERC20 allowance to this vault
    function lockFrom(OT.CommitId commitId, address trader, address token, uint96 amount) external;

    function release(OT.CommitId commitId, address to) external;

    function slash(OT.CommitId commitId, address to, uint8 reason) external;

    //--------Events-----------------------
    event ManagerUpdated(address indexed oldManager, address indexed newManager);
    event SlashRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event BondLocked(bytes32 indexed commitId, address indexed trader, address indexed token, uint96 amount);
    event BondReleased(bytes32 indexed commitId, address indexed to, uint96 amount);
    event BondSlashed(bytes32 indexed commitId, address indexed to, uint96 amount, uint8 reason);
}
