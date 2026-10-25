import { createOracle } from './oracle.mjs';

/** Test-only readbacks. Production retains all fields and never maps them. */
export async function runDynamicMaterialParity(api, device) {
  const oracle = createOracle(api);
  const canvas = document.createElement('canvas');
  const pipeline = new api.GpuScenePipeline(device, canvas.getContext('webgpu'), navigator.gpu.getPreferredCanvasFormat());
  const failures = [], rows = [];
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
  const make = (p = 0, grain, dx = 0, width = 36, surfaceSize = 16) => api.createScene({ width, height: 28,
    surfaces: [{ ...base, position: { x: 4 + dx, y: 4 }, size: { x: surfaceSize, y: surfaceSize }, elevation: 8 - 6 * p, thickness: 3 - 2 * p },
      { ...base, id: 'mask', position: { x: 24, y: 4 }, size: { x: 8, y: 8 }, elevation: 3, shape: { kind: 'mask', mask } }],
    materials: { resin: { baseColor: { r: 0.3, g: 0.35, b: 0.4 }, roughness: 0.4, metallic: 0, grain } },
    light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 }, environment: { intensity: 0.15 } });
  device.pushErrorScope('validation');
  try {
    for (const dpr of [0.75, 1, 1.5, 2]) {
      let stable = make(0);
      pipeline.render({ scene: stable, dpr }); const unchanged = await fields();
      for (const grain of [{ scale: 4, strength: 0.5, seed: 42 }, { scale: 3, strength: 0.7, seed: 43 }, { scale: 0.25, strength: 1, seed: 42 }, { scale: 4, strength: 0, seed: 42 }, undefined]) {
        const scene = make(0, grain), frame = pipeline.render({ scene, dpr });
        check(frame.height.composePasses === 0 && frame.shadow.submissions === 0, 'R3 material-only invalidated geometry/shadow');
        await device.queue.onSubmittedWorkDone();
        const validationError = await device.popErrorScope(); device.pushErrorScope("validation");
        check(!validationError, validationError?.message);
        const result = await fields(), s = pipeline.getSnapshot();
        for (const key of ['height', 'caster', 'owners', 'normal', 'visibility']) compare(result[key], unchanged[key], 0, `R3 preserved ${key}`);
        const expected = oracle.lightingOracleCPU(scene, s.width, s.height, result.normal, result.owners, result.visibility, { dpr });
        compare(result.color, expected.color, 1, `R3 CPU/GPU RGBA8 (<=1 byte), DPR=${dpr}, grain=${JSON.stringify(grain)}`);
        if (!grain || grain.strength === 0 || grain.scale * dpr <= 1) compare(result.color, unchanged.color, 0, 'R3 disabled/unresolved grain matches default output');
        else if (grain.scale * dpr >= 4) check(result.color.some((value, i) => value !== unchanged.color[i]), 'R3 resolved grain has no visible samples');
        pipeline.render({ scene, dpr, debugForceFull: true });
        const full = await fields();
        for (const key of Object.keys(result)) compare(result[key], full[key], 0, `R3 retained/full ${key}`);
        rows.push({ dpr, grain: grain ?? null, allocations: frame.lighting.totalAllocationBytes, dispatchCount: frame.frame.dispatchCount });
        check(pipeline.render({ scene, dpr }).frame.dispatchCount === 0, 'R3 idle dispatched');
      }
    }
    // Surface-local translation, shared material, and resized target at DPR 1.
    const grain = { scale: 4, strength: 0.7, seed: 42 };
    pipeline.render({ scene: make(0, grain), dpr: 1 }); const a = await fields();
    pipeline.render({ scene: make(0, { ...grain, seed: 43 }), dpr: 1 });
    pipeline.render({ scene: make(0, grain), dpr: 1 }); const repeated = await fields();
    compare(repeated.color, a.color, 0, 'same seed reproduces GPU pixels exactly');
    pipeline.render({ scene: make(0, grain, 0, 36, 20), dpr: 1 }); const resized = await fields();
    for (let y = 7; y < 16; y++) for (let x = 7; x < 16; x++) {
      const offset = (y * 36 + x) * 4;
      compare(a.color.subarray(offset, offset + 4), resized.color.subarray(offset, offset + 4), 1, 'surface resize preserves local grain scale');
    }
    pipeline.render({ scene: make(0, grain, 2, 40), dpr: 1 }); const b = await fields();
    for (let y = 7; y < 17; y++) for (let x = 7; x < 17; x++) {
      for (let c = 0; c < 4; c++) compare([a.color[(y * 36 + x) * 4 + c]], [b.color[(y * 40 + x + 2) * 4 + c]], 1, 'translated grain');
    }
  } finally { pipeline.dispose(); }
  const error = await device.popErrorScope(); check(!error, error?.message);
  return { rows, failures, repeatedSeedExact: true, surfaceResize: true, translatedAndTargetResized: true, parity: 'grain color <=1 RGBA8 byte; geometry and shadow retained exactly' };
}
