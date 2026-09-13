// #52 glyph lighting ablation harness (real Chrome, real WebGPU adapter).
//
// Root-cause evidence for "the physical glyph relief does not visibly respond
// to directional light". This page renders the CURRENT PLAYGROUND GLYPH
// FIXTURE (the real Playground typography/layout for the glyph; the only
// capture-stage deviations are recorded in the report's
// `fixture.layoutDifferences`) through the REAL PRODUCTION REACT PATH:
//
//   <Ukibori backend="webgpu">      (provider: shared light, shadow options)
//     <Surface  id="glyph-panel">   panel elevation 0 / thickness 3 /
//                                   bevelWidth 5 / matte (roundedRect r16),
//                                   styled by demo/src/index.css
//                                   .demo-play-panel
//     <UkiboriText id="glyph">      glyph ABSOLUTE elevation 3 / thickness 2 /
//                                   bevelWidth 1.1 / metal, styled by
//                                   demo/src/index.css .ukibori-text
//                                   (3.2rem / 800 / 0.12em / line-height 1 /
//                                   ui-monospace stack), fixed 2x source mask
//                                   rasterization inside the component
//
// There is NO copied `rasterizeText` here: <UkiboriText> rasterizes with its
// own fixed-2x source-mask policy, registers the mask through <Surface>, and
// the harness only reads the RETAINED REGISTRY (`layer.registry`) for the
// resulting mask geometry and delegation state. The runner
// (scripts/glyph-ablation.mjs) builds the published `ukibori` / `ukibori-dom`
// / `ukibori-renderer` packages and bundles THIS page against those builds.
//
// The page provides three evidence modes:
//
//   1. LIGHT-RESPONSE MATRIX (window.__prepare / window.__report): for each
//      light direction (left/right/top/bottom) x render DPR (1/1.5/2) x DOM
//      ink state, renders a frame and captures the PRESENTED canvas through a
//      same-task staging copy (debugReadback seam), reporting the physical
//      glyph-region mean RGB and the |delta| between opposite directions.
//   2. SHADOW VERIFICATION (window.__runShadowVerification): NUMERIC presented
//      -frame verification for the review lights default (-0.6,-0.8,1),
//      reversed (0.6,0.8,1) and grazing z=0.35, with the provider-global
//      bias 0.5 vs 0.15: glyph shadow existence on the panel, centroid
//      direction reversal, grazing projection-reach increase, acne and
//      roundedRect/panel impact. Every number comes from GPU readback of the
//      presented frame (glyph-present vs glyph-absent baseline), not from
//      screenshots.
//   3. ALIGNMENT MATRIX (window.__configureAlignment): re-renders
//      <UkiboriText> with typography/DPR cases and reports the PRODUCTION
//      mask geometry from the registry plus the DOM line-rect count and the
//      delegation outcome; the DOM ink bounds come from the runner's
//      screenshot round-trip (window.__measureInk).
//
// `window.__setInk(visible)` is the documented DEBUG OVERRIDE used to
// reproduce the pre-fix appearance for screenshots: the layer-owned
// `data-ukibori-physical-ink` suppression attribute is removed/restored
// behind the layer's back (setting `color: transparent` would correctly
// exclude the glyph from the physical scene instead).

import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { Ukibori, Surface, UkiboriText } from "ukibori";

const STAGE_RECT = { x: 0, y: 0, w: 420, h: 260 };

// Current Playground fixture (demo/src/dashboard/Playground.tsx):
//   panel:  roundedRect radius 16, elevation 0, thickness 3, bevelWidth 5,
//           material matte (variant raised)
//   glyph:  ABSOLUTE elevation 3 (its base exactly on the panel top),
//           thickness 2, bevelWidth 1.1, material metal
const PANEL_OPTIONS = {
  id: "glyph-panel",
  sceneId: "glyph-panel",
  shape: { kind: "roundedRect", radius: 16 },
  variant: "raised",
  elevation: 0,
  thickness: 3,
  bevelWidth: 5,
  radius: 16,
  material: "matte",
  // The Playground panel classes (demo/src/index.css) plus the harness-only
  // capture-stage placement class (`harness-play-panel` = absolute position).
  className: "demo-play-panel harness-play-panel",
};
// A second roundedRect surface with the same provider-global shadow bias:
// used to measure whether a bias change impacts surfaces OTHER than the
// glyph panel (acne/self-shadow differences).
const SIDE_PANEL_OPTIONS = {
  id: "side-panel",
  sceneId: "side-panel",
  shape: { kind: "roundedRect", radius: 12 },
  variant: "raised",
  elevation: 0,
  thickness: 3,
  bevelWidth: 4,
  radius: 12,
  material: "matte",
  className: "demo-side-panel",
};
const GLYPH_OPTIONS = {
  id: "glyph",
  sceneId: "glyph",
  text: "PLAY",
  elevation: 3,
  thickness: 2,
  bevelWidth: 1.1,
  material: "metal",
  className: "ukibori-text",
};

// The renderer's default self-shadow bias (packages/renderer/src/shadow.ts
// DEFAULT_BIAS) and the demo-local reduced bias under review.
const DEFAULT_BIAS = 0.5;
const LOW_BIAS = 0.15;

// Expected Playground fixture typography (demo/src/index.css): font-size
// 3.2rem, weight 800, letter-spacing 0.12em, line-height 1, monospace stack.
// The harness styles are pinned to demo/src/index.css by
// glyph-lighting-css.test.mjs; these constants are the COMPUTED-value gate so
// a harness/stylesheet drift cannot pass as Playground evidence.
const PLAYGROUND_TYPOGRAPHY = {
  fontWeight: "800",
  fontSizeRem: 3.2,
  letterSpacingEm: 0.12,
  lineHeightRatio: 1,
  fontFamilyIncludes: ["monospace", "cascadia", "consolas"],
};

// Provider-global bias-change tolerance for surfaces OTHER than the glyph
// panel (the side roundedRect). The measured change is bit-identical; a tiny
// GPU-difference envelope is allowed so the gate is not machine-specific.
const SIDE_PANEL_BIAS_TOLERANCE = 8;

// Review verification lights.
const VERIFICATION_LIGHTS = {
  default: { x: -0.6, y: -0.8, z: 1 },
  reversed: { x: 0.6, y: 0.8, z: 1 },
  grazing: { x: -0.6, y: -0.8, z: 0.35 },
};

// Light-response matrix directions (with z=1) and their opposites.
const DIRECTIONS = {
  left: { x: -1, y: 0, z: 1 },
  right: { x: 1, y: 0, z: 1 },
  top: { x: 0, y: -1, z: 1 },
  bottom: { x: 0, y: 1, z: 1 },
};
const OPPOSITES = { left: "right", right: "left", top: "bottom", bottom: "top" };

/** Same-task staging copy of the presented frame (see dom-gpu.mjs notes). */
function submitPresentedCopy(device, context, width, height) {
  const captured = context.getCurrentTexture();
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const staging = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: captured, mipLevel: 0, origin: { x: 0, y: 0 } },
    { buffer: staging, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  return { staging, width, height, bytesPerRow };
}

async function stagingReadback(handle) {
  const { staging, width, height, bytesPerRow } = handle;
  try {
    await staging.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(staging.getMappedRange().slice());
    const rows = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      rows.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    }
    return rows;
  } finally {
    staging.destroy();
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settle(device) {
  await device.queue.onSubmittedWorkDone();
  await nextFrame();
  await nextFrame();
}

/** Wait for React commit + effects (root.render -> effect -> retained update)
 * plus the layer's scheduled render, without assuming microtask timing. */
async function settleAfterRender() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextFrame();
  await nextFrame();
}

// The provider's render scheduler seam: test runs force a full render
// synchronously (`flush`) so the presented-texture copy is submitted in the
// SAME task as the render (Windows/D3D swapchain backing recycling).
const pending = [];
function schedule(cb) {
  pending.push(cb);
}
function flush() {
  const copy = [...pending];
  pending.length = 0;
  for (const cb of copy) {
    cb();
  }
}

/** Force a synchronous paint of the CURRENT state. `invalidate()` alone does
 * not repaint when the geometry is unchanged (the layer's retained fast
 * path), so a public setter (which sets `sceneDirty` unconditionally) is used
 * before draining the scheduled render callbacks. The live getter preserves
 * the CURRENT requested `config.dpr` — the render target must stay at the
 * requested resolution (never forced to 1). */
function paintNow() {
  layer.setDpr(() => config.dpr);
  flush();
}

// ---- React production app (the ONLY glyph rasterizer is <UkiboriText>) ----

let layer = null;
let gpuCanvas = null;
let readbackInstalled = false;
let layerError = null;
let resolveLayer = null;
const layerReady = new Promise((resolve) => {
  resolveLayer = resolve;
});

function glyphProps(overrides = {}) {
  return { ...GLYPH_OPTIONS, ...overrides };
}

let config = {
  light: DIRECTIONS.left,
  dpr: 1,
  // Current Playground fixture: the demo provider passes shadow bias 0.15.
  bias: LOW_BIAS,
  glyph: true,
  glyphProps: glyphProps(),
};

function installReadback(next) {
  if (readbackInstalled) {
    return;
  }
  const pipeline = next.gpuPipeline;
  if (pipeline === null || pipeline === undefined) {
    return;
  }
  // TEST-ONLY: make the presented frame stage-readable and ALWAYS run the
  // full chain (pixels unchanged). `debugForceFull` defeats the pipeline's
  // retained-frame fast path, which would otherwise keep a stale/blank canvas
  // texture when the layer repaints with an identical encoded scene.
  const originalRender = pipeline.render.bind(pipeline);
  pipeline.render = (input) => originalRender({ ...input, debugReadback: true, debugForceFull: true });
  gpuCanvas = next.overlay.gpuCanvas();
  readbackInstalled = true;
}

// The Playground provider's shadow pipeline: angularRadius 0 (default slider)
// keeps the hard path, while samples/reconstruction are forwarded exactly
// like demo/src/dashboard/Playground.tsx passes them.
const PLAYGROUND_SHADOW = {
  samples: 8,
  reconstruction: { enabled: true, radius: 2 },
};

/** Provider shadow options for a bias override (`null` = renderer default). */
function shadowOptions(bias) {
  return bias === null ? { ...PLAYGROUND_SHADOW } : { ...PLAYGROUND_SHADOW, bias };
}

function App({ cfg }) {
  return h(
    Ukibori,
    {
      backend: "webgpu",
      light: cfg.light,
      intensity: 1,
      lightColor: { r: 1, g: 1, b: 1 },
      angularRadius: 0,
      shadow: shadowOptions(cfg.bias),
      environment: { intensity: 0.5, specularIntensity: 1 },
      exposure: 1,
      dpr: cfg.dpr,
      className: "harness-root",
      style: { position: "relative", width: `${STAGE_RECT.w}px`, height: `${STAGE_RECT.h}px` },
      schedule,
      onError: (error) => {
        layerError = error;
      },
      onReady: (next) => {
        layer = next;
        if (next !== null) {
          installReadback(next);
          resolveLayer(next);
        }
      },
    },
    h(Surface, SIDE_PANEL_OPTIONS),
    h(
      Surface,
      PANEL_OPTIONS,
      cfg.glyph ? h(UkiboriText, cfg.glyphProps) : null,
    ),
  );
}

const root = createRoot(document.getElementById("stage"));
function renderApp() {
  root.render(h(App, { cfg: config }));
}

async function applyConfig(patch) {
  config = { ...config, ...patch };
  renderApp();
  await settleAfterRender();
}

/** Wait until the CURRENT <UkiboriText> is registered in the retained layer
 * with a mask shape. Toggling the glyph off/on (baseline captures) remounts
 * the component; the production registration + rasterization effects are
 * async relative to the React commit, and rendering before they complete
 * would capture the GLYPH-ABSENT scene (a stale-looking pair). */
async function waitForGlyphRegistered(timeoutFrames = 120) {
  for (let i = 0; i < timeoutFrames; i++) {
    const entry = layer.registry.get("glyph");
    if (
      entry !== undefined &&
      entry.options.shape !== null &&
      entry.options.shape !== undefined &&
      entry.options.shape.kind === "mask"
    ) {
      return true;
    }
    await nextFrame();
  }
  return false;
}

async function readFrame() {
  const device = layer.gpuDevice;
  // SAME-TASK capture: submit the staging copy for the JUST-PRESENTED frame
  // before any await can recycle the D3D swapchain backing (Windows/D3D
  // specifics documented in dom-gpu.mjs), then wait for completion.
  const w = gpuCanvas.width;
  const h = gpuCanvas.height;
  const handle = submitPresentedCopy(device, gpuCanvas.getContext("webgpu"), w, h);
  await settle(device);
  const rows = await stagingReadback(handle);
  return { rows, width: w, height: h };
}

function frameOpaqueCount(frame) {
  let count = 0;
  for (let p = 3; p < frame.rows.length; p += 4) {
    if (frame.rows[p] === 255) count++;
  }
  return count;
}

/** Freshness probe: the PANEL must be opaque in the captured frame. A blank
 * or mis-registered first frame can still have stray opaque pixels elsewhere,
 * so the global count alone is not enough. */
function framePanelOpaque(frame) {
  const panel = document.getElementById("glyph-panel");
  if (panel === null) return frameOpaqueCount(frame) >= 1000;
  const box = deviceBox(panel, frame);
  const cx = Math.floor((box.x0 + box.x1) / 2);
  const cy = Math.floor((box.y0 + box.y1) / 2);
  let opaque = 0;
  for (let y = Math.max(0, cy - 8); y < Math.min(frame.height, cy + 8); y++) {
    for (let x = Math.max(0, cx - 8); x < Math.min(frame.width, cx + 8); x++) {
      if (frame.rows[(y * frame.width + x) * 4 + 3] === 255) opaque++;
    }
  }
  return opaque > 64;
}

/** Presented-frame capture with a same-task retry: the swapchain backing can
 * be recycled between an async React settle and the staging copy, which
 * occasionally yields an all-transparent or mis-registered readback.
 * Re-render + recopy until the panel region is actually opaque. */
async function capturePresentedFrame() {
  let frame = await readFrame();
  for (let attempt = 0; attempt < 4 && !framePanelOpaque(frame); attempt++) {
    paintNow();
    frame = await readFrame();
  }
  return frame;
}

// ---- light-response matrix (#52 ablation evidence) ----

/** frames[groupKey][dir] = { rows, width, height, box, mean } */
const frames = {};
/** report[groupKey][dir / delta] = metrics */
const report = {};

function groupKey(dpr, ink) {
  return `dpr-${dpr}-ink-${ink ? "visible" : "suppressed"}`;
}

/** Device-px box of a document-space DOM rect inside the render target. The
 * render target covers the layer's scene region (stage + margin), so the
 * region origin/scale from debugState() is the authoritative mapping. */
function frameToViewport(frame) {
  const region = layer.debugState().region;
  return {
    sx: region !== null ? frame.width / region.w : frame.width / STAGE_RECT.w,
    sy: region !== null ? frame.height / region.h : frame.height / STAGE_RECT.h,
    ox: region !== null ? region.x : STAGE_RECT.x,
    oy: region !== null ? region.y : STAGE_RECT.y,
  };
}

function deviceBoxFromRect(rect, frame) {
  const { sx, sy, ox, oy } = frameToViewport(frame);
  const x0 = Math.max(0, Math.floor((rect.left - ox) * sx));
  const y0 = Math.max(0, Math.floor((rect.top - oy) * sy));
  const x1 = Math.min(frame.width, Math.ceil((rect.right - ox) * sx));
  const y1 = Math.min(frame.height, Math.ceil((rect.bottom - oy) * sy));
  return { x0, y0, x1, y1, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0), rect };
}

function deviceBox(element, frame) {
  return deviceBoxFromRect(element.getBoundingClientRect(), frame);
}

function padBox(box, pad, frame) {
  const x0 = Math.max(0, box.x0 - pad);
  const y0 = Math.max(0, box.y0 - pad);
  const x1 = Math.min(frame.width, box.x1 + pad);
  const y1 = Math.min(frame.height, box.y1 + pad);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** Mean |delta| over opaque pixels in a device-px box, between two frames. */
function regionDelta(rowsA, rowsB, width, box) {
  let n = 0;
  let sum = 0;
  let max = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const p = (y * width + x) * 4;
      if (rowsA[p + 3] !== 255 || rowsB[p + 3] !== 255) continue;
      n++;
      let d = 0;
      for (let c = 0; c < 3; c++) d += Math.abs(rowsA[p + c] - rowsB[p + c]);
      d /= 3;
      sum += d;
      if (d > max) max = d;
    }
  }
  return { n, mean: n > 0 ? sum / n : 0, max };
}

/** Mean RGB over opaque pixels in a device-px box. */
function regionMean(rows, width, box) {
  let n = 0;
  const sum = [0, 0, 0];
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const p = (y * width + x) * 4;
      if (rows[p + 3] !== 255) continue;
      n++;
      for (let c = 0; c < 3; c++) sum[c] += rows[p + c];
    }
  }
  return n > 0 ? sum.map((v) => Math.round((v / n) * 10) / 10) : null;
}

window.__setInk = (visible) => {
  const span = document.getElementById("glyph");
  if (visible) {
    // DEBUG OVERRIDE (#52): with the production policy live, a registered
    // mask surface owns the data-ukibori-physical-ink suppression, so the
    // pre-fix "ink visible" state is reproduced here by removing the
    // layer-owned attribute. Debug evidence tooling only.
    span.removeAttribute("data-ukibori-physical-ink");
  } else {
    // Production suppression is ATTRIBUTE-driven (the injected stylesheet
    // paints the ink transparent without touching CSS `color`, which #56
    // reads as the physical pigment). Re-adding the attribute reproduces it;
    // setting `color: transparent` would (correctly) exclude the glyph from
    // the physical scene instead.
    span.setAttribute("data-ukibori-physical-ink", "");
  }
};

/** Alignment measurement support: hide the physical overlay canvas so the
 * screenshot captures PURE DOM ink (the fixed-2x relief's dark bevels would
 * otherwise extend the segmented ink bbox). Debug evidence tooling only. */
window.__setOverlayVisible = (visible) => {
  const canvas = gpuCanvas !== null ? gpuCanvas : layer.overlay.gpuCanvas();
  if (canvas !== null && canvas !== undefined) {
    canvas.style.visibility = visible ? "" : "hidden";
  }
};

window.__prepare = async ({ direction, dpr, ink, readback = true }) => {
  const key = groupKey(dpr, ink);
  if (report[key] === undefined) {
    report[key] = {};
    frames[key] = {};
  }
  await applyConfig({
    light: DIRECTIONS[direction],
    dpr,
    // The current Playground fixture uses the demo-local bias 0.15.
    bias: LOW_BIAS,
    glyph: true,
    glyphProps: glyphProps(),
  });
  await waitForGlyphRegistered();
  window.__setInk(ink);
  // Force a synchronous paint of the current state so the staging copy is
  // submitted in the SAME task (the layer's retained fast path would skip a
  // repaint otherwise).
  paintNow();
  if (!readback) {
    // Screenshot-only conditions: leave the presented frame untouched (a
    // post-present staging copy submit can blank the composited D3D
    // swapchain content). Metrics for these conditions come from their
    // readback twin earlier in the condition matrix.
    return null;
  }
  const { rows, width, height } = await capturePresentedFrame();
  const frame = { width, height };
  const box = padBox(
    deviceBox(document.getElementById("glyph"), frame),
    Math.max(2, Math.round(2 * dpr)),
    frame,
  );
  const entry = {
    rows,
    width,
    height,
    box,
    mean: regionMean(rows, width, box),
    panelOpaque: framePanelOpaque({ rows, width, height }),
    opaqueCount: frameOpaqueCount({ rows, width, height }),
  };
  frames[key][direction] = entry;
  const debugState = layer.debugState();
  report[key][direction] = {
    mean: entry.mean,
    box,
    canvas: [width, height],
    dpr: debugState.dpr,
    region: debugState.region,
    panelOpaque: entry.panelOpaque,
    opaqueCount: entry.opaqueCount,
  };
  const opposite = frames[key][OPPOSITES[direction]];
  if (opposite) {
    const d = regionDelta(entry.rows, opposite.rows, width, box);
    report[key][`delta-${direction}-${OPPOSITES[direction]}`] = d;
  }
  return report[key][direction];
};

window.__report = () => report;

// ---- numeric shadow verification (presented-frame readback) ----

const luma = (rows, p) => 0.299 * rows[p] + 0.587 * rows[p + 1] + 0.114 * rows[p + 2];

const SHADOW_THRESHOLD = 2; // u8 luminance delta counted as cast shadow
const ACNE_THRESHOLD = 6; // u8 luminance delta counted as bias-induced change

/** The PRODUCTION glyph surface for the currently mounted <UkiboriText>: the
 * retained mask (alpha >= 0.5 is the physical SDF silhouette) plus the span
 * box it is mapped onto. `mask` is sampled in the analysis to distinguish
 * GLYPH-SURFACE pixels from receiver pixels (panel visible through counters /
 * letter gaps and around the ink) — a bounding box cannot make that
 * distinction. */
function glyphSurfaceInfo() {
  const span = document.getElementById("glyph");
  const entry = layer.registry.get("glyph");
  if (span === null || entry === undefined) return null;
  const shape = entry.options.shape;
  if (shape === null || shape === undefined || shape.kind !== "mask") return null;
  return { mask: shape.mask, box: span.getBoundingClientRect() };
}

/** Viewport CSS-px <-> device-px mapping for one captured frame. */
function makeViewportMapper(frame) {
  const { sx, sy, ox, oy } = frameToViewport(frame);
  return {
    toViewportX: (x) => ox + (x + 0.5) / sx,
    toViewportY: (y) => oy + (y + 0.5) / sy,
  };
}

/** Predicate factory: sample the PRODUCTION mask alpha at a device-pixel
 * center (via the renderer's mask mapping). alpha >= 0.5 is the physical
 * glyph surface; alpha in (0, 0.5) is the antialiased silhouette halo (a
 * blended glyph/panel pixel — excluded from evidence); alpha == 0 is a true
 * receiver pixel. */
const MASK_SURFACE_ALPHA = 0.5;
const MASK_HALO_ALPHA = 0.01;

/** Sample the production mask alpha at a VIEWPORT CSS-px point. The mask maps
 * onto the span box exactly like the renderer maps it onto SurfaceNode.size
 * (mask pixel (i,j) covers [i,i+1) x [j,j+1) of the footprint). */
function makeViewportAlphaSampler(info) {
  if (info === null || info === undefined) return () => 0;
  const { mask, box } = info;
  if (box.width <= 0 || box.height <= 0) return () => 0;
  return (vx, vy) => {
    const u = (vx - box.left) / box.width;
    const v = (vy - box.top) / box.height;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return 0;
    const mx = Math.min(mask.width - 1, Math.floor(u * mask.width));
    const my = Math.min(mask.height - 1, Math.floor(v * mask.height));
    return mask.alpha[my * mask.width + mx];
  };
}

/** Device-pixel alpha sampler (viewport mapping + frame mapping). */
function makeDeviceAlphaSampler(info, frame) {
  if (info === null || info === undefined) return () => 0;
  const sampleViewport = makeViewportAlphaSampler(info);
  const { toViewportX, toViewportY } = makeViewportMapper(frame);
  return (x, y) => sampleViewport(toViewportX(x), toViewportY(y));
}

/** LOCAL cast-shadow attribution: from a receiver pixel walk back TOWARD the
 * light along the horizontal light ray and find the first production-mask
 * caster boundary (alpha >= 0.5). Returns the horizontal distance in CSS px
 * plus the caster-to-shadow displacement (receiver - caster), which points
 * along the anti-light direction. This is the physically meaningful shadow
 * length for the local silhouette, not a word-center projection. */
const LOCAL_STEP_CSS = 0.1;
const LOCAL_MAX_SEARCH_CSS = 16;

function localCasterAttribution(sampleAlpha, vx, vy, lhatX, lhatY) {
  for (let d = LOCAL_STEP_CSS; d <= LOCAL_MAX_SEARCH_CSS; d += LOCAL_STEP_CSS) {
    const qx = vx + lhatX * d;
    const qy = vy + lhatY * d;
    if (sampleAlpha(qx, qy) >= MASK_SURFACE_ALPHA) {
      return { distance: d, dx: vx - qx, dy: vy - qy };
    }
  }
  return null;
}

/** Capture one presented frame with the given light/bias/glyph state AND
 * remember the production glyph surface info (the glyph is absent in
 * baseline captures). */
async function captureShadowFrame({ light, bias, glyph }) {
  await applyConfig({ light, dpr: 1, bias, glyph, glyphProps: glyphProps() });
  if (glyph) {
    await waitForGlyphRegistered();
  }
  const surfaceInfo = glyph ? glyphSurfaceInfo() : null;
  // Fixture fidelity snapshot: the PRODUCTION computed typography, logical
  // glyph box and fixed-2x mask dimensions for the mounted <UkiboriText>.
  const glyphInfo = glyph ? productionGlyphInfo() : null;
  // Force a synchronous paint of the current state so the staging copy is
  // submitted in the SAME task (the layer's retained fast path would skip a
  // repaint otherwise).
  paintNow();
  const { rows, width, height } = await capturePresentedFrame();
  return { rows, width, height, surfaceInfo, glyphInfo };
}

/**
 * Shadow geometry for one (light, bias): the glyph-present frame minus the
 * glyph-absent baseline at the SAME light/bias.
 *
 * Evidence rules:
 * - Glyph-surface pixels (mask alpha >= 0.5) are never receivers.
 * - Silhouette-halo pixels (alpha in (0, 0.5)) are blended glyph/panel pixels
 *   and are excluded from all evidence.
 * - A cast-shadow candidate is a true receiver pixel that is significantly
 *   darker with the glyph present. Its LOCAL shadow length is the horizontal
 *   distance from the pixel back toward the light to the first production-mask
 *   caster boundary (alpha >= 0.5) — physically ~`thickness / tan(elevation)`
 *   for the local silhouette, independent of word size.
 * - The caster-to-shadow displacement must point along the anti-light
 *   direction; the mean displacement vector is the direction evidence (the
 *   word-center projection is intentionally NOT used).
 */
function analyzeShadowCase(withCapture, baseCapture, light) {
  const withFrame = withCapture;
  const baseFrame = baseCapture;
  const frame = { width: withFrame.width, height: withFrame.height };
  const panel = deviceBox(document.getElementById("glyph-panel"), frame);
  const alphaAtDevice = makeDeviceAlphaSampler(withFrame.surfaceInfo, frame);
  const sampleAlpha = makeViewportAlphaSampler(withFrame.surfaceInfo);
  const { toViewportX, toViewportY } = makeViewportMapper(frame);
  const ink = deviceBoxFromRect(
    withFrame.surfaceInfo !== null ? withFrame.surfaceInfo.box : panel.rect,
    frame,
  );
  const length = Math.hypot(light.x, light.y) || 1;
  const lhatX = light.x / length; // toward the light
  const lhatY = light.y / length;
  const ux = -lhatX; // anti-light: expected caster -> shadow direction
  const uy = -lhatY;
  let count = 0;
  let unattributed = 0;
  let sumDelta = 0;
  let maxDelta = 0;
  let horizontalSum = 0;
  let horizontalMax = 0;
  let raySum = 0;
  let rayMax = 0;
  let dispX = 0;
  let dispY = 0;
  let alignSum = 0;
  const rayFactor = Math.hypot(light.x, light.y, light.z) / length || 1;
  const histogram = [0, 0, 0, 0, 0]; // luminance deltas >2/>4/>8/>16/>32 u8
  // Horizontal (XY receiver-plane) caster reach <=1/2/3/4/6/>6 CSS px — the
  // GATE metric's distribution (robust to the rare counter-spanning max).
  const horizontalHistogram = [0, 0, 0, 0, 0, 0];
  for (let y = panel.y0; y < panel.y1; y++) {
    for (let x = panel.x0; x < panel.x1; x++) {
      if (alphaAtDevice(x, y) > MASK_HALO_ALPHA) continue;
      const p = (y * withFrame.width + x) * 4;
      if (withFrame.rows[p + 3] !== 255 || baseFrame.rows[p + 3] !== 255) continue;
      const delta = luma(baseFrame.rows, p) - luma(withFrame.rows, p);
      if (delta > 2) histogram[0]++;
      if (delta > 4) histogram[1]++;
      if (delta > 8) histogram[2]++;
      if (delta > 16) histogram[3]++;
      if (delta > 32) histogram[4]++;
      if (delta <= SHADOW_THRESHOLD) continue;
      const vx = toViewportX(x);
      const vy = toViewportY(y);
      const local = localCasterAttribution(sampleAlpha, vx, vy, lhatX, lhatY);
      if (local === null) {
        unattributed++;
        continue;
      }
      count++;
      sumDelta += delta;
      if (delta > maxDelta) maxDelta = delta;
      // Horizontal distance from the receiver pixel to the caster boundary;
      // the 3D distance along the light ray additionally rises by Lz/|Lxy|.
      const rayDistance = local.distance * rayFactor;
      horizontalSum += local.distance;
      if (local.distance > horizontalMax) horizontalMax = local.distance;
      raySum += rayDistance;
      if (rayDistance > rayMax) rayMax = rayDistance;
      const bucket =
        local.distance <= 1
          ? 0
          : local.distance <= 2
            ? 1
            : local.distance <= 3
              ? 2
              : local.distance <= 4
                ? 3
                : local.distance <= 6
                  ? 4
                  : 5;
      horizontalHistogram[bucket]++;
      dispX += local.dx;
      dispY += local.dy;
      const dlen = Math.hypot(local.dx, local.dy) || 1;
      alignSum += (local.dx * ux + local.dy * uy) / dlen;
    }
  }
  const round2 = (value) => Math.round(value * 100) / 100;
  // Robust local reach: a MAX over per-pixel attributions is dominated by the
  // rare receiver pixel whose nearest caster lies across a letter counter (a
  // legitimate counter shadow, but not the cast-shadow extent of the glyph
  // silhouette). The 90th-percentile HORIZONTAL reach from the histogram is
  // the gate metric; the raw max stays reported for transparency.
  const reachBuckets = [1, 2, 3, 4, 6, LOCAL_MAX_SEARCH_CSS];
  const quantileReach = (q) => {
    if (count <= 0) return 0;
    const target = q * count;
    let cumulative = 0;
    for (let i = 0; i < horizontalHistogram.length; i++) {
      cumulative += horizontalHistogram[i];
      if (cumulative >= target) return reachBuckets[i];
    }
    return LOCAL_MAX_SEARCH_CSS;
  };
  return {
    count,
    unattributed,
    histogram,
    horizontalHistogram,
    meanDelta: count > 0 ? round2(sumDelta / count) : 0,
    maxDelta,
    horizontalMean: count > 0 ? round2(horizontalSum / count) : 0,
    horizontalMax: round2(horizontalMax),
    localP90: quantileReach(0.9),
    localP95: quantileReach(0.95),
    // 3D distance from the receiver pixel to the caster boundary along the
    // light ray (CSS px): the physically meaningful local shadow length.
    rayMean: count > 0 ? round2(raySum / count) : 0,
    rayMax: round2(rayMax),
    rayFactor: Math.round(rayFactor * 1000) / 1000,
    // Mean local caster -> shadow displacement (CSS px, viewport axes, y
    // down). This is the direction evidence.
    displacement:
      count > 0
        ? { x: round2(dispX / count), y: round2(dispY / count) }
        : null,
    meanAlignmentWithLight: count > 0 ? Math.round((alignSum / count) * 1000) / 1000 : 0,
    panelBox: { x: panel.x0, y: panel.y0, w: panel.width, h: panel.height },
    inkBox: { x: ink.x0, y: ink.y0, w: ink.width, h: ink.height },
    canvas: [withFrame.width, withFrame.height],
  };
}

/** Bias-change split between GLYPH-SURFACE pixels (self-shadow / acne) and
 * RECEIVER pixels (panel visible through counters/letter gaps plus shadow
 * coverage). frameA = higher bias (0.5), frameB = lower bias (0.15): a
 * positive delta means the LOWER-bias frame is DARKER. Silhouette-halo
 * pixels (alpha in (0, 0.5)) are skipped — they blend glyph and panel and
 * belong to neither class. */
function biasDeltaSplit(frameA, frameB, box, alphaAtDevice) {
  const out = {
    surfaceDarker: 0,
    surfaceLighter: 0,
    receiverDarker: 0,
    receiverLighter: 0,
    halo: 0,
  };
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const p = (y * frameA.width + x) * 4;
      if (frameA.rows[p + 3] !== 255 || frameB.rows[p + 3] !== 255) continue;
      const alpha = alphaAtDevice(x, y);
      const surface = alpha >= MASK_SURFACE_ALPHA;
      if (!surface && alpha > MASK_HALO_ALPHA) {
        out.halo++;
        continue;
      }
      const delta = luma(frameA.rows, p) - luma(frameB.rows, p);
      if (delta > ACNE_THRESHOLD) {
        if (surface) out.surfaceDarker++;
        else out.receiverDarker++;
      }
      if (delta < -ACNE_THRESHOLD) {
        if (surface) out.surfaceLighter++;
        else out.receiverLighter++;
      }
    }
  }
  return out;
}

function regionMeanLuma(rows, width, box) {
  let n = 0;
  let sum = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const p = (y * width + x) * 4;
      if (rows[p + 3] !== 255) continue;
      n++;
      sum += luma(rows, p);
    }
  }
  return n > 0 ? Math.round((sum / n) * 100) / 100 : null;
}

/** Adapter details for the evidence JSON (Chrome exposes `GPUAdapter.info`;
 * older builds used requestAdapterInfo()). */
async function describeAdapter() {
  try {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null || adapter === undefined) return null;
    const info = adapter.info;
    if (info !== undefined && info !== null) {
      return {
        vendor: info.vendor ?? "",
        architecture: info.architecture ?? "",
        device: info.device ?? "",
        description: info.description ?? "",
      };
    }
    if (typeof adapter.requestAdapterInfo === "function") {
      const legacy = await adapter.requestAdapterInfo();
      return {
        vendor: legacy.vendor ?? "",
        architecture: legacy.architecture ?? "",
        device: legacy.device ?? "",
        description: legacy.description ?? "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Layer runtime metadata for the evidence JSON. */
function runtimeMetadata() {
  const state = layer.debugState();
  return {
    backend: state.backend,
    gpuFallbackReason: state.gpuFallbackReason ?? null,
    dpr: state.dpr,
    renderSize: state.renderSize,
    region: state.region,
    lastRenderMs: state.lastRenderMs,
    windowDevicePixelRatio: window.devicePixelRatio,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    adapter: null, // filled asynchronously
  };
}

window.__runShadowVerification = async () => {
  const runtime = runtimeMetadata();
  runtime.adapter = await describeAdapter();
  const captures = {};
  for (const [name, light] of Object.entries(VERIFICATION_LIGHTS)) {
    for (const bias of [DEFAULT_BIAS, LOW_BIAS]) {
      // With-glyph first so the glyph DOM rect is captured before the
      // baseline frame unmounts the <UkiboriText>.
      const withCapture = await captureShadowFrame({ light, bias, glyph: true });
      const baseCapture = await captureShadowFrame({ light, bias, glyph: false });
      captures[`${name}|${bias}`] = { withCapture, baseCapture };
    }
  }
  const cases = {};
  for (const [name, light] of Object.entries(VERIFICATION_LIGHTS)) {
    cases[name] = {};
    for (const bias of [DEFAULT_BIAS, LOW_BIAS]) {
      const pair = captures[`${name}|${bias}`];
      cases[name][`bias${bias}`] = analyzeShadowCase(pair.withCapture, pair.baseCapture, light);
    }
  }

  // Bias impact, computed for EVERY review light: glyph-SURFACE pixels
  // (self-shadow / acne candidates) vs true RECEIVER pixels (cast-shadow
  // coverage), glyph-present frames only, higher bias 0.5 vs lower bias 0.15.
  const biasImpactPerLight = {};
  for (const [name, light] of Object.entries(VERIFICATION_LIGHTS)) {
    const frame05 = captures[`${name}|${DEFAULT_BIAS}`].withCapture;
    const frame015 = captures[`${name}|${LOW_BIAS}`].withCapture;
    const frame = { width: frame05.width, height: frame05.height };
    const alphaAt = makeDeviceAlphaSampler(frame05.surfaceInfo, frame);
    const panelBox = deviceBox(document.getElementById("glyph-panel"), frame);
    const split = biasDeltaSplit(frame05, frame015, panelBox, alphaAt);
    let surfacePixels = 0;
    for (let y = panelBox.y0; y < panelBox.y1; y++) {
      for (let x = panelBox.x0; x < panelBox.x1; x++) {
        if (alphaAt(x, y) >= MASK_SURFACE_ALPHA) surfacePixels++;
      }
    }
    biasImpactPerLight[name] = {
      light,
      surfacePixels,
      glyphSurface: { darker: split.surfaceDarker, lighter: split.surfaceLighter },
      receivers: { darker: split.receiverDarker, lighter: split.receiverLighter },
      halo: split.halo,
    };
  }
  // Provider-global side effect: the second roundedRect surface (all
  // receiver) at the default light.
  const sideFrame05 = captures[`default|${DEFAULT_BIAS}`].withCapture;
  const sideFrame015 = captures[`default|${LOW_BIAS}`].withCapture;
  const sideFrame = { width: sideFrame05.width, height: sideFrame05.height };
  const sidePanel = deviceBox(document.getElementById("side-panel"), sideFrame);
  const sidePanelMeans = {
    bias05: regionMeanLuma(sideFrame05.rows, sideFrame05.width, sidePanel),
    bias015: regionMeanLuma(sideFrame015.rows, sideFrame015.width, sidePanel),
  };
  const sidePanelBiasDelta = biasDeltaSplit(sideFrame05, sideFrame015, sidePanel, () => 0);
  const inkBox05 = deviceBoxFromRect(sideFrame05.surfaceInfo.box, sideFrame);

  const at = (name, bias) => cases[name][`bias${bias}`];

  // Bias-adoption decision metrics: the reduced 0.15 bias is retained ONLY
  // because it adds real cast-shadow receiver pixels while leaving other
  // surfaces alone. Both are asserted by the runner (biasDecisionFailures).
  const defaultReceiverGain = at("default", LOW_BIAS).count - at("default", DEFAULT_BIAS).count;
  const grazingReceiverGain = at("grazing", LOW_BIAS).count - at("grazing", DEFAULT_BIAS).count;
  const biasDecision = {
    threshold: ACNE_THRESHOLD,
    defaultReceiverGain,
    grazingReceiverGain,
    defaultBeneficial: defaultReceiverGain > 0,
    grazingBeneficial: grazingReceiverGain > 0,
    sidePanelSurfaceChanged:
      sidePanelBiasDelta.surfaceDarker + sidePanelBiasDelta.surfaceLighter,
    sidePanelReceiverChanged:
      sidePanelBiasDelta.receiverDarker + sidePanelBiasDelta.receiverLighter,
    sidePanelTolerance: SIDE_PANEL_BIAS_TOLERANCE,
  };

  // Playground fixture fidelity: the computed typography / logical box / fixed
  // 2x mask of the PRODUCTION <UkiboriText> at the default Playground light.
  const glyphFixture = captures[`default|${DEFAULT_BIAS}`].withCapture.glyphInfo;

  const report = {
    runtime,
    fixture: {
      panel: { elevation: 0, thickness: 3, bevelWidth: 5, radius: 16, material: "matte" },
      glyph: { elevation: 3, thickness: 2, bevelWidth: 1.1, material: "metal" },
      // The Playground provider's shadow pipeline, forwarded exactly like the
      // demo (angularRadius 0 keeps the hard path; samples/reconstruction are
      // still passed so the fixture is not silently reduced).
      shadowPipeline: { angularRadius: 0, samples: 8, reconstruction: { enabled: true, radius: 2 } },
      raster: "fixed 2x source mask (independent of devicePixelRatio)",
      dpr: 1,
      canvas: [sideFrame05.width, sideFrame05.height],
      // The harness reproduces the ACTUAL Playground typography/layout by
      // construction (demo-play-panel / .ukibori-text copied from
      // demo/src/index.css; parity pinned by glyph-lighting-css.test.mjs).
      // Capture-stage-only deviations that cannot affect the glyph's raster
      // box are recorded so the fixture claim stays precise.
      layoutSource: "demo/src/index.css .demo-play-panel + .ukibori-text",
      layoutDifferences: [
        "panel positioned on the fixed capture stage instead of the demo showcase grid",
        "trailing .plain-note paragraph omitted (follows the glyph; cannot affect the glyph box)",
      ],
      typography: glyphFixture !== null ? glyphFixture.typography : null,
      glyphBox: glyphFixture !== null ? glyphFixture.box : null,
      mask:
        glyphFixture !== null
          ? {
              width: glyphFixture.maskSize !== null ? glyphFixture.maskSize[0] : null,
              height: glyphFixture.maskSize !== null ? glyphFixture.maskSize[1] : null,
              logical: glyphFixture.maskSizeCss,
            }
          : null,
      expectedTypography: PLAYGROUND_TYPOGRAPHY,
    },
    thresholds: { shadowLuma: SHADOW_THRESHOLD, changeLuma: ACNE_THRESHOLD },
    cases,
    biasDecision,
    biasImpact: {
      perLight: biasImpactPerLight,
      sidePanel: { means: sidePanelMeans, ...sidePanelBiasDelta },
      inkBox: { x: inkBox05.x0, y: inkBox05.y0, w: inkBox05.width, h: inkBox05.height },
    },
    verification: {
      shadowExistsAt05: [
        at("default", DEFAULT_BIAS).count,
        at("reversed", DEFAULT_BIAS).count,
        at("grazing", DEFAULT_BIAS).count,
      ],
      shadowExistsAt015: [
        at("default", LOW_BIAS).count,
        at("reversed", LOW_BIAS).count,
        at("grazing", LOW_BIAS).count,
      ],
      // PRIMARY screen-space projection metric: the local horizontal
      // caster-to-shadow distance on the receiver plane.
      horizontalMaxAt05: [
        at("default", DEFAULT_BIAS).horizontalMax,
        at("reversed", DEFAULT_BIAS).horizontalMax,
        at("grazing", DEFAULT_BIAS).horizontalMax,
      ],
      horizontalMaxAt015: [
        at("default", LOW_BIAS).horizontalMax,
        at("reversed", LOW_BIAS).horizontalMax,
        at("grazing", LOW_BIAS).horizontalMax,
      ],
      // GATE metric: 90th-percentile local reach (robust to the rare
      // counter-spanning attribution that inflates the raw max).
      reachAt05: [
        at("default", DEFAULT_BIAS).localP90,
        at("reversed", DEFAULT_BIAS).localP90,
        at("grazing", DEFAULT_BIAS).localP90,
      ],
      reachAt015: [
        at("default", LOW_BIAS).localP90,
        at("reversed", LOW_BIAS).localP90,
        at("grazing", LOW_BIAS).localP90,
      ],
      // SECONDARY: 3D distance along the light ray.
      rayMaxAt05: [
        at("default", DEFAULT_BIAS).rayMax,
        at("reversed", DEFAULT_BIAS).rayMax,
        at("grazing", DEFAULT_BIAS).rayMax,
      ],
      rayMaxAt015: [
        at("default", LOW_BIAS).rayMax,
        at("reversed", LOW_BIAS).rayMax,
        at("grazing", LOW_BIAS).rayMax,
      ],
      displacementAt05: [
        at("default", DEFAULT_BIAS).displacement,
        at("reversed", DEFAULT_BIAS).displacement,
        at("grazing", DEFAULT_BIAS).displacement,
      ],
      displacementAt015: [
        at("default", LOW_BIAS).displacement,
        at("reversed", LOW_BIAS).displacement,
        at("grazing", LOW_BIAS).displacement,
      ],
      defaultDirectionOk: null,
      reversedDirectionOk: null,
      directionReverses: null,
      grazingDistanceIncreasesAt05: null,
      grazingDistanceIncreasesAt015: null,
    },
  };
  const d05 = at("default", DEFAULT_BIAS);
  const r05 = at("reversed", DEFAULT_BIAS);
  const g05 = at("grazing", DEFAULT_BIAS);
  const d015 = at("default", LOW_BIAS);
  const r015 = at("reversed", LOW_BIAS);
  const g015 = at("grazing", LOW_BIAS);
  const directionOk = (c) =>
    c.displacement !== null && c.meanAlignmentWithLight > 0.9 && c.horizontalMax > 0;
  const displacementCosine = (a, b) => {
    if (a.displacement === null || b.displacement === null) return null;
    const la = Math.hypot(a.displacement.x, a.displacement.y) || 1;
    const lb = Math.hypot(b.displacement.x, b.displacement.y) || 1;
    return (
      (a.displacement.x * b.displacement.x + a.displacement.y * b.displacement.y) / (la * lb)
    );
  };
  const cos05 = displacementCosine(d05, r05);
  const cos015 = displacementCosine(d015, r015);
  report.verification.defaultDirectionOk = directionOk(d05) && directionOk(d015);
  report.verification.reversedDirectionOk = directionOk(r05) && directionOk(r015);
  report.verification.directionReverses =
    cos05 !== null && cos05 < -0.5 && cos015 !== null && cos015 < -0.5;
  // PRIMARY assertion: the robust receiver-plane reach strictly grows under
  // the grazing light (raw max and secondary ray length stay informational).
  report.verification.grazingDistanceIncreasesAt05 = g05.localP90 > d05.localP90 + 0.5;
  report.verification.grazingDistanceIncreasesAt015 = g015.localP90 > d015.localP90 + 0.5;

  window.__shadowReport = report;
  return report;
};

window.__shadowReport = null;

// ---- alignment matrix (production UkiboriText + registry, no mirror) ----

/** Canvas typography capability probe (documented in the ablation report:
 * which spacing mirrors THIS Chrome's canvas actually supports). */
function probeCanvasTypographySupport() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  return {
    letterSpacing: ctx !== null && "letterSpacing" in ctx,
    wordSpacing: ctx !== null && "wordSpacing" in ctx,
    fontKerning: ctx !== null && "fontKerning" in ctx,
    fontStretch: ctx !== null && "fontStretch" in ctx,
    fontVariantCaps: ctx !== null && "fontVariantCaps" in ctx,
    textRendering: ctx !== null && "textRendering" in ctx,
    direction: ctx !== null && "direction" in ctx,
  };
}

function readComputedTypography(el) {
  const style = getComputedStyle(el);
  const read = (prop) => {
    const value = style[prop];
    return typeof value === "string" ? value : "";
  };
  return {
    font: read("font"),
    fontFamily: read("fontFamily"),
    fontSize: read("fontSize"),
    fontWeight: read("fontWeight"),
    lineHeight: read("lineHeight"),
    letterSpacing: read("letterSpacing"),
    wordSpacing: read("wordSpacing"),
    textTransform: read("textTransform"),
    direction: read("direction"),
    writingMode: read("writingMode"),
    fontKerning: read("fontKerning"),
    fontStretch: read("fontStretch"),
    fontVariantCaps: read("fontVariantCaps"),
    fontVariantPosition: read("fontVariantPosition"),
    fontFeatureSettings: read("fontFeatureSettings"),
    fontVariationSettings: read("fontVariationSettings"),
    textRendering: read("textRendering"),
    textDecorationLine: read("textDecorationLine"),
    textEmphasisStyle: read("textEmphasisStyle"),
    webkitTextStrokeWidth: read("webkitTextStrokeWidth"),
  };
}

/** Production registry facts for the currently mounted glyph: the mask the
 * REAL <UkiboriText> produced, its delegation outcome, the live line rects
 * and the logic box. No raster mirror. */
function productionGlyphInfo() {
  const span = document.getElementById("glyph");
  const entry = layer.registry.get("glyph");
  const box = span.getBoundingClientRect();
  const mask = entry && entry.options.shape && entry.options.shape.kind === "mask" ? entry.options.shape.mask : null;
  let inkTop = Infinity;
  let inkBottom = -Infinity;
  let inkLeft = Infinity;
  let inkRight = -Infinity;
  if (mask !== null) {
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        if (mask.alpha[y * mask.width + x] >= 0.5) {
          inkTop = Math.min(inkTop, y);
          inkBottom = Math.max(inkBottom, y + 1);
          inkLeft = Math.min(inkLeft, x);
          inkRight = Math.max(inkRight, x + 1);
        }
      }
    }
  }
  const lineRange = document.createRange();
  lineRange.selectNodeContents(span);
  const lineRects = lineRange.getClientRects();
  const lineBox = lineRects[0];
  const rasterScale = 2; // fixed production policy
  return {
    box: { left: box.left, top: box.top, width: box.width, height: box.height },
    maskInk:
      mask !== null && Number.isFinite(inkTop)
        ? {
            left: inkLeft / rasterScale,
            top: inkTop / rasterScale,
            right: inkRight / rasterScale,
            bottom: inkBottom / rasterScale,
          }
        : null,
    maskSize: mask !== null ? [mask.width, mask.height] : null,
    maskSizeCss: [Math.round(box.width), Math.round(box.height)],
    rasterScale,
    canDelegateInk: entry !== undefined && entry.inkDelegated === true,
    lineRectCount: lineRects.length,
    inkAttrPresent: span.getAttribute("data-ukibori-physical-ink") !== null,
    typography: {
      ...readComputedTypography(span),
      canvasSupport: probeCanvasTypographySupport(),
    },
    lineBox: lineBox
      ? { top: lineBox.top - box.top, height: lineBox.height, left: lineBox.left - box.left }
      : null,
    canvas: gpuCanvas !== null ? [gpuCanvas.width, gpuCanvas.height] : null,
  };
}

/**
 * #52 alignment/fidelity evidence: reconfigure the PRODUCTION <UkiboriText>
 * (text/weight/size/DPR, optional constrained width for the multiline
 * fixture) and report the PRODUCTION mask geometry from the registry. The DOM
 * ink bounds come from the runner's screenshot analysis (window.__measureInk)
 * — real rendered pixels, not line-box estimates.
 */
window.__configureAlignment = async ({
  text,
  fontWeight,
  fontPx,
  dpr,
  constrainWidth,
  textTransform,
  letterSpacing,
}) => {
  const style = {
    fontWeight,
    fontSize: `${fontPx}px`,
    textTransform: textTransform ?? undefined,
    letterSpacing: letterSpacing ?? undefined,
  };
  if (constrainWidth !== undefined) {
    style.width = `${constrainWidth}px`;
  }
  await applyConfig({ dpr, bias: null, glyph: true, glyphProps: glyphProps({ text, style }) });
  // The component rasterizes in its effect; re-normalize the layer-owned
  // suppression attribute after any prior DEBUG OVERRIDE (__setInk removes/
  // adds it behind the layer's back): the fixture state must reflect the
  // POLICY, not the override bookkeeping.
  const info = productionGlyphInfo();
  if (info.canDelegateInk) {
    document.getElementById("glyph").setAttribute("data-ukibori-physical-ink", "");
  } else {
    document.getElementById("glyph").removeAttribute("data-ukibori-physical-ink");
  }
  layer.invalidate();
  await settle(layer.gpuDevice);
  return productionGlyphInfo();
};

/**
 * Screenshot round-trip: load the runner-captured PNG into a 2d canvas and
 * segment the DOM text ink (dark pixels) inside the CURRENT glyph box. The
 * screenshot is viewport-aligned CSS pixels (headless DPR 1), so the result
 * is directly comparable with the mask ink bounds (also CSS-px box coords).
 */
window.__measureInk = async (dataUrl) => {
  const span = document.getElementById("glyph");
  const box = span.getBoundingClientRect();
  const image = new Image();
  await new Promise((resolveLoad, rejectLoad) => {
    image.onload = () => resolveLoad();
    image.onerror = () => rejectLoad(new Error("screenshot image load failed"));
    image.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const margin = 6;
  const x0 = Math.max(0, Math.floor(box.left) - margin);
  const y0 = Math.max(0, Math.floor(box.top) - margin);
  const x1 = Math.min(canvas.width, Math.ceil(box.right) + margin);
  const y1 = Math.min(canvas.height, Math.ceil(box.bottom) + margin);
  const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let inkTop = Infinity;
  let inkBottom = -Infinity;
  let inkLeft = Infinity;
  let inkRight = -Infinity;
  for (let y = 0; y < y1 - y0; y++) {
    for (let x = 0; x < x1 - x0; x++) {
      const p = (y * (x1 - x0) + x) * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const a = data[p + 3];
      // Ink = dark core pixels (the #222 glyph color); the panel/relief
      // grays stay above the threshold.
      if (a === 255 && 0.299 * r + 0.587 * g + 0.114 * b < 128) {
        inkTop = Math.min(inkTop, y0 + y);
        inkBottom = Math.max(inkBottom, y0 + y + 1);
        inkLeft = Math.min(inkLeft, x0 + x);
        inkRight = Math.max(inkRight, x0 + x + 1);
      }
    }
  }
  if (!Number.isFinite(inkTop)) {
    return null;
  }
  return {
    // viewport-absolute bbox and the same bbox relative to the span box
    absolute: { left: inkLeft, top: inkTop, right: inkRight, bottom: inkBottom },
    inBox: {
      left: inkLeft - box.left,
      top: inkTop - box.top,
      right: inkRight - box.left,
      bottom: inkBottom - box.top,
    },
    box: { left: box.left, top: box.top, width: box.width, height: box.height },
  };
};

async function main() {
  const resultEl = document.getElementById("result");
  try {
    if (!navigator.gpu) {
      resultEl.textContent = "GLYPH_ABLATION_SKIP navigator.gpu unavailable";
      return;
    }
    renderApp();
    const created = await Promise.race([
      layerReady,
      new Promise((resolve) => setTimeout(() => resolve(null), 30_000)),
    ]);
    if (created === null || created === undefined) {
      throw new Error(
        `layer creation failed${layerError ? `: ${layerError.stack ?? layerError}` : " (timeout)"}`,
      );
    }
    if (created.gpuPipeline === null || created.gpuPipeline === undefined) {
      resultEl.textContent = "GLYPH_ABLATION_SKIP webgpu pipeline unavailable (CPU fallback)";
      return;
    }
    // Let the production rasterization + registration/delegation settle.
    await settleAfterRender();
    await settle(created.gpuDevice);
    flush();
    created.invalidate();
    created.render();
    await settle(created.gpuDevice);
    window.__alignment = productionGlyphInfo();
    resultEl.textContent = "GLYPH_ABLATION_READY";
  } catch (error) {
    resultEl.textContent = `GLYPH_ABLATION_FAIL ${error && error.stack ? error.stack : error}`;
  }
}

main();
