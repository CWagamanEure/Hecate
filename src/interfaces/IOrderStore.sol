//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "../types/OrderTypes.sol";

interface IOrderStore {
    function owner() external view returns (address);

    function manager() external view returns (address);

    function setManager(address m) external;

    function commit(
        address trader,
        bytes32 batchId,
        bytes32 commitmentHash
    ) external returns (bytes32 commitId);

    //Mapping mirros
    function commits(
        bytes32 commitId
    )
        external
        view
        returns (
            address trader,
            bytes32 batchId,
            bytes32 commitmentHash,
            bool revealed,
            bool executed,
            bool slashed,
            bool cancelled
        );

    function reveals(
        bytes32 commitId
    )
        external
        view
        returns (
            address base,
            address quote,
            OT.Side side,
            uint256 size,
            uint256 bandBps,
            OT.BatchId batchId,
            bytes32 salt,
            address trader
        );
}
