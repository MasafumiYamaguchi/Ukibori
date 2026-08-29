// #46 DOM integration benchmark (#D/#14): ukibori-dom browser benchmark.
//
// Measures the DOM layer SEPARATELY from GPU work, with the REAL
// MutationObserver / ResizeObserver paths (observe: true) and the real
// WebGPU renderer:
//   - registered surface re-measurement (getBoundingClientRect count + ms)
//   - getComputedStyle() count + ms (benchmark-only instrumentation)
//   - dirty entries, scene rebuild, renderer invocation, skipped render
//   - measurement time / scene-build time (debugState seams)
//   - the complete DOM -> presented frame wall time per scenario
//
// Scenarios (per registered-surface count):
//   stable-page        no DOM changes after mount (retained frame)
//   one-surface-resize one registered Ukibori surface resized (ResizeObserver)
//   unrelated-mutation one unrelated DOM mutation (document MutationObserver)
//   frequent-mutations one unrelated mutation per frame
//   scroll             document-relative geometry unchanged
//
// EVERY scenario runs `warmup` untimed frames then `samples` timed frames
// (query parameters; defaults keep a full run manageable). The mount-time
// observer/scheduled-renderer work is fully drained (bounded settle loop)
// before any measurement.
//
// Marker contract identical to the renderer harness: first line
// UKIBORI_DOM_BENCH_PASS/FAIL/SKIP + `SUMMARY <json>` (the versioned result
// document consumed by scripts/bench-dom.mjs).

import { UkiboriDom } from "../src/index";
import { summarizeSeries } from "@ukibori-bench/stats";
import {
  createResultDocument,
  validateResultDocument,
} from "@ukibori-bench/schema";
import { drainLoop, installCounter } from "./dom-bench-helpers.mjs";

const RESULT_EL = document.getElementById("result");
const MARKER_PASS = "UKIBORI_DOM_BENCH_PASS";
const MARKER_FAIL = "UKIBORI_DOM_BENCH_FAIL";
const MARKER_SKIP = "UKIBORI_DOM_BENCH_SKIP";

const query = new URLSearchParams(location.search);
const WARMUP = Number(query.get("warmup") ?? 5);
const SAMPLES = Number(query.get("samples") ?? 20);
const SURFACE_QUERY = query.get("surfaces") ?? "1,10,50,100,250,500,1000";

const cases = [];
const notes = [];

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

/**
 * Bounded observer drain with frame-local timing decomposition: the caller
 * times the flush callbacks (`callbackHostMs`) and the wait turns
 * (`settleWallMs`) separately. `skipIdleWait` lets event-less scenarios
 * (stable-page) skip the setTimeout(0) scheduler floor entirely so it is
 * never billed as Ukibori work.
 */
async function drain({ skipIdleWait = false, callbackTimer = null, settleTimer = null } = {}) {
  const outcome = await drainLoop({
    wait: () => {
      const t0 = performance.now();
      return new Promise((resolve) =>
        setTimeout(() => {
          if (settleTimer !== null) {
            settleTimer.ms += performance.now() - t0;
          }
          resolve();
        }, 0),
      );
    },
    hasPending: () => pending.length > 0,
    flush: () => {
      const t0 = performance.now();
      flushPending();
      if (callbackTimer !== null) {
        callbackTimer.ms += performance.now() - t0;
      }
    },
    skipIdleWait,
  });
  if (!outcome.drained) {
    notes.push(`observer drain hit the ${outcome.passes}-pass cap (work may still be pending)`);
  }
  return outcome;
}

function flushPending() {
  const copy = [...pending];
  pending.length = 0;
  for (const cb of copy) {
    cb();
  }
}

const rectCounter = { calls: 0, ms: 0 };
const styleCounter = { calls: 0, ms: 0 };
const restoreInstrumentation = [];
function instrument() {
  restoreInstrumentation.push(
    installCounter(Element.prototype, "getBoundingClientRect", rectCounter),
  );
  restoreInstrumentation.push(
    installCounter(window, "getComputedStyle", styleCounter),
  );
}
function resetCounters() {
  rectCounter.calls = 0;
  rectCounter.ms = 0;
  styleCounter.calls = 0;
  styleCounter.ms = 0;
}

/** Deterministic document-relative geometry: left/top fixed per surface index. */
function surfaceRect(index) {
  const col = index % 8;
  const row = Math.floor(index / 8);
  return { left: 8 + col * 90, top: 8 + row * 60, width: 64, height: 36 };
}

function mountStage(surfaceCount) {
  const stage = document.createElement("div");
  stage.id = "bench-stage";
  stage.style.position = "relative";
  stage.style.width = "800px";
  stage.style.height = "1200px";
  document.body.appendChild(stage);
  // a tall spacer makes the document scrollable so the scroll scenario can
  // produce REAL scroll events (window.scrollTo) instead of faking them
  const spacer = document.createElement("div");
  spacer.id = "bench-spacer";
  spacer.style.height = "2400px";
  spacer.style.width = "1px";
  document.body.appendChild(spacer);
  // CSSOM resize rule for the one-surface-resize scenario: changing the
  // rule's style changes the target's LAYOUT size without producing any
  // style-attribute MutationRecord, so the ResizeObserver path (per-surface
  // markDirty) is what fires — never the document MutationObserver.
  const styleEl = document.createElement("style");
  styleEl.id = "bench-resize-rule";
  styleEl.textContent =
    "#bench-resize-target { width: 64px; height: 36px; }";
  document.head.appendChild(styleEl);
  const resizeRule = styleEl.sheet.cssRules[0];
  const buttons = [];
  for (let i = 0; i < surfaceCount; i++) {
    const button = document.createElement("button");
    button.type = "button";
    button.style.position = "absolute";
    const rect = surfaceRect(i);
    button.style.left = `${rect.left}px`;
    button.style.top = `${rect.top}px`;
    if (i === 0) {
      // the resize target's width/height come from the CSSOM rule, not
      // inline styles (a rule edit is not a DOM attribute mutation)
      button.id = "bench-resize-target";
    } else {
      button.style.width = `${rect.width}px`;
      button.style.height = `${rect.height}px`;
    }
    button.style.padding = "0";
    button.style.border = "none";
    stage.appendChild(button);
    buttons.push({ button, rect });
  }
  const unrelated = document.createElement("div");
  unrelated.id = "unrelated";
  unrelated.style.position = "absolute";
  unrelated.style.left = "0px";
  unrelated.style.top = "0px";
  unrelated.style.width = "10px";
  unrelated.style.height = "10px";
  // OUTSIDE the stage: mutations inside the overlay node are filtered out
  // as the layer's own output (isManagedMutation), so an unrelated mutation
  // must live on a sibling to exercise the document MutationObserver path.
  document.body.appendChild(unrelated);
  return { stage, buttons, unrelated, spacer, resizeRule };
}

const BUTTON_OPTIONS = (i) => ({
  id: `s${i}`,
  shape: { kind: "roundedRect", radius: 8 },
  elevation: 2,
  thickness: 2,
  material: "silicone",
});

async function measureScenario(scenario, surfaceCount, { frames }) {
  const { stage, buttons, unrelated, spacer, resizeRule } = mountStage(surfaceCount);
  const layer = await UkiboriDom.create({
    backend: "webgpu",
    observe: true,
    schedule,
    overlay: { stage },
    dpr: 1,
  });
  let pipelineInvocations = 0;
  try {
    if (layer.gpuPipeline !== null) {
      const original = layer.gpuPipeline.render.bind(layer.gpuPipeline);
      layer.gpuPipeline.render = (input) => {
        pipelineInvocations += 1;
        return original(input);
      };
    }
    for (let i = 0; i < buttons.length; i++) {
      layer.register(buttons[i].button, BUTTON_OPTIONS(i));
    }
    // FULL mount drain before any measurement (mount observers/renderer
    // callbacks must be quiescent, or the first measured frame inherits
    // stray mount work)
    await drain();
    await drain();
    resetCounters();
    const perFrame = [];
    for (let frame = 0; frame < frames; frame++) {
      const beforeRects = rectCounter.calls;
      const beforeStyles = styleCounter.calls;
      const beforePipelines = pipelineInvocations;
      // frame-local provenance serials: only a frame whose serial advanced
      // may attribute the timing values (stale previous-frame values are
      // forbidden). Render detection uses the SERIALS, never the gpuFrame
      // object identity (the async gpuTiming readback replaces the object
      // without a render).
      const beforeSerials = {
        render: layer.debugState().renderSerial,
        measure: layer.debugState().measureSerial,
        scene: layer.debugState().sceneBuildSerial,
        gpuRender: layer.debugState().gpuRenderSerial,
      };
      const callbackTimer = { ms: 0 };
      const settleTimer = { ms: 0 };
      const t0 = performance.now();
      let triggerHostMs = 0;
      switch (scenario) {
        case "stable-page":
          break; // no DOM change at all
        case "one-surface-resize": {
          // REAL ResizeObserver path: edit the CSSOM rule so the target's
          // LAYOUT size changes without producing any style-attribute
          // MutationRecord (the document MutationObserver must NOT fire).
          const t1 = performance.now();
          const grow = frame + 1;
          resizeRule.style.width = `${64 + grow}px`;
          resizeRule.style.height = `${36 + grow}px`;
          triggerHostMs = performance.now() - t1;
          break;
        }
        case "surface-style-mutation": {
          // the historical style-attribute mutation case, kept SEPARATE: the
          // document MutationObserver -> markAllDirty path (NOT a resize)
          const target = buttons[0].button;
          const rect = surfaceRect(0);
          const t1 = performance.now();
          target.style.left = `${rect.left + frame + 1}px`;
          target.style.top = `${rect.top + frame + 1}px`;
          triggerHostMs = performance.now() - t1;
          break;
        }
        case "unrelated-mutation":
        case "frequent-mutations": {
          const t1 = performance.now();
          unrelated.style.width = `${10 + frame + 1}px`;
          triggerHostMs = performance.now() - t1;
          break;
        }
        case "scroll": {
          // REAL scroll path: move the viewport and let the layer's
          // document scroll listener invalidate (capture phase). Geometry
          // is document-relative, so the renderer is expected to skip.
          const t1 = performance.now();
          window.scrollTo(0, 10 + (frame % 200));
          triggerHostMs = performance.now() - t1;
          break;
        }
        default:
          throw new Error(`unknown scenario ${scenario}`);
      }
      // stable-page produces no event at all: skip the idle settle floor
      const skipIdleWait = scenario === "stable-page";
      await drain({ skipIdleWait, callbackTimer, settleTimer });
      const totalMs = performance.now() - t0;
      const state = layer.debugState();
      const rendererRan = state.gpuRenderSerial !== beforeSerials.gpuRender;
      const renderRanThisFrame = state.renderSerial !== beforeSerials.render;
      const measureRanThisFrame = state.measureSerial !== beforeSerials.measure;
      const sceneBuiltThisFrame = state.sceneBuildSerial !== beforeSerials.scene;
      // invariant: the pipeline-invocation counter and the gpuRenderSerial
      // must agree on whether the renderer ran (GPU backend)
      if (rendererRan !== (pipelineInvocations - beforePipelines > 0)) {
        notes.push(
          `dom ${scenario} surfaces-${surfaceCount}: gpuRenderSerial and pipeline ` +
            `invocation counter disagree (rendererRan=${rendererRan}, ` +
            `invocations=${pipelineInvocations - beforePipelines})`,
        );
      }
      // current-frame executed stages: the renderer's own result is only
      // readable when it RAN this frame; otherwise executed stays empty
      // (the async gpuTiming object swap is not a render)
      let executed = "";
      let retained = null;
      let gpuStats = null;
      if (rendererRan) {
        gpuStats = state.gpuFrame?.frame ?? null;
        executed = gpuStats !== null ? gpuStats.invalidation.executed.join(",") : "";
        retained = gpuStats !== null ? gpuStats.invalidation.retained === true : null;
      }
      perFrame.push({
        totalMs,
        callbackHostMs: callbackTimer.ms,
        settleWallMs: settleTimer.ms,
        triggerHostMs,
        rectCallsDelta: rectCounter.calls - beforeRects,
        styleCallsDelta: styleCounter.calls - beforeStyles,
        pipelineInvocationsDelta: pipelineInvocations - beforePipelines,
        rendererRan,
        dirtyCount: state.dirtyCount,
        renderHostMs: renderRanThisFrame ? state.lastRenderMs : 0,
        measureHostMs: measureRanThisFrame ? state.lastMeasureMs : 0,
        measuredEntries: measureRanThisFrame ? state.lastMeasuredEntries : 0,
        sceneBuildHostMs: sceneBuiltThisFrame ? state.lastSceneBuildMs : 0,
        executed,
        retained,
        renderSize: state.renderSize !== null ? `${state.renderSize.width}x${state.renderSize.height}` : null,
      });
    }
    // time every frame (cheap), but only the last SAMPLES frames count:
    // the first WARMUP frames are warmup and must never enter the summary
    const timed = perFrame.slice(WARMUP);
    if (timed.length !== SAMPLES) {
      notes.push(`dom ${scenario} surfaces-${surfaceCount}: expected ${SAMPLES} timed frames, got ${timed.length}`);
    }
    pushCase(
      `dom/${scenario}/${surfaceCount}`,
      {
        suite: "dom",
        scenario,
        surfaceCount,
        frames,
        warmups: WARMUP,
        samples: SAMPLES,
      },
      {
        wallMs: summarizeSeries(timed.map((f) => f.totalMs)),
        callbackHostMsPerFrame: summarizeSeries(timed.map((f) => f.callbackHostMs)),
        settleWallMsPerFrame: summarizeSeries(timed.map((f) => f.settleWallMs)),
        triggerHostMsPerFrame: summarizeSeries(timed.map((f) => f.triggerHostMs)),
        rectCallsPerFrame: summarizeSeries(timed.map((f) => f.rectCallsDelta)),
        computedStyleCallsPerFrame: summarizeSeries(timed.map((f) => f.styleCallsDelta)),
        rendererInvocationsPerFrame: summarizeSeries(timed.map((f) => f.pipelineInvocationsDelta)),
        skippedRenderPerFrame: summarizeSeries(timed.map((f) => (f.rendererRan ? 0 : 1))),
        dirtyCountPerFrame: summarizeSeries(timed.map((f) => f.dirtyCount)),
        measureHostMsPerFrame: summarizeSeries(timed.map((f) => f.measureHostMs)),
        measuredEntriesPerFrame: summarizeSeries(timed.map((f) => f.measuredEntries)),
        sceneBuildHostMsPerFrame: summarizeSeries(timed.map((f) => f.sceneBuildHostMs)),
        renderHostMsPerFrame: summarizeSeries(timed.map((f) => f.renderHostMs)),
        executed: timed.map((f) => f.executed).filter((v, i, a) => a.indexOf(v) === i).join("|"),
        retained: timed.map((f) => (f.retained === true ? 1 : 0)).reduce((a, b) => a + b, 0) / timed.length,
        renderSize: timed[timed.length - 1].renderSize,
        backend: layer.debugState().backend,
      },
    );
  } finally {
    layer.dispose();
    stage.remove();
    unrelated.remove();
    spacer.remove();
    document.getElementById("bench-resize-rule")?.remove();
    window.scrollTo(0, 0);
  }
}

function pushCase(id, parameters, metrics) {
  cases.push({ id, parameters, metrics });
}

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
  if (!navigator.gpu) {
    publish(MARKER_SKIP, "navigator.gpu unavailable in this browser", null);
    return;
  }
  const surfaceCounts = SURFACE_QUERY.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const scenarios = [
    "stable-page",
    "one-surface-resize",
    "surface-style-mutation",
    "unrelated-mutation",
    "frequent-mutations",
    "scroll",
  ];
  try {
    instrument();
    for (const surfaceCount of surfaceCounts) {
      for (const scenario of scenarios) {
        notes.push(`dom ${scenario} surfaces-${surfaceCount} start`);
        // warmup frames are NOT counted: every scenario runs WARMUP + SAMPLES
        // frames and only the last SAMPLES are timed
        await measureScenario(scenario, surfaceCount, { frames: WARMUP + SAMPLES });
        notes.push(`dom ${scenario} surfaces-${surfaceCount} done`);
      }
    }
    const doc = createResultDocument({
      environment: {
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        browser: /Chrome\//.test(navigator.userAgent) ? "chrome" : "unknown",
        // explicit UA information (not a guess): HeadlessChrome appears in
        // the UA of headless Chrome regardless of the webdriver flag
        headless: navigator.webdriver === true || /HeadlessChrome\//.test(navigator.userAgent),
        devicePixelRatio: window.devicePixelRatio,
        backend: "webgpu",
      },
      cases,
    });
    const problems = validateResultDocument(doc);
    if (problems.length > 0) {
      publish(MARKER_FAIL, `result document invalid: ${problems.join("; ")}`, doc);
      return;
    }
    publish(MARKER_PASS, `${cases.length} cases`, doc);
  } catch (error) {
    publish(MARKER_FAIL, String(error?.stack ?? error), null);
  }
}

void main();