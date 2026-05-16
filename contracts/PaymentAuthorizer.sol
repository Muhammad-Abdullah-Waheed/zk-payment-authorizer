// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./UltraPlonkVerifier.sol";
import "./PolicyRegistry.sol";

/// @title PaymentAuthorizer
/// @notice Verifies UltraHonk proofs and enforces nullifier replay protection.
/// @dev Public input layout (must match Noir circuit order):
///      0: payment_amount (u64)
///      1: current_time (u64)
///      2: vendor (Field)
///      3: policy_commitment (Field)
///      4: nullifier (Field)
contract PaymentAuthorizer {
    HonkVerifier public verifier;
    PolicyRegistry public policyRegistry;
    mapping(bytes32 => bool) public usedNullifiers;

    event PaymentAuthorized(
        uint256 amount,
        uint256 currentTime,
        bytes32 vendor,
        bytes32 policyCommitment,
        bytes32 nullifier
    );
    event PaymentRejected(string reason);

    constructor(address _verifier, address _policyRegistry) {
        verifier = HonkVerifier(_verifier);
        policyRegistry = PolicyRegistry(_policyRegistry);
    }

    function authorize(bytes calldata proof, bytes32[] calldata publicInputs) external returns (bool) {
        if (publicInputs.length < 5) {
            emit PaymentRejected("Invalid public inputs");
            return false;
        }

        bytes32 policyCommitment = publicInputs[3];
        bytes32 nullifier = publicInputs[4];

        if (!policyRegistry.isRegistered(policyCommitment)) {
            emit PaymentRejected("Unknown policy");
            return false;
        }

        if (usedNullifiers[nullifier]) {
            emit PaymentRejected("Replay attack detected");
            return false;
        }

        bool ok;
        try verifier.verify(proof, publicInputs) returns (bool result) {
            ok = result;
        } catch {
            ok = false;
        }

        if (!ok) {
            emit PaymentRejected("Invalid proof");
            return false;
        }

        usedNullifiers[nullifier] = true;
        uint256 amount = uint256(publicInputs[0]);
        uint256 currentTime = uint256(publicInputs[1]);
        bytes32 vendor = publicInputs[2];

        emit PaymentAuthorized(amount, currentTime, vendor, policyCommitment, nullifier);
        return true;
    }
}
