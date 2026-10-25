import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Bake, Surface, Ukibori, UkiboriText } from "../src/index";
import type { UkiboriDom } from "ukibori-dom";

// R0 fixture: keep these conditions unchanged for before/after comparisons.
const progress = [0, 0.125, 0.375, 0.625, 0.875, 1, 0.875, 0.625, 0.375, 0.125];
const warmup = 20, samples = 60;
const grainEnabled = new URLSearchParams(location.search).has("grain");
let layer: UkiboriDom | null = null;
const errors: string[] = [];
const ready = (value: UkiboriDom | null) => { layer = value; };
const onError = (error: unknown) => { errors.push(String(error)); };
const svg = { kind: "svgPath" as const, d: "M1 1H15V15H1ZM5 5V11H11V5Z", viewBox: [0, 0, 16, 16] as [number, number, number, number], fillRule: "evenodd" as const };
const root = createRoot(document.getElementById("root")!);
function Fixture({ p, effects }: { p: number; effects: boolean }) {
  return <Ukibori backend="webgpu" gpuProfiling dpr={1} margin={8} highContrast={false}
    light={{ x: -0.6, y: -0.8, z: 1 }} angularRadius={0.12}
    shadow={{ samples: 8, maxDistance: 48, reconstruction: { radius: 2 } }}
    materials={{ button: { baseColor: { r: 0.35, g: 0.4, b: 0.45 }, roughness: 0.5, metallic: 0,
      grain: grainEnabled ? { scale: 3, strength: 0.6, seed: 42 } : undefined,
      emissive: effects ? { r: 0.3, g: 0.1, b: 0.02 } : undefined } }}
    basePlaneColor="#bcbcbc" compositing={{ emissive: effects ? {
      illumination: { radius: 24, intensity: 0.5 }, bloom: { radius: 8, intensity: 0.4 } } : undefined }}
    onReady={ready} onError={onError} style={{ position: "relative", width: 320, height: 180 }}>
    <Bake><UkiboriText sceneId="static-text" text="UI" elevation={4} thickness={1}
      style={{ position: "absolute", left: 24, top: 16, font: "bold 16px Arial", color: "#777" }} />
    <Surface sceneId="static-icon" shape={svg} elevation={5} thickness={1}
      style={{ position: "absolute", left: 80, top: 16, width: 16, height: 16 }} aria-label="Fixed icon" /></Bake>
    <Surface as="button" type="button" sceneId="moving-button" elevation={8 - 6 * p}
      thickness={3 - 2 * p} bevelWidth={4} material="button" aria-pressed={p === 1}
      style={{ position: "absolute", left: 24, top: 64, width: 112, height: 48, borderRadius: 12 }}>Press</Surface>
  </Ukibori>;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const end = performance.now() + 20000;
  while (!check()) { if (errors.length) throw new Error(errors.join("; ")); if (performance.now() > end) throw new Error("fixture timeout"); await pause(2); }
}
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, median: sorted[Math.floor(sorted.length / 2)] ?? null, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null };
}
async function run() {
  await document.fonts.ready;
  const cases = [];
  for (const effects of [false, true]) {
    flushSync(() => root.render(<Fixture p={0} effects={effects} />));
    await until(() => layer !== null && layer.debugState().nodeCount === 3 && layer.debugState().dirtyCount === 0 && layer.debugState().gpuRenderSerial > 0);
    await pause(200);
    const rows = [];
    for (let i = 1; i <= warmup + samples; i++) {
      const active = layer!;
      const before = active.debugState();
      const start = performance.now();
      const p = progress[i % progress.length];
      flushSync(() => root.render(<Fixture p={p} effects={effects} />));
      await until(() => active.debugState().gpuRenderSerial > before.gpuRenderSerial);
      const state = active.debugState(), gpu = state.gpuFrame!;
      const timing = await gpu.frame.gpuTiming;
      const completed = performance.now() - start;
      if (i > warmup) rows.push({ p, domMeasureHostMs: state.measureSerial > before.measureSerial ? state.lastMeasureMs : 0,
        sceneBuildHostMs: state.sceneBuildSerial > before.sceneBuildSerial ? state.lastSceneBuildMs : 0,
        renderHostMs: state.lastRenderMs, pipelineHostMs: gpu.frame.frame.hostMs,
        uploadHostMs: gpu.frame.frame.passDurations.upload, passHostMs: gpu.frame.frame.passDurations,
        gpuStatus: timing.status, passGpuMs: timing.passGpuMs, updateThroughGpuTimingReadbackWallMs: completed,
        maskSdfPasses: gpu.frame.height.maskSdfPasses, dispatchCount: gpu.frame.frame.dispatchCount,
        bytesUploaded: gpu.frame.frame.bytesUploaded, allocations: gpu.frame.frame.newAllocations });
    }
    await pause(200);
    const serial = layer!.debugState().gpuRenderSerial;
    await pause(150);
    const idle = serial === layer!.debugState().gpuRenderSerial;
    if (!idle) throw new Error("scene did not return to idle");
    const metrics: Record<string, unknown> = {};
    for (const key of ["domMeasureHostMs", "sceneBuildHostMs", "renderHostMs", "pipelineHostMs", "uploadHostMs", "updateThroughGpuTimingReadbackWallMs"] as const) metrics[key] = summary(rows.map(row => row[key]));
    for (const key of Object.keys(rows[0].passGpuMs)) metrics[`gpu.${key}`] = summary(rows.flatMap(row => {
      const value = row.passGpuMs[key as keyof typeof row.passGpuMs]; return typeof value === "number" ? [value] : [];
    }));
    cases.push({ effects, idle, metrics, rows });
  }
  const adapter = await navigator.gpu?.requestAdapter();
  const environment = { userAgent: navigator.userAgent, platform: navigator.platform, adapter: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description, device: adapter.info.device } : null, grainEnabled,
    devicePixelRatio: window.devicePixelRatio, dpr: 1, cssStage: [320, 180], margin: 8, font: "bold 16px Arial",
    shadow: { samples: 8, angularRadius: 0.12, maxDistance: 48, reconstructionRadius: 2 }, warmup, samples, progress,
    displayLatencyMs: null, note: "Wall time includes scheduler polling and benchmark timestamp readback; display latency is unmeasured. Production profiling is opt-in." };
  root.unmount();
  return { environment, cases, errors };
}
run().then(detail => { document.getElementById("result")!.textContent = `UKIBORI_DYNAMIC_SURFACES_PASS\n${JSON.stringify(detail, null, 2)}`; })
  .catch(error => { document.getElementById("result")!.textContent = `UKIBORI_DYNAMIC_SURFACES_FAIL\n${String(error?.stack ?? error)}`; });
