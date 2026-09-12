// Focused #56 conversion benchmark, NOT a DOM/layout/GPU or FPS benchmark.
// Run from any directory: node packages/ukibori-dom/scripts/bench-text-color.mjs
import { build } from "esbuild";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/computed-text-color.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node",
});
const { parseOpaqueComputedSrgb, readOpaqueComputedTextColor } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const style = { color: "rgb(128, 64, 17)" };
const element = {};
// Identical constant-cost live-read stub in both paths isolates conversion.
globalThis.getComputedStyle = () => style;
const baseline = () => parseOpaqueComputedSrgb(getComputedStyle(element).color);
const retained = () => readOpaqueComputedTextColor(element);
const iterations = 100_000;
let checksum = 0;
function sample(fn) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) checksum += fn().r;
  return performance.now() - start;
}
for (let i = 0; i < 10_000; i++) { baseline(); retained(); }
const before = [], after = [];
for (let round = 0; round < 9; round++) {
  // Alternate order to reduce systematic warmup/order bias.
  if (round % 2) { after.push(sample(retained)); before.push(sample(baseline)); }
  else { before.push(sample(baseline)); after.push(sample(retained)); }
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({
  scope: "unchanged computed-color parsing/conversion only; getComputedStyle stubbed; no FPS claim",
  node: process.version, iterations, rounds: 9,
  baselineMedianMs: median(before), retainedMedianMs: median(after),
  speedup: median(before) / median(after), checksum,
}, null, 2));
