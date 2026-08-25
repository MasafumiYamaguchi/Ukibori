// #30 CPU oracle + comparison + canonicalization module.
//
// Pure functions over an injected renderer API object (`createOracle(api)`),
// shared by:
//
//   - the browser parity harness (test-browser/parity.mjs, api = the bundled
//     public ESM) — every GPU fixture is compared against these functions
//   - the static-CPU-golden verification (vitest, api = the TS source) and
//     the golden maintenance CLI (scripts/golden-cpu.mjs, api = dist bundle)
//
// Canonicalization (#30, "Static CPU goldens"):
//
//   - integer/RGBA buffers are hashed as canonical little-endian bytes
//   - f32 buffers canonicalize non-finite/-0 behavior FIRST (NaN -> 0x7fc00000,
//     +Inf -> 0x7f800000, -Inf -> 0xff800000, -0 -> +0), then quantize each
//     value with the buffer's declared absolute tolerance (round(v / tol) *
//     tol) before the bytes are produced, so the digest is portable and the
//     tolerance is visible in the policy table
//   - the canonical payload embeds fixture id, categories, logical/render
//     dimensions, DPR and the full relevant parameter set, so a dimension or
//     parameter change cannot preserve a stale digest accidentally
//   - digests are compact SHA-256 hex plus a small set of human-readable
//     probes (coordinates and values) instead of large binary dumps
//
// Mismatch reporting (#30): every mismatch carries fixture ID, semantic
// categories, pass/buffer, dimensions/DPR, relevant parameters,
// coordinate/index, CPU value, GPU value, delta and policy/tolerance, and is
// classified as EXACTLY ONE of `contract`, `coordinate`, `precision`,
// `sampling`, `scheduling`, `color-space` or `unclassified`. The automatic
// classifier only emits a category when the evidence is sound; anything else
// is `unclassified` and requires a human to choose one of the six.

import { POLICY_TABLE, policyFor } from "./catalog.mjs";

// #30: the fixed +/-5e-4 shadow stability pre-check perturbation (an exact
// 0/1 GPU decision is undefined for razor edges that flip within the
// #25-height-tolerance margin between independently composed fields).
export const SHADOW_PERTURBATION = 5e-4;

export function createOracle(api) {
  const {
    surfaceHeight,
    computeNormals,
    computeVisibility,
    reconstructVisibility,
    sanitizeReconstructionOptions,
    shadePreparedFields,
    resolveMaterial,
    HostBuffer,
    HEIGHT_SPEC,
    OBJECT_ID_SPEC,
    NORMAL_SPEC,
    VISIBILITY_SPEC,
    NO_OWNER,
    DEFAULT_IOR,
    sanitizeNormalOptions,
    sanitizeShadowOptions,
    sanitizeAmbient,
    compositePixelBytes,
    compositeShadowPremultipliedBytes,
    compositeShadowPremultipliedStrengthBytes,
  } = api;

  /** DPR 1/1.5/2 sampling scales (scale = 0.5 * dpr), matching the catalog. */
  const DPR_NORMAL_OPTIONS = {
    1: { scaleX: 0.5, scaleY: 0.5, normalScale: 1 },
    1.5: { scaleX: 0.75, scaleY: 0.75, normalScale: 1 },
    2: { scaleX: 1, scaleY: 1, normalScale: 1 },
  };

  // -------------------------------------------------------------------------
  // CPU oracle: the semantic reference (mirrors composeHeightField exactly,
  // sampling render texels at ((tx + 0.5) / dpr, (ty + 0.5) / dpr))
  // -------------------------------------------------------------------------

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
   * at the same render extent and the same effective options.
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
   * #27/#41 CPU visibility oracle: the ACTUAL TypeScript `computeVisibility`
   * fed with the CPU reference height, caster-height and object-id fields at
   * the same render extent, the same f32-packed light direction the GPU reads
   * from the header uniform, the same DPR, the light's f32 angular radius
   * (#41) and the SAME effective (sanitized, f32-rounded) options. Returns
   * the field as a Float32Array — binary 0/1 on the hard path, dyadic
   * fractions on the #41 soft path.
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
        // #41: keep the light size so the oracle samples the same cone
        angularRadius: Math.fround(scene.light.angularRadius ?? 0),
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
   * perturbations instead exercise both worst-case margins between
   * independently composed GPU fields. A decision that flips is a razor edge
   * on which exact 0/1 parity is not defined, so the fixture fails
   * deterministically. `exactThreshold` opts out only for deliberate equality
   * pins whose purpose is the zero-margin strict-comparison boundary itself.
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
    // ShadowPass reads the encoded caster flags and exits all-lit when no
    // surface casts. `computeVisibility` also supports free-standing
    // synthetic height fields, so it cannot infer that integrated-scene
    // condition itself; mirror the pass contract before calling the actual
    // TypeScript oracle for scenes that do contain casters.
    if (!scene.surfaces.some((surface) => surface.castsShadow)) {
      return new Float32Array(rw * rh).fill(1);
    }
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
            `receiver-down/caster-up ${receiverDownCasterUp[g]}); exact GPU parity is not defined`,
        );
      }
    }
    return base;
  }

  /**
   * #43 reconstructed-visibility CPU oracle: the ACTUAL TypeScript
   * `reconstructVisibility` (the semantic reference for the GPU
   * ReconstructionPass) applied to the raw #41 visibility oracle field.
   * The filter arithmetic is exact (dyadic visibility values, fixed tap
   * order, uniform weights), so the comparison policy for the reconstructed
   * field is the SAME zero-tolerance exact equality as raw visibility — the
   * two values must be bit-identical on both backends.
   */
  function reconstructionOracle(
    scene,
    rw,
    rh,
    height,
    objectId,
    rawVisibility,
    dpr,
    reconOptions,
  ) {
    if (!scene.surfaces.some((surface) => surface.castsShadow)) {
      return rawVisibility;
    }
    const load = (spec, data, channels) => {
      const buf = new HostBuffer(spec(rw, rh));
      for (let g = 0; g < rw * rh; g++) {
        for (let c = 0; c < channels; c++) {
          buf.set(g % rw, Math.floor(g / rw), c, data[g * channels + c]);
        }
      }
      return buf;
    };
    const recon = reconstructVisibility(
      load(VISIBILITY_SPEC, rawVisibility, 1),
      load(HEIGHT_SPEC, height, 1),
      { objectId: load(OBJECT_ID_SPEC, objectId, 1), dpr },
      reconOptions ?? {},
    );
    const out = new Float32Array(rw * rh);
    for (let g = 0; g < rw * rh; g++) {
      out[g] = recon.get(g % rw, Math.floor(g / rw), 0);
    }
    return out;
  }

  /**
   * #43 effective reconstruction options as the GPU pipeline derives them
   * for one frame: sanitized with the render DPR, so the oracle and the
   * shader consume the identical texel radius.
   */
  function effectiveReconstructionOptions(scene, dpr, rawOptions) {
    return sanitizeReconstructionOptions(rawOptions ?? {}, Math.fround(dpr));
  }

  /**
   * #28 CPU lighting oracle: the ACTUAL TypeScript `shadePreparedFields` (the
   * semantic reference and CPU fallback, never a second copy of the formulas)
   * fed with the CPU reference normal/objectId fields at the same render
   * extent, the f32-packed scene values (light direction, intensity, exposure
   * and environment exactly as the encoder wrote them), the STABLE CPU
   * visibility oracle and the effective ambient. Returns the diffuse,
   * specular and RGBA8 color fields.
   */
  function lightingOracleCPU(scene, rw, rh, normal, objectId, visibility, options) {
    const f32Materials = Object.fromEntries(
      [...new Set(scene.surfaces.map((surface) => surface.material))].map((ref) => {
        const material = resolveMaterial(scene.materials, ref);
        return [
          ref,
          {
            baseColor: {
              r: Math.fround(material.baseColor.r),
              g: Math.fround(material.baseColor.g),
              b: Math.fround(material.baseColor.b),
            },
            roughness: Math.fround(material.roughness),
            metallic: Math.fround(material.metallic),
            ior: Math.fround(material.ior ?? DEFAULT_IOR),
          },
        ];
      }),
    );
    const oracleScene = {
      ...scene,
      materials: f32Materials,
      light: {
        direction: {
          x: Math.fround(scene.light.direction.x),
          y: Math.fround(scene.light.direction.y),
          z: Math.fround(scene.light.direction.z),
        },
        intensity: Math.fround(scene.light.intensity),
      },
      exposure: Math.fround(scene.exposure),
      environment: {
        intensity: Math.fround(scene.environment.intensity),
        diffuseIntensity: Math.fround(scene.environment.diffuseIntensity),
        specularIntensity: Math.fround(scene.environment.specularIntensity),
      },
    };
    const load = (spec, data, channels) => {
      const buf = new HostBuffer(spec(rw, rh));
      for (let g = 0; g < rw * rh; g++) {
        for (let c = 0; c < channels; c++) {
          buf.set(g % rw, Math.floor(g / rw), c, data[g * channels + c]);
        }
      }
      return buf;
    };
    const shaded = shadePreparedFields(
      oracleScene,
      {
        normal: load(NORMAL_SPEC, normal, 3),
        objectId: load(OBJECT_ID_SPEC, objectId, 1),
        visibility: load(VISIBILITY_SPEC, visibility, 1),
      },
      options,
    );
    const diffuse = new Float32Array(rw * rh);
    const specular = new Float32Array(rw * rh);
    const color = new Uint8Array(rw * rh * 4);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const g = y * rw + x;
        diffuse[g] = shaded.diffuse.get(x, y, 0);
        specular[g] = shaded.specular.get(x, y, 0);
        for (let c = 0; c < 4; c++) {
          color[g * 4 + c] = shaded.color.get(x, y, c);
        }
      }
    }
    return { diffuse, specular, color };
  }

  // -------------------------------------------------------------------------
  // Comparison helpers. Every mismatch is recorded with fixture ID, semantic
  // categories, pass/buffer, dimensions/DPR, relevant parameters,
  // coordinate/index, CPU value, GPU value, delta and policy/tolerance, and
  // is classified exactly once (see classifyMismatch).
  // -------------------------------------------------------------------------

  function mismatchReport(fixture, buffer, index, width, cpu, gpu, delta, context = {}) {
    const policyName = buffer.startsWith("canvas-frame-") ? "canvas" : buffer;
    const policy = policyFor(policyName);
    const classification = classifyMismatch(policyName, context);
    const x = index % width;
    const y = Math.floor(index / width);
    const logical = fixture.logical ?? { width, height: Math.ceil((index + 1) / width) };
    const render = fixture.render ?? logical;
    return (
      `fixture=${fixture.id} categories=${JSON.stringify(fixture.categories ?? [])} ` +
      `pass/buffer=${buffer} dimensions=logical:${logical.width}x${logical.height},` +
      `render:${render.width}x${render.height},dpr:${fixture.dpr ?? 1} ` +
      `params=${JSON.stringify(fixture.params ?? {})} coordinate=(${x},${y}) index=${index} ` +
      `cpu=${JSON.stringify(cpu)} gpu=${JSON.stringify(gpu)} delta=${JSON.stringify(delta)} ` +
      `policy=${policy?.policy ?? "unclassified"} tolerance=${policy?.tolerance ?? "n/a"} ` +
      `classification=${classification}`
    );
  }

  /** The effective shadow options exactly as the GPU pass computes them. */
  function effectiveShadowOptions(scene, dpr, rawOptions) {
    const dprF = Math.fround(dpr);
    const rw = Math.max(1, Math.floor(scene.width * dprF));
    const rh = Math.max(1, Math.floor(scene.height * dprF));
    const sceneDiagonal = Math.hypot(rw / dprF, rh / dprF);
    const lightXYLength = Math.hypot(
      Math.fround(scene.light.direction.x),
      Math.fround(scene.light.direction.y),
    );
    return sanitizeShadowOptions(rawOptions, { sceneDiagonal, lightXYLength });
  }

  function compareFixture(fixture, oracle, gpu) {
    const texels = oracle.rw * oracle.rh;
    let mismatches = 0;
    const samples = [];
    const classified = {};
    const recordClassification = (buffer, context) => {
      const category = classifyMismatch(buffer, context);
      classified[category] = (classified[category] ?? 0) + 1;
    };
    for (let g = 0; g < texels; g++) {
      const covBad = gpu.coverage[g] !== oracle.coverage[g];
      const objBad = gpu.objectId[g] !== oracle.objectId[g];
      const matBad = gpu.materialId[g] !== oracle.materialId[g];
      const dh = Math.abs(gpu.height[g] - oracle.height[g]);
      const heightBad = !(dh <= policyFor("height").tolerance);
      let coordinateShift = false;
      if (covBad || objBad || matBad || heightBad) {
        mismatches += 1;
        if (covBad) {
          recordClassification("coverage", {});
        }
        if (objBad) {
          recordClassification("objectId", {});
        }
        if (matBad) {
          recordClassification("materialId", {});
        }
        if (heightBad) {
          // coordinate-shift evidence: the GPU value matches a 1-texel
          // neighbor of the CPU height within tolerance (an off-by-one
          // spatial offset), otherwise the mismatch is numeric
          const tx = g % oracle.rw;
          const ty = Math.floor(g / oracle.rw);
          const neighbors = [];
          if (tx > 0) neighbors.push(g - 1);
          if (tx < oracle.rw - 1) neighbors.push(g + 1);
          if (ty > 0) neighbors.push(g - oracle.rw);
          if (ty < oracle.rh - 1) neighbors.push(g + oracle.rw);
          for (const n of neighbors) {
            if (Math.abs(gpu.height[g] - oracle.height[n]) <= policyFor("height").tolerance) {
              coordinateShift = true;
              break;
            }
          }
          recordClassification("height", { coordinateShift });
        }
        if (samples.length < 8) {
          if (covBad) samples.push(mismatchReport(fixture, "coverage", g, oracle.rw, oracle.coverage[g], gpu.coverage[g], gpu.coverage[g] - oracle.coverage[g]));
          if (objBad && samples.length < 8) samples.push(mismatchReport(fixture, "objectId", g, oracle.rw, oracle.objectId[g], gpu.objectId[g], gpu.objectId[g] - oracle.objectId[g]));
          if (matBad && samples.length < 8) samples.push(mismatchReport(fixture, "materialId", g, oracle.rw, oracle.materialId[g], gpu.materialId[g], gpu.materialId[g] - oracle.materialId[g]));
          if (heightBad && samples.length < 8) samples.push(mismatchReport(fixture, "height", g, oracle.rw, oracle.height[g], gpu.height[g], dh, { coordinateShift }));
        }
      }
    }
    return { name: fixture.id, texels, mismatches, samples, classified };
  }

  /**
   * #26 normal comparison: all xyz components, finite values, unit-length
   * vectors, and the explicit component tolerance. Reports the measured
   * maximum component and length errors (always surfaced in the summary).
   */
  function compareNormals(fixture, oracle, gpu, width) {
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
      if (!finite || lengthError > policyFor("normal").tolerance || componentError > policyFor("normal").tolerance) {
        mismatches += 1;
        if (samples.length < 8) {
          samples.push(mismatchReport(
            fixture,
            "normal",
            g,
            width,
            [oracle[i], oracle[i + 1], oracle[i + 2]],
            [x, y, z],
            { componentError, lengthError, finite },
          ));
        }
      }
    }
    return { mismatches, samples, maxComponentError, maxLengthError };
  }

  /**
   * #27/#41 visibility comparison: EXACT equality against the oracle plus a
   * finite audit of every GPU value. Hard fixtures additionally require the
   * binary 0/1 domain; #41 soft fixtures accept the dyadic fractions (the
   * comparison stays EXACT — no tolerance: a 0.99999 or a flipped texel is
   * a mismatch).
   */
  function compareVisibility(fixture, oracle, gpu, width) {
    const softMode =
      (fixture.shadowOptions?.samples ?? 0) > 1 &&
      Math.fround(fixture.scene?.light?.angularRadius ?? 0) > 0;
    const texels = oracle.length;
    let mismatches = 0;
    const samples = [];
    for (let g = 0; g < texels; g++) {
      const v = gpu[g];
      const bad =
        !Number.isFinite(v)
          ? `non-finite ${v}`
          : softMode
            ? v < 0 || v > 1
              ? `out of [0,1]: ${v}`
              : v === oracle[g]
                ? null
                : `!= oracle ${oracle[g]}`
            : v !== 0 && v !== 1
              ? `non-binary/non-finite ${v}`
              : v === oracle[g]
                ? null
                : `!= oracle ${oracle[g]}`;
      if (bad !== null) {
        mismatches += 1;
        if (samples.length < 8) {
          samples.push(mismatchReport(fixture, "visibility", g, width, oracle[g], v, v - oracle[g]));
        }
      }
    }
    return { mismatches, samples };
  }

  /** #27 caster-height comparison: the tight #25 tolerance plus the max error. */
  function compareCasterHeight(fixture, oracle, gpu, width) {
    const texels = oracle.length;
    let mismatches = 0;
    let maxError = 0;
    const samples = [];
    for (let g = 0; g < texels; g++) {
      const dh = Math.abs(gpu[g] - oracle[g]);
      maxError = Math.max(maxError, dh);
      if (!(dh <= policyFor("casterHeight").tolerance) || !Number.isFinite(gpu[g])) {
        mismatches += 1;
        if (samples.length < 8) {
          samples.push(mismatchReport(fixture, "casterHeight", g, width, oracle[g], gpu[g], dh));
        }
      }
    }
    return { mismatches, maxError, samples };
  }

  /**
   * #28 diffuse/specular comparison: every value must be finite and within
   * the explicit tight f32 tolerance; reports the measured maximum errors.
   */
  function compareLightingF32(fixture, buffer, oracle, gpu, width) {
    const texels = oracle.length;
    let mismatches = 0;
    let maxError = 0;
    const samples = [];
    for (let g = 0; g < texels; g++) {
      const d = Math.abs(gpu[g] - oracle[g]);
      maxError = Math.max(maxError, d);
      if (!Number.isFinite(gpu[g]) || !(d <= policyFor(buffer).tolerance)) {
        mismatches += 1;
        if (samples.length < 8) {
          samples.push(mismatchReport(fixture, buffer, g, width, oracle[g], gpu[g], d));
        }
      }
    }
    return { mismatches, maxError, samples };
  }

  /**
   * #28 RGBA8 color comparison. Byte order R, G, B, A is enforced by the
   * comparison itself (the GPU u32 packing is read back little-endian, the
   * oracle writes R,G,B,A per texel). Alpha must be EXACTLY 255 on both sides.
   * Each texel may differ in AT MOST ONE encoded byte, and that byte by AT
   * MOST ONE unit (a documented f32-vs-f64 rounding justification); any
   * larger difference or any second differing channel is a hard mismatch.
   * Reports the per-channel maximum deltas.
   */
  function compareColor(fixture, oracle, gpu, width) {
    const texels = oracle.length / 4;
    let hard = 0;
    let soft = 0;
    let alphaBad = 0;
    const maxDelta = [0, 0, 0, 0];
    const samples = [];
    for (let g = 0; g < texels; g++) {
      const i = g * 4;
      let diffs = 0;
      let maxd = 0;
      for (let ch = 0; ch < 4; ch++) {
        const d = Math.abs(gpu[i + ch] - oracle[i + ch]);
        maxDelta[ch] = Math.max(maxDelta[ch], d);
        maxd = Math.max(maxd, d);
        if (d > 0) {
          diffs += 1;
        }
      }
      const alpha = oracle[i + 3] !== 255 || gpu[i + 3] !== 255;
      if (maxd > 1 || diffs > 1 || alpha) {
        hard += 1;
        if (alpha) {
          alphaBad += 1;
        }
        if (samples.length < 8) {
          samples.push(mismatchReport(
            fixture,
            "lightingColor",
            g,
            width,
            Array.from(oracle.subarray(i, i + 4)),
            Array.from(gpu.subarray(i, i + 4)),
            Array.from({ length: 4 }, (_, ch) => Math.abs(gpu[i + ch] - oracle[i + ch])),
            { alphaMismatch: alpha },
          ));
        }
      } else if (diffs === 1) {
        soft += 1;
      }
    }
    return { hard, soft, alphaBad, maxDelta, samples };
  }

  /**
   * #29 canvas comparison: exact alpha and byte order (premultiplied RGBA8),
   * with the documented at-most-one-channel-by-one policy (the GPU storage
   * bytes -> f32 -> unorm round trip can flip one channel by one 8-bit step)
   * and per-channel maxima always reported.
   */
  function compareCanvas(fixture, reference, gpu, width) {
    const texels = reference.length / 4;
    let hard = 0;
    let alphaBad = 0;
    const maxDelta = [0, 0, 0, 0];
    const samples = [];
    for (let g = 0; g < texels; g++) {
      const i = g * 4;
      let diffs = 0;
      let maxd = 0;
      for (let ch = 0; ch < 4; ch++) {
        const d = Math.abs(gpu[i + ch] - reference[i + ch]);
        maxDelta[ch] = Math.max(maxDelta[ch], d);
        maxd = Math.max(maxd, d);
        if (d > 0) {
          diffs += 1;
        }
      }
      const alpha = Math.abs(gpu[i + 3] - reference[i + 3]) > 0;
      if (maxd > 1 || diffs > 1 || alpha) {
        hard += 1;
        if (alpha) {
          alphaBad += 1;
        }
        if (samples.length < 8) {
          samples.push(mismatchReport(
            fixture,
            "canvas",
            g,
            width,
            Array.from(reference.subarray(i, i + 4)),
            Array.from(gpu.subarray(i, i + 4)),
            Array.from({ length: 4 }, (_, ch) => Math.abs(gpu[i + ch] - reference[i + ch])),
            { alphaMismatch: alpha },
          ));
        }
      }
    }
    return { hard, alphaBad, maxDelta, samples };
  }

  // -------------------------------------------------------------------------
  // #30 mismatch classification: exactly one of contract / coordinate /
  // precision / sampling / scheduling / color-space, or unclassified. The
  // automatic rules only fire on sound evidence; anything else requires a
  // human to choose one of the six.
  // -------------------------------------------------------------------------

  /**
   * Classify a mismatch for one buffer/texel. `context.oracle` may provide
   * the CPU height field so a coordinate (1-2 texel spatial) shift can be
   * detected; when absent, only the buffer-level rules apply.
   */
  function classifyMismatch(buffer, context = {}) {
    const explicit = context.classification;
    if (["contract", "coordinate", "precision", "sampling", "scheduling", "color-space"].includes(explicit)) {
      return explicit;
    }
    const exactSemantic = new Set([
      "encodedHeader",
      "coverage",
      "objectId",
      "materialId",
      "visibility",
    ]);
    if (exactSemantic.has(buffer)) {
      return "contract"; // semantic invariants diverged (no tolerance involved)
    }
    if (buffer === "height" || buffer === "casterHeight") {
      if (context.coordinateShift === true) {
        return "coordinate";
      }
      return "precision";
    }
    if (buffer === "normal" || buffer === "diffuse" || buffer === "specular") {
      return "precision";
    }
    if (buffer === "lightingColor" || buffer === "canvas" || (typeof buffer === "string" && buffer.startsWith("canvas-frame-"))) {
      return context.alphaMismatch === true ? "color-space" : "precision";
    }
    if (typeof buffer === "string" && buffer.endsWith("mutation")) {
      return "scheduling"; // an upstream buffer changed during a dispatch
    }
    return "unclassified";
  }

  // -------------------------------------------------------------------------
  // #30 static-CPU-golden canonicalization.
  // -------------------------------------------------------------------------

  /**
   * Canonical f32 bytes for one value: -0 -> +0, non-finite -> a fixed token,
   * then quantize with `tolerance` (round(v / tolerance) * tolerance) and
   * write the result as little-endian f32. With `tolerance === 0` the raw
   * value is written (used only by exact buffers, which are hashed as
   * integer bytes instead).
   */
  function canonicalF32(value, tolerance) {
    let v = value;
    if (v !== v) {
      return 0x7fc00000; // canonical NaN
    }
    if (v === Infinity) {
      return 0x7f800000;
    }
    if (v === -Infinity) {
      return 0xff800000;
    }
    if (Object.is(v, -0)) {
      v = 0;
    }
    if (tolerance > 0) {
      v = Math.round(v / tolerance) * tolerance;
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, v, true);
    return new DataView(bytes.buffer).getUint32(0, true);
  }

  /**
   * Canonical little-endian bytes for a whole buffer.
   *
   * - `kind: "u32"` -> little-endian uint32 bytes (canonical, no tolerance)
   * - `kind: "u8"` -> the raw bytes
   * - `kind: "f32"` -> canonicalized/quantized little-endian f32 bytes
   */
  function canonicalBufferBytes(kind, data, tolerance) {
    if (kind === "u32") {
      const bytes = new Uint8Array(data.length * 4);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < data.length; i++) {
        view.setUint32(i * 4, data[i], true);
      }
      return bytes;
    }
    if (kind === "u8") {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (kind === "f32") {
      const bytes = new Uint8Array(data.length * 4);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < data.length; i++) {
        view.setUint32(i * 4, canonicalF32(data[i], tolerance), true);
      }
      return bytes;
    }
    throw new Error(`canonicalBufferBytes: unknown kind "${kind}"`);
  }

  /** The canonical digest payload metadata for one fixture (dimensions/DPR/params embedded). */
  function canonicalPayloadMeta(fixture) {
    return JSON.stringify({
      format: "ukibori-cpu-golden-v1",
      id: fixture.id,
      categories: [...fixture.categories].sort(),
      logical: fixture.logical,
      render: fixture.render,
      dpr: fixture.dpr,
      params: fixture.params,
    });
  }

  /** SHA-256 hex digest (WebCrypto when available, node:crypto fallback). */
  async function sha256Hex(bytes) {
    if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle !== undefined) {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
    }
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(bytes).digest("hex");
  }

  /** Buffer digest: canonical payload metadata + canonical buffer bytes. */
  async function bufferDigest(fixture, name, kind, data, tolerance) {
    const meta = new TextEncoder().encode(canonicalPayloadMeta(fixture) + `\nbuffer ${name}\n`);
    const bytes = canonicalBufferBytes(kind, data, tolerance);
    const combined = new Uint8Array(meta.length + bytes.length);
    combined.set(meta, 0);
    combined.set(bytes, meta.length);
    return sha256Hex(combined);
  }

  /**
   * Human-readable probes for a buffer: a few deterministic coordinates and
   * values (first texel, center, last texel and the max-|value| texel for
   * scalar buffers) so a golden diff is understandable without a binary dump.
   */
  function probesFor(name, kind, data, rw, rh) {
    const out = [];
    const texels = rw * rh;
    const candidates = [
      { x: 0, y: 0, label: "first" },
      { x: Math.floor(rw / 2), y: Math.floor(rh / 2), label: "center" },
      { x: rw - 1, y: rh - 1, label: "last" },
    ];
    if (kind === "u8") {
      for (const c of candidates) {
        const i = (c.y * rw + c.x) * 4;
        out.push({
          x: c.x,
          y: c.y,
          v: `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`,
        });
      }
      return out;
    }
    const channels = kind === "u32" ? 1 : kind === "f32" && (name === "normal") ? 3 : 1;
    for (const c of candidates) {
      const i = (c.y * rw + c.x) * channels;
      const parts = [];
      for (let ch = 0; ch < channels; ch++) {
        parts.push(probeValue(data[i + ch]));
      }
      out.push({ x: c.x, y: c.y, v: parts.join(",") });
    }
    if (channels === 1 && texels > 0) {
      let best = 0;
      let bestV = 0;
      for (let g = 0; g < texels; g++) {
        const v = data[g];
        if (Math.abs(v) > Math.abs(bestV)) {
          best = g;
          bestV = v;
        }
      }
      out.push({ x: best % rw, y: Math.floor(best / rw), v: probeValue(bestV), label: "maxAbs" });
    }
    return out;
  }

  function probeValue(v) {
    if (v !== v) {
      return "NaN";
    }
    if (v === Infinity) {
      return "Infinity";
    }
    if (v === -Infinity) {
      return "-Infinity";
    }
    return Number(v.toPrecision(9));
  }

  // -------------------------------------------------------------------------
  // #29 CPU reference for the presented canvas: the actual shared compositor
  // semantics (`compositePixelBytes` — the DOM path's exact per-texel
  // decision — with `compositeShadowPremultipliedBytes` as the premultiplied
  // shadow form the `alphaMode: "premultiplied"` canvas receives), composed
  // from the CPU oracle fields. No second formula copy.
  // -------------------------------------------------------------------------

  function presentationReference(scene, dpr, effectiveShadowOptions, ambient, compositeOptions, reconstructionOptions) {
    const oracle = cpuOracle(scene, dpr);
    const casterOracle = cpuCasterOracle(scene, dpr);
    const normal = normalOracle(
      oracle.height,
      oracle.rw,
      oracle.rh,
      sanitizeNormalOptions(DPR_NORMAL_OPTIONS[dpr] ?? {}),
    );
    const rawVisibility = stableShadowOracle(
      scene,
      oracle.rw,
      oracle.rh,
      oracle.height,
      casterOracle.height,
      oracle.objectId,
      dpr,
      effectiveShadowOptions,
    );
    // #43: the GPU pipeline reconstructs the soft visibility field before
    // lighting/presentation whenever the soft path is active and
    // reconstruction is enabled (default). The reference must mirror that
    // decision exactly; hard-path frames keep the raw {0,1} bytes.
    const softActive =
      Math.fround(scene.light.angularRadius ?? 0) > 0 &&
      (effectiveShadowOptions.samples ?? 8) > 1;
    const reconOptions = sanitizeReconstructionOptions(reconstructionOptions ?? {}, Math.fround(dpr));
    const visibility =
      softActive && reconOptions.enabled && reconOptions.radiusTexels > 0
        ? reconstructionOracle(
            scene,
            oracle.rw,
            oracle.rh,
            oracle.height,
            oracle.objectId,
            rawVisibility,
            dpr,
            reconstructionOptions,
          )
        : rawVisibility;
    const lighting = lightingOracleCPU(
      scene,
      oracle.rw,
      oracle.rh,
      normal,
      oracle.objectId,
      visibility,
      { ambient },
    );
    const ref = new Uint8Array(oracle.rw * oracle.rh * 4);
    for (let g = 0; g < oracle.rw * oracle.rh; g++) {
      const i = g * 4;
      const owner = oracle.objectId[g];
      // the shared DOM-compositor decision (opaque surface / transparent lit
      // base plane / translucent shadow tint)
      const decision = compositePixelBytes(
        owner,
        lighting.color[i],
        lighting.color[i + 1],
        lighting.color[i + 2],
        visibility[g],
        compositeOptions,
      );
      // the canvas is premultiplied: the base-plane shadow tint scales with
      // the #41 CONTINUOUS occlusion strength (1 - vis) — both alpha and the
      // premultiplied RGB — mirroring the WGSL exactly. Hard inputs ({0, 1})
      // reproduce the historical binary bytes; surface texels (alpha 1) and
      // fully-lit base plane ((0,0,0,0)) are unchanged by premultiplication.
      let px = decision;
      if (owner === NO_OWNER) {
        px = compositeShadowPremultipliedStrengthBytes(1 - visibility[g], compositeOptions);
      }
      ref.set(px, i);
    }
    return { ref, texels: oracle.rw * oracle.rh, rw: oracle.rw, rh: oracle.rh };
  }

  /** bytesEqual helper shared by the mutation audits. */
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

  return {
    // oracles
    cpuOracle,
    normalOracle,
    cpuCasterOracle,
    shadowOracleCPU,
    stableShadowOracle,
    reconstructionOracle,
    effectiveReconstructionOptions,
    lightingOracleCPU,
    presentationReference,
    effectiveShadowOptions,
    bytesEqual,
    // comparisons
    compareFixture,
    compareNormals,
    compareVisibility,
    compareCasterHeight,
    compareLightingF32,
    compareColor,
    compareCanvas,
    mismatchReport,
    // classification
    classifyMismatch,
    // sanitizers for the golden computation (the same effective values the
    // GPU passes derive from the raw options)
    sanitizerApi: {
      sanitizeNormalOptions,
      sanitizeShadowOptions,
      sanitizeReconstructionOptions,
      sanitizeAmbient,
    },
    // canonicalization (static CPU goldens)
    canonicalF32,
    canonicalBufferBytes,
    canonicalPayloadMeta,
    bufferDigest,
    sha256Hex,
    probesFor,
    // policy helper (re-export for convenience)
    POLICY_TABLE,
    policyFor,
  };
}
