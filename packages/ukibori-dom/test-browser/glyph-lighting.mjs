// #52 glyph lighting ablation harness (real Chrome, real WebGPU adapter).
//
// Root-cause evidence for "the physical glyph relief does not visibly respond
// to directional light". This page:
//
//   1. builds a demo-equivalent scene through the REAL UkiboriDom physical
//      path: a rounded-rect panel + a mask glyph span ("PLAY") rasterized
//      exactly like `UkiboriText.rasterizeText` (canvas 2d at the DEVICE
//      scale — window.devicePixelRatio clamped to [1, 2] — over the logical
//      CSS-pixel box, with the gcd-derived exactly-isotropic mask dims),
//      registered with the demo's glyph options
//      (elevation 3 / thickness 0.8 / bevelWidth 1.1, material metal)
//   2. for each light direction (left/right/top/bottom) renders a frame and
//      captures the PRESENTED canvas through a same-task staging copy
//      (debugReadback seam), then reports the physical glyph-region mean RGB
//      per direction and the |delta| between opposite directions  Ethe
//      CANVAS-side light response
//   3. repeats at pipeline DPR 1 / 1.5 / 2 (setDpr) to expose the render
//      grid resolution separately from the raster resolution
//   4. exposes `window.__setInk(visible)` so the RUNNER can toggle the DOM
//      glyph ink (visible vs suppressed) and capture page screenshots.
//      With the #52 production policy live, a registered mask surface owns
//      the data-ukibori-physical-ink suppression, so the ink-visible state
//      is a DEBUG OVERRIDE (removing the layer-owned attribute) that
//      reproduces the pre-fix appearance for comparison.
//
// The runner (scripts/glyph-ablation.mjs) drives `window.__prepare` /
// `window.__report` and screenshots selected conditions. The page is the
// evidence-collection tool for #52; production semantics live in
// src/overlay.ts + src/dom-layer.ts.

import { UkiboriDom } from "../src/index";

const STAGE_RECT = { x: 0, y: 0, w: 420, h: 260 };
const GLYPH_OPTIONS_BASE = {
  elevation: 3,
  thickness: 0.8,
  bevelWidth: 1.1,
  material: "metal",
};
const PANEL_OPTIONS = {
  shape: { kind: "roundedRect", radius: 10 },
  elevation: 0,
  thickness: 3,
  bevelWidth: 5,
  material: "matte",
};

const DIRECTIONS = {
  left: { x: -1, y: 0, z: 1 },
  right: { x: 1, y: 0, z: 1 },
  top: { x: 0, y: -1, z: 1 },
  bottom: { x: 0, y: 1, z: 1 },
};
const OPPOSITES = { left: "right", right: "left", top: "bottom", bottom: "top" };

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
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

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

/** Rasterize the span's text to a mask exactly like UkiboriText.rasterizeText
 * (including the #52 alignment policy AND the fidelity gate — review round 3
 * typography gate included: the result carries canDelegateInk, false for
 * multi-line/unmeasurable text or DOM typography the canvas cannot mirror). */

/**
 * Mirror of UkiboriText's computed-typography read/fingerprint (review
 * round 3). The fields and the default/mirror/fallback classification must
 * stay in sync with packages/ukibori/src/components/UkiboriText.tsx.
 */
function readComputedTypography(el) {
  const style = getComputedStyle(el);
  const read = (prop) => {
    const value = style[prop];
    return typeof value === "string" ? value : "";
  };
  return {
    font: read("font"),
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

function isDefaultValue(value, ...defaults) {
  return value === "" || defaults.includes(value);
}

function mirrorCanvasProperty(ctx, property, value) {
  if (!(property in ctx)) {
    return false;
  }
  try {
    ctx[property] = value;
  } catch {
    return false;
  }
  const applied = ctx[property];
  if (typeof applied !== "string") {
    return false;
  }
  if (applied === value) {
    return true;
  }
  const expected = Number.parseFloat(value);
  const actual = Number.parseFloat(applied);
  return Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) < 0.01;
}

function applyTypographyAndGate(ctx, typography) {
  // Hard fallbacks: DOM-only ink/metrics the canvas raster cannot mirror.
  if (!isDefaultValue(typography.textTransform, "none")) return false;
  if (!isDefaultValue(typography.writingMode, "horizontal-tb")) return false;
  if (!isDefaultValue(typography.textDecorationLine, "none")) return false;
  if (!isDefaultValue(typography.textEmphasisStyle, "none")) return false;
  if (!isDefaultValue(typography.webkitTextStrokeWidth, "0px")) return false;
  if (!isDefaultValue(typography.fontVariantPosition, "normal")) return false;
  if (!isDefaultValue(typography.fontFeatureSettings, "normal")) return false;
  if (!isDefaultValue(typography.fontVariationSettings, "normal")) return false;
  // Mirrorable drawing state: apply only when supported AND confirmed back.
  if (!isDefaultValue(typography.letterSpacing, "normal", "0px")) {
    if (!mirrorCanvasProperty(ctx, "letterSpacing", typography.letterSpacing)) return false;
  }
  if (!isDefaultValue(typography.wordSpacing, "normal", "0px")) {
    if (!mirrorCanvasProperty(ctx, "wordSpacing", typography.wordSpacing)) return false;
  }
  if (!isDefaultValue(typography.fontKerning, "auto")) {
    if (!mirrorCanvasProperty(ctx, "fontKerning", typography.fontKerning)) return false;
  }
  if (!isDefaultValue(typography.fontStretch, "normal", "100%")) {
    if (!mirrorCanvasProperty(ctx, "fontStretch", typography.fontStretch)) return false;
  }
  if (!isDefaultValue(typography.fontVariantCaps, "normal")) {
    if (!mirrorCanvasProperty(ctx, "fontVariantCaps", typography.fontVariantCaps)) return false;
  }
  if (!isDefaultValue(typography.textRendering, "auto")) {
    if (!mirrorCanvasProperty(ctx, "textRendering", typography.textRendering)) return false;
  }
  if (!isDefaultValue(typography.direction, "ltr")) {
    if (!mirrorCanvasProperty(ctx, "direction", typography.direction)) return false;
  }
  return true;
}

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

/**
 * Mirror of UkiboriText's device-scale supersampling policy. The requested
 * scale is `window.devicePixelRatio` clamped to `[1, 2]` (missing/non-finite/
 * non-positive -> 1); the raster footprint is the nearest common-multiplier
 * dimension pair so the mask aspect equals the logical box aspect exactly.
 */
const GLYPH_RASTER_SCALE_MAX = 2;

function currentDeviceRasterScale() {
  const dpr = window.devicePixelRatio;
  if (typeof dpr !== "number" || !Number.isFinite(dpr) || dpr <= 0) {
    return 1;
  }
  return Math.min(GLYPH_RASTER_SCALE_MAX, Math.max(1, dpr));
}

function greatestCommonDivisor(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x === 0 ? 1 : x;
}

function supersampledMaskSize(cssWidth, cssHeight, requestedScale) {
  const divisor = greatestCommonDivisor(cssWidth, cssHeight);
  const multiplier = Math.max(divisor, Math.round(requestedScale * divisor));
  return {
    width: (cssWidth / divisor) * multiplier,
    height: (cssHeight / divisor) * multiplier,
    scale: multiplier / divisor,
  };
}

/**
 * TEST-ONLY device-scale override for the harness: lets a condition emulate
 * a display DPR the way a real device reports it on window.devicePixelRatio
 * (the production component reads it live; headless Chrome would always
 * report 1).
 */
function setEffectiveDevicePixelRatio(dpr) {
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    get: () => dpr,
  });
}

function rasterizeGlyph(span) {
  const typography = readComputedTypography(span);
  const rect = span.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.round(rect.width));
  const cssHeight = Math.max(1, Math.round(rect.height));
  const raster = supersampledMaskSize(cssWidth, cssHeight, currentDeviceRasterScale());
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, raster.width, raster.height);
  ctx.font = typography.font;
  // Supersampled drawing space (mirror of UkiboriText): logical CSS
  // coordinates are mapped onto the denser raster; every anchor stays CSS px.
  ctx.setTransform(raster.scale, 0, 0, raster.scale, 0, 0);
  // #52 alignment policy + fidelity gate (mirror of UkiboriText.rasterizeText).
  let anchored = false;
  let canDelegateInk = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(span);
    const lineRects = range.getClientRects();
    const lineBox = lineRects.length === 1 ? lineRects[0] : undefined;
    const metrics = ctx.measureText(span.textContent);
    const ascent = metrics && metrics.fontBoundingBoxAscent;
    const descent = metrics && metrics.fontBoundingBoxDescent;
    if (
      lineBox !== undefined &&
      typeof ascent === "number" &&
      Number.isFinite(ascent) &&
      typeof descent === "number" &&
      Number.isFinite(descent) &&
      ascent + descent > 0
    ) {
      if (applyTypographyAndGate(ctx, typography)) {
        const halfLeading = (lineBox.height - (ascent + descent)) / 2;
        const baselineY = lineBox.top - rect.top + halfLeading + ascent;
        const anchorX = lineBox.left - rect.left;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = "#fff";
        ctx.fillText(span.textContent, anchorX, baselineY);
        anchored = true;
        canDelegateInk = true;
      }
    }
  } catch {
    // fall through to the legacy placement (delegation stays off)
  }
  if (!anchored) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(span.textContent, cssWidth / 2, cssHeight / 2);
  }
  const data = ctx.getImageData(0, 0, raster.width, raster.height).data;
  const alpha = new Float32Array(raster.width * raster.height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3] / 255;
  }
  return {
    mask: { width: raster.width, height: raster.height, alpha },
    canDelegateInk,
    typography,
    cssWidth,
    cssHeight,
    rasterScale: raster.scale,
  };
}

async function settle(device) {
  await device.queue.onSubmittedWorkDone();
  await nextFrame();
  await nextFrame();
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

let layer = null;
let gpuCanvas = null;
let glyphRect = null;
/** frames[groupKey][dir] = { rows, width, height, box, mean } */
const frames = {};
/** report[groupKey][dir / delta] = metrics */
const report = {};
let currentGroup = null;

function groupKey(dpr, ink) {
  return `dpr-${dpr}-ink-${ink ? "visible" : "suppressed"}`;
}

function glyphBox(dpr, width, height) {
  const pad = Math.max(2, Math.round(2 * dpr));
  const box = {
    x: Math.max(0, Math.floor((glyphRect.x - STAGE_RECT.x) * dpr) - pad),
    y: Math.max(0, Math.floor((glyphRect.y - STAGE_RECT.y) * dpr) - pad),
    w: Math.min(Math.ceil(glyphRect.w * dpr) + 2 * pad, width),
    h: Math.min(Math.ceil(glyphRect.h * dpr) + 2 * pad, height),
  };
  box.w = Math.max(1, Math.min(box.w, width - box.x));
  box.h = Math.max(1, Math.min(box.h, height - box.y));
  return box;
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

window.__prepare = async ({ direction, dpr, ink, readback = true }) => {
  const key = groupKey(dpr, ink);
  if (report[key] === undefined) {
    report[key] = {};
    frames[key] = {};
  }
  window.__setInk(ink);
  layer.setLight(DIRECTIONS[direction], 1);
  layer.setDpr(() => dpr);
  // Force a full re-render: an identical retained frame keeps the previous
  // presentation and a fresh getCurrentTexture() copy is not guaranteed to
  // still hold it, which would show up as an all-transparent capture.
  layer.invalidate();
  flush();
  if (!readback) {
    // Screenshot-only conditions: leave the presented frame untouched (a
    // post-present staging copy submit can blank the composited D3D
    // swapchain content). Metrics for these conditions come from their
    // readback twin earlier in the condition matrix.
    return null;
  }
  const { rows, width, height } = await readFrame();
  const box = glyphBox(dpr, width, height);
  const entry = { rows, width, height, box, mean: regionMean(rows, width, box) };
  frames[key][direction] = entry;
  report[key][direction] = { mean: entry.mean, box, canvas: [width, height] };
  const opposite = frames[key][OPPOSITES[direction]];
  if (opposite) {
    const d = regionDelta(entry.rows, opposite.rows, width, box);
    report[key][`delta-${direction}-${OPPOSITES[direction]}`] = d;
  }
  return report[key][direction];
};

window.__report = () => report;

/**
 * #52 alignment/fidelity evidence: reconfigure the glyph span
 * (text/weight/size/DPR, optional constrained width for the multiline
 * fixture) through the UkiboriText lifecycle (measure box -> rasterize with
 * the fidelity gate -> fix box -> retained mask + intent update) and report
 * the MASK ink bounds in box coordinates. The DOM ink bounds come from the
 * runner's screenshot analysis (window.__measureInk) — real rendered
 * pixels, not line-box estimates.
 */
window.__configureAlignment = async ({ text, fontWeight, fontPx, dpr, constrainWidth, textTransform, letterSpacing }) => {
  const span = document.getElementById("glyph");
  const stage = document.getElementById("stage");
  // Reset to the measurement state so the box is measured like a fresh
  // UkiboriText mount (the logical box must come from the measured rect).
  span.style.display = constrainWidth !== undefined ? "inline-block" : "";
  span.style.width = constrainWidth !== undefined ? `${constrainWidth}px` : "";
  span.style.height = "";
  span.style.font = `${fontWeight} ${fontPx}px "Segoe UI", Arial, sans-serif`;
  span.style.textTransform = textTransform ?? "";
  span.style.letterSpacing = letterSpacing ?? "";
  span.textContent = text;
  // The alignment matrix's dpr is the DEVICE scale for the raster mirror
  // (real devices report it on window.devicePixelRatio).
  setEffectiveDevicePixelRatio(dpr);
  const rect = span.getBoundingClientRect();
  const raster = rasterizeGlyph(span);
  const mask = raster.mask;
  span.style.display = "inline-block";
  span.style.width = `${raster.cssWidth}px`;
  span.style.height = `${raster.cssHeight}px`;
  glyphRect = { x: rect.left, y: rect.top, w: raster.cssWidth, h: raster.cssHeight };
  layer.setDpr(() => dpr);
  // #52 fidelity policy: the delegation intent follows the rasterization
  // gate (multi-line/unmeasurable rasters keep the DOM ink visible).
  layer.updateSurface("glyph", {
    shape: { kind: "mask", mask },
    delegateTextInk: raster.canDelegateInk,
  });
  flush();
  await settle(layer.gpuDevice);
  // Re-normalize the layer-owned suppression attribute after any prior
  // DEBUG OVERRIDE (__setInk removes/adds it behind the layer's back): the
  // fixture state must reflect the POLICY, not the override bookkeeping.
  if (raster.canDelegateInk) {
    span.setAttribute("data-ukibori-physical-ink", "");
  } else {
    span.removeAttribute("data-ukibori-physical-ink");
  }
  // #52 policy evidence: the live line-rect count and the delegation state
  // AFTER the retained update (multi-line text must leave the ink visible).
  const lineRange = document.createRange();
  lineRange.selectNodeContents(span);
  const lineRectsAfter = lineRange.getClientRects();
  // Mask ink bounds in box coordinates (the production SDF threshold),
  // converted from raster px to LOGICAL CSS px (rasterScale mask px = 1 CSS
  // px) so they are directly comparable with the screenshot-measured DOM ink.
  let inkTop = Infinity;
  let inkBottom = -Infinity;
  let inkLeft = Infinity;
  let inkRight = -Infinity;
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
  const box = span.getBoundingClientRect();
  const lineBox = lineRectsAfter[0];
  return {
    box: { left: box.left, top: box.top, width: box.width, height: box.height },
    maskInk: Number.isFinite(inkTop)
      ? {
          left: inkLeft / raster.rasterScale,
          top: inkTop / raster.rasterScale,
          right: inkRight / raster.rasterScale,
          bottom: inkBottom / raster.rasterScale,
        }
      : null,
    maskSize: [mask.width, mask.height],
    maskSizeCss: [raster.cssWidth, raster.cssHeight],
    rasterScale: raster.rasterScale,
    canDelegateInk: raster.canDelegateInk,
    lineRectCount: lineRectsAfter.length,
    inkAttrPresent: span.getAttribute("data-ukibori-physical-ink") !== null,
    // #52 review round 3: the computed typography the gate evaluated and
    // the canvas mirror capabilities of THIS Chrome build.
    typography: {
      textTransform: raster.typography.textTransform,
      letterSpacing: raster.typography.letterSpacing,
      wordSpacing: raster.typography.wordSpacing,
      fontStretch: raster.typography.fontStretch,
      fontKerning: raster.typography.fontKerning,
      fontVariantCaps: raster.typography.fontVariantCaps,
      textRendering: raster.typography.textRendering,
      direction: raster.typography.direction,
      textDecorationLine: raster.typography.textDecorationLine,
      canvasSupport: probeCanvasTypographySupport(),
    },
    lineBox: lineBox
      ? { top: lineBox.top - box.top, height: lineBox.height, left: lineBox.left - box.left }
      : null,
    canvas: [gpuCanvas.width, gpuCanvas.height],
  };
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
  const span = document.getElementById("glyph");
  const stage = document.getElementById("stage");
  try {
    if (!navigator.gpu) {
      resultEl.textContent = "GLYPH_ABLATION_SKIP navigator.gpu unavailable";
      return;
    }
    // Measure + fix the span box exactly like UkiboriText (logical integer
    // CSS-pixel box; the raster itself follows the device scale).
    const rect = span.getBoundingClientRect();
    const raster = rasterizeGlyph(span);
    const mask = raster.mask;
    span.style.display = "inline-block";
    span.style.width = `${raster.cssWidth}px`;
    span.style.height = `${raster.cssHeight}px`;
    glyphRect = { x: rect.left, y: rect.top, w: raster.cssWidth, h: raster.cssHeight };

    // Vertical alignment evidence: where does the DOM line box put the ink
    // inside the logical box, vs where the supersampled mask raster put it
    // (baseline-anchored since #52; reported in CSS px).
    const range = document.createRange();
    range.selectNodeContents(span);
    const lineBox = range.getClientRects()[0];
    let inkTop = Infinity;
    let inkBottom = -Infinity;
    for (let y = 0; y < mask.height; y++) {
      let any = false;
      for (let x = 0; x < mask.width; x++) {
        if (mask.alpha[y * mask.width + x] >= 0.5) {
          any = true;
          break;
        }
      }
      if (any) {
        inkTop = Math.min(inkTop, y);
        inkBottom = Math.max(inkBottom, y);
      }
    }
    window.__alignment = {
      maskInk: {
        top: inkTop / raster.rasterScale,
        bottom: inkBottom / raster.rasterScale,
        height: raster.cssHeight,
      },
      maskSize: [mask.width, mask.height],
      maskSizeCss: [raster.cssWidth, raster.cssHeight],
      rasterScale: raster.rasterScale,
      domLineBox: { top: lineBox.top - rect.top, bottom: lineBox.bottom - rect.top, height: lineBox.height },
    };

    layer = await UkiboriDom.create({
      backend: "webgpu",
      dpr: 1,
      observe: false,
      schedule,
      overlay: { stage },
    });
    // TEST-ONLY: make the presented frame stage-readable (pixels unchanged).
    const pipeline = layer.gpuPipeline;
    const originalRender = pipeline.render.bind(pipeline);
    pipeline.render = (input) => originalRender({ ...input, debugReadback: true });
    gpuCanvas = layer.overlay.gpuCanvas();

    layer.register(span, {
      id: "glyph",
      shape: { kind: "mask", mask },
      ...GLYPH_OPTIONS_BASE,
      // #52 UkiboriText contract: this page's glyph span rasterizes ITS OWN
      // text into the mask, so the ink delegation intent follows the
      // rasterization fidelity gate (a generic mask surface would omit it
      // and keep its DOM text).
      delegateTextInk: raster.canDelegateInk,
    });
    // A panel under the glyph, matching the demo's glyph-panel context.
    const panel = document.createElement("div");
    panel.style.position = "absolute";
    panel.style.left = "20px";
    panel.style.top = "40px";
    panel.style.width = "380px";
    panel.style.height = "180px";
    stage.insertBefore(panel, span);
    layer.register(panel, { id: "panel", ...PANEL_OPTIONS });
    flush();
    await readFrame();

    resultEl.textContent = "GLYPH_ABLATION_READY";
  } catch (error) {
    resultEl.textContent = `GLYPH_ABLATION_FAIL ${error && error.stack ? error.stack : error}`;
  }
}

main();

