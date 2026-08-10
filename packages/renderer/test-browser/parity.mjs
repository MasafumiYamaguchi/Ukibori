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
// #27: caster-height parity reuses the tight #25 tolerance; visibility is
// binary and requires EXACT 0/1 equality. Every shadow fixture must also be
// invariant under a +/-5e-4 perturbation of both CPU fields: the GPU fields
// differ from the CPU oracle by at most the #25 height tolerance (~1e-4
// worst case; ~1e-5 for the integer-height fixtures), so a decision that
// flips within 5e-4 is a razor edge that would make exact 0/1 parity
// undefined. The perturbation pre-check runs on the CPU oracle BEFORE the
// GPU comparison, so a razor fixture fails deterministically.
const SHADOW_CASTER_TOLERANCE = 1e-4;
const SHADOW_PERTURBATION = 5e-4;
// #27 benchmark: the fixed demo-frame proxy extent (the actual demo/debug
// extent is 96x60, not representative, so 640x360 is documented as the
// demo-frame proxy per the brief) and the required material improvement.
const BENCHMARK_WIDTH = 640;
const BENCHMARK_HEIGHT = 360;
const BENCHMARK_WARMUP = 5;
const BENCHMARK_SAMPLES = 10;
const BENCHMARK_MIN_SPEEDUP = 2;

const {
  createScene,
  encodeScene,
  SceneUploader,
  HeightPass,
  NormalPass,
  normalHeightBindingFromHeightPass,
  sanitizeNormalOptions,
  ShadowPass,
  shadowHeightBindingsFromHeightPass,
  computeNormals,
  computeVisibility,
  composeCasterHeightField,
  composeSdfHeightField,
  HostBuffer,
  HEIGHT_SPEC,
  OBJECT_ID_SPEC,
  NO_OWNER,
  surfaceHeight,
  MASK_SDF_WGSL,
  COMPOSE_HEIGHT_WGSL,
  COMPOSE_COVERAGE_WGSL,
  COMPOSE_OBJECT_ID_WGSL,
  COMPOSE_MATERIAL_ID_WGSL,
  COMPOSE_CASTER_HEIGHT_WGSL,
  NORMAL_PASS_WGSL,
  SHADOW_PASS_WGSL,
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

// ---------------------------------------------------------------------------
// #27 CPU shadow oracle (the semantic reference and CPU fallback)
// ---------------------------------------------------------------------------

/**
 * Caster-only composition oracle: the #27 Hcaster field at the same render
 * extent — `cpuOracle` restricted to surfaces with `castsShadow = true`,
 * using the exact same composition rule (larger f32 height wins, exact
 * ties to the later surface).
 */
function cpuCasterOracle(scene, dpr) {
  return cpuOracle(
    { ...scene, surfaces: scene.surfaces.filter((s) => s.castsShadow) },
    dpr,
  );
}

/**
 * #27 CPU visibility oracle: the ACTUAL TypeScript `computeVisibility` (the
 * semantic oracle and CPU fallback) fed with the CPU reference height,
 * caster-height and object-id fields at the same render extent, the same
 * f32-packed light direction the GPU reads from the header uniform, the
 * same DPR and the SAME effective (sanitized, f32-rounded) options the GPU
 * ran. Returns the binary field as a Float32Array of 0/1.
 */
function shadowOracleCPU(scene, rw, rh, height, casterHeight, objectId, dpr, effectiveOptions) {
  const oracleScene = {
    ...scene,
    light: {
      direction: {
        x: Math.fround(scene.light.direction.x),
        y: Math.fround(scene.light.direction.y),
        z: Math.fround(scene.light.direction.z),
      },
      intensity: 1,
    },
  };
  const load = (spec, data) => {
    const buf = new HostBuffer(spec(rw, rh));
    for (let g = 0; g < data.length; g++) {
      buf.set(g % rw, Math.floor(g / rw), 0, data[g]);
    }
    return buf;
  };
  const visibility = computeVisibility(oracleScene, load(HEIGHT_SPEC, height), {
    objectId: load(OBJECT_ID_SPEC, objectId),
    casterHeight: load(HEIGHT_SPEC, casterHeight),
    dpr: Math.fround(dpr),
    ...effectiveOptions,
  });
  const out = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      out[y * rw + x] = visibility.get(x, y, 0);
    }
  }
  return out;
}

/**
 * Binary-stable CPU oracle for a shadow fixture: compute the oracle and
 * require it to be invariant when receiver and caster fields are perturbed
 * in OPPOSITE directions by SHADOW_PERTURBATION. Moving both fields in the
 * same direction can cancel at the comparison threshold; the opposing
 * perturbations instead exercise both worst-case margins between independently
 * composed GPU fields. A decision that flips is a razor edge on which exact
 * 0/1 parity is not defined, so the fixture fails deterministically.
 *
 * `exactThreshold` opts out only for deliberate equality pins whose purpose
 * is the zero-margin strict-comparison boundary itself.
 */
function stableShadowOracle(
  scene,
  rw,
  rh,
  height,
  casterHeight,
  objectId,
  dpr,
  effectiveOptions,
  exactThreshold = false,
) {
  const oracle = (h, c) =>
    shadowOracleCPU(scene, rw, rh, h, c, objectId, dpr, effectiveOptions);
  const base = oracle(height, casterHeight);
  if (exactThreshold) {
    return base;
  }
  const receiverUpCasterDown = oracle(
    height.map((v) => v + SHADOW_PERTURBATION),
    casterHeight.map((v) => v - SHADOW_PERTURBATION),
  );
  const receiverDownCasterUp = oracle(
    height.map((v) => v - SHADOW_PERTURBATION),
    casterHeight.map((v) => v + SHADOW_PERTURBATION),
  );
  for (let g = 0; g < base.length; g++) {
    if (
      base[g] !== receiverUpCasterDown[g] ||
      base[g] !== receiverDownCasterUp[g]
    ) {
      const tx = g % rw;
      const ty = Math.floor(g / rw);
      throw new Error(
        `razor-edge fixture texel(${tx},${ty}): the CPU decision flips within ` +
          `+/-${SHADOW_PERTURBATION} field perturbation ` +
          `(base ${base[g]}, receiver-up/caster-down ${receiverUpCasterDown[g]}, ` +
          `receiver-down/caster-up ${receiverDownCasterUp[g]}); exact 0/1 GPU parity is not defined`,
      );
    }
  }
  return base;
}

/**
 * #27 visibility comparison: EXACT binary 0/1 equality, plus a finite /
 * binary audit of every GPU value. No tolerance is used: a 0.99999 or a
 * flipped texel is a mismatch.
 */
function compareVisibility(name, oracle, gpu, width) {
  const texels = oracle.length;
  let mismatches = 0;
  const samples = [];
  for (let g = 0; g < texels; g++) {
    const v = gpu[g];
    const bad =
      v !== 0 && v !== 1 ? `non-binary/non-finite ${v}` : v === oracle[g] ? null : `!= oracle ${oracle[g]}`;
    if (bad !== null) {
      mismatches += 1;
      if (samples.length < 8) {
        const tx = g % width;
        const ty = Math.floor(g / width);
        samples.push(`visibility texel(${tx},${ty}): gpu ${v} ${bad}`);
      }
    }
  }
  return { mismatches, samples };
}

/** #27 caster-height comparison: the tight #25 tolerance plus the max error. */
function compareCasterHeight(oracle, gpu) {
  const texels = oracle.length;
  let mismatches = 0;
  let maxError = 0;
  for (let g = 0; g < texels; g++) {
    const dh = Math.abs(gpu[g] - oracle[g]);
    maxError = Math.max(maxError, dh);
    if (!(dh <= SHADOW_CASTER_TOLERANCE) || !Number.isFinite(gpu[g])) {
      mismatches += 1;
    }
  }
  return { mismatches, maxError };
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

// ---------------------------------------------------------------------------
// #27 shadow fixtures. All surfaces use integer positions/sizes and
// f32-exact integer (or exact half/quarter) elevations and thicknesses, so
// the composed full/caster fields are f32-exact on both the CPU oracle and
// the GPU; decisions keep >= ~0.05 scene-unit margins (the harness also
// runs the +/-5e-4 stability pre-check, which would reject any razor edge).
// Lights use the fixed #13 sign convention (direction FROM the receiver
// TOWARD the light).
// ---------------------------------------------------------------------------

const LIGHT_FROM_RIGHT = { x: 0.70710678, y: 0, z: 0.70710678 };
const LIGHT_FROM_LEFT = { x: -0.70710678, y: 0, z: 0.70710678 };
const LIGHT_VERTICAL = { x: 0, y: 0, z: 1 };
const LIGHT_NEAR_VERTICAL = { x: 0.1, y: 0, z: 0.995 };
const LIGHT_HORIZONTAL = { x: 1, y: 0, z: 0 };
const LIGHT_SHALLOW_LEFT = { x: -0.9, y: 0, z: 0.1 };
const LIGHT_SELF_SHADOW = { x: 0.89442719, y: 0, z: 0.4472136 };

function shadowSurface(partial) {
  return {
    id: "s",
    position: { x: 0, y: 0 },
    size: { x: 10, y: 10 },
    elevation: 0,
    thickness: 0,
    shape: { kind: "roundedRect", radius: 0 },
    profile: { kind: "flat" },
    material: "silicone",
    castsShadow: true,
    receivesShadow: true,
    ...partial,
  };
}

function shadowScene(width, height, surfaces, light, shadowOptions) {
  return {
    scene: createScene({
      width,
      height,
      surfaces,
      light: { direction: light, intensity: 1 },
    }),
    shadowOptions,
  };
}

/**
 * The #17 two-level fixture: a 6-unit slab on NO_OWNER background receivers
 * (no panel surface). The slab covers render texels 8..13 x 2..3 at dpr 1.
 */
function twoLevelScene(light, shadowOptions) {
  return shadowScene(16, 16, [shadowSurface({
    id: "slab",
    position: { x: 8, y: 2 },
    size: { x: 6, y: 2 },
    elevation: 6,
  })], light, shadowOptions);
}

/** Non-casting top (4.5) fully covering a lower casting slab (4). */
function nonCastingTopScene() {
  return shadowScene(16, 16, [
    shadowSurface({ id: "caster", position: { x: 3, y: 3 }, size: { x: 10, y: 10 }, elevation: 4 }),
    shadowSurface({
      id: "top",
      position: { x: 3, y: 3 },
      size: { x: 10, y: 10 },
      elevation: 4.5,
      castsShadow: false,
    }),
  ], LIGHT_FROM_RIGHT);
}

/** A receiving panel with a casting button (receivesShadow true/false pair). */
function panelButtonScene(receivesShadow) {
  return shadowScene(16, 16, [
    shadowSurface({
      id: "panel",
      position: { x: 0, y: 0 },
      size: { x: 16, y: 16 },
      elevation: 0,
      castsShadow: false,
      receivesShadow,
    }),
    shadowSurface({
      id: "btn",
      position: { x: 3, y: 3 },
      size: { x: 10, y: 10 },
      elevation: 4,
    }),
  ], LIGHT_FROM_RIGHT);
}

/** Casting/non-casting bilinear boundary with a shallow light from the left. */
function bilinearBoundaryScene() {
  return shadowScene(16, 16, [
    shadowSurface({ id: "caster", position: { x: 3, y: 3 }, size: { x: 5, y: 10 }, elevation: 4 }),
    shadowSurface({
      id: "adj",
      position: { x: 8, y: 3 },
      size: { x: 4, y: 10 },
      elevation: 0,
      castsShadow: false,
    }),
  ], LIGHT_SHALLOW_LEFT);
}

/** Exact f32 equality at the threshold: a 0.5-tall caster must stay lit. */
function equalityThresholdScene() {
  return shadowScene(16, 16, [
    shadowSurface({
      id: "half",
      position: { x: 3, y: 6 },
      size: { x: 4, y: 2 },
      elevation: 0,
      thickness: 0.5,
    }),
  ], LIGHT_HORIZONTAL);
}

/** Strict comparison above the threshold: a 0.75-tall caster blocks. */
function strictThresholdScene() {
  return shadowScene(16, 16, [
    shadowSurface({
      id: "threeQuarter",
      position: { x: 3, y: 6 },
      size: { x: 4, y: 2 },
      elevation: 0,
      thickness: 0.75,
    }),
  ], LIGHT_HORIZONTAL);
}

/** Overlap/tie ordering: identical ties (a/b) and a higher c (c wins). */
function tieOverlapScene() {
  return shadowScene(16, 16, [
    shadowSurface({ id: "a", position: { x: 2, y: 2 }, size: { x: 8, y: 8 }, elevation: 1, thickness: 2 }),
    shadowSurface({ id: "b", position: { x: 4, y: 4 }, size: { x: 8, y: 8 }, elevation: 1, thickness: 2 }),
    shadowSurface({ id: "c", position: { x: 3, y: 3 }, size: { x: 4, y: 4 }, elevation: 5, thickness: 1 }),
  ], LIGHT_FROM_RIGHT);
}

/** A solid mask glyph as the caster (full-ink 4x4 mask on an 8x8 surface). */
function maskCasterScene() {
  return shadowScene(16, 16, [
    shadowSurface({
      id: "glyph",
      position: { x: 6, y: 6 },
      size: { x: 8, y: 8 },
      elevation: 4,
      shape: { kind: "mask", mask: { width: 4, height: 4, alpha: new Float32Array(16).fill(1) } },
    }),
  ], LIGHT_FROM_RIGHT);
}

/**
 * Clipped caster whose shadow reaches the visible field + offscreen caster.
 * The caster's left edge is offscreen (x -10) and its right edge (x 10) is
 * visible; with the light FROM THE LEFT the shadow falls onto the visible
 * base-plane texels right of x 10 (rows inside the caster's band).
 */
function clippedCasterScene() {
  return shadowScene(16, 16, [
    shadowSurface({
      id: "clipped",
      position: { x: -10, y: 4 },
      size: { x: 20, y: 8 },
      elevation: 3,
      thickness: 3,
    }),
    shadowSurface({
      id: "offscreen",
      position: { x: 200, y: 200 },
      size: { x: 10, y: 10 },
      elevation: 9,
      thickness: 9,
    }),
  ], LIGHT_FROM_LEFT);
}

/**
 * Fractional render extents with a casting surface: the logical 13x9 scene
 * maps to 19x13 (dpr 1.5) and 26x18 (dpr 2). A tall 7-top caster keeps the
 * shadow margins wide at every dpr.
 */
function fracShadowScene() {
  return shadowScene(13, 9, [
    shadowSurface({
      id: "frac",
      position: { x: 2, y: 1 },
      size: { x: 8, y: 6 },
      elevation: 1,
      thickness: 6,
    }),
  ], LIGHT_FROM_RIGHT);
}

/**
 * Synthetic GPU-resident self-shadow fixture (like the #26 synth normals):
 * a f32-exact ramp H(x) = 0.55 * x with the ray ascending 0.5 per scene
 * unit. The ramp texels self-occlude with bias 0 (every ramp texel is
 * blocked; the sample/rayZ gap grows 0.0447 per step, so every decision
 * keeps a >= ~0.02 margin) and the bias-2 set suppresses every occlusion.
 */
function selfShadowSynthFixture() {
  return {
    name: "shadow-synth-self-shadow-bias-sets",
    shadowSynth: true,
    width: 16,
    height: 16,
    field: synthHeight(16, 16, (x) => 0.55 * x),
    optionSets: [
      { stepSize: 0.5, bias: 0, maxDistance: 100 },
      { stepSize: 0.5, bias: 2, maxDistance: 100 },
    ],
    scene: shadowScene(16, 16, [
      // dummy casting surface: hasCasters = 1 (the shader marches using the
      // synthetic fields) and its top (10) is a conservative maxCasterHeight
      // bound above the ramp max (8.25)
      shadowSurface({
        id: "dummy",
        position: { x: 0, y: 0 },
        size: { x: 16, y: 16 },
        elevation: 10,
      }),
    ], LIGHT_SELF_SHADOW).scene,
  };
}

/**
 * f32-vs-f64 threshold fixture: the caster top is f32(0.1 + 0.2) =
 * 0.30000001192092896 (f32-exact in both the composed CPU field and the
 * composed GPU field) and the f32 threshold f32(0 + 0.3) equals it EXACTLY,
 * so the strict `>` comparison says LIT (equality) — while a naive f64
 * comparison (0.30000001192092896 > 0.3) would say BLOCKED. The equality is
 * value-exact in both arithmetic paths (not margin luck), so this fixture is
 * deliberately exempt from the +/-5e-4 perturbation pre-check.
 */
function f32ThresholdScene() {
  return shadowScene(16, 16, [
    shadowSurface({
      id: "f32top",
      position: { x: 3, y: 6 },
      size: { x: 4, y: 2 },
      elevation: 0,
      thickness: 0.3,
    }),
  ], LIGHT_HORIZONTAL, { bias: 0.3 });
}

const SHADOW_FIXTURES = [
  { ...twoLevelScene(LIGHT_FROM_RIGHT), name: "shadow-two-level-light-right", dpr: 1 },
  { ...twoLevelScene(LIGHT_FROM_LEFT), name: "shadow-two-level-light-left", dpr: 1 },
  {
    ...twoLevelScene(LIGHT_FROM_RIGHT),
    name: "shadow-occluder-removed",
    dpr: 1,
    scene: createScene({
      width: 16,
      height: 16,
      surfaces: [shadowSurface({
        id: "slab",
        position: { x: 8, y: 2 },
        size: { x: 6, y: 2 },
        elevation: 6,
        castsShadow: false,
      })],
      light: { direction: LIGHT_FROM_RIGHT, intensity: 1 },
    }),
  },
  { ...nonCastingTopScene(), name: "shadow-non-casting-top", dpr: 1 },
  { ...panelButtonScene(true), name: "shadow-panel-receives", dpr: 1 },
  { ...panelButtonScene(false), name: "shadow-receives-false", dpr: 1 },
  { ...bilinearBoundaryScene(), name: "shadow-bilinear-boundary", dpr: 1 },
  {
    ...equalityThresholdScene(),
    name: "shadow-equality-at-threshold",
    dpr: 1,
    shadowThresholdExact: true,
  },
  { ...strictThresholdScene(), name: "shadow-strict-above-threshold", dpr: 1 },
  { ...tieOverlapScene(), name: "shadow-tie-overlap-ordering", dpr: 1 },
  { ...maskCasterScene(), name: "shadow-mask-caster", dpr: 1 },
  { ...clippedCasterScene(), name: "shadow-clipped-offscreen-caster", dpr: 1 },
  { ...twoLevelScene(LIGHT_VERTICAL), name: "shadow-vertical-light", dpr: 1 },
  { ...twoLevelScene(LIGHT_NEAR_VERTICAL), name: "shadow-near-vertical-light", dpr: 1 },
  // +/-y lights: the shadow falls on the -y/+y side and rays from the
  // bottom/top edge receivers leave the field through the bottom/top edge
  { ...twoLevelScene({ x: 0, y: 1, z: 1 }), name: "shadow-y-light-bottom-exit", dpr: 1 },
  { ...twoLevelScene({ x: 0, y: -1, z: 1 }), name: "shadow-y-light-top-exit", dpr: 1 },
  {
    ...twoLevelScene(LIGHT_FROM_RIGHT, { maxDistance: 3 }),
    name: "shadow-short-max-distance",
    dpr: 1,
  },
  {
    ...twoLevelScene(LIGHT_FROM_RIGHT, { stepSize: 0.25, bias: 0.25, maxDistance: 6 }),
    name: "shadow-custom-options-a",
    dpr: 1,
  },
  {
    ...twoLevelScene(LIGHT_FROM_RIGHT, { stepSize: 1, bias: 0, maxDistance: 20 }),
    name: "shadow-custom-options-b",
    dpr: 1,
  },
  // non-dyadic step: pins the explicit f32-multiple march series
  // (t = f32(k * stepSize)) end-to-end on the real GPU
  {
    ...twoLevelScene(LIGHT_FROM_RIGHT, { stepSize: 0.1, bias: 0.25, maxDistance: 10 }),
    name: "shadow-non-binary-step-0.1",
    dpr: 1,
  },
  {
    ...f32ThresholdScene(),
    name: "shadow-f32-vs-f64-equality",
    dpr: 1,
    shadowThresholdExact: true,
  },
  { ...fracShadowScene(), name: "shadow-frac-dpr1", dpr: 1 },
  { ...fracShadowScene(), name: "shadow-frac-dpr1.5", dpr: 1.5 },
  { ...fracShadowScene(), name: "shadow-frac-dpr2", dpr: 2 },
  selfShadowSynthFixture(),
];

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
  // #27 shadow fixtures (the real-GPU shadow stage: HeightPass ->
  // NormalPass -> ShadowPass, exact 0/1 visibility parity, tight
  // caster-height parity, and the +/-5e-4 stability pre-check on every
  // fixture).
  ...SHADOW_FIXTURES,
];

// ---------------------------------------------------------------------------
// Fixture runner
// ---------------------------------------------------------------------------

async function runFixture(device, fixture) {
  let uploader = null;
  let pass = null;
  let normalPass = null;
  let shadowPass = null;
  let synthHeightBuffer = null;
  let synthObjectIdBuffer = null;
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
    } else if (fixture.shadowSynth) {
      // #27 synthetic GPU-resident self-shadow fixture: upload the f32
      // ramp as both the full and caster height fields plus an all-NO_OWNER
      // object-id field, and run the shadow pass directly with two option
      // sets. Proves the source field bytes stay EXACTLY unchanged and the
      // output flips from fully occluded (bias 0) to fully lit (bias 2).
      const { width, height: rh, field, optionSets, scene } = fixture;
      const byteLength = field.length * 4;
      synthHeightBuffer = device.createBuffer({
        size: Math.max(byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        label: "ukibori-test-synth-shadow",
      });
      device.queue.writeBuffer(
        synthHeightBuffer,
        0,
        new Uint8Array(field.buffer, field.byteOffset, byteLength),
      );
      const objectId = new Uint32Array(width * rh).fill(NO_OWNER);
      synthObjectIdBuffer = device.createBuffer({
        size: Math.max(byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        label: "ukibori-test-synth-objid",
      });
      device.queue.writeBuffer(
        synthObjectIdBuffer,
        0,
        new Uint8Array(objectId.buffer, objectId.byteOffset, byteLength),
      );
      const encoded = encodeScene(scene, 1);
      const synthUploader = new SceneUploader(device);
      synthUploader.upload(encoded);
      const bindings = synthUploader.getBindings();
      const syntheticProvenance = Object.freeze({
        sceneBytes: encoded.bytes,
        width,
        height: rh,
        dpr: 1,
      });
      shadowPass = new ShadowPass(device);
      const input = {
        scene: encoded,
        bindings,
        height: {
          buffer: synthHeightBuffer,
          byteLength,
          format: "f32",
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          width,
          height: rh,
          provenance: syntheticProvenance,
        },
        casterHeight: {
          buffer: synthHeightBuffer,
          byteLength,
          format: "f32",
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          width,
          height: rh,
          provenance: syntheticProvenance,
        },
        objectId: {
          buffer: synthObjectIdBuffer,
          byteLength,
          format: "u32",
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          width,
          height: rh,
          provenance: syntheticProvenance,
        },
      };
      const initialHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      shadowPass.dispatch({ ...input, options: optionSets[0] });
      const firstHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      const firstVis = await readbackF32(
        device,
        shadowPass.getSnapshot().output.buffer,
        shadowPass.getSnapshot().output.byteLength,
      );
      const optionsA = shadowPass.getSnapshot().options;
      shadowPass.dispatch({ ...input, options: optionSets[1] });
      const secondHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      const secondVis = await readbackF32(
        device,
        shadowPass.getSnapshot().output.buffer,
        shadowPass.getSnapshot().output.byteLength,
      );
      const optionsB = shadowPass.getSnapshot().options;
      const a = compareVisibility(
        fixture.name + "/bias0",
        stableShadowOracle(scene, width, rh, field, field, objectId, 1, optionsA),
        firstVis,
        width,
      );
      const b = compareVisibility(
        fixture.name + "/bias2",
        stableShadowOracle(scene, width, rh, field, field, objectId, 1, optionsB),
        secondVis,
        width,
      );
      let extraMismatches = 0;
      const extraSamples = [];
      if (
        !bytesEqual(initialHeightBytes, firstHeightBytes) ||
        !bytesEqual(initialHeightBytes, secondHeightBytes)
      ) {
        extraMismatches += 1;
        extraSamples.push("  source height bytes changed during a shadow dispatch");
      }
      let outputChanged = false;
      for (let i = 0; i < firstVis.length; i++) {
        if (firstVis[i] !== secondVis[i]) {
          outputChanged = true;
          break;
        }
      }
      if (!outputChanged) {
        extraMismatches += 1;
        extraSamples.push("  shadow output did not change between option sets");
      }
      synthUploader.dispose();
      result = {
        name: fixture.name,
        texels: width * rh,
        mismatches: 0,
        samples: [],
        shadowTexels: width * rh * 2,
        shadow: {
          mismatches: a.mismatches + b.mismatches + extraMismatches,
          samples: [...a.samples, ...b.samples, ...extraSamples],
        },
        casterTexels: 0,
        caster: { mismatches: 0, maxError: 0 },
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

      // #27 shadow stage: consume the #25 height/casterHeight/objectId
      // outputs DIRECTLY through the public helper, dispatch the real
      // ShadowPass with the fixture options, and read back the caster
      // height and the binary visibility through TEST-ONLY staging buffers.
      shadowPass = new ShadowPass(device);
      const shadowInputs = shadowHeightBindingsFromHeightPass(snapshot);
      shadowPass.dispatch({
        scene: encoded,
        bindings,
        ...shadowInputs,
        options: fixture.shadowOptions,
      });
      const shadowSnapshot = shadowPass.getSnapshot();
      const [shadowBytes, casterBytes] = await Promise.all([
        readback(device, shadowSnapshot.output.buffer, shadowSnapshot.output.byteLength),
        readbackF32(device, outputs.casterHeight.buffer, outputs.casterHeight.byteLength),
      ]);
      const visibility = new Float32Array(
        shadowBytes.buffer,
        shadowBytes.byteOffset,
        shadowBytes.byteLength / 4,
      );
      const dpr = fixture.dpr ?? 1;
      // CPU oracle: the ACTUAL TypeScript oracle (computeVisibility +
      // caster-only composition) at the same render extent, DPR, f32 light
      // and the GPU's EFFECTIVE options, hardened by the +/-5e-4 stability
      // pre-check.
      const casterOracle = cpuCasterOracle(fixture.scene, dpr);
      const visibilityOracle = stableShadowOracle(
        fixture.scene,
        oracle.rw,
        oracle.rh,
        oracle.height,
        casterOracle.height,
        oracle.objectId,
        dpr,
        shadowSnapshot.options,
        fixture.shadowThresholdExact === true,
      );
      result.shadowTexels = oracle.rw * oracle.rh;
      result.shadow = compareVisibility(fixture.name, visibilityOracle, visibility, oracle.rw);
      result.casterTexels = oracle.rw * oracle.rh;
      result.caster = compareCasterHeight(casterOracle.height, casterBytes);

      // Raw GPU probes for the first fixture only: the uploaded scene header
      // (proves the queue.writeBuffer path), the objectId field (proves the
      // shader actually wrote NO_OWNER into background texels), the normal
      // field (proves the normal stage wrote its packed triples) and the
      // shadow pass snapshot (proves the visibility stage ran with the
      // effective options).
      if (fixture.probe) {
        const header = await readbackU32(device, bindings.header.buffer, bindings.header.byteLength);
        const headerView = new DataView(bindings.header.byteLength > 0 ? header.buffer : new ArrayBuffer(0));
        const probeLines = [
          `  header magic=0x${header[0].toString(16)} renderWidth=${header[6]} renderHeight=${header[7]} dpr=${headerView.getFloat32(32, true)}`,
          `  objectId first16=${Array.from(objectId.subarray(0, 16)).join(",")}`,
          `  coverage first16=${Array.from(coverage.subarray(0, 16)).join(",")}`,
          `  height first16=${Array.from(height.subarray(0, 16)).map((v) => v.toFixed(4)).join(",")}`,
          `  normal first16=${Array.from(normal.subarray(0, 48)).map((v) => v.toFixed(4)).join(",")}`,
          `  shadow first16=${Array.from(visibility.subarray(0, 16)).join(",")}`,
          `  snapshot=${JSON.stringify({ w: snapshot.width, h: snapshot.height, wg: snapshot.lastDispatch.workgroupCountX, cells: snapshot.lastDispatch.totalMaskCells, nwg: normalPass.getSnapshot().lastDispatch.workgroupCountX, swg: shadowSnapshot.lastDispatch.workgroupCountX, steps: shadowSnapshot.lastDispatch.stepCount, swOpts: shadowSnapshot.options })}`,
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
    shadowPass?.dispose();
    synthHeightBuffer?.destroy();
    synthObjectIdBuffer?.destroy();
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
    ["COMPOSE_CASTER_HEIGHT_WGSL", COMPOSE_CASTER_HEIGHT_WGSL],
    ["NORMAL_PASS_WGSL", NORMAL_PASS_WGSL],
    ["SHADOW_PASS_WGSL", SHADOW_PASS_WGSL],
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

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * #27 reproducible benchmark at the documented demo-frame proxy extent
 * (640x360): the same nontrivial multi-surface scene/options for CPU and
 * GPU. Adapter/pipeline creation, test-only readback and the parity
 * comparison are excluded from both timings; the GPU side includes the
 * normal per-frame parameter upload/dispatch/queue completion
 * (`queue.onSubmittedWorkDone()`). Reports median CPU ms, median GPU ms and
 * the speedup; requires a material >= BENCHMARK_MIN_SPEEDUP improvement and
 * otherwise reports the measured blocker.
 */
async function runBenchmark(device) {
  const glyph = {
    width: 6,
    height: 6,
    alpha: new Uint8Array(36).fill(255),
  };
  const scene = createScene({
    width: BENCHMARK_WIDTH,
    height: BENCHMARK_HEIGHT,
    surfaces: [
      shadowSurface({
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: BENCHMARK_WIDTH, y: BENCHMARK_HEIGHT },
        elevation: 0,
        castsShadow: false,
      }),
      shadowSurface({
        id: "btn-a",
        position: { x: 60, y: 80 },
        size: { x: 90, y: 60 },
        elevation: 2,
        thickness: 3,
        bevelWidth: 8,
        shape: { kind: "roundedRect", radius: 12 },
      }),
      shadowSurface({
        id: "btn-b",
        position: { x: 240, y: 120 },
        size: { x: 120, y: 70 },
        elevation: 4,
        thickness: 3,
        bevelWidth: 8,
        shape: { kind: "roundedRect", radius: 16 },
      }),
      shadowSurface({
        id: "btn-c",
        position: { x: 420, y: 60 },
        size: { x: 80, y: 90 },
        elevation: 1,
        thickness: 4,
        bevelWidth: 6,
        shape: { kind: "roundedRect", radius: 10 },
      }),
      shadowSurface({
        id: "badge",
        position: { x: 150, y: 200 },
        size: { x: 40, y: 40 },
        elevation: 7,
        thickness: 2,
        shape: { kind: "roundedRect", radius: 8 },
      }),
      shadowSurface({
        id: "glyph",
        position: { x: 520, y: 220 },
        size: { x: 12, y: 12 },
        elevation: 5,
        thickness: 2,
        shape: { kind: "mask", mask: glyph },
      }),
    ],
    light: { direction: LIGHT_FROM_RIGHT, intensity: 1 },
  });
  const options = {};

  // CPU side (like-for-like stage set: height + caster composition +
  // normals + visibility).
  const cpuFrame = () => {
    const composed = composeSdfHeightField(scene);
    const caster = composeCasterHeightField(scene);
    computeNormals(composed.height);
    computeVisibility(scene, composed.height, {
      objectId: composed.objectId,
      casterHeight: caster,
    });
  };
  for (let i = 0; i < BENCHMARK_WARMUP; i++) {
    cpuFrame(); // warm the JS JIT before timing
  }
  const cpuSamples = [];
  for (let i = 0; i < BENCHMARK_SAMPLES; i++) {
    const t0 = performance.now();
    cpuFrame();
    cpuSamples.push(performance.now() - t0);
  }
  const cpuMedian = median(cpuSamples);

  // GPU side: upload once, then per sample the full frame chain
  // (HeightPass -> NormalPass -> ShadowPass) with queue completion. This
  // includes the normal per-frame parameter upload/dispatch/queue
  // completion; pipeline and allocation caches are warm from the parity
  // run and the warm-up frame below.
  const encoded = encodeScene(scene, 1);
  const uploader = new SceneUploader(device);
  uploader.upload(encoded);
  const bindings = uploader.getBindings();
  const heightPass = new HeightPass(device);
  const normalPass = new NormalPass(device);
  const shadowPass = new ShadowPass(device);
  heightPass.dispatch(encoded, bindings);
  const snapshot = heightPass.getSnapshot();
  const shadowInputs = shadowHeightBindingsFromHeightPass(snapshot);
  const normalInput = { height: normalHeightBindingFromHeightPass(snapshot), options: {} };
  const frame = async () => {
    heightPass.dispatch(encoded, bindings);
    normalPass.dispatch(normalInput);
    shadowPass.dispatch({ scene: encoded, bindings, ...shadowInputs, options });
    await device.queue.onSubmittedWorkDone();
  };
  for (let i = 0; i < BENCHMARK_WARMUP; i++) {
    await frame(); // warm device/pipeline/allocation caches before timing
  }
  const gpuSamples = [];
  for (let i = 0; i < BENCHMARK_SAMPLES; i++) {
    const t0 = performance.now();
    await frame();
    gpuSamples.push(performance.now() - t0);
  }
  const gpuMedian = median(gpuSamples);
  const speedup = cpuMedian / gpuMedian;
  // effective (sanitized + f32-packed) options of the benchmark run
  const effectiveOptions = shadowPass.getSnapshot().options;

  // One parity verification of the benchmark scene itself (outside both
  // timings): exact binary visibility vs the stable CPU oracle and tight
  // caster-height parity, so the benchmark measures verified work.
  const outputs = heightPass.getOutputs();
  const [shadowBytes, caster] = await Promise.all([
    readback(device, shadowPass.getSnapshot().output.buffer, shadowPass.getSnapshot().output.byteLength),
    readbackF32(device, outputs.casterHeight.buffer, outputs.casterHeight.byteLength),
  ]);
  const oracle = cpuOracle(scene, 1);
  const casterOracle = cpuCasterOracle(scene, 1);
  const casterCompare = compareCasterHeight(casterOracle.height, caster);
  const visibility = new Float32Array(
    shadowBytes.buffer,
    shadowBytes.byteOffset,
    shadowBytes.byteLength / 4,
  );
  const visCompare = compareVisibility(
    "benchmark",
    stableShadowOracle(
      scene,
      oracle.rw,
      oracle.rh,
      oracle.height,
      casterOracle.height,
      oracle.objectId,
      1,
      shadowPass.getSnapshot().options,
    ),
    visibility,
    oracle.rw,
  );

  uploader.dispose();
  heightPass.dispose();
  normalPass.dispose();
  shadowPass.dispose();
  return {
    cpuMedian,
    gpuMedian,
    speedup,
    warmups: BENCHMARK_WARMUP,
    samples: BENCHMARK_SAMPLES,
    width: BENCHMARK_WIDTH,
    height: BENCHMARK_HEIGHT,
    // the effective (sanitized + f32-packed) options the shader ran with,
    // taken from the final snapshot before disposal
    options: effectiveOptions,
    parity: {
      ...visCompare,
      casterMismatches: casterCompare.mismatches,
      casterMaxError: casterCompare.maxError,
      rw: oracle.rw,
      rh: oracle.rh,
    },
  };
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
    // #27 benchmark: the same 640x360 nontrivial scene on CPU and GPU.
    let benchmark = null;
    let benchmarkFailure = null;
    try {
      benchmark = await runBenchmark(device);
    } catch (error) {
      benchmarkFailure = String(error?.stack ?? error);
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
    let totalShadowMismatches = 0;
    let totalShadowTexels = 0;
    let totalCasterMismatches = 0;
    let totalCasterTexels = 0;
    let casterMaxError = 0;
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
      const shadow = result.shadow;
      if (shadow !== undefined) {
        totalShadowMismatches += shadow.mismatches ?? 0;
        totalShadowTexels += result.shadowTexels ?? 0;
      }
      const caster = result.caster;
      if (caster !== undefined) {
        totalCasterMismatches += caster.mismatches ?? 0;
        totalCasterTexels += result.casterTexels ?? 0;
        casterMaxError = Math.max(casterMaxError, caster.maxError ?? 0);
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
        const shadowLine =
          result.shadow === undefined
            ? ""
            : `; shadow ${result.shadow.mismatches === 0 ? "PASS" : "FAIL"} ` +
              `(${result.shadow.mismatches}/${result.shadowTexels ?? result.texels} visibility texels, ` +
              `caster ${result.caster?.mismatches ?? 0}/${result.casterTexels ?? 0} ` +
              `max err ${(result.caster?.maxError ?? 0).toExponential(3)})`;
        detail.push(
          `fixture ${result.name}: ${result.mismatches === 0 ? "PASS" : "FAIL"} ` +
            `(${result.mismatches}/${result.texels} texels)${normalLine}${shadowLine}`,
        );
      }
      for (const sample of result.samples ?? []) {
        detail.push("  " + sample);
      }
      for (const sample of result.normal?.samples ?? []) {
        detail.push("  " + sample);
      }
      for (const sample of result.shadow?.samples ?? []) {
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
    if (totalShadowMismatches > 0) {
      finish(
        MARKER_FAIL,
        `shadow visibility mismatches: ${totalShadowMismatches} of ${totalShadowTexels} visibility texels ` +
          `across ${fixtureResults.length} fixtures (exact 0/1 equality required)`,
      );
      return;
    }
    if (totalCasterMismatches > 0) {
      finish(
        MARKER_FAIL,
        `caster-height mismatches: ${totalCasterMismatches} of ${totalCasterTexels} texels ` +
          `(tolerance ${SHADOW_CASTER_TOLERANCE}, measured max error ${casterMaxError.toExponential(3)})`,
      );
      return;
    }
    if (benchmarkFailure !== null) {
      finish(
        MARKER_FAIL,
        `benchmark failed: ${benchmarkFailure}`,
      );
      return;
    }
    const benchmarkLine =
      `benchmark ${benchmark.width}x${benchmark.height} ${benchmark.warmups} warmups, ` +
      `${benchmark.samples} samples: ` +
      `CPU median ${benchmark.cpuMedian.toFixed(2)}ms, GPU median ${benchmark.gpuMedian.toFixed(3)}ms, ` +
      `speedup ${benchmark.speedup.toFixed(1)}x ` +
      `(effective options ${JSON.stringify(benchmark.options)})`;
    detail.push(benchmarkLine);
    const benchmarkParity = benchmark.parity;
    detail.push(
      `benchmark parity: visibility ${benchmarkParity.mismatches}/${benchmarkParity.rw * benchmarkParity.rh}, ` +
        `caster ${benchmarkParity.casterMismatches}/${benchmarkParity.rw * benchmarkParity.rh}, ` +
        `max err ${benchmarkParity.casterMaxError.toExponential(3)}`,
    );
    if (!(benchmark.speedup >= BENCHMARK_MIN_SPEEDUP)) {
      finish(
        MARKER_FAIL,
        `benchmark blocker: speedup ${benchmark.speedup.toFixed(2)}x is below the required ` +
          `${BENCHMARK_MIN_SPEEDUP}x (CPU median ${benchmark.cpuMedian.toFixed(2)}ms, ` +
          `GPU median ${benchmark.gpuMedian.toFixed(3)}ms at ${benchmark.width}x${benchmark.height}, ` +
          `${benchmark.samples} samples)`,
      );
      return;
    }
    if (benchmarkParity.mismatches > 0) {
      finish(
        MARKER_FAIL,
        `benchmark scene visibility mismatches: ${benchmarkParity.mismatches} of ${benchmarkParity.rw * benchmarkParity.rh}`,
      );
      return;
    }
    if (benchmarkParity.casterMismatches > 0) {
      finish(
        MARKER_FAIL,
        `benchmark scene caster-height mismatches: ${benchmarkParity.casterMismatches} of ` +
          `${benchmarkParity.rw * benchmarkParity.rh}`,
      );
      return;
    }
    finish(
      MARKER_PASS,
      `real adapter parity: ${fixtureResults.length} fixtures, ${totalTexels} scene texels, ` +
        `0 mismatches (height tolerance ${HEIGHT_TOLERANCE}; normal tolerance ${NORMAL_TOLERANCE}, ` +
        `length tolerance ${LENGTH_TOLERANCE}; measured max component error ${maxComponentError.toExponential(3)}, ` +
        `max length error ${maxLengthError.toExponential(3)}; ` +
        `shadow ${totalShadowMismatches}/${totalShadowTexels} visibility texels exact, ` +
        `caster tolerance ${SHADOW_CASTER_TOLERANCE} max err ${casterMaxError.toExponential(3)}; ` +
        `${benchmarkLine})`,
    );
  } catch (error) {
    finish(MARKER_FAIL, `harness threw: ${String(error?.stack ?? error)}`);
  }
}

main();
