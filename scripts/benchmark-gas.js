/** Gas-only benchmark; deploys fresh contracts then measures authorize paths. */
const hre = require("hardhat");
const path = require("path");
const { loadAll, tamperedProof } = require("./load_proof.js");

const CIRCUIT_DIR = path.join(__dirname, "..", "circuits", "payment_policy");

async function main() {
  const { proof, publicInputs } = loadAll(CIRCUIT_DIR);

  const HonkVerifier = await hre.ethers.getContractFactory("HonkVerifier");
  const vTx = await HonkVerifier.deploy();
  const vRc = await vTx.deploymentTransaction().wait();
  const verifier = await vTx.getAddress();

  const PaymentAuthorizer = await hre.ethers.getContractFactory("PaymentAuthorizer");
  const aTx = await PaymentAuthorizer.deploy(verifier);
  const aRc = await aTx.deploymentTransaction().wait();
  const authorizer = await aTx.getAddress();

  const authorizerC = await hre.ethers.getContractAt("PaymentAuthorizer", authorizer);
  const verifierC = await hre.ethers.getContractAt("HonkVerifier", verifier);

  const honkArtifact = await hre.artifacts.readArtifact("HonkVerifier");
  const honkDeployGas = vRc.gasUsed;
  const authDeployGas = aRc.gasUsed;

  const v0 = Date.now();
  await verifierC.verify.staticCall(proof, publicInputs);
  const verifyStaticMs = Date.now() - v0;

  const okTx = await authorizerC.authorize(proof, publicInputs);
  const okRc = await okTx.wait();

  const replayTx = await authorizerC.authorize(proof, publicInputs);
  const replayRc = await replayTx.wait();

  const freshNullifier = "0x" + "b".repeat(64);
  const badTx = await authorizerC.authorize(tamperedProof(proof), [
    publicInputs[0],
    freshNullifier,
  ]);
  const badRc = await badTx.wait();

  const bytecodeHonk = await hre.ethers.provider.getCode(verifier);
  const bytecodeAuth = await hre.ethers.provider.getCode(authorizer);

  console.log(
    JSON.stringify(
      {
        deployGas: {
          HonkVerifier: honkDeployGas.toString(),
          PaymentAuthorizer: authDeployGas.toString(),
          total: (honkDeployGas + authDeployGas).toString(),
        },
        deployedBytecodeBytes: {
          HonkVerifier: (bytecodeHonk.length - 2) / 2,
          PaymentAuthorizer: (bytecodeAuth.length - 2) / 2,
        },
        authorizeGas: {
          validPayment: okRc.gasUsed.toString(),
          replayRejected: replayRc.gasUsed.toString(),
          invalidProof: badRc.gasUsed.toString(),
        },
        honkVerifyStaticCallMs: verifyStaticMs,
        proofCalldataBytes: (proof.length - 2) / 2,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
