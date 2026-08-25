#!/usr/bin/env node
// #43 soft-shadow reconstruction benchmark — the #43 report's performance
// data point at the documented 640x360 proxy extent.
//
//   node scripts/bench-shadow-reconstruction.mjs [--samples n]
//
// Measures the CPU reference implementation (the semantic oracle the GPU
// mirrors) in wall-clock milliseconds:
//
//   - 4 raw samples            (soft, no reconstruction)
//   - 8 raw samples            (soft, no reconstruction)
//   - 8 samples + reconstruction
//   - 16 raw samples           (soft, no reconstruction)
//
// The 32-sample configuration is intentionally NOT benchmarked: the #41
// API pins the sample-count candidates to {1, 4, 8, 16} (the dyadic set
// whose k/n visibility fractions are exactly representable, and the uniform
// capacity is SHADOW_MAX_SAMPLES = 16). Increasing the default sample count
// would solve nothing — the #43 target is `8 samples + reconstruction`
// being substantially smoother than `8 raw samples` while materially
// cheaper than brute-force high sample counts.
//
// GPU pass times are reported by the real-WebGPU harness in CI
// (test:webgpu -> parity.mjs timestamp/benchmark sections); this script
// covers the host-side oracle costs (compose + shadow + reconstruction +
// shading per configuration) with the median over the warmed JIT.
//
// Consumes the BUILT public ESM (dist/index.js): run
// `npm run build -w ukibori-renderer` before using it.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const bundlePath = join(pkgRoot, "dist", "index.js");

if (!existsSync(bundlePath)) {
  console.error(
    "bench-shadow-reconstruction.mjs: built bundle not found at " +
      bundlePath +
      " — run `npm run build -w ukibori-renderer` first",
  );
  process.exit(1);
}

const api = await import(pathToBundle(bundlePath));

function pathToBundle(path) {
  // dist/index.js is a real ESM file: import it with a file:// URL.
  return new URL(`file://${path}`).href;
}

const WIDTH = 640;
const HEIGHT = 360;
// The 640x360 CPU reference costs ~1.5s/frame at 4 samples, so the default
// run is trimmed to keep the whole script under a minute; pass
//   WARMUP=5 SAMPLES=20 node scripts/bench-shadow-reconstruction.mjs
// for a more stable measurement.
const WARMUP = Number(process.env.WARMUP ?? 3);
const SAMPLES = Number(process.env.SAMPLES ?? 8);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** The #43 proxy scene: a flat receiver plane with a raised slab caster. */
function proxyScene() {
  return api.createScene({
    width: WIDTH,
    height: HEIGHT,
    surfaces: [
      {
        id: "slab",
        position: { x: 320, y: 140 },
        size: { x: 90, y: 40 },
        elevation: 0,
        thickness: 24,
        shape: { kind: "roundedRect", radius: 16 },
        profile: { kind: "bevel" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: {
      direction: { x: -0.6, y: -0.4, z: 0.8 },
      intensity: 1,
      angularRadius: Math.fround(0.2),
    },
  });
}

function frame(scene, samples, reconOptions) {
  const composed = api.composeSdfHeightField(scene);
  const visibility = api.computeVisibility(scene, composed.height, {
    samples,
    objectId: composed.objectId,
    casterHeight: composed.height,
  });
  if (reconOptions !== undefined) {
    api.reconstructVisibility(visibility, composed.height, {
      objectId: composed.objectId,
    }, reconOptions);
  }
  api.shadeHeightField(scene, {
    height: composed.height,
    objectId: composed.objectId,
    visibility,
  });
}

function bench(scene, label, samples, reconOptions) {
  for (let i = 0; i < WARMUP; i++) {
    frame(scene, samples, reconOptions); // warm the JIT
  }
  const runs = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    frame(scene, samples, reconOptions);
    runs.push(performance.now() - t0);
  }
  const med = median(runs);
  console.log(
    `${label.padEnd(34)} median ${med.toFixed(3)}ms   (min ${Math.min(...runs).toFixed(3)}ms, ` +
      `max ${Math.max(...runs).toFixed(3)}ms)`,
  );
  return med;
}

const scene = proxyScene();
console.log(`#43 CPU reference @ ${WIDTH}x${HEIGHT} (proxy extent), angularRadius 0.2 rad:`);
console.log("---");
const results = {
  "4 raw samples": bench(scene, "4 raw samples", 4, undefined),
  "8 raw samples": bench(scene, "8 raw samples", 8, undefined),
  "8 samples + reconstruction (radius 2)": bench(
    scene,
    "8 samples + reconstruction (radius 2)",
    8,
    { enabled: true, radius: 2 },
  ),
  "16 raw samples": bench(scene, "16 raw samples", 16, undefined),
};
console.log("---");
const reconCost = results["8 samples + reconstruction (radius 2)"] - results["8 raw samples"];
console.log(
  `reconstruction stage cost at 8 samples + radius 2: ~${reconCost.toFixed(3)}ms ` +
    `(${(100 * reconCost / results["8 raw samples"]).toFixed(1)}% of the raw 8-sample shadow pass)`,
);
console.log(
  `8 samples + reconstruction vs 16 raw samples: ` +
    `${(100 * results["8 samples + reconstruction (radius 2)"] / results["16 raw samples"]).toFixed(1)}% of the cost`,
);
console.log(
  "note: 32 samples is out of scope — #41 pins the sample-count candidates to the " +
    "exactly-representable dyadic set {1,4,8,16} and the uniform capacity is 16; " +
    "the target is 8+reconstruction beating brute-force higher counts, not a default bump.",
);