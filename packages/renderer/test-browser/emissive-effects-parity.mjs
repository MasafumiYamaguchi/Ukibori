/** Real adapter comparison against CPU effects using GPU geometry inputs. */
export async function runEmissiveEffectsParity(api, device) {
  const uploader = new api.SceneUploader(device);
  const height = new api.HeightPass(device), normal = new api.NormalPass(device);
  const shadow = new api.ShadowPass(device), lighting = new api.LightingPass(device);
  const effects = new api.EmissiveEffectsPass(device);
  let fixtures = 0, comparedBytes = 0, maxByteError = 0;
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
  const surface = (id, x, y, w, h, elevation, material) => ({ id, position:{x,y}, size:{x:w,y:h}, elevation, thickness:0,
    shape:{kind:'roundedRect',radius:0}, profile:{kind:'flat'}, material, castsShadow:true, receivesShadow:true });
  device.pushErrorScope('validation');
  try {
    for (const blocked of [false,true]) for (const dpr of [1,1.5,2]) for (const exposure of [0,1]) {
      const scene = api.createScene({ width:48,height:24,exposure,
        surfaces:[surface('receiver',3,4,14,16,1,'receiver'),surface('led',24,6,8,12,4,'led'),...(blocked?[surface('wall',20,0,2,24,20,'receiver')]:[])],
        materials:{receiver:{baseColor:{r:0.6,g:0.4,b:0.2},roughness:1,metallic:0},led:{baseColor:{r:0,g:0,b:0},roughness:1,metallic:0,emissive:{r:4,g:0.5,b:0.1}}},
        light:{direction:{x:0,y:0,z:1},intensity:0,color:{r:1,g:1,b:1}},environment:{intensity:0} });
      const encoded=api.encodeScene(scene,dpr);uploader.upload(encoded);const bindings=uploader.getBindings();
      height.dispatch(encoded,bindings);const hp=height.getSnapshot();
      normal.dispatch({height:api.normalHeightBindingFromHeightPass(hp)});
      shadow.dispatch({scene:encoded,bindings,...api.shadowHeightBindingsFromHeightPass(hp)});
      const np=normal.getSnapshot(),sp=shadow.getSnapshot();
      lighting.dispatch({scene:encoded,bindings,materialId:api.lightingMaterialIdBindingFromHeightPass(hp),normal:api.lightingNormalBindingFromNormalPass(np),visibility:api.lightingVisibilityBindingFromShadowPass(sp),options:{ambient:0}});
      const lp=lighting.getSnapshot(),ho=height.getOutputs();
      const field=async(output,format,channels,Type)=>{const f=new api.HostBuffer({width:hp.width,height:hp.height,format,channels});f.data.set(await read(output,Type));return f;};
      const fields={color:await field(lp.color,'u8',4,Uint8Array),height:await field(ho.height,'f32',1,Float32Array),objectId:await field(ho.objectId,'u32',1,Uint32Array),normal:await field(np.output,'f32',3,Float32Array),visibility:await field(sp.output,'f32',1,Float32Array)};
      for(const options of [{bloom:{radius:12,threshold:1}},{illumination:{radius:24,intensity:2}},{bloom:{radius:12,threshold:1},illumination:{radius:24,intensity:2}},{bloom:{radius:12,threshold:8}},{bloom:{radius:12.5,threshold:0.5},illumination:{radius:25,intensity:2},quality:6},{illumination:{radius:24,intensity:1},quality:2}]){
        const e=api.sanitizeEmissiveEffects(options);
        const output=effects.dispatch([lp.color.buffer,ho.objectId.buffer,ho.materialId.buffer,ho.height.buffer,np.output.buffer,bindings.materials.buffer,sp.output.buffer],hp.width,hp.height,api.parseHeader(encoded.bytes).materialCount,dpr,exposure,e,[12,16,28],0.3);
        const actual=await read(output,Uint8Array),expected=api.renderEmissiveEffects(scene,fields,e,[12,16,28],0.3,dpr);
        for(let i=0;i<actual.length;i++){
          const error=Math.abs(actual[i]-expected[i]);maxByteError=Math.max(maxByteError,error);
          if(error>1)throw new Error(`blocked=${blocked}, dpr=${dpr}, exposure=${exposure}, ${JSON.stringify(options)} byte ${i}: CPU=${expected[i]}, GPU=${actual[i]}`);
          if(i%4!==3&&actual[i]>actual[i-i%4+3])throw new Error('invalid premultiplied output');
        }
        comparedBytes+=actual.length;fixtures++;
      }
    }

    // Exercise the actual pipeline and fragment presentation, including retention.
    const canvas = { width: 16, height: 8 };
    let texture;
    const context = { canvas, configure() {}, unconfigure() {}, getCurrentTexture() {
      texture?.destroy();
      texture = device.createTexture({ size: [canvas.width, canvas.height], format: 'rgba8unorm', usage: 17 });
      return texture;
    } };
    const pipeline = new api.GpuScenePipeline(device, context, 'rgba8unorm');
    async function image() {
      const staging = device.createBuffer({ size: 256 * canvas.height, usage: 9 });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: 256 }, [canvas.width, canvas.height]);
        device.queue.submit([encoder.finish()]); await staging.mapAsync(1);
        const mapped = new Uint8Array(staging.getMappedRange()), pixels = new Uint8Array(canvas.width * canvas.height * 4);
        for (let y = 0; y < canvas.height; y++) pixels.set(mapped.subarray(y * 256, y * 256 + canvas.width * 4), y * canvas.width * 4);
        staging.unmap(); return pixels;
      } finally { staging.destroy(); }
    }
    try {
      const scene = api.createScene({ width: 16, height: 8, surfaces: [surface('led', 4, 2, 4, 4, 2, 'led')],
        materials: { led: { baseColor: { r: 0, g: 0, b: 0 }, roughness: 1, metallic: 0, emissive: { r: 4, g: 0, b: 0 } } },
        light: { direction: { x: 0, y: 0, z: 1 }, intensity: 0, color: { r: 1, g: 1, b: 1 } }, environment: { intensity: 0 } });
      const compositeOptions = { emissive: { bloom: { radius: 4, threshold: 1 } } };
      pipeline.render({ scene, dpr: 1 }); const disabled = await image();
      const enabled = pipeline.render({ scene, dpr: 1, compositeOptions }); const glowing = await image();
      if (enabled.invalidation.executed.join(',') !== 'presentation') throw new Error('controls invalidated geometry');
      const halo = (4 * 16 + 9) * 4;
      if (!(glowing[halo] > disabled[halo] && glowing[halo + 3] > 0)) throw new Error('pipeline did not present bloom halo');
      pipeline.present(); const retained = await image();
      if (retained.some((v, i) => v !== glowing[i])) throw new Error('retained presentation lost effects');
      scene.materials.led.emissive.r = 0;
      const edited = pipeline.render({ scene, dpr: 1, compositeOptions }); const dark = await image();
      if (edited.invalidation.executed.join(',') !== 'upload,lighting,presentation' || dark[halo] !== 0) throw new Error('emitter edit retained stale bloom');
      pipeline.render({ scene, dpr: 1 }); const cleared = await image();
      if (cleared[halo] !== 0 || cleared[halo + 3] !== 0) throw new Error('disabled presentation retained halo');
    } finally { pipeline.dispose(); texture?.destroy(); }
  } finally {effects.dispose();lighting.dispose();shadow.dispose();normal.dispose();height.dispose();uploader.dispose();}
  const error=await device.popErrorScope();if(error)throw new Error(error.message);
  return {fixtures,comparedBytes,maxByteError,tolerance:1,presentationTransitions:5};
}
