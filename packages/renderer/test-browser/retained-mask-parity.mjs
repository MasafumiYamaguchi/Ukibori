import { createOracle } from './oracle.mjs';

/** Test-only readbacks. Production retains all fields and never maps them. */
export async function runRetainedMaskParity(api, device) {
  const oracle = createOracle(api);
  const canvas = document.createElement('canvas');
  const pipeline = new api.GpuScenePipeline(device, canvas.getContext('webgpu'), navigator.gpu.getPreferredCanvasFormat());

  const check = (ok, message) => { if (!ok) throw new Error(message); };
  async function read(output, Type) {
    const staging = device.createBuffer({ size: output.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(output.buffer, 0, staging, 0, output.byteLength); device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ); const values = new Type(staging.getMappedRange().slice(0)); staging.unmap(); return values;
    } finally { staging.destroy(); }
  }
  async function fields() {
    const s = pipeline.getSnapshot();
    return { height: await read(s.heightPass.outputs.height, Float32Array), caster: await read(s.heightPass.outputs.casterHeight, Float32Array),
      owners: await read(s.heightPass.outputs.objectId, Uint32Array), normal: await read(s.normalPass.output, Float32Array),
      visibility: await read(s.reconstructionPass?.output ?? s.shadowPass.output, Float32Array), color: await read(s.lightingPass.color, Uint8Array) };
  }
  function compare(a, b, tol, label) { check(a.length === b.length, `${label} extent`); for (let i = 0; i < a.length; i++) check(Math.abs(a[i] - b[i]) <= tol, `${label}[${i}]: ${a[i]} vs ${b[i]}`); }
  const mask = { width: 4, height: 4, alpha: new Uint8Array([0,255,255,0,255,0,255,255,255,255,0,255,0,255,255,0]) };
  const base = { id: 'button', position: { x: 4, y: 4 }, size: { x: 16, y: 16 }, elevation: 4, thickness: 2, bevelWidth: 2,
    shape: { kind: 'roundedRect', radius: 3 }, profile: { kind: 'smooth' }, material: 'resin', castsShadow: true, receivesShadow: true };
  const make = (p = 0) => api.createScene({ width: 36, height: 28,
    surfaces: [{ ...base, position: { x: 4, y: 4 }, elevation: 8 - 6 * p, thickness: 3 - 2 * p },
      { ...base, id: 'mask', position: { x: 24, y: 4 }, size: { x: 8, y: 8 }, elevation: 3, shape: { kind: 'mask', mask } }],
    materials: { resin: { baseColor: { r: 0.3, g: 0.35, b: 0.4 }, roughness: 0.4, metallic: 0 } },
    light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 }, environment: { intensity: 0.15 } });
  device.pushErrorScope('validation');
  try {
    for (const dpr of [0.75, 1, 1.5, 2]) {
      pipeline.render({ scene: make(), dpr });
      for (const p of [0.125, 0.375, 0.625, 0.875, 1, 0]) {
        const scene = make(p), frame = pipeline.render({ scene, dpr });
        check(frame.height.maskSdfPasses === 0, 'R1 elevation re-ran SDF');
        const retained = await fields();
        const expected = oracle.cpuOracle(scene, dpr);
        compare(retained.height, expected.height, 1e-4, 'CPU height');
        compare(retained.owners, expected.objectId, 0, 'CPU owners');
        const full = pipeline.render({ scene, dpr, debugForceFull: true });
        check(full.height.maskSdfPasses === 1, 'forced full did not regenerate SDF');
        const rebuilt = await fields();
        for (const key of Object.keys(retained)) compare(retained[key], rebuilt[key], 0, `R1 forced-full ${key}`);
      }
      const original = make(0), glyph = original.surfaces[1];
      const otherMask = { width: 4, height: 4, alpha: new Uint8Array(mask.alpha.map(v => v ? 0 : 255)) };
      const second = { ...glyph, id: "second-mask", shape: { kind: "mask", mask: otherMask } };
      const large = { ...glyph, shape: { kind: "mask", mask: { width: 8, height: 8, alpha: new Uint8Array(64).fill(255) } } };
      const floating = { ...glyph, shape: { kind: "mask", mask: { width: 4, height: 4, alpha: new Float32Array([...mask.alpha].map(v => v / 255)) } } };
      for (const surfaces of [[original.surfaces[0], glyph, second], [original.surfaces[0], second, glyph],
        [original.surfaces[0], large], [original.surfaces[0], floating], [original.surfaces[0]], original.surfaces]) {
        const scene = api.createScene({ ...original, surfaces });
        const frame = pipeline.render({ scene, dpr });
        const expectedPasses = surfaces.some(s => s.shape.kind === "mask") ? 1 : 0;
        check(frame.height.maskSdfPasses === expectedPasses, 'R1 mask mutation did not invalidate');
        const retained = await fields(), cpu = oracle.cpuOracle(scene, dpr);
        compare(retained.height, cpu.height, 1e-4, 'R1 changed-mask CPU height');
        pipeline.render({ scene, dpr, debugForceFull: true });
        const rebuilt = await fields();
        for (const key of Object.keys(retained)) compare(retained[key], rebuilt[key], 0, `R1 changed-mask full ${key}`);
      }
    }
  } finally { pipeline.dispose(); }
  const error = await device.popErrorScope(); check(!error, error?.message);
  // Device loss has an explicit recovery contract: a new device/pipeline,
  // never reuse resources from the lost one.
  const adapter = await navigator.gpu.requestAdapter();
  const lostDevice = await adapter.requestDevice();
  const makePipeline = d => new api.GpuScenePipeline(d, document.createElement('canvas').getContext('webgpu'), navigator.gpu.getPreferredCanvasFormat());
  const lostPipeline = makePipeline(lostDevice);
  check(lostPipeline.render({ scene: make(), dpr: 1 }).height.maskSdfPasses === 1, 'new device missed SDF');
  await lostDevice.queue.onSubmittedWorkDone();
  lostDevice.destroy(); await lostDevice.lost; await Promise.resolve();
  let rejected = false;
  try { lostPipeline.render({ scene: make(0.5), dpr: 1 }); } catch { rejected = true; }
  check(rejected, 'lost pipeline accepted stale resources'); lostPipeline.dispose();
  const freshAdapter = await navigator.gpu.requestAdapter();
  const freshDevice = await freshAdapter.requestDevice(), freshPipeline = makePipeline(freshDevice);
  freshDevice.pushErrorScope('validation');
  try {
    check(freshPipeline.render({ scene: make(), dpr: 1 }).height.maskSdfPasses === 1, 'recovery reused stale SDF');
    check(freshPipeline.render({ scene: make(0.5), dpr: 1 }).height.maskSdfPasses === 0, 'recovery did not retain SDF');
    await freshDevice.queue.onSubmittedWorkDone();
    const error = await freshDevice.popErrorScope(); check(!error, error?.message);
  } finally { freshPipeline.dispose(); freshDevice.destroy(); }
  return { deviceLossRecovery: true, intermediateFixtures: 24, maskMutationFixtures: 24, parity: 'forced full exact; CPU height 1e-4' };
}
