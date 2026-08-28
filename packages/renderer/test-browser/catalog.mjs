// #30 golden fixture catalog.
//
// The single source of truth for the parity fixture set. Every fixture has a
// STABLE ID and explicit metadata:
//
//   - `id`: stable fixture identifier (never reused; renaming a fixture is a
//     catalog version change)
//   - `categories`: semantic categories covered (controlled vocabulary in
//     CATEGORIES; REQUIRED_COVERAGE pins the brief coverage list)
//   - `dpr`: device pixel ratio (1 / 1.5 / 2)
//   - `scene` / synthetic dims / `renders`: the concrete geometry, light,
//     environment, exposure and material parameters (finalized into `params`)
//   - `options`: normal/shadow/lighting/composite options (finalized)
//   - `buffers`: the buffers compared for the fixture and their comparison
//     policy (looked up in the central POLICY_TABLE)
//   - `golden`: when true, static CPU golden digests are checked in for every
//     compared buffer under `goldens/cpu-goldens.json`
//
// The catalog is versioned: bump CATALOG_VERSION when a fixture changes so a
// stale digest can never be silently preserved. The canonical golden payload
// additionally embeds logical/render dimensions, DPR and the full relevant
// parameter set, so a dimension/parameter change cannot preserve a stale
// digest accidentally.
//
// Scene construction mirrors the pre-#30 harness exactly; no scene feature is
// invented here. Only translation/size (position/size) and DPR transforms are
// supported by the scene contract —there is NO rotation/skew support, and
// the catalog never claims any.

export const CATALOG_VERSION = 6;

// ---------------------------------------------------------------------------
// Central comparison policy table (#30). One declaration, used by the
// browser harness, the static-CPU-golden canonicalization and every report.
// ---------------------------------------------------------------------------

export const POLICY_TABLE = Object.freeze([
  {
    buffer: "encodedHeader",
    policy: "exact",
    tolerance: 0,
    description: "encoded scene/header bytes: exact (the #24 frozen ABI)",
  },
  {
    buffer: "coverage",
    policy: "exact",
    tolerance: 0,
    description: "coverage: exact unless an already-fixed contract says otherwise",
  },
  {
    buffer: "objectId",
    policy: "exact",
    tolerance: 0,
    description: "object ID: exact",
  },
  {
    buffer: "materialId",
    policy: "exact",
    tolerance: 0,
    description: "material ID: exact",
  },
  {
    buffer: "visibility",
    policy: "exact-0-1",
    tolerance: 0,
    description:
      "#17/#41 shadow visibility: exact equality, no tolerance. HARD shadow " +
      "(angularRadius 0 or samples 1): exact binary 0/1. SOFT shadow (#41 " +
      "area-light sampling): exact deterministic [0,1] fractional visibility " +
      "(dyadic k/n fractions of identical f32 cone rays on both backends)",
  },
  {
    buffer: "visibility-reconstructed",
    policy: "reconstructed-abs-tolerance",
    tolerance: 1e-6,
    description:
      "#43 reconstructed visibility: SEPARATE tight policy from raw #41. " +
      "The gated tap average sum/tapCount is NOT dyadic (3/25, 7/49, ...), " +
      "so the CPU's exact f64 quotient rounded to f32 once and the GPU's " +
      "f32 accumulation must NOT be promised bit-identical across legal " +
      "WebGPU backends. Every value must be finite and inside [0,1] with " +
      "|gpu - cpu| <= 1e-6 (~16-30 f32 ulp —evidence-driven; the ULP " +
      "simulation measures 0 ulp for the exact dyadic accumulation and the " +
      "headroom covers backend division rounding); max abs/ULP errors are " +
      "reported so regressions surface even under the tolerance.",
  },
  {
    buffer: "height",
    policy: "abs-tolerance",
    tolerance: 1e-4,
    description: "height: existing absolute tolerance (1e-4, #25)",
  },
  {
    buffer: "casterHeight",
    policy: "abs-tolerance",
    tolerance: 1e-4,
    description: "caster height: existing absolute tolerance (1e-4, #27)",
  },
  {
    buffer: "normal",
    policy: "component-length-tolerance",
    tolerance: 1e-4,
    description: "normals: existing component and length tolerances (1e-4, #26)",
  },
  {
    buffer: "diffuse",
    policy: "abs-tolerance",
    tolerance: 1e-3,
    description: "diffuse: existing absolute tolerance (1e-3, #28)",
  },
  {
    buffer: "specular",
    policy: "abs-tolerance",
    tolerance: 1e-3,
    description: "specular: existing absolute tolerance (1e-3, #28)",
  },
  {
    buffer: "lightingColor",
    policy: "rgba8",
    tolerance: 1,
    description:
      "packed lighting RGBA8: exact for stable fixtures, otherwise only the " +
      "documented at-most-one-channel-by-one allowance, with exact alpha",
  },
  {
    buffer: "canvas",
    policy: "canvas-rgba8",
    tolerance: 1,
    description:
      "final normalized premultiplied canvas RGBA8: exact alpha and the " +
      "documented at-most-one-channel-by-one color-byte policy (#29)",
  },
]);

export function policyFor(bufferName) {
  return POLICY_TABLE.find((entry) => entry.buffer === bufferName) ?? null;
}

// ---------------------------------------------------------------------------
// Semantic category vocabulary and the required brief coverage.
// ---------------------------------------------------------------------------

export const CATEGORIES = Object.freeze([
  // shapes / profiles
  "analytic-shape",
  "rounded-surface",
  "bevel",
  "no-bevel",
  "mask-shape",
  "glyph-shape",
  // transform / ownership / order
  "translation",
  "resize",
  "overlap",
  "ownership-tie",
  "paint-order",
  "clipping",
  "offscreen",
  // scene states
  "empty-scene",
  "unowned-lit-background",
  "opaque-owned-pixels",
  "translucent-shadow-pixels",
  // dpr / extents
  "dpr-1",
  "dpr-1.5",
  "dpr-2",
  "fractional-extent",
  // buffers
  "height-field",
  "coverage",
  "object-id",
  "material-id",
  "caster-height",
  // normals
  "normal-flat",
  "normal-edge-bevel",
  "normal-boundary",
  "normal-synthetic",
  "extreme-f32",
  "subnormal",
  // shadow
  "shadow-visibility",
  "shadow-no-shadow-vertical",
  "shadow-opposing-directions",
  "shadow-occluder-receiver-separation",
  "shadow-max-distance",
  "shadow-options",
  "shadow-synthetic",
  // #41 area-light soft shadows
  "soft-shadow",
  "penumbra-separation",
  "sampling-boundary",
  "threshold-equality",
  // #43 edge-aware visibility reconstruction
  "reconstruction",
  "cast-flag",
  "receive-flag",
  // lighting / environment / exposure
  "lighting",
  "light-color",
  "material-silicone",
  "material-matte",
  "material-metal",
  "material-base",
  "material-override",
  "light-direction-change",
  "environment-off",
  "environment-on",
  "exposure-zero",
  "exposure-low",
  "exposure-default",
  "exposure-high",
  "exposure-extreme-finite",
  "lighting-options",
  "degenerate-half-vector",
  // canvas presentation
  "canvas-composition",
  "canvas-format-normalization",
  "canvas-transparency",
  "canvas-resize",
  "canvas-clipped-output",
  "composite-options",
  // static goldens
  "static-golden",
]);

/**
 * The brief's coverage list, expressed as category names. The structural
 * tests require every entry to be covered by at least one fixture.
 */
export const REQUIRED_COVERAGE = Object.freeze([
  "analytic-shape",
  "bevel",
  "mask-shape",
  "glyph-shape",
  "translation",
  "overlap",
  "ownership-tie",
  "paint-order",
  "clipping",
  "offscreen",
  "empty-scene",
  "unowned-lit-background",
  "opaque-owned-pixels",
  "translucent-shadow-pixels",
  "dpr-1",
  "dpr-1.5",
  "dpr-2",
  "fractional-extent",
  "height-field",
  "coverage",
  "object-id",
  "material-id",
  "caster-height",
  "normal-flat",
  "normal-edge-bevel",
  "normal-boundary",
  "shadow-visibility",
  "shadow-no-shadow-vertical",
  "shadow-opposing-directions",
  "shadow-occluder-receiver-separation",
  "shadow-max-distance",
  "material-silicone",
  "material-matte",
  "material-metal",
  "light-direction-change",
  "environment-off",
  "environment-on",
  "exposure-zero",
  "exposure-low",
  "exposure-default",
  "exposure-high",
  "exposure-extreme-finite",
  "canvas-composition",
  "canvas-format-normalization",
  "canvas-transparency",
  "canvas-resize",
  "canvas-clipped-output",
  "reconstruction",
]);

/** Buffers every integrated compute fixture compares (full-chain passes). */
export const COMPUTE_CHAIN_BUFFERS = Object.freeze([
  "height",
  "coverage",
  "objectId",
  "materialId",
  "casterHeight",
  "normal",
  "visibility",
  "diffuse",
  "specular",
  "lightingColor",
]);

// ---------------------------------------------------------------------------
// Catalog construction (the `api` is the renderer API object; the same
// catalog drives the browser harness and the Node golden tooling).
// ---------------------------------------------------------------------------

export function createCatalog(api) {
  const { createScene, encodeScene } = api;

  // largest finite f32 and the minimum positive subnormal (both f32-exact in
  // JS); used by the #26 extreme-normal fixtures
  const F32_MAX = 3.4028234663852886e38;
  const MIN_POSITIVE_SUBNORMAL = 1.401298464324817e-45;

  /** DPR 1/1.5/2 with explicit scene-unit sampling scales (scale = 0.5 * dpr). */
  const DPR_NORMAL_OPTIONS = {
    1: { scaleX: 0.5, scaleY: 0.5, normalScale: 1 },
    1.5: { scaleX: 0.75, scaleY: 0.75, normalScale: 1 },
    2: { scaleX: 1, scaleY: 1, normalScale: 1 },
  };

  // #27 shadow fixtures. All surfaces use integer positions/sizes and
  // f32-exact integer (or exact half/quarter) elevations and thicknesses, so
  // the composed full/caster fields are f32-exact on both the CPU oracle and
  // the GPU; decisions keep >= ~0.05 scene-unit margins (the harness also
  // runs the +/-5e-4 stability pre-check, which would reject any razor edge).
  // Lights use the fixed #13 sign convention (direction FROM the receiver
  // TOWARD the light).
  const LIGHT_FROM_RIGHT = { x: 0.70710678, y: 0, z: 0.70710678 };
  const LIGHT_FROM_LEFT = { x: -0.70710678, y: 0, z: 0.70710678 };
  const LIGHT_VERTICAL = { x: 0, y: 0, z: 1 };
  const LIGHT_NEAR_VERTICAL = { x: 0.1, y: 0, z: 0.995 };
  const LIGHT_HORIZONTAL = { x: 1, y: 0, z: 0 };
  const LIGHT_SHALLOW_LEFT = { x: -0.9, y: 0, z: 0.1 };
  const LIGHT_SELF_SHADOW = { x: 0.89442719, y: 0, z: 0.4472136 };

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

  /**
   * #41 area-light soft-shadow fixture: the light carries an angular radius
   * (radians) and the shadow options pin the deterministic sample count. The
   * slab elevation sets the caster/receiver separation that widens the
   * penumbra ring around the hard shadow.
   */
  function softShadowScene(angularRadius, samples, separation) {
    return {
      scene: createScene({
        width: 16,
        height: 16,
        surfaces: [shadowSurface({
          id: "slab",
          position: { x: 8, y: 2 },
          size: { x: 6, y: 2 },
          elevation: separation,
        })],
        light: { direction: LIGHT_FROM_RIGHT, intensity: 1, angularRadius },
      }),
      shadowOptions: { samples },
    };
  }

  /**
   * #43 reconstructed-soft-shadow fixture: the #41 soft scene with explicit
   * reconstruction options; the harness ALSO dispatches the real
   * ReconstructionPass and compares its output against the actual
   * TypeScript reconstructVisibility oracle (exact equality).
   */
  function softShadowReconstructionScene(angularRadius, samples, separation, radius) {
    return {
      ...softShadowScene(angularRadius, samples, separation),
      reconstructionOptions: { enabled: true, radius },
    };
  }

  /**
   * #43 PORTABLE reconstructed-canvas presentation scene (only used by the
   * `present-reconstructed-soft-shadow` canvas fixture).
   *
   * Reconstructed visibility is a NON-DYADIC tap average, so the
   * premultiplied canvas products (shadowAlpha x strength, tint x strength)
   * can land arbitrarily close to an 8-bit rounding boundary and flip by one
   * byte under the small unorm8 encode variance legal backends exhibit. This
   * scene + the fixture's composite options were chosen by sweeping
   * geometry/samples/radius/tint so that the measured minimum quantization
   * margin (see oracle.reconstructedCanvasQuantizationReport) is ~0.122 byte
   * units —comfortably above the observed ~0.057 flip envelope —while the
   * soft path, reconstruction (radius 3) and a visible shadow remain real.
   */
  function portableReconstructedScene(lightOverrides = {}) {
    return {
      scene: createScene({
        width: 16,
        height: 16,
        surfaces: [shadowSurface({
          id: "slab",
          position: { x: 8, y: 2 },
          size: { x: 4, y: 2 },
          elevation: 2,
        })],
        // #45: `lightOverrides` may carry a linear-RGB `color` (e.g. the
        // warm fixture) — createScene sanitizes it; the shadow/reconstruction
        // fields stay color-invariant.
        light: {
          direction: LIGHT_FROM_RIGHT,
          intensity: 1,
          angularRadius: Math.fround(0.25),
          ...lightOverrides,
        },
      }),
      shadowOptions: { samples: 8, reconstruction: { enabled: true, radius: 3 } },
    };
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
   * #41 soft variant of the mask/glyph caster: same geometry, cone-sampled
   * light. The penumbra ring exercises fractional visibility through the
   * mask SDF path on both backends.
   */
  function softShadowMaskCaster(angularRadius, samples) {
    return {
      scene: createScene({
        width: 16,
        height: 16,
        surfaces: [shadowSurface({
          id: "glyph",
          position: { x: 6, y: 6 },
          size: { x: 8, y: 8 },
          elevation: 4,
          shape: { kind: "mask", mask: { width: 4, height: 4, alpha: new Float32Array(16).fill(1) } },
        })],
        light: { direction: LIGHT_FROM_RIGHT, intensity: 1, angularRadius },
      }),
      shadowOptions: { samples },
    };
  }

  /**
   * #43 reconstructed variant of the mask/glyph caster: the glyph silhouette
   * must be preserved by the reconstruction's ownership/height edge gates —
   * the reconstructed field never bleeds across the glyph boundary.
   */
  function softShadowMaskCasterReconstruction(angularRadius, samples, radius) {
    return {
      ...softShadowMaskCaster(angularRadius, samples),
      reconstructionOptions: { enabled: true, radius },
    };
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
   * so the strict `>` comparison says LIT (equality) —while a naive f64
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
    {
      // #41 soft shadow cast by a MASK/GLYPH caster: exact fractional GPU
      // parity through the mask SDF path
      ...softShadowMaskCaster(Math.fround(0.25), 8),
      name: "shadow-soft-mask-caster",
      dpr: 1,
    },
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
    // #41 area-light soft shadows: the GPU visibility field must match the
    // CPU oracle EXACTLY (dyadic fractions of identical f32 cone rays).
    {
      ...softShadowScene(Math.fround(0.15), 8, 6),
      name: "shadow-soft-radius-0.15-samples-8",
      dpr: 1,
    },
    {
      ...softShadowScene(Math.fround(0.3), 16, 6),
      name: "shadow-soft-radius-0.3-samples-16",
      dpr: 1,
    },
    {
      ...softShadowScene(Math.fround(0.05), 4, 6),
      name: "shadow-soft-radius-0.05-samples-4",
      dpr: 1,
    },
    {
      // samples 1 forces the hard path even with a positive radius
      ...softShadowScene(Math.fround(0.3), 1, 6),
      name: "shadow-soft-samples-1-hard-compatible",
      dpr: 1,
    },
    {
      // taller caster = larger separation = wider penumbra ring
      ...softShadowScene(Math.fround(0.25), 8, 12),
      name: "shadow-soft-tall-caster-separation",
      dpr: 1,
    },
    // #43 edge-aware reconstruction of the raw soft field: 4-sample inputs
    // are noisy (layered hard shadows); the reconstructed field must match
    // the TypeScript reconstructVisibility oracle EXACTLY on the real GPU.
    {
      ...softShadowReconstructionScene(Math.fround(0.25), 4, 6, 2),
      name: "shadow-reconstruction-radius-0.25-samples-4-r2",
      dpr: 1,
    },
    {
      ...softShadowReconstructionScene(Math.fround(0.15), 8, 6, 2),
      name: "shadow-reconstruction-radius-0.15-samples-8-r2",
      dpr: 1,
    },
    {
      // larger caster/receiver separation: the reconstruction must follow
      // the physical penumbra widening (never a fixed blur)
      ...softShadowReconstructionScene(Math.fround(0.25), 8, 12, 3),
      name: "shadow-reconstruction-tall-separation-r3",
      dpr: 1,
    },
    {
      ...softShadowMaskCasterReconstruction(Math.fround(0.25), 8, 2),
      name: "shadow-reconstruction-mask-caster-r2",
      dpr: 1,
    },
    // #43 DPR coverage: the same CSS scene at 1.5 / 2 render DPR must
    // produce the same CSS-space reconstruction footprint (radius in scene
    // units, texel conversion round(radius * dpr) exactly once).
    // NOTE: separation 10 (not the 6 used by the DPR-1 soft fixtures): at
    // separation 6 the dpr-2 grid puts a penumbra edge exactly on a texel
    // center, so the CPU oracle's razor-edge stability pre-check
    // (stableShadowOracle) correctly refuses to certify exact parity there.
    // Separation 10 keeps both DPRs clear of every razor edge (verified via
    // the oracle itself) while still exercising the DPR-invariant footprint.
    {
      ...softShadowReconstructionScene(Math.fround(0.2), 8, 10, 2),
      name: "shadow-reconstruction-dpr1.5",
      dpr: 1.5,
    },
    {
      ...softShadowReconstructionScene(Math.fround(0.2), 8, 10, 2),
      name: "shadow-reconstruction-dpr2",
      dpr: 2,
    },
    // #43 non-dyadic tap count: radius 1 gives 9-tap neighborhoods whose
    // gated averages produce non-dyadic quotients (1/3, 2/3, ...) —the
    // reconstructed-vs-oracle comparison must use the documented tolerance,
    // never a bit-exact promise.
    {
      ...softShadowReconstructionScene(Math.fround(0.25), 4, 6, 1),
      name: "shadow-reconstruction-nondyadic-9-tap-r1",
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

  // -------------------------------------------------------------------------
  // #28 lighting fixtures. Every fixture runs the FULL integrated chain
  // (SceneUploader -> HeightPass -> NormalPass -> ShadowPass -> LightingPass)
  // and compares diffuse/specular/RGBA8 against the actual TypeScript
  // `shadePreparedFields` oracle fed with the CPU reference fields, the
  // f32-packed scene values and the GPU's effective ambient. Scenes use
  // integer positions/sizes and f32-exact elevations; the lighting button is
  // a FLAT-profile caster so the shadow decisions keep wide stability margins
  // (the +/-5e-4 pre-check still guards every fixture).
  // -------------------------------------------------------------------------

  /**
   * A 32x32 panel with a flat casting button. `material` is the button's
   * built-in preset ref; the panel uses a custom override material (proving
   * the uploaded MaterialRecord table is consumed). `extra` may override
   * light/environment/exposure/materials for the #22/#28 variants.
   */
  function lightingPanel(material, light = LIGHT_FROM_RIGHT, extra = {}) {
    return createScene({
      width: 32,
      height: 32,
      surfaces: [
        {
          id: "panel",
          position: { x: 0, y: 0 },
          size: { x: 32, y: 32 },
          elevation: 0,
          thickness: 0,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "panel",
          castsShadow: false,
          receivesShadow: true,
        },
        {
          id: "btn",
          position: { x: 6, y: 6 },
          size: { x: 14, y: 14 },
          elevation: 3,
          thickness: 2,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material,
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      materials: {
        panel: { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 0.5, metallic: 0 },
      },
      light: { direction: light, intensity: 1 },
      ...extra,
    });
  }

  const withEnv = (scene, intensity, diffuseShare, specularShare) => ({
    ...scene,
    environment: { intensity, diffuseIntensity: diffuseShare, specularIntensity: specularShare },
  });

  const withExposure = (scene, exposure) => ({ ...scene, exposure });

  const withLight = (scene, direction) => ({
    ...scene,
    // #45: a replaced light must carry the full sanitized DirectionalLight
    // contract — the white color default, exactly as createScene emits it.
    light: { direction, intensity: 1, color: { r: 1, g: 1, b: 1 } },
  });

  // #45: replace only the directional-light COLOR of an already-created
  // scene (linear RGB; the other light fields stay as createScene emitted
  // them).
  const withLightColor = (scene, color) => ({
    ...scene,
    light: { ...scene.light, color },
  });

  const LIGHTING_FIXTURES = [
    // built-in material coverage (silicone / matte / metal presets)
    { name: "lighting-silicone", scene: lightingPanel("silicone"), dpr: 1 },
    { name: "lighting-matte", scene: lightingPanel("matte"), dpr: 1 },
    { name: "lighting-metal", scene: lightingPanel("metal"), dpr: 1 },
    // base plane only: every texel is NO_OWNER -> BASE_MATERIAL, and the
    // scene carries a ZERO-length logical material table (the one-record ABI
    // floor binding is never read by the shader)
    { name: "lighting-base-plane", scene: emptyScene(), dpr: 1 },
    // material overrides: custom baseColor/roughness/metallic/ior in the
    // scene materials table, consumed through the uploaded MaterialRecords
    {
      name: "lighting-material-overrides",
      scene: lightingPanel("silicone", LIGHT_FROM_RIGHT, {
        materials: {
          panel: { baseColor: { r: 0.15, g: 0.55, b: 0.9 }, roughness: 0.1, metallic: 0.5, ior: 1.33 },
          silicone: { baseColor: { r: 0.95, g: 0.3, b: 0.25 }, roughness: 0.7, metallic: 0.2 },
        },
      }),
      dpr: 1,
    },
    // environment OFF / ON with share endpoints and mixed shares
    { name: "lighting-env-off", scene: withEnv(lightingPanel("silicone"), 0, 1, 1), dpr: 1 },
    { name: "lighting-env-shares", scene: withEnv(lightingPanel("metal"), 1, 0.25, 0.75), dpr: 1 },
    { name: "lighting-env-no-shares", scene: withEnv(lightingPanel("silicone"), 1, 0, 0), dpr: 1 },
    // exposure 0 / low / default / high
    { name: "lighting-exposure-0", scene: withExposure(lightingPanel("silicone"), 0), dpr: 1 },
    { name: "lighting-exposure-low", scene: withExposure(lightingPanel("silicone"), 0.5), dpr: 1 },
    { name: "lighting-exposure-default", scene: withExposure(lightingPanel("silicone"), 1), dpr: 1 },
    { name: "lighting-exposure-high", scene: withExposure(lightingPanel("silicone"), 4), dpr: 1 },
    // visibility 0/1: the two-level slab casts a hard shadow on the base
    // plane (visibility 0 texels keep ambient + environment); the vertical
    // light produces no shadow at all (visibility 1 everywhere)
    { name: "lighting-visibility-shadowed", scene: twoLevelScene(LIGHT_FROM_RIGHT).scene, dpr: 1 },
    { name: "lighting-visibility-lit", scene: twoLevelScene(LIGHT_VERTICAL).scene, dpr: 1 },
    // light movement over the same scene
    { name: "lighting-light-right", scene: lightingPanel("silicone", LIGHT_FROM_RIGHT), dpr: 1 },
    { name: "lighting-light-left", scene: lightingPanel("silicone", LIGHT_FROM_LEFT), dpr: 1 },
    { name: "lighting-light-vertical", scene: lightingPanel("silicone", LIGHT_VERTICAL), dpr: 1 },
    // degenerate half vector (L = -V): zero direct BRDF, no NaN, ambient +
    // environment only (no casters so the shadow field is exactly 1)
    {
      name: "lighting-degenerate-half-vector",
      scene: (() => {
        const base = lightingPanel("metal", { x: 0, y: 0, z: -1 });
        return { ...base, surfaces: base.surfaces.map((s) => ({ ...s, castsShadow: false })) };
      })(),
      dpr: 1,
    },
    // fractional render extents at DPR 1 / 1.5 / 2
    { name: "lighting-frac-dpr1", scene: lightingPanel("silicone"), dpr: 1, normalOptions: DPR_NORMAL_OPTIONS[1] },
    { name: "lighting-frac-dpr1.5", scene: lightingPanel("silicone"), dpr: 1.5, normalOptions: DPR_NORMAL_OPTIONS[1.5] },
    { name: "lighting-frac-dpr2", scene: lightingPanel("silicone"), dpr: 2, normalOptions: DPR_NORMAL_OPTIONS[2] },
    // finite f32 stress: intensity/environment/exposure at the largest finite
    // f32 —saturated non-negative accumulation must stay finite and saturate
    // to white on both the f64 oracle and the f32 shader
    {
      name: "lighting-f32-stress",
      scene: withEnv(
        withExposure(withLight(lightingPanel("metal"), LIGHT_FROM_RIGHT), F32_MAX),
        F32_MAX,
        1,
        1,
      ),
      dpr: 1,
    },
    // ambient variants: off, half, and a value above 1 (clamped to 1)
    { name: "lighting-ambient-0", scene: lightingPanel("silicone"), dpr: 1, lightingOptions: { ambient: 0 } },
    { name: "lighting-ambient-half", scene: lightingPanel("silicone"), dpr: 1, lightingOptions: { ambient: 0.5 } },
    { name: "lighting-ambient-saturated", scene: lightingPanel("silicone"), dpr: 1, lightingOptions: { ambient: 2 } },
    // #45 directional-light color: linear-RGB tints of the DIRECT
    // contribution — white (historical), red, green, blue, warm, and an HDR
    // multiplier above 1. The shadows/reconstruction are color-invariant;
    // only the final lighting color differs.
    { name: "lighting-color-white", scene: lightingPanel("silicone"), dpr: 1 },
    { name: "lighting-color-red", scene: withLightColor(lightingPanel("silicone"), { r: 1, g: 0, b: 0 }), dpr: 1 },
    { name: "lighting-color-green", scene: withLightColor(lightingPanel("matte"), { r: 0, g: 1, b: 0 }), dpr: 1 },
    { name: "lighting-color-blue", scene: withLightColor(lightingPanel("metal"), { r: 0, g: 0, b: 1 }), dpr: 1 },
    { name: "lighting-color-warm", scene: withLightColor(lightingPanel("silicone"), { r: 1, g: 0.55, b: 0.25 }), dpr: 1 },
    { name: "lighting-color-hdr", scene: withLightColor(lightingPanel("metal"), { r: 2, g: 1, b: 0.5 }), dpr: 1 },
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
    // largest-finite-f32 scale overflows to infinity in naive f32 —the
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
    // #28 lighting fixtures (the real-GPU lighting stage: the full integrated
    // chain plus LightingPass, diffuse/specular tolerance parity and the
    // RGBA8 color policy —all compared against shadePreparedFields).
    ...LIGHTING_FIXTURES,
  ];

  // -------------------------------------------------------------------------
  // #29 presentation fixtures: the full public GpuScenePipeline into a real
  // GPUCanvasContext, compared against the CPU reference composition.
  // -------------------------------------------------------------------------

  const PRESENTATION_FIXTURES = [
    // opaque silicone/matte/metal surfaces and lit base-plane transparency
    { name: "present-silicone-opaque", scene: lightingPanel("silicone"), dpr: 1 },
    { name: "present-matte-opaque", scene: lightingPanel("matte"), dpr: 1 },
    { name: "present-metal-opaque", scene: lightingPanel("metal"), dpr: 1 },
    // vertical light: no shadow anywhere, the base plane is transparent
    { name: "present-lit-background", scene: twoLevelScene(LIGHT_VERTICAL).scene, dpr: 1 },
    // shadowed and lit background, custom shadow tint/alpha, alpha 0 and 1
    { name: "present-shadow-default", scene: twoLevelScene(LIGHT_FROM_RIGHT).scene, dpr: 1 },
    {
      name: "present-shadow-custom-tint-alpha",
      scene: twoLevelScene(LIGHT_FROM_RIGHT).scene,
      dpr: 1,
      compositeOptions: { shadowColor: [200, 40, 220], shadowAlpha: 0.6 },
    },
    {
      name: "present-shadow-alpha-0",
      scene: twoLevelScene(LIGHT_FROM_RIGHT).scene,
      dpr: 1,
      compositeOptions: { shadowAlpha: 0 },
    },
    {
      name: "present-shadow-alpha-1",
      scene: twoLevelScene(LIGHT_FROM_RIGHT).scene,
      dpr: 1,
      compositeOptions: { shadowAlpha: 1 },
    },
    // #41 soft shadow reaching the CANVAS: intermediate visibilities scale
    // the premultiplied tint through the continuous occlusion strength.
    // shadowAlpha 0.5 -> full-strength alpha byte round(0.5 * 255) = 128;
    // with samples=4 every dyadic strength keeps the products integral
    // (128 * 0.25 = 32, 128 * 0.5 = 64, 128 * 0.75 = 96), so NO texel ever
    // lands on a halfway quantization boundary —the fixture stays portable
    // across WebGPU backends instead of depending on a rounding tie-break.
    // samples=4 deliberately DIFFERS from the renderer default (8): if the
    // fixture's shadowOptions stopped being forwarded to pipeline.render,
    // the canvas would silently fall back to 8-sample visibility and this
    // fixture would fail.
    // #43: the pipeline reconstructs the soft field by DEFAULT, which would
    // break this fixture's integral-product portability argument (recon
    // quotients are non-dyadic); this fixture tests the RAW dyadic field
    // end-to-end, so it explicitly disables reconstruction (the #43
    // reconstructed-canvas path is covered by
    // present-reconstructed-soft-shadow below).
    {
      name: "present-soft-shadow-custom-tint-alpha",
      ...softShadowScene(Math.fround(0.25), 4, 6),
      shadowOptions: { samples: 4, reconstruction: { enabled: false } },
      dpr: 1,
      compositeOptions: { shadowColor: [200, 40, 220], shadowAlpha: 0.5 },
    },
    // #43 reconstructed soft shadow reaching the CANVAS: the presentation
    // pipeline consumes the RECONSTRUCTED visibility (default-enabled on the
    // soft path), so the canvas bytes must equal the reconstructVisibility
    // oracle composed with the same tint/alpha. The explicit radius pins the
    // option forwarding end-to-end.
    //
    // PORTABLE geometry/params: the reconstructed (non-dyadic) strength
    // products must sit FAR from any 8-bit rounding boundary, because the
    // canvas policy is exact-alpha and unorm8 encode behavior can vary by a
    // small margin across legal backends (the parity harness verifies this
    // fixture's minimum quantization margin via
    // reconstructedCanvasQuantizationReport). This configuration (low slab,
    // samples 8, radius 3, shadowAlpha ~0.29, tint [160,70,180]) measures a
    // min margin of ~0.122 byte units —comfortably above the ~0.057
    // backend flip envelope observed in the parity sweep.
    {
      name: "present-reconstructed-soft-shadow",
      ...portableReconstructedScene(),
      dpr: 1,
      compositeOptions: { shadowColor: [160, 70, 180], shadowAlpha: Math.fround(74 / 255) },
    },
    // #45 colored light through the FULL soft + reconstruction chain: the
    // final canvas carries the warm tint of the direct contribution while
    // the reconstructed soft shadow reaches the canvas unchanged (the
    // reconstructed-shadow canvas quantization guard applies as usual).
    {
      name: "present-reconstructed-soft-shadow-colored-light",
      ...portableReconstructedScene({ color: { r: 1, g: 0.55, b: 0.25 } }),
      dpr: 1,
      compositeOptions: { shadowColor: [160, 70, 180], shadowAlpha: Math.fround(74 / 255) },
    },
    // overlap/ownership, clipped/offscreen surfaces and empty scene behavior
    { name: "present-overlap-ownership", scene: tieOverlapScene().scene, dpr: 1 },
    { name: "present-clipped-offscreen", scene: clipScene(), dpr: 1 },
    { name: "present-empty-scene", scene: emptyScene(), dpr: 1 },
    // DPR 1 / 1.5 / 2 and fractional floor render extents (13x9 logical)
    { name: "present-frac-dpr1", scene: fracShadowScene().scene, dpr: 1 },
    {
      name: "present-frac-dpr1.5",
      scene: fracShadowScene().scene,
      dpr: 1.5,
      normalOptions: DPR_NORMAL_OPTIONS[1.5],
    },
    {
      name: "present-frac-dpr2",
      scene: fracShadowScene().scene,
      dpr: 2,
      normalOptions: DPR_NORMAL_OPTIONS[2],
    },
    // two backing-store resizes on the SAME presenter (32x32 -> 16x16 ->
    // 32x32), each frame compared
    {
      name: "present-two-resizes",
      renders: [
        { scene: lightingPanel("silicone"), dpr: 1 },
        { scene: twoLevelScene(LIGHT_FROM_RIGHT).scene, dpr: 1 },
        { scene: lightingPanel("silicone"), dpr: 1 },
      ],
    },
    // light/environment/exposure changes without stale presentation
    // dimensions (the same 32x32 presenter every frame)
    { name: "present-light-change", scene: lightingPanel("silicone", LIGHT_FROM_LEFT), dpr: 1 },
    {
      name: "present-env-exposure-change",
      scene: withEnv(withExposure(lightingPanel("silicone"), 4), 1, 0.25, 0.75),
      dpr: 1,
    },
  ];

  // -------------------------------------------------------------------------
  // Finalize: explicit catalog metadata for every fixture (stable id,
  // categories, logical/render dimensions, DPR, parameters, buffers+policy).
  // -------------------------------------------------------------------------

  function alphaHex(alpha) {
    if (alpha instanceof Uint8Array) {
      return Array.from(alpha, (v) => v.toString(16).padStart(2, "0")).join("");
    }
    const view = new DataView(alpha.buffer, alpha.byteOffset, alpha.byteLength);
    let hex = "";
    for (let i = 0; i < alpha.length; i++) {
      const bits = view.getUint32(i * 4, true);
      hex += (bits >>> 8).toString(16).padStart(6, "0") + (bits & 0xff).toString(16).padStart(2, "0");
    }
    return hex;
  }

  /**
   * Deterministic serializable description of a created scene: every field
   * that can affect output (geometry, material table, light, environment,
   * exposure). Typed mask alpha arrays become canonical hex so the payload is
   * a plain JSON structure.
   */
  function describeScene(scene) {
    const lightDescription = {
      direction: { x: scene.light.direction.x, y: scene.light.direction.y, z: scene.light.direction.z },
      intensity: scene.light.intensity,
      // #41: the apparent light size (radians) affects the rendered
      // visibility/canvas output, so it MUST be part of the canonical
      // fixture metadata (mismatch reports and static-golden parameters).
      angularRadius: scene.light.angularRadius ?? 0,
    };
    // #45: the canonical f32 light color affects the rendered output, so a
    // NON-WHITE color must be part of the fixture metadata. The white
    // default is deliberately OMITTED so the historical white-light golden
    // payloads (and their digests) stay byte-identical.
    const color = scene.light.color;
    if (color !== undefined && (color.r !== 1 || color.g !== 1 || color.b !== 1)) {
      lightDescription.color = {
        r: color.r,
        g: color.g,
        b: color.b,
      };
    }
    return {
      width: scene.width,
      height: scene.height,
      surfaces: scene.surfaces.map((s) => ({
        id: s.id,
        position: { x: s.position.x, y: s.position.y },
        size: { x: s.size.x, y: s.size.y },
        elevation: s.elevation,
        thickness: s.thickness,
        bevelWidth: s.bevelWidth,
        profile: s.profile.kind,
        shape:
          s.shape.kind === "roundedRect"
            ? { kind: "roundedRect", radius: s.shape.radius }
            : {
                kind: "mask",
                mask: { width: s.shape.mask.width, height: s.shape.mask.height, alphaHex: alphaHex(s.shape.mask.alpha) },
              },
        material: s.material,
        castsShadow: s.castsShadow,
        receivesShadow: s.receivesShadow,
      })),
      materials: scene.materials,
      light: lightDescription,
      environment: {
        intensity: scene.environment.intensity,
        diffuseIntensity: scene.environment.diffuseIntensity,
        specularIntensity: scene.environment.specularIntensity,
      },
      exposure: scene.exposure,
    };
  }

  const CATEGORY_BY_FIXTURE = {
    // base fixtures
    "rounded-flat-dpr1": ["analytic-shape", "rounded-surface", "no-bevel", "height-field", "coverage", "object-id", "material-id", "normal-flat", "material-silicone", "opaque-owned-pixels", "static-golden"],
    "rounded-bevel-dpr1": ["analytic-shape", "rounded-surface", "bevel", "height-field", "normal-edge-bevel", "material-silicone", "static-golden"],
    "background-only-dpr1": ["empty-scene", "unowned-lit-background", "canvas-transparency", "static-golden"],
    "zero-height-ownership-dpr1": ["height-field", "ownership-tie", "opaque-owned-pixels", "static-golden"],
    "overlap-exact-ties-dpr1": ["overlap", "ownership-tie", "paint-order", "height-field", "material-metal", "static-golden"],
    "clipping-offscreen-dpr1": ["clipping", "offscreen", "translation", "static-golden"],
    "dpr1-fractional-floor": ["dpr-1", "fractional-extent"],
    "dpr1.5-fractional-floor": ["dpr-1.5", "fractional-extent"],
    "dpr2-fractional-floor": ["dpr-2", "fractional-extent", "static-golden"],
    "mask-f32-empty": ["mask-shape", "height-field"],
    "mask-f32-full": ["mask-shape", "height-field"],
    "mask-f32-edge": ["mask-shape", "height-field", "normal-boundary", "static-golden"],
    "mask-u8-empty": ["mask-shape"],
    "mask-u8-full": ["mask-shape", "static-golden"],
    "mask-u8-edge": ["mask-shape"],
    "multi-mask-f32-u8": ["mask-shape", "overlap", "paint-order"],
    // synthetic normals
    "synth-flat-constant": ["normal-synthetic"],
    "synth-x-ramp-sign": ["normal-synthetic", "static-golden"],
    "synth-diagonal-slope": ["normal-synthetic"],
    "synth-plateau-edges": ["normal-synthetic", "normal-boundary"],
    "synth-wrap-guard": ["normal-synthetic"],
    "synth-options-change": ["normal-synthetic"],
    "synth-extreme-f32-diff-scale": ["normal-synthetic", "extreme-f32", "static-golden"],
    "synth-extreme-diagonal-signs": ["normal-synthetic", "extreme-f32"],
    "synth-extreme-x-scale-small-heights": ["normal-synthetic", "extreme-f32"],
    "synth-extreme-normal-scale-small-heights": ["normal-synthetic", "extreme-f32"],
    "synth-normal-scale-below-min-subnormal": ["normal-synthetic", "subnormal"],
    "synth-normal-scale-min-subnormal": ["normal-synthetic", "subnormal"],
    "synth-normal-scale-min-subnormal-flat": ["normal-synthetic", "subnormal"],
    // shadow fixtures
    "shadow-two-level-light-right": ["shadow-visibility", "caster-height", "shadow-occluder-receiver-separation", "translucent-shadow-pixels", "static-golden"],
    "shadow-two-level-light-left": ["shadow-visibility", "caster-height", "shadow-opposing-directions"],
    "shadow-occluder-removed": ["shadow-visibility", "shadow-occluder-receiver-separation", "cast-flag"],
    "shadow-non-casting-top": ["shadow-visibility", "cast-flag"],
    "shadow-panel-receives": ["shadow-visibility", "receive-flag"],
    "shadow-receives-false": ["shadow-visibility", "receive-flag"],
    "shadow-bilinear-boundary": ["shadow-visibility", "sampling-boundary"],
    "shadow-equality-at-threshold": ["shadow-visibility", "threshold-equality"],
    "shadow-strict-above-threshold": ["shadow-visibility", "threshold-equality"],
    "shadow-tie-overlap-ordering": ["shadow-visibility", "overlap", "ownership-tie", "paint-order"],
    "shadow-mask-caster": ["shadow-visibility", "mask-shape", "glyph-shape"],
    "shadow-clipped-offscreen-caster": ["shadow-visibility", "clipping", "offscreen"],
    "shadow-vertical-light": ["shadow-visibility", "shadow-no-shadow-vertical"],
    "shadow-near-vertical-light": ["shadow-visibility", "shadow-no-shadow-vertical"],
    "shadow-y-light-bottom-exit": ["shadow-visibility", "light-direction-change"],
    "shadow-y-light-top-exit": ["shadow-visibility", "light-direction-change"],
    "shadow-short-max-distance": ["shadow-visibility", "shadow-max-distance", "static-golden"],
    "shadow-custom-options-a": ["shadow-visibility", "shadow-options"],
    "shadow-custom-options-b": ["shadow-visibility", "shadow-options"],
    "shadow-soft-radius-0.15-samples-8": ["shadow-visibility", "soft-shadow"],
    "shadow-soft-radius-0.3-samples-16": ["shadow-visibility", "soft-shadow"],
    "shadow-soft-radius-0.05-samples-4": ["shadow-visibility", "soft-shadow"],
    "shadow-soft-samples-1-hard-compatible": ["shadow-visibility", "soft-shadow"],
    "shadow-soft-tall-caster-separation": [
      "shadow-visibility",
      "soft-shadow",
      "penumbra-separation",
    ],
    "shadow-soft-mask-caster": ["shadow-visibility", "soft-shadow", "mask-shape", "glyph-shape"],
    // #43 reconstructed soft shadows (edge-aware visibility reconstruction)
    "shadow-reconstruction-radius-0.25-samples-4-r2": ["shadow-visibility", "soft-shadow", "reconstruction"],
    "shadow-reconstruction-radius-0.15-samples-8-r2": ["shadow-visibility", "soft-shadow", "reconstruction"],
    "shadow-reconstruction-tall-separation-r3": ["shadow-visibility", "soft-shadow", "reconstruction"],
    "shadow-reconstruction-mask-caster-r2": ["shadow-visibility", "soft-shadow", "reconstruction", "mask-shape", "glyph-shape"],
    "shadow-reconstruction-dpr1.5": ["shadow-visibility", "soft-shadow", "reconstruction", "dpr-1.5", "fractional-extent"],
    "shadow-reconstruction-dpr2": ["shadow-visibility", "soft-shadow", "reconstruction", "dpr-2"],
    "shadow-reconstruction-nondyadic-9-tap-r1": ["shadow-visibility", "soft-shadow", "reconstruction"],
    "shadow-non-binary-step-0.1": ["shadow-visibility", "shadow-options"],
    "shadow-f32-vs-f64-equality": ["shadow-visibility", "threshold-equality"],
    "shadow-frac-dpr1": ["shadow-visibility", "dpr-1", "fractional-extent"],
    "shadow-frac-dpr1.5": ["shadow-visibility", "dpr-1.5", "fractional-extent"],
    "shadow-frac-dpr2": ["shadow-visibility", "dpr-2", "fractional-extent", "static-golden"],
    "shadow-synth-self-shadow-bias-sets": ["shadow-synthetic", "shadow-options"],
    // lighting fixtures
    "lighting-silicone": ["lighting", "material-silicone", "static-golden"],
    "lighting-matte": ["lighting", "material-matte", "static-golden"],
    "lighting-metal": ["lighting", "material-metal", "static-golden"],
    "lighting-base-plane": ["lighting", "material-base", "unowned-lit-background"],
    "lighting-material-overrides": ["lighting", "material-override"],
    "lighting-env-off": ["lighting", "environment-off", "static-golden"],
    "lighting-env-shares": ["lighting", "environment-on"],
    "lighting-env-no-shares": ["lighting", "environment-on"],
    "lighting-exposure-0": ["lighting", "exposure-zero", "static-golden"],
    "lighting-exposure-low": ["lighting", "exposure-low"],
    "lighting-exposure-default": ["lighting", "exposure-default"],
    "lighting-exposure-high": ["lighting", "exposure-high"],
    "lighting-visibility-shadowed": ["lighting", "shadow-visibility", "translucent-shadow-pixels"],
    "lighting-visibility-lit": ["lighting", "shadow-no-shadow-vertical"],
    "lighting-light-right": ["lighting", "light-direction-change"],
    "lighting-light-left": ["lighting", "light-direction-change", "static-golden"],
    "lighting-light-vertical": ["lighting", "light-direction-change"],
    "lighting-degenerate-half-vector": ["lighting", "degenerate-half-vector"],
    "lighting-frac-dpr1": ["lighting", "dpr-1", "fractional-extent"],
    "lighting-frac-dpr1.5": ["lighting", "dpr-1.5", "fractional-extent", "static-golden"],
    "lighting-frac-dpr2": ["lighting", "dpr-2", "fractional-extent"],
    "lighting-f32-stress": ["lighting", "exposure-extreme-finite", "extreme-f32", "environment-on", "static-golden"],
    "lighting-ambient-0": ["lighting", "lighting-options"],
    "lighting-ambient-half": ["lighting", "lighting-options"],
    "lighting-ambient-saturated": ["lighting", "lighting-options"],
    // #45 directional-light color (linear RGB)
    "lighting-color-white": ["lighting", "light-color"],
    "lighting-color-red": ["lighting", "light-color"],
    "lighting-color-green": ["lighting", "light-color"],
    "lighting-color-blue": ["lighting", "light-color"],
    "lighting-color-warm": ["lighting", "light-color"],
    "lighting-color-hdr": ["lighting", "light-color"],
    // presentation fixtures
    "present-silicone-opaque": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "material-silicone", "opaque-owned-pixels", "static-golden"],
    "present-matte-opaque": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "material-matte"],
    "present-metal-opaque": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "material-metal"],
    "present-lit-background": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "unowned-lit-background"],
    "present-shadow-default": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "translucent-shadow-pixels", "static-golden"],
    "present-shadow-custom-tint-alpha": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "translucent-shadow-pixels", "composite-options"],
    "present-shadow-alpha-0": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "composite-options"],
    "present-shadow-alpha-1": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "composite-options"],
    "present-soft-shadow-custom-tint-alpha": [
      "canvas-composition",
      "canvas-format-normalization",
      "canvas-transparency",
      "composite-options",
      "soft-shadow",
    ],
    "present-reconstructed-soft-shadow": [
      "canvas-composition",
      "canvas-format-normalization",
      "canvas-transparency",
      "composite-options",
      "soft-shadow",
      "reconstruction",
    ],
    "present-reconstructed-soft-shadow-colored-light": [
      "canvas-composition",
      "canvas-format-normalization",
      "canvas-transparency",
      "composite-options",
      "soft-shadow",
      "reconstruction",
      "light-color",
    ],
    "present-overlap-ownership": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "overlap", "ownership-tie", "paint-order"],
    "present-clipped-offscreen": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "clipping", "offscreen", "canvas-clipped-output"],
    "present-empty-scene": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "empty-scene"],
    "present-frac-dpr1": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "dpr-1", "fractional-extent"],
    "present-frac-dpr1.5": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "dpr-1.5", "fractional-extent", "static-golden"],
    "present-frac-dpr2": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "dpr-2", "fractional-extent"],
    "present-two-resizes": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "canvas-resize", "resize", "static-golden"],
    "present-light-change": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "light-direction-change"],
    "present-env-exposure-change": ["canvas-composition", "canvas-format-normalization", "canvas-transparency", "environment-on", "exposure-high"],
  };

  const GOLDEN_FIXTURES = new Set([
    "rounded-flat-dpr1",
    "rounded-bevel-dpr1",
    "background-only-dpr1",
    "zero-height-ownership-dpr1",
    "overlap-exact-ties-dpr1",
    "clipping-offscreen-dpr1",
    "dpr2-fractional-floor",
    "mask-f32-edge",
    "mask-u8-full",
    "synth-x-ramp-sign",
    "synth-extreme-f32-diff-scale",
    "shadow-two-level-light-right",
    "shadow-short-max-distance",
    "shadow-frac-dpr2",
    "lighting-silicone",
    "lighting-matte",
    "lighting-metal",
    "lighting-env-off",
    "lighting-exposure-0",
    "lighting-light-left",
    "lighting-frac-dpr1.5",
    "lighting-f32-stress",
    "present-silicone-opaque",
    "present-shadow-default",
    "present-frac-dpr1.5",
    "present-two-resizes",
  ]);

  function finalizeFixture(entry, index, isPresentation) {
    const id = entry.name;
    const categories = CATEGORY_BY_FIXTURE[id];
    if (categories === undefined) {
      throw new Error(`catalog: fixture "${id}" has no declared categories`);
    }
    for (const category of categories) {
      if (!CATEGORIES.includes(category)) {
        throw new Error(`catalog: fixture "${id}" declares unknown category "${category}"`);
      }
    }
    const dpr = entry.dpr ?? 1;
    const source = entry.renders !== undefined ? entry.renders[0].scene : entry.scene;
    const logical =
      source !== undefined
        ? { width: source.width, height: source.height }
        : { width: entry.width, height: entry.height };
    const dprF = Math.fround(dpr);
    const render = {
      width: Math.max(1, Math.floor(logical.width * dprF)),
      height: Math.max(1, Math.floor(logical.height * dprF)),
    };
    const options = {};
    if (entry.normalOptions !== undefined) options.normal = entry.normalOptions;
    if (entry.shadowOptions !== undefined) options.shadow = entry.shadowOptions;
    if (entry.lightingOptions !== undefined) options.lighting = entry.lightingOptions;
    if (entry.compositeOptions !== undefined) options.composite = entry.compositeOptions;
    if (entry.shadowSynth === true && entry.optionSets !== undefined) {
      options.shadowSets = entry.optionSets;
    } else if (entry.optionSets !== undefined) {
      options.normalSets = entry.optionSets;
    }
    const params = {
      scene: source !== undefined ? describeScene(source) : { width: entry.width, height: entry.height },
      dpr,
      render: { width: render.width, height: render.height },
      options,
    };
    if (isPresentation === true && entry.renders !== undefined) {
      params.frames = entry.renders.map((frame, frameIndex) => ({
        frame: frameIndex,
        dpr: frame.dpr ?? 1,
        scene: describeScene(frame.scene),
        options: {
          ...(frame.normalOptions !== undefined ? { normal: frame.normalOptions } : {}),
          ...(frame.shadowOptions !== undefined ? { shadow: frame.shadowOptions } : {}),
          ...(frame.lightingOptions !== undefined ? { lighting: frame.lightingOptions } : {}),
          ...(frame.compositeOptions !== undefined ? { composite: frame.compositeOptions } : {}),
        },
      }));
    }
    let buffers;
    if (entry.synthetic === true || entry.optionChange === true) {
      buffers = ["normal"];
    } else if (entry.shadowSynth === true) {
      buffers = ["visibility"];
    } else if (isPresentation === true) {
      buffers =
        entry.renders !== undefined
          ? entry.renders.map((_, frameIndex) => `canvas-frame-${frameIndex}`)
          : ["canvas-frame-0"];
    } else {
      buffers = [...COMPUTE_CHAIN_BUFFERS];
    }
    return {
      ...entry,
      id,
      name: id,
      categories: Object.freeze([...categories]),
      dpr,
      logical: Object.freeze(logical),
      render: Object.freeze(render),
      params: Object.freeze(params),
      buffers: Object.freeze(buffers),
      golden: GOLDEN_FIXTURES.has(id),
      catalogIndex: index,
    };
  }

  const computeFixtures = Object.freeze(FIXTURES.map((entry, index) => finalizeFixture(entry, index, false)));
  const presentationFixtures = Object.freeze(
    PRESENTATION_FIXTURES.map((entry, index) => finalizeFixture(entry, index, true)),
  );

  // encodeScene smoke check: every scene fixture must encode at its DPR (the
  // golden payload depends on the frozen ABI, so a broken encoder is caught
  // at catalog load time).
  for (const fixture of computeFixtures) {
    if (fixture.scene !== undefined) {
      encodeScene(fixture.scene, fixture.dpr);
    }
  }
  for (const fixture of presentationFixtures) {
    for (const frame of fixture.renders ?? [{ scene: fixture.scene, dpr: fixture.dpr }]) {
      encodeScene(frame.scene, frame.dpr);
    }
  }

  return {
    catalogVersion: CATALOG_VERSION,
    computeFixtures,
    presentationFixtures,
  };
}
