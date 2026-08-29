// #46 real-WebGPU benchmark harness (the counterpart of scripts/bench-gpu.mjs).
//
// Runs on a REAL adapter through the public bundled renderer ESM:
//
//   1. requests a real adapter/device (SKIP when unavailable), requesting
//      the optional `timestamp-query` feature when the adapter exposes it
//   2. runs every selected suite on deterministic scenes from
//      scripts/bench/lib/scenes.mjs (never inline fixtures)
//   3. reports host encode time (`hostMs`), real GPU timestamps
//      (`gpuTimestampMs`, only when timestamp-query works  Ean unsupported
//      feature stays report-only, never a fabricated zero), queue-completion
//      wall time (`wallMs`) SEPARATELY, plus submissions / dispatches /
//      workgroups / uploaded bytes / allocations per case
//   4. writes ONE unambiguous marker as the first line of the result block
//      (UKIBORI_BENCH_GPU_PASS / FAIL / SKIP) followed by
//      `SUMMARY <json>`  Ea versioned benchmark result document
//      (scripts/bench/lib/schema.mjs) that scripts/bench-gpu.mjs saves to
//      benchmark-results.json
//
// Timing honesty (#46 #23): the three mechanisms are NEVER merged into one
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
// standalone GPU timestamp helper (benchmark-only; the raw P0-P3 render
// pipelines have no other timing seam). Owns one query pair per submission
// and resolves it through a readback buffer  Eno production code involved.
// ---------------------------------------------------------------------------

async function submitWithGpuTimestamp(submit) {
  const t0 = performance.now();
  if (device.features.has("timestamp-query") !== true) {
    const h0 = performance.now();
    submit();
    const hostMs = performance.now() - h0;
    await device.queue.onSubmittedWorkDone();
    return { wallMs: performance.now() - t0, hostMs, gpuTimestampMs: null };
  }
  const querySet = device.createQuerySet({
    type: "timestamp",
    count: 2,
    label: "ukibori-bench-presentation-timestamps",
  });
  const resolveBuffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    label: "ukibori-bench-presentation-resolve",
  });
  const readbackBuffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    label: "ukibori-bench-presentation-readback",
  });
  try {
    // the closure wraps the RAW descriptor into `{ timestampWrites }`
    const h0 = performance.now();
    submit({ querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
    const hostMs = performance.now() - h0;
    await device.queue.onSubmittedWorkDone();
    const wallMs = performance.now() - t0;
    const encoder = device.createCommandEncoder({ label: "ukibori-bench-presentation-resolve" });
    encoder.resolveQuerySet(querySet, 0, 2, resolveBuffer, 0);
    encoder.copyBufferToBuffer(resolveBuffer, 0, readbackBuffer, 0, 16);
    device.queue.submit([encoder.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ, 0, 16);
    const view = new DataView(readbackBuffer.getMappedRange(0, 16));
    const begin = view.getBigUint64(0, true);
    const end = view.getBigUint64(8, true);
    readbackBuffer.unmap();
    const gpuTimestampMs = end >= begin ? Number(end - begin) / 1_000_000 : null;
    return { wallMs, hostMs, gpuTimestampMs };
  } catch (error) {
    notes.push(`submitWithGpuTimestamp failed: ${String(error?.stack ?? error)}`);
    return { wallMs: performance.now() - t0, gpuTimestampMs: null };
  } finally {
    readbackBuffer.destroy();
    resolveBuffer.destroy();
    querySet.destroy();
  }
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
// #A  Estage benchmark: one full soft-shadow frame, per-stage timings
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
      { suite: "stage", resolution: `${WIDTH}x${HEIGHT}`, warmups: WARMUP, samples: SAMPLES },
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
// #B  Eend-to-end frame cases: cold / warm / retained / repaint / light /
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
          { suite: "e2e", case: "cold-first", resolution: `${WIDTH}x${HEIGHT}`, warmups: WARMUP, samples: SAMPLES },
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
            { suite: "e2e", case: scenario.id, resolution: `${WIDTH}x${HEIGHT}`, warmups: WARMUP, samples: SAMPLES },
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
      // frame (not a retained repeat - retained costs are suiteRetained's
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
        { suite: "e2e", case: scenario.id, resolution: `${WIDTH}x${HEIGHT}`, warmups: WARMUP, samples: SAMPLES },
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
// #2: resolution scaling
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
        { suite: "resolution", width: w, height: h, scene: SCENE_FAMILIES.simpleRoundedRect, warmups: WARMUP, samples: SAMPLES },
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
// #4  Esurface-count scaling
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
        { suite: "surface", surfaceCount: count, resolution: `${WIDTH}x${HEIGHT}`, scene: SCENE_FAMILIES.surfaceGrid, warmups: WARMUP, samples: SAMPLES },
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
// #6: mask / glyph scaling
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
        { suite: "mask", maskCount, maskResolution: 32, resolution: `${WIDTH}x${HEIGHT}`, scene: SCENE_FAMILIES.maskHeavy, warmups: WARMUP, samples: SAMPLES },
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
    // the 128/256 mask cases cost up to ~800ms per frame: cap the sample
    // count and record the ACTUAL samples in the case parameters
    const actualSamples = Math.min(SAMPLES, 5);
    try {
      const series = await benchUpdateFrame(
        pipeline,
        { scene: primerScene, dpr: 1 },
        { scene, dpr: 1 },
        { warmups: WARMUP, sampleCount: actualSamples },
      );
      const snap = pipeline.getSnapshot();
      pushCase(
        `mask-resolution/${maskResolution}`,
        { suite: "mask", maskCount: 16, maskResolution, resolution: `${WIDTH}x${HEIGHT}`, scene: SCENE_FAMILIES.maskHeavy, warmups: WARMUP, samples: actualSamples },
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
  // #6: unchanged mask + other geometry changed - does the mask SDF re-run?
  // Every timed sample is a REAL base -> moved transition (the
  // benchUpdateFrame contract): the measured frame's own stats, planning,
  // timestamp data and dispatch stats are captured from THAT frame, never
  // inferred from a stale lastDispatch. The maskSDF/compose GPU split comes
  // from a standalone HeightPass with the benchmark-only substage seam on
  // the SAME encoded scene (the SDF pass always runs full; the compose
  // timing is the full-frame cost, noted in the parameters).
  {
    const { canvas, context, canvasFormat } = makeCanvas();
    const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
    const base = sceneFor(() => maskHeavyScene({ width: WIDTH, height: HEIGHT, maskCount: 16, maskResolution: 32 }));
    const moved = sceneFor(() => ({
      ...base,
      surfaces: base.surfaces.map((s, i) =>
        i === base.surfaces.length - 1 ? { ...s, position: { x: s.position.x + 10, y: s.position.y + 5 } } : s,
      ),
    }));
    const uploader = new api.SceneUploader(device);
    const heightPass = new api.HeightPass(device);
    try {
      const series = await benchUpdateFrame(
        pipeline,
        { scene: base, dpr: 1 },
        { scene: moved, dpr: 1 },
      );
      const first = series[0];
      const snap = pipeline.getSnapshot();
      // THIS frame's dispatch stats (the snapshot reflects the last
      // dispatch, which IS the measured moved frame)
      const thisFrameDispatch = {
        maskSdfPasses: snap.heightPass.lastDispatch.maskSdfPasses,
        composePasses: snap.heightPass.lastDispatch.composePasses,
        totalMaskCells: snap.heightPass.lastDispatch.totalMaskCells,
        workgroupCountX: snap.heightPass.lastDispatch.workgroupCountX,
      };
      // substage GPU split via the benchmark-only HeightPass seam. Unlike the
      // main frame (20 samples), the substage run takes its OWN
      // warmup + sample count so the reported summary is a real
      // distribution, not a single-shot diagnostic.
      const SUBSTAGE_WARMUP = 3;
      const SUBSTAGE_SAMPLES = 10;
      const maskSdfGpuSamples = [];
      const composeGpuSamples = [];
      if (device.features.has("timestamp-query") === true) {
        const encoded = api.encodeScene(moved, 1);
        uploader.upload(encoded);
        // warm the pass pipelines BEFORE the timed dispatches (the first
        // dispatch on a fresh pass compiles shaders, which is not GPU work);
        // the warmup query sets are destroyed after use
        for (let i = 0; i < SUBSTAGE_WARMUP; i++) {
          const warmupQuerySet = device.createQuerySet({
            type: "timestamp",
            count: 4,
            label: "ukibori-bench-height-warmup",
          });
          try {
            heightPass.dispatch(encoded, uploader.getBindings(), {
              substageTimestamps: {
                querySet: warmupQuerySet,
                sdfBeginIndex: 0,
                composeBeginIndex: 2,
              },
            });
          } finally {
            warmupQuerySet.destroy();
          }
        }
        await device.queue.onSubmittedWorkDone();
        for (let i = 0; i < SUBSTAGE_SAMPLES; i++) {
          const querySet = device.createQuerySet({ type: "timestamp", count: 4, label: "ukibori-bench-height-substage" });
          const resolveBuffer = device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
          });
          const readbackBuffer = device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });
          try {
            heightPass.dispatch(encoded, uploader.getBindings(), {
              substageTimestamps: { querySet, sdfBeginIndex: 0, composeBeginIndex: 2 },
            });
            await device.queue.onSubmittedWorkDone();
            const encoder = device.createCommandEncoder();
            encoder.resolveQuerySet(querySet, 0, 4, resolveBuffer, 0);
            encoder.copyBufferToBuffer(resolveBuffer, 0, readbackBuffer, 0, 32);
            device.queue.submit([encoder.finish()]);
            await readbackBuffer.mapAsync(GPUMapMode.READ, 0, 32);
            const view = new DataView(readbackBuffer.getMappedRange(0, 32));
            const sdfBegin = view.getBigUint64(0, true);
            const sdfEnd = view.getBigUint64(8, true);
            const composeBegin = view.getBigUint64(16, true);
            const composeEnd = view.getBigUint64(24, true);
            readbackBuffer.unmap();
            if (sdfEnd >= sdfBegin) {
              maskSdfGpuSamples.push(Number(sdfEnd - sdfBegin) / 1_000_000);
            }
            if (composeEnd >= composeBegin) {
              composeGpuSamples.push(Number(composeEnd - composeBegin) / 1_000_000);
            }
          } finally {
            readbackBuffer.destroy();
            resolveBuffer.destroy();
            querySet.destroy();
          }
        }
      }
      pushCase(
        "mask/unrelated-geometry-after-mask",
        {
          suite: "mask",
          case: "unrelated-geometry-after-mask",
          maskCount: 16,
          maskResolution: 32,
          warmups: WARMUP,
          samples: SAMPLES,
          note: "maskSdfGpuTimestampMs/composeGpuTimestampMs measured on a standalone full-frame HeightPass with the benchmark-only substage seam (SDF always runs full; compose is the full-frame cost)",
          substageWarmups: SUBSTAGE_WARMUP,
          substageSamples: SUBSTAGE_SAMPLES,
        },
        {
          wallMs: summarizeSeries(series.map((r) => r.wallMs)),
          heightGpuTimestampMs: summarizeSeries(gpuSeriesOf(series, (r) => r.gpuTiming?.passGpuMs?.height)),
          gpuTimestampMs: totalGpuSummary(series),
          maskSdfGpuTimestampMs: maskSdfGpuSamples.length > 0 ? summarizeSeries(maskSdfGpuSamples) : null,
          composeGpuTimestampMs: composeGpuSamples.length > 0 ? summarizeSeries(composeGpuSamples) : null,
          maskSdfPassesThisFrame: thisFrameDispatch.maskSdfPasses,
          composePassesThisFrame: thisFrameDispatch.composePasses,
          totalMaskCells: thisFrameDispatch.totalMaskCells,
          heightWorkgroups: thisFrameDispatch.workgroupCountX,
          executed: first.stats.invalidation.executed.join(","),
          planningMode: first.stats.planning.mode,
          planningReason: first.stats.planning.reason,
        },
      );
    } finally {
      heightPass.dispose();
      uploader.dispose();
      pipeline.dispose();
      canvas.remove();
    }
  }
}

// ---------------------------------------------------------------------------
// #7: shadow sample / angular radius / travel distance
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
            shadowSamples: samples,
            angularRadius,
            travel: "medium",
            resolution: `${WIDTH}x${HEIGHT}`,
            scene: SCENE_FAMILIES.softShadow,
            warmups: WARMUP,
            samples: SAMPLES,
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
  // travel distance: the short/medium/long axis is the EXPLICIT maxDistance
// (the ray-march budget), so the cases are genuinely different workloads:
//   short  = 40 scene units
//   medium = 120
//   long   = 300
// (within the renderer's sanitized maxDistance range)
  const TRAVEL_MAX_DISTANCE = { short: 40, medium: 120, long: 300 };
  const TRAVEL_STEP_SIZE = 0.5;
  for (const travel of ["short", "medium", "long"]) {
    const { canvas, context, canvasFormat } = makeCanvas();
    const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
    const scene = sceneFor(() => shadowScene({ width: WIDTH, height: HEIGHT, travel, angularRadius: 0.15 }));
    const primer = sceneFor(() =>
      shadowScene({ width: WIDTH, height: HEIGHT, travel: travel === "short" ? "long" : "short", angularRadius: 0.15 }),
    );
    const maxDistance = TRAVEL_MAX_DISTANCE[travel];
    const primerMaxDistance = TRAVEL_MAX_DISTANCE[travel === "short" ? "long" : "short"];
    const theoreticalMaxSteps = Math.ceil(maxDistance / TRAVEL_STEP_SIZE);
    try {
      const series = await benchUpdateFrame(
        pipeline,
        {
          scene: primer,
          dpr: 1,
          shadowOptions: { samples: 8, maxDistance: primerMaxDistance, stepSize: TRAVEL_STEP_SIZE },
        },
        { scene, dpr: 1, shadowOptions: { samples: 8, maxDistance, stepSize: TRAVEL_STEP_SIZE } },
      );
      const snap = pipeline.getSnapshot();
      pushCase(
        `shadow/travel-${travel}`,
        {
          suite: "shadow",
          travel,
          maxDistance,
          stepSize: TRAVEL_STEP_SIZE,
          theoreticalMaxSteps,
          // the ray sample count per texel, kept SEPARATE from the
          // statistical benchmark sample count (`samples` below)
          shadowSamples: 8,
          angularRadius: 0.15,
          resolution: `${WIDTH}x${HEIGHT}`,
          warmups: WARMUP,
          samples: SAMPLES,
        },
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
// #8: reconstruction radius xDPR
// ---------------------------------------------------------------------------

async function suiteReconstruction() {
  const radii = [0, 1, 2, 4]; // 0 = bypass (radiusTexels 0)
  const dprs = [1, 1.5, 2, 3, 4];
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
          { warmups: WARMUP, sampleCount: SAMPLES },
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
          { suite: "reconstruction", dpr, radius, resolution: `${WIDTH}x${HEIGHT}`, scene: SCENE_FAMILIES.reconstructionHeavy, warmups: WARMUP, samples: SAMPLES },
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
// #9  Epresentation microbenchmark: P0 attachment-only, P1 color field,
// P2 color+owner, P3 full inputs, P4 production PresentationPass
// ---------------------------------------------------------------------------

import { PRESENT_VS, PRESENT_FS_CONSTANT, presentFs } from "./lib/presentation-shader.mjs";
async function runPresentationMicrobench(device, context, canvasFormat, stage) {
  const format = canvasFormat;
  const module = device.createShaderModule({
    code:
      PRESENT_VS +
      (stage === 0 ? PRESENT_FS_CONSTANT : presentFs(WIDTH, stage)),
    label: `bench-presentation-p${stage}`,
  });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    label: `bench-presentation-p${stage}`,
  });
  const texels = WIDTH * HEIGHT;
  const buffer = (usage, bytes) =>
    device.createBuffer({ size: Math.max(bytes, 16), usage: usage | GPUBufferUsage.COPY_DST });
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
  // The submit accepts an optional timestampWrites descriptor (benchmark
  // seam from submitWithGpuTimestamp); without it the pass is exactly the
  // historical P0-P3 microbenchmark submission.
  return (timestampWrites) => {
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
      ...(timestampWrites === undefined ? {} : { timestampWrites }),
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
  // P0-P3 use their OWN canvas, explicitly configured (canvas.width writes
  // reset a WebGPU context, and the P4 pipeline resizes its canvas on every
  // present - the two must never share a context)
  const micro = makeCanvas();
  micro.canvas.width = WIDTH;
  micro.canvas.height = HEIGHT;
  micro.context.configure({
    device,
    format: micro.canvasFormat,
    alphaMode: "premultiplied",
  });
  const submits = [];
  for (let stage = 0; stage <= 3; stage++) {
    submits.push(await runPresentationMicrobench(device, micro.context, micro.canvasFormat, stage));
  }
  // P4: the PRODUCTION PresentationPass. Two mechanisms, reported
  // separately:
  //   - wallMs: pipeline.present() + queue completion (the #29 seam)
  //   - gpuTimestampMs: a repaint render (production path) whose existing
  //     timestamp seam records ONLY the presentation stage
  const { canvas, context, canvasFormat } = makeCanvas();
  const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
  const scene = sceneFor(() => simpleRoundedRectScene({ width: WIDTH, height: HEIGHT }));
  try {
    await pipeline.render({ scene, dpr: 1, debugReadback: true });
    await device.queue.onSubmittedWorkDone();
    const p4Wall = async () => {
      const h0 = performance.now();
      const t0 = performance.now();
      pipeline.present();
      const hostMs = performance.now() - h0;
      await device.queue.onSubmittedWorkDone();
      return { wallMs: performance.now() - t0, hostMs };
    };
    const p4WallSeries = await benchSeries(p4Wall);
    const p4Gpu = async () => {
      const result = await timedRender(pipeline, { scene, dpr: 1, debugReadback: true, repaint: true });
      return result.gpuTiming?.passGpuMs?.presentation;
    };
    const p4GpuSeries = await benchSeries(p4Gpu);
    pushCase(
      "presentation/p4-production",
      { suite: "presentation", stage: "P4", resolution: `${WIDTH}x${HEIGHT}`, warmups: WARMUP, samples: SAMPLES },
      {
        wallMs: summarizeSeries(p4WallSeries.map((r) => r.wallMs)),
        gpuTimestampMs: summarizeSeries(gpuSeriesOf(p4GpuSeries, (v) => v)),
        hostMs: summarizeSeries(p4WallSeries.map((r) => r.hostMs)),
        canvasFormat,
        alphaMode: pipeline.getSnapshot().presentationPass.alphaMode,
        renderExtent: `${WIDTH}x${HEIGHT}`,
      },
    );
    for (let stage = 0; stage <= 3; stage++) {
      const submit = submits[stage];
      const timed = async () => {
        const h0 = performance.now();
        const t0 = performance.now();
        submit(undefined);
        const hostMs = performance.now() - h0;
        await device.queue.onSubmittedWorkDone();
        return { wallMs: performance.now() - t0, hostMs };
      };
      const wallSeries = await benchSeries(timed);
      const gpuSeries = [];
      const gpuHostSeries = [];
      for (let i = 0; i < SAMPLES; i++) {
        const result = await submitWithGpuTimestamp(submit);
        gpuSeries.push(result.gpuTimestampMs);
        gpuHostSeries.push(result.hostMs);
      }
      pushCase(
        `presentation/p${stage}`,
        { suite: "presentation", stage: `P${stage}`, resolution: `${WIDTH}x${HEIGHT}`, warmups: WARMUP, samples: SAMPLES },
        {
          wallMs: summarizeSeries(wallSeries.map((r) => r.wallMs)),
          gpuTimestampMs: summarizeSeries(gpuSeriesOf(gpuSeries, (v) => v)),
          hostMs: summarizeSeries(gpuHostSeries),
          canvasFormat,
          renderExtent: `${WIDTH}x${HEIGHT}`,
        },
      );
    }
  } finally {
    pipeline.dispose();
    canvas.remove();
    micro.canvas.remove();
  }
}

// ---------------------------------------------------------------------------
// #10  Esubmission-count overhead: N empty submissions
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
      { suite: "submission", submissions: count, warmups: WARMUP, samples: SAMPLES },
      {
        wallMs: summarizeSeries(series),
        submissions: count,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// #11  Eupload benchmark: which sections transfer per update type. Every
// timed sample re-creates the transition: a FRESH uploader uploads the
// `before` scene (untimed), then the timed upload of the `after` scene is
// measured (host ms + write calls + bytes + allocations of the TARGET
// frame). "first" has no before state (cold allocation is the point);
// "identical" uploads the same scene twice (allocation reuse is the point).
// ---------------------------------------------------------------------------

async function suiteUpload() {
  const gridScene = sceneFor(() => surfaceGridScene({ width: WIDTH, height: HEIGHT, count: 64 }));
  const glyphScene = sceneFor(() => glyphGridScene({ width: WIDTH, height: HEIGHT, count: 8 }));
  const gridBytes = api.encodeScene(gridScene, 1);
  const glyphBytes = api.encodeScene(glyphScene, 1);
  const lightScene = sceneFor(() => ({ ...gridScene, light: { ...gridScene.light, intensity: 0.5 } }));
  const materialScene = sceneFor(() => ({
    ...gridScene,
    materials: {
      silicone: { baseColor: { r: 0.9, g: 0.3, b: 0.2 }, roughness: 0.5, metallic: 0, ior: 1.5 },
    },
  }));
  const geometryScene = sceneFor(() => ({
    ...gridScene,
    surfaces: gridScene.surfaces.map((s, i) =>
      i === 3 ? { ...s, position: { x: s.position.x + 4, y: s.position.y + 4 } } : s,
    ),
  }));
  const maskChangedScene = sceneFor(() => ({
    ...glyphScene,
    surfaces: glyphScene.surfaces.map((s, i) =>
      i === 3
        ? { ...s, shape: { kind: "mask", mask: { width: 8, height: 8, alpha: new Uint8Array(64).fill(128) } } }
        : s,
    ),
  }));
  const casesSpec = [
    { id: "first", before: null, after: gridBytes },
    { id: "identical", before: gridBytes, after: gridBytes },
    { id: "light-only", before: gridBytes, after: api.encodeScene(lightScene, 1) },
    { id: "material-values-only", before: gridBytes, after: api.encodeScene(materialScene, 1) },
    { id: "single-surface-geometry", before: gridBytes, after: api.encodeScene(geometryScene, 1) },
    { id: "mask-change", before: glyphBytes, after: api.encodeScene(maskChangedScene, 1) },
  ];
  for (const spec of casesSpec) {
    const series = [];
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      const uploader = new api.SceneUploader(device);
      try {
        if (spec.before !== null) {
          uploader.upload(spec.before); // before state (untimed)
        }
        const wallStart = performance.now();
        const hostStart = performance.now();
        const stats = uploader.upload(spec.after);
        const hostMs = performance.now() - hostStart;
        await device.queue.onSubmittedWorkDone();
        const wallMs = performance.now() - wallStart;
        if (i >= WARMUP) {
          const bindings = uploader.getBindings();
          series.push({
            hostMs,
            wallMs,
            stats,
            bytes: spec.after.bytes.byteLength,
            bindings,
          });
        }
      } finally {
        uploader.dispose();
      }
    }
    const last = series[series.length - 1];
    // #14 which sections did the TARGET scene actually transfer (the
    // uploader writes every non-empty section), and which sections'
    // bytes CHANGED between the before and after scenes
    const writtenSections = [];
    for (const [name, binding] of [
      ["header", last.bindings.header],
      ["surfaces", last.bindings.surfaces],
      ["masks", last.bindings.masks],
      ["maskPixels", last.bindings.maskPixels],
      ["materials", last.bindings.materials],
    ]) {
      if (binding.byteLength > 0) {
        writtenSections.push(name);
      }
    }
    const changedSections = sectionDeltas(spec.before, spec.after);
    pushCase(
      `upload/${spec.id}`,
      {
        suite: "upload",
        updateType: spec.id,
        resolution: `${WIDTH}x${HEIGHT}`,
        warmups: WARMUP,
        samples: SAMPLES,
      },
      {
        hostMs: summarizeSeries(series.map((r) => r.hostMs)),
        wallMs: summarizeSeries(series.map((r) => r.wallMs)),
        encodedBytes: last.bytes,
        headerBytes: last.bindings.header.byteLength,
        surfaceBytes: last.bindings.surfaces.byteLength,
        maskRecordBytes: last.bindings.masks.byteLength,
        maskPixelBytes: last.bindings.maskPixels.byteLength,
        materialBytes: last.bindings.materials.byteLength,
        writeCalls: last.stats.writeCalls,
        bytesUploaded: last.stats.bytesUploaded,
        newAllocations: last.stats.newAllocations,
        writtenSections,
        changedSections,
      },
    );
  }
}

/**
 * #14 section-level byte comparison between two encoded scenes: which
 * sections' bytes actually differ (the answer to "which update transfers
 * which section"). The uploader itself always rewrites every non-empty
 * section; the DELTA is what distinguishes update types.
 */
function sectionDeltas(before, after) {
  if (before === null) {
    return ["first-upload-all-sections"];
  }
  const sections = ["header", "surfaces", "masks", "materials", "maskPixels"];
  const equalSection = (name) => {
    const a = api.sceneSectionLayout(api.parseHeader(before.bytes));
    const b = api.sceneSectionLayout(api.parseHeader(after.bytes));
    const offsets = {
      header: 0,
      surfaces: a.surfacesOffset,
      masks: a.masksOffset,
      materials: a.materialsOffset,
      maskPixels: a.maskPixelsOffset,
    };
    const lengths = {
      header: a.headerByteLength,
      surfaces: a.surfacesByteLength,
      masks: a.masksByteLength,
      materials: a.materialsByteLength,
      maskPixels: a.maskPixelsByteLength,
    };
    if (lengths[name] !== 0 && lengths[name] !== {
      header: b.headerByteLength,
      surfaces: b.surfacesByteLength,
      masks: b.masksByteLength,
      materials: b.materialsByteLength,
      maskPixels: b.maskPixelsByteLength,
    }[name]) {
      return false;
    }
    const start = offsets[name];
    const end = start + lengths[name];
    if (end > before.bytes.byteLength || end > after.bytes.byteLength) {
      return false;
    }
    const prev = before.bytes.subarray(start, end);
    const next = after.bytes.subarray(start, end);
    if (prev.length !== next.length) return false;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== next[i]) return false;
    }
    return true;
  };
  const changed = [];
  for (const name of sections) {
    if (!equalSection(name)) {
      changed.push(name);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// #12 — partial vs forced-full recompute, labeled by the PLANNER's actual
// dirty ratio (never by the input knob alone). Every case is a PAIR measured
// on the SAME warm retained pipeline with the SAME base -> target
// transition:
//   A. the normal scheduler render of the target (planning = real decision)
//   B. the benchmark-only debugForceFull render of the SAME target
// Both sides share the identical resource state (pipeline, allocations,
// shader caches, canvas, device), so the only difference is the execution
// plan. The calibration diagnostic normalFullToForcedFullRatio compares the
// two sides on cases where the normal planner ALSO chose full.
// ---------------------------------------------------------------------------

const PARTIAL_MOVE_EDITS = [0.02, 0.05, 0.1, 0.2, 0.35, 0.55, 0.8, 1];
const PARTIAL_GROW_EDITS = [1, 2, 4, 7];

async function suitePartial() {
  const base = sceneFor(() => partialEditScene({ width: WIDTH, height: HEIGHT }));
  const shadowOptions = { maxDistance: 40, stepSize: 0.5, bias: 0.5 };
  const casesSpec = [
    ...PARTIAL_MOVE_EDITS.map((edit) => ({ id: `move-${edit}`, edit, grow: 0 })),
    ...PARTIAL_GROW_EDITS.map((grow) => ({ id: `grow-${grow}`, edit: 0, grow })),
  ];
  for (const spec of casesSpec) {
    const { canvas, context, canvasFormat } = makeCanvas();
    const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
    const edit = sceneFor(() =>
      partialEditScene({ width: WIDTH, height: HEIGHT, edit: spec.edit, grow: spec.grow }),
    );
    try {
      // A + B on the SAME pipeline: every sample resets to base, then the
      // target is rendered once through the normal scheduler and once with
      // debugForceFull — identical resource warm state on both sides.
      const normalSeries = [];
      const forcedSeries = [];
      for (let i = 0; i < WARMUP + SAMPLES; i++) {
        await timedRender(pipeline, { scene: base, dpr: 1, shadowOptions, tileSize: 64 });
        const normal = await timedRender(pipeline, {
          scene: edit,
          dpr: 1,
          shadowOptions,
          tileSize: 64,
        });
        await timedRender(pipeline, { scene: base, dpr: 1, shadowOptions, tileSize: 64 });
        const forced = await timedRender(pipeline, {
          scene: edit,
          dpr: 1,
          shadowOptions,
          tileSize: 64,
          debugForceFull: true,
        });
        if (i >= WARMUP) {
          normalSeries.push(normal);
          forcedSeries.push(forced);
        }
      }
      const first = normalSeries[0];
      const plan = first.stats.planning;
      const totalTexels = plan.totalTexels ?? WIDTH * HEIGHT;
      const dirtyTexels = plan.dirtyTexels ?? null;
      const actualDirtyRatio = dirtyTexels !== null ? dirtyTexels / totalTexels : null;
      const partialGpu = totalGpuSummary(normalSeries)?.median;
      const forcedGpuMedian = totalGpuSummary(forcedSeries);
      const forcedWall = summarizeSeries(forcedSeries.map((r) => r.wallMs));
      const partialToFullRatio =
        forcedGpuMedian?.median !== null && forcedGpuMedian?.median !== undefined && forcedGpuMedian.median > 0
          ? partialGpu / forcedGpuMedian.median
          : null;
      // calibration: when the NORMAL planner also chose full, the two sides
      // must agree (a systematic normal-vs-forced gap would mean the
      // comparator is still unfair)
      const normalFullToForcedFullRatio =
        plan.mode === "full" && forcedGpuMedian?.median !== null && forcedGpuMedian?.median > 0
          ? partialGpu / forcedGpuMedian.median
          : null;
      const forcedPlan = forcedSeries[forcedSeries.length - 1].stats.planning;
      if (forcedPlan.mode !== "full") {
        notes.push(
          `partial/${spec.id}: debugForceFull planned ${forcedPlan.mode} — the seam must always plan full`,
        );
      }
      const forcedExecuted =
        forcedSeries[forcedSeries.length - 1].stats.invalidation.executed.join(",");
      const expectedForcedExecuted =
        "upload,height,normal,shadow,reconstruction,lighting,presentation";
      if (forcedExecuted !== expectedForcedExecuted) {
        notes.push(
          `partial/${spec.id}: debugForceFull executed [${forcedExecuted}] ` +
            "(expected the full seven-stage chain)",
        );
      }
      pushCase(
        `partial/${spec.id}`,
        {
          suite: "partial",
          inputEdit: spec.edit,
          inputGrow: spec.grow,
          resolution: `${WIDTH}x${HEIGHT}`,
          scene: SCENE_FAMILIES.partialEdit,
          tileSize: 64,
          warmups: WARMUP,
          samples: SAMPLES,
        },
        {
          wallMs: summarizeSeries(normalSeries.map((r) => r.wallMs)),
          planningHostMs: summarizeSeries(normalSeries.map((r) => r.stats.planning.planningHostMs)),
          gpuTimestampMs: totalGpuSummary(normalSeries),
          heightGpuTimestampMs: summarizeSeries(gpuSeriesOf(normalSeries, (r) => r.gpuTiming?.passGpuMs?.height)),
          shadowGpuTimestampMs: summarizeSeries(gpuSeriesOf(normalSeries, (r) => r.gpuTiming?.passGpuMs?.shadow)),
          forcedFullGpuTimestampMs: forcedGpuMedian,
          forcedFullWallMs: forcedWall,
          forcedFullPlanningMode: forcedPlan.mode,
          forcedFullPlanningReason: forcedPlan.reason,
          forcedFullExecuted: forcedExecuted,
          partialToFullRatio,
          normalFullToForcedFullRatio,
          partialPlanningMode: plan.mode,
          partialPlanningReason: plan.reason,
          actualDirtyRatio,
          dirtyTileCount: plan.dirtyTileCount ?? null,
          dirtyTexels,
          totalTileCount: plan.totalTileCount ?? null,
          dispatchTexels: plan.dispatchTexels ?? null,
          totalTexels,
          candidateSurfaceCount: plan.candidateSurfaceCount ?? null,
          culledSurfaceCount: plan.culledSurfaceCount ?? null,
        },
      );
    } finally {
      pipeline.dispose();
      canvas.remove();
    }
  }
}

// ---------------------------------------------------------------------------
// #13: retained scheduling: TWO separate measurements per variant, never
// mixed into one average:
//   A. transitionFrame: the real base -> variant update frame (every sample
//      is a fresh transition via benchUpdateFrame)
//   B. repeatedRetained: identical variant -> variant frames after the
//      transition (the retained skip cost)
// ---------------------------------------------------------------------------

async function suiteRetained() {
  const { canvas, context, canvasFormat } = makeCanvas();
  const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
  const base = sceneFor(() => simpleRoundedRectScene({ width: WIDTH, height: HEIGHT }));
  const variants = [
    { id: "no-change", input: { scene: base, dpr: 1 }, transition: false },
    { id: "repaint-only", input: { scene: base, dpr: 1, repaint: true }, transition: false },
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
  const expectedExecuted = {
    "no-change": "",
    "repaint-only": "presentation",
    "light-intensity": "upload,lighting,presentation",
    "light-direction": "upload,shadow,reconstruction,lighting,presentation",
    "material-values": "upload,lighting,presentation",
    geometry: "upload,height,normal,shadow,reconstruction,lighting,presentation",
  };
  try {
    for (const variant of variants) {
      // A. transition frame cost (real base -> variant per sample)
      const transitionSeries = variant.transition === false
        ? null
        : await benchUpdateFrame(pipeline, { scene: base, dpr: 1 }, variant.input);
      // B. repeated retained frames (variant -> variant)
      const repeated = [];
      await timedRender(pipeline, variant.input);
      for (let i = 0; i < RETAINED_FRAMES; i++) {
        repeated.push(await timedRender(pipeline, variant.input));
      }
      pushCase(
        `retained/${variant.id}`,
        {
          suite: "retained",
          case: variant.id,
          frames: RETAINED_FRAMES,
          resolution: `${WIDTH}x${HEIGHT}`,
          warmups: WARMUP,
          samples: SAMPLES,
        },
        {
          transitionWallMs:
            transitionSeries !== null
              ? summarizeSeries(transitionSeries.map((r) => r.wallMs))
              : null,
          transitionGpuTimestampMs:
            transitionSeries !== null ? totalGpuSummary(transitionSeries) : null,
          transitionExecuted:
            transitionSeries !== null
              ? transitionSeries[transitionSeries.length - 1].stats.invalidation.executed.join(",")
              : "",
          transitionSubmissions:
            transitionSeries !== null
              ? transitionSeries[transitionSeries.length - 1].stats.frame.submissions
              : null,
          repeatedWallMs: summarizeSeries(repeated.map((r) => r.wallMs)),
          repeatedSubmissionsPerFrame:
            repeated.reduce((a, r) => a + r.stats.frame.submissions, 0) / repeated.length,
          repeatedDispatchesPerFrame:
            repeated.reduce((a, r) => a + r.stats.frame.dispatchCount, 0) / repeated.length,
          repeatedBytesUploadedPerFrame:
            repeated.reduce((a, r) => a + r.stats.frame.bytesUploaded, 0) / repeated.length,
          repeatedExecuted: repeated[repeated.length - 1].stats.invalidation.executed.join(","),
          expectedExecuted: expectedExecuted[variant.id],
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
    if (notes.length > 0) {
      doc.notes = [...notes];
    }
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