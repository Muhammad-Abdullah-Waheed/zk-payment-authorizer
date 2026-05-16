const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { BarretenbergSync, Fr } = require("@aztec/bb.js");
const {
  computePolicyCommitment,
  publicInputsFromProver,
  VENDOR_SLOTS,
} = require("./policy.js");
const { readProverToml } = require("./load_proof.js");

const DEFAULT_VENDORS = [
  "0x0000000000000000000000000000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000000000000000000000000000003",
  "0x0000000000000000000000000000000000000000000000000000000000000004",
];

function vendorFieldFromSlot(slot) {
  const n = Number(slot);
  if (!Number.isInteger(n) || n < 1 || n > VENDOR_SLOTS) {
    throw new Error(`vendor_slot must be 1..${VENDOR_SLOTS}`);
  }
  return DEFAULT_VENDORS[n - 1];
}

function policyFromProverRecord(prover) {
  return {
    spending_limit: String(prover.spending_limit),
    tx_nonce: String(prover.tx_nonce),
    window_start: String(prover.window_start),
    window_end: String(prover.window_end),
    approved_vendor_0: prover.approved_vendor_0,
    approved_vendor_1: prover.approved_vendor_1,
    approved_vendor_2: prover.approved_vendor_2,
    approved_vendor_3: prover.approved_vendor_3,
  };
}

function loadDefaultPolicy(circuitDir) {
  return policyFromProverRecord(readProverToml(circuitDir));
}

async function computeNullifierHex(txNonce) {
  const api = await BarretenbergSync.initSingleton();
  const hash = api.poseidon2Hash([new Fr(BigInt(txNonce))]);
  return "0x" + Buffer.from(hash.toBuffer()).toString("hex");
}

function formatProverToml(prover) {
  return `spending_limit = "${prover.spending_limit}"
tx_nonce = "${prover.tx_nonce}"
window_start = "${prover.window_start}"
window_end = "${prover.window_end}"
approved_vendor_0 = "${prover.approved_vendor_0}"
approved_vendor_1 = "${prover.approved_vendor_1}"
approved_vendor_2 = "${prover.approved_vendor_2}"
approved_vendor_3 = "${prover.approved_vendor_3}"

payment_amount = "${prover.payment_amount}"
current_time = "${prover.current_time}"
vendor = "${prover.vendor}"
policy_commitment = "${prover.policy_commitment}"
nullifier = "${prover.nullifier}"
`;
}

async function buildProverRecord(policy, payment) {
  const policy_commitment = await computePolicyCommitment(policy);
  const nullifier = await computeNullifierHex(policy.tx_nonce);
  return {
    ...policy,
    payment_amount: String(payment.payment_amount),
    current_time: String(payment.current_time),
    vendor: payment.vendor,
    policy_commitment,
    nullifier,
  };
}

function writeProverToml(circuitDir, prover) {
  const proverPath = path.join(circuitDir, "Prover.toml");
  fs.writeFileSync(proverPath, formatProverToml(prover));
}

function runNargoExecute(circuitDir) {
  try {
    execFileSync("nargo", ["execute"], {
      cwd: circuitDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { success: true, stderr: "" };
  } catch (err) {
    return {
      success: false,
      stderr: (err.stderr && err.stderr.toString()) || err.message,
    };
  }
}

function runBbProve(circuitDir) {
  execFileSync(
    "bb",
    [
      "prove",
      "-b",
      "./target/payment_policy.json",
      "-w",
      "./target/payment_policy.gz",
      "-k",
      "./target/vk",
      "-o",
      "./target/",
      "-t",
      "evm-no-zk",
    ],
    { cwd: circuitDir, stdio: ["ignore", "pipe", "pipe"] }
  );
}

function readProofBundle(circuitDir) {
  const proofPath = path.join(circuitDir, "target", "proof");
  const proof = "0x" + fs.readFileSync(proofPath).toString("hex");
  const prover = readProverToml(circuitDir);
  const publicInputs = publicInputsFromProver(prover);
  return { prover, proof, publicInputs };
}

async function provePaymentRequest(circuitDir, policy, payment) {
  const prover = await buildProverRecord(policy, payment);
  writeProverToml(circuitDir, prover);
  const executeResult = runNargoExecute(circuitDir);
  if (!executeResult.success) {
    return { ok: false, stage: "execute", stderr: executeResult.stderr, prover };
  }
  runBbProve(circuitDir);
  const bundle = readProofBundle(circuitDir);
  return { ok: true, ...bundle };
}

module.exports = {
  DEFAULT_VENDORS,
  vendorFieldFromSlot,
  policyFromProverRecord,
  loadDefaultPolicy,
  computeNullifierHex,
  buildProverRecord,
  formatProverToml,
  writeProverToml,
  runNargoExecute,
  runBbProve,
  provePaymentRequest,
  computePolicyCommitment,
};
