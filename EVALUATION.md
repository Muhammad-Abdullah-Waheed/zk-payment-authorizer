# Evaluation Metrics

This document records performance and cost measurements for **zk-payment-authorizer**. The headline figures are **averages over 1,000 distinct, valid proofs** (raw data in [`benchmark-results-1000.json`](./benchmark-results-1000.json)); single-proof reject-path figures come from [`benchmark-results.json`](./benchmark-results.json).

**Last measured:** 2026-06-21 (1,000-proof run; see `measuredAt` in JSON)

**Test scenario:** Private spending limit **$50**, public payment **$30**, vendor inside a 4-slot whitelist, `current_time` inside a registered time window, `evm-no-zk` UltraHonk prover, Solidity **0.8.28** / **Cancun**. Each of the 1,000 proofs is generated with a **unique `tx_nonce`** (hence a unique nullifier), so every on-chain `authorize()` takes the real `PaymentAuthorized` path — not a replayed/rejected shortcut.

**Hardware:** AMD Ryzen 3 PRO 3300U (4 cores) @ ~2.1 GHz, 6.72 GiB RAM, **WSL2 Ubuntu** (Linux x64) on Windows 11. `bb prove` uses 4 threads.

---

## Why these metrics

| Category | What we measured | Why it matters |
| --- | --- | --- |
| Gas / fees | `authorize()`, deploy, replay, invalid proof | On-chain cost for agents and relayers |
| TPS / throughput | Sequential valid `authorize()` on Hardhat | Separates EVM verifier speed from real block time |
| ZK prove / verify time | `nargo`, `bb` pipeline + EVM `verify` | Agent latency off-chain vs verifier cost on-chain |
| CPU / memory / crypto | Poseidon nullifier, artifact sizes | Feasibility on laptop/edge hardware |

All ZK and on-chain timings below are **means over 1,000 proofs**, reported with **p50 / p95** so tail latency is visible.

---

## 1. Gas consumption / transaction fees

Measured on the Hardhat in-process network (`chainId` 31337). Regenerate with:

```bash
node scripts/run-benchmarks-1000.js          # 1,000 valid proofs (averaged)
node scripts/run-benchmarks-1000.js --proofs 200   # quicker run
node scripts/run-benchmarks.js               # single-proof, all reject paths
```

| Operation | Gas | Notes |
| --- | ---: | --- |
| Deploy `HonkVerifier` | **3,177,682** | One-time per circuit version (~14.5 KB runtime bytecode) |
| Deploy `PaymentAuthorizer` | **432,494** | One-time wrapper + nullifier mapping |
| **Total deploy** | **3,610,176** | `HonkVerifier` + `PaymentAuthorizer`; `PolicyRegistry` adds ≈ 250 k gas, measured separately |
| `authorize()` — valid proof | **691,012 avg** | **1,000-proof mean**; min 690,767 / p50 691,019 / p95 691,103 / max 691,211 |
| `authorize()` — replay rejected | **272,700** | Mapping hit before verifier (~60 % cheaper) |
| `authorize()` — invalid proof | **272,700** | Verifier runs; proof fails; no nullifier stored |
| `authorize()` — unknown policy | **≈ 30 k** | `PolicyRegistry.isRegistered` view returns false before the verifier runs |
| Proof calldata | **6,368 bytes** | Constant across all 1,000 proofs; dominates tx size on L1 / rollups |

**Note on gas stability:** across 1,000 distinct valid proofs the `authorize()` gas spans only **690,767 – 691,211** (≈ 0.06 % range). Honk verification cost is essentially fixed; the small variation comes from the number of non-zero bytes in the public inputs.

**Estimated mainnet-style fees (valid authorize, avg gas = 691,012):**

| Gas price | ETH | USD @ $3,000/ETH |
| --- | --- | --- |
| 20 gwei | 0.013820 | ~$41 |
| 30 gwei | 0.020730 | ~$62 |

Local Hardhat gas price is not zero in all setups; the fee table uses fixed 20/30 gwei for planning (see `onChain.fees` in JSON).

**Takeaway:** Happy-path authorization is dominated by the **Honk verifier** gas, not the small policy wrapper, and is **highly predictable** per proof. Replay rejection is significantly cheaper.

---

## 2. Transactions per second (TPS) / throughput

| Metric | Value | Context |
| --- | ---: | --- |
| Sequential valid `authorize()` (1,000 distinct proofs) | **11.35 tx/s** | 88.1 s total, ~88 ms/tx average |
| Mainnet-style upper bound (12 s blocks, 1 tx/block) | **~0.08 tx/s** | Illustrative; public chains limited by consensus |

Hardhat uses **instant automine**, so this is an **upper bound** on EVM execution throughput, not production TPS. Unlike the previous report, this **11.35 tx/s** figure is a sequence of **1,000 fresh, valid proofs** — each one actually verifies and emits `PaymentAuthorized` — so it reflects the genuine valid-path cost, not an on-chain reject shortcut.

**Takeaway:** Off-chain proving (~1.6 s/proof end-to-end) is the real agent-side bottleneck; on a public network, **block time and gas markets** dominate settlement throughput.

---

## 3. Proof generation & verification time (ZK)

Off-chain, **averaged over 1,000 proofs** (`circuits/payment_policy`, 4 `bb` threads):

| Stage | Avg | p50 | p95 | Purpose |
| --- | ---: | ---: | ---: | --- |
| `nargo execute` (witness) | **1.007 s** | 0.892 s | 1.794 s | Witness generation |
| `bb prove` | **0.449 s** | 0.411 s | 0.670 s | **Primary agent metric** |
| `bb verify` (native) | **0.073 s** | 0.064 s | 0.128 s | Pre-flight check before submit |
| End-to-end per proof | **~1.58 s** | — | — | Wall time incl. commitment + nullifier hashing and `Prover.toml` write |

`nargo compile` (**0.68 s**) and `bb write_vk` (**0.26 s**) are one-time per circuit version, not per proof.

On-chain (Hardhat), **averaged over 1,000 proofs**:

| Stage | Avg | p50 | p95 |
| --- | ---: | ---: | ---: |
| `HonkVerifier.verify` (`staticCall`) | **43 ms** | 36 ms | 91 ms |
| Full `authorize()` tx (valid, incl. state write) | **44 ms** | 37 ms | 96 ms |

**Artifact sizes:**

| File | Bytes |
| --- | ---: |
| Proof | 6,368 (constant across all 1,000) |
| Verification key | 1,888 |
| Witness (`payment_policy.gz`) | ~900 |
| ACIR JSON | 27,295 |
| Generated verifier Solidity | 265,153 |

**Takeaway:** Proving is **sub-second** (`bb prove` ≈ 0.45 s) on a laptop CPU; witness generation dominates the off-chain path. On-chain verification is **tens of milliseconds** locally but costs **~691k gas** when committed.

---

## 4. CPU / memory overhead & cryptographic work

| Component | Measurement | Why |
| --- | --- | --- |
| Prover parallelism | Barretenberg `bb prove` uses **4 threads** | Agent/workstation proving |
| Circuit logic | `payment_amount ≤ spending_limit`; `window_start ≤ current_time ≤ window_end`; `vendor ∈ {v0,v1,v2,v3}`; `Poseidon2(policy) = policy_commitment`; `nullifier = Poseidon2(tx_nonce)` | Policy + replay invariants; cost dominated by Honk proof system |
| Poseidon2 nullifier (`compute_nullifier.js`) | **~4.35 s** avg (3 runs, includes Node + `@aztec/bb.js` cold start) | One-shot CLI helper; the in-process prover pipeline pays this startup **once**, not per proof |
| `HonkVerifier` deployed bytecode | **14,455 bytes** | Explains high deploy gas |
| `PaymentAuthorizer` deployed bytecode | **1,533 bytes** | Thin policy + replay map |

Security comes from **UltraHonk soundness** and **Poseidon2** inside the circuit, not from hash throughput (unlike PoW).

---

## Summary

| Metric | Value (1,000-proof avg unless noted) |
| --- | ---: |
| Valid `authorize()` gas | 691,012 (p95 691,103) |
| Replay / invalid `authorize()` gas | 272,700 |
| Unknown-policy `authorize()` gas | ≈ 30,000 |
| One-time deploy gas (`HonkVerifier` + `PaymentAuthorizer`) | 3,610,176 |
| Off-chain `nargo execute` | 1.007 s |
| Off-chain prove (`bb prove`) | 0.449 s |
| Off-chain verify (`bb verify`) | 0.073 s |
| End-to-end per proof (off-chain) | ~1.58 s |
| On-chain verify (`staticCall`) | 43 ms |
| Valid `authorize()` tx latency | 44 ms |
| Local valid-path throughput (Hardhat) | 11.35 tx/s |
| Proof size | 6,368 bytes |
| Public-input vector size | 5 × 32 B = 160 B |

---

## Reproducing results

1. Install toolchain per [README.md](./README.md) (Node 20, `nargo` 1.0.0-beta.21, `bb` 5.0.0-nightly.20260324).
2. Generate circuit artifacts (`nargo compile`, `bb write_vk`).
3. Run the 1,000-proof evaluation:

```bash
node scripts/run-benchmarks-1000.js            # averages over 1,000 valid proofs
# optional smaller run:
node scripts/run-benchmarks-1000.js --proofs 200
# single-proof reject-path numbers:
node scripts/run-benchmarks.js
```

Optional — against a running local node:

```bash
npx hardhat node   # terminal A
node scripts/run-benchmarks-1000.js --network localhost
```

Output: `benchmark-results-1000.json` (and `benchmark-results.json`) at repo root.

---

## Limitations

- TPS and latency are from **Hardhat**, not Ethereum mainnet or an L2 sequencer.
- Fee estimates assume **20 / 30 gwei**; real costs depend on network conditions and calldata pricing.
- `HonkVerifier` **and** the Solidity verifier source must be regenerated whenever the circuit's public-input signature changes.
- The 1,000-proof run measures the **valid path** only (every proof verifies). Reject-path gas (replay / invalid / unknown policy) is taken from the single-proof `scripts/run-benchmarks.js` on the same machine and code.
- The previous report's "55.6 tx/s" reused one proof while mutating the nullifier, which makes verification fail — i.e. it was a **reject-path** figure. This revision fixes that: the **11.35 tx/s** above is 1,000 genuinely distinct, valid proofs.
- `evm-no-zk` target is used for the optimized Solidity verifier; private inputs remain off-chain in the Noir witness.
- Measured on a 4-core laptop CPU under WSL2; native Linux or a faster CPU will lower proving times.
