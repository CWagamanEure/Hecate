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
        OHL.makeDomainSeparator(s_name, s_version, address(this), block.chainid);

    IOrderStore public immutable STORE;

    mapping(OT.PairId => OT.BatchConfig) public cfg;

    //-----------Events--------------------

    //-----------Errors-----------------
    error CrossingManager__BatchNotConfigured();

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

    //---------time math-----------------------
    function currentIndex(OT.PairId pairId) public view returns (uint64) {
        OT.BatchConfig storage c = cfg[pairId];
        if (c.batchLength == 0) revert CrossingManager__BatchNotConfigured();
        uint256 since = block.timestamp - c.genesisTs;
        return uint64(since / c.batchLength);
    }

    function batchTimes(OT.PairId pairId, uint64 idx)
        public
        view
        returns (uint256 tStart, uint256 tCommitEnd, uint256 tClear)
    {
        OT.BatchConfig storage c = cfg[pairId];
        if (c.batchLength == 0) revert CrossingManager__BatchNotConfigured();
        tStart = uint256(c.genesisTs) + uint256(idx) * c.batchLength;
        tCommitEnd = tStart + c.commitSecs;
        tClear = tStart + c.batchLength;
    }

    function phaseFor(OT.PairId pairId, uint64 idx) public view returns (OT.Phase) {
        (uint256 tStart, uint256 tCommitEnd, uint256 tClear) = batchTimes(pairId, idx);
        if (block.timestamp < tCommitEnd) return OT.Phase.COMMIT;
        if (block.timestamp < tClear) return OT.Phase.REVEAL;
        return OT.Phase.CLEARREADY;
    }

    //------------helpers----------------
    function getCurrentBatch(OT.PairId pairId) public view returns (OT.BatchId bid, uint64 idx, OT.Phase p) {
        idx = currentIndex(pairId);
        p = phaseFor(pairId, idx);
        bid = OHL.batchIdOf(_CACHED_DOMAIN_SEPARATOR, pairId, idx);
    }

    function commit(bytes32 commitmentHash, bytes32 batchId, PT.Permit calldata bondPermit) external {
        STORE.commit(msg.sender, batchId, commitmentHash);
    }

    function reveal(OT.Order calldata o, PT.Permit calldata p) internal {}

    function clear(bytes32 batchId) public {}

    function cancelCommit(bytes32 batchId) public {}

    function domainSeparator() public view returns (bytes32) {
        return _CACHED_DOMAIN_SEPARATOR;
    }

    function _isValidSig(bytes32 digest, bytes calldata sig, address expected) internal pure returns (bool) {
        return ECDSA.recover(digest, sig) == expected;
    }
}
