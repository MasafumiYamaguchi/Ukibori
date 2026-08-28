// #46 DOM integration benchmark (§D/§14): ukibori-dom browser benchmark.
//
// Measures the DOM layer SEPARATELY from GPU work, with the REAL
// MutationObserver / ResizeObserver paths (observe: true) and the real
// WebGPU renderer:
//   - registered surface re-measurement (getBoundingClientRect count)
//   - dirty entries, scene rebuild, renderer invocation, skipped render
//   - the complete DOM -> presented frame wall time per scenario
//
// Scenarios (per registered-surface count):
//   stable-page        no DOM changes after mount (retained frame)
//   one-surface-resize one registered Ukibori surface resized (ResizeObserver)
//   unrelated-mutation one unrelated DOM mutation (document MutationObserver)
//   frequent-mutations one unrelated mutation per frame
//   scroll             document-relative geometry unchanged
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

const RESULT_EL = document.getElementById("result");
const MARKER_PASS = "UKIBORI_DOM_BENCH_PASS";
const MARKER_FAIL = "UKIBORI_DOM_BENCH_FAIL";
const MARKER_SKIP = "UKIBORI_DOM_BENCH_SKIP";

const query = new URLSearchParams(location.search);
const WARMUP = Number(query.get("warmup") ?? 2);
const SAMPLES = Number(query.get("samples") ?? 5);
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
/** Let MutationObserver / ResizeObserver callbacks deliver, then flush. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
}

let rectCalls = 0;
function instrument() {
  const proto = Element.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
  if (desc !== undefined && desc.value !== undefined && !desc.value.__benchmarked) {
    const original = desc.value;
    const wrapped = function (...args) {
      rectCalls += 1;
      return original.apply(this, args);
    };
    wrapped.__benchmarked = true;
    Object.defineProperty(proto, "getBoundingClientRect", {
      ...desc,
      value: wrapped,
    });
  }
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
  const buttons = [];
  for (let i = 0; i < surfaceCount; i++) {
    const button = document.createElement("button");
    button.type = "button";
    button.style.position = "absolute";
    const rect = surfaceRect(i);
    button.style.left = `${rect.left}px`;
    button.style.top = `${rect.top}px`;
    button.style.width = `${rect.width}px`;
    button.style.height = `${rect.height}px`;
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
  return { stage, buttons, unrelated };
}

const BUTTON_OPTIONS = (i) => ({
  id: `s${i}`,
  shape: { kind: "roundedRect", radius: 8 },
  elevation: 2,
  thickness: 2,
  material: "silicone",
});

async function measureScenario(scenario, surfaceCount, { frames = 1 }) {
  const { stage, buttons, unrelated } = mountStage(surfaceCount);
  instrument();
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
    await settle(); // mount render (untimed)
    rectCalls = 0;
    const perFrame = [];
    for (let frame = 0; frame < frames; frame++) {
      const beforeRects = rectCalls;
      const beforePipelines = pipelineInvocations;
      const beforeFrame = layer.debugState().gpuFrame;
      const t0 = performance.now();
      switch (scenario) {
        case "stable-page":
          break; // no DOM change at all
        case "one-surface-resize": {
          const target = buttons[0].button;
          const rect = surfaceRect(0);
          target.style.left = `${rect.left + frame + 1}px`;
          target.style.top = `${rect.top + frame + 1}px`;
          break;
        }
        case "unrelated-mutation":
        case "frequent-mutations":
          unrelated.style.width = `${10 + frame + 1}px`;
          break;
        case "scroll":
          break; // geometry document-relative and unchanged
        default:
          throw new Error(`unknown scenario ${scenario}`);
      }
      await settle();
      const totalMs = performance.now() - t0;
      const state = layer.debugState();
      const afterFrame = state.gpuFrame;
      const rendered = afterFrame !== beforeFrame;
      const gpuFrame = rendered ? afterFrame : null;
      perFrame.push({
        totalMs,
        rectCallsDelta: rectCalls - beforeRects,
        pipelineInvocationsDelta: pipelineInvocations - beforePipelines,
        rendered,
        dirtyCount: state.dirtyCount,
        lastRenderMs: state.lastRenderMs,
        executed: gpuFrame !== null ? gpuFrame.frame.invalidation.executed.join(",") : "",
        retained: gpuFrame !== null ? gpuFrame.frame.invalidation.retained === true : null,
        renderSize: state.renderSize !== null ? `${state.renderSize.width}x${state.renderSize.height}` : null,
      });
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
        wallMs: summarizeSeries(perFrame.map((f) => f.totalMs)),
        rectCallsPerFrame: summarizeSeries(perFrame.map((f) => f.rectCallsDelta)),
        rendererInvocationsPerFrame: summarizeSeries(perFrame.map((f) => f.pipelineInvocationsDelta)),
        skippedRenderPerFrame: summarizeSeries(perFrame.map((f) => (f.rendered ? 0 : 1))),
        dirtyCountPerFrame: summarizeSeries(perFrame.map((f) => f.dirtyCount)),
        lastRenderMsPerFrame: summarizeSeries(perFrame.map((f) => f.lastRenderMs)),
        executed: perFrame.map((f) => f.executed).filter((v, i, a) => a.indexOf(v) === i).join("|"),
        retained: perFrame.map((f) => (f.retained === true ? 1 : 0)).reduce((a, b) => a + b, 0) / perFrame.length,
        renderSize: perFrame[perFrame.length - 1].renderSize,
        backend: layer.debugState().backend,
      },
    );
  } finally {
    layer.dispose();
    stage.remove();
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
    "unrelated-mutation",
    "frequent-mutations",
    "scroll",
  ];
  try {
    for (const surfaceCount of surfaceCounts) {
      for (const scenario of scenarios) {
        notes.push(`dom ${scenario} surfaces-${surfaceCount} start`);
        const frames = scenario === "frequent-mutations" ? Math.max(10, SAMPLES) : 1;
        await measureScenario(scenario, surfaceCount, { frames });
        notes.push(`dom ${scenario} surfaces-${surfaceCount} done`);
      }
    }
    const doc = createResultDocument({
      environment: {
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
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