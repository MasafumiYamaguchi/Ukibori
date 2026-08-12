// #25/#26 real-GPU parity harness.
//
// Runs the PUBLIC bundled renderer ESM on a real WebGPU adapter:
//
//   1. requests a real adapter/device (SKIP when unavailable)
//   2. captures shader compilation messages (ANY type FAILs the run) and
//      device validation errors
//   3. for every integrated fixture: `encodeScene` -> `SceneUploader.upload`
//      -> `HeightPass.dispatch` (the real compute pipeline) ->
//      `NormalPass.dispatch` (the #26 normal stage consuming the #25 height
//      output DIRECTLY), then TEST-ONLY staging copies + readback of the
//      four height outputs AND the normal field
//   4. compares height / coverage / objectId / materialId against small
//      CPU-oracle fixtures computed from the semantic CPU geometry
//      (`surfaceHeight`): IDs and coverage must match EXACTLY; height is
//      compared with an explicit tight f32 tolerance (justified below)
//   5. compares the GPU normal field against the ACTUAL TypeScript
//      `computeNormals` oracle (the #15/#16 semantic oracle and CPU
//      fallback) fed with the CPU reference height at the same render
//      extent and the same effective (sanitized, f32-rounded) options;
//      every component must be finite, every vector unit length, and every
//      component within the explicit tolerance
//   6. also runs a small synthetic GPU-resident height input (x ramp /
//      diagonal slope / plateau / wrap-guard / flat) through the normal
//      pass to pin replicate-clamp borders and sign conventions, and one
//      fixture with two custom option sets proving the normal output
//      changes while the source height bytes remain EXACTLY unchanged in
//      the test-only readback
//   7. #26 extreme-normal fixtures prove the overflow-safe shader
//      normalization: a largest-finite-f32 height difference times a
//      largest-finite-f32 scale (the f32 product overflows to infinity in
//      the old naive form) and normalScale values at/below the minimum
//      positive subnormal, all compared against the f64 oracle with the
//      same effective (sanitized, f32-rounded) options
//   8. writes ONE unambiguous marker as the first line of the result block:
//      UKIBORI_WEBGPU_PASS / UKIBORI_WEBGPU_FAIL / UKIBORI_WEBGPU_SKIP
//
// The runner (scripts/test-webgpu.mjs) serves only this page, the copied
// bundle and this module on 127.0.0.1 and parses the marker from the DOM.
//
// ## Height tolerance justification (explicit, tight)
//
// Every scene scalar is f32-rounded by the encoder; the oracle composes in
// f64 and rounds only the final height with `Math.fround`, while the GPU
// composes entirely in f32. Each WGSL f32 op rounds to <= 0.5 ulp, and
// f32 epsilon is ~1.19e-7. The SDF -> profile -> height chain is ~10 f32
// ops (<= ~1e-6 absolute for heights <= 100); the mask path adds a bilinear
// sample (<= ~2 ulp) and one f32 scale (1 ulp). The worst case is therefore
// ~1e-5 absolute; 1e-4 is the tight explicit bound with >10x margin. It is
// NOT a loose "anything close enough" tolerance: 1e-4 rejects any real
// divergence (the SDF/bevel values differ by 1e-5 at most).
//
// ## Normal tolerance justification (explicit, tight)
//
// Both the GPU and the oracle consume f32 height values. The oracle's dx/dy
// are exact f64 differences of f32 values, while the GPU computes them in
// f32: one subtract rounds to <= 0.5 ulp (<= ~1e-6 for heights <= 100; the
// fixtures cap height differences at a few units). The scale multiply,
// max-component-first normalization and final divide add ~4 more f32
// roundings (<= ~1e-6 each on unit-size components; extreme custom scales
// still keep components O(1) after the overflow-safe scaling). The output
// is additionally quantized to f32 (<= 1.19e-7). The worst-case component
// error is therefore ~1e-5; 1e-4 is the tight explicit bound with >10x
// margin and the measured maximum is always reported. A length error bound
// of 1e-4 keeps the "unit normal" requirement measurable in f32 arithmetic.
//
// ## Fixture safety
//
// All surfaces use integer positions/sizes and f32-exact elevations and
// thicknesses, and mask fixtures keep texel centers >= 0.2 mask-pixels away
// from any silhouette boundary, so no texel sits on an SDF zero crossing
// (coverage is decided by sign and never by rounding luck). Every option
// value used in fixtures is exactly representable in f32 (0.5, 0.75, 1,
// 0.25, 2, 3, F32_MAX, -F32_MAX, the minimum positive subnormal, etc.), so
// the sanitized effective options equal the raw ones and CPU/GPU parity is
// well-defined; the sole exception is `5e-324`, which rounds to f32 zero
// and exercises the documented fround-based fallback to normalScale = 1.

const RESULT_EL = document.getElementById("result");
const MARKER_PASS = "UKIBORI_WEBGPU_PASS";
const MARKER_FAIL = "UKIBORI_WEBGPU_FAIL";
const MARKER_SKIP = "UKIBORI_WEBGPU_SKIP";
const HEIGHT_TOLERANCE = 1e-4;
const NORMAL_TOLERANCE = 1e-4;
const LENGTH_TOLERANCE = 1e-4;
// largest finite f32 and the minimum positive subnormal (both f32-exact in
// JS); used by the #26 extreme-normal fixtures
const F32_MAX = 3.4028234663852886e38;
const MIN_POSITIVE_SUBNORMAL = 1.401298464324817e-45;

const {
  createScene,
  encodeScene,
  SceneUploader,
  HeightPass,
  NormalPass,
  normalHeightBindingFromHeightPass,
  sanitizeNormalOptions,
  computeNormals,
  HostBuffer,
  HEIGHT_SPEC,
  NO_OWNER,
  surfaceHeight,
  MASK_SDF_WGSL,
  COMPOSE_HEIGHT_WGSL,
  COMPOSE_COVERAGE_WGSL,
  COMPOSE_OBJECT_ID_WGSL,
  COMPOSE_MATERIAL_ID_WGSL,
  NORMAL_PASS_WGSL,
} = await import("./index.js");

const detail = [];

function finish(marker, summary) {
  RESULT_EL.textContent = [marker + " " + summary, ...detail].join("\n");
}

// ---------------------------------------------------------------------------
// Test-only staging readback (production code never maps or reads back)
// ---------------------------------------------------------------------------

async function readback(device, buffer, byteLength) {
  const staging = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    label: "ukibori-test-staging",
  });
  try {
    const encoder = device.createCommandEncoder({ label: "ukibori-test-readback" });
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = new Uint8Array(staging.getMappedRange().slice()); // detach before unmap
    staging.unmap();
    return copy;
  } finally {
    staging.destroy();
  }
}

async function readbackF32(device, buffer, byteLength) {
  const bytes = await readback(device, buffer, byteLength);
  return new Float32Array(bytes.buffer, bytes.byteOffset, byteLength / 4);
}

async function readbackU32(device, buffer, byteLength) {
  const bytes = await readback(device, buffer, byteLength);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, byteLength / 4);
}

// ---------------------------------------------------------------------------
// CPU oracle: the semantic reference (mirrors composeHeightField exactly,
// sampling render texels at ((tx + 0.5) / dpr, (ty + 0.5) / dpr))
// ---------------------------------------------------------------------------

function cpuOracle(scene, dpr) {
  const dprF = Math.fround(dpr);
  const rw = Math.max(1, Math.floor(scene.width * dprF));
  const rh = Math.max(1, Math.floor(scene.height * dprF));
  const materialIndex = new Map();
  for (let i = 0; i < scene.surfaces.length; i++) {
    const material = scene.surfaces[i].material;
    if (!materialIndex.has(material)) {
      materialIndex.set(material, materialIndex.size);
    }
  }
  const height = new Float32Array(rw * rh);
  const coverage = new Uint32Array(rw * rh);
  const objectId = new Uint32Array(rw * rh).fill(NO_OWNER);
  const materialId = new Uint32Array(rw * rh).fill(NO_OWNER);
  for (let ty = 0; ty < rh; ty++) {
    for (let tx = 0; tx < rw; tx++) {
      const sx = (tx + 0.5) / dprF;
      const sy = (ty + 0.5) / dprF;
      let best = 0;
      let owner = NO_OWNER;
      for (let i = 0; i < scene.surfaces.length; i++) {
        const h = Math.fround(surfaceHeight(scene.surfaces[i], sx, sy));
        if (Number.isFinite(h) && h >= 0 && (h > best || h === best)) {
          best = h;
          owner = i;
        }
      }
      if (owner !== NO_OWNER) {
        const g = ty * rw + tx;
        height[g] = best;
        coverage[g] = 1;
        objectId[g] = owner;
        materialId[g] = materialIndex.get(scene.surfaces[owner].material);
      }
    }
  }
  return { rw, rh, height, coverage, objectId, materialId };
}

/**
 * #26 CPU normal oracle: the actual TypeScript `computeNormals` (the
 * semantic oracle and CPU fallback) fed with the CPU reference height field
 * at the same render extent and the same effective options the GPU ran
 * (sanitized + f32-rounded through `sanitizeNormalOptions`).
 */
function normalOracle(height, rw, rh, effectiveOptions) {
  const hb = new HostBuffer(HEIGHT_SPEC(rw, rh));
  for (let g = 0; g < height.length; g++) {
    hb.set(g % rw, Math.floor(g / rw), 0, height[g]);
  }
  const normal = computeNormals(hb, effectiveOptions);
  const out = new Float32Array(rw * rh * 3);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const o = (y * rw + x) * 3;
      out[o] = normal.get(x, y, 0);
      out[o + 1] = normal.get(x, y, 1);
      out[o + 2] = normal.get(x, y, 2);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compareFixture(name, oracle, gpu) {
  const texels = oracle.rw * oracle.rh;
  let mismatches = 0;
  const samples = [];
  for (let g = 0; g < texels; g++) {
    const covBad = gpu.coverage[g] !== oracle.coverage[g];
    const objBad = gpu.objectId[g] !== oracle.objectId[g];
    const matBad = gpu.materialId[g] !== oracle.materialId[g];
    const dh = Math.abs(gpu.height[g] - oracle.height[g]);
    const heightBad = !(dh <= HEIGHT_TOLERANCE);
    if (covBad || objBad || matBad || heightBad) {
      mismatches += 1;
      if (samples.length < 8) {
        const tx = g % oracle.rw;
        const ty = Math.floor(g / oracle.rw);
        samples.push(
          `texel(${tx},${ty}): coverage ${gpu.coverage[g]} != ${oracle.coverage[g]}; ` +
            `objectId ${gpu.objectId[g]} != ${oracle.objectId[g]}; ` +
            `materialId ${gpu.materialId[g]} != ${oracle.materialId[g]}; ` +
            `height ${gpu.height[g]} != ${oracle.height[g]} (dh ${dh.toExponential(3)})`,
        );
      }
    }
  }
  return { name, texels, mismatches, samples };
}

/**
 * #26 normal comparison: all xyz components, finite values, unit-length
 * vectors, and the explicit component tolerance. Reports the measured
 * maximum component and length errors (always surfaced in the summary).
 */
function compareNormals(name, oracle, gpu, width) {
  const texels = oracle.length / 3;
  let mismatches = 0;
  const samples = [];
  let maxComponentError = 0;
  let maxLengthError = 0;
  for (let g = 0; g < texels; g++) {
    const i = g * 3;
    const x = gpu[i];
    const y = gpu[i + 1];
    const z = gpu[i + 2];
    const length = Math.hypot(x, y, z);
    const lengthError = Math.abs(length - 1);
    maxLengthError = Math.max(maxLengthError, lengthError);
    const ex = Math.abs(x - oracle[i]);
    const ey = Math.abs(y - oracle[i + 1]);
    const ez = Math.abs(z - oracle[i + 2]);
    const componentError = Math.max(ex, ey, ez);
    maxComponentError = Math.max(maxComponentError, componentError);
    const finite = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
    if (!finite || lengthError > LENGTH_TOLERANCE || componentError > NORMAL_TOLERANCE) {
      mismatches += 1;
      if (samples.length < 8) {
        const tx = g % width;
        const ty = Math.floor(g / width);
        samples.push(
          `normal texel(${tx},${ty}): gpu (${x.toExponential(3)},${y.toExponential(3)},${z.toExponential(3)}) ` +
            `oracle (${oracle[i].toExponential(3)},${oracle[i + 1].toExponential(3)},${oracle[i + 2].toExponential(3)}) ` +
            `len ${length.toExponential(3)}${finite ? "" : " (non-finite)"}`,
        );
      }
    }
  }
  return { mismatches, samples, maxComponentError, maxLengthError };
}

function bytesEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Small synthetic f32-exact GPU-resident height field for normal fixtures. */
function synthHeight(width, height, fn) {
  const field = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      field[y * width + x] = Math.fround(fn(x, y));
    }
  }
  return field;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function flatScene() {
  return createScene({
    width: 100,
    height: 80,
    surfaces: [
      {
        id: "flat",
        position: { x: 10, y: 20 },
        size: { x: 60, y: 40 },
        elevation: 2,
        thickness: 3,
        shape: { kind: "roundedRect", radius: 8 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: false,
      },
    ],
  });
}

function bevelScene() {
  return createScene({
    width: 100,
    height: 80,
    surfaces: [
      {
        id: "bevel",
        position: { x: 20, y: 10 },
        size: { x: 50, y: 30 },
        elevation: 1,
        thickness: 5,
        bevelWidth: 4,
        shape: { kind: "roundedRect", radius: 12 },
        profile: { kind: "bevel" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: false,
      },
    ],
  });
}

function emptyScene() {
  return createScene({ width: 64, height: 48, surfaces: [] });
}

function zeroHeightScene() {
  return createScene({
    width: 40,
    height: 40,
    surfaces: [
      {
        id: "zero",
        position: { x: 5, y: 5 },
        size: { x: 20, y: 20 },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: false,
      },
    ],
  });
}

function tieScene() {
  // a and b are identical flat rects (exact height ties -> later b wins);
  // c sits higher and wins where it overlaps either.
  const flat = (id, position, size) => ({
    id,
    position,
    size,
    elevation: 1,
    thickness: 2,
    shape: { kind: "roundedRect", radius: 0 },
    profile: { kind: "flat" },
    material: "silicone",
    castsShadow: false,
    receivesShadow: false,
  });
  return createScene({
    width: 60,
    height: 60,
    surfaces: [
      flat("a", { x: 5, y: 5 }, { x: 30, y: 30 }),
      flat("b", { x: 15, y: 15 }, { x: 30, y: 30 }),
      {
        ...flat("c", { x: 10, y: 10 }, { x: 15, y: 15 }),
        elevation: 5,
        thickness: 1,
        material: "metal",
      },
    ],
  });
}

function clipScene() {
  return createScene({
    width: 50,
    height: 40,
    surfaces: [
      {
        id: "clipped",
        position: { x: -10, y: -5 },
        size: { x: 30, y: 20 },
        elevation: 2,
        thickness: 2,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: false,
      },
      {
        id: "offscreen",
        position: { x: 200, y: 200 },
        size: { x: 10, y: 10 },
        elevation: 9,
        thickness: 9,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: false,
      },
    ],
  });
}

function fracScene() {
  // 13x9 logical scene: dpr 1.5 -> 19x13 and dpr 2 -> 26x18 (fractional
  // floor render extents), dpr 1 -> 13x9.
  return createScene({
    width: 13,
    height: 9,
    surfaces: [
      {
        id: "frac",
        position: { x: 2, y: 1 },
        size: { x: 8, y: 6 },
        elevation: 1,
        thickness: 2,
        shape: { kind: "roundedRect", radius: 2 },
        profile: { kind: "flat" },
        material: "silicone",
        castsShadow: false,
        receivesShadow: false,
      },
    ],
  });
}

function maskSurface(id, mask, position, size, elevation, thickness) {
  return {
    id,
    position,
    size,
    elevation,
    thickness,
    shape: { kind: "mask", mask },
    profile: { kind: "flat" },
    material: "silicone",
    castsShadow: false,
    receivesShadow: false,
  };
}

function maskScene(mask, label) {
  // 4x4 mask mapped isotropically onto an 8x8 surface; texel centers stay
  // >= 0.2 mask-pixels away from every silhouette boundary.
  return createScene({
    width: 16,
    height: 16,
    surfaces: [
      maskSurface(label, mask, { x: 2, y: 2 }, { x: 8, y: 8 }, 0, 3),
    ],
  });
}

function multiMaskScene() {
  const f32Edge = new Float32Array([
    0.75, 0.5, 0.75, 0.75,
    0.75, 0, 0, 0,
    0.75, 0, 0, 0,
    0.75, 0, 0, 0,
  ]);
  const u8Full = new Uint8Array(9).fill(255);
  return createScene({
    width: 20,
    height: 20,
    surfaces: [
      maskSurface("mm-f32", { width: 4, height: 4, alpha: f32Edge }, { x: 2, y: 2 }, { x: 8, y: 8 }, 0, 2),
      maskSurface("mm-u8", { width: 3, height: 3, alpha: u8Full }, { x: 10, y: 6 }, { x: 6, y: 6 }, 1, 2),
    ],
  });
}

/** DPR 1/1.5/2 with explicit scene-unit sampling scales (scale = 0.5 * dpr). */
const DPR_NORMAL_OPTIONS = {
  1: { scaleX: 0.5, scaleY: 0.5, normalScale: 1 },
  1.5: { scaleX: 0.75, scaleY: 0.75, normalScale: 1 },
  2: { scaleX: 1, scaleY: 1, normalScale: 1 },
};

const FIXTURES = [
  { name: "rounded-flat-dpr1", scene: flatScene(), dpr: 1 },
  { name: "rounded-bevel-dpr1", scene: bevelScene(), dpr: 1 },
  { name: "background-only-dpr1", scene: emptyScene(), dpr: 1 },
  { name: "zero-height-ownership-dpr1", scene: zeroHeightScene(), dpr: 1 },
  { name: "overlap-exact-ties-dpr1", scene: tieScene(), dpr: 1 },
  { name: "clipping-offscreen-dpr1", scene: clipScene(), dpr: 1 },
  {
    name: "dpr1-fractional-floor",
    scene: fracScene(),
    dpr: 1,
    normalOptions: DPR_NORMAL_OPTIONS[1],
  },
  {
    name: "dpr1.5-fractional-floor",
    scene: fracScene(),
    dpr: 1.5,
    normalOptions: DPR_NORMAL_OPTIONS[1.5],
  },
  {
    name: "dpr2-fractional-floor",
    scene: fracScene(),
    dpr: 2,
    normalOptions: DPR_NORMAL_OPTIONS[2],
  },
  {
    name: "mask-f32-empty",
    scene: maskScene({ width: 4, height: 4, alpha: new Float32Array(16) }, "m-f32-empty"),
    dpr: 1,
  },
  {
    name: "mask-f32-full",
    scene: maskScene({ width: 4, height: 4, alpha: new Float32Array(16).fill(1) }, "m-f32-full"),
    dpr: 1,
  },
  {
    name: "mask-f32-edge",
    scene: maskScene(
      {
        width: 4,
        height: 4,
        alpha: new Float32Array([
          0.75, 0.5, 0.75, 0.75,
          0.75, 0, 0, 0,
          0.75, 0, 0, 0,
          0.75, 0, 0, 0,
        ]),
      },
      "m-f32-edge",
    ),
    dpr: 1,
  },
  {
    name: "mask-u8-empty",
    scene: maskScene({ width: 4, height: 4, alpha: new Uint8Array(16) }, "m-u8-empty"),
    dpr: 1,
  },
  {
    name: "mask-u8-full",
    scene: maskScene({ width: 4, height: 4, alpha: new Uint8Array(16).fill(255) }, "m-u8-full"),
    dpr: 1,
  },
  {
    name: "mask-u8-edge",
    scene: maskScene(
      {
        width: 4,
        height: 4,
        alpha: new Uint8Array([
          255, 128, 255, 255,
          255, 0, 0, 0,
          255, 0, 0, 0,
          255, 0, 0, 0,
        ]),
      },
      "m-u8-edge",
    ),
    dpr: 1,
  },
  { name: "multi-mask-f32-u8", scene: multiMaskScene(), dpr: 1 },
  // #26 synthetic GPU-resident height inputs (f32-exact, no #25 scene):
  // flat +Z, x ramp/sign + replicate-clamp outer borders, diagonal slope,
  // plateau edges in both directions, and a wrap-guard ramp whose border
  // texels would diverge if the shader wrapped instead of clamping.
  {
    name: "synth-flat-constant",
    synthetic: true,
    width: 16,
    height: 12,
    field: synthHeight(16, 12, () => 0),
  },
  {
    name: "synth-x-ramp-sign",
    synthetic: true,
    width: 9,
    height: 5,
    field: synthHeight(9, 5, (x) => 0.25 * x),
  },
  {
    name: "synth-diagonal-slope",
    synthetic: true,
    width: 8,
    height: 8,
    field: synthHeight(8, 8, (x, y) => 0.25 * (x + y)),
  },
  {
    name: "synth-plateau-edges",
    synthetic: true,
    width: 12,
    height: 12,
    field: synthHeight(12, 12, (x, y) => (x >= 2 && x <= 9 && y >= 2 && y <= 9 ? 3 : 0)),
  },
  {
    name: "synth-wrap-guard",
    synthetic: true,
    width: 7,
    height: 4,
    field: synthHeight(7, 4, (x) => 0.25 * x),
  },
  // #26 two custom option sets on one unchanged height field: the normal
  // output must change while the source height bytes stay EXACTLY the same
  // in the test-only readback.
  {
    name: "synth-options-change",
    optionChange: true,
    width: 9,
    height: 5,
    field: synthHeight(9, 5, (x) => 0.25 * x),
    optionSets: [
      { scaleX: 2, scaleY: 0.25, normalScale: 0.5 },
      { scaleX: -1, scaleY: -1, normalScale: 3 },
    ],
  },
  // #26 extreme-normal fixtures: the f32 height differences here are the
  // largest FINITE f32 values (F32_MAX, exact), so `dx * scaleX` with a
  // largest-finite-f32 scale overflows to infinity in naive f32 — the
  // exponent-aligned normalization must still match the f64 oracle.
  {
    name: "synth-extreme-f32-diff-scale",
    synthetic: true,
    width: 3,
    height: 1,
    field: synthHeight(3, 1, (x) => (x === 2 ? 0 : F32_MAX)),
    normalOptions: { scaleX: F32_MAX, scaleY: F32_MAX, normalScale: 1 },
  },
  {
    name: "synth-extreme-diagonal-signs",
    synthetic: true,
    width: 4,
    height: 4,
    field: synthHeight(4, 4, (x, y) => (x >= 2 && y >= 2 ? F32_MAX / 2 : 0)),
    normalOptions: { scaleX: F32_MAX, scaleY: -F32_MAX, normalScale: 1 },
  },
  {
    name: "synth-extreme-x-scale-small-heights",
    synthetic: true,
    width: 9,
    height: 5,
    field: synthHeight(9, 5, (x) => 0.25 * x),
    normalOptions: { scaleX: F32_MAX, scaleY: F32_MAX, normalScale: 1 },
  },
  {
    name: "synth-extreme-normal-scale-small-heights",
    synthetic: true,
    width: 9,
    height: 5,
    field: synthHeight(9, 5, (x) => 0.25 * x),
    normalOptions: { scaleX: 0.5, scaleY: 0.5, normalScale: F32_MAX },
  },
  // #26 subnormal normalScale: below the minimum positive subnormal the
  // host sanitizer's fround-based fallback forces 1 (5e-324 -> f32 0), while
  // the minimum positive subnormal itself is kept and must survive the
  // exponent-aligned normalization on the GPU without a subnormal
  // reciprocal.
  {
    name: "synth-normal-scale-below-min-subnormal",
    synthetic: true,
    width: 9,
    height: 5,
    field: synthHeight(9, 5, (x) => 0.25 * x),
    normalOptions: { scaleX: 2, scaleY: 0.5, normalScale: 5e-324 },
  },
  {
    name: "synth-normal-scale-min-subnormal",
    synthetic: true,
    width: 9,
    height: 5,
    field: synthHeight(9, 5, (x) => 0.25 * x),
    normalOptions: { scaleX: 0.5, scaleY: 0.5, normalScale: MIN_POSITIVE_SUBNORMAL },
  },
  {
    name: "synth-normal-scale-min-subnormal-flat",
    synthetic: true,
    width: 8,
    height: 6,
    field: synthHeight(8, 6, () => 0),
    normalOptions: { normalScale: MIN_POSITIVE_SUBNORMAL },
  },
];

// ---------------------------------------------------------------------------
// Fixture runner
// ---------------------------------------------------------------------------

async function runFixture(device, fixture) {
  let uploader = null;
  let pass = null;
  let normalPass = null;
  let synthHeightBuffer = null;
  let result = null;
  let failure = null;
  device.pushErrorScope("validation");
  try {
    if (fixture.synthetic) {
      // #26 synthetic GPU-resident height input: upload the f32 field into
      // a STORAGE|COPY_SRC|COPY_DST buffer and run the normal pass directly
      // (a small synthetic input is acceptable in addition to the
      // integrated #25 scenes).
      const { width, height: rh, field } = fixture;
      const byteLength = field.length * 4;
      synthHeightBuffer = device.createBuffer({
        size: Math.max(byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        label: "ukibori-test-synth-height",
      });
      device.queue.writeBuffer(
        synthHeightBuffer,
        0,
        new Uint8Array(field.buffer, field.byteOffset, byteLength),
      );
      normalPass = new NormalPass(device);
      normalPass.dispatch({
        height: {
          buffer: synthHeightBuffer,
          byteLength,
          format: "f32",
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          width,
          height: rh,
        },
        options: fixture.normalOptions,
      });
      const normal = await readbackF32(
        device,
        normalPass.getSnapshot().output.buffer,
        normalPass.getSnapshot().output.byteLength,
      );
      result = {
        name: fixture.name,
        texels: width * rh,
        mismatches: 0,
        samples: [],
        normalTexels: width * rh,
        normal: compareNormals(
          fixture.name,
          normalOracle(field, width, rh, sanitizeNormalOptions(fixture.normalOptions)),
          normal,
          width,
        ),
      };
    } else if (fixture.optionChange) {
      // #26 two custom option sets: proves the normal output changes while
      // the source height bytes remain EXACTLY unchanged in the test-only
      // readback, and that option updates reuse the same allocations.
      const { width, height: rh, field, optionSets } = fixture;
      const byteLength = field.length * 4;
      synthHeightBuffer = device.createBuffer({
        size: Math.max(byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        label: "ukibori-test-synth-height",
      });
      device.queue.writeBuffer(
        synthHeightBuffer,
        0,
        new Uint8Array(field.buffer, field.byteOffset, byteLength),
      );
      const initialHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      normalPass = new NormalPass(device);
      const input = {
        height: {
          buffer: synthHeightBuffer,
          byteLength,
          format: "f32",
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          width,
          height: rh,
        },
      };
      normalPass.dispatch({ ...input, options: optionSets[0] });
      const firstHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      const firstNormal = await readbackF32(
        device,
        normalPass.getSnapshot().output.buffer,
        normalPass.getSnapshot().output.byteLength,
      );
      normalPass.dispatch({ ...input, options: optionSets[1] });
      const secondHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      const secondNormal = await readbackF32(
        device,
        normalPass.getSnapshot().output.buffer,
        normalPass.getSnapshot().output.byteLength,
      );
      const a = compareNormals(
        fixture.name + "/a",
        normalOracle(field, width, rh, sanitizeNormalOptions(optionSets[0])),
        firstNormal,
        width,
      );
      const b = compareNormals(
        fixture.name + "/b",
        normalOracle(field, width, rh, sanitizeNormalOptions(optionSets[1])),
        secondNormal,
        width,
      );
      let extraMismatches = 0;
      const extraSamples = [];
      if (
        !bytesEqual(initialHeightBytes, firstHeightBytes) ||
        !bytesEqual(initialHeightBytes, secondHeightBytes)
      ) {
        extraMismatches += 1;
        extraSamples.push("  source height bytes changed during a normal dispatch");
      }
      let outputChanged = false;
      for (let i = 0; i < firstNormal.length; i++) {
        if (Math.abs(firstNormal[i] - secondNormal[i]) > NORMAL_TOLERANCE) {
          outputChanged = true;
          break;
        }
      }
      if (!outputChanged) {
        extraMismatches += 1;
        extraSamples.push("  normal output did not change between option sets");
      }
      result = {
        name: fixture.name,
        texels: width * rh,
        mismatches: 0,
        samples: [],
        normalTexels: width * rh * 2,
        normal: {
          mismatches: a.mismatches + b.mismatches + extraMismatches,
          samples: [...a.samples, ...b.samples, ...extraSamples],
          maxComponentError: Math.max(a.maxComponentError, b.maxComponentError),
          maxLengthError: Math.max(a.maxLengthError, b.maxLengthError),
        },
      };
    } else {
      const encoded = encodeScene(fixture.scene, fixture.dpr);
      uploader = new SceneUploader(device);
      pass = new HeightPass(device);
      uploader.upload(encoded);
      const bindings = uploader.getBindings();
      pass.dispatch(encoded, bindings);
      const outputs = pass.getOutputs();
      const snapshot = pass.getSnapshot();
      const [height, coverage, objectId, materialId] = await Promise.all([
        readbackF32(device, outputs.height.buffer, outputs.height.byteLength),
        readbackU32(device, outputs.coverage.buffer, outputs.coverage.byteLength),
        readbackU32(device, outputs.objectId.buffer, outputs.objectId.byteLength),
        readbackU32(device, outputs.materialId.buffer, outputs.materialId.byteLength),
      ]);
      const oracle = cpuOracle(fixture.scene, fixture.dpr);
      result = compareFixture(fixture.name, oracle, { height, coverage, objectId, materialId });

      // #26 normal stage: consume the #25 height output DIRECTLY through the
      // public helper and compare against the actual TypeScript oracle fed
      // with the CPU reference height and the same effective options.
      normalPass = new NormalPass(device);
      normalPass.dispatch({
        height: normalHeightBindingFromHeightPass(snapshot),
        options: fixture.normalOptions,
      });
      const normalBytes = await readback(
        device,
        normalPass.getSnapshot().output.buffer,
        normalPass.getSnapshot().output.byteLength,
      );
      const normal = new Float32Array(normalBytes.buffer, normalBytes.byteOffset, normalBytes.byteLength / 4);
      result.normalTexels = oracle.rw * oracle.rh;
      result.normal = compareNormals(
        fixture.name,
        normalOracle(oracle.height, oracle.rw, oracle.rh, sanitizeNormalOptions(fixture.normalOptions)),
        normal,
        oracle.rw,
      );

      // Raw GPU probes for the first fixture only: the uploaded scene header
      // (proves the queue.writeBuffer path), the objectId field (proves the
      // shader actually wrote NO_OWNER into background texels) and the
      // normal field (proves the normal stage wrote its packed triples).
      if (fixture.probe) {
        const header = await readbackU32(device, bindings.header.buffer, bindings.header.byteLength);
        const headerView = new DataView(bindings.header.byteLength > 0 ? header.buffer : new ArrayBuffer(0));
        const probeLines = [
          `  header magic=0x${header[0].toString(16)} renderWidth=${header[6]} renderHeight=${header[7]} dpr=${headerView.getFloat32(32, true)}`,
          `  objectId first16=${Array.from(objectId.subarray(0, 16)).join(",")}`,
          `  coverage first16=${Array.from(coverage.subarray(0, 16)).join(",")}`,
          `  height first16=${Array.from(height.subarray(0, 16)).map((v) => v.toFixed(4)).join(",")}`,
          `  normal first16=${Array.from(normal.subarray(0, 48)).map((v) => v.toFixed(4)).join(",")}`,
          `  snapshot=${JSON.stringify({ w: snapshot.width, h: snapshot.height, wg: snapshot.lastDispatch.workgroupCountX, cells: snapshot.lastDispatch.totalMaskCells, nwg: normalPass.getSnapshot().lastDispatch.workgroupCountX })}`,
        ];
        for (const line of probeLines) {
          detail.push(line);
        }
      }
    }
  } catch (error) {
    failure = String(error?.stack ?? error);
  }
  // Exactly one popErrorScope per fixture: a non-null scoped validation error
  // is a REAL failure even when the comparison did not throw (e.g. an
  // invalid submit that dropped the command buffer), so it fails the fixture.
  const scopedError = await device.popErrorScope().catch(() => null);
  if (scopedError !== null) {
    detail.push(`fixture ${fixture.name} validation error: ${scopedError.message}`);
  }
  try {
    uploader?.dispose();
    pass?.dispose();
    normalPass?.dispose();
    synthHeightBuffer?.destroy();
  } catch {
    // disposal must never mask the fixture outcome
  }
  if (failure !== null) {
    return { name: fixture.name, error: failure };
  }
  if (scopedError !== null) {
    return { name: fixture.name, error: `validation: ${scopedError.message}` };
  }
  return result;
}

async function checkShaders(device) {
  const problems = [];
  for (const [label, code] of [
    ["MASK_SDF_WGSL", MASK_SDF_WGSL],
    ["COMPOSE_HEIGHT_WGSL", COMPOSE_HEIGHT_WGSL],
    ["COMPOSE_COVERAGE_WGSL", COMPOSE_COVERAGE_WGSL],
    ["COMPOSE_OBJECT_ID_WGSL", COMPOSE_OBJECT_ID_WGSL],
    ["COMPOSE_MATERIAL_ID_WGSL", COMPOSE_MATERIAL_ID_WGSL],
    ["NORMAL_PASS_WGSL", NORMAL_PASS_WGSL],
  ]) {
    const module = device.createShaderModule({ code, label });
    const info = await module.getCompilationInfo();
    for (const message of info.messages) {
      // ANY compilation message (error, warning, info) FAILS the run: a
      // real-adapter PASS means every module compiled with ZERO messages.
      problems.push(
        `${label}:${message.lineNum}:${message.linePos}: ${message.type}: ${message.message}`,
      );
    }
  }
  return problems;
}

async function main() {
  try {
    if (typeof navigator === "undefined" || navigator.gpu === undefined) {
      finish(MARKER_SKIP, "navigator.gpu is unavailable in this browser");
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) {
      finish(MARKER_SKIP, "no WebGPU adapter available");
      return;
    }
    const device = await adapter.requestDevice();
    const deviceErrors = [];
    device.onuncapturederror = (event) => {
      deviceErrors.push(String(event.error?.message ?? event.error));
    };

    const shaderProblems = await checkShaders(device);
    const fixtureResults = [];
    for (let i = 0; i < FIXTURES.length; i++) {
      const fixture = { ...FIXTURES[i], probe: i === 0 };
      try {
        fixtureResults.push(await runFixture(device, fixture));
      } catch (error) {
        fixtureResults.push({ name: fixture.name, error: String(error?.stack ?? error) });
      }
    }
    // drain async device errors before destroying the device
    await device.queue.onSubmittedWorkDone().catch(() => undefined);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    device.destroy();

    for (const problem of shaderProblems) {
      detail.push("shader error: " + problem);
    }
    for (const error of deviceErrors) {
      detail.push("device error: " + error);
    }
    let totalTexels = 0;
    let totalMismatches = 0;
    let totalNormalMismatches = 0;
    let maxComponentError = 0;
    let maxLengthError = 0;
    let executionFailures = 0;
    for (const result of fixtureResults) {
      totalTexels += result.texels ?? 0;
      totalMismatches += result.mismatches ?? 0;
      const normal = result.normal;
      if (normal !== undefined) {
        totalNormalMismatches += normal.mismatches ?? 0;
        maxComponentError = Math.max(maxComponentError, normal.maxComponentError ?? 0);
        maxLengthError = Math.max(maxLengthError, normal.maxLengthError ?? 0);
      }
      if (result.error !== undefined) {
        executionFailures += 1;
      }
      if (result.error !== undefined) {
        detail.push(`fixture ${result.name}: FAIL (threw: ${result.error})`);
      } else {
        const normalLine =
          result.normal === undefined
            ? ""
            : `; normal ${result.normal.mismatches === 0 ? "PASS" : "FAIL"} ` +
              `(${result.normal.mismatches}/${result.normalTexels ?? result.texels} normal texels, ` +
              `max comp err ${result.normal.maxComponentError.toExponential(3)}, ` +
              `max len err ${result.normal.maxLengthError.toExponential(3)})`;
        detail.push(
          `fixture ${result.name}: ${result.mismatches === 0 ? "PASS" : "FAIL"} ` +
            `(${result.mismatches}/${result.texels} texels)${normalLine}`,
        );
      }
      for (const sample of result.samples ?? []) {
        detail.push("  " + sample);
      }
      for (const sample of result.normal?.samples ?? []) {
        detail.push("  " + sample);
      }
    }

    if (shaderProblems.length > 0) {
      finish(MARKER_FAIL, `shader compilation failed (${shaderProblems.length} messages)`);
      return;
    }
    if (deviceErrors.length > 0) {
      finish(MARKER_FAIL, `device validation errors (${deviceErrors.length})`);
      return;
    }
    if (executionFailures > 0) {
      finish(
        MARKER_FAIL,
        `fixture execution failures: ${executionFailures} of ${fixtureResults.length} fixtures ` +
          `(thrown errors or non-null scoped validation errors)`,
      );
      return;
    }
    if (totalMismatches > 0) {
      finish(
        MARKER_FAIL,
        `fixture mismatches: ${totalMismatches} texels across ${fixtureResults.length} fixtures (${totalTexels} texels total)`,
      );
      return;
    }
    if (totalNormalMismatches > 0) {
      finish(
        MARKER_FAIL,
        `normal mismatches: ${totalNormalMismatches} normal texels across ${fixtureResults.length} fixtures`,
      );
      return;
    }
    finish(
      MARKER_PASS,
      `real adapter parity: ${fixtureResults.length} fixtures, ${totalTexels} scene texels, ` +
        `0 mismatches (height tolerance ${HEIGHT_TOLERANCE}; normal tolerance ${NORMAL_TOLERANCE}, ` +
        `length tolerance ${LENGTH_TOLERANCE}; measured max component error ${maxComponentError.toExponential(3)}, ` +
        `max length error ${maxLengthError.toExponential(3)})`,
    );
  } catch (error) {
    finish(MARKER_FAIL, `harness threw: ${String(error?.stack ?? error)}`);
  }
}

main();
