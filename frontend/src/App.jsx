import { useEffect, useState } from "react";
import "./App.css";

const API_BASE = "http://127.0.0.1:4000";

function StateCard({ state }) {
  if (!state) return null;
  return (
    <div className="card">
      <h3>Deployment</h3>
      <table className="kv">
        <tbody>
          <tr><td>Network</td><td>{state.deployment.network} (chainId {state.deployment.chainId})</td></tr>
          <tr><td>Verifier</td><td><code>{state.deployment.verifier}</code></td></tr>
          <tr><td>Authorizer</td><td><code>{state.deployment.authorizer}</code></td></tr>
          <tr><td>Proof size</td><td>{state.proofLength} bytes</td></tr>
          <tr><td>Public amount</td><td>{state.paymentAmountWei}</td></tr>
          <tr><td>Public nullifier</td><td><code className="trim">{state.nullifier}</code></td></tr>
        </tbody>
      </table>
    </div>
  );
}

function ResultBlock({ title, result, kind }) {
  if (!result) return null;

  const success = kind === "A" ? result.ok : result.proveSucceeded === false && result.onChain?.event === "PaymentRejected";
  const cls = success ? "result ok" : "result err";

  return (
    <div className={cls}>
      <h4>{title}</h4>
      {kind === "A" && (
        <>
          <p>
            <strong>On-chain event:</strong> {result.event}
          </p>
          <p>
            <strong>Amount:</strong> {result.paymentAmount}
            <br />
            <strong>Nullifier:</strong> <code className="trim">{result.nullifier}</code>
          </p>
          <p>
            <strong>Tx:</strong> <code className="trim">{result.txHash}</code>
            <br />
            <strong>Block:</strong> {result.blockNumber} | <strong>Gas:</strong> {result.gasUsed}
          </p>
        </>
      )}
      {kind === "B" && (
        <>
          <p>
            <strong>Proof generation:</strong> {result.proveSucceeded ? "succeeded (unexpected)" : "failed (witness unsatisfiable)"}
          </p>
          {result.stderr && (
            <pre className="stderr">{result.stderr.split("\n").slice(0, 10).join("\n")}</pre>
          )}
          {result.onChain && (
            <p>
              <strong>On-chain fallback (tampered proof):</strong> {result.onChain.event} {result.onChain.args?.[0]}
              <br />
              <strong>Tx:</strong> <code className="trim">{result.onChain.txHash}</code>
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [loadingA, setLoadingA] = useState(false);
  const [loadingB, setLoadingB] = useState(false);
  const [resultA, setResultA] = useState(null);
  const [resultB, setResultB] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API_BASE}/api/state`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setState(data);
      })
      .catch((e) => setError(e.message));
  }, []);

  async function runScenarioA() {
    setLoadingA(true);
    setError("");
    setResultA(null);
    try {
      const r = await fetch(`${API_BASE}/api/scenarioA`, { method: "POST" });
      const data = await r.json();
      if (data.error) setError(data.error);
      else setResultA(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingA(false);
    }
  }

  async function runScenarioB() {
    setLoadingB(true);
    setError("");
    setResultB(null);
    try {
      const r = await fetch(`${API_BASE}/api/scenarioB`, { method: "POST" });
      const data = await r.json();
      if (data.error) setError(data.error);
      else setResultB(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingB(false);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>ZK Payment Authorization</h1>
        <p className="sub">
          Private spending policy: <strong>limit = $50</strong> ($5000 in cents).
          A Noir + Barretenberg proof shows that a payment respects the policy
          without revealing the limit or transaction nonce.
        </p>
      </header>

      <StateCard state={state} />

      <section className="actions">
        <div className="action">
          <button
            className="btn btn-ok"
            onClick={runScenarioA}
            disabled={loadingA}
          >
            {loadingA ? "Submitting…" : "Authorize $30 payment"}
          </button>
          <p className="hint">
            Uses the pre-generated valid proof (payment $30 ≤ limit $50). Expect on-chain <code>PaymentAuthorized</code>.
          </p>
        </div>

        <div className="action">
          <button
            className="btn btn-warn"
            onClick={runScenarioB}
            disabled={loadingB}
          >
            {loadingB ? "Trying…" : "Try $80 payment"}
          </button>
          <p className="hint">
            Re-runs <code>nargo execute</code> with payment $80 &gt; limit $50. Expect witness-solver failure and on-chain <code>PaymentRejected</code> for a tampered proof.
          </p>
        </div>
      </section>

      {error && <div className="result err"><strong>Error:</strong> {error}</div>}

      <ResultBlock title="Scenario A result" result={resultA} kind="A" />
      <ResultBlock title="Scenario B result" result={resultB} kind="B" />

      <footer>
        <p>Local Hardhat network · UltraHonk verifier (no-zk variant, optimized) · Poseidon2 nullifier</p>
      </footer>
    </div>
  );
}
