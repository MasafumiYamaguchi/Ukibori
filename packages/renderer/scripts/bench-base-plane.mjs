// Reproducible #75 same-extent comparison; excludes shader/pipeline warmup.
// UKIBORI_BASELINE_MODULE should point to a separately built master renderer.
import { writeFile } from 'node:fs/promises';
import { basePlaneFixture } from '../test-browser/base-plane-parity.mjs';
import * as current from '../dist/index.js';
const { create, globals } = await import(process.env.UKIBORI_WEBGPU_MODULE ?? 'webgpu');
Object.assign(globalThis, globals);
const gpu = create(['enable-dawn-features=allow_unsafe_apis']);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error('No real WebGPU adapter available');
const features = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
const device = await adapter.requestDevice({ requiredFeatures: features });
const baseline = process.env.UKIBORI_BASELINE_MODULE ? await import(process.env.UKIBORI_BASELINE_MODULE) : null;
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const results = [];
try {
  for (const [label, api, physical] of [...(baseline ? [['master', baseline, false]] : []), ['branch-legacy', current, false], ['physical-floor', current, true]]) {
    for (const update of ['full', 'static', 'light-only', 'emissive-only', 'partial-geometry']) {
      const factory = { ...api, basePlaneMaterial: current.basePlaneMaterial };
      const { scene, basePlane } = basePlaneFixture(factory); scene.width = 320; scene.height = 192;
      const canvas = { width: 320, height: 192 }; let texture;
      const context = { canvas, configure() {}, unconfigure() {}, getCurrentTexture() {
        if (!texture) texture = device.createTexture({ size: [320, 192], format: 'rgba8unorm', usage: 16 }); return texture;
      } };
      const pipeline = new api.GpuScenePipeline(device, context, 'rgba8unorm');
      const input = { scene, dpr: 1, tileSize: 8, compositeOptions: { ...(physical ? { basePlane } : {}), emissive: { illumination: { radius: 40, intensity: 2 }, bloom: { radius: 8, intensity: 0.5 } } }, shadowOptions: { samples: 8, reconstruction: { enabled: true } } };
      const host = [], completion = [], gpuMs = []; let final;
      try {
        pipeline.render(input); await device.queue.onSubmittedWorkDone();
        for (let i = 0; i < 11; i++) {
          if (update === 'light-only') scene.light.intensity = 1.5 + (i % 2);
          if (update === 'emissive-only') scene.materials.led.emissive.b = 6 + (i % 2);
          if (update === 'partial-geometry') scene.surfaces[2].position.x = 65 + (i % 2) * 2;
          const start = performance.now();
          final = pipeline.render({ ...input, debugForceFull: update === 'full' });
          const hostMs = performance.now() - start;
          await device.queue.onSubmittedWorkDone(); const done = performance.now() - start;
          const timing = await final.gpuTiming;
          if (i >= 3) { host.push(hostMs); completion.push(done); if (timing.totalGpuMs !== null) gpuMs.push(timing.totalGpuMs); }
        }
        results.push({ label, update, extent: [320, 192], samples: host.length, hostMedianMs: median(host), completionMedianMs: median(completion), gpuMedianMs: gpuMs.length ? median(gpuMs) : null,
          executed: final.invalidation.executed, planning: final.planning.mode, dispatches: final.frame.dispatchCount, submissions: final.frame.submissions, newAllocations: final.frame.newAllocations });
      } finally { pipeline.dispose(); texture?.destroy(); }
    }
  }
  const report = { adapter: adapter.info.description, timestampQuery: features.length > 0, note: 'Warm median of 8 samples; software adapters do not establish hardware GPU performance. Completion includes host submission and queued GPU work.', results };
  if (process.env.UKIBORI_BENCH_OUTPUT) await writeFile(process.env.UKIBORI_BENCH_OUTPUT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { device.destroy(); }
