import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import "./App.css";

const DEFAULT_POLICY = {
  spending_limit: "5000",
  tx_nonce: "123",
  window_start: "1700000000",
  window_end: "2000000000",
  approved_vendor_0:
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  approved_vendor_1:
    "0x0000000000000000000000000000000000000000000000000000000000000002",
  approved_vendor_2:
    "0x0000000000000000000000000000000000000000000000000000000000000003",
  approved_vendor_3:
    "0x0000000000000000000000000000000000000000000000000000000000000004",
};

const VENDOR_OPTIONS = [
  { slot: 1, label: "Vendor #1 (0x…01)" },
  { slot: 2, label: "Vendor #2 (0x…02)" },
  { slot: 3, label: "Vendor #3 (0x…03)" },
  { slot: 4, label: "Vendor #4 (0x…04)" },
];

const DEMOS = [
  { id: "valid30", label: "Valid $30 payment", desc: "Prove + authorize within policy", tone: "ok" },
  { id: "replay", label: "Replay attack", desc: "Submit same proof twice", tone: "warn" },
  { id: "overLimit", label: "Over spending limit", desc: "Witness fails ($80 > $50)", tone: "warn" },
  { id: "badVendor", label: "Unapproved vendor", desc: "Witness fails (vendor ∉ list)", tone: "warn" },
  { id: "badTime", label: "Outside time window", desc: "Witness fails (time too early)", tone: "warn" },
  { id: "tampered", label: "Tampered proof", desc: "On-chain Invalid proof", tone: "danger" },
  { id: "unknownPolicy", label: "Unknown policy", desc: "Unregistered commitment", tone: "danger" },
];

const TABS = [
  { id: "status", label: "Status" },
  { id: "policy", label: "Policy setup" },
  { id: "agent", label: "Agent simulator" },
  { id: "demos", label: "Quick demos" },
  { id: "history", label: "History" },
];

function centsToUsd(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function formatUnix(ts) {
  const n = Number(ts);
  if (!n) return "—";
  return new Date(n * 1000).toLocaleString();
}

function trimCode(value, len = 18) {
  if (!value) return "—";
  const s = String(value);
  if (s.length <= len * 2 + 2) return s;
  return `${s.slice(0, len)}…${s.slice(-8)}`;
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function TxResult({ result }) {
  if (!result) return null;
  const ok = result.ok === true;
  const cls = ok ? "result ok" : "result err";
  return (
    <div className={cls}>
      <h4>{ok ? "Success" : "Rejected / failed"}</h4>
      {result.label && <p><strong>Scenario:</strong> {result.label}</p>}
      {result.message && <p>{result.message}</p>}
      {result.stage && <p><strong>Stage:</strong> {result.stage}</p>}
      {result.event && <p><strong>Event:</strong> {result.event}</p>}
      {result.reason && <p><strong>Reason:</strong> {result.reason}</p>}
      {result.proveSucceeded !== undefined && (
        <p><strong>Witness / prove:</strong> {result.proveSucceeded ? "succeeded" : "failed"}</p>
      )}
      {result.paymentAmount && (
        <p>
          <strong>Amount:</strong> {centsToUsd(result.paymentAmount)} ({result.paymentAmount} cents)
        </p>
      )}
      {result.currentTime && (
        <p><strong>Time:</strong> {formatUnix(result.currentTime)}</p>
      )}
      {result.vendor && (
        <p><strong>Vendor:</strong> <code>{trimCode(result.vendor, 12)}</code></p>
      )}
      {result.nullifier && (
        <p><strong>Nullifier:</strong> <code className="trim">{result.nullifier}</code></p>
      )}
      {result.txHash && (
        <p>
          <strong>Tx:</strong> <code className="trim">{result.txHash}</code>
          {result.blockNumber != null && <> · block {result.blockNumber}</>}
          {result.gasUsed && <> · gas {result.gasUsed}</>}
        </p>
      )}
      {result.stderr && (
        <pre className="stderr">{result.stderr.split("\n").slice(0, 12).join("\n")}</pre>
      )}
    </div>
  );
}

function StatusTab({ snapshot }) {
  if (!snapshot) return <p className="muted">Loading…</p>;
  const d = snapshot.deployment || {};
  return (
    <div className="grid-2">
      <div className="card">
        <h3>Deployment</h3>
        <table className="kv">
          <tbody>
            <tr><td>Network</td><td>{d.network || "—"} (chainId {d.chainId ?? "—"})</td></tr>
            <tr><td>PolicyRegistry</td><td><code className="trim">{d.policyRegistry}</code></td></tr>
            <tr><td>HonkVerifier</td><td><code className="trim">{d.verifier}</code></td></tr>
            <tr><td>PaymentAuthorizer</td><td><code className="trim">{d.authorizer}</code></td></tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Active policy</h3>
        <table className="kv">
          <tbody>
            <tr><td>Spending limit</td><td>{centsToUsd(snapshot.activePolicy?.spending_limit)}</td></tr>
            <tr><td>Time window</td><td>{formatUnix(snapshot.activePolicy?.window_start)} → {formatUnix(snapshot.activePolicy?.window_end)}</td></tr>
            <tr><td>Commitment</td><td><code className="trim">{snapshot.policyCommitment}</code></td></tr>
            <tr><td>On-chain registered</td><td>{snapshot.policyRegistered ? "Yes" : "No"}</td></tr>
            <tr><td>History entries</td><td>{snapshot.historyCount}</td></tr>
          </tbody>
        </table>
      </div>
      {snapshot.prebuilt && (
        <div className="card span-2">
          <h3>Prebuilt proof (Prover.toml)</h3>
          <table className="kv">
            <tbody>
              <tr><td>Amount</td><td>{centsToUsd(snapshot.prebuilt.paymentAmount)}</td></tr>
              <tr><td>Time</td><td>{formatUnix(snapshot.prebuilt.currentTime)}</td></tr>
              <tr><td>Proof size</td><td>{snapshot.prebuilt.proofBytes} bytes</td></tr>
              <tr><td>Nullifier</td><td><code className="trim">{snapshot.prebuilt.nullifier}</code></td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PolicyTab({ policy, setPolicy, onPreview, onRegister, loading, preview, lastResult }) {
  const set = (key) => (e) => setPolicy((p) => ({ ...p, [key]: e.target.value }));

  return (
    <div className="stack">
      <p className="muted">
        Define a <strong>private</strong> spending policy. Only the Poseidon commitment is stored on-chain;
        limits, vendors, and time bounds stay in the proof witness.
      </p>
      <div className="card form-grid">
        <Field label="Spending limit (cents)" hint="e.g. 5000 = $50.00">
          <input type="number" value={policy.spending_limit} onChange={set("spending_limit")} />
        </Field>
        <Field label="Transaction nonce" hint="Used for nullifier = Poseidon2(nonce)">
          <input type="text" value={policy.tx_nonce} onChange={set("tx_nonce")} />
        </Field>
        <Field label="Window start (unix)">
          <input type="number" value={policy.window_start} onChange={set("window_start")} />
        </Field>
        <Field label="Window end (unix)">
          <input type="number" value={policy.window_end} onChange={set("window_end")} />
        </Field>
        {[0, 1, 2, 3].map((i) => (
          <Field key={i} label={`Approved vendor ${i + 1} (field)`} className="span-2">
            <input
              type="text"
              value={policy[`approved_vendor_${i}`]}
              onChange={set(`approved_vendor_${i}`)}
            />
          </Field>
        ))}
      </div>
      {preview && (
        <div className="card">
          <h3>Preview commitment</h3>
          <code className="block">{preview.policyCommitment}</code>
        </div>
      )}
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={onPreview}>
          Preview commitment
        </button>
        <button type="button" className="btn btn-ok" disabled={loading} onClick={onRegister}>
          Register on-chain
        </button>
      </div>
      <TxResult result={lastResult} />
    </div>
  );
}

function AgentTab({ policy, payment, setPayment, onProve, onAuthorize, loading, proveResult, authResult }) {
  const set = (key) => (e) => setPayment((p) => ({ ...p, [key]: e.target.value }));

  return (
    <div className="stack">
      <p className="muted">
        Simulate an <strong>AI agent payment request</strong>: compose amount, vendor, and timestamp,
        run <code>nargo execute</code> + <code>bb prove</code>, then submit to <code>PaymentAuthorizer</code>.
      </p>
      <div className="card form-grid">
        <Field label="Payment amount (cents)" hint={`Must be ≤ ${centsToUsd(policy.spending_limit)}`}>
          <input type="number" value={payment.payment_amount} onChange={set("payment_amount")} />
        </Field>
        <Field label="Approved vendor">
          <select
            value={payment.vendor_slot}
            onChange={(e) => setPayment((p) => ({ ...p, vendor_slot: Number(e.target.value) }))}
          >
            {VENDOR_OPTIONS.map((v) => (
              <option key={v.slot} value={v.slot}>{v.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Current time (unix)" hint="Must fall inside policy window">
          <input type="number" value={payment.current_time} onChange={set("current_time")} />
        </Field>
        <Field label=" ">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() =>
              setPayment((p) => ({
                ...p,
                current_time: String(Math.floor(Date.now() / 1000)),
              }))
            }
          >
            Use now
          </button>
        </Field>
      </div>
      <div className="btn-row">
        <button type="button" className="btn btn-ok" disabled={loading} onClick={onProve}>
          {loading ? "Proving…" : "1. Generate proof"}
        </button>
        <button type="button" className="btn btn-ok" disabled={loading || !proveResult?.ok} onClick={onAuthorize}>
          2. Authorize on-chain
        </button>
      </div>
      {proveResult && !proveResult.ok && (
        <div className="result err">
          <h4>Proof generation failed</h4>
          <p>Stage: {proveResult.stage}</p>
          <pre className="stderr">{proveResult.stderr?.split("\n").slice(0, 15).join("\n")}</pre>
        </div>
      )}
      {proveResult?.ok && (
        <div className="card">
          <h3>Proof ready</h3>
          <p>Size: {proveResult.proofLength} bytes · nullifier <code className="trim">{proveResult.publicInputs?.[4]}</code></p>
        </div>
      )}
      <TxResult result={authResult} />
    </div>
  );
}

function DemosTab({ onRun, loading, lastResult }) {
  return (
    <div className="stack">
      <p className="muted">One-click scenarios matching the slide deck and README demos.</p>
      <div className="demo-grid">
        {DEMOS.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`demo-card demo-${d.tone}`}
            disabled={loading}
            onClick={() => onRun(d.id)}
          >
            <strong>{d.label}</strong>
            <span>{d.desc}</span>
          </button>
        ))}
      </div>
      <TxResult result={lastResult} />
    </div>
  );
}

function HistoryTab({ history, refresh, loading }) {
  return (
    <div className="stack">
      <div className="btn-row">
        <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={refresh}>
          Refresh
        </button>
      </div>
      {!history.length && <p className="muted">No authorizations yet. Run the agent or demos.</p>}
      {history.length > 0 && (
        <div className="card table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Scenario</th>
                <th>Result</th>
                <th>Amount</th>
                <th>Gas</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className={h.ok ? "row-ok" : "row-err"}>
                  <td>{new Date(h.at).toLocaleTimeString()}</td>
                  <td>{h.label || h.scenario}</td>
                  <td>{h.event}{h.reason ? `: ${h.reason}` : ""}</td>
                  <td>{h.paymentAmount ? centsToUsd(h.paymentAmount) : "—"}</td>
                  <td>{h.gasUsed || "—"}</td>
                  <td><code>{trimCode(h.txHash, 8)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("status");
  const [snapshot, setSnapshot] = useState(null);
  const [policy, setPolicy] = useState(DEFAULT_POLICY);
  const [payment, setPayment] = useState({
    payment_amount: "3000",
    vendor_slot: 1,
    current_time: "1715000000",
  });
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [policyResult, setPolicyResult] = useState(null);
  const [proveResult, setProveResult] = useState(null);
  const [authResult, setAuthResult] = useState(null);
  const [demoResult, setDemoResult] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [st, hist] = await Promise.all([api.getState(), api.getHistory()]);
      if (st.error) throw new Error(st.error);
      setSnapshot(st);
      if (st.activePolicy) setPolicy(st.activePolicy);
      setHistory(hist.history || []);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function withLoad(fn) {
    setLoading(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">ZK-AAPA · Zero-Knowledge AI Agent Payment Authorization</p>
          <h1>Agent payment simulator</h1>
          <p className="sub">
            Private policy (limit, vendors, time window) enforced in Noir; UltraHonk verification on
            Hardhat. No delegation in this build — spending, vendor, time, commitment, and replay checks only.
          </p>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="result err banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      <main>
        {tab === "status" && <StatusTab snapshot={snapshot} />}
        {tab === "policy" && (
          <PolicyTab
            policy={policy}
            setPolicy={setPolicy}
            preview={preview}
            lastResult={policyResult}
            loading={loading}
            onPreview={() =>
              withLoad(async () => {
                const data = await api.previewPolicy(policy);
                if (data.error) throw new Error(data.error);
                setPreview(data);
                setPolicyResult(null);
              })
            }
            onRegister={() =>
              withLoad(async () => {
                const data = await api.registerPolicy(policy);
                if (data.error) throw new Error(data.error);
                setPolicyResult({
                  ok: true,
                  label: data.alreadyRegistered ? "Already registered" : "Policy registered",
                  policyCommitment: data.policyCommitment,
                });
              })
            }
          />
        )}
        {tab === "agent" && (
          <AgentTab
            policy={policy}
            payment={payment}
            setPayment={setPayment}
            proveResult={proveResult}
            authResult={authResult}
            loading={loading}
            onProve={() =>
              withLoad(async () => {
                setProveResult(null);
                setAuthResult(null);
                const body = { ...policy, ...payment };
                const data = await api.agentProve(body);
                if (data.error) throw new Error(data.error);
                setProveResult(data);
              })
            }
            onAuthorize={() =>
              withLoad(async () => {
                const data = await api.agentAuthorize({
                  label: `Agent $${(Number(payment.payment_amount) / 100).toFixed(2)}`,
                });
                if (data.error) throw new Error(data.error);
                setAuthResult(data);
              })
            }
          />
        )}
        {tab === "demos" && (
          <DemosTab
            loading={loading}
            lastResult={demoResult}
            onRun={(id) =>
              withLoad(async () => {
                const data = await api.runDemo(id);
                if (data.error) throw new Error(data.error);
                setDemoResult({ ...data, label: DEMOS.find((d) => d.id === id)?.label });
              })
            }
          />
        )}
        {tab === "history" && (
          <HistoryTab history={history} refresh={refresh} loading={loading} />
        )}
      </main>

      <footer>
        <p>API · Hardhat localhost · Run <code>npm run server</code> and <code>npx hardhat node</code> first</p>
      </footer>
    </div>
  );
}
