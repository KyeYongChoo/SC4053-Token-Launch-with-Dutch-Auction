// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title LaunchToken
/// @notice Fixed-supply ERC20 sold through the Dutch auction. The whole supply is
///         minted once to `recipient`; there is no mint function afterwards, so
///         burning unsold tokens permanently reduces `totalSupply`.
contract LaunchToken is ERC20, ERC20Burnable {
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply,
        address recipient
    ) ERC20(name_, symbol_) {
        _mint(recipient, initialSupply);
    }
}
