//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {PermitTypes} from "../types/PermitTypes.sol";
import {IPermit2} from "../interfaces/IPermit2.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IERC20Permit} from "../interfaces/IERC20Permit.sol";

library PermitExecutor {
    //------------Errors----------------
    error PermitExecutor__InvalidPermit();
    error PermitExecutor__SigLen();
    error PermitExecutor__PullFailed();
    error PermitExecutor__BadV();

    //--------------Functions-----------------
    function pull(
        address permit2,
        address owner,
        address token,
        address to,
        uint256 amount,
        PermitTypes.Permit calldata p
    ) internal {
        if (p.kind == PermitTypes.PermitKind.PERMIT2) {
            _pullPermit2(permit2, owner, token, to, amount, p);
        } else if (p.kind == PermitTypes.PermitKind.EIP2612) {
            _pull2612(owner, token, to, amount, p);
        } else {
            revert PermitExecutor__InvalidPermit();
        }
    }

    function _pullPermit2(
        address permit2,
        address owner,
        address token,
        address to,
        uint256 amount,
        PermitTypes.Permit calldata p
    ) private {
        IPermit2.PermitTransferFrom memory pt = IPermit2.PermitTransferFrom({
            permitted: IPermit2.TokenPermissions({token: token, amount: p.maxAmount}),
            nonce: p.nonce,
            deadline: p.deadline
        });
        IPermit2.SignatureTransferDetails memory xfer =
            IPermit2.SignatureTransferDetails({to: to, requestedAmount: amount});

        IPermit2(permit2).permitWitnessTransferFrom(
            pt,
            xfer,
            owner,
            PermitTypes.witness(p.orderHash, p.batchId),
            "Witness(bytes32 orderHash, bytes32 batchId)",
            p.signature
        );
    }

    function _pull2612(address owner, address token, address to, uint256 amount, PermitTypes.Permit calldata p)
        private
    {
        (uint8 v, bytes32 r, bytes32 s) = _splitSig(p.signature);
        IERC20Permit(token).permit(owner, address(this), p.maxAmount, p.deadline, v, r, s);
        SafeTransferLib.safeTransferFrom(token, owner, to, amount);
    }

    function _splitSig(bytes memory sig) private pure returns (uint8 v, bytes32 r, bytes32 s) {
        if (sig.length != 65) revert PermitExecutor__SigLen();

        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        if (v == 27 || v == 28) return (v, r, s);

        assembly {
            v := byte(0, mload(add(sig, 32)))
            r := mload(add(sig, 64))
            s := mload(add(sig, 96))
        }
        if (v < 27) v += 27;
        if (v == 27 || v == 28) revert PermitExecutor__BadV();
        return (v, r, s);
    }
}
