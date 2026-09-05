// #52 glyph lighting ablation harness (real Chrome, real WebGPU adapter).
//
// Root-cause evidence for "the physical glyph relief does not visibly respond
// to directional light". This page:
//
//   1. builds a demo-equivalent scene through the REAL UkiboriDom physical
//      path: a rounded-rect panel + a mask glyph span ("PLAY") rasterized
//      exactly like `UkiboriText.rasterizeText` (canvas 2d at the rounded CSS
//      pixel box), registered with the demo's glyph options
//      (elevation 3 / thickness 0.8 / bevelWidth 1.1, material metal)
//   2. for each light direction (left/right/top/bottom) renders a frame and
//      captures the PRESENTED canvas through a same-task staging copy
//      (debugReadback seam), then reports the physical glyph-region mean RGB
//      per direction and the |delta| between opposite directions  Ethe
//      CANVAS-side light response
//   3. repeats at DPR 1 / 1.5 / 2 (setDpr) to expose the mask-resolution
//      contract (the mask stays a CSS-px raster; the render grid densifies)
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

/** Rasterize the span's text to a mask exactly like UkiboriText.rasterizeText. */
function rasterizeGlyph(span) {
  const rect = span.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  const style = getComputedStyle(span);
  ctx.font = style.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.fillText(span.textContent, width / 2, height / 2);
  const data = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3] / 255;
  }
  return { width, height, alpha };
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
    span.style.color = "";
    // DEBUG OVERRIDE (#52): with the production policy live, a registered
    // mask surface owns the data-ukibori-physical-ink suppression, so the
    // pre-fix "ink visible" state is reproduced here by removing the
    // layer-owned attribute. Debug evidence tooling only.
    span.removeAttribute("data-ukibori-physical-ink");
  } else {
    span.style.color = "transparent";
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

async function main() {
  const resultEl = document.getElementById("result");
  const span = document.getElementById("glyph");
  const stage = document.getElementById("stage");
  try {
    if (!navigator.gpu) {
      resultEl.textContent = "GLYPH_ABLATION_SKIP navigator.gpu unavailable";
      return;
    }
    // Measure + fix the span box exactly like UkiboriText (integer policy).
    const rect = span.getBoundingClientRect();
    const mask = rasterizeGlyph(span);
    span.style.display = "inline-block";
    span.style.width = `${mask.width}px`;
    span.style.height = `${mask.height}px`;
    glyphRect = { x: rect.left, y: rect.top, w: mask.width, h: mask.height };

    // Vertical alignment evidence: where does the DOM line box put the ink
    // inside the fixed box, vs where the mask raster put it (textBaseline
    // "middle" at box center)? Both are pre-existing production behaviors
    // (UkiboriText rasterizes with middle baseline; the DOM paints the same
    // text with normal CSS line layout inside the same box).
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
      maskInk: { top: inkTop, bottom: inkBottom, height: mask.height },
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

