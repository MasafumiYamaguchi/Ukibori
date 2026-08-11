#!/usr/bin/env node
// #30 static-CPU-golden maintenance CLI.
//
//   node scripts/golden-cpu.mjs --verify   (default) recompute and VERIFY the
//                                          checked-in goldens; exit 1 when a
//                                          digest or parameter changed
//   node scripts/golden-cpu.mjs --update   EXPLICIT maintenance regeneration:
//                                          recompute, print every changed
//                                          fixture/buffer digest, rewrite
//                                          goldens/cpu-goldens.json
//
// This script consumes the BUILT public ESM (dist/index.js): run
// `npm run build -w ukibori-renderer` before using it. Normal test/CI runs
// NEVER invoke --update: the vitest golden test
// (src/cpu-goldens.test.ts, part of `npm test`) only verifies against the
// checked-in file.
//
// The CPU renderer is never changed merely to update a failing golden:
// classify and explain the semantic change first (contract / coordinate /
// precision / sampling / scheduling / color-space), then regenerate. The
// updated JSON file is the reviewable artifact of that decision.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCatalog } from "../test-browser/catalog.mjs";
import { createGoldenRunner, goldenFile } from "../test-browser/golden-core.mjs";
import { createOracle } from "../test-browser/oracle.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const bundlePath = join(pkgRoot, "dist", "index.js");
const goldensPath = join(pkgRoot, "test-browser", "goldens", "cpu-goldens.json");

const mode = process.argv.includes("--update") ? "update" : "verify";

if (!existsSync(bundlePath)) {
  console.error(
    "golden-cpu.mjs: built bundle not found at " +
      bundlePath +
      " — run `npm run build -w ukibori-renderer` first " +
      "(the golden tooling consumes the same public ESM the browser harness runs)",
  );
  process.exit(1);
}

const api = await import(pathToBundle(bundlePath));
const catalog = createCatalog(api);
const oracle = createOracle(api);
const runner = createGoldenRunner({ oracle, catalog });

// A missing goldens file only makes sense for an explicit --update
// (first-time bootstrap); verification requires the checked-in file.
let goldens = null;
if (existsSync(goldensPath)) {
  goldens = JSON.parse(await readFile(goldensPath, "utf8"));
} else if (mode === "update") {
  goldens = { format: "ukibori-cpu-goldens-v1", goldens: [] };
} else {
  console.error(`golden-cpu: goldens file not found at ${goldensPath} — nothing to verify`);
  process.exit(1);
}

const result =
  mode === "verify" ? await runner.verify(goldens) : await runner.update(goldens);

if (result.changes.length === 0) {
  console.log(
    `golden-cpu: ${mode === "verify" ? "VERIFY" : "UPDATE"}: ` +
      `${result.totalFixtures} fixtures / ${result.totalBuffers} buffer digests: no changes`,
  );
  process.exit(0);
}

console.log(
  `golden-cpu: ${mode === "verify" ? "VERIFY FAILED" : "UPDATE"}: ` +
    `${result.changes.length} buffer digest(s) changed across ${result.totalFixtures} golden fixtures:`,
);
for (const change of result.changes) {
  const oldDigest = change.oldDigest ?? "(missing)";
  const newDigest = change.newDigest ?? "(missing)";
  console.log(
    `  fixture ${change.fixtureId} buffer ${change.buffer} ` +
      `(policy ${change.policy}, tolerance ${change.tolerance}) ` +
      `digest ${oldDigest} -> ${newDigest}`,
  );
}

if (mode === "verify") {
  console.error(
    "golden-cpu: goldens MISMATCH. Do NOT edit the CPU renderer to fix this: " +
      "classify and explain the semantic change (contract / coordinate / precision / " +
      "sampling / scheduling / color-space / unclassified), then run " +
      "`npm run goldens:update -w ukibori-renderer` and review the JSON diff.",
  );
  process.exit(1);
}

await mkdir(dirname(goldensPath), { recursive: true });
await writeFile(goldensPath, JSON.stringify(goldenFile(result.records), null, 2) + "\n", "utf8");
console.log(`golden-cpu: updated ${goldensPath}`);
process.exit(0);

function pathToBundle(path) {
  return new URL(`file://${path}`);
}
