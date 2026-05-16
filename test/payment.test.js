const { expect } = require("chai");
const { ethers } = require("hardhat");
const path = require("path");

const { loadAll, tamperedProof } = require("../scripts/load_proof.js");

const CIRCUIT_DIR = path.join(__dirname, "..", "circuits", "payment_policy");

describe("PaymentAuthorizer", function () {
  let verifier;
  let authorizer;
  let proofHex;
  let publicInputs;

  before(async function () {
    const { proof, publicInputs: pis } = loadAll(CIRCUIT_DIR);
    proofHex = proof;
    publicInputs = pis;

    const HonkVerifier = await ethers.getContractFactory("HonkVerifier");
    verifier = await HonkVerifier.deploy();
    await verifier.waitForDeployment();

    const PaymentAuthorizer = await ethers.getContractFactory("PaymentAuthorizer");
    authorizer = await PaymentAuthorizer.deploy(await verifier.getAddress());
    await authorizer.waitForDeployment();
  });

  it("verifies a valid proof natively via the Honk verifier", async function () {
    const ok = await verifier.verify(proofHex, publicInputs);
    expect(ok).to.equal(true);
  });

  it("authorizes a valid payment and emits PaymentAuthorized", async function () {
    const expectedAmount = BigInt(publicInputs[0]);
    const expectedNullifier = publicInputs[1];

    await expect(authorizer.authorize(proofHex, publicInputs))
      .to.emit(authorizer, "PaymentAuthorized")
      .withArgs(expectedAmount, expectedNullifier);

    expect(await authorizer.usedNullifiers(expectedNullifier)).to.equal(true);
  });

  it("rejects a replay of the same proof and emits PaymentRejected", async function () {
    await expect(authorizer.authorize(proofHex, publicInputs))
      .to.emit(authorizer, "PaymentRejected")
      .withArgs("Replay attack detected");
  });

  it("rejects a tampered proof with a fresh nullifier", async function () {
    const freshNullifier =
      "0x" + "1".repeat(64);
    const freshInputs = [publicInputs[0], freshNullifier];
    const badProof = tamperedProof(proofHex);

    await expect(authorizer.authorize(badProof, freshInputs))
      .to.emit(authorizer, "PaymentRejected")
      .withArgs("Invalid proof");
  });
});
