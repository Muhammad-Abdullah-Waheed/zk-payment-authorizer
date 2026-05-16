// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./UltraPlonkVerifier.sol";

contract PaymentAuthorizer {
    HonkVerifier public verifier;
    mapping(bytes32 => bool) public usedNullifiers;

    event PaymentAuthorized(uint256 amount, bytes32 nullifier);
    event PaymentRejected(string reason);

    constructor(address _verifier) {
        verifier = HonkVerifier(_verifier);
    }

    function authorize(bytes calldata proof, bytes32[] calldata publicInputs) external returns (bool) {
        bytes32 nullifier = publicInputs[1];

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
        emit PaymentAuthorized(amount, nullifier);
        return true;
    }
}
