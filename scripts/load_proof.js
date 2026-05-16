const fs = require("fs");
const path = require("path");
const toml = require("@iarna/toml");

const FIELD_SIZE = 32;

function toHex32(bn) {
  let h = BigInt(bn).toString(16);
  if (h.length > 64) {
    throw new Error("Value too large for bytes32: " + bn);
  }
  return "0x" + h.padStart(64, "0");
}

function readProverToml(circuitDir) {
  const proverPath = path.join(circuitDir, "Prover.toml");
  const raw = fs.readFileSync(proverPath, "utf8");
  return toml.parse(raw);
}

function readProofBytes(circuitDir) {
  const proofPath = path.join(circuitDir, "target", "proof");
  const buf = fs.readFileSync(proofPath);
  return "0x" + buf.toString("hex");
}

function publicInputsFromProver(prover) {
  const amount = BigInt(prover.payment_amount);
  const nullifier = prover.nullifier;
  return [toHex32(amount), nullifier];
}

function tamperedProof(hexProof) {
  const bytes = Buffer.from(hexProof.slice(2), "hex");
  bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0x01;
  return "0x" + bytes.toString("hex");
}

function loadAll(circuitDir) {
  const prover = readProverToml(circuitDir);
  const proof = readProofBytes(circuitDir);
  const publicInputs = publicInputsFromProver(prover);
  return { prover, proof, publicInputs };
}

module.exports = {
  toHex32,
  readProverToml,
  readProofBytes,
  publicInputsFromProver,
  tamperedProof,
  loadAll,
  FIELD_SIZE,
};
