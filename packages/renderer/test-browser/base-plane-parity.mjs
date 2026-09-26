// #75 deterministic CPU/WebGPU receiver parity. All readbacks are TEST ONLY.
export function basePlaneFixture(api, { background = 0.32, emission = 6, soft = false, short = false, receiver = true } = {}) {
  const surface = (id, x, y, w, h, z, material) => ({ id, position: { x, y }, size: { x: w, y: h }, elevation: z, thickness: 0,
    shape: { kind: 'roundedRect', radius: 0 }, profile: { kind: 'flat' }, material, castsShadow: true, receivesShadow: true });
  const basePlane = { baseColor: { r: background, g: background, b: background } };
  const scene = api.createScene({ width: 96, height: 64,
    light: { direction: { x: -1, y: -0.15, z: short ? 1 : 0.2 }, intensity: 2, angularRadius: soft ? 0.08 : 0 },
    environment: { intensity: 0.15 },
    materials: { floor: api.basePlaneMaterial(basePlane), blocker: { baseColor: { r: 0.12, g: 0.16, b: 0.2 }, roughness: 0.6, metallic: 0 },
      led: { baseColor: { r: 0.02, g: 0.02, b: 0.02 }, roughness: 0.9, metallic: 0, emissive: { r: emission * 0.05, g: emission * 0.55, b: emission } } },
    surfaces: [...(receiver ? [surface('receiver', 0, 42, 96, 22, 0, 'floor')] : []),
      surface('blocker', 27, 16, 6, 30, 12, 'blocker'), surface('led', 65, 26, 12, 12, 4, 'led')] });
  return { scene, basePlane };
}

export async function runBasePlaneParity(api, device) {
  const assert = (ok, message) => { if (!ok) throw new Error(`#75 ${message}`); };
  const canvas = { width: 96, height: 64 };
  let texture;
  const context = { canvas, configure() {}, unconfigure() {}, getCurrentTexture() {
    texture?.destroy(); texture = device.createTexture({ size: [canvas.width, canvas.height], format: 'rgba8unorm', usage: 17 }); return texture;
  } };
  const pipeline = new api.GpuScenePipeline(device, context, 'rgba8unorm');
  async function read(binding, Type) {
    const buffer = device.createBuffer({ size: binding.byteLength, usage: 9 });
    try {
      const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(binding.buffer, 0, buffer, 0, binding.byteLength); device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(1); const result = new Type(buffer.getMappedRange().slice(0)); buffer.unmap(); return result;
    } finally { buffer.destroy(); }
  }
  async function image() {
    const stride = Math.ceil(canvas.width * 4 / 256) * 256;
    const buffer = device.createBuffer({ size: stride * canvas.height, usage: 9 });
    try {
      const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [canvas.width, canvas.height]); device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(1); const mapped = new Uint8Array(buffer.getMappedRange()), result = new Uint8Array(canvas.width * canvas.height * 4);
      for (let y = 0; y < canvas.height; y++) result.set(mapped.subarray(y * stride, y * stride + canvas.width * 4), y * canvas.width * 4);
      buffer.unmap(); return result;
    } finally { buffer.destroy(); }
  }
  async function fields() {
    const s = pipeline.getSnapshot();
    const host = async (binding, format, channels, Type) => { const f = new api.HostBuffer({ width: s.width, height: s.height, format, channels }); f.data.set(await read(binding, Type)); return f; };
    return {
      height: await host(api.normalHeightBindingFromHeightPass(s.heightPass), 'f32', 1, Float32Array),
      objectId: await host(api.presentationObjectIdBindingFromHeightPass(s.heightPass), 'u32', 1, Uint32Array),
      normal: await host(api.lightingNormalBindingFromNormalPass(s.normalPass), 'f32', 3, Float32Array),
      visibility: await host(s.reconstructionPass ? api.lightingVisibilityBindingFromReconstructionPass(s.reconstructionPass) : api.lightingVisibilityBindingFromShadowPass(s.shadowPass), 'f32', 1, Float32Array),
    };
  }
  let fixtures = 0, comparedBytes = 0, maxByteError = 0, shadowedLitPixels = 0;
  const compare = (actual, expected, label, tolerance = 1) => {
    assert(actual.length === expected.length, `${label}: length mismatch`);
    for (let i = 0; i < actual.length; i++) {
      const delta = Math.abs(actual[i] - expected[i]); maxByteError = Math.max(maxByteError, delta);
      assert(delta <= (i % 4 === 3 ? 0 : tolerance), `${label}: byte ${i}, CPU ${expected[i]}, GPU ${actual[i]}, delta ${delta}`);
    }
    comparedBytes += actual.length;
  };
  device.pushErrorScope('validation');
  try {
    for (const dpr of [1, 1.5, 2]) for (const background of [0.025, 0.55]) for (const mode of ['hard', 'soft', 'reconstructed']) {
      let visibilityOff, imageOff;
      for (const emission of [0, 6]) for (const bloom of [false, true]) {
        const { scene, basePlane } = basePlaneFixture(api, { background, emission, soft: mode !== 'hard' });
        const emissive = { illumination: { radius: 40, intensity: 2 }, ...(bloom ? { bloom: { radius: 8, intensity: 0.5 } } : {}), quality: 4 };
        const input = { scene, dpr, compositeOptions: { basePlane, emissive }, shadowOptions: { samples: 8, reconstruction: { enabled: mode === 'reconstructed' } } };
        pipeline.render(input);
        const f = await fields(), color = api.shadePreparedFields(scene, f, { basePlane }).color;
        const actual = await image(), expected = api.renderEmissiveEffects(scene, { ...f, color }, api.sanitizeEmissiveEffects(emissive), undefined, undefined, dpr, basePlane);
        compare(actual, expected, `${mode}/${dpr}/${background}/${emission}/${bloom}`);
        if (emission === 0 && !bloom) { visibilityOff = f.visibility.data.slice(); imageOff = actual; }
        assert(f.visibility.data.every((v, i) => v === visibilityOff[i]), 'emission/bloom changed visibility');
        if (emission > 0 && !bloom) {
          const lifted = f.visibility.data.reduce((n, v, i) => n + (v < 0.5 && f.objectId.data[i] === api.NO_OWNER && actual[i * 4 + 2] > imageOff[i * 4 + 2] + 2 ? 1 : 0), 0);
          assert(lifted > 0, 'no shadowed base pixels received emission with bloom off'); shadowedLitPixels += lifted;
        }
        fixtures++;
      }
    }
    // No-effects presentation + short/long shadow fixture (A/B); no alpha tint.
    for (const short of [true, false]) {
      const { scene, basePlane } = basePlaneFixture(api, { short, emission: 0 });
      pipeline.render({ scene, dpr: 1, compositeOptions: { basePlane, shadowColor: [255, 0, 255], shadowAlpha: 1 } });
      const f = await fields(), expected = api.shadePreparedFields(scene, f, { basePlane }).color.data;
      compare(await image(), expected, `no-effects/short=${short}`); fixtures++;
    }
    // Retention must equal a full recompute after each semantic edit.
    const { scene, basePlane } = basePlaneFixture(api);
    scene.height = 192;
    const input = { scene, dpr: 1, compositeOptions: { basePlane, emissive: { illumination: { radius: 40, intensity: 2 } } }, shadowOptions: { reconstruction: { enabled: false } }, tileSize: 8 };
    pipeline.render(input); const initial = await image();
    const staticFrame = pipeline.render(input);
    assert(staticFrame.invalidation.executed.length === 0, 'static frame executed work');
    pipeline.present(); compare(await image(), initial, 'retained present', 0);
    const updates = [];
    for (const kind of ['base-color', 'emission', 'light', 'geometry', 'geometry+base-color', 'disable-effects', 'disable-floor']) {
      if (kind.includes('base-color')) input.compositeOptions.basePlane = { baseColor: { r: 0.4, g: kind === 'base-color' ? 0.3 : 0.2, b: 0.1 } };
      if (kind === 'emission') scene.materials.led.emissive.b = 12;
      if (kind === 'light') scene.light.intensity = 3;
      if (kind.includes('geometry')) scene.surfaces[2].position.x -= 2;
      if (kind === 'disable-effects') delete input.compositeOptions.emissive;
      if (kind === 'disable-floor') delete input.compositeOptions.basePlane;
      const stats = pipeline.render(input), retained = await image();
      pipeline.render({ ...input, debugForceFull: true }); compare(await image(), retained, `${kind}/full`, 0);
      if (kind === 'base-color') assert(stats.invalidation.executed.join(',') === 'lighting,presentation', 'floor edit invalidated geometry/shadows');
      if (kind === 'emission' || kind === 'light') assert(stats.invalidation.executed.join(',') === 'upload,lighting,presentation', `${kind} invalidated geometry/shadows`);
      if (kind === 'geometry') assert(stats.planning.mode === 'partial', 'geometry edit did not exercise partial update');
      if (kind === 'geometry+base-color') assert(stats.planning.mode === 'full', 'global floor change incorrectly used partial lighting');
      updates.push({ kind, executed: stats.invalidation.executed, mode: stats.planning.mode, dispatches: stats.frame.dispatchCount });
    }
    return { fixtures, comparedBytes, maxByteError, tolerance: 1, exactAlpha: true, shadowedLitPixels, staticDispatches: staticFrame.frame.dispatchCount, updates };
  } finally {
    pipeline.dispose(); texture?.destroy();
    const error = await device.popErrorScope(); if (error) throw new Error(error.message);
  }
}
