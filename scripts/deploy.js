const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const HonkVerifier = await hre.ethers.getContractFactory("HonkVerifier");
  const verifier = await HonkVerifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log("HonkVerifier deployed to:", verifierAddress);

  const PaymentAuthorizer = await hre.ethers.getContractFactory("PaymentAuthorizer");
  const authorizer = await PaymentAuthorizer.deploy(verifierAddress);
  await authorizer.waitForDeployment();
  const authorizerAddress = await authorizer.getAddress();
  console.log("PaymentAuthorizer deployed to:", authorizerAddress);

  const out = {
    verifier: verifierAddress,
    authorizer: authorizerAddress,
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
