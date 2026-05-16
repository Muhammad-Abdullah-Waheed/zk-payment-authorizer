const { BarretenbergSync, Fr } = require("@aztec/bb.js");

const VENDOR_SLOTS = 4;

/** Public input indices — must match Noir `pub` parameter order in main.nr */
const PI = {
  PAYMENT_AMOUNT: 0,
  CURRENT_TIME: 1,
  VENDOR: 2,
  POLICY_COMMITMENT: 3,
  NULLIFIER: 4,
};

function fieldFromHex(hex) {
  return BigInt(hex);
}

function toHex32(value) {
  const v = BigInt(value);
  if (v < 0n) {
    throw new Error("Expected non-negative field/value: " + value);
  }
  let h = v.toString(16);
  if (h.length > 64) {
    throw new Error("Value too large for bytes32: " + value);
  }
  return "0x" + h.padStart(64, "0");
}

function readVendorSlots(prover) {
  return [
    prover.approved_vendor_0,
    prover.approved_vendor_1,
    prover.approved_vendor_2,
    prover.approved_vendor_3,
  ];
}

async function computePolicyCommitment({
  spending_limit,
  window_start,
  window_end,
  approved_vendor_0,
  approved_vendor_1,
  approved_vendor_2,
  approved_vendor_3,
}) {
  const api = await BarretenbergSync.initSingleton();
  const inputs = [
    new Fr(BigInt(spending_limit)),
    new Fr(BigInt(window_start)),
    new Fr(BigInt(window_end)),
    new Fr(fieldFromHex(approved_vendor_0)),
    new Fr(fieldFromHex(approved_vendor_1)),
    new Fr(fieldFromHex(approved_vendor_2)),
    new Fr(fieldFromHex(approved_vendor_3)),
  ];
  const hash = api.poseidon2Hash(inputs);
  return "0x" + Buffer.from(hash.toBuffer()).toString("hex");
}

function publicInputsFromProver(prover) {
  return [
    toHex32(prover.payment_amount),
    toHex32(prover.current_time),
    prover.vendor,
    prover.policy_commitment,
    prover.nullifier,
  ];
}

module.exports = {
  VENDOR_SLOTS,
  PI,
  fieldFromHex,
  toHex32,
  readVendorSlots,
  computePolicyCommitment,
  publicInputsFromProver,
};
