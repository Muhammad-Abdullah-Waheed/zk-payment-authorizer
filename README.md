# zk-payment-authorizer

> Prove that an AI-agent payment request satisfies a **private spending
> policy** — without revealing the policy — and have a smart contract
> accept or reject it on-chain.

An end-to-end proof-of-concept that wires together [Noir](https://noir-lang.org/)
circuits, the [Barretenberg](https://github.com/AztecProtocol/aztec-packages/tree/next/barretenberg)
UltraHonk proving backend, a Solidity verifier, a `PolicyRegistry`
contract that whitelists policy commitments, and a React/Vite agent
simulator on a local Hardhat blockchain.

The on-chain stack never sees the spending limit, the time window,
the approved-vendor list, or the transaction nonce — only the
*public* payment amount, current time, vendor, **policy commitment**,
and nullifier. The Noir circuit enforces every rule.

---

## What the system does

```
                       ┌──────────────────────────────┐
                       │   Agent (off-chain Node)     │
                       │  policy + payment request    │
                       └───────────────┬──────────────┘
                                       │ nargo execute + bb prove
                                       ▼
                          proof + 5 public inputs
                                       │
                                       │ JSON-RPC tx
                                       ▼
            ┌─────────────────────────────────────────────────┐
            │                Hardhat localhost                │
            │                                                 │
            │  PolicyRegistry ── isRegistered(policyHash)?    │
            │            │                                    │
            │            ▼                                    │
            │  PaymentAuthorizer.authorize(proof, pubInputs)  │
            │            │                                    │
            │     ┌──────┴──────┐                             │
            │     │             │                             │
            │  HonkVerifier   nullifier replay map            │
            │   (UltraHonk)                                   │
            │                                                 │
            │  → PaymentAuthorized(amount, time, vendor,      │
            │                      policyHash, nullifier)     │
            │  → PaymentRejected(reason)                      │
            └─────────────────────────────────────────────────┘
```

The agent simulator (React UI) lets you:

1. Edit a private policy (limit / time window / four approved vendors).
2. Compute and register the policy's **Poseidon2 commitment** on chain.
3. Generate a fresh proof for a payment request (amount + time + vendor).
4. Submit `authorize()` and watch the contract emit `PaymentAuthorized`
   or `PaymentRejected`.
5. Trigger seven canned failure scenarios (replay, over-limit, bad
   vendor, bad time, tampered proof, unregistered policy, …).

---

## The Noir circuit (current)

```rust
use poseidon::poseidon2::Poseidon2;

fn main(
    // --- private witnesses ---
    spending_limit:    u64,
    tx_nonce:          Field,
    window_start:      u64,
    window_end:        u64,
    approved_vendor_0: Field,
    approved_vendor_1: Field,
    approved_vendor_2: Field,
    approved_vendor_3: Field,

    // --- public inputs (order matches PaymentAuthorizer.sol) ---
    payment_amount:    pub u64,
    current_time:      pub u64,
    vendor:            pub Field,
    policy_commitment: pub Field,
    nullifier:         pub Field,
) {
    assert(payment_amount <= spending_limit);

    assert(window_start <= current_time);
    assert(current_time <= window_end);

    assert(vendor_is_approved(vendor,
        approved_vendor_0, approved_vendor_1,
        approved_vendor_2, approved_vendor_3));

    let expected_commitment = Poseidon2::hash(
        [spending_limit as Field, window_start as Field, window_end as Field,
         approved_vendor_0, approved_vendor_1, approved_vendor_2, approved_vendor_3], 7);
    assert(expected_commitment == policy_commitment);

    let computed_nullifier = Poseidon2::hash([tx_nonce], 1);
    assert(computed_nullifier == nullifier);
}
```

**Public-input order (5 fields × 32 bytes = 160 bytes):**

| Index | Field | Type | Meaning |
| :---: | --- | --- | --- |
| 0 | `payment_amount` | `u64` | Requested payment amount in cents |
| 1 | `current_time` | `u64` | Unix timestamp the agent claims |
| 2 | `vendor` | `Field` | Vendor identifier (e.g. `0x…01`) |
| 3 | `policy_commitment` | `Field` | Poseidon2 hash of the full policy |
| 4 | `nullifier` | `Field` | Poseidon2 hash of the private `tx_nonce` |

`PaymentAuthorizer.authorize(...)` then enforces, in order:
1. `publicInputs.length >= 5` (well-formed call)
2. `PolicyRegistry.isRegistered(publicInputs[3])` (commitment is on the
   whitelist of policies an owner has pre-registered)
3. `usedNullifiers[publicInputs[4]] == false` (replay defense)
4. `HonkVerifier.verify(proof, publicInputs)` (ZK proof valid)

If all four pass, the contract marks the nullifier used and emits
`PaymentAuthorized`. Otherwise it emits `PaymentRejected(reason)`.

---

## Demo scenarios

Use the React UI's "Quick demos" tab or the JSON API
(`POST /api/demo/<type>`). Every scenario is end-to-end: the server
runs `nargo execute` + `bb prove` for the cases that need a fresh
proof, then submits to `PaymentAuthorizer`.

| Type | What it does | Expected outcome |
| --- | --- | --- |
| `valid30` | Prove + authorize a $30 payment, vendor #1, in-window time. | `PaymentAuthorized` ✓ |
| `replay` | Re-submit the last accepted proof. | `PaymentRejected("Replay attack detected")` |
| `overLimit` | Try to prove an $80 payment against a $50 limit. | Witness solver fails (`Failed constraint`) before any tx. |
| `badVendor` | Try to prove for vendor `0x…99` (not whitelisted). | Witness fails (`vendor_is_approved`). |
| `badTime` | Try to prove with `current_time` < `window_start`. | Witness fails. |
| `tampered` | Mutate a byte of a valid proof and submit with a fresh nullifier. | `PaymentRejected("Invalid proof")` (verifier rejects). |
| `unknownPolicy` | Submit a valid-shaped proof claiming an unregistered policy commitment. | `PaymentRejected("Unknown policy")` (registry guard fires before the verifier). |

Hardhat test suite (`npm test`) covers the five core paths:

```
PaymentAuthorizer
  ✔ verifies a valid proof natively via the Honk verifier
  ✔ authorizes a valid payment and emits PaymentAuthorized
  ✔ rejects a replay of the same proof and emits PaymentRejected
  ✔ rejects a tampered proof with a fresh nullifier
  ✔ rejects when policy commitment is not registered
5 passing
```

Performance numbers (gas / latency / proof size / TPS) live in
[`EVALUATION.md`](./EVALUATION.md) and the raw machine-readable form in
[`benchmark-results.json`](./benchmark-results.json).

---

## Tech stack

| Layer | Tool | Version pinned here |
| --- | --- | --- |
| ZK circuit | Noir / `nargo` | `1.0.0-beta.21` |
| ZK backend | Barretenberg / `bb` | `5.0.0-nightly.20260324` (auto-resolved via `bb-versions.json`) |
| Poseidon library | [`noir-lang/poseidon`](https://github.com/noir-lang/poseidon) | `v0.3.0` |
| Smart contracts | Solidity | `0.8.28`, EVM target `cancun` (uses `mcopy`) |
| Dev framework | Hardhat 2 + `@nomicfoundation/hardhat-toolbox` | `2.28.x` / `5.x` |
| Frontend | React 19 + Vite | latest |
| Glue API | Node + Express + `ethers` v6 | latest |

The Solidity verifier is the **optimized no-zk UltraHonk** verifier
generated by `bb write_solidity_verifier --optimized -t evm-no-zk`. The
"no-zk" tag refers to the proof system's internal zero-knowledge
property; private inputs (`spending_limit`, `tx_nonce`, `window_*`,
`approved_vendor_*`) are still never encoded in the public inputs, so
the on-chain verifier never sees them.

---

## Repository layout

```
.
├── circuits/payment_policy/
│   ├── Nargo.toml
│   ├── Prover.toml           # full witness incl. policy commitment + nullifier
│   ├── src/main.nr
│   └── target/               # bb proof, vk, witness (regenerated locally)
├── contracts/
│   ├── UltraPlonkVerifier.sol   # generated by bb; defines `HonkVerifier`
│   ├── PolicyRegistry.sol       # commitment whitelist
│   └── PaymentAuthorizer.sol    # verify + replay + registry guard
├── scripts/
│   ├── deploy.js                # deploys verifier + registry + authorizer
│   ├── policy.js                # PI indices, Poseidon2 commitment, bytes32[] (re)serializer
│   ├── prover_pipeline.js       # writes Prover.toml + runs nargo+bb to produce a proof bundle
│   ├── simulator_api.js         # business logic (prove/register/authorize/demo) used by server.js
│   ├── server.js                # Express API (mounted on http://127.0.0.1:4000)
│   ├── load_proof.js            # reads target/proof + Prover.toml into JS
│   ├── compute_nullifier.js     # CLI: Poseidon2 nullifier from a tx_nonce
│   ├── compute_policy_commitment.js  # CLI: Poseidon2 commitment from policy fields
│   ├── benchmark-gas.js         # tiny gas snapshot for npx hardhat run
│   └── run-benchmarks.js        # produces benchmark-results.json (timings, gas, throughput)
├── test/payment.test.js
├── frontend/                    # Vite + React app (5 tabs, see below)
├── EVALUATION.md                # human-readable performance writeup
├── benchmark-results.json       # raw measurements
└── hardhat.config.js
```

### NPM scripts

| Script | Effect |
| --- | --- |
| `npm run compile` | `hardhat compile` |
| `npm run node` | `hardhat node` (local chain on :8545) |
| `npm run deploy` | Deploys `HonkVerifier` + `PolicyRegistry` + `PaymentAuthorizer`, registers the default policy commitment, writes `deployment.json` |
| `npm test` | `hardhat test --network localhost` (also works without `--network`) |
| `npm run server` | `node scripts/server.js` (API on :4000) |
| `npm run nullifier` | `node scripts/compute_nullifier.js <tx_nonce>` |
| `npm run policy-commitment` | `node scripts/compute_policy_commitment.js …` |
| `npm run benchmark` | Writes `benchmark-results.json` (single proof, all reject paths) |
| `npm run benchmark-1000` | Writes `benchmark-results-1000.json` — averages over 1,000 distinct valid proofs (`--proofs N` to change count) |

### HTTP API (Express, default port 4000)

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/state` | — | Deployment addresses, active policy, prebuilt proof info, whether commitment is registered. |
| `GET` | `/api/history` | — | Last 100 simulator actions. |
| `POST` | `/api/policy/preview` | policy fields | Returns the Poseidon2 commitment for a candidate policy. |
| `POST` | `/api/policy/register` | policy fields | Computes the commitment and (if new) calls `PolicyRegistry.registerPolicy(...)`. |
| `POST` | `/api/agent/prove` | `payment_amount`, `current_time`, `vendor` *or* `vendor_slot`, optional policy overrides | Writes a fresh `Prover.toml`, runs `nargo execute` + `bb prove`, returns proof bundle. |
| `POST` | `/api/agent/authorize` | `{ usePrebuilt?, label? }` | Submits the last proof bundle (or the prebuilt one from disk) to `authorize()`. |
| `POST` | `/api/demo/:type` | — | Run one of the canned demos (`valid30`, `replay`, `overLimit`, `badVendor`, `badTime`, `tampered`, `unknownPolicy`). |
| `POST` | `/api/scenarioA` | — | Legacy alias for `valid30`. |
| `POST` | `/api/scenarioB` | — | Legacy alias for `overLimit`. |

### React UI tabs

1. **Status** — addresses pulled from `deployment.json`, whether the
   current policy is registered, the size of the prebuilt proof.
2. **Policy setup** — edit `spending_limit / window_start / window_end /
   vendors[0..3]`, preview commitment, register it on chain.
3. **Agent simulator** — choose `payment_amount / current_time / vendor`,
   prove + authorize.
4. **Quick demos** — one-click failures: replay, over-limit, bad vendor,
   bad time, tampered proof, unknown policy.
5. **History** — every action with tx hash, gas, event, reason.

---

## Running it from a fresh Ubuntu machine

Every command below has been tested top-to-bottom on Ubuntu 22.04 /
24.04 with `bash`. Copy-paste each block into a terminal.

### 0. System prerequisites

```bash
sudo apt update
sudo apt install -y curl git build-essential
```

### 1. Install Node.js 20

The easiest, sudo-free way is via `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc

nvm install 20
nvm use 20
node --version       # v20.x.x
npm --version
```

(If you prefer the system package: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs`.)

### 2. Install Noir (`nargo`)

```bash
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
source ~/.bashrc

# Pin to the exact version this repo was built against
noirup -v 1.0.0-beta.21

nargo --version        # should print "nargo version = 1.0.0-beta.21"
```

### 3. Install Barretenberg (`bb`) — version auto-matched to nargo

```bash
mkdir -p ~/.bb
curl -sSL https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/next/barretenberg/bbup/bbup -o ~/.bb/bbup
chmod +x ~/.bb/bbup

~/.bb/bbup --noir-version current

export PATH="$HOME/.bb:$PATH"
bb --version           # 5.0.0-nightly.20260324 on nargo 1.0.0-beta.21
```

### 4. Clone the repository

```bash
git clone https://github.com/Muhammad-Abdullah-Waheed/zk-payment-authorizer.git
cd zk-payment-authorizer
```

### 5. Install JavaScript dependencies

```bash
npm install
( cd frontend && npm install )
```

### 6. Generate the proof and Solidity verifier

`circuits/payment_policy/target/` is gitignored, so this step is required
on every fresh clone.

```bash
cd circuits/payment_policy

nargo compile
nargo execute        # solves the witness using Prover.toml

bb write_vk    -b ./target/payment_policy.json -o ./target/ -t evm-no-zk
bb prove       -b ./target/payment_policy.json -w ./target/payment_policy.gz \
               -k ./target/vk -o ./target/ -t evm-no-zk
bb write_solidity_verifier -k ./target/vk \
               -o ../../contracts/UltraPlonkVerifier.sol \
               -t evm-no-zk --optimized

cd ../..
```

The default `Prover.toml` ships valid values:
`spending_limit=5000`, `tx_nonce=123`, window `[1700000000, 2000000000]`,
vendors `0x…01..04`, `vendor=0x…01`, `payment_amount=3000`,
`current_time=1715000000`. The `policy_commitment` and `nullifier`
fields are pre-computed for that policy — if you change *any* of the
private fields, recompute them via `npm run policy-commitment` and
`npm run nullifier <tx_nonce>` before re-running `nargo execute`.

### 7. Compile Solidity, run the local chain, run tests

```bash
npm run compile

# Terminal A — keep this running:
npm run node

# Terminal B:
npm run deploy
npm test
```

After `npm run deploy`, contract addresses live in `deployment.json`
(`verifier`, `policyRegistry`, `authorizer`, `policyCommitment`).

### 8. Start the demo UI

```bash
# Terminal C — API server:
npm run server
# Terminal D — frontend:
( cd frontend && npm run dev )
```

Open <http://localhost:5173>.

> ℹ️ Each `tx_nonce` produces exactly one valid nullifier. Once
> `PaymentAuthorizer` has seen it, every replay (including from the UI)
> is rejected — that's the intended defense. To re-run the "Valid $30
> payment" success path against a clean state, redeploy (`npm run
> deploy`) and reload the browser tab, **or** bump `tx_nonce` and
> re-prove.

---

## Architecture (data flow)

```
                  private witnesses
                  ┌──────────────────────────────────────┐
                  │ spending_limit, tx_nonce,             │
                  │ window_start, window_end,             │
                  │ approved_vendor_0..3                  │
                  └──────────────┬───────────────────────┘
                                 │
                    Noir circuit │  (payment_policy/src/main.nr)
                    ┌────────────▼──────────────┐
                    │ payment ≤ limit            │
                    │ window_start ≤ time ≤ end  │
                    │ vendor ∈ whitelist         │
                    │ Poseidon2(policy) = pubH   │
                    │ Poseidon2(nonce) = nullif. │
                    └────────────┬──────────────┘
                                 │ nargo compile / execute
                                 ▼
                           ACIR + witness
                                 │ bb prove
                                 ▼
                       proof + 5 public inputs
                                 │
                 ┌───────────────┴──────────────┐
                 │                              │
        bb write_solidity_verifier        Hardhat test / UI
                 │                              │
                 ▼                              ▼
      contracts/UltraPlonkVerifier.sol  PaymentAuthorizer.authorize(proof, pis)
        (contract HonkVerifier)
                                                │
                                                ├─ registry guard fails  → PaymentRejected("Unknown policy")
                                                ├─ nullifier replayed    → PaymentRejected("Replay attack detected")
                                                ├─ verifier.verify ✗     → PaymentRejected("Invalid proof")
                                                └─ verifier.verify ✓     → PaymentAuthorized(amount, time, vendor, hash, null)
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Browser shows `PaymentRejected("Replay attack detected")` on the very first `Valid $30` click after a restart. | The nullifier for `tx_nonce=123` is still stored in the deployed `PaymentAuthorizer` from a previous session. Redeploy (`npm run deploy`) and reload, **or** change `tx_nonce` in the Policy tab and re-prove. |
| `PaymentRejected("Unknown policy")`. | You changed a policy field but didn't register the new commitment. Click "Register policy" in the UI, or `POST /api/policy/register`, or just `npm run deploy` (it auto-registers the default policy). |
| `bb verify` says `num_public_inputs mismatch with VK`. | Stale `target/vk` from an older circuit. Regenerate everything in step 6 of this README. |
| `bb: command not found` after step 3. | Open a new terminal (the installer wrote `export PATH="$HOME/.bb:$PATH"` to `~/.bashrc`) or rerun the export. |
| `nargo: command not found`. | Same idea — `noirup` adds `~/.nargo/bin` to your shell rc; reopen the shell or `export PATH="$HOME/.nargo/bin:$PATH"`. |
| `Error HH600: Compilation failed … mcopy … paris`. | `hardhat.config.js` already pins `evmVersion: "cancun"`. If you forked or changed this, set it back. |
| `EADDRINUSE: address already in use 8545 / 4000 / 5173`. | Another instance is still running. `lsof -i :8545` (or `:4000`, `:5173`) → `kill <pid>`. |
| `nargo execute` complains "Failed constraint". | The values in `Prover.toml` don't satisfy the circuit (e.g. `payment_amount > spending_limit`, vendor not in whitelist, time outside window, or `policy_commitment` / `nullifier` mis-computed). Re-derive the commitment and nullifier as shown in step 6. |

---

## Notes on design choices

- **`UltraPlonkVerifier.sol` vs `HonkVerifier`.** Modern Barretenberg
  has deprecated PLONK in favor of UltraHonk. The generated file is
  kept under the `UltraPlonkVerifier.sol` name to match the original
  project spec; the contract defined inside is `HonkVerifier`, and
  that is what `PaymentAuthorizer.sol` references.
- **Policy commitment.** Storing only `Poseidon2(policy)` on chain
  lets a policy owner publicly say "I have approved this policy"
  without exposing the limit, the window, or which vendors are
  whitelisted. The Noir circuit re-derives the commitment from the
  private witness and asserts equality, so the on-chain registry
  effectively gates which policies an agent can prove against.
- **`evm-no-zk` proving target.** The optimized Solidity verifier is
  only available for the no-zk Honk variant. The Noir witness still
  hides the private inputs — `evm-no-zk` only affects the proof
  structure, not which fields of the circuit are public.
- **`evmVersion: "cancun"`.** The optimized verifier uses `mcopy`,
  which only exists from Cancun onward. Hardhat's in-memory chain
  supports this; on real networks this targets Ethereum mainnet ≥
  2024.
- **Replay protection.** `PaymentAuthorizer` stores every accepted
  `nullifier` in a `mapping(bytes32 => bool)`. The nullifier is a
  Poseidon2 hash of a private nonce, so it cannot be forged or
  enumerated by anyone who doesn't know the nonce.

---

## License

MIT — see [`LICENSE`](./LICENSE).
