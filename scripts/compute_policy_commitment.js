const { computePolicyCommitment } = require("./policy.js");

async function main() {
  const spending_limit = process.argv[2] || "5000";
  const window_start = process.argv[3] || "1700000000";
  const window_end = process.argv[4] || "2000000000";
  const v0 =
    process.argv[5] ||
    "0x0000000000000000000000000000000000000000000000000000000000000001";
  const v1 =
    process.argv[6] ||
    "0x0000000000000000000000000000000000000000000000000000000000000002";
  const v2 =
    process.argv[7] ||
    "0x0000000000000000000000000000000000000000000000000000000000000003";
  const v3 =
    process.argv[8] ||
    "0x0000000000000000000000000000000000000000000000000000000000000004";

  const commitment = await computePolicyCommitment({
    spending_limit,
    window_start,
    window_end,
    approved_vendor_0: v0,
    approved_vendor_1: v1,
    approved_vendor_2: v2,
    approved_vendor_3: v3,
  });
  console.log(commitment);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
