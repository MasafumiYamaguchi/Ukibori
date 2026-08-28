#!/usr/bin/env node
// #46 CPU reference benchmark (§C): the CPU oracle pipeline mirroring the
// GPU stages, measured with the median over a warmed JIT.
//
//   node scripts/bench-cpu.mjs [--suite NAME] [--json out.json]
//        [--warmup N] [--samples N] [--resolution WxH]
//
// Suites:
//   stage          per-stage breakdown at one resolution
//   resolution     320x180 640x360 1280x720 1920x1080
//   surface        surface-grid {1,4,16,64,128,256}
//   mask           mask-heavy {0,1,16,64} x mask resolutions
//   shadow         samples {1,4,8,16} x angular radius {0, 0.05, 0.15}
//   reconstruction radius {1,2,4} (+ off) on a soft scene
//   partial        encode+diff planner host cost at dirty ratios
//   upload         encodeScene bytes by update type
//   all            every suite (default)
//
// The default extent is 320x180 and the default sample count is small
// because the CPU oracle is O(texels x surfaces x samples); pass
// --resolution 640x360 --samples 20 for the §24 representative numbers.
// Every result lands in the versioned JSON document (schema.mjs).

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectNodeEnvironment,
  gitCommitSync,
} from "./bench/lib/env-node.mjs";
import { summarizeSeries, median } from "./bench/lib/stats.mjs";
import {
  createResultDocument,
  validateResultDocument,
} from "./bench/lib/schema.mjs";
import {
  simpleRoundedRectScene,
  surfaceGridScene,
  maskHeavyScene,
  glyphGridScene,
  shadowScene,
  reconstructionHeavyScene,
  partialEditScene,
  SCENE_FAMILIES,
} from "./bench/lib/scenes.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const bundlePath = join(pkgRoot, "dist", "index.js");

if (!existsSync(bundlePath)) {
  console.error(
    "bench-cpu.mjs: built bundle not found at " +
      bundlePath +
      "  Erun `npm run build -w ukibori-renderer` first",
  );
  process.exit(1);
}
const api = await import(new URL(`file://${bundlePath}`).href);

/**
 * Every benchmark scene must pass through the public `createScene`
 * validator/sanitizer exactly like production code: the oracle functions
 * consume the VALIDATED Scene (defaults filled, numbers sanitized), never a
 * raw fixture object.
 */
function validated(builder) {
  return api.createScene(builder());
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const suiteName = flag("--suite", "all");
const jsonPath = flag("--json", null);
const warmup = Number(flag("--warmup", process.env.WARMUP ?? "3"));
const samples = Number(flag("--samples", process.env.SAMPLES ?? "5"));
const resolution = flag("--resolution", process.env.RESOLUTION ?? "320x180");
const [resW, resH] = resolution.split("x").map(Number);

const SUITES = ["stage", "resolution", "surface", "mask", "shadow", "reconstruction", "partial", "upload"];

// ---------------------------------------------------------------------------
// timing helpers
// ---------------------------------------------------------------------------

function benchStage(fn, label, warmups = warmup, sampleCount = samples) {
  for (let i = 0; i < warmups; i++) {
    fn();
  }
  const runs = [];
  for (let i = 0; i < sampleCount; i++) {
    const t0 = performance.now();
    fn();
    runs.push(performance.now() - t0);
  }
  return { label, summary: summarizeSeries(runs) };
}

function reportStage(table, { label, summary, extra = {} }) {
  table.push({
    label,
    medianMs: summary.median,
    p95Ms: summary.p95,
    minMs: summary.min,
    maxMs: summary.max,
    samples: summary.samples,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// CPU stage pipeline (mirrors the GPU stage chain; see §C)
// ---------------------------------------------------------------------------

function cpuFrameStages(scene, { samples: shadowSamples = 4, reconstruction = undefined } = {}) {
  const composed = api.composeSdfHeightField(scene);
  const caster = api.composeCasterHeightField(scene);
  const normal = api.computeNormals(composed.height);
  const raw = api.computeVisibility(scene, composed.height, {
    samples: shadowSamples,
    objectId: composed.objectId,
    casterHeight: caster,
  });
  const visibility =
    reconstruction !== undefined
      ? api.reconstructVisibility(raw, composed.height, {
          objectId: composed.objectId,
        }, reconstruction)
      : raw;
  api.shadePreparedFields(scene, {
    normal,
    objectId: composed.objectId,
    visibility,
  });
  return { composed, caster, normal, raw, visibility };
}

function caseId(prefix, params) {
  return `${prefix}/${Object.entries(params)
    .map(([k, v]) => `${k}-${v}`)
    .join("/")}`;
}

// ---------------------------------------------------------------------------
// suites
// ---------------------------------------------------------------------------

function suiteStage() {
  const scene = validated(() => simpleRoundedRectScene({ width: resW, height: resH }));
  const cases = [];
  const table = [];
  console.log(`\nstage breakdown @ ${resW}x${resH} (CPU oracle):`);
  console.log("-".repeat(68));
  const compose = () => api.composeSdfHeightField(scene);
  reportStage(table, benchStage(compose, "compose height (incl. mask SDF)"));
  reportStage(table, benchStage(() => api.composeCasterHeightField(scene), "compose caster height"));
  const composed = api.composeSdfHeightField(scene);
  const caster = api.composeCasterHeightField(scene);
  reportStage(table, benchStage(() => api.computeNormals(composed.height), "normal"));
  reportStage(table, benchStage(() => api.computeVisibility(scene, composed.height, {
    samples: 4,
    objectId: composed.objectId,
    casterHeight: caster,
  }), "shadow (4 samples)"));
  const raw = api.computeVisibility(scene, composed.height, {
    samples: 4,
    objectId: composed.objectId,
    casterHeight: caster,
  });
  reportStage(table, benchStage(() => api.reconstructVisibility(raw, composed.height, {
    objectId: composed.objectId,
  }, { enabled: true, radius: 2 }), "reconstruction (radius 2)"));
  const normal = api.computeNormals(composed.height);
  reportStage(table, benchStage(() => api.shadePreparedFields(scene, {
    normal,
    objectId: composed.objectId,
    visibility: raw,
  }), "lighting (shade + RGBA bytes)"));
  for (const row of table) {
    console.log(
      `  ${row.label.padEnd(34)} median ${row.medianMs.toFixed(3)}ms  ` +
        `(min ${row.minMs.toFixed(3)}, max ${row.maxMs.toFixed(3)}, p95 ${row.p95Ms.toFixed(3)})`,
    );
  }
  for (const row of table) {
    cases.push({
      id: caseId("cpu/stage", { resolution, stage: row.label.replace(/\s+/g, "-") }),
      parameters: { suite: "stage", resolution, stage: row.label, warmups: warmup, samples },
      metrics: { hostMs: row },
    });
  }
  return cases;
}

function suiteResolution() {
  const resolutions = [
    [320, 180],
    [640, 360],
    [1280, 720],
    [1920, 1080],
  ];
  const cases = [];
  console.log(`\nresolution scaling (simple-rounded-rect, 4 shadow samples):`);
  console.log("-".repeat(68));
  for (const [w, h] of resolutions) {
    const scene = validated(() => simpleRoundedRectScene({ width: w, height: h }));
    const full = benchStage(() => cpuFrameStages(scene), `${w}x${h} full chain`);
    console.log(
      `  ${`${w}x${h} full chain`.padEnd(34)} median ${full.summary.median.toFixed(3)}ms  ` +
        `(min ${full.summary.min.toFixed(3)}, max ${full.summary.max.toFixed(3)})`,
    );
    cases.push({
      id: caseId("cpu/resolution", { w, h }),
      parameters: { suite: "resolution", width: w, height: h, scene: SCENE_FAMILIES.simpleRoundedRect },
      metrics: { hostMs: full.summary, texels: w * h },
    });
  }
  return cases;
}

function suiteSurface() {
  const counts = [1, 4, 16, 64, 128, 256];
  const cases = [];
  console.log(`\nsurface-count scaling (surface-grid @ ${resW}x${resH}, 4 samples):`);
  console.log("-".repeat(68));
  for (const count of counts) {
    const scene = validated(() => surfaceGridScene({ width: resW, height: resH, count }));
    const full = benchStage(() => cpuFrameStages(scene), `surfaces-${count}`);
    console.log(
      `  ${`surfaces-${count}`.padEnd(34)} median ${full.summary.median.toFixed(3)}ms  ` +
        `(min ${full.summary.min.toFixed(3)}, max ${full.summary.max.toFixed(3)})`,
    );
    cases.push({
      id: caseId("cpu/surface", { count }),
      parameters: { suite: "surface", surfaceCount: count, resolution, scene: SCENE_FAMILIES.surfaceGrid },
      metrics: { hostMs: full.summary, texels: resW * resH },
    });
  }
  return cases;
}

function suiteMask() {
  const maskCounts = [0, 1, 16, 64];
  const maskResolutions = [16, 32, 64];
  const cases = [];
  console.log(`\nmask scaling (mask-heavy @ ${resW}x${resH}):`);
  console.log("-".repeat(68));
  for (const maskCount of maskCounts) {
    const scene = validated(() => maskHeavyScene({ width: resW, height: resH, maskCount, maskResolution: 32 }));
    const sdfOnly = benchStage(() => {
      for (const surface of scene.surfaces) {
        if (surface.shape.kind === "mask") {
          api.computeMaskSdf(surface.shape.mask);
        }
      }
    }, `masks-${maskCount} SDF only`);
    const full = benchStage(() => cpuFrameStages(scene), `masks-${maskCount} full chain`);
    console.log(
      `  ${`masks-${maskCount} SDF-only`.padEnd(34)} median ${sdfOnly.summary.median.toFixed(3)}ms`,
    );
    console.log(
      `  ${`masks-${maskCount} full chain`.padEnd(34)} median ${full.summary.median.toFixed(3)}ms`,
    );
    cases.push({
      id: caseId("cpu/mask", { maskCount, maskResolution: 32 }),
      parameters: { suite: "mask", maskCount, maskResolution: 32, resolution, scene: SCENE_FAMILIES.maskHeavy },
      metrics: {
        sdfHostMs: sdfOnly.summary,
        fullHostMs: full.summary,
        texels: resW * resH,
      },
    });
  }
  for (const maskResolution of maskResolutions) {
    const scene = validated(() => maskHeavyScene({ width: resW, height: resH, maskCount: 16, maskResolution }));
    const sdfOnly = benchStage(() => {
      for (const surface of scene.surfaces) {
        if (surface.shape.kind === "mask") {
          api.computeMaskSdf(surface.shape.mask);
        }
      }
    }, `mask-res-${maskResolution} SDF only`);
    console.log(
      `  ${`mask-res-${maskResolution} (16 masks) SDF-only`.padEnd(34)} median ${sdfOnly.summary.median.toFixed(3)}ms`,
    );
    cases.push({
      id: caseId("cpu/mask-resolution", { maskResolution, maskCount: 16 }),
      parameters: { suite: "mask", maskCount: 16, maskResolution, resolution, scene: SCENE_FAMILIES.maskHeavy },
      metrics: { sdfHostMs: sdfOnly.summary },
    });
  }
  return cases;
}

function suiteShadow() {
  const samplesList = [1, 4, 8, 16];
  const angularRadii = [0, 0.05, 0.15];
  const cases = [];
  console.log(`\nshadow scaling (soft-shadow @ ${resW}x${resH}):`);
  console.log("-".repeat(68));
  for (const angularRadius of angularRadii) {
    const scene = validated(() => shadowScene({ width: resW, height: resH, travel: "medium", angularRadius }));
    for (const shadowSamples of samplesList) {
      const stage = benchStage(() => {
        const composed = api.composeSdfHeightField(scene);
        api.computeVisibility(scene, composed.height, {
          samples: shadowSamples,
          objectId: composed.objectId,
          casterHeight: composed.height,
        });
      }, `samples-${shadowSamples} radius-${angularRadius}`);
      console.log(
        `  ${`samples-${shadowSamples} angRadius-${angularRadius}`.padEnd(34)} median ${stage.summary.median.toFixed(3)}ms`,
      );
      cases.push({
        id: caseId("cpu/shadow", { samples: shadowSamples, angularRadius }),
        parameters: { suite: "shadow", samples: shadowSamples, angularRadius, resolution, scene: SCENE_FAMILIES.softShadow },
        metrics: { hostMs: stage.summary, texels: resW * resH },
      });
    }
  }
  return cases;
}

function suiteReconstruction() {
  const radii = [1, 2, 4];
  const cases = [];
  console.log(`\nreconstruction scaling (soft-shadow @ ${resW}x${resH}, 8 samples):`);
  console.log("-".repeat(68));
  const scene = validated(() => shadowScene({ width: resW, height: resH, travel: "medium", angularRadius: 0.15 }));
  const composed = api.composeSdfHeightField(scene);
  const raw = api.computeVisibility(scene, composed.height, {
    samples: 8,
    objectId: composed.objectId,
    casterHeight: composed.height,
  });
  for (const radius of radii) {
    const stage = benchStage(() => api.reconstructVisibility(raw, composed.height, {
      objectId: composed.objectId,
    }, { enabled: true, radius }), `radius-${radius}`);
    console.log(
      `  ${`radius-${radius} (8 samples input)`.padEnd(34)} median ${stage.summary.median.toFixed(3)}ms`,
    );
    const taps = (2 * radius + 1) ** 2;
    cases.push({
      id: caseId("cpu/reconstruction", { radius }),
      parameters: { suite: "reconstruction", radius, tapsPerTexel: taps, resolution, scene: SCENE_FAMILIES.reconstructionHeavy },
      metrics: { hostMs: stage.summary, texels: resW * resH, totalTaps: resW * resH * taps },
    });
  }
  return cases;
}

function suitePartial() {
  const ratios = [0.01, 0.1, 0.25, 0.5, 1];
  const cases = [];
  console.log(`\npartial planner host cost (partial-edit @ ${resW}x${resH}):`);
  console.log("-".repeat(68));
  const base = validated(() => partialEditScene({ width: resW, height: resH }));
  const baseEncoded = api.encodeScene(base, 1);
  for (const ratio of ratios) {
    const edit = validated(() => partialEditScene({ width: resW, height: resH, edit: ratio }));
    const encoded = api.encodeScene(edit, 1);
    const stage = benchStage(() => api.diffEncodedScenes(baseEncoded.bytes, encoded.bytes), `ratio-${Math.round(ratio * 100)}%`);
    console.log(
      `  ${`dirty-${Math.round(ratio * 100)}% diff+plan`.padEnd(34)} median ${stage.summary.median.toFixed(3)}ms`,
    );
    cases.push({
      id: caseId("cpu/partial", { ratio: Math.round(ratio * 100) }),
      parameters: { suite: "partial", dirtyRatio: Math.round(ratio * 100), resolution, scene: SCENE_FAMILIES.partialEdit },
      metrics: { hostMs: stage.summary },
    });
  }
  return cases;
}

function suiteUpload() {
  const cases = [];
  console.log(`\nupload benchmark (encodeScene host cost @ ${resW}x${resH}):`);
  console.log("-".repeat(68));
  const rows = [];
  const scene = validated(() => surfaceGridScene({ width: resW, height: resH, count: 64 }));
  const surfaceStage = benchStage(() => api.encodeScene(scene, 1), "surface-grid-64 encode");
  console.log(`  ${"surface-grid-64 encode".padEnd(34)} median ${surfaceStage.summary.median.toFixed(3)}ms`);
  rows.push({ label: "surface-grid-64", summary: surfaceStage.summary, bytes: api.encodeScene(scene, 1).bytes.byteLength });
  const maskScene = validated(() => maskHeavyScene({ width: resW, height: resH, maskCount: 64, maskResolution: 32 }));
  const maskStage = benchStage(() => api.encodeScene(maskScene, 1), "mask-heavy-64 encode");
  console.log(`  ${"mask-heavy-64 encode".padEnd(34)} median ${maskStage.summary.median.toFixed(3)}ms`);
  rows.push({ label: "mask-heavy-64", summary: maskStage.summary, bytes: api.encodeScene(maskScene, 1).bytes.byteLength });
  for (const row of rows) {
    cases.push({
      id: caseId("cpu/upload", { scene: row.label }),
      parameters: { suite: "upload", scene: row.label, resolution },
      metrics: { hostMs: row.summary, encodedBytes: row.bytes },
    });
  }
  return cases;
}

const SUITE_RUNNERS = {
  stage: suiteStage,
  resolution: suiteResolution,
  surface: suiteSurface,
  mask: suiteMask,
  shadow: suiteShadow,
  reconstruction: suiteReconstruction,
  partial: suitePartial,
  upload: suiteUpload,
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const selected = suiteName === "all" ? SUITES : [suiteName];
const missing = selected.filter((name) => !(name in SUITE_RUNNERS));
if (missing.length > 0) {
  console.error(`bench-cpu.mjs: unknown suite(s) ${missing.join(", ")} (available: ${SUITES.join(", ")})`);
  process.exit(1);
}

console.log(
  `#46 CPU reference benchmark  E${resolution}, warmup ${warmup}, samples ${samples}, ` +
    `node ${process.version}, ${collectNodeEnvironment().cpuModel}`,
);
const cases = [];
for (const name of selected) {
  cases.push(...SUITE_RUNNERS[name]());
}

const doc = createResultDocument({
  commit: gitCommitSync(),
  environment: collectNodeEnvironment(),
  cases,
});
const problems = validateResultDocument(doc);
if (problems.length > 0) {
  console.error("bench-cpu.mjs: result document failed validation:");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
if (jsonPath !== null) {
  await writeFile(jsonPath, JSON.stringify(doc, null, 2), "utf8");
  console.log(`\nwrote ${jsonPath} (${cases.length} cases, schema v${doc.schemaVersion})`);
} else {
  console.log(`\n${cases.length} cases measured; pass --json out.json to save the result document.`);
}