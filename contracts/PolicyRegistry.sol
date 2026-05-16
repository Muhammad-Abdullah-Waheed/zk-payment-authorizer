// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PolicyRegistry
/// @notice Stores registered policy commitment hashes. The ZK circuit proves
///         payment requests against a private policy whose hash matches a
///         registered commitment.
contract PolicyRegistry {
    mapping(bytes32 => bool) public registeredPolicies;

    event PolicyRegistered(bytes32 indexed commitment, address indexed owner);

    function registerPolicy(bytes32 commitment) external {
        require(!registeredPolicies[commitment], "Policy already registered");
        registeredPolicies[commitment] = true;
        emit PolicyRegistered(commitment, msg.sender);
    }

    function isRegistered(bytes32 commitment) external view returns (bool) {
        return registeredPolicies[commitment];
    }
}
