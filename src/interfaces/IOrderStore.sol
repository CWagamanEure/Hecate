//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "../types/OrderTypes.sol";
import {PermitTypes as PT} from "../types/PermitTypes.sol";

interface IOrderStore {
    // -------- Views --------
    function manager() external view returns (address);

    // Note: returns the full Commitment struct
    function getCommited(OT.CommitId commitId) external view returns (OT.Commitment memory);

    // -------- Mutating --------
    function commit(address _trader, OT.BatchId _batchId, bytes32 _commitmentHash) external returns (OT.CommitId);

    function reveal(OT.CommitId commitId, OT.Order calldata o) external;

    function cancelCommit(address trader, OT.CommitId commitId) external;

    function changeManager(address newManager) external;
}
