// Real-Chrome integration harness for the UkiboriDom WebGPU path
// (UkiboriDom -> OverlayCanvas -> GpuScenePipeline -> REAL GPU canvas).
//
// Verifies, for DPR 1 / 1.5 / 2 and for in-layer DPR changes:
//   1. backend === "webgpu" and gpuFallbackReason === null (no silent fallback)
//   2. render extent == floor(region * dpr) 窶・NEVER DPRﾂｲ (dpr applied once)
//   3. the presented canvas backing store matches the render extent
//   4. no width/height attribute write happens after the last presentation
//      submit of a frame, and a retained re-render performs NO backing-store
//      write and NO new submission (the presented frame must survive)
//   5. the presented frames contain NON-TRANSPARENT surface pixels with a
//      transparent base plane, verified through TEST-ONLY staging copies of
//      the presented texture 窶・the exact Windows blank-frame regression.
//
// PIXEL READBACK NOTES (Windows/D3D specifics this harness is built around):
//   - The staging copy MUST be submitted in the SAME TASK as the present.
//     After an await, Chrome recycles the D3DSharedImage swapchain backing
//     ("Destroyed texture ... used in a submit") and late copies read zeros.
//   - drawImage from such canvases returns transparent content even when the
//     presented frame is opaque; it is informational only here.
//   - Production overlay frames are made stage-readable by wrapping the
//     layer-internal pipeline with debugReadback: true (pixels unchanged).
//
// The runner (scripts/test-webgpu-dom.mjs) parses only the first line of the
// #result block below.

import { UkiboriDom } from "../src/index";

const MARKER_PASS = "UKIBORI_DOM_GPU_PASS";
const MARKER_FAIL = "UKIBORI_DOM_GPU_FAIL";
const MARKER_SKIP = "UKIBORI_DOM_GPU_SKIP";

const BUTTON_RECT = { left: 100, top: 200, width: 160, height: 44 };
/** button rect inflated by the default 64 margin */
const REGION = { x: 36, y: 136, w: 288, h: 172 };

const BUTTON_OPTIONS = {
  id: "primary",
  shape: { kind: "roundedRect", radius: 10 },
  elevation: 4,
  thickness: 2,
  bevelWidth: 3,
  material: "silicone",
};

const failures = [];
const notes = [];
/** Every uncaptured error from every device created by this harness. */
const gpuErrors = [];
function note(text) {
  notes.push(text);
}
function check(condition, label) {
  if (!condition) {
    failures.push(label);
  }
}
function observeDevice(device, label) {
  device.onuncapturederror = (event) => {
    const message = String(event.error?.message ?? event.error);
    gpuErrors.push(`${label}: ${message}`);
  };
  return device;
}

/**
 * Minimal self-contained control (loaded by probe.html WITHOUT any
 * ukibori-dom code or bundling): one device, one canvas, the renderer ESM
 * file directly, one flatScene render, one staging readback. If this cannot
 * produce opaque pixels while the renderer parity harness can on the same
 * machine, the difference is purely page/runner-level.
 */
export async function runProbe() {
  const result = { marker: "PROBE_FAIL", detail: "" };
  try {
    const mod = await import("./renderer-index.js");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      result.detail = "no adapter";
      return result;
    }
    const device = observeDevice(await adapter.requestDevice(), "probe");
    const format = navigator.gpu.getPreferredCanvasFormat();
    const scene = mod.createScene({
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
    const canvas = document.createElement("canvas");
    canvas.width = 0;
    canvas.height = 0;
    document.body.appendChild(canvas);
    const context = canvas.getContext("webgpu");
    device.pushErrorScope("validation");
    const pipeline = new mod.GpuScenePipeline(device, context, format);
    try {
      const stats = pipeline.render({ scene, dpr: 1, debugReadback: true });
      // SAME-TASK copy submit: awaiting anything before the blit lets the
      // D3D swapchain recycle the presented texture (destroyed-texture
      // invalid copy -> silent zeros).
      const handle = submitPresentedCopy(device, context, stats.renderWidth, stats.renderHeight);
      const error = await device.popErrorScope();
      const rows = await stagingReadback(handle);
      result.detail =
        `extent=${stats.renderWidth}x${stats.renderHeight} maxAlpha=${stagingMaxAlpha(rows)} ` +
        `gpuError=${error ? error.message : "none"} ` +
        `deviceErrors=[${gpuErrors.join(" | ")}]`;
      result.marker = stagingMaxAlpha(rows) > 0 ? "PROBE_PASS" : "PROBE_TRANSPARENT";
    } finally {
      pipeline.dispose();
      canvas.remove();
    }
  } catch (error) {
    result.detail = String((error && error.stack) ?? error) + ` deviceErrors=[${gpuErrors.join(" | ")}]`;
  }
  return result;
}
function eq(actual, expected, label) {
  check(
    actual === expected,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

/**
 * Deterministic scheduler: renders run only when flush() is called, so every
 * assertion has a fixed happens-before relation to the frames it inspects.
 */
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

/**
 * Replace instance width/height accessors with RECORDING ones that DELEGATE
 * to the real prototype accessors, logging into a shared timeline. Models
 * real browser semantics under test: ANY assignment, even same-value, resets
 * the canvas bitmap/context.
 */
function instrumentBackingStore(canvas, timeline) {
  const proto = Object.getPrototypeOf(canvas);
  const widthDesc = Object.getOwnPropertyDescriptor(proto, "width");
  const heightDesc = Object.getOwnPropertyDescriptor(proto, "height");
  if (!widthDesc || !heightDesc || !widthDesc.set || !heightDesc.set) {
    throw new Error("cannot instrument canvas size accessors");
  }
  Object.defineProperty(canvas, "width", {
    configurable: true,
    get: () => widthDesc.get.call(canvas),
    set: (value) => {
      timeline.push(`resize-width ${widthDesc.get.call(canvas)}->${value}`);
      widthDesc.set.call(canvas, value);
    },
  });
  Object.defineProperty(canvas, "height", {
    configurable: true,
    get: () => heightDesc.get.call(canvas),
    set: (value) => {
      timeline.push(`resize-height ${heightDesc.get.call(canvas)}->${value}`);
      heightDesc.set.call(canvas, value);
    },
  });
}

function wrapQueueSubmit(device, timeline) {
  const queue = device.queue;
  const raw = queue.submit.bind(queue);
  queue.submit = (commandBuffers) => {
    timeline.push("submit");
    return raw(commandBuffers);
  };
}

/**
 * Coarse-grid scan of the whole canvas: reports max alpha and the count of
 * opaque texels. INFORMATIONAL ONLY: drawImage from a D3DSharedImage-backed
 * WebGPU canvas whose backing store was resized returns transparent content
 * in headless Chrome even when the presented frame is opaque 窶・staging copies
 * (submitPresentedCopy) are the ground truth for all assertions.
 */
function scanCanvas(gpuCanvas) {
  const probe = document.createElement("canvas");
  probe.width = gpuCanvas.width;
  probe.height = gpuCanvas.height;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(gpuCanvas, 0, 0);
  const step = Math.max(4, Math.floor(Math.min(gpuCanvas.width, gpuCanvas.height) / 16));
  let maxAlpha = 0;
  let opaque = 0;
  let total = 0;
  for (let y = 0; y < gpuCanvas.height; y += step) {
    for (let x = 0; x < gpuCanvas.width; x += step) {
      const a = ctx.getImageData(x, y, 1, 1).data[3];
      total++;
      if (a > maxAlpha) {
        maxAlpha = a;
      }
      if (a === 255) {
        opaque++;
      }
    }
  }
  return { maxAlpha, opaque, total };
}

function surfaceCenterPoint(dpr) {
  // Button center in CSS (180, 222) -> region-relative device pixels.
  return [Math.floor((180 - REGION.x) * dpr), Math.floor((222 - REGION.y) * dpr)];
}
function basePlanePoint(dpr) {
  // A point inside the shadow margin (lit base plane -> transparent).
  return [Math.floor(10 * dpr), Math.floor(10 * dpr)];
}

function makeStage() {
  const stage = document.createElement("div");
  document.body.appendChild(stage);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Press me";
  stage.appendChild(button);
  const rect = { ...BUTTON_RECT, x: BUTTON_RECT.left, y: BUTTON_RECT.top };
  button.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      toJSON: () => rect,
    });
  return { stage, button };
}

function makeGlyphStage() {
  const stage = document.createElement("div");
  stage.style.setProperty("--glyph-color", "rgb(255, 0, 0)");
  document.body.appendChild(stage);
  const glyph = document.createElement("span");
  glyph.textContent = "PLAY";
  glyph.style.color = "var(--glyph-color)";
  stage.appendChild(glyph);
  const rect = { ...BUTTON_RECT, x: BUTTON_RECT.left, y: BUTTON_RECT.top };
  glyph.getBoundingClientRect = () => ({
    ...rect,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => rect,
  });
  return { stage, glyph };
}

/** The lazily created WebGPU canvas (overlay-internal accessor, test seam). */
function gpuCanvasOf(layer) {
  return layer.overlay.gpuCanvas();
}

/**
 * TEST-ONLY: force COPY_SRC on the PRODUCTION overlay frames by wrapping the
 * layer-internal GpuScenePipeline.render (runtime access to the private
 * field 窶・the same test-seam convention the unit tests use). The rendered
 * pixels are identical; only the canvas texture gains COPY_SRC so the
 * presented frame can be stage-read back IN THE SAME TASK as the present.
 * drawImage is NOT a reliable readback for D3DSharedImage-backed canvases
 * whose backing store was resized (returns transparent), which is why every
 * pixel assertion here goes through staging copies instead.
 */
function wrapPipelineDebugReadback(layer) {
  const pipeline = layer.gpuPipeline;
  if (!pipeline) {
    throw new Error("layer has no internal gpuPipeline");
  }
  const original = pipeline.render.bind(pipeline);
  pipeline.render = (input) => original({ ...input, debugReadback: true });
}

/** One normalized RGBA pixel out of tightly packed staging rows. */
function stagingPixel(rows, width, [x, y]) {
  const p = (y * width + x) * 4;
  const pixel = [rows[p], rows[p + 1], rows[p + 2], rows[p + 3]];
  return navigator.gpu.getPreferredCanvasFormat() === "bgra8unorm"
    ? [pixel[2], pixel[1], pixel[0], pixel[3]]
    : pixel;
}

function assertFrameHealthy(layer, gpuCanvas, timeline, dpr, phaseLabel) {
  const state = layer.debugState();
  eq(state.backend, "webgpu", `${phaseLabel} backend`);
  eq(state.gpuFallbackReason, null, `${phaseLabel} gpuFallbackReason`);

  // DPR applied EXACTLY ONCE (device-pixel extents, never DPR^2).
  const expectedW = Math.floor(REGION.w * dpr);
  const expectedH = Math.floor(REGION.h * dpr);
  eq(state.gpuFrame.frame.renderWidth, expectedW, `${phaseLabel} renderWidth`);
  eq(state.gpuFrame.frame.renderHeight, expectedH, `${phaseLabel} renderHeight`);
  if (dpr !== 1) {
    check(
      state.gpuFrame.frame.renderWidth !== Math.floor(REGION.w * dpr * dpr),
      `${phaseLabel} renderWidth is DPR-squared (${state.gpuFrame.frame.renderWidth})`,
    );
  }
  eq(state.dpr, dpr, `${phaseLabel} debugState.dpr`);
  eq(gpuCanvas.width, expectedW, `${phaseLabel} canvas.width`);
  eq(gpuCanvas.height, expectedH, `${phaseLabel} canvas.height`);

  // Lifecycle invariant: nothing may resize the canvas after its present.
  eq(timeline[timeline.length - 1], "submit", `${phaseLabel} last event is a submit`);
  timeline.forEach((event, index) => {
    if (event.startsWith("resize-")) {
      check(
        timeline.slice(index + 1).includes("submit"),
        `${phaseLabel}: "${event}" has no later presentation submit`,
      );
    }
  });
}

async function settle(device) {
  // Wait until all submitted work completed, then give the compositor two
  // frames so the presented content is readable via drawImage.
  await device.queue.onSubmittedWorkDone();
  await nextFrame();
  await nextFrame();
}

async function runFixedDprScenario(dpr) {
  const label = `dpr ${dpr}`;
  const { stage, button } = makeStage();
  const timeline = [];
  const layer = await UkiboriDom.create({
    backend: "webgpu",
    dpr,
    observe: false,
    schedule,
    overlay: { stage },
  });
  try {
    const device = layer.gpuDevice;
    check(device != null, `${label}: internal gpuDevice missing`);
    wrapQueueSubmit(device, timeline);
    // TEST-ONLY seam: production frames become stage-readable (COPY_SRC).
    wrapPipelineDebugReadback(layer);

    const canvases = stage.querySelectorAll("canvas[data-ukibori-overlay]");
    eq(canvases.length, 2, `${label}: overlay canvas count`);
    const gpuCanvas = gpuCanvasOf(layer);
    instrumentBackingStore(gpuCanvas, timeline);

    layer.register(button, BUTTON_OPTIONS);
    flush();
    // SAME TASK as the present: capture the production frame's texture into
    // a staging copy BEFORE any await can recycle the D3D swapchain backing.
    const expectedW = Math.floor(REGION.w * dpr);
    const expectedH = Math.floor(REGION.h * dpr);
    const initialHandle = submitPresentedCopy(device, gpuCanvas.getContext("webgpu"), expectedW, expectedH);
    await settle(device);
    const initialRows = await stagingReadback(initialHandle);

    assertFrameHealthy(layer, gpuCanvas, timeline, dpr, `${label} initial frame`);
    const st = layer.debugState();
    note(
      `${label} diag: gpuErrors=[${layer.debugGpuDiagnostics().join(" | ")}] ` +
        `executed=[${st.gpuFrame.frame.invalidation.executed}] ` +
        `upload=${st.gpuFrame.frame.upload.bytesUploaded}B ` +
        `height={sdf:${st.gpuFrame.frame.height.maskSdfPasses},compose:${st.gpuFrame.frame.height.composePasses},sub:${st.gpuFrame.frame.height.submissions}} ` +
        `normal.sub=${st.gpuFrame.frame.normal.submissions} shadow.sub=${st.gpuFrame.frame.shadow.submissions} ` +
        `lighting.sub=${st.gpuFrame.frame.lighting.submissions} present.sub=${st.gpuFrame.frame.presentation.workSubmitted} ` +
        `drawScan=${JSON.stringify(scanCanvas(gpuCanvas))}`,
    );
    const resizesAfterInitial = timeline.filter((e) => e.startsWith("resize-")).length;
    const submitsAfterInitial = timeline.filter((e) => e === "submit").length;

    // STAGING ground truth: opaque surface pixels on a transparent base plane.
    const [surface0, base0] = [
      stagingPixel(initialRows, expectedW, surfaceCenterPoint(dpr)),
      stagingPixel(initialRows, expectedW, basePlanePoint(dpr)),
    ];
    check(
      surface0[3] === 255,
      `${label} initial frame surface alpha: rgba(${surface0}) at ${surfaceCenterPoint(dpr)}`,
    );
    eq(base0[3], 0, `${label} initial frame base-plane alpha`);

    // RETAINED re-render (byte-identical scene): NO new submissions, NO
    // backing-store writes 窶・the presented frame must survive untouched.
    layer.setShadow({});
    flush();
    layer.invalidate();
    flush();

    eq(
      timeline.filter((e) => e === "submit").length,
      submitsAfterInitial,
      `${label} retained re-render added submissions`,
    );
    eq(
      timeline.filter((e) => e.startsWith("resize-")).length,
      resizesAfterInitial,
      `${label} retained re-render wrote the backing store`,
    );

    const frame = layer.debugState().gpuFrame.frame;
    check(frame.invalidation.retained === true, `${label} last pipeline frame was not retained`);

    // After the retained boundary the pipeline must still present healthy
    // frames: force one REAL change (different shadow options -> full chain
    // incl. presentation) and stage-read it again.
    layer.setShadow({ bias: 0.4 });
    flush();
    const afterRetainedHandle = submitPresentedCopy(device, gpuCanvas.getContext("webgpu"), expectedW, expectedH);
    await settle(device);
    const afterRetainedRows = await stagingReadback(afterRetainedHandle);
    const surface1 = stagingPixel(afterRetainedRows, expectedW, surfaceCenterPoint(dpr));
    const base1 = stagingPixel(afterRetainedRows, expectedW, basePlanePoint(dpr));
    check(
      surface1[3] === 255,
      `${label} post-retained frame surface alpha: rgba(${surface1})`,
    );
    eq(base1[3], 0, `${label} post-retained frame base-plane alpha`);
    note(`${label} post-retained drawScan=${JSON.stringify(scanCanvas(gpuCanvas))}`);
  } finally {
    layer.dispose();
    stage.remove();
  }
}

async function runDprChangeScenario() {
  const label = "dpr change";
  const { stage, button } = makeStage();
  const timeline = [];
  const layer = await UkiboriDom.create({
    backend: "webgpu",
    dpr: 1,
    observe: false,
    schedule,
    overlay: { stage },
  });
  try {
    wrapQueueSubmit(layer.gpuDevice, timeline);
    wrapPipelineDebugReadback(layer);
    const gpuCanvas = gpuCanvasOf(layer);
    instrumentBackingStore(gpuCanvas, timeline);

    layer.register(button, BUTTON_OPTIONS);
    flush();
    assertFrameHealthy(layer, gpuCanvas, timeline, 1, `${label} at dpr 1`);
    const eventsAtDpr1 = timeline.length;

    // 1 -> 2: exactly one guarded resize pair BEFORE the next present.
    layer.setDpr(2);
    flush();
    const handle2 = submitPresentedCopy(layer.gpuDevice, gpuCanvas.getContext("webgpu"), Math.floor(REGION.w * 2), Math.floor(REGION.h * 2));
    await settle(layer.gpuDevice);
    const rows2 = await stagingReadback(handle2);
    const added = timeline.slice(eventsAtDpr1);
    eq(added.filter((e) => e.startsWith("resize-")).length, 2, `${label} 1->2 resize pair count`);
    check(added.includes("resize-width 288->576"), `${label} 1->2 width write: [${added}]`);
    check(added.includes("resize-height 172->344"), `${label} 1->2 height write`);
    eq(timeline[timeline.length - 1], "submit", `${label} 1->2 last event is a submit`);
    assertFrameHealthy(layer, gpuCanvas, timeline, 2, `${label} at dpr 2`);
    const surface2 = stagingPixel(rows2, Math.floor(REGION.w * 2), surfaceCenterPoint(2));
    eq(surface2[3], 255, `${label} at dpr 2 surface alpha`);

    // 2 -> 1.5.
    const eventsAtDpr2 = timeline.length;
    layer.setDpr(1.5);
    flush();
    const handle15 = submitPresentedCopy(layer.gpuDevice, gpuCanvas.getContext("webgpu"), Math.floor(REGION.w * 1.5), Math.floor(REGION.h * 1.5));
    await settle(layer.gpuDevice);
    const rows15 = await stagingReadback(handle15);
    const added15 = timeline.slice(eventsAtDpr2);
    eq(added15.filter((e) => e.startsWith("resize-")).length, 2, `${label} 2->1.5 resize pair count`);
    check(added15.includes("resize-width 576->432"), `${label} 2->1.5 width write: [${added15}]`);
    eq(timeline[timeline.length - 1], "submit", `${label} 2->1.5 last event is a submit`);
    assertFrameHealthy(layer, gpuCanvas, timeline, 1.5, `${label} at dpr 1.5`);
    const surface15 = stagingPixel(rows15, Math.floor(REGION.w * 1.5), surfaceCenterPoint(1.5));
    eq(surface15[3], 255, `${label} at dpr 1.5 surface alpha`);
  } finally {
    layer.dispose();
    stage.remove();
  }
}

/** #56 real-WebGPU proof: live inherited CSS color becomes material albedo. */
async function runGlyphColorScenario() {
  const label = "glyph css color";
  const { stage, glyph } = makeGlyphStage();
  const layer = await UkiboriDom.create({
    backend: "webgpu",
    dpr: 1,
    observe: false,
    schedule,
    overlay: { stage },
  });
  try {
    const device = layer.gpuDevice;
    wrapPipelineDebugReadback(layer);
    const gpuCanvas = gpuCanvasOf(layer);
    const mask = { width: 40, height: 11, alpha: new Float32Array(40 * 11).fill(1) };
    layer.register(glyph, {
      id: "glyph-color",
      shape: { kind: "mask", mask },
      elevation: 2,
      thickness: 2,
      bevelWidth: 1,
      profile: { kind: "bevel" },
      material: "metal",
      castsShadow: false,
      receivesShadow: false,
      delegateTextInk: true,
    });
    flush();
    const context = gpuCanvas.getContext("webgpu");
    const redHandle = submitPresentedCopy(device, context, REGION.w, REGION.h);
    await settle(device);
    const redRows = await stagingReadback(redHandle);
    const red = stagingPixel(redRows, REGION.w, surfaceCenterPoint(1));
    check(red[0] > red[2] + 20, `${label}: red CSS did not produce red albedo rgba(${red})`);
    eq(glyph.getAttribute("data-ukibori-physical-ink"), "", `${label}: opaque red delegation`);

    // Inherited CSS-variable/theme-style update. Explicit invalidate is the
    // observe:false test equivalent of the production document observer.
    stage.style.setProperty("--glyph-color", "rgb(0, 0, 255)");
    layer.invalidate("glyph-color");
    flush();
    const blueHandle = submitPresentedCopy(device, context, REGION.w, REGION.h);
    await settle(device);
    const blueRows = await stagingReadback(blueHandle);
    const blue = stagingPixel(blueRows, REGION.w, surfaceCenterPoint(1));
    check(blue[2] > blue[0] + 20, `${label}: blue update did not produce blue albedo rgba(${blue})`);

    stage.style.setProperty("--glyph-color", "rgba(0, 0, 255, 0.5)");
    layer.invalidate("glyph-color");
    flush();
    eq(glyph.getAttribute("data-ukibori-physical-ink"), null, `${label}: alpha fallback`);
    note(`${label}: red=rgba(${red}) blue=rgba(${blue}) alphaFallback=true`);
  } finally {
    layer.dispose();
    stage.remove();
  }
}

/**
 * CPU control through the SAME UkiboriDom pipeline: if the CPU canvas is
 * opaque at the surface center, DOM geometry/measurement are correct and any
 * GPU-side transparency is a GPU-path defect (not a scene defect).
 */
async function runCpuControlScenario() {
  const { stage, button } = makeStage();
  const layer = await UkiboriDom.create({
    backend: "cpu",
    observe: false,
    schedule,
    overlay: { stage },
  });
  try {
    layer.register(button, BUTTON_OPTIONS);
    flush();
    const canvases = stage.querySelectorAll("canvas[data-ukibori-overlay]");
    const cpuCanvas = canvases[0];
    const ctx = cpuCanvas.getContext("2d");
    const state = layer.debugState();
    const px = ctx.getImageData(144, 86, 1, 1).data;
    note(
      `cpu control: backend=${state.backend} size=${cpuCanvas.width}x${cpuCanvas.height} ` +
        `center=rgba(${Array.from(px)})`,
    );
  } finally {
    layer.dispose();
    stage.remove();
  }
}

/**
 * TEST-ONLY presented-frame capture (the parity harness pattern, CRITICAL on
 * Windows/D3D): the current texture MUST be captured and the staging copy
 * SUBMITTED SYNCHRONOUSLY IN THE SAME TASK as the presentation submission.
 * After an await, the D3DSharedImage swapchain backing may be recycled
 * ("Destroyed texture ... used in a submit") and a late copy would silently
 * read zeros. Returns a pending handle; resolve it with readStaging().
 */
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

function stagingMaxAlpha(rows) {
  let maxAlpha = 0;
  for (let i = 3; i < rows.length; i += 4) {
    if (rows[i] > maxAlpha) {
      maxAlpha = rows[i];
    }
  }
  return maxAlpha;
}


async function main() {
  const resultEl = document.getElementById("result");
  if (!navigator.gpu) {
    resultEl.textContent =
      `${MARKER_SKIP} navigator.gpu unavailable in this browser`;
    return;
  }
  try {
    // Environment gate: a raw hand-rolled pipeline on a NEVER-RESIZED canvas
    // must present opaque pixels readable via drawImage. If this fails, the
    // browser/adapter environment itself is broken (not the app code).
    const sanity = await runRawWebgpuReadbackSanity();
    check(sanity.maxAlpha === 255, `raw webgpu readback sanity: ${JSON.stringify(sanity)}`);

    await runCpuControlScenario();
    await runFixedDprScenario(1);
    await runFixedDprScenario(1.5);
    await runFixedDprScenario(2);
    await runDprChangeScenario();
    await runGlyphColorScenario();
    const notesText =
      notes.map((n) => `  # ${n}`).join("\n") +
      (gpuErrors.length > 0
        ? "\n" + gpuErrors.map((e) => `  ! ${e}`).join("\n")
        : "");
    if (failures.length === 0) {
      resultEl.textContent =
        `${MARKER_PASS} dom+gpu lifecycle verified at dpr 1/1.5/2 incl. retained survival\n${notesText}`;
    } else {
      resultEl.textContent =
        `${MARKER_FAIL} ${failures.length} failure(s):\n` +
        failures.map((f) => `  - ${f}`).join("\n") +
        `\n${notesText}`;
    }
  } catch (error) {
    resultEl.textContent =
      `${MARKER_FAIL} harness threw: ${error && error.stack ? error.stack : String(error)}\n` +
      failures.map((f) => `  - ${f}`).join("\n") +
      "\n" +
      notes.map((n) => `  # ${n}`).join("\n");
  }
}

/**
 * Raw-WebGPU control: present one fullscreen OPAQUE triangle through a
 * hand-rolled pipeline (no ukibori code) and scan the canvas. Proves (or
 * refutes) that drawImage readback of a presented WebGPU canvas works in
 * this browser/environment at all.
 */
async function runRawWebgpuReadbackSanity() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    return { maxAlpha: -1, note: "no adapter" };
  }
  const device = await adapter.requestDevice();
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("webgpu");
  context.configure({
    device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: "premultiplied",
  });
  const module = device.createShaderModule({
    code: `
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
        var pos = array<vec2<f32>, 3>(
          vec2<f32>(-1.0, -3.0), vec2<f32>(3.0, 1.0), vec2<f32>(-1.0, 1.0));
        return vec4<f32>(pos[i], 0.0, 1.0);
      }
      @fragment fn fs() -> @location(0) vec4<f32> {
        return vec4<f32>(0.0, 0.5, 1.0, 1.0);
      }
    `,
  });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await nextFrame();
  await nextFrame();
  const scan = scanCanvas(canvas);
  device.destroy();
  canvas.remove();
  return scan;
}

// Auto-run the full harness ONLY on the dom-gpu page; probe.html imports
// this module for the exported runProbe() control alone.
if (
  typeof location !== "undefined" &&
  location.pathname.endsWith("dom-gpu.html")
) {
  void main();
}
