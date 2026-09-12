import { createOracle } from "./oracle.mjs";

/** Shared by real WebGPU browser/native runners; no mock or null backend. */
export async function runProfileParity(api, device, shapeOverrides) {
  const oracle = createOracle(api);
  const profiles = ["step", "linear", "smooth", "convex", "concave"].map((kind) => ({ kind }));
  for (const exponent of [0.5, 1.3, 2, 4]) for (const bias of ["in", "out"]) profiles.push({ kind: "power", exponent, bias });
  const mask = { width: 16, height: 16, alpha: new Uint8Array(256) };
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if ((x >= 4 && x < 12) || (y >= 4 && y < 12)) mask.alpha[y * 16 + x] = 255;
  }
  const base = { id: "base", position: { x: 0, y: 0 }, size: { x: 24, y: 24 }, elevation: 0, thickness: 10,
    bevelWidth: 0, shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "step" }, material: "matte", castsShadow: true, receivesShadow: true };
  const uploader = new api.SceneUploader(device);
  const heightPass = new api.HeightPass(device);
  const normalPass = new api.NormalPass(device);
  const shadowPass = new api.ShadowPass(device);
  let fixtures = 0;
  let shadowFixtures = 0;
  const maxima = { height: 0, casterHeight: 0, normal: 0, visibility: 0 };
  async function read(output, Type) {
    const staging = device.createBuffer({ size: output.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(output.buffer, 0, staging, 0, output.byteLength);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Type(staging.getMappedRange().slice(0)); staging.unmap(); return data;
    } finally { staging.destroy(); }
  }
  function compare(name, expected, actual, tolerance, label) {
    if (expected.length !== actual.length) throw new Error(`${label} ${name}: length mismatch`);
    for (let i = 0; i < expected.length; i++) {
      const delta = Math.abs(expected[i] - actual[i]);
      if (!Number.isFinite(delta) || delta > tolerance) throw new Error(`${label} ${name}[${i}]: CPU=${expected[i]} GPU=${actual[i]} delta=${delta}`);
      if (name in maxima) maxima[name] = Math.max(maxima[name], delta);
    }
  }
  device.pushErrorScope("validation");
  try {
    for (const profile of profiles) for (const mode of ["raised", "inset"]) for (const shape of (shapeOverrides ?? [{ kind: "roundedRect", radius: 2 }, { kind: "mask", mask }])) for (const dpr of [1, 1.5, 2]) {
      const cut = { ...base, id: "profile", position: { x: 4, y: 4 }, size: { x: 16, y: 16 }, elevation: 10, thickness: 8, bevelWidth: 4,
        shape, profile: { ...profile, mode }, material: "metal", castsShadow: mode === "raised" };
      const knob = { ...base, id: "knob", position: { x: 10, y: 10 }, size: { x: 4, y: 4 }, elevation: 2, thickness: 4 };
      const scene = api.createScene({ width: 24, height: 24, surfaces: [base, cut, knob], light: { direction: { x: -0.6, y: -0.4, z: 1 }, intensity: 1 } });
      const label = `${JSON.stringify(cut.profile)} ${shape.kind} DPR=${dpr}`;
      const encoded = api.encodeScene(scene, dpr);
      uploader.upload(encoded); const bindings = uploader.getBindings();
      heightPass.dispatch(encoded, bindings);
      const outputs = heightPass.getOutputs(), snapshot = heightPass.getSnapshot();
      const cpu = oracle.cpuOracle(scene, dpr), caster = oracle.cpuCasterOracle(scene, dpr);
      compare("height", cpu.height, await read(outputs.height, Float32Array), 1e-4, label);
      compare("casterHeight", caster.height, await read(outputs.casterHeight, Float32Array), 1e-4, label);
      compare("objectId", cpu.objectId, await read(outputs.objectId, Uint32Array), 0, label);
      compare("materialId", cpu.materialId, await read(outputs.materialId, Uint32Array), 0, label);
      compare("coverage", cpu.coverage, await read(outputs.coverage, Uint32Array), 0, label);
      normalPass.dispatch({ scene: encoded, bindings, height: api.normalHeightBindingFromHeightPass(snapshot) });
      const normal = oracle.normalOracle(cpu.height, cpu.rw, cpu.rh, api.sanitizeNormalOptions());
      compare("normal", normal, await read(normalPass.getSnapshot().output, Float32Array), 1e-4, label);
      // Exact binary visibility is only asserted on dedicated stable fixtures;
      // the curve/DPR matrix contains legitimate razor-edge shadow thresholds.
      if (profile.kind === "step" && shape.kind === "roundedRect" && dpr === 1) {
      shadowPass.dispatch({ scene: encoded, bindings, ...api.shadowHeightBindingsFromHeightPass(snapshot), options: { bias: 0.03125 } });
      const shadow = shadowPass.getSnapshot();
      let expectedVisibility;
      try { expectedVisibility = oracle.stableShadowOracle(scene, cpu.rw, cpu.rh, cpu.height, caster.height, cpu.objectId, dpr, shadow.options); }
      catch (error) { throw new Error(`${label}: ${error.message}`); }
      compare("visibility", expectedVisibility, await read(shadow.output, Float32Array), 0, label);
      shadowFixtures++;
      }
      fixtures++;
    }
  } finally {
    shadowPass.dispose(); normalPass.dispose(); heightPass.dispose(); uploader.dispose();
  }
  const validationError = await device.popErrorScope();
  if (validationError) throw new Error(validationError.message);
  return { fixtures, shadowFixtures, maxima };
}
