const express = require("express");
const cors = require("cors");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CIRCUIT_DIR = path.join(ROOT, "circuits", "payment_policy");

const {
  createSimulatorState,
  loadContracts,
  getStateSnapshot,
  previewPolicy,
  registerPolicy,
  authorizeBundle,
  agentProve,
  normalizePolicy,
  runDemo,
} = require("./simulator_api.js");
const { loadAll } = require("./load_proof.js");

const state = createSimulatorState(CIRCUIT_DIR);

const app = express();
app.use(cors());
app.use(express.json());

function handle(handler) {
  return async (req, res) => {
    try {
      const contracts = loadContracts(ROOT);
      const data = await handler(req, res, contracts);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

app.get(
  "/api/state",
  handle(async () => getStateSnapshot(state, loadContracts(ROOT)))
);

app.get("/api/history", (req, res) => {
  res.json({ history: state.history });
});

app.post(
  "/api/policy/preview",
  handle(async (req) => previewPolicy(normalizePolicy(req.body, state.activePolicy)))
);

app.post(
  "/api/policy/register",
  handle(async (req) => {
    const policy = normalizePolicy(req.body, state.activePolicy);
    return registerPolicy(state, loadContracts(ROOT), policy);
  })
);

app.post(
  "/api/agent/prove",
  handle(async (req) => agentProve(state, req.body))
);

app.post(
  "/api/agent/authorize",
  handle(async (req) => {
    const contracts = loadContracts(ROOT);
    let bundle = state.lastBundle;
    if (req.body.usePrebuilt) {
      bundle = loadAll(CIRCUIT_DIR);
    }
    if (!bundle) {
      throw new Error("No proof available. Run Agent Prove first or use prebuilt.");
    }
    return authorizeBundle(state, contracts, bundle, {
      scenario: req.body.scenario || "agent",
      label: req.body.label || "Agent authorization",
    });
  })
);

app.post(
  "/api/demo/:type",
  handle(async (req) => runDemo(state, loadContracts(ROOT), req.params.type))
);

/** Legacy endpoints */
app.post(
  "/api/scenarioA",
  handle(async () => runDemo(state, loadContracts(ROOT), "valid30"))
);

app.post(
  "/api/scenarioB",
  handle(async () => runDemo(state, loadContracts(ROOT), "overLimit"))
);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`zk-payment server listening on http://127.0.0.1:${PORT}`);
});
