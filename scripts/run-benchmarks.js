/**
 * Collects evaluation metrics and writes benchmark-results.json at repo root.
 * Usage: node scripts/run-benchmarks.js [--network localhost]
 */
const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

const ROOT = path.join(__dirname, "..");
const CIRCUIT_DIR = path.join(ROOT, "circuits", "payment_policy");
const OUT_PATH = path.join(ROOT, "benchmark-results.json");
const { loadAll, tamperedProof, PI } = require("./load_proof.js");

const HOME = process.env.HOME || "";
const PATH_NARGO = fs.existsSync(path.join(HOME, ".nargo/bin/nargo"))
  ? path.join(HOME, ".nargo/bin/nargo")
  : "nargo";
const PATH_BB = fs.existsSync(path.join(HOME, ".bb/bb"))
  ? path.join(HOME, ".bb/bb")
  : "bb";

function fileSize(p) {
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
}

function runTimedShell(cmd, cwd) {
  const t0 = performance.now();
  const parseTimeLine = (text) => {
    const m = (text || "").match(/\{[^{}]*"wallSec"[^{}]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    return {
      wallSec: Math.round(parseFloat(p.wallSec) * 1000) / 1000,
      maxRssMiB: p.maxRssKiB
        ? Math.round((p.maxRssKiB / 1024) * 10) / 10
        : null,
    };
  };
  try {
    const stderr = execSync(cmd, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const parsed = parseTimeLine(stderr.toString());
    if (parsed) return parsed;
  } catch (e) {
    const out =
      ((e.stderr && e.stderr.toString()) || "") +
      ((e.stdout && e.stdout.toString()) || "");
    const parsed = parseTimeLine(out);
    if (parsed) return parsed;
  }
  return {
    wallSec: Math.round((performance.now() - t0)) / 1000,
    maxRssMiB: null,
  };
}

function timeNullifier() {
  const t0 = performance.now();
  execFileSync("node", [path.join(ROOT, "scripts/compute_nullifier.js"), "123"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  return Math.round((performance.now() - t0) * 100) / 100;
}

async function runOnChain(networkName) {
  process.env.HARDHAT_NETWORK = networkName;
  delete require.cache[require.resolve("hardhat")];
  const hre = require("hardhat");
  const { proof, publicInputs } = loadAll(CIRCUIT_DIR);

  const HonkVerifier = await hre.ethers.getContractFactory("HonkVerifier");
  const vTx = await HonkVerifier.deploy();
  const vRc = await vTx.deploymentTransaction().wait();
  const verifier = await vTx.getAddress();

  const PolicyRegistry = await hre.ethers.getContractFactory("PolicyRegistry");
  const registry = await PolicyRegistry.deploy();
  await registry.waitForDeployment();
  await (await registry.registerPolicy(publicInputs[PI.POLICY_COMMITMENT])).wait();

  const PaymentAuthorizer = await hre.ethers.getContractFactory("PaymentAuthorizer");
  const aTx = await PaymentAuthorizer.deploy(verifier, await registry.getAddress());
  const aRc = await aTx.deploymentTransaction().wait();
  const authorizer = await aTx.getAddress();

  const authorizerC = await hre.ethers.getContractAt("PaymentAuthorizer", authorizer);
  const verifierC = await hre.ethers.getContractAt("HonkVerifier", verifier);

  const tVerify0 = performance.now();
  await verifierC.verify.staticCall(proof, publicInputs);
  const honkVerifyStaticCallMs = Math.round(performance.now() - tVerify0);

  const okTx = await authorizerC.authorize(proof, publicInputs);
  const okRc = await okTx.wait();

  const replayTx = await authorizerC.authorize(proof, publicInputs);
  const replayRc = await replayTx.wait();

  const freshNullifier = "0x" + "b".repeat(64);
  const badInputs = [...publicInputs];
  badInputs[PI.NULLIFIER] = freshNullifier;
  const badTx = await authorizerC.authorize(tamperedProof(proof), badInputs);
  const badRc = await badTx.wait();

  const bytecodeHonk = await hre.ethers.provider.getCode(verifier);
  const bytecodeAuth = await hre.ethers.provider.getCode(authorizer);

  const N = 10;
  const tBatch0 = performance.now();
  for (let i = 0; i < N; i++) {
    const nf =
      "0x" +
      (BigInt(publicInputs[PI.NULLIFIER]) + BigInt(400 + i))
        .toString(16)
        .padStart(64, "0");
    const batchInputs = [...publicInputs];
    batchInputs[PI.NULLIFIER] = nf;
    const tx = await authorizerC.authorize(proof, batchInputs);
    await tx.wait();
  }
  const batchMs = performance.now() - tBatch0;

  const gasPrice = (await hre.ethers.provider.getFeeData()).gasPrice || 0n;
  const validGas = okRc.gasUsed;

  return {
    network: networkName,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    deployGas: {
      HonkVerifier: vRc.gasUsed.toString(),
      PaymentAuthorizer: aRc.gasUsed.toString(),
      total: (vRc.gasUsed + aRc.gasUsed).toString(),
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
    latencyMs: {
      honkVerifyStaticCall: honkVerifyStaticCallMs,
    },
    throughput: {
      sequentialValidAuthorizes: N,
      totalWallMs: Math.round(batchMs),
      avgMsPerAuthorize: Math.round(batchMs / N),
      throughputTxPerSec: Math.round((N / (batchMs / 1000)) * 100) / 100,
      note: "Hardhat automine; not representative of mainnet block time.",
    },
    fees: {
      gasPriceWei: gasPrice.toString(),
      estimatedValidAuthorizeEth_at20gwei: (
        Number(validGas * 20_000_000_000n) / 1e18
      ).toFixed(6),
      estimatedValidAuthorizeEth_at30gwei: (
        Number(validGas * 30_000_000_000n) / 1e18
      ).toFixed(6),
    },
    proofCalldataBytes: (proof.length - 2) / 2,
  };
}

async function main() {
  const networkArg = process.argv.includes("--network")
    ? process.argv[process.argv.indexOf("--network") + 1]
    : "hardhat";

  let nargoVersion = "unknown";
  let bbVersion = "unknown";
  try {
    nargoVersion = execFileSync(PATH_NARGO, ["--version"], { encoding: "utf8" }).trim();
  } catch {}
  try {
    bbVersion = execFileSync(PATH_BB, ["--version"], { encoding: "utf8" }).trim();
  } catch {}

  const { proof } = loadAll(CIRCUIT_DIR);

  const zk = {};
  try {
    zk.nargoCompile = runTimedShell(
      `/usr/bin/time -f '{"wallSec":%e,"maxRssKiB":%M}' ${PATH_NARGO} compile`,
      CIRCUIT_DIR
    );
  } catch (e) {
    zk.nargoCompile = { error: e.message };
  }

  try {
    zk.nargoExecute = runTimedShell(
      `/usr/bin/time -f '{"wallSec":%e,"maxRssKiB":%M}' ${PATH_NARGO} execute`,
      CIRCUIT_DIR
    );
  } catch (e) {
    zk.nargoExecute = { error: e.message };
  }

  try {
    zk.bbWriteVk = runTimedShell(
      `/usr/bin/time -f '{"wallSec":%e,"maxRssKiB":%M}' ${PATH_BB} write_vk -b ./target/payment_policy.json -o ./target/ -t evm-no-zk`,
      CIRCUIT_DIR
    );
  } catch (e) {
    zk.bbWriteVk = { error: e.message };
  }

  try {
    zk.bbProve = runTimedShell(
      `/usr/bin/time -f '{"wallSec":%e,"maxRssKiB":%M}' ${PATH_BB} prove -b ./target/payment_policy.json -w ./target/payment_policy.gz -k ./target/vk -o ./target/ -t evm-no-zk`,
      CIRCUIT_DIR
    );
  } catch (e) {
    zk.bbProve = { error: e.message };
  }

  try {
    zk.bbVerify = runTimedShell(
      `/usr/bin/time -f '{"wallSec":%e,"maxRssKiB":%M}' ${PATH_BB} verify -p ./target/proof -k ./target/vk -i ./target/public_inputs -t evm-no-zk`,
      CIRCUIT_DIR
    );
  } catch (e) {
    zk.bbVerify = { error: e.message };
  }

  const nullifierRuns = [timeNullifier(), timeNullifier(), timeNullifier()];

  const report = {
    measuredAt: new Date().toISOString(),
    project: "zk-payment-authorizer",
    provingTarget: "evm-no-zk",
    toolchain: {
      nargo: nargoVersion,
      barretenberg: bbVersion,
      solidity: "0.8.28",
      evmVersion: "cancun",
    },
    environment: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model || "unknown",
      cpuCores: os.cpus().length,
      totalMemGiB: Math.round((os.totalmem() / 1024 ** 3) * 100) / 100,
    },
    proverTomlScenario: {
      spendingLimitCents: 5000,
      paymentAmountCents: 3000,
      description: "Valid $30 payment against $50 private limit",
    },
    artifactSizesBytes: {
      proof: fileSize(path.join(CIRCUIT_DIR, "target/proof")),
      verificationKey: fileSize(path.join(CIRCUIT_DIR, "target/vk")),
      witnessGz: fileSize(path.join(CIRCUIT_DIR, "target/payment_policy.gz")),
      acirJson: fileSize(path.join(CIRCUIT_DIR, "target/payment_policy.json")),
      honkVerifierSolidity: fileSize(path.join(ROOT, "contracts/UltraPlonkVerifier.sol")),
      proofCalldata: (proof.length - 2) / 2,
    },
    zkOffChain: zk,
    cryptography: {
      primitive: "Poseidon2 (noir-lang/poseidon v0.3.0)",
      nullifierComputeNodeMs: {
        runs: nullifierRuns,
        avgMs: Math.round((nullifierRuns.reduce((a, b) => a + b, 0) / nullifierRuns.length) * 100) / 100,
      },
      circuitConstraints: [
        "payment_amount <= spending_limit",
        "nullifier == Poseidon2::hash([tx_nonce], 1)",
      ],
    },
    onChain: await runOnChain(networkArg),
    limitations: [
      "TPS measured on Hardhat with instant automine; not mainnet/L2 throughput.",
      "Fee estimates use hypothetical 20/30 gwei; local Hardhat gas price is 0.",
      "HonkVerifier deploy is one-time per circuit version; authorize gas is per payment.",
    ],
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
