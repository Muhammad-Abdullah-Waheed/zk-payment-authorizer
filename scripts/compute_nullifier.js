const { BarretenbergSync, Fr } = require("@aztec/bb.js");

function toHex(bufLike) {
  const bytes = Buffer.from(bufLike);
  return "0x" + bytes.toString("hex");
}

async function main() {
  const txNonce = BigInt(process.argv[2] || "123");
  const api = await BarretenbergSync.initSingleton();
  const result = api.poseidon2Hash([new Fr(txNonce)]);
  console.log(toHex(result.toBuffer()));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
