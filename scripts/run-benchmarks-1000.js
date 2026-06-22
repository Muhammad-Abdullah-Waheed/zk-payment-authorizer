/**
 * Multi-proof evaluation harness.
 *
 * Unlike scripts/run-benchmarks.js (which measures a single proof and reuses it
 * while mutating the nullifier — an on-chain *reject* path), this script
 * generates N **distinct, valid** proofs by rotating `tx_nonce` (so every
 * nullifier differs and every proof verifies), then reports the average plus
 * min / max / p50 / p95 / stddev for each metric.
 *
 * Off-chain, per proof:  nargo execute  -> bb prove  -> (bb verify)
 * On-chain,  per proof:  PaymentAuthorizer.authorize(proof, publicInputs)
 *                        -> all emit PaymentAuthorized (no replay collisions)
 *
 * Usage:
 *   node scripts/run-benchmarks-1000.js                 # N = 1000, hardhat in-proc
 *   node scripts/run-benchmarks-1000.js --proofs 200    # smaller run
 *   node scripts/run-benchmarks-1000.js --network localhost
 *   node scripts/run-benchmarks-1000.js --skip-verify   # skip per-proof bb verify
 *
 * Output: benchmark-results-1000.json at repo root.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

const ROOT = path.join(__dirname, "..");
const CIRCUIT_DIR = path.join(ROOT, "circuits", "payment_policy");
const OUT_PATH = path.join(ROOT, "benchmark-results-1000.json");

const { loadAll, PI } = require("./load_proof.js");
const {
  loadDefaultPolicy,
  buildProverRecord,
  writeProverToml,
  runNargoExecute,
  runBbProve,
} = require("./prover_pipeline.js");
const { publicInputsFromProver } = require("./policy.js");

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const PATH_NARGO = fs.existsSync(path.join(HOME, ".nargo/bin/nargo"))
  ? path.join(HOME, ".nargo/bin/nargo")
  : "nargo";
const PATH_BB = fs.existsSync(path.join(HOME, ".bb/bb"))
  ? path.join(HOME, ".bb/bb")
  : "bb";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const N = Math.max(1, parseInt(arg("--proofs", "1000"), 10));
const NETWORK = arg("--network", "hardhat");
const SKIP_VERIFY = process.argv.includes("--skip-verify");
// tx_nonce values to rotate through; base chosen to avoid the default (123).
const NONCE_BASE = BigInt(arg("--nonce-base", "1000000"));

function fileSize(p) {
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
}

/** Aggregate stats for a numeric array. */
function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const pct = (p) => sorted[Math.min(n - 1, Math.floor((p / 100) * n))];
  const round = (x) => Math.round(x * 1000) / 1000;
  return {
    count: n,
    avg: round(mean),
    min: round(sorted[0]),
    max: round(sorted[n - 1]),
    p50: round(pct(50)),
    p95: round(pct(95)),
    stddev: round(Math.sqrt(variance)),
  };
}

/** bigint-array stats (gas). Returns string fields to stay precise. */
function gasStats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0n);
  const avg = sum / BigInt(n);
  const pct = (p) => sorted[Math.min(n - 1, Math.floor((p / 100) * n))];
  return {
    count: n,
    avg: avg.toString(),
    min: sorted[0].toString(),
    max: sorted[n - 1].toString(),
    p50: pct(50).toString(),
    p95: pct(95).toString(),
  };
}

function ensureVk() {
  const vkPath = path.join(CIRCUIT_DIR, "target", "vk");
  if (fs.existsSync(vkPath)) return;
  console.log("target/vk missing — writing verification key...");
  execFileSync(
    PATH_BB,
    ["write_vk", "-b", "./target/payment_policy.json", "-o", "./target/", "-t", "evm-no-zk"],
    { cwd: CIRCUIT_DIR, stdio: ["ignore", "pipe", "pipe"] }
  );
}

function runBbVerify() {
  execFileSync(
    PATH_BB,
    ["verify", "-p", "./target/proof", "-k", "./target/vk", "-i", "./target/public_inputs", "-t", "evm-no-zk"],
    { cwd: CIRCUIT_DIR, stdio: ["ignore", "pipe", "pipe"] }
  );
}

/**
 * Phase 1 — generate N distinct valid proofs off-chain, timing each stage.
 * Returns { bundles, timings } where bundles feed the on-chain phase.
 */
async function generateProofs(policy) {
  const executeMs = [];
  const proveMs = [];
  const verifyMs = [];
  const proofBytes = [];
  const bundles = [];

  const payment = {
    payment_amount: "3000",
    current_time: "1715000000",
    vendor: "0x0000000000000000000000000000000000000000000000000000000000000001",
  };

  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const iterPolicy = { ...policy, tx_nonce: (NONCE_BASE + BigInt(i)).toString() };
    const prover = await buildProverRecord(iterPolicy, payment);
    writeProverToml(CIRCUIT_DIR, prover);

    const tExec = performance.now();
    const exec = runNargoExecute(CIRCUIT_DIR);
    executeMs.push(performance.now() - tExec);
    if (!exec.success) {
      throw new Error(`nargo execute failed on proof ${i}: ${exec.stderr}`);
    }

    const tProve = performance.now();
    runBbProve(CIRCUIT_DIR);
    proveMs.push(performance.now() - tProve);

    const proofPath = path.join(CIRCUIT_DIR, "target", "proof");
    const proofHex = "0x" + fs.readFileSync(proofPath).toString("hex");
    proofBytes.push((proofHex.length - 2) / 2);
    bundles.push({ proof: proofHex, publicInputs: publicInputsFromProver(prover) });

    if (!SKIP_VERIFY) {
      const tVerify = performance.now();
      runBbVerify();
      verifyMs.push(performance.now() - tVerify);
    }

    if ((i + 1) % 25 === 0 || i + 1 === N) {
      const elapsed = (performance.now() - t0) / 1000;
      const rate = (i + 1) / elapsed;
      process.stdout.write(
        `\r  off-chain proofs: ${i + 1}/${N}  (${rate.toFixed(2)} proofs/s, ${elapsed.toFixed(1)}s elapsed)   `
      );
    }
  }
  process.stdout.write("\n");

  return {
    bundles,
    offChainWallSec: Math.round(((performance.now() - t0) / 1000) * 1000) / 1000,
    timings: {
      nargoExecuteMs: stats(executeMs),
      bbProveMs: stats(proveMs),
      bbVerifyMs: SKIP_VERIFY ? null : stats(verifyMs),
      proofBytes: stats(proofBytes),
    },
  };
}

/**
 * Phase 2 — submit each distinct valid proof to PaymentAuthorizer.authorize().
 * All should emit PaymentAuthorized (unique nullifiers => no replay rejects).
 */
async function runOnChain(bundles) {
  process.env.HARDHAT_NETWORK = NETWORK;
  delete require.cache[require.resolve("hardhat")];
  const hre = require("hardhat");

  const commitment = bundles[0].publicInputs[PI.POLICY_COMMITMENT];

  const HonkVerifier = await hre.ethers.getContractFactory("HonkVerifier");
  const vTx = await HonkVerifier.deploy();
  const vRc = await vTx.deploymentTransaction().wait();
  const verifier = await vTx.getAddress();

  const PolicyRegistry = await hre.ethers.getContractFactory("PolicyRegistry");
  const registry = await PolicyRegistry.deploy();
  await registry.waitForDeployment();
  await (await registry.registerPolicy(commitment)).wait();

  const PaymentAuthorizer = await hre.ethers.getContractFactory("PaymentAuthorizer");
  const aTx = await PaymentAuthorizer.deploy(verifier, await registry.getAddress());
  const aRc = await aTx.deploymentTransaction().wait();
  const authorizer = await aTx.getAddress();
  const authorizerC = await hre.ethers.getContractAt("PaymentAuthorizer", authorizer);
  const verifierC = await hre.ethers.getContractAt("HonkVerifier", verifier);

  const authorizedTopic = authorizerC.interface.getEvent("PaymentAuthorized").topicHash;

  const authorizeGas = [];
  const authorizeMs = [];
  const verifyStaticMs = [];
  let authorizedCount = 0;
  let rejectedCount = 0;

  const t0 = performance.now();
  for (let i = 0; i < bundles.length; i++) {
    const { proof, publicInputs } = bundles[i];

    // Static-call the raw verifier for a pure verification-latency sample.
    const tV = performance.now();
    await verifierC.verify.staticCall(proof, publicInputs);
    verifyStaticMs.push(performance.now() - tV);

    const tA = performance.now();
    const tx = await authorizerC.authorize(proof, publicInputs);
    const rc = await tx.wait();
    authorizeMs.push(performance.now() - tA);
    authorizeGas.push(rc.gasUsed);

    const ok = rc.logs.some((l) => l.topics[0] === authorizedTopic);
    if (ok) authorizedCount++;
    else rejectedCount++;

    if ((i + 1) % 25 === 0 || i + 1 === bundles.length) {
      const elapsed = (performance.now() - t0) / 1000;
      process.stdout.write(
        `\r  on-chain authorizes: ${i + 1}/${bundles.length}  (${((i + 1) / elapsed).toFixed(1)} tx/s)   `
      );
    }
  }
  process.stdout.write("\n");
  const batchMs = performance.now() - t0;

  const bytecodeHonk = await hre.ethers.provider.getCode(verifier);
  const bytecodeAuth = await hre.ethers.provider.getCode(authorizer);
  const avgGas = BigInt(gasStats(authorizeGas).avg);

  return {
    network: NETWORK,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    proofsSubmitted: bundles.length,
    authorizedCount,
    rejectedCount,
    deployGas: {
      HonkVerifier: vRc.gasUsed.toString(),
      PaymentAuthorizer: aRc.gasUsed.toString(),
      total: (vRc.gasUsed + aRc.gasUsed).toString(),
    },
    deployedBytecodeBytes: {
      HonkVerifier: (bytecodeHonk.length - 2) / 2,
      PaymentAuthorizer: (bytecodeAuth.length - 2) / 2,
    },
    authorizeGas: gasStats(authorizeGas),
    authorizeLatencyMs: stats(authorizeMs),
    honkVerifyStaticCallMs: stats(verifyStaticMs),
    throughput: {
      totalWallMs: Math.round(batchMs),
      avgMsPerAuthorize: Math.round(batchMs / bundles.length),
      throughputTxPerSec: Math.round((bundles.length / (batchMs / 1000)) * 100) / 100,
      note: "Hardhat automine; distinct VALID proofs (no replay/reject shortcut). Not mainnet block time.",
    },
    fees: {
      avgGas: avgGas.toString(),
      estimatedAuthorizeEth_at20gwei: (Number(avgGas * 20_000_000_000n) / 1e18).toFixed(6),
      estimatedAuthorizeEth_at30gwei: (Number(avgGas * 30_000_000_000n) / 1e18).toFixed(6),
    },
  };
}

async function main() {
  console.log(`zk-payment-authorizer — ${N}-proof evaluation`);
  console.log(`network=${NETWORK}  skipVerify=${SKIP_VERIFY}\n`);

  // Preconditions: toolchain + compiled circuit must exist.
  for (const [bin, p] of [["nargo", PATH_NARGO], ["bb", PATH_BB]]) {
    try {
      execFileSync(p, ["--version"], { stdio: "ignore" });
    } catch {
      throw new Error(`'${bin}' not found (looked at '${p}'). Install the ZK toolchain per README step 2/3.`);
    }
  }
  if (!fs.existsSync(path.join(CIRCUIT_DIR, "target", "payment_policy.json"))) {
    throw new Error("circuits/payment_policy/target/payment_policy.json missing. Run `nargo compile` first.");
  }
  ensureVk();

  let nargoVersion = "unknown";
  let bbVersion = "unknown";
  try { nargoVersion = execFileSync(PATH_NARGO, ["--version"], { encoding: "utf8" }).trim(); } catch {}
  try { bbVersion = execFileSync(PATH_BB, ["--version"], { encoding: "utf8" }).trim(); } catch {}

  const policy = loadDefaultPolicy(CIRCUIT_DIR);

  console.log("Phase 1/2 — generating distinct valid proofs off-chain...");
  const offChain = await generateProofs(policy);

  console.log("Phase 2/2 — submitting proofs on-chain...");
  const onChain = await runOnChain(offChain.bundles);

  const report = {
    measuredAt: new Date().toISOString(),
    project: "zk-payment-authorizer",
    evaluation: `average over ${N} distinct valid proofs`,
    proofsRequested: N,
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
    scenario: {
      spendingLimitCents: Number(policy.spending_limit),
      paymentAmountCents: 3000,
      description: "Valid $30 payment against $50 private limit; tx_nonce rotated per proof",
    },
    artifactSizesBytes: {
      verificationKey: fileSize(path.join(CIRCUIT_DIR, "target/vk")),
      acirJson: fileSize(path.join(CIRCUIT_DIR, "target/payment_policy.json")),
      honkVerifierSolidity: fileSize(path.join(ROOT, "contracts/UltraPlonkVerifier.sol")),
    },
    offChain: {
      wallSec: offChain.offChainWallSec,
      perProofMs: offChain.timings,
    },
    onChain,
    notes: [
      `Every one of the ${N} proofs is freshly generated with a unique tx_nonce, so all authorize() calls take the VALID path (PaymentAuthorized) — this is the true per-proof gas/latency, not the reject path.`,
      "Timing uses performance.now() around each child process (cross-platform); max-RSS is not sampled here.",
      "Hardhat automine inflates throughput vs. a real network bound by block time / gas market.",
    ],
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nWrote ${OUT_PATH}`);
  console.log("\nSummary:");
  console.log(`  bb prove (avg):        ${report.offChain.perProofMs.bbProveMs.avg} ms`);
  console.log(`  authorize gas (avg):   ${report.onChain.authorizeGas.avg}`);
  console.log(`  authorize latency:     ${report.onChain.authorizeLatencyMs.avg} ms (avg)`);
  console.log(`  EVM verify staticCall: ${report.onChain.honkVerifyStaticCallMs.avg} ms (avg)`);
  console.log(`  authorized/rejected:   ${report.onChain.authorizedCount}/${report.onChain.rejectedCount}`);
}

main().catch((err) => {
  console.error("\n" + err.message);
  process.exit(1);
});
