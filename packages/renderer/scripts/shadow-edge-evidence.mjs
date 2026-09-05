#!/usr/bin/env node
// #53 Phase 1 evidence: measure WHERE shadow edge jaggedness comes from.
//
//   node scripts/shadow-edge-evidence.mjs --out <dir> [--scenarios a,b,c]
//
// The CPU oracle is bit-exact with the GPU for the RAW visibility field
// (hard exact {0,1}, soft dyadic k/n), so the cause analysis runs in Node:
// for every (scenario, variant, dpr) it renders
//
//   raw visibility  ->  reconstructed visibility (soft only)  ->  presented
//   bytes (the production compositor helper, composited over white)
//
// and measures, along horizontal cuts crossing the shadow edge:
//
//   crossingZigzagMax/Rms  texels  deviation of the per-row 50% crossing
//                                  from a fitted straight line (staircase)
//   crossingRuns           -      mean run length of identical integer
//                                  crossings along the boundary
//   transitionTexels       texels mean count of texels in (0.02, 0.98)
//   levels                 -      distinct visibility values in (0.02, 0.98)
//   boundaryTexelFraction  -      fraction of texels whose 3x3 raw
//                                  neighborhood is non-uniform (the cost
//                                  driver for boundary-local work)
//   thin: minVis, areaBelowHalf   thin-feature preservation (thin scenario)
//
// Artifacts: summary.json, per-case raw/recon/presented P6 PPMs, and
// per-row crossing CSVs for the diagonal cases.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const bundlePath = join(pkgRoot, "dist", "index.js");
if (!existsSync(bundlePath)) {
  console.error(
    "shadow-edge-evidence.mjs: built bundle not found at " +
      bundlePath +
      "  Erun `npm run build -w ukibori-renderer` first",
  );
  process.exit(1);
}
const api = await import(new URL(`file://${bundlePath}`).href);

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const outDir = flag("--out", join(pkgRoot, "test-browser", "shadow-edge-artifacts", "phase1"));
const onlyScenarios = flag("--scenarios", null);
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// DPR-aware CPU composition (mirrors test-browser/oracle.mjs cpuOracle):
// render texel (tx, ty) samples the scene at ((tx + 0.5) / dpr).
// ---------------------------------------------------------------------------

function composeAtDpr(scene, dpr) {
  const dprF = Math.fround(dpr);
  const rw = Math.max(1, Math.floor(scene.width * dprF));
  const rh = Math.max(1, Math.floor(scene.height * dprF));
  const height = new api.HostBuffer(api.HEIGHT_SPEC(rw, rh));
  const caster = new api.HostBuffer(api.HEIGHT_SPEC(rw, rh));
  const objectId = new api.HostBuffer(api.OBJECT_ID_SPEC(rw, rh));
  const casters = scene.surfaces.filter((s) => s.castsShadow);
  for (let ty = 0; ty < rh; ty++) {
    for (let tx = 0; tx < rw; tx++) {
      const sx = (tx + 0.5) / dprF;
      const sy = (ty + 0.5) / dprF;
      let best = 0;
      let owner = api.NO_OWNER;
      let bestCaster = 0;
      for (let i = 0; i < scene.surfaces.length; i++) {
        const h = Math.fround(api.surfaceHeight(scene.surfaces[i], sx, sy));
        if (Number.isFinite(h) && h > best) {
          best = h;
          owner = i;
        }
      }
      let bestC = 0;
      for (let i = 0; i < casters.length; i++) {
        const h = Math.fround(api.surfaceHeight(casters[i], sx, sy));
        if (Number.isFinite(h) && h > bestC) {
          bestC = h;
        }
      }
      const g = ty * rw + tx;
      height.set(tx, ty, 0, best);
      caster.set(tx, ty, 0, bestC);
      objectId.set(tx, ty, 0, owner);
    }
  }
  return { height, caster, objectId, rw, rh };
}

// ---------------------------------------------------------------------------
// Scenario scenes (logical units; the light is near-vertical so the shadow
// edge sits next to the caster silhouette and stays inside the cut window).
// ---------------------------------------------------------------------------

function panelSurface(width, height) {
  return {
    id: "panel",
    position: { x: 0, y: 0 },
    size: { x: width, y: height },
    elevation: 0,
    thickness: 0,
    shape: { kind: "roundedRect", radius: 0 },
    profile: { kind: "flat" },
    material: "matte",
    castsShadow: false,
    receivesShadow: true,
  };
}

function maskCaster(id, width, height, maskW, maskH, alphaFn, { elevation = 0, thickness = 8 } = {}) {
  const alpha = new Float32Array(maskW * maskH);
  for (let y = 0; y < maskH; y++) {
    for (let x = 0; x < maskW; x++) {
      alpha[y * maskW + x] = alphaFn(x + 0.5, y + 0.5) ? 1 : 0;
    }
  }
  return {
    id,
    position: { x: 0, y: 0 },
    size: { x: width, y: height },
    elevation,
    thickness,
    shape: { kind: "mask", mask: { width: maskW, height: maskH, alpha } },
    profile: { kind: "flat" },
    material: "silicone",
    castsShadow: true,
    receivesShadow: true,
  };
}

/** 45-degree half plane: alpha = 1 left of the line x - y = d (in mask px). */
const diagonalAlpha = (d) => (x, y) => x - y < d;
/** 45-degree thin strip |x - y - d| <= w/2. */
const thinAlpha = (d, w) => (x, y) => Math.abs(x - y - d) <= w / 2;

const SCENES = {
  // One clean 45-degree shadow edge across the cut band. Representative
  // oblique light (-0.7,-0.5,0.6): the height-8 silhouette projects to
  // x - y ~= 30 + 8*(1.166-0.834) ~= 32.7.
  diagonal: () => ({
    scene: {
      width: 128,
      height: 96,
      surfaces: [panelSurface(128, 96), maskCaster("diag", 128, 96, 128, 96, diagonalAlpha(30), { elevation: 0, thickness: 8 })],
      light: { direction: { x: -0.7, y: -0.5, z: 0.6 }, intensity: 1, angularRadius: 0 },
    },
    options: { maxDistance: 60, stepSize: 0.5, bias: 0.5 },
    cut: { y0: 24, y1: 72, diag: 32.7, window: 25 },
    thinCheck: null,
  }),
  // Same diagonal edge with a 24-unit-tall caster: the angularRadius 0.15
  // penumbra spreads over ~6 scene units -> the soft banding is visible;
  // the silhouette projects to x - y ~= 30 + 24*0.332 ~= 38.
  diagonalTall: () => ({
    scene: {
      width: 128,
      height: 96,
      surfaces: [panelSurface(128, 96), maskCaster("diag", 128, 96, 128, 96, diagonalAlpha(30), { elevation: 0, thickness: 24 })],
      light: { direction: { x: -0.7, y: -0.5, z: 0.6 }, intensity: 1, angularRadius: 0 },
    },
    options: { maxDistance: 60, stepSize: 0.5, bias: 0.5 },
    cut: { y0: 24, y1: 72, diag: 38, window: 30 },
    thinCheck: null,
  }),
  // 2-scene-unit wide 45-degree line blocker (thin-feature preservation);
  // its shadow strip lands near x - y ~= 32.7.
  thin: () => ({
    scene: {
      width: 128,
      height: 96,
      surfaces: [panelSurface(128, 96), maskCaster("thin", 128, 96, 128, 96, thinAlpha(30, 2), { elevation: 0, thickness: 8 })],
      light: { direction: { x: -0.7, y: -0.5, z: 0.6 }, intensity: 1, angularRadius: 0 },
    },
    options: { maxDistance: 60, stepSize: 0.5, bias: 0.5 },
    cut: { y0: 24, y1: 72, diag: 32.7, window: 15, take: "first" },
    thinCheck: { kind: "strip" },
  }),
  // The #48 representative rounded-rect bevel caster: the long left shadow
  // edge lands near x ~= 38 + 24*1.166*(0.866) ... measured window covers it.
  rounded: () => ({
    scene: {
      width: 128,
      height: 96,
      surfaces: [
        panelSurface(128, 96),
        {
          id: "caster",
          position: { x: Math.floor(128 * 0.3), y: Math.floor(96 * 0.25) },
          size: { x: 70, y: 40 },
          elevation: 0,
          thickness: 24,
          shape: { kind: "roundedRect", radius: 12 },
          profile: { kind: "bevel" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      light: { direction: { x: -0.7, y: -0.5, z: 0.6 }, intensity: 1, angularRadius: 0 },
    },
    options: { maxDistance: 120, stepSize: 0.5, bias: 0.5 },
    cut: { y0: 30, y1: 60, windowX0: 35, windowX1: 62, take: "first" },
    thinCheck: null,
  }),
  // Thin wide strip close above the receivers (near-contact edge): with
  // light (0.4,0.6,0.7) the height-4 strip projects up-left by ~(-1.6,-2.5).
  near: () => ({
    scene: {
      width: 128,
      height: 96,
      surfaces: [
        panelSurface(128, 96),
        {
          id: "strip",
          position: { x: 24, y: 40 },
          size: { x: 80, y: 3 },
          elevation: 0,
          thickness: 4,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      light: { direction: { x: 0.4, y: 0.6, z: 0.7 }, intensity: 1, angularRadius: 0 },
    },
    options: { maxDistance: 60, stepSize: 0.5, bias: 0.5 },
    cut: { y0: 35, y1: 40, windowX0: 10, windowX1: 60, take: "first" },
    thinCheck: null,
  }),
  // Long-travel shadow: light (-0.9,-0.6,0.5) projects the height-12 caster
  // by ~ (23,15) -> the edge lands far from the caster near x ~= 33.
  far: () => ({
    scene: {
      width: 128,
      height: 96,
      surfaces: [
        panelSurface(128, 96),
        {
          id: "caster",
          position: { x: 10, y: 10 },
          size: { x: 24, y: 18 },
          elevation: 0,
          thickness: 12,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      light: { direction: { x: -0.9, y: -0.6, z: 0.5 }, intensity: 1, angularRadius: 0 },
    },
    options: { maxDistance: 300, stepSize: 0.5, bias: 0.5 },
    cut: { y0: 30, y1: 50, windowX0: 25, windowX1: 45, take: "first" },
    thinCheck: null,
  }),
  // Glyph-like mask caster (counters/holes); near-vertical light keeps the
  // ~2-3-unit shadow band hugging the silhouette (the worst case for 1-texel
  // features). whole-image thin preservation + boundary fraction; no cut.
  glyph: () => {
    const rows = [
      "  ####    ####  ",
      " ##  ##  ##  ## ",
      "##    ## ##   ##",
      "##    ## ##    #",
      "######## ##    #",
      "##    ## ##    #",
      "##    ## ##   ##",
      "##    ##  ##  ##",
      "##    ##   #### ",
    ];
    const mask = api.maskFromAscii(rows);
    return {
      scene: {
        width: 128,
        height: 96,
        surfaces: [
          panelSurface(128, 96),
          {
            id: "glyph",
            position: { x: 44, y: 20 },
            size: { x: 32, y: 18 },
            elevation: 0,
            thickness: 12,
            shape: { kind: "mask", mask },
            profile: { kind: "flat" },
            material: "silicone",
            castsShadow: true,
            receivesShadow: true,
          },
        ],
        light: { direction: { x: -0.2, y: -0.15, z: 1 }, intensity: 1, angularRadius: 0 },
      },
      options: { maxDistance: 60, stepSize: 0.5, bias: 0.5 },
      cut: null,
      thinCheck: { kind: "maskWhole" },
    };
  },
};

// ---------------------------------------------------------------------------
// Rendering + metrics
// ---------------------------------------------------------------------------

const VARIANTS = {
  hard: { samples: 1, angularRadius: 0, reconstruct: false },
  soft4: { samples: 4, angularRadius: 0.15, reconstruct: true },
  soft8: { samples: 8, angularRadius: 0.15, reconstruct: true },
  soft16: { samples: 16, angularRadius: 0.15, reconstruct: true },
};

function renderCase(scenarioName, variantName, dpr) {
  const scenario = SCENES[scenarioName]();
  const variant = VARIANTS[variantName];
  const scene = structuredClone(scenario.scene);
  scene.light.angularRadius = Math.fround(variant.angularRadius);
  const fields = composeAtDpr(scene, dpr);
  const raw = api.computeVisibility(scene, fields.height, {
    ...scenario.options,
    samples: variant.samples,
    objectId: fields.objectId,
    casterHeight: fields.caster,
    dpr,
  });
  const softActive = variant.angularRadius > 0 && variant.samples > 1;
  let reconstructed = null;
  if (softActive && variant.reconstruct) {
    reconstructed = api.reconstructVisibility(raw, fields.height, { objectId: fields.objectId }, { radius: 2 });
  }
  const normal = api.computeNormals(fields.height);
  const shaded = api.shadePreparedFields(scene, {
    normal,
    objectId: fields.objectId,
    visibility: reconstructed ?? raw,
  });
  // Presented bytes: production compositor helper per base-plane texel,
  // composited over white for the artifact (the canvas shows it over the
  // page background; over white makes the tint edge directly visible).
  const presented = new Uint8ClampedArray(fields.rw * fields.rh * 4);
  const visData = (reconstructed ?? raw).data;
  const objData = fields.objectId.data;
  const colorData = shaded.color.data;
  for (let i = 0; i < objData.length; i++) {
    const p = i * 4;
    if (objData[i] !== api.NO_OWNER) {
      presented[p] = colorData[p];
      presented[p + 1] = colorData[p + 1];
      presented[p + 2] = colorData[p + 2];
      presented[p + 3] = 255;
    } else {
      const strength = Math.min(1, Math.max(0, 1 - visData[i]));
      const bytes = api.compositeShadowPremultipliedStrengthBytes(strength);
      const a = bytes[3] / 255;
      presented[p] = Math.round(255 * (1 - a) + bytes[0]);
      presented[p + 1] = Math.round(255 * (1 - a) + bytes[1]);
      presented[p + 2] = Math.round(255 * (1 - a) + bytes[2]);
      presented[p + 3] = 255;
    }
  }
  return { scenario, fields, raw, reconstructed, presented };
}

/** Boundary/edge metrics along horizontal cuts crossing the shadow edge.
 * The cut is given in LOGICAL scene units and scaled to render texels.
 * Crossings are the 50%-crossings; the MAIN edge is the steepest crossing
 * in the window (soft fields ripple, so "first" is not the edge). */
function cutMetrics(data, rw, rh, cutScaled) {
  const cut = cutScaled;
  const crossings = [];
  const transitions = [];
  const levels = new Set();
  for (let y = cut.y0; y < cut.y1; y++) {
    // 50% crossings across the window with their local steepness. The
    // sub-texel interpolation only applies to a REAL local step (|b-a|
    // above the plateau noise floor); a plateau pair reports the texel
    // boundary (no extrapolation across shallow tails).
    const found = [];
    for (let x = 1; x < rw; x++) {
      const a = data[y * rw + x - 1];
      const b = data[y * rw + x];
      if ((a - 0.5) * (b - 0.5) < 0) {
        const t = Math.abs(b - a) > 0.05 ? (0.5 - a) / (b - a) : 0.5;
        found.push({ x: x - 1 + t, steep: Math.abs(b - a) });
      }
    }
    // Restrict to the scenario window (the half-plane edge / strip).
    const lineX = cut.diag !== undefined ? y + cut.diag : null;
    let picked = found.filter((c) =>
      lineX !== null
        ? Math.abs(c.x - lineX) <= cut.window
        : c.x >= cut.windowX0 && c.x <= cut.windowX1,
    );
    if (picked.length > 1) {
      // "closest": the main edge nearest the expected line (diag cuts);
      // "steepest": the largest jump (windowX cuts on binary-ish fields).
      let best = picked[0];
      for (const c of picked) {
        const better =
          lineX !== null
            ? Math.abs(c.x - lineX) < Math.abs(best.x - lineX)
            : c.steep > best.steep;
        if (better) best = c;
      }
      picked = [best];
    }
    for (const c of picked) {
      crossings.push({ y, x: c.x });
      // transition width around the crossing
      let width = 0;
      for (let x = Math.max(0, Math.floor(c.x) - 24); x < Math.min(rw, Math.ceil(c.x) + 24); x++) {
        const v = data[y * rw + x];
        if (v > 0.02 && v < 0.98) {
          width++;
          levels.add(Math.round(v * 1e6) / 1e6);
        }
      }
      transitions.push(width);
    }
  }
  const xs = crossings.map((c) => c.x);
  const ys = crossings.map((c) => c.y);
  let zigzagMax = 0;
  let zigzagSumSq = 0;
  if (xs.length > 2) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (ys[i] - my) * (xs[i] - mx);
      syy += (ys[i] - my) * (ys[i] - my);
    }
    const slope = syy > 0 ? sxy / syy : 0;
    for (let i = 0; i < n; i++) {
      const dev = xs[i] - (mx + slope * (ys[i] - my));
      zigzagMax = Math.max(zigzagMax, Math.abs(dev));
      zigzagSumSq += dev * dev;
    }
    var zigzagRms = Math.sqrt(zigzagSumSq / n);
    var meanCrossing = mx;
  }
  // run length of identical integer crossings along the boundary
  const runs = [];
  if (xs.length > 1) {
    let run = 1;
    for (let i = 1; i < xs.length; i++) {
      if (Math.floor(xs[i]) === Math.floor(xs[i - 1])) {
        run++;
      } else {
        runs.push(run);
        run = 1;
      }
    }
    runs.push(run);
  }
  return {
    crossings: xs.length,
    zigzagMaxTexels: round3(zigzagMax ?? 0),
    zigzagRmsTexels: round3(zigzagRms ?? 0),
    meanCrossing: round3(meanCrossing ?? 0),
    meanRunTexels: round3(runs.length ? xs.length / runs.length : 0),
    maxRunTexels: runs.length ? Math.max(...runs) : 0,
    transitionTexelsMean: round3(transitions.length ? transitions.reduce((a, b) => a + b, 0) / transitions.length : 0),
    transitionTexelsMax: transitions.length ? Math.max(...transitions) : 0,
    levels: levels.size,
  };
}

/** Fraction of texels whose 3x3 raw neighborhood is non-uniform. */
function boundaryFraction(data, rw, rh) {
  let boundary = 0;
  for (let y = 1; y < rh - 1; y++) {
    for (let x = 1; x < rw - 1; x++) {
      const c = data[y * rw + x];
      let diff = false;
      for (let dy = -1; dy <= 1 && !diff; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (data[(y + dy) * rw + (x + dx)] !== c) {
            diff = true;
            break;
          }
        }
      }
      if (diff) boundary++;
    }
  }
  return round3(boundary / ((rw - 2) * (rh - 2)));
}

function round3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}

/** Scale a logical-unit cut to render-texel space (floor at the edges so the
 * window never crosses into neighboring geometry). */
function scaleCut(cut, dpr) {
  const dprF = Math.fround(dpr);
  const scaled = {
    y0: Math.round(cut.y0 * dprF),
    y1: Math.round(cut.y1 * dprF),
    window: cut.window !== undefined ? Math.round(cut.window * dprF) : undefined,
    take: cut.take,
  };
  if (cut.diag !== undefined) {
    scaled.diag = cut.diag * dprF;
  }
  if (cut.windowX0 !== undefined) {
    scaled.windowX0 = Math.round(cut.windowX0 * dprF);
    scaled.windowX1 = Math.round(cut.windowX1 * dprF);
  }
  return scaled;
}

function toPpm(rgba) {
  return Buffer.from(api.toPpmBytes(rgba));
}

function grayscalePpm(field, rw, rh) {
  const rgba = new Uint8ClampedArray(rw * rh * 4);
  for (let i = 0; i < rw * rh; i++) {
    const v = Math.max(0, Math.min(1, field[i]));
    const g = Math.round(v * 255);
    rgba[i * 4] = g;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = 255;
  }
  return toPpm({ width: rw, height: rh, data: rgba });
}

// ---------------------------------------------------------------------------
// Phase 1 FIX PROTOTYPES (measured before any production change)
// ---------------------------------------------------------------------------

const SUBTEXEL_OFFSETS = {
  4: [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]],
  9: [[-1 / 3, -1 / 3], [0, -1 / 3], [1 / 3, -1 / 3], [-1 / 3, 0], [0, 0], [1 / 3, 0], [-1 / 3, 1 / 3], [0, 1 / 3], [1 / 3, 1 / 3]],
};

/**
 * Candidate "boundary-local subpixel coverage refinement" (hard): texels
 * whose 3x3 RAW neighborhood is non-uniform re-evaluate the EXACT same hard
 * occlusion semantics at K deterministic subtexel positions and store the
 * measured occlusion fraction. Interior texels keep the raw value verbatim;
 * the raw field itself is never modified (the oracle/debug contract).
 */
function refineHardCoverage(raw, fields, scene, options, dpr, K) {
  const out = new Float32Array(raw.data);
  const ctx = api.prepareShadowContext(scene, fields.height, {
    ...options,
    samples: 1,
    objectId: fields.objectId,
    casterHeight: fields.caster,
    dpr,
  });
  const offsets = SUBTEXEL_OFFSETS[K];
  let refined = 0;
  for (let ty = 1; ty < fields.rh - 1; ty++) {
    for (let tx = 1; tx < fields.rw - 1; tx++) {
      const g = ty * fields.rw + tx;
      const c = raw.data[g];
      let nonUniform = false;
      for (let dy = -1; dy <= 1 && !nonUniform; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (raw.data[g + dy * fields.rw + dx] !== c) {
            nonUniform = true;
            break;
          }
        }
      }
      if (!nonUniform) {
        continue;
      }
      let occluded = 0;
      for (const [ox, oy] of offsets) {
        const px = (tx + 0.5 + ox) / Math.fround(dpr);
        const py = (ty + 0.5 + oy) / Math.fround(dpr);
        if (api.isOccludedWithContext(ctx, fields.height, px, py)) {
          occluded++;
        }
      }
      out[g] = occluded / K;
      refined++;
    }
  }
  return { data: out, refined, texels: fields.rw * fields.rh };
}

/**
 * Candidate "range-gated (value-bilateral) reconstruction" (soft): the
 * production box kernel plus a VALUE gate — a neighbor is averaged only when
 * |vis_neighbor - vis_center| <= gate (one sample level by default), on top
 * of the existing ownership + heightGate. One-level jumps (the decorrelated
 * sampling salt-and-pepper) smooth; multi-level jumps (thin dark bands next
 * to lit ground, core edges) are preserved.
 */
function gatedReconPrototype(raw, fields, { radius, gate }) {
  const raw_ = raw.data;
  const height = fields.height.data;
  const owner = fields.objectId.data;
  const out = new Float32Array(raw_.length);
  const heightGate = 0.5;
  const r = radius;
  for (let ty = 0; ty < fields.rh; ty++) {
    for (let tx = 0; tx < fields.rw; tx++) {
      const g = ty * fields.rw + tx;
      const centerOwner = owner[g];
      const centerY = height[g];
      const centerVis = raw_[g];
      let sum = 0;
      let taps = 0;
      for (let dy = -r; dy <= r; dy++) {
        const ny = ty + dy;
        if (ny < 0 || ny >= fields.rh) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = tx + dx;
          if (nx < 0 || nx >= fields.rw) continue;
          const ng = ny * fields.rw + nx;
          if (owner[ng] !== centerOwner) continue;
          const nh = height[ng];
          if (Math.abs(Math.fround(centerY - nh)) > heightGate) continue;
          const nv = raw_[ng];
          if (Math.abs(nv - centerVis) > gate) continue;
          sum += nv;
          taps++;
        }
      }
      const value = taps > 0 ? Math.min(1, Math.max(0, sum / taps)) : Math.min(1, Math.max(0, centerVis));
      out[g] = value;
    }
  }
  return { data: out };
}

/**
 * Candidate "ring-rule binomial edge refinement" (postprocess, no extra
 * rays): a texel is refined ONLY when its 8-neighbor ring shows exactly two
 * value transitions with BOTH arcs >= 3 ring elements (a single straight-ish
 * boundary through the window). Narrow features (arcs 1-2), isolated texels,
 * corners and speckle keep the source value verbatim. The refinement value
 * is the separable (1,2,1)/2 x (1,2,1)/2 binomial of the 3x3 window — a
 * ~1-2 texel ramp centered on the boundary (the 50% crossing is preserved
 * by the symmetric kernel).
 */
function ringRuleRefine(source, fields) {
  const src = source.data;
  const out = new Float32Array(src.length);
  const rw = fields.rw;
  const rh = fields.rh;
  const ringDeltas = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let ty = 1; ty < rh - 1; ty++) {
    for (let tx = 1; tx < rw - 1; tx++) {
      const g = ty * rw + tx;
      const c = src[g] >= 0.5;
      // ring transitions + arc lengths
      let transitions = 0;
      const arcRuns = [];
      let run = 1;
      let firstSameLast = true;
      const ring = [];
      for (let i = 0; i < 8; i++) {
        const [dx, dy] = ringDeltas[i];
        const v = src[g + dy * rw + dx] >= 0.5;
        ring.push(v);
        if (i > 0) {
          if (v !== ring[i - 1]) {
            transitions++;
            arcRuns.push(run);
            run = 1;
          } else {
            run++;
          }
          if (v !== ring[0]) firstSameLast = false;
        }
      }
      if (ring[7] !== ring[0]) {
        transitions++;
        arcRuns.push(run);
      } else {
        // merge the wrap-around run into the first
        arcRuns[0] += run - 1;
      }
      const edgeLike = transitions === 2 && firstSameLast === false && Math.min(...arcRuns) >= 3;
      if (!edgeLike) {
        out[g] = src[g];
        continue;
      }
      // separable binomial (1,2,1)/2 per axis over the 3x3 window
      const wx = (src[g - 1] + 2 * src[g] + src[g + 1]) / 4;
      const wxN = (src[g - 1 - rw] + 2 * src[g - rw] + src[g + 1 - rw]) / 4;
      const wxS = (src[g - 1 + rw] + 2 * src[g + rw] + src[g + 1 + rw]) / 4;
      out[g] = (wxN + 2 * wx + wxS) / 4;
    }
  }
  return { data: out };
}

/**
 * Candidate "gaussian value-bilateral reconstruction" (soft): production
 * spatial box footprint with weight exp(-(dv)^2 / (2 sigma^2)) on the value
 * difference (plus the existing ownership/height gates). sigma ~ the
 * sampling noise scale: multi-level speckle jumps are downweighted but not
 * zeroed; full-range jumps (thin dark bands next to lit ground) are
 * effectively excluded.
 */
function bilateralReconPrototype(raw, fields, { radius, sigma }) {
  const raw_ = raw.data;
  const height = fields.height.data;
  const owner = fields.objectId.data;
  const out = new Float32Array(raw_.length);
  const heightGate = 0.5;
  const r = radius;
  const twoSigma2 = 2 * sigma * sigma;
  for (let ty = 0; ty < fields.rh; ty++) {
    for (let tx = 0; tx < fields.rw; tx++) {
      const g = ty * fields.rw + tx;
      const centerOwner = owner[g];
      const centerY = height[g];
      const centerVis = raw_[g];
      let sum = 0;
      let wsum = 0;
      for (let dy = -r; dy <= r; dy++) {
        const ny = ty + dy;
        if (ny < 0 || ny >= fields.rh) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = tx + dx;
          if (nx < 0 || nx >= fields.rw) continue;
          const ng = ny * fields.rw + nx;
          if (owner[ng] !== centerOwner) continue;
          const nh = height[ng];
          if (Math.abs(Math.fround(centerY - nh)) > heightGate) continue;
          const dv = raw_[ng] - centerVis;
          const w = Math.exp(-(dv * dv) / twoSigma2);
          sum += w * raw_[ng];
          wsum += w;
        }
      }
      const value = wsum > 0 ? sum / wsum : centerVis;
      out[g] = Math.min(1, Math.max(0, value));
    }
  }
  return { data: out };
}

/** Boundary texel fraction helper for the refined-field cost reporting. */
function refineAndMeasure(name, render, plan, dpr, fieldData, extra = {}) {
  const cutScaled = plan.cut ? scaleCut(plan.cut, dpr) : null;
  const metrics = cutScaled ? cutMetrics(fieldData, render.fields.rw, render.fields.rh, cutScaled) : null;
  return { name, metrics, ...extra };
}

// ---------------------------------------------------------------------------
// Run the matrix
// ---------------------------------------------------------------------------

const scenarioNames = onlyScenarios
  ? onlyScenarios.split(",")
  : Object.keys(SCENES);
const summary = { meta: { note: "#53 phase 1 shadow-edge evidence (CPU oracle, raw = bit-exact GPU)" }, cases: {} };

for (const scenarioName of scenarioNames) {
  const plan = SCENES[scenarioName]();
  const dprMatrix = { diagonal: [1, 1.5, 2, 3], diagonalTall: [1, 2], thin: [1, 2], glyph: [1, 2], rounded: [1, 2], near: [1], far: [1] }[scenarioName] ?? [1];
  const variantNames = scenarioName === "diagonal" || scenarioName === "diagonalTall" || scenarioName === "glyph"
    ? ["hard", "soft4", "soft8", "soft16"]
    : ["hard", "soft8"];
  for (const dpr of dprMatrix) {
    for (const variantName of variantNames) {
      const caseId = `${scenarioName}/${variantName}/dpr${dpr}`;
      const t0 = performance.now();
      const { fields, raw, reconstructed, presented } = renderCase(scenarioName, variantName, dpr);
      const cutScaled = plan.cut ? scaleCut(plan.cut, dpr) : null;
      const rawMetrics = cutScaled
        ? cutMetrics(raw.data, fields.rw, fields.rh, cutScaled)
        : null;
      const reconMetrics = reconstructed && cutScaled
        ? cutMetrics(reconstructed.data, fields.rw, fields.rh, cutScaled)
        : null;
      // presented alpha strength field (1 - vis of the FIELD the presentation
      // consumed) mirrored through the byte quantization
      const presentedField = new Float32Array(fields.rw * fields.rh);
      {
        const visData = (reconstructed ?? raw).data;
        for (let i = 0; i < presentedField.length; i++) {
          presentedField[i] = Math.min(1, Math.max(0, 1 - visData[i]));
        }
      }
      const presentedMetrics = cutScaled
        ? cutMetrics(presentedField, fields.rw, fields.rh, cutScaled)
        : null;
      const case_ = {
        dpr,
        renderExtent: [fields.rw, fields.rh],
        samples: VARIANTS[variantName].samples,
        angularRadius: VARIANTS[variantName].angularRadius,
        raw: rawMetrics,
        reconstructed: reconMetrics,
        presented: presentedMetrics,
        boundaryTexelFractionRaw: boundaryFraction(raw.data, fields.rw, fields.rh),
        ms: Math.round((performance.now() - t0) * 10) / 10,
      };
      // thin-feature preservation: min vis + area below 0.5 inside the strip
      if (plan.thinCheck?.kind === "strip" && cutScaled) {
        const field = reconstructed?.data ?? raw.data;
        let minVis = 1;
        let area = 0;
        let rawMinVis = 1;
        let rawArea = 0;
        for (let y = cutScaled.y0; y < cutScaled.y1; y++) {
          for (let x = 0; x < fields.rw; x++) {
            const v = field[y * fields.rw + x];
            const rv = raw.data[y * fields.rw + x];
            if (v < 0.98) {
              if (v < minVis) minVis = v;
              if (v < 0.5) area++;
            }
            if (rv < 0.98) {
              if (rv < rawMinVis) rawMinVis = rv;
              if (rv < 0.5) rawArea++;
            }
          }
        }
        case_.thin = { rawMinVis, rawAreaBelowHalf: rawArea, reconMinVis: reconstructed ? minVis : null, reconAreaBelowHalf: reconstructed ? area : null };
      }
      if (plan.thinCheck?.kind === "maskWhole") {
        const field = reconstructed?.data ?? raw.data;
        let minVis = 1;
        let area = 0;
        let rawMinVis = 1;
        let rawArea = 0;
        for (let i = 0; i < field.length; i++) {
          const v = field[i];
          const rv = raw.data[i];
          if (v < 0.98) {
            if (v < minVis) minVis = v;
            if (v < 0.5) area++;
          }
          if (rv < 0.98) {
            if (rv < rawMinVis) rawMinVis = rv;
            if (rv < 0.5) rawArea++;
          }
        }
        case_.thin = { rawMinVis, rawAreaBelowHalf: rawArea, reconMinVis: reconstructed ? minVis : null, reconAreaBelowHalf: reconstructed ? area : null };
      }
      // -- Phase 1 fix prototypes (measured before any production change) --
      // #53 final pass: the two adopted candidates are now the SHIPPED
      // implementation —the hard ring-rule refinement (kernel mode 1) and
      // the soft value-bilateral kernel (sigma 0.25, the production default
      // radius 2)— so those cases measure the real production functions via
      // the api. The rejected candidates (subtexel coverage supersampling,
      // value-gated reconstruction, ring-on-recon) stay as inline
      // prototypes for the evidence record.
      const softActive = VARIANTS[variantName].angularRadius > 0 && VARIANTS[variantName].samples > 1;
      if (!softActive) {
        // Candidate A == the #53 SHIPPED ring-rule binomial edge refinement
        // (kernel mode 1; borders keep raw, exact dyadic k/16).
        const ringRefined = api.refineHardEdgeVisibility(raw);
        const m = cutScaled ? cutMetrics(ringRefined.data, fields.rw, fields.rh, cutScaled) : null;
        case_.ringRule = { shipped: true, metrics: m };
        if (plan.thinCheck) {
          let minVis = 1;
          let area = 0;
          const scan = plan.thinCheck.kind === "strip" && cutScaled
            ? (fn) => { for (let y = cutScaled.y0; y < cutScaled.y1; y++) for (let x = 0; x < fields.rw; x++) fn(y * fields.rw + x); }
            : (fn) => { for (let i = 0; i < ringRefined.data.length; i++) fn(i); };
          scan((i) => {
            const v = ringRefined.data[i];
            if (v < 0.98) {
              if (v < minVis) minVis = v;
              if (v < 0.5) area++;
            }
          });
          case_.ringRule.thin = { minVis, areaBelowHalf: area };
        }
        writeFileSync(join(outDir, `${caseId.replaceAll("/", "-")}-ring.ppm`), grayscalePpm(ringRefined.data, fields.rw, fields.rh));
        // Candidate B: boundary-local subpixel coverage refinement (K
        // subtexel hard-ray tests at 3x3-non-uniform texels).
        for (const K of [4, 9]) {
          const refined = refineHardCoverage(raw, fields, structuredClone(plan.scene), plan.options, dpr, K);
          const m = cutScaled ? cutMetrics(refined.data, fields.rw, fields.rh, cutScaled) : null;
          case_["coverage" + K] = {
            metrics: m,
            refinedTexels: refined.refined,
            refinedFraction: round3(refined.refined / refined.texels),
          };
          if (plan.thinCheck?.kind === "strip" && cutScaled) {
            let minVis = 1;
            let area = 0;
            for (let y = cutScaled.y0; y < cutScaled.y1; y++) {
              for (let x = 0; x < fields.rw; x++) {
                const v = refined.data[y * fields.rw + x];
                if (v < 0.98) {
                  if (v < minVis) minVis = v;
                  if (v < 0.5) area++;
                }
              }
            }
            case_["coverage" + K].thin = { minVis, areaBelowHalf: area };
          }
          if (plan.thinCheck?.kind === "maskWhole") {
            let minVis = 1;
            let area = 0;
            for (let i = 0; i < refined.data.length; i++) {
              const v = refined.data[i];
              if (v < 0.98) {
                if (v < minVis) minVis = v;
                if (v < 0.5) area++;
              }
            }
            case_["coverage" + K].thin = { minVis, areaBelowHalf: area };
          }
          writeFileSync(join(outDir, `${caseId.replaceAll("/", "-")}-coverage${K}.ppm`), grayscalePpm(refined.data, fields.rw, fields.rh));
        }
      } else {
        // #53 BEFORE reference: the pre-#53 production kernel (the #43
        // gated box average —every gate-passing tap averaged with weight 1,
        // i.e. gate >= 1 disables the value gate), at the same production
        // radius, so the before/after comparison is apples-to-apples.
        const radiusTexels = (r) => Math.min(16, Math.round(r * dpr));
        const legacyBox = gatedReconPrototype(raw, fields, { radius: radiusTexels(2), gate: 1 });
        const mLegacy = cutScaled ? cutMetrics(legacyBox.data, fields.rw, fields.rh, cutScaled) : null;
        case_.legacyBoxRecon = { metrics: mLegacy };
        if (plan.thinCheck) {
          let minVis = 1;
          let area = 0;
          const scan = plan.thinCheck.kind === "strip" && cutScaled
            ? (fn) => { for (let y = cutScaled.y0; y < cutScaled.y1; y++) for (let x = 0; x < fields.rw; x++) fn(y * fields.rw + x); }
            : (fn) => { for (let i = 0; i < legacyBox.data.length; i++) fn(i); };
          scan((i) => {
            const v = legacyBox.data[i];
            if (v < 0.98) {
              if (v < minVis) minVis = v;
              if (v < 0.5) area++;
            }
          });
          case_.legacyBoxRecon.thin = { minVis, areaBelowHalf: area };
        }
        writeFileSync(join(outDir, `${caseId.replaceAll("/", "-")}-legacybox.ppm`), grayscalePpm(legacyBox.data, fields.rw, fields.rh));
        // Candidate: range-gated (value-bilateral) reconstruction REPLACING
        // the production box kernel (operates on the RAW field). gate = one
        // sample level (1/N); radiusTexels exactly as production derives
        // them (min(16, round(radiusSceneUnits * dpr))).
        const N = VARIANTS[variantName].samples;
        for (const [label, gate, radiusScene] of [["gated1", 1 / N, 2], ["gated2", 2 / N, 2], ["gated1r4", 1 / N, 4]]) {
          const gated = gatedReconPrototype(raw, fields, { radius: radiusTexels(radiusScene), gate });
          const m = cutScaled ? cutMetrics(gated.data, fields.rw, fields.rh, cutScaled) : null;
          case_[label] = { metrics: m };
          if (plan.thinCheck) {
            let minVis = 1;
            let area = 0;
            const scan = plan.thinCheck.kind === "strip" && cutScaled
              ? (fn) => { for (let y = cutScaled.y0; y < cutScaled.y1; y++) for (let x = 0; x < fields.rw; x++) fn(y * fields.rw + x); }
              : (fn) => { for (let i = 0; i < gated.data.length; i++) fn(i); };
            scan((i) => {
              const v = gated.data[i];
              if (v < 0.98) {
                if (v < minVis) minVis = v;
                if (v < 0.5) area++;
              }
            });
            case_[label].thin = { minVis, areaBelowHalf: area };
          }
          if (label === "gated1") {
            writeFileSync(join(outDir, `${caseId.replaceAll("/", "-")}-gated1.ppm`), grayscalePpm(gated.data, fields.rw, fields.rh));
          }
        }
        // Candidate: gaussian value-bilateral (sigma in visibility units) at
        // the production radius, plus the ring-rule refinement on TOP of the
        // production box reconstruction (contour cleanup after smoothing).
        // #53: sigma 0.25 == the SHIPPED kernel; the shipped result is the
        // `reconstructed` field measured above (renderCase), so the bil25
        // prototype doubles as a cross-check of the api round-trip.
        for (const [label, sigma] of [["bil25", 0.25], ["bil35", 0.35]]) {
          const bil = bilateralReconPrototype(raw, fields, { radius: radiusTexels(2), sigma });
          const m = cutScaled ? cutMetrics(bil.data, fields.rw, fields.rh, cutScaled) : null;
          case_[label] = { metrics: m };
          if (plan.thinCheck) {
            let minVis = 1;
            let area = 0;
            const scan = plan.thinCheck.kind === "strip" && cutScaled
              ? (fn) => { for (let y = cutScaled.y0; y < cutScaled.y1; y++) for (let x = 0; x < fields.rw; x++) fn(y * fields.rw + x); }
              : (fn) => { for (let i = 0; i < bil.data.length; i++) fn(i); };
            scan((i) => {
              const v = bil.data[i];
              if (v < 0.98) {
                if (v < minVis) minVis = v;
                if (v < 0.5) area++;
              }
            });
            case_[label].thin = { minVis, areaBelowHalf: area };
          }
          if (label === "bil35") {
            writeFileSync(join(outDir, `${caseId.replaceAll("/", "-")}-bil35.ppm`), grayscalePpm(bil.data, fields.rw, fields.rh));
          }
        }
        // The ring-rule refinement applied on TOP of the production box:
        const ringOnRecon = ringRuleRefine(reconstructed, fields);
        const mrr = cutScaled ? cutMetrics(ringOnRecon.data, fields.rw, fields.rh, cutScaled) : null;
        case_.ringOnRecon = { metrics: mrr };
        if (plan.thinCheck) {
          let minVis = 1;
          let area = 0;
          const scan = plan.thinCheck.kind === "strip" && cutScaled
            ? (fn) => { for (let y = cutScaled.y0; y < cutScaled.y1; y++) for (let x = 0; x < fields.rw; x++) fn(y * fields.rw + x); }
            : (fn) => { for (let i = 0; i < ringOnRecon.data.length; i++) fn(i); };
          scan((i) => {
            const v = ringOnRecon.data[i];
            if (v < 0.98) {
              if (v < minVis) minVis = v;
              if (v < 0.5) area++;
            }
          });
          case_.ringOnRecon.thin = { minVis, areaBelowHalf: area };
        }
        writeFileSync(join(outDir, `${caseId.replaceAll("/", "-")}-ringrecon.ppm`), grayscalePpm(ringOnRecon.data, fields.rw, fields.rh));
      }
      summary.cases[caseId] = case_;
      // artifacts
      const base = join(outDir, caseId.replaceAll("/", "-"));
      writeFileSync(`${base}-raw.ppm`, grayscalePpm(raw.data, fields.rw, fields.rh));
      if (reconstructed) {
        writeFileSync(`${base}-recon.ppm`, grayscalePpm(reconstructed.data, fields.rw, fields.rh));
      }
      writeFileSync(`${base}-presented.ppm`, toPpm({ width: fields.rw, height: fields.rh, data: presented }));
      // diagonal crossing CSV (raw vs recon)
      if (plan.cut && plan.cut.diag !== undefined) {
        const lines = ["y,crossingRaw,crossingRecon"];
        for (let y = cutScaled.y0; y < cutScaled.y1; y++) {
          lines.push(`${y},${crossingAt(raw.data, fields.rw, y, cutScaled)},${reconstructed ? crossingAt(reconstructed.data, fields.rw, y, cutScaled) : ""}`);
        }
        writeFileSync(`${base}-crossings.csv`, lines.join("\n"));
      }
      console.log(`${caseId}: raw ${case_.raw ? `x${case_.raw.crossings} zig ${case_.raw.zigzagMaxTexels}/${case_.raw.zigzagRmsTexels} tx, w ${case_.raw.transitionTexelsMean}, ${case_.raw.levels} lv` : "-"}${reconstructed && reconMetrics ? ` | recon x${reconMetrics.crossings} zig ${reconMetrics.zigzagMaxTexels}/${reconMetrics.zigzagRmsTexels}, w ${reconMetrics.transitionTexelsMean}, ${reconMetrics.levels} lv` : ""} | boundary ${case_.boundaryTexelFractionRaw} | ${case_.ms}ms`);
    }
  }
}

function crossingAt(data, rw, y, cut) {
  const lineX = cut.diag !== undefined ? y + cut.diag : null;
  for (let x = 1; x < rw; x++) {
    const a = data[y * rw + x - 1];
    const b = data[y * rw + x];
    if ((a - 0.5) * (b - 0.5) < 0) {
      const c = x - 1 + (0.5 - a) / (b - a);
      if (lineX !== null ? Math.abs(c - lineX) <= cut.window : c >= cut.windowX0 && c <= cut.windowX1) {
        return c.toFixed(3);
      }
    }
  }
  return "";
}

writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`\nartifacts: ${outDir}`);
