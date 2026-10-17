// Fails unless the built bundle contains App strings that exist only past the "No deployment found" guard (issue #48).
// Usage: node scripts/check-bundle.mjs <outDir>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REQUIRED = [
  "Connect wallet", // App header, wallet button
  "Loading auction...", // App main render, before the first snapshot
  "Place a bid", // BidForm heading
  "Withdraw proceeds", // OwnerPanel button
  "Sweep after claim deadline", // OwnerPanel button
];

const outDir = process.argv[2];
if (!outDir) {
  console.error("Usage: node scripts/check-bundle.mjs <outDir>");
  process.exit(2);
}

const assets = join(outDir, "assets");
const js = readdirSync(assets)
  .filter((f) => f.endsWith(".js"))
  .map((f) => readFileSync(join(assets, f), "utf8"))
  .join("\n");
if (!js) {
  console.error(`check-bundle: no JS found in ${assets}`);
  process.exit(1);
}

const missing = REQUIRED.filter((s) => !js.includes(s));
if (missing.length) {
  console.error(`check-bundle: ${outDir} is missing App strings (was the deployment guard folded away?):`);
  for (const s of missing) console.error(`  - ${s}`);
  process.exit(1);
}
console.log(`check-bundle: ${outDir} contains all ${REQUIRED.length} App strings.`);
