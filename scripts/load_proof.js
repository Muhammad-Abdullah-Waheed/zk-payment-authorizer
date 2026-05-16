const fs = require("fs");
const path = require("path");
const toml = require("@iarna/toml");
const { publicInputsFromProver, PI } = require("./policy.js");

const FIELD_SIZE = 32;

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
  readProverToml,
  readProofBytes,
  publicInputsFromProver,
  tamperedProof,
  loadAll,
  FIELD_SIZE,
  PI,
};
