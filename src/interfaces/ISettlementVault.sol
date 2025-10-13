//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {OrderTypes as OT} from "../types/OrderTypes.sol";
import {PermitTypes as PT} from "../types/PermitTypes.sol";

interface ISettlementVault {
    function changeManager(address newManager) external;

    function settle(
        OT.BatchId bid,
        OT.Match calldata m,
        PT.Permit calldata pBuyer,
        PT.Permit calldata pSeller,
        OT.CommitId cidSeller,
        OT.CommitId cidBuyer
    ) external returns (uint256 quotePaid);

    event Settled(
        bytes32 indexed bid,
        bytes32 indexed cidBuyer,
        bytes32 indexed cidSeller,
        address buyer,
        address seller,
        address base,
        address quote,
        uint256 sizeBase,
        uint256 priceX18,
        uint256 quotePaid
    );
}
