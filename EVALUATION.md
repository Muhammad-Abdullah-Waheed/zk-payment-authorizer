# Evaluation Metrics

This document records performance and cost measurements for **zk-payment-authorizer**. Raw numbers are stored in [`benchmark-results.json`](./benchmark-results.json).

**Last measured:** 2026-05-16 (see `measuredAt` in JSON)

**Test scenario:** Private spending limit **$50**, public payment **$30**, `evm-no-zk` UltraHonk prover, Solidity **0.8.28** / **Cancun**.

**Hardware:** Intel Core i5-7200U @ 2.50 GHz, 4 cores, 15.5 GiB RAM, Ubuntu Linux x64.

---

## Why these metrics

| Category | What we measured | Why it matters |
| --- | --- | --- |
| Gas / fees | `authorize()`, deploy, replay, invalid proof | On-chain cost for agents and relayers |
| TPS / throughput | Sequential `authorize()` on Hardhat | Separates EVM verifier speed from real block time |
| ZK prove / verify time | `nargo`, `bb` pipeline + EVM `verify` | Agent latency off-chain vs verifier cost on-chain |
| CPU / memory / crypto | RSS during prove, Poseidon nullifier, artifact sizes | Feasibility on laptop/edge hardware |

---

## 1. Gas consumption / transaction fees

Measured on Hardhat in-process network (`chainId` 31337). Regenerate with:

```bash
node scripts/run-benchmarks.js
# or gas-only:
npx hardhat run scripts/benchmark-gas.js --network localhost
```

| Operation | Gas | Notes |
| --- | ---: | --- |
| Deploy `HonkVerifier` | **3,177,670** | One-time per circuit version (~14.5 KB runtime bytecode) |
| Deploy `PaymentAuthorizer` | **323,356** | One-time wrapper + nullifier mapping |
| **Total deploy** | **3,501,026** | Full system bootstrap |
| `authorize()` — valid proof | **681,103** | Full Honk verification + nullifier `SSTORE` + events |
| `authorize()` — replay rejected | **270,630** | Mapping hit before verifier (~60% cheaper) |
| `authorize()` — invalid proof | **270,630** | Verifier runs; proof fails; no nullifier stored |
| Proof calldata | **6,368 bytes** | Dominates tx size on L1 / rollups |

**Estimated mainnet-style fees (valid authorize only, gas = 681,103):**

| Gas price | ETH | USD @ $3,000/ETH |
| --- | --- | --- |
| 20 gwei | 0.013622 | ~$41 |
| 30 gwei | 0.020433 | ~$61 |

Local Hardhat gas price is not zero in all setups; fee table uses fixed 20/30 gwei for planning (see `onChain.fees` in JSON).

**Takeaway:** Happy-path authorization is dominated by the **Honk verifier** gas, not the small policy wrapper. Replay rejection is significantly cheaper.

---

## 2. Transactions per second (TPS) / throughput

| Metric | Value | Context |
| --- | ---: | --- |
| Sequential valid `authorize()` (10 txs) | **55.6 tx/s** | 180 ms total, ~18 ms/tx average |
| Mainnet-style upper bound (12 s blocks, 1 tx/block) | **~0.08 tx/s** | Illustrative; public chains limited by consensus |

Hardhat uses **instant automine**, so this is an **upper bound** on EVM execution throughput, not production TPS.

**Takeaway:** Off-chain proving is not the bottleneck for burst local testing; on a public network, **block time and gas markets** dominate.

---

## 3. Proof generation & verification time (ZK)

Off-chain (`circuits/payment_policy`, 4 `bb` threads):

| Stage | Wall time | Purpose |
| --- | ---: | --- |
| `nargo compile` | **0.86 s** | Circuit → ACIR |
| `nargo execute` | **0.78 s** | Witness generation |
| `bb write_vk` | **0.11 s** | Verification key (per circuit version) |
| `bb prove` | **0.46 s** | **Primary agent metric** |
| `bb verify` (native) | **0.04 s** | Pre-flight check before submit |

On-chain (Hardhat):

| Stage | Latency |
| --- | ---: |
| `HonkVerifier.verify` (`staticCall`) | **63 ms** |
| Full `authorize()` tx (valid, incl. state write) | ~**18 ms** avg in throughput batch* |

\*Batch average includes automine; single UI/API txs are typically higher.

**Artifact sizes:**

| File | Bytes |
| --- | ---: |
| Proof | 6,368 |
| Verification key | 1,888 |
| Witness (`payment_policy.gz`) | 259 |
| ACIR JSON | 23,757 |
| Generated verifier Solidity | 260,514 |

**Takeaway:** Proving is **sub-second** on a laptop CPU; on-chain verification is **tens of milliseconds** locally but costs **~681k gas** when committed.

---

## 4. CPU / memory overhead & cryptographic work

| Component | Measurement | Why |
| --- | --- | --- |
| Prover parallelism | Barretenberg `bb prove` uses **4 threads** | Agent/workstation proving |
| Circuit logic | `payment_amount ≤ spending_limit`; `nullifier = Poseidon2(tx_nonce)` | Minimal policy; cost is proof system |
| Poseidon2 nullifier (`compute_nullifier.js`) | **~1.64 s** avg (3 runs, includes Node + `@aztec/bb.js` startup) | Nonce rotation helper |
| `HonkVerifier` deployed bytecode | **14,455 bytes** | Explains high deploy gas |
| `PaymentAuthorizer` deployed bytecode | **1,136 bytes** | Thin policy + replay map |

Security comes from **UltraHonk soundness** and **Poseidon2** inside the circuit, not from hash throughput (unlike PoW).

---

## Summary

| Metric | Value |
| --- | ---: |
| Valid `authorize()` gas | 681,103 |
| Replay / invalid `authorize()` gas | 270,630 |
| One-time deploy gas | 3,501,026 |
| Off-chain prove (`bb prove`) | 0.46 s |
| Off-chain verify (`bb verify`) | 0.04 s |
| On-chain verify (`staticCall`) | 63 ms |
| Local max throughput (Hardhat) | 55.6 tx/s |
| Proof size | 6,368 bytes |

---

## Reproducing results

1. Install toolchain per [README.md](./README.md) (Node 20, `nargo` 1.0.0-beta.21, `bb` 5.0.0-nightly.20260324).
2. Generate circuit artifacts (`nargo compile/execute`, `bb prove`, verifier).
3. Run:

```bash
node scripts/run-benchmarks.js
```

Optional — against a running local node:

```bash
npx hardhat node   # terminal A
node scripts/run-benchmarks.js --network localhost
```

Output: `benchmark-results.json` at repo root.

---

## Limitations

- TPS and latency are from **Hardhat**, not Ethereum mainnet or an L2 sequencer.
- Fee estimates assume **20 / 30 gwei**; real costs depend on network conditions and calldata pricing.
- `HonkVerifier` must be redeployed when the circuit or `bb` VK changes.
- `evm-no-zk` target is used for the optimized Solidity verifier; private inputs remain off-chain in the Noir witness.
