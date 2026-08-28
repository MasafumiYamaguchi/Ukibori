// #46 real-WebGPU benchmark harness (the counterpart of scripts/bench-gpu.mjs).
//
// Runs on a REAL adapter through the public bundled renderer ESM:
//
//   1. requests a real adapter/device (SKIP when unavailable), requesting
//      the optional `timestamp-query` feature when the adapter exposes it
//   2. runs every selected suite on deterministic scenes from
//      scripts/bench/lib/scenes.mjs (never inline fixtures)
//   3. reports host encode time (`hostMs`), real GPU timestamps
//      (`gpuTimestampMs`, only when timestamp-query works  Ean unsupported
//      feature stays report-only, never a fabricated zero), queue-completion
//      wall time (`wallMs`) SEPARATELY, plus submissions / dispatches /
//      workgroups / uploaded bytes / allocations per case
//   4. writes ONE unambiguous marker as the first line of the result block
//      (UKIBORI_BENCH_GPU_PASS / FAIL / SKIP) followed by
//      `SUMMARY <json>`  Ea versioned benchmark result document
//      (scripts/bench/lib/schema.mjs) that scripts/bench-gpu.mjs saves to
//      benchmark-results.json
//
// Timing honesty (#46 §23): the three mechanisms are NEVER merged into one
// total; every metric key follows the schema's canonical labels.
//
// Configuration comes from URL query parameters (the runner passes them
// through; defaults keep a single suite run under a couple of minutes):
//   ?suite=all|stage,e2e,...&warmup=3&samples=5&width=640&height=360

import {
  simpleRoundedRectScene,
  surfaceGridScene,
  glyphGridScene,
  maskHeavyScene,
  shadowScene,
  reconstructionHeavyScene,
  partialEditScene,
  SCENE_FAMILIES,
} from "./lib/scenes.mjs";
import { summarizeSeries } from "./lib/stats.mjs";
import {
  createResultDocument,
  validateResultDocument,
} from "./lib/schema.mjs";
import { collectBrowserEnvironment } from "./lib/env-browser.mjs";

const RESULT_EL = document.getElementById("result");
const MARKER_PASS = "UKIBORI_BENCH_GPU_PASS";
const MARKER_FAIL = "UKIBORI_BENCH_GPU_FAIL";
const MARKER_SKIP = "UKIBORI_BENCH_GPU_SKIP";

const api = await import("./index.js");

const query = new URLSearchParams(location.search);
const WIDTH = Number(query.get("width") ?? 640);
const HEIGHT = Number(query.get("height") ?? 360);
const WARMUP = Number(query.get("warmup") ?? 3);
const SAMPLES = Number(query.get("samples") ?? 5);
const RETAINED_FRAMES = Number(query.get("retainedFrames") ?? 20);
const SUITE_QUERY = query.get("suite") ?? "all";

const cases = [];
const notes = [];

let device = null;
let adapter = null;

// ---------------------------------------------------------------------------
// device / adapter
// ---------------------------------------------------------------------------

async function acquireDevice() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    return { adapter: null, device: null, reason: "no adapter" };
  }
  const wantsTimestamp = adapter.features?.has("timestamp-query") === true;
  try {
    const device = wantsTimestamp
      ? await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] })
      : await adapter.requestDevice();
    return { adapter, device, reason: null, timestampRequested: wantsTimestamp };
  } catch (error) {
    try {
      const device = await adapter.requestDevice();
      return {
        adapter,
        device,
        reason: `timestamp-query device request failed: ${errorMessage(error)}`,
        timestampRequested: wantsTimestamp,
      };
    } catch (fallbackError) {
      return {
        adapter: null,
        device: null,
        reason: `device request failed: ${errorMessage(fallbackError)}`,
      };
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// canvas / pipeline helpers
// ---------------------------------------------------------------------------

function makeCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 0;
  canvas.height = 0;
  document.body.appendChild(canvas);
  const context = canvas.getContext("webgpu");
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  return { canvas, context, canvasFormat };
}

/**
 * Render one frame and measure it with all three mechanisms, kept separate:
 *  - wallMs: performance.now() around render() + queue.onSubmittedWorkDone()
 *  - hostMs: stats.frame.hostMs (host encode/upload/dispatch wall time)
 *  - gpuTimestampMs: stats.gpuTiming (real GPU timestamps, null when
 *    unsupported/failed)
 */
async function timedRender(pipeline, input) {
  const t0 = performance.now();
  const stats = pipeline.render(input);
  await device.queue.onSubmittedWorkDone();
  const wallMs = performance.now() - t0;
  const gpuTiming = await stats.gpuTiming;
  return { wallMs, stats, gpuTiming };
}

/**
 * Run fn() WARMUP times (untimed), then SAMPLES timed runs, resolving with
 * the series of return values.
 */
async function benchSeries(fn, { warmups = WARMUP, sampleCount = SAMPLES } = {}) {
  for (let i = 0; i < warmups; i++) {
    await fn();
  }
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(await fn());
  }
  return samples;
}

function gpuSeriesOf(series, pick) {
  return series.map(pick).filter((v) => typeof v === "number" && Number.isFinite(v));
}

function totalGpuSummary(series) {
  const values = gpuSeriesOf(series, (r) => r.gpuTiming?.totalGpuMs);
  return values.length > 0 ? summarizeSeries(values) : null;
}

/**
 * Measure the UPDATE frame of `caseInput` against a `primerInput` on one
 * retained pipeline: every timed sample renders the primer first, so the
 * case frame is a genuine full recompute (retained repeats are
 * suiteRetained's job). Returns the series of timed results.
 */
async function benchUpdateFrame(pipeline, primerInput, caseInput, { warmups = WARMUP, sampleCount = SAMPLES } = {}) {
  for (let i = 0; i < warmups; i++) {
    await timedRender(pipeline, primerInput);
    await timedRender(pipeline, caseInput);
  }
  const series = [];
  for (let i = 0; i < sampleCount; i++) {
    await timedRender(pipeline, primerInput);
    series.push(await timedRender(pipeline, caseInput));
  }
  return series;
}

function snapshotWorkgroups(pipeline) {
  const snap = pipeline.getSnapshot();
  const out = {};
  for (const stage of ["heightPass", "normalPass", "shadowPass", "reconstructionPass", "lightingPass"]) {
    const pass = snap[stage];
    if (pass?.lastDispatch) {
      out[stage.replace("Pass", "")] = {
        workgroupCountX: pass.lastDispatch.workgroupCountX,
        ...(stage === "shadowPass"
          ? { steps: pass.lastDispatch.stepCount, samples: pass.options?.samples }
          : {}),
        ...(stage === "heightPass"
          ? {
              maskSdfPasses: pass.lastDispatch.maskSdfPasses,
              composePasses: pass.lastDispatch.composePasses,
              totalMaskCells: pass.lastDispatch.totalMaskCells,
            }
          : {}),
        ...(stage === "reconstructionPass"
          ? { radiusTexels: pass.options?.radiusTexels }
          : {}),
      };
    }
  }
  return out;
}

function pushCase(id, parameters, metrics) {
  cases.push({ id, parameters, metrics });
}

/**
 * Every benchmark scene must pass through the public `createScene`
 * validator/sanitizer exactly like production code: the pipeline consumes
 * the VALIDATED Scene (defaults filled, numbers sanitized), never a raw
 * fixture object.
 */
function sceneFor(builder) {
  return api.createScene(builder());
}

// ---------------------------------------------------------------------------
// §A  Estage benchmark: one full soft-shadow frame, per-stage timings
// ---------------------------------------------------------------------------

async function suiteStage() {
  const scene = sceneFor(() => reconstructionHeavyScene({ width: WIDTH, height: HEIGHT }));
  const primer = sceneFor(() => simpleRoundedRectScene({ width: WIDTH, height: HEIGHT }));
  const { canvas, context, canvasFormat } = makeCanvas();
  const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
  try {
    const series = await benchUpdateFrame(
      pipeline,
      { scene: primer, dpr: 1, shadowOptions: { samples: 8, maxDistance: 200, stepSize: 0.5, bias: 0.5 } },
      { scene, dpr: 1, shadowOptions: { samples: 8, maxDistance: 200, stepSize: 0.5, bias: 0.5 } },
    );
    const first = series[0];
    const snapshot = snapshotWorkgroups(pipeline);
    const stageList = ["upload", "height", "normal", "shadow", "reconstruction", "lighting", "presentation"];
    for (const stage of stageList) {
      pushCase(
        `stage/${stage}`,
        { suite: "stage", stage, resolution: `${WIDTH}x${HEIGHT}`, warmups: WARMUP, samples: SAMPLES },
        {
          hostMs: summarizeSeries(series.map((r) => r.stats.frame.passDurations[stage])),
          gpuTimestampMs: summarizeSeries(gpuSeriesOf(series, (r) => r.gpuTiming?.passGpuMs?.[stage])),
          submissions: first.stats.frame.submissions,
          dispatches: first.stats.frame.dispatchCount,
          bytesUploaded: first.stats.frame.bytesUploaded,
          newAllocations: first.stats.frame.newAllocations,
          renderExtent: `${first.stats.renderWidth}x${first.stats.renderHeight}`,
          workgroups: snapshot[stage]?.workgroupCountX ?? null,
        },
      );
    }
    pushCase(
      "stage/frame-total",
      { suite: "stage", resolution: `${WIDTH}x${HEIGHT}` },
      {
        wallMs: summarizeSeries(series.map((r) => r.wallMs)),
        hostMs: summarizeSeries(series.map((r) => r.stats.frame.hostMs)),
        gpuTimestampMs: totalGpuSummary(series),
        submissions: first.stats.frame.submissions,
        dispatches: first.stats.frame.dispatchCount,
        executed: first.stats.invalidation.executed.join(","),
        gpuTimestampStatus: first.gpuTiming?.status ?? "unsupported",
      },
    );
  } finally {
    pipeline.dispose();
    canvas.remove();
  }
}

// ---------------------------------------------------------------------------
// §B  Eend-to-end frame cases: cold / warm / retained / repaint / light /
// material / geometry / partial / forced-full
// ---------------------------------------------------------------------------

async function suiteE2E() {
  const { canvas, context, canvasFormat } = makeCanvas();
  const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
  const base = sceneFor(() => simpleRoundedRectScene({ width: WIDTH, height: HEIGHT }));
  try {
    const scenarios = [
      { id: "warmed-full", input: { scene: base, dpr: 1 } },
      { id: "retained", input: { scene: base, dpr: 1 } },
      { id: "repaint", input: { scene: base, dpr: 1, repaint: true } },
      { id: "light-intensity", input: {
        scene: sceneFor(() => ({ ...base, light: { ...base.light, intensity: 0.5 } })), dpr: 1,
      } },
      { id: "light-direction", input: {
        scene: sceneFor(() => ({
          ...base,
          light: { ...base.light, direction: { x: 0.5, y: 0.3, z: 0.8 } },
        })), dpr: 1,
      } },
      { id: "material-values", input: {
        scene: sceneFor(() => ({
          ...base,
          materials: {
            silicone: { baseColor: { r: 0.9, g: 0.3, b: 0.2 }, roughness: 0.5, metallic: 0, ior: 1.5 },
          },
        })), dpr: 1,
      } },
      { id: "geometry-move", input: {
        scene: sceneFor(() => simpleRoundedRectScene({ width: WIDTH, height: HEIGHT, slabSize: 60 })), dpr: 1,
      } },
      { id: "partial-geometry", input: {
        scene: sceneFor(() => simpleRoundedRectScene({ width: WIDTH, height: HEIGHT, slabSize: 120 })), dpr: 1,
      } },
      { id: "forced-full", input: { scene: base, dpr: 1 }, fresh: true },
    ];
    // cold-first: a FRESH pipeline's very first frame (pipeline/shader/
    // allocation cold costs are included, reported separately from the
    // warmed cases below)
    {
      const fresh = makeCanvas();
      const freshPipeline = new api.GpuScenePipeline(device, fresh.context, fresh.canvasFormat);
      try {
        const result = await timedRender(freshPipeline, { scene: base, dpr: 1 });
        pushCase(
          "e2e/cold-first",
          { suite: "e2e", case: "cold-first", resolution: `${WIDTH}x${HEIGHT}` },
          {
            wallMs: summarizeSeries([result.wallMs]),
            hostMs: summarizeSeries([result.stats.frame.hostMs]),
            gpuTimestampMs: result.gpuTiming?.totalGpuMs !== null
              ? summarizeSeries([result.gpuTiming.totalGpuMs])
              : null,
            submissions: result.stats.frame.submissions,
            dispatches: result.stats.frame.dispatchCount,
            bytesUploaded: result.stats.frame.bytesUploaded,
            executed: result.stats.invalidation.executed.join(","),
            planningMode: result.stats.planning.mode,
          },
        );
      } finally {
        freshPipeline.dispose();
        fresh.canvas.remove();
      }
    }
    for (const scenario of scenarios) {
      if (scenario.fresh) {
        // forced-full on a FRESH pipeline (retained equivalence baseline):
        // each sample recreates the pipeline so every sample is a genuine
        // full recompute (device warm, pipeline/allocations warm from the
        // warmup render below)
        const prime = makeCanvas();
        const primePipeline = new api.GpuScenePipeline(device, prime.context, prime.canvasFormat);
        try {
          for (let i = 0; i < WARMUP; i++) {
            await timedRender(primePipeline, scenario.input);
          }
        } finally {
          primePipeline.dispose();
          prime.canvas.remove();
        }
        const series = [];
        for (let i = 0; i < Math.min(3, SAMPLES); i++) {
          const fresh = makeCanvas();
          const freshPipeline = new api.GpuScenePipeline(device, fresh.context, fresh.canvasFormat);
          try {
            series.push(await timedRender(freshPipeline, scenario.input));
          } finally {
            freshPipeline.dispose();
            fresh.canvas.remove();
          }
        }
        const last = series[series.length - 1];
        pushCase(
            `e2e/${scenario.id}`,
            { suite: "e2e", case: scenario.id, resolution: `${WIDTH}x${HEIGHT}` },
            {
              wallMs: summarizeSeries(series.map((r) => r.wallMs)),
              hostMs: summarizeSeries(series.map((r) => r.stats.frame.hostMs)),
              gpuTimestampMs: totalGpuSummary(series),
              submissions: last.stats.frame.submissions,
              dispatches: last.stats.frame.dispatchCount,
              bytesUploaded: last.stats.frame.bytesUploaded,
              executed: last.stats.invalidation.executed.join(","),
              planningMode: last.stats.planning.mode,
            },
          );
        continue;
      }
      // Update-frame measurement: between every timed sample the pipeline is
      // reset to a primer scene, so each sample measures the REAL update
      // frame (not a retained repeat  Eretained costs are suiteRetained's
      // job). The warmup renders are untimed. `warmed-full` primes with a
      // different scene so the measured frame is a genuine full frame.
      const primer = scenario.id === "warmed-full"
        ? sceneFor(() => simpleRoundedRectScene({ width: WIDTH, height: HEIGHT, slabSize: 120 }))
        : base;
      for (let i = 0; i < WARMUP; i++) {
        await timedRender(pipeline, { scene: primer, dpr: 1 });
        await timedRender(pipeline, scenario.input);
      }
      const series = [];
      for (let i = 0; i < SAMPLES; i++) {
        await timedRender(pipeline, { scene: primer, dpr: 1 });
        series.push(await timedRender(pipeline, scenario.input));
      }
      const last = series[series.length - 1];
      pushCase(
        `e2e/${scenario.id}`,
        { suite: "e2e", case: scenario.id, resolution: `${WIDTH}x${HEIGHT}` },
        {
          wallMs: summarizeSeries(series.map((r) => r.wallMs)),
          hostMs: summarizeSeries(series.map((r) => r.stats.frame.hostMs)),
          gpuTimestampMs: totalGpuSummary(series),
          submissions: last.stats.frame.submissions,
          dispatches: last.stats.frame.dispatchCount,
          bytesUploaded: last.stats.frame.bytesUploaded,
          executed: last.stats.invalidation.executed.join(","),
          planningMode: last.stats.planning.mode,
        },
      );
    }
  } finally {
    pipeline.dispose();
    canvas.remove();
  }
}

// ---------------------------------------------------------------------------
// §2  Eresolution scaling
// ---------------------------------------------------------------------------

async function suiteResolution() {
  const resolutions = [
    [320, 180],
    [640, 360],
    [1280, 720],
    [1920, 1080],
  ];
  for (const [w, h] of resolutions) {
    const { canvas, context, canvasFormat } = makeCanvas();
    const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
    const scene = sceneFor(() => simpleRoundedRectScene({ width: w, height: h }));
    const primer = sceneFor(() => simpleRoundedRectScene({ width: w, height: h, slabSize: 60 }));
    try {
      const series = await benchUpdateFrame(
        pipeline,
        { scene: primer, dpr: 1 },
        {
          scene,
          dpr: 1,
          shadowOptions: { samples: 4, maxDistance: 300, stepSize: 0.5, bias: 0.5 },
        },
      );
      const first = series[0];
      const passGpu = {};
      for (const stage of Object.keys(first.gpuTiming?.passGpuMs ?? {})) {
        const values = gpuSeriesOf(series, (r) => r.gpuTiming?.passGpuMs?.[stage]);
        passGpu[stage] = values.length > 0 ? summarizeSeries(values) : null;
      }
      pushCase(
        `resolution/${w}x${h}`,
        { suite: "resolution", width: w, height: h, scene: SCENE_FAMILIES.simpleRoundedRect },
        {
          wallMs: summarizeSeries(series.map((r) => r.wallMs)),
          hostMs: summarizeSeries(series.map((r) => r.stats.frame.hostMs)),
          gpuTimestampMs: totalGpuSummary(series),
          gpuTimestampPass: passGpu,
          renderExtent: `${first.stats.renderWidth}x${first.stats.renderHeight}`,
          texels: first.stats.renderWidth * first.stats.renderHeight,
          executed: first.stats.invalidation.executed.join(","),
        },
      );
    } finally {
      pipeline.dispose();
      canvas.remove();
    }
  }
}

// ---------------------------------------------------------------------------
// §4  Esurface-count scaling
// ---------------------------------------------------------------------------

async function suiteSurface() {
  const counts = [1, 4, 16, 64, 128, 256, 512, 1000];
  const primerScene = sceneFor(() => surfaceGridScene({ width: WIDTH, height: HEIGHT, count: 2 }));
  for (const count of counts) {
    const { canvas, context, canvasFormat } = makeCanvas();
    const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
    const scene = sceneFor(() => surfaceGridScene({ width: WIDTH, height: HEIGHT, count }));
    const encoded = api.encodeScene(scene, 1);
    try {
      const series = await benchUpdateFrame(
        pipeline,
        { scene: primerScene, dpr: 1, shadowOptions: { samples: 4, maxDistance: 200 } },
        { scene, dpr: 1, shadowOptions: { samples: 4, maxDistance: 200 } },
      );
      const first = series[0];
      const snap = pipeline.getSnapshot();
      pushCase(
        `surface-scale/${count}`,
        { suite: "surface", surfaceCount: count, resolution: `${WIDTH}x${HEIGHT}`, scene: SCENE_FAMILIES.surfaceGrid },
        {
          wallMs: summarizeSeries(series.map((r) => r.wallMs)),
          hostMs: summarizeSeries(series.map((r) => r.stats.frame.hostMs)),
          heightGpuTimestampMs: summarizeSeries(gpuSeriesOf(series, (r) => r.gpuTiming?.passGpuMs?.height)),
          gpuTimestampMs: totalGpuSummary(series),
          submissions: first.stats.frame.submissions,
          dispatches: first.stats.frame.dispatchCount,
          bytesUploaded: first.stats.frame.bytesUploaded,
          encodedBytes: encoded.bytes.byteLength,
          candidateSurfaceCount: first.stats.planning.candidateSurfaceCount ?? 0,
          heightWorkgroups: snap.heightPass.lastDispatch.workgroupCountX,
          renderExtent: `${first.stats.renderWidth}x${first.stats.renderHeight}`,
        },
      );
    } finally {
      pipeline.dispose();
      canvas.remove();
    }
  }
}

// ---------------------------------------------------------------------------
// §6  Emask / glyph scaling
// ---------------------------------------------------------------------------

async function suiteMask() {
  const maskCounts = [0, 1, 16, 64];
  const maskResolutions = [16, 32, 64, 128, 256];
  const primerScene = sceneFor(() => maskHeavyScene({ width: WIDTH, height: HEIGHT, maskCount: 2, maskResolution: 16 }));
  for (const maskCount of maskCounts) {
    const { canvas, context, canvasFormat } = makeCanvas();
    const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
    const scene = sceneFor(() => maskHeavyScene({ width: WIDTH, height: HEIGHT, maskCount, maskResolution: 32 }));
    try {
      const series = await benchUpdateFrame(
        pipeline,
        { scene: primerScene, dpr: 1 },
        { scene, dpr: 1 },
      );
      const snap = pipeline.getSnapshot();
      pushCase(
        `mask-count/${maskCount}`,
        { suite: "mask", maskCount, maskResolution: 32, resolution: `${WIDTH}x${HEIGHT}`, scene: SCENE_FAMILIES.maskHeavy },
        {
          wallMs: summarizeSeries(series.map((r) => r.wallMs)),
          gpuTimestampMs: totalGpuSummary(series),
          heightGpuTimestampMs: summarizeSeries(gpuSeriesOf(series, (r) => r.gpuTiming?.passGpuMs?.height)),
          maskSdfPasses: snap.heightPass.lastDispatch.maskSdfPasses,
          composePasses: snap.heightPass.lastDispatch.composePasses,
          totalMaskCells: snap.heightPass.lastDispatch.totalMaskCells,
          bytesUploaded: series[0].stats.frame.bytesUploaded,
          executed: series[0].stats.invalidation.executed.join(","),
        },
      );
    } finally {
      pipeline.dispose();
      canvas.remove();
    }
  }
  for (const maskResolution of maskResolutions) {
    const { canvas, context, canvasFormat } = makeCanvas();
    const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
    const scene = sceneFor(() => maskHeavyScene({ width: WIDTH, height: HEIGHT, maskCount: 16, maskResolution }));
    try {
      const series = await benchUpdateFrame(
        pipeline,
        { scene: primerScene, dpr: 1 },
        { scene, dpr: 1 },
      );
      const snap = pipeline.getSnapshot();
      pushCase(
        `mask-resolution/${maskResolution}`,
        { suite: "mask", maskCount: 16, maskResolution, resolution: `${WIDTH}x${HEIGHT}`, scene: SCENE_FAMILIES.maskHeavy },
        {
          wallMs: summarizeSeries(series.map((r) => r.wallMs)),
          gpuTimestampMs: totalGpuSummary(series),
          maskSdfPasses: snap.heightPass.lastDispatch.maskSdfPasses,
          totalMaskCells: snap.heightPass.lastDispatch.totalMaskCells,
          bytesUploaded: series[0].stats.frame.bytesUploaded,
        },
      );
    } finally {
      pipeline.dispose();
      canvas.remove();
    }
  }
  // §6: unchanged mask + other geometry changed  Edoes the mask SDF re-run?
  {
    const { canvas, context, canvasFormat } = makeCanvas();
    const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
    const base = sceneFor(() => maskHeavyScene({ width: WIDTH, height: HEIGHT, maskCount: 16, maskResolution: 32 }));
    const moved = {
      ...base,
      surfaces: base.surfaces.map((s, i) =>
        i === base.surfaces.length - 1 ? { ...s, position: { x: s.position.x + 10, y: s.position.y + 5 } } : s,
      ),
    };
    try {
      await timedRender(pipeline, { scene: base, dpr: 1 });
      const series = await benchSeries(() => timedRender(pipeline, { scene: moved, dpr: 1 }));
      const snap = pipeline.getSnapshot();
      const first = series[0];
      pushCase(
        "mask/unrelated-geometry-after-mask",
        { suite: "mask", case: "unrelated-geometry-after-mask", maskCount: 16, maskResolution: 32 },
        {
          wallMs: summarizeSeries([first.wallMs]),
          maskSdfPasses: snap.heightPass.lastDispatch.maskSdfPasses,
          executed: first.stats.invalidation.executed.join(","),
          planningMode: first.stats.planning.mode,
        },
      );
    } finally {
      pipeline.dispose();
      canvas.remove();
    }
  }
}

// ---------------------------------------------------------------------------
// §7  Eshadow sample / angular radius / travel distance
// ---------------------------------------------------------------------------

async function suiteShadow() {
  const sampleCounts = [1, 4, 8, 16];
  const angularRadii = [0, 0.05, 0.15, 0.3];
  for (const angularRadius of angularRadii) {
    for (const samples of sampleCounts) {
      const { canvas, context, canvasFormat } = makeCanvas();
      const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
      const scene = sceneFor(() => shadowScene({ width: WIDTH, height: HEIGHT, travel: "medium", angularRadius }));
      const primer = sceneFor(() =>
        shadowScene({ width: WIDTH, height: HEIGHT, travel: "medium", angularRadius: angularRadius > 0 ? 0 : 0.3 }),
      );
      try {
        const series = await benchUpdateFrame(
          pipeline,
          { scene: primer, dpr: 1, shadowOptions: { samples: 4, maxDistance: 200, stepSize: 0.5, bias: 0.5 } },
          { scene, dpr: 1, shadowOptions: { samples, maxDistance: 200, stepSize: 0.5, bias: 0.5 } },
        );
        const snap = pipeline.getSnapshot();
        pushCase(
          `shadow/samples-${samples}/radius-${angularRadius}`,
          {
            suite: "shadow",
            samples,
            angularRadius,
            travel: "medium",
            resolution: `${WIDTH}x${HEIGHT}`,
            scene: SCENE_FAMILIES.softShadow,
          },
          {
            wallMs: summarizeSeries(series.map((r) => r.wallMs)),
            shadowHostMs: summarizeSeries(series.map((r) => r.stats.frame.passDurations.shadow)),
            shadowGpuTimestampMs: summarizeSeries(gpuSeriesOf(series, (r) => r.gpuTiming?.passGpuMs?.shadow)),
            gpuTimestampMs: totalGpuSummary(series),
            effectiveSamples: snap.shadowPass.options.samples,
            softActive: angularRadius > 0 && snap.shadowPass.options.samples > 1,
            shadowWorkgroups: snap.shadowPass.lastDispatch.workgroupCountX,
            shadowSteps: snap.shadowPass.lastDispatch.stepCount,
            renderExtent: `${series[0].stats.renderWidth}x${series[0].stats.renderHeight}`,
            texels: series[0].stats.renderWidth * series[0].stats.renderHeight,
          },
        );
      } finally {
        pipeline.dispose();
        canvas.remove();
      }
    }
  }
  // travel distance at the representative 8 samples / default radius
  for (const travel of ["short", "medium", "long"]) {
    const { canvas, context, canvasFormat } = makeCanvas();
    const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
    const scene = sceneFor(() => shadowScene({ width: WIDTH, height: HEIGHT, travel, angularRadius: 0.15 }));
    const primer = sceneFor(() =>
      shadowScene({ width: WIDTH, height: HEIGHT, travel: travel === "short" ? "long" : "short", angularRadius: 0.15 }),
    );
    try {
      const series = await benchUpdateFrame(
        pipeline,
        { scene: primer, dpr: 1, shadowOptions: { samples: 8, maxDistance: 200 } },
        { scene, dpr: 1, shadowOptions: { samples: 8, maxDistance: 200 } },
      );
      const snap = pipeline.getSnapshot();
      pushCase(
        `shadow/travel-${travel}`,
        { suite: "shadow", travel, samples: 8, angularRadius: 0.15, resolution: `${WIDTH}x${HEIGHT}` },
        {
          wallMs: summarizeSeries(series.map((r) => r.wallMs)),
          shadowHostMs: summarizeSeries(series.map((r) => r.stats.frame.passDurations.shadow)),
          shadowGpuTimestampMs: summarizeSeries(gpuSeriesOf(series, (r) => r.gpuTiming?.passGpuMs?.shadow)),
          shadowSteps: snap.shadowPass.lastDispatch.stepCount,
        },
      );
    } finally {
      pipeline.dispose();
      canvas.remove();
    }
  }
}

// ---------------------------------------------------------------------------
// §8  Ereconstruction radius ÁEDPR
// ---------------------------------------------------------------------------

async function suiteReconstruction() {
  const radii = [0, 1, 2, 4]; // 0 = bypass (radiusTexels 0)
  const dprs = [1, 2, 3, 4];
  const baseScene = sceneFor(() => reconstructionHeavyScene({ width: WIDTH, height: HEIGHT }));
  for (const dpr of dprs) {
    for (const radius of radii) {
      const { canvas, context, canvasFormat } = makeCanvas();
      const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
      // primer: the same scene with a DIFFERENT reconstruction radius so the
      // measured frame always executes the full chain (radius 0 = bypass)
      const primerRadius = radius > 0 ? 0 : 4;
      const caseOptions = {
        samples: 8,
        maxDistance: 200,
        stepSize: 0.5,
        bias: 0.5,
        reconstruction: { enabled: true, radius },
      };
      const primerOptions = {
        samples: 8,
        maxDistance: 200,
        stepSize: 0.5,
        bias: 0.5,
        reconstruction: { enabled: true, radius: primerRadius },
      };
      try {
        const series = await benchUpdateFrame(
          pipeline,
          { scene: baseScene, dpr, shadowOptions: primerOptions },
          { scene: baseScene, dpr, shadowOptions: caseOptions },
          { warmups: 2, sampleCount: Math.min(3, SAMPLES) },
        );
        const first = series[0];
        const snap = pipeline.getSnapshot();
        const radiusTexels = snap.reconstructionPass?.options?.radiusTexels ?? 0;
        const active = radiusTexels > 0;
        const tapsPerTexel = active ? (2 * radiusTexels + 1) ** 2 : 0;
        const total = first.stats.renderWidth * first.stats.renderHeight;
        const reconValues = gpuSeriesOf(series, (r) => r.gpuTiming?.passGpuMs?.reconstruction);
        pushCase(
          `reconstruction/dpr-${dpr}/radius-${radius}`,
          { suite: "reconstruction", dpr, radius, resolution: `${WIDTH}x${HEIGHT}`, scene: SCENE_FAMILIES.reconstructionHeavy },
          {
            wallMs: summarizeSeries(series.map((r) => r.wallMs)),
            reconstructionHostMs: summarizeSeries(series.map((r) => r.stats.frame.passDurations.reconstruction)),
            reconstructionGpuTimestampMs: reconValues.length > 0 ? summarizeSeries(reconValues) : null,
            gpuTimestampMs: totalGpuSummary(series),
            reconstructionActive: active,
            radiusTexels,
            tapsPerTexel,
            totalReconstructedTaps: active ? total * tapsPerTexel : 0,
            renderExtent: `${first.stats.renderWidth}x${first.stats.renderHeight}`,
            texels: total,
            reconstructionWorkgroups: snap.reconstructionPass?.lastDispatch.workgroupCountX ?? null,
            reconstructionRatio:
              reconValues.length > 0 && series[0].gpuTiming?.totalGpuMs
                ? reconValues[0] / series[0].gpuTiming.totalGpuMs
                : null,
          },
        );
      } finally {
        pipeline.dispose();
        canvas.remove();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// §9  Epresentation microbenchmark: P0 attachment-only, P1 color field,
// P2 color+owner, P3 full inputs, P4 production PresentationPass
// ---------------------------------------------------------------------------

const PRESENT_VS = `
  @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    var pos = array<vec2<f32>, 3>(
      vec2<f32>(-1.0, -3.0), vec2<f32>(3.0, 1.0), vec2<f32>(-1.0, 1.0));
    return vec4<f32>(pos[i], 0.0, 1.0);
  }
`;

const PRESENT_FS_CONSTANT = `
  @fragment fn fs() -> @location(0) vec4<f32> {
    return vec4<f32>(0.2, 0.4, 0.6, 1.0);
  }
`;

const PRESENT_FS_COLOR = `
  struct ColorField { data: array<vec4<f32>> }
  @group(0) @binding(0) var<storage, read> color: ColorField;
  @fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let i = u32(pos.y) * 640u + u32(pos.x);
    return color.data[i];
  }
`;

const PRESENT_FS_COLOR_OWNER = `
  struct ColorField { data: array<vec4<f32>> }
  struct OwnerField { data: array<u32> }
  @group(0) @binding(0) var<storage, read> color: ColorField;
  @group(0) @binding(1) var<storage, read> owner: OwnerField;
  @fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let i = u32(pos.y) * 640u + u32(pos.x);
    let o = owner.data[i];
    var c = color.data[i];
    if (o == 0xffffffffu) { c = vec4<f32>(0.0, 0.0, 0.0, 0.0); }
    return c;
  }
`;

const PRESENT_FS_FULL = `
  struct ColorField { data: array<vec4<f32>> }
  struct OwnerField { data: array<u32> }
  struct VisField { data: array<f32> }
  @group(0) @binding(0) var<storage, read> color: ColorField;
  @group(0) @binding(1) var<storage, read> owner: OwnerField;
  @group(0) @binding(2) var<storage, read> vis: VisField;
  @fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let i = u32(pos.y) * 640u + u32(pos.x);
    let o = owner.data[i];
    let v = vis.data[i];
    var c = color.data[i];
    if (o == 0xffffffffu) { c = vec4<f32>(0.0, 0.0, 0.0, v); }
    return c;
  }
`;

async function runPresentationMicrobench(device, context, canvasFormat, stage) {
  const format = canvasFormat;
  const module = device.createShaderModule({
    code:
      PRESENT_VS +
      (stage === 0
        ? PRESENT_FS_CONSTANT
        : stage === 1
          ? PRESENT_FS_COLOR
          : stage === 2
            ? PRESENT_FS_COLOR_OWNER
            : PRESENT_FS_FULL),
    label: `bench-presentation-p${stage}`,
  });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    label: `bench-presentation-p${stage}`,
  });
  const texels = WIDTH * HEIGHT;
  const buffer = (usage, bytes) => device.createBuffer({ size: Math.max(bytes, 16), usage });
  const bindGroupEntries = [];
  if (stage >= 1) {
    const colorBuf = buffer(GPUBufferUsage.STORAGE, texels * 16);
    device.queue.writeBuffer(colorBuf, 0, new Float32Array(texels * 4).fill(0.5));
    bindGroupEntries.push({ binding: 0, resource: { buffer: colorBuf } });
  }
  if (stage >= 2) {
    const ownerBuf = buffer(GPUBufferUsage.STORAGE, texels * 4);
    device.queue.writeBuffer(ownerBuf, 0, new Uint32Array(texels).fill(0xffffffff));
    bindGroupEntries.push({ binding: 1, resource: { buffer: ownerBuf } });
  }
  if (stage >= 3) {
    const visBuf = buffer(GPUBufferUsage.STORAGE, texels * 4);
    device.queue.writeBuffer(visBuf, 0, new Float32Array(texels).fill(0.5));
    bindGroupEntries.push({ binding: 2, resource: { buffer: visBuf } });
  }
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: bindGroupEntries,
  });
  return () => {
    const encoder = device.createCommandEncoder({ label: `bench-presentation-p${stage}` });
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
    if (bindGroupEntries.length > 0) {
      pass.setBindGroup(0, bindGroup);
    }
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
}

async function suitePresentation() {
  const { canvas, context, canvasFormat } = makeCanvas();
  const submits = [];
  for (let stage = 0; stage <= 3; stage++) {
    submits.push(await runPresentationMicrobench(device, context, canvasFormat, stage));
  }
  // P4: the production PresentationPass through pipeline.present()
  const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
  const scene = sceneFor(() => simpleRoundedRectScene({ width: WIDTH, height: HEIGHT }));
  try {
    await pipeline.render({ scene, dpr: 1, debugReadback: true });
    await device.queue.onSubmittedWorkDone();
    const p4Submit = async () => {
      const t0 = performance.now();
      pipeline.present();
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    };
    const p4Series = await benchSeries(p4Submit);
    pushCase(
      "presentation/p4-production",
      { suite: "presentation", stage: "P4", resolution: `${WIDTH}x${HEIGHT}` },
      {
        wallMs: summarizeSeries(p4Series),
        canvasFormat,
        alphaMode: pipeline.getSnapshot().presentationPass.alphaMode,
        renderExtent: `${WIDTH}x${HEIGHT}`,
      },
    );
    for (let stage = 0; stage <= 3; stage++) {
      const submit = submits[stage];
      const timed = async () => {
        const t0 = performance.now();
        submit();
        await device.queue.onSubmittedWorkDone();
        return performance.now() - t0;
      };
      const series = await benchSeries(timed);
      pushCase(
        `presentation/p${stage}`,
        { suite: "presentation", stage: `P${stage}`, resolution: `${WIDTH}x${HEIGHT}` },
        {
          wallMs: summarizeSeries(series),
          gpuTimestampMs: null,
          canvasFormat,
          renderExtent: `${WIDTH}x${HEIGHT}`,
        },
      );
    }
  } finally {
    pipeline.dispose();
    canvas.remove();
  }
}

// ---------------------------------------------------------------------------
// §10  Esubmission-count overhead: N empty submissions
// ---------------------------------------------------------------------------

async function suiteSubmission() {
  const counts = [1, 2, 4, 6, 8];
  for (const count of counts) {
    const timed = async () => {
      const t0 = performance.now();
      for (let i = 0; i < count; i++) {
        device.queue.submit([]);
      }
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    };
    const series = await benchSeries(timed);
    pushCase(
      `submission/n-${count}`,
      { suite: "submission", submissions: count },
      {
        wallMs: summarizeSeries(series),
        submissions: count,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// §11  Eupload benchmark: which sections transfer per update type
// ---------------------------------------------------------------------------

async function suiteUpload() {
  const gridScene = sceneFor(() => surfaceGridScene({ width: WIDTH, height: HEIGHT, count: 64 }));
  const glyphScene = sceneFor(() => glyphGridScene({ width: WIDTH, height: HEIGHT, count: 8 }));
  const encoded = api.encodeScene(gridScene, 1);
  const uploader = new api.SceneUploader(device);
  const runUpload = async (bytes) => {
    const t0 = performance.now();
    const stats = uploader.upload(bytes);
    await device.queue.onSubmittedWorkDone();
    return { hostMs: performance.now() - t0, stats, bytes: bytes.bytes.byteLength, bindings: uploader.getBindings() };
  };
  const casesSpec = [
    { id: "first", bytes: encoded },
    { id: "identical", bytes: encoded },
    { id: "light-only", bytes: api.encodeScene({ ...gridScene, light: { ...gridScene.light, intensity: 0.5 } }, 1) },
    {
      id: "material-values-only",
      bytes: api.encodeScene({
        ...gridScene,
        materials: {
          silicone: { baseColor: { r: 0.9, g: 0.3, b: 0.2 }, roughness: 0.5, metallic: 0, ior: 1.5 },
        },
      }, 1),
    },
    {
      id: "single-surface-geometry",
      bytes: api.encodeScene({
        ...gridScene,
        surfaces: gridScene.surfaces.map((s, i) =>
          i === 3 ? { ...s, position: { x: s.position.x + 4, y: s.position.y + 4 } } : s,
        ),
      }, 1),
    },
    {
      id: "mask-change",
      bytes: api.encodeScene({
        ...glyphScene,
        surfaces: glyphScene.surfaces.map((s, i) =>
          i === 3
            ? { ...s, shape: { kind: "mask", mask: { width: 8, height: 8, alpha: new Uint8Array(64).fill(128) } } }
            : s,
        ),
      }, 1),
    },
  ];
  try {
    for (const spec of casesSpec) {
      const series = await benchSeries(() => runUpload(spec.bytes));
      // the FIRST upload of each update type is the interesting one (it
      // decides allocations); later identical uploads reuse everything
      const first = series[0];
      pushCase(
        `upload/${spec.id}`,
        { suite: "upload", updateType: spec.id, resolution: `${WIDTH}x${HEIGHT}` },
        {
          hostMs: summarizeSeries(series.map((r) => r.hostMs)),
          encodedBytes: first.bytes,
          headerBytes: first.bindings.header.byteLength,
          surfaceBytes: first.bindings.surfaces.byteLength,
          maskRecordBytes: first.bindings.masks.byteLength,
          maskPixelBytes: first.bindings.maskPixels.byteLength,
          materialBytes: first.bindings.materials.byteLength,
          writeCalls: first.stats.writeCalls,
          bytesUploaded: first.stats.bytesUploaded,
          newAllocations: first.stats.newAllocations,
        },
      );
    }
  } finally {
    uploader.dispose();
  }
}

// ---------------------------------------------------------------------------
// §12  Epartial vs full recompute at dirty ratios
// ---------------------------------------------------------------------------

async function suitePartial() {
  const ratios = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1];
  const base = sceneFor(() => partialEditScene({ width: WIDTH, height: HEIGHT }));
  const shadowOptions = { maxDistance: 40, stepSize: 0.5, bias: 0.5 };
  for (const ratio of ratios) {
    const { canvas, context, canvasFormat } = makeCanvas();
    const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
    const edit = sceneFor(() => partialEditScene({ width: WIDTH, height: HEIGHT, edit: ratio }));
    try {
      const series = await benchUpdateFrame(
        pipeline,
        { scene: base, dpr: 1, shadowOptions, tileSize: 64 },
        { scene: edit, dpr: 1, shadowOptions, tileSize: 64 },
      );
      const first = series[0];
      pushCase(
        `partial/ratio-${Math.round(ratio * 100)}`,
        {
          suite: "partial",
          dirtyRatio: Math.round(ratio * 100),
          resolution: `${WIDTH}x${HEIGHT}`,
          scene: SCENE_FAMILIES.partialEdit,
          tileSize: 64,
        },
        {
          wallMs: summarizeSeries(series.map((r) => r.wallMs)),
          planningHostMs: summarizeSeries(series.map((r) => r.stats.planning.planningHostMs)),
          gpuTimestampMs: totalGpuSummary(series),
          heightGpuTimestampMs: summarizeSeries(gpuSeriesOf(series, (r) => r.gpuTiming?.passGpuMs?.height)),
          shadowGpuTimestampMs: summarizeSeries(gpuSeriesOf(series, (r) => r.gpuTiming?.passGpuMs?.shadow)),
          planningMode: first.stats.planning.mode,
          planningReason: first.stats.planning.reason,
          dirtyTileCount: first.stats.planning.dirtyTileCount ?? null,
          dirtyTexels: first.stats.planning.dirtyTexels ?? null,
          totalTileCount: first.stats.planning.totalTileCount ?? null,
          dispatchTexels: first.stats.planning.dispatchTexels ?? null,
          totalTexels: first.stats.planning.totalTexels ?? null,
          candidateSurfaceCount: first.stats.planning.candidateSurfaceCount ?? null,
          culledSurfaceCount: first.stats.planning.culledSurfaceCount ?? null,
        },
      );
    } finally {
      pipeline.dispose();
      canvas.remove();
    }
  }
}

// ---------------------------------------------------------------------------
// §13  Eretained scheduling over repeated frames
// ---------------------------------------------------------------------------

async function suiteRetained() {
  const { canvas, context, canvasFormat } = makeCanvas();
  const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
  const base = sceneFor(() => simpleRoundedRectScene({ width: WIDTH, height: HEIGHT }));
  const variants = [
    { id: "no-change", input: { scene: base, dpr: 1 } },
    { id: "repaint-only", input: { scene: base, dpr: 1, repaint: true } },
    { id: "light-intensity", input: {
      scene: sceneFor(() => ({ ...base, light: { ...base.light, intensity: 0.5 } })), dpr: 1,
    } },
    { id: "light-direction", input: {
      scene: sceneFor(() => ({
        ...base,
        light: { ...base.light, direction: { x: 0.5, y: 0.3, z: 0.8 } },
      })), dpr: 1,
    } },
    { id: "material-values", input: {
      scene: sceneFor(() => ({
        ...base,
        materials: {
          silicone: { baseColor: { r: 0.9, g: 0.3, b: 0.2 }, roughness: 0.5, metallic: 0, ior: 1.5 },
        },
      })), dpr: 1,
    } },
    { id: "geometry", input: {
      scene: sceneFor(() => simpleRoundedRectScene({ width: WIDTH, height: HEIGHT, slabSize: 120 })), dpr: 1,
    } },
  ];
  try {
    await timedRender(pipeline, { scene: base, dpr: 1 });
    for (const variant of variants) {
      const wall = [];
      const executed = new Set();
      const planningModes = new Set();
      let submissions = 0;
      let dispatches = 0;
      let bytesUploaded = 0;
      for (let i = 0; i < RETAINED_FRAMES; i++) {
        const { wallMs, stats } = await timedRender(pipeline, variant.input);
        wall.push(wallMs);
        executed.add(stats.invalidation.executed.join(","));
        planningModes.add(stats.planning.mode);
        submissions += stats.frame.submissions;
        dispatches += stats.frame.dispatchCount;
        bytesUploaded += stats.frame.bytesUploaded;
      }
      const expectedExecuted =
        variant.id === "no-change" ? ""
        : variant.id === "repaint-only" ? "presentation"
        : variant.id === "light-intensity" ? "upload,lighting,presentation"
        : variant.id === "geometry"
          ? "upload,height,normal,shadow,reconstruction,lighting,presentation"
          : "upload,shadow,reconstruction,lighting,presentation";
      pushCase(
        `retained/${variant.id}`,
        { suite: "retained", case: variant.id, frames: RETAINED_FRAMES, resolution: `${WIDTH}x${HEIGHT}` },
        {
          wallMs: summarizeSeries(wall),
          submissionsPerFrame: submissions / RETAINED_FRAMES,
          dispatchesPerFrame: dispatches / RETAINED_FRAMES,
          bytesUploadedPerFrame: bytesUploaded / RETAINED_FRAMES,
          executed: [...executed].join("|"),
          expectedExecuted,
          planningModes: [...planningModes].join(","),
        },
      );
    }
  } finally {
    pipeline.dispose();
    canvas.remove();
  }
}

// ---------------------------------------------------------------------------
// suite selection
// ---------------------------------------------------------------------------

const SUITE_RUNNERS = {
  stage: suiteStage,
  e2e: suiteE2E,
  resolution: suiteResolution,
  surface: suiteSurface,
  mask: suiteMask,
  shadow: suiteShadow,
  reconstruction: suiteReconstruction,
  presentation: suitePresentation,
  submission: suiteSubmission,
  upload: suiteUpload,
  partial: suitePartial,
  retained: suiteRetained,
};

const SUITES = Object.keys(SUITE_RUNNERS);

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function publish(marker, message, doc) {
  const lines = [`${marker} ${message}`];
  if (doc !== null) {
    lines.push(`SUMMARY ${JSON.stringify(doc)}`);
  } else {
    lines.push(`SUMMARY ${JSON.stringify({ error: message, notes })}`);
  }
  for (const note of notes) {
    lines.push(`  # ${note}`);
  }
  RESULT_EL.textContent = lines.join("\n");
}

async function main() {
  const selected = SUITE_QUERY.split(",").filter(Boolean);
  const toRun = selected[0] === "all" ? SUITES : selected;
  const missing = toRun.filter((name) => !(name in SUITE_RUNNERS));
  if (missing.length > 0) {
    publish(MARKER_FAIL, `unknown suite(s): ${missing.join(", ")} (available: ${SUITES.join(", ")})`, null);
    return;
  }
  if (!navigator.gpu) {
    publish(MARKER_SKIP, "navigator.gpu unavailable in this browser", null);
    return;
  }
  const acquired = await acquireDevice();
  if (acquired.device === null) {
    publish(MARKER_SKIP, `no device: ${acquired.reason}`, null);
    return;
  }
  device = acquired.device;
  adapter = acquired.adapter;
  device.onuncapturederror = (event) => {
    notes.push(`uncaptured error: ${String(event.error?.message ?? event.error)}`);
  };
  try {
    for (const name of toRun) {
      notes.push(`suite ${name} start`);
      await SUITE_RUNNERS[name]();
      notes.push(`suite ${name} done`);
    }
    const environment = collectBrowserEnvironment({ adapter, device });
    const doc = createResultDocument({ environment, cases });
    const problems = validateResultDocument(doc);
    if (problems.length > 0) {
      publish(MARKER_FAIL, `result document invalid: ${problems.join("; ")}`, doc);
      return;
    }
    publish(MARKER_PASS, `${cases.length} cases across ${toRun.join(",")}`, doc);
  } catch (error) {
    publish(MARKER_FAIL, String(error?.stack ?? error), null);
  } finally {
    device.destroy();
  }
}

void main();