//SPDX-License-Identifier:MIT
pragma solidity ^0.8.20;

import {IERC20} from "../../src/interfaces/IERC20.sol";
import {IERC20Permit} from "../../src/interfaces/IERC20Permit.sol";

contract MockERC20Permit is IERC20, IERC20Permit {
    string public name = "Mock Permit Token";
    string public symbol = "MPT";
    uint8 public decimals = 18;

    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    mapping(address => uint256) public override nonces;
    uint256 public override totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        unchecked {
            balanceOf[msg.sender] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(balanceOf[from] >= amount, "bal");
        require(a >= amount, "allow");
        unchecked {
            allowance[from][msg.sender] = a - amount;
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8, // v (ignored)
        bytes32, // r (ignored)
        bytes32 // s (ignored)
    ) external override {
        require(block.timestamp <= deadline, "expired");
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
        unchecked {
            ++nonces[owner];
        }
    }
}
