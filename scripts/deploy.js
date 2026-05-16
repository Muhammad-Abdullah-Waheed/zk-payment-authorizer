const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { PI } = require("./policy.js");
const { loadAll } = require("./load_proof.js");

const CIRCUIT_DIR = path.join(__dirname, "..", "circuits", "payment_policy");

async function main() {
  const HonkVerifier = await hre.ethers.getContractFactory("HonkVerifier");
  const verifier = await HonkVerifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log("HonkVerifier deployed to:", verifierAddress);

  const PolicyRegistry = await hre.ethers.getContractFactory("PolicyRegistry");
  const registry = await PolicyRegistry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("PolicyRegistry deployed to:", registryAddress);

  const { publicInputs } = loadAll(CIRCUIT_DIR);
  const policyCommitment = publicInputs[PI.POLICY_COMMITMENT];
  const regTx = await registry.registerPolicy(policyCommitment);
  await regTx.wait();
  console.log("Registered policy commitment:", policyCommitment);

  const PaymentAuthorizer = await hre.ethers.getContractFactory("PaymentAuthorizer");
  const authorizer = await PaymentAuthorizer.deploy(verifierAddress, registryAddress);
  await authorizer.waitForDeployment();
  const authorizerAddress = await authorizer.getAddress();
  console.log("PaymentAuthorizer deployed to:", authorizerAddress);

  const out = {
    verifier: verifierAddress,
    policyRegistry: registryAddress,
    authorizer: authorizerAddress,
    policyCommitment,
    network: hre.network.name,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
  };
  const outPath = path.join(__dirname, "..", "deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("Saved deployment info to", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
