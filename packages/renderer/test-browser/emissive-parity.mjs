import { createOracle } from './oracle.mjs';

/** Real GPU lighting comparison, with controlled shadow visibility inputs. */
export async function runEmissiveParity(api, device) {
  const oracle = createOracle(api);
  const uploader = new api.SceneUploader(device);
  const height = new api.HeightPass(device), normal = new api.NormalPass(device);
  const shadow = new api.ShadowPass(device), lighting = new api.LightingPass(device);
  let fixtures = 0, comparedBytes = 0;
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
  const surface = { id: 'led', position:{x:0,y:0}, size:{x:8,y:8}, elevation:1, thickness:0,
    shape:{kind:'roundedRect',radius:0}, profile:{kind:'flat'}, material:'led', castsShadow:true, receivesShadow:true };
  device.pushErrorScope('validation');
  try {
    const cases = [0, 0.0031308, 0.25, 2, 3.4028234663852886e38].map(emission => ({ emission, lit: false }));
    cases.push({ emission: 0.25, lit: true }, { emission: 2, lit: true });
    for (const { emission, lit } of cases) {
      for (const exposure of [0, 0.125, 1]) for (const dpr of [1, 1.5, 2]) {
        const scene = api.createScene({ width:8, height:8, surfaces:[surface], exposure,
          materials:{led:{baseColor:lit?{r:0.25,g:0.5,b:0.75}:{r:0,g:0,b:0},roughness:lit?0.5:1,metallic:lit?0:1,emissive:{r:emission,g:emission * 0.25,b:0}}},
          light:{direction:{x:0,y:0,z:1},intensity:lit?0.5:0,color:{r:1,g:1,b:1}}, environment:{intensity:lit?0.25:0} });
        const encoded = api.encodeScene(scene,dpr); uploader.upload(encoded); const bindings = uploader.getBindings();
        height.dispatch(encoded,bindings); const hp = height.getSnapshot();
        normal.dispatch({height:api.normalHeightBindingFromHeightPass(hp)});
        shadow.dispatch({scene:encoded,bindings,...api.shadowHeightBindingsFromHeightPass(hp)});
        const np=normal.getSnapshot(), sp=shadow.getSnapshot();
        const normals=await read(np.output,Float32Array), owners=await read(height.getOutputs().objectId,Uint32Array);
        for (const visibility of [0,1]) {
          // Isolate emission from a completely occluded/unoccluded lighting input.
          const vis=new Float32Array(sp.output.byteLength / 4).fill(visibility);
          device.queue.writeBuffer(sp.output.buffer,0,vis);
          lighting.dispatch({scene:encoded,bindings,materialId:api.lightingMaterialIdBindingFromHeightPass(hp),
            normal:api.lightingNormalBindingFromNormalPass(np),visibility:api.lightingVisibilityBindingFromShadowPass(sp),options:{ambient:0}});
          const output=lighting.getSnapshot();
          const expected=oracle.lightingOracleCPU(scene,output.width,output.height,normals,owners,vis,{ambient:0});
          const actual=await read(output.color,Uint8Array);
          for(let i=0;i<actual.length;i++) if(actual[i]!==expected.color[i]) throw new Error(`lit=${lit}, emission=${emission}, exposure=${exposure}, DPR=${dpr}, visibility=${visibility}: byte ${i}, CPU=${expected.color[i]}, GPU=${actual[i]}`);
          comparedBytes+=actual.length; fixtures++;
        }
      }
    }
  } finally { lighting.dispose(); shadow.dispose(); normal.dispose(); height.dispose(); uploader.dispose(); }
  const error=await device.popErrorScope(); if(error) throw new Error(error.message);
  return { fixtures, comparedBytes, colorParity:'exact' };
}
