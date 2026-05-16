const { expect } = require("chai");
const { ethers } = require("hardhat");
const path = require("path");

const { loadAll, tamperedProof, PI } = require("../scripts/load_proof.js");

const CIRCUIT_DIR = path.join(__dirname, "..", "circuits", "payment_policy");

describe("PaymentAuthorizer", function () {
  let verifier;
  let registry;
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

    const PolicyRegistry = await ethers.getContractFactory("PolicyRegistry");
    registry = await PolicyRegistry.deploy();
    await registry.waitForDeployment();

    const commitment = publicInputs[PI.POLICY_COMMITMENT];
    await (await registry.registerPolicy(commitment)).wait();

    const PaymentAuthorizer = await ethers.getContractFactory("PaymentAuthorizer");
    authorizer = await PaymentAuthorizer.deploy(
      await verifier.getAddress(),
      await registry.getAddress()
    );
    await authorizer.waitForDeployment();
  });

  it("verifies a valid proof natively via the Honk verifier", async function () {
    const ok = await verifier.verify(proofHex, publicInputs);
    expect(ok).to.equal(true);
  });

  it("authorizes a valid payment and emits PaymentAuthorized", async function () {
    const expectedAmount = BigInt(publicInputs[PI.PAYMENT_AMOUNT]);
    const expectedNullifier = publicInputs[PI.NULLIFIER];

    await expect(authorizer.authorize(proofHex, publicInputs))
      .to.emit(authorizer, "PaymentAuthorized")
      .withArgs(
        expectedAmount,
        BigInt(publicInputs[PI.CURRENT_TIME]),
        publicInputs[PI.VENDOR],
        publicInputs[PI.POLICY_COMMITMENT],
        expectedNullifier
      );

    expect(await authorizer.usedNullifiers(expectedNullifier)).to.equal(true);
  });

  it("rejects a replay of the same proof and emits PaymentRejected", async function () {
    await expect(authorizer.authorize(proofHex, publicInputs))
      .to.emit(authorizer, "PaymentRejected")
      .withArgs("Replay attack detected");
  });

  it("rejects a tampered proof with a fresh nullifier", async function () {
    const freshNullifier = "0x" + "1".repeat(64);
    const freshInputs = [...publicInputs];
    freshInputs[PI.NULLIFIER] = freshNullifier;
    const badProof = tamperedProof(proofHex);

    await expect(authorizer.authorize(badProof, freshInputs))
      .to.emit(authorizer, "PaymentRejected")
      .withArgs("Invalid proof");
  });

  it("rejects when policy commitment is not registered", async function () {
    const unregisteredInputs = [...publicInputs];
    unregisteredInputs[PI.POLICY_COMMITMENT] = "0x" + "2".repeat(64);
    unregisteredInputs[PI.NULLIFIER] = "0x" + "3".repeat(64);

    await expect(authorizer.authorize(proofHex, unregisteredInputs))
      .to.emit(authorizer, "PaymentRejected")
      .withArgs("Unknown policy");
  });
});
