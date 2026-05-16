const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const { ethers } = require("ethers");

const { loadAll, tamperedProof, PI } = require("./load_proof.js");

const ROOT = path.join(__dirname, "..");
const CIRCUIT_DIR = path.join(ROOT, "circuits", "payment_policy");
const DEPLOYMENT_PATH = path.join(ROOT, "deployment.json");
const ARTIFACT_PATH = path.join(
  ROOT,
  "artifacts",
  "contracts",
  "PaymentAuthorizer.sol",
  "PaymentAuthorizer.json"
);

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";

const HARDHAT_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function loadDeployment() {
  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error(
      "deployment.json not found. Run 'npx hardhat run scripts/deploy.js --network localhost' first."
    );
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
}

function loadAuthorizerContract() {
  const deployment = loadDeployment();
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(HARDHAT_KEY_0, provider);
  const authorizer = new ethers.Contract(
    deployment.authorizer,
    artifact.abi,
    wallet
  );
  return { provider, wallet, authorizer, deployment };
}

async function parseAuthorizeResult(receipt, authorizerInterface) {
  for (const log of receipt.logs) {
    let parsed;
    try {
      parsed = authorizerInterface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed) {
      return {
        event: parsed.name,
        args: parsed.args.map((a) =>
          typeof a === "bigint" ? a.toString() : a
        ),
      };
    }
  }
  return { event: "Unknown", args: [] };
}

function attemptScenarioBProve() {
  const proverPath = path.join(CIRCUIT_DIR, "Prover.toml");
  const backupPath = proverPath + ".bak";

  const original = fs.readFileSync(proverPath, "utf8");
  fs.writeFileSync(backupPath, original);

  const scenarioBToml = `spending_limit = "5000"
tx_nonce = "123"
window_start = "1700000000"
window_end = "2000000000"
approved_vendor_0 = "0x0000000000000000000000000000000000000000000000000000000000000001"
approved_vendor_1 = "0x0000000000000000000000000000000000000000000000000000000000000002"
approved_vendor_2 = "0x0000000000000000000000000000000000000000000000000000000000000003"
approved_vendor_3 = "0x0000000000000000000000000000000000000000000000000000000000000004"

payment_amount = "8000"
current_time = "1715000000"
vendor = "0x0000000000000000000000000000000000000000000000000000000000000001"
policy_commitment = "0x00b410c871f9cdff3e71cbadc6252cbdf93069e555deb69629caa3f0be96f0be"
nullifier = "0x2b9f6ac4e48bde1097ddc877bf77a0412b45711c3cae07783fbc7789eedc1acc"
`;

  fs.writeFileSync(proverPath, scenarioBToml);

  try {
    execFileSync("nargo", ["execute"], {
      cwd: CIRCUIT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { success: true, stderr: "" };
  } catch (err) {
    const stderr = (err.stderr && err.stderr.toString()) || err.message;
    return { success: false, stderr };
  } finally {
    fs.writeFileSync(proverPath, original);
    try {
      fs.unlinkSync(backupPath);
    } catch {}
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/state", (req, res) => {
  try {
    const deployment = loadDeployment();
    const { proof, publicInputs } = loadAll(CIRCUIT_DIR);
    res.json({
      deployment,
      proofLength: (proof.length - 2) / 2,
      publicInputs,
      paymentAmountWei: BigInt(publicInputs[PI.PAYMENT_AMOUNT]).toString(),
      currentTime: BigInt(publicInputs[PI.CURRENT_TIME]).toString(),
      vendor: publicInputs[PI.VENDOR],
      policyCommitment: publicInputs[PI.POLICY_COMMITMENT],
      nullifier: publicInputs[PI.NULLIFIER],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/scenarioA", async (req, res) => {
  try {
    const { authorizer } = loadAuthorizerContract();
    const { proof, publicInputs } = loadAll(CIRCUIT_DIR);

    const tx = await authorizer.authorize(proof, publicInputs);
    const receipt = await tx.wait();

    const result = await parseAuthorizeResult(receipt, authorizer.interface);
    res.json({
      ok: result.event === "PaymentAuthorized",
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      event: result.event,
      args: result.args,
      publicInputs,
      paymentAmount: BigInt(publicInputs[PI.PAYMENT_AMOUNT]).toString(),
      currentTime: BigInt(publicInputs[PI.CURRENT_TIME]).toString(),
      vendor: publicInputs[PI.VENDOR],
      policyCommitment: publicInputs[PI.POLICY_COMMITMENT],
      nullifier: publicInputs[PI.NULLIFIER],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/scenarioB", async (req, res) => {
  try {
    const proveResult = attemptScenarioBProve();

    let onChain = null;
    if (!proveResult.success) {
      const { authorizer } = loadAuthorizerContract();
      const { proof, publicInputs } = loadAll(CIRCUIT_DIR);

      const tamperedAmount =
        "0x" + BigInt(80).toString(16).padStart(64, "0");
      const freshNullifier =
        "0x" +
        Array.from({ length: 64 }, () =>
          Math.floor(Math.random() * 16).toString(16)
        ).join("");

      const badProof = tamperedProof(proof);
      const badInputs = [...publicInputs];
      badInputs[PI.PAYMENT_AMOUNT] = tamperedAmount;
      badInputs[PI.NULLIFIER] = freshNullifier;

      const tx = await authorizer.authorize(badProof, badInputs);
      const receipt = await tx.wait();
      const parsed = await parseAuthorizeResult(receipt, authorizer.interface);
      onChain = {
        txHash: tx.hash,
        event: parsed.event,
        args: parsed.args,
      };
    }

    res.json({
      proveSucceeded: proveResult.success,
      stderr: proveResult.stderr,
      onChain,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`zk-payment server listening on http://127.0.0.1:${PORT}`);
});
