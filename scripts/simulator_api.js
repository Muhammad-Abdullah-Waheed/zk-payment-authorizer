/**
 * Shared helpers for the agent simulator HTTP API and server routes.
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadAll, tamperedProof, PI } = require("./load_proof.js");
const {
  computePolicyCommitment,
  vendorFieldFromSlot,
  policyFromProverRecord,
  loadDefaultPolicy,
  provePaymentRequest,
} = require("./prover_pipeline.js");

const HISTORY_LIMIT = 100;

function createSimulatorState(circuitDir) {
  return {
    circuitDir,
    activePolicy: loadDefaultPolicy(circuitDir),
    lastBundle: null,
    history: [],
  };
}

function pushHistory(state, entry) {
  state.history.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...entry,
  });
  if (state.history.length > HISTORY_LIMIT) {
    state.history.length = HISTORY_LIMIT;
  }
}

async function parseAuthorizeResult(receipt, authorizerInterface) {
  for (const log of receipt.logs) {
    try {
      const parsed = authorizerInterface.parseLog(log);
      if (parsed) {
        return {
          event: parsed.name,
          args: parsed.args.map((a) =>
            typeof a === "bigint" ? a.toString() : a
          ),
        };
      }
    } catch {
      continue;
    }
  }
  return { event: "Unknown", args: [] };
}

function formatAuthorizeResponse(tx, receipt, parsed, publicInputs) {
  const ok = parsed.event === "PaymentAuthorized";
  return {
    ok,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    event: parsed.event,
    reason: ok ? null : parsed.args[0] || "Rejected",
    args: parsed.args,
    publicInputs,
    paymentAmount: BigInt(publicInputs[PI.PAYMENT_AMOUNT]).toString(),
    currentTime: BigInt(publicInputs[PI.CURRENT_TIME]).toString(),
    vendor: publicInputs[PI.VENDOR],
    policyCommitment: publicInputs[PI.POLICY_COMMITMENT],
    nullifier: publicInputs[PI.NULLIFIER],
  };
}

function loadContracts(root) {
  const deploymentPath = path.join(root, "deployment.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      "deployment.json not found. Run: npx hardhat run scripts/deploy.js --network localhost"
    );
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
  const key =
    process.env.SIMULATOR_PRIVATE_KEY ||
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(key, provider);

  const authorizerArtifact = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "artifacts/contracts/PaymentAuthorizer.sol/PaymentAuthorizer.json"
      ),
      "utf8"
    )
  );
  const registryArtifact = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "artifacts/contracts/PolicyRegistry.sol/PolicyRegistry.json"
      ),
      "utf8"
    )
  );

  const authorizer = new ethers.Contract(
    deployment.authorizer,
    authorizerArtifact.abi,
    wallet
  );
  const registry = new ethers.Contract(
    deployment.policyRegistry,
    registryArtifact.abi,
    wallet
  );

  return { deployment, provider, authorizer, registry };
}

async function getStateSnapshot(state, contracts) {
  const { deployment, registry } = contracts;
  let prebuilt = null;
  try {
    const bundle = loadAll(state.circuitDir);
    prebuilt = {
      paymentAmount: bundle.publicInputs[PI.PAYMENT_AMOUNT],
      currentTime: bundle.publicInputs[PI.CURRENT_TIME],
      vendor: bundle.publicInputs[PI.VENDOR],
      policyCommitment: bundle.publicInputs[PI.POLICY_COMMITMENT],
      nullifier: bundle.publicInputs[PI.NULLIFIER],
      proofBytes: (bundle.proof.length - 2) / 2,
    };
  } catch {
    prebuilt = null;
  }

  const commitment = await computePolicyCommitment(state.activePolicy);
  let policyRegistered = false;
  try {
    policyRegistered = await registry.isRegistered(commitment);
  } catch {
    policyRegistered = false;
  }

  return {
    deployment,
    activePolicy: state.activePolicy,
    policyCommitment: commitment,
    policyRegistered,
    prebuilt,
    lastBundle: state.lastBundle
      ? {
          paymentAmount: state.lastBundle.publicInputs[PI.PAYMENT_AMOUNT],
          nullifier: state.lastBundle.publicInputs[PI.NULLIFIER],
        }
      : null,
    historyCount: state.history.length,
  };
}

async function previewPolicy(policy) {
  const commitment = await computePolicyCommitment(policy);
  return { policy, policyCommitment: commitment };
}

async function registerPolicy(state, contracts, policy) {
  const { registry } = contracts;
  const { policyCommitment } = await previewPolicy(policy);
  const already = await registry.isRegistered(policyCommitment);
  if (!already) {
    const tx = await registry.registerPolicy(policyCommitment);
    await tx.wait();
  }
  state.activePolicy = policy;
  return { policyCommitment, registered: true, alreadyRegistered: already };
}

async function authorizeBundle(state, contracts, bundle, meta) {
  const { authorizer } = contracts;
  const { proof, publicInputs } = bundle;
  const tx = await authorizer.authorize(proof, publicInputs);
  const receipt = await tx.wait();
  const parsed = await parseAuthorizeResult(receipt, authorizer.interface);
  const result = formatAuthorizeResponse(tx, receipt, parsed, publicInputs);
  pushHistory(state, {
    scenario: meta.scenario || "authorize",
    label: meta.label || meta.scenario,
    ...result,
  });
  return result;
}

async function agentProve(state, body) {
  const policy = normalizePolicy(body, state.activePolicy);
  const payment = {
    payment_amount: body.payment_amount ?? "3000",
    current_time: body.current_time ?? String(Math.floor(Date.now() / 1000)),
    vendor: body.vendor ?? vendorFieldFromSlot(body.vendor_slot ?? 1),
  };
  const result = await provePaymentRequest(state.circuitDir, policy, payment);
  if (!result.ok) {
    return {
      ok: false,
      stage: result.stage,
      stderr: result.stderr,
      prover: result.prover,
    };
  }
  state.lastBundle = {
    proof: result.proof,
    publicInputs: result.publicInputs,
    prover: result.prover,
  };
  return {
    ok: true,
    proofLength: (result.proof.length - 2) / 2,
    publicInputs: result.publicInputs,
    prover: policyFromProverRecord(result.prover),
    payment,
  };
}

function normalizePolicy(body, fallback) {
  const vendors = [];
  for (let i = 0; i < 4; i++) {
    const key = `approved_vendor_${i}`;
    vendors.push(
      body[key] ||
        body.vendors?.[i] ||
        fallback[`approved_vendor_${i}`]
    );
  }
  return {
    spending_limit: String(body.spending_limit ?? fallback.spending_limit),
    tx_nonce: String(body.tx_nonce ?? fallback.tx_nonce),
    window_start: String(body.window_start ?? fallback.window_start),
    window_end: String(body.window_end ?? fallback.window_end),
    approved_vendor_0: vendors[0],
    approved_vendor_1: vendors[1],
    approved_vendor_2: vendors[2],
    approved_vendor_3: vendors[3],
  };
}

async function runDemo(state, contracts, type) {
  const policy = state.activePolicy;
  const commitment = await computePolicyCommitment(policy);

  switch (type) {
    case "valid30": {
      const payment = {
        payment_amount: "3000",
        current_time: "1715000000",
        vendor: vendorFieldFromSlot(1),
      };
      const proved = await provePaymentRequest(state.circuitDir, policy, payment);
      if (!proved.ok) {
        return { ok: false, stage: proved.stage, stderr: proved.stderr };
      }
      state.lastBundle = proved;
      return authorizeBundle(
        state,
        contracts,
        proved,
        { scenario: "valid30", label: "Valid $30 payment" }
      );
    }
    case "replay": {
      const bundle =
        state.lastBundle || loadAll(state.circuitDir);
      return authorizeBundle(state, contracts, bundle, {
        scenario: "replay",
        label: "Replay same proof",
      });
    }
    case "overLimit": {
      const payment = {
        payment_amount: "8000",
        current_time: "1715000000",
        vendor: vendorFieldFromSlot(1),
      };
      const proved = await provePaymentRequest(state.circuitDir, policy, payment);
      return {
        ok: false,
        demo: "overLimit",
        proveSucceeded: proved.ok,
        stderr: proved.stderr || null,
        onChain: null,
        message: proved.ok
          ? "Unexpected: witness should fail"
          : "Witness failed (payment > limit)",
      };
    }
    case "badVendor": {
      const payment = {
        payment_amount: "3000",
        current_time: "1715000000",
        vendor:
          "0x0000000000000000000000000000000000000000000000000000000000000099",
      };
      const proved = await provePaymentRequest(state.circuitDir, policy, payment);
      return {
        ok: false,
        demo: "badVendor",
        proveSucceeded: proved.ok,
        stderr: proved.stderr,
        message: proved.ok ? "Unexpected" : "Witness failed (vendor not approved)",
      };
    }
    case "badTime": {
      const payment = {
        payment_amount: "3000",
        current_time: "1600000000",
        vendor: vendorFieldFromSlot(1),
      };
      const proved = await provePaymentRequest(state.circuitDir, policy, payment);
      return {
        ok: false,
        demo: "badTime",
        proveSucceeded: proved.ok,
        stderr: proved.stderr,
        message: proved.ok ? "Unexpected" : "Witness failed (outside time window)",
      };
    }
    case "tampered": {
      const bundle = loadAll(state.circuitDir);
      const badProof = tamperedProof(bundle.proof);
      const freshNullifier = "0x" + "c".repeat(64);
      const badInputs = [...bundle.publicInputs];
      badInputs[PI.NULLIFIER] = freshNullifier;
      return authorizeBundle(
        state,
        contracts,
        { proof: badProof, publicInputs: badInputs },
        { scenario: "tampered", label: "Tampered proof" }
      );
    }
    case "unknownPolicy": {
      const bundle = loadAll(state.circuitDir);
      const badInputs = [...bundle.publicInputs];
      badInputs[PI.POLICY_COMMITMENT] = "0x" + "d".repeat(64);
      badInputs[PI.NULLIFIER] = "0x" + "e".repeat(64);
      return authorizeBundle(
        state,
        contracts,
        { proof: bundle.proof, publicInputs: badInputs },
        { scenario: "unknownPolicy", label: "Unregistered policy commitment" }
      );
    }
    default:
      throw new Error(`Unknown demo: ${type}`);
  }
}

module.exports = {
  PI,
  createSimulatorState,
  pushHistory,
  loadContracts,
  getStateSnapshot,
  previewPolicy,
  registerPolicy,
  authorizeBundle,
  agentProve,
  normalizePolicy,
  runDemo,
  vendorFieldFromSlot,
};
