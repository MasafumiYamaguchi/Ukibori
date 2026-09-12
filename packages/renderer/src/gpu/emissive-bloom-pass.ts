import type { GpuComputeDeviceLike, GpuComputePipelineLike, GpuBindGroupLayoutLike } from './height-pass';
import type { GpuBufferLike } from './uploader';
const SHARED = /* wgsl */ `
struct Params { width:u32, height:u32, quality:u32, materialCount:u32,
 dpr:f32, exposure:f32, lightIntensity:f32, lightRadius:f32,
 bloomIntensity:f32, bloomRadius:f32, threshold:f32, shadowAlpha:f32,
 shadowR:f32, shadowG:f32, shadowB:f32, pad:f32 }
fn encode(x:f32)->f32{let v=clamp(x,0.0,1.0);if(v<=0.0031308){return 12.92*v;}return 1.055*pow(v,1.0/2.4)-0.055;}
fn decode(v:f32)->f32{if(v<=0.04045){return v/12.92;}return pow((v+0.055)/1.055,2.4);}
`;
const HORIZONTAL = SHARED + /* wgsl */ `
@group(0) @binding(0) var<storage,read> materialIds:array<u32>;
@group(0) @binding(1) var<storage,read> materials:array<f32>;
@group(0) @binding(2) var<storage,read_write> output:array<vec4<f32>>;
@group(0) @binding(3) var<uniform> p:Params;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=p.width||id.y>=p.height){return;}
 let radius=p.bloomRadius*p.dpr;let count=i32(ceil(radius));var total=0.0;var sum=vec3<f32>(0.0);
 for(var k=-count;k<=count;k++){
  let t=f32(k)/radius;let w=exp(-4.5*t*t);total+=w;
  let x=i32(id.x)+k;if(x<0||x>=i32(p.width)){continue;}
  let m=materialIds[id.y*p.width+u32(x)];if(m>=p.materialCount){continue;}
  let a=m*16u+8u;let rgb=min(vec3<f32>(materials[a],materials[a+1u],materials[a+2u]),vec3<f32>(65504.0))*p.exposure;
  let peak=max(rgb.r,max(rgb.g,rgb.b));if(peak>0.0){sum+=rgb*(max(0.0,peak-p.threshold)/peak)*w;}
 }
 output[id.y*p.width+id.x]=vec4<f32>(sum/total,0.0);
}
`;
const VERTICAL = SHARED + /* wgsl */ `
@group(0) @binding(0) var<storage,read> horizontal:array<vec4<f32>>;
@group(0) @binding(1) var<storage,read> colors:array<u32>;
@group(0) @binding(2) var<storage,read> owners:array<u32>;
@group(0) @binding(3) var<storage,read> visibility:array<f32>;
@group(0) @binding(4) var<storage,read_write> output:array<u32>;
@group(0) @binding(5) var<uniform> p:Params;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=p.width||id.y>=p.height){return;}
 let radius=p.bloomRadius*p.dpr;let count=i32(ceil(radius));var total=0.0;var sum=vec3<f32>(0.0);
 for(var k=-count;k<=count;k++){
  let t=f32(k)/radius;let w=exp(-4.5*t*t);total+=w;
  let y=i32(id.y)+k;if(y<0||y>=i32(p.height)){continue;}
  sum+=horizontal[u32(y)*p.width+id.x].rgb*w;
 }
 let g=id.y*p.width+id.x;let raw=unpack4x8unorm(colors[g]);let glow=sum/total*p.bloomIntensity;
 var rgb=vec3<f32>(0.0);var alpha=1.0;
 if(owners[g]!=0xffffffffu){rgb=vec3<f32>(encode(decode(raw.r)+glow.r),encode(decode(raw.g)+glow.g),encode(decode(raw.b)+glow.b));}
 else{
  let a0=p.shadowAlpha*(1.0-clamp(visibility[g],0.0,1.0));let shadow=vec3<f32>(p.shadowR,p.shadowG,p.shadowB)*a0;
  let spill=max(vec3<f32>(0.0),raw.rgb-shadow);
  rgb=min(vec3<f32>(1.0),shadow+vec3<f32>(encode(decode(spill.r)+glow.r),encode(decode(spill.g)+glow.g),encode(decode(spill.b)+glow.b)));
  alpha=max(a0,max(rgb.r,max(rgb.g,rgb.b)));
 }
 let bytes=vec4<u32>(floor(clamp(vec4<f32>(rgb,alpha),vec4<f32>(0.0),vec4<f32>(1.0))*255.0+vec4<f32>(0.5)));
 output[g]=bytes.r|(bytes.g<<8u)|(bytes.b<<16u)|(bytes.a<<24u);
}
`;
/** Full-resolution separable Gaussian: no sparse-grid bands around silhouettes. */
export class EmissiveBloomPass {
  private horizontal: GpuBufferLike | null = null;
  private output: GpuBufferLike | null = null;
  private params: GpuBufferLike | null = null;
  private pipelines: Array<{
    pipeline: GpuComputePipelineLike;
    layout: GpuBindGroupLayoutLike;
  }> = [];
  constructor(private readonly device: GpuComputeDeviceLike) { }
  dispatch(inputs: readonly GpuBufferLike[], width: number, height: number, params: Uint8Array) {
    const bytes = width * height * 4;
    if (bytes * 4 > this.device.limits.maxStorageBufferBindingSize || bytes * 4 > (this.device.limits.maxBufferSize ?? Infinity))
      throw new RangeError('bloom intermediate exceeds device limits');
    let newAllocations = 0;
    if (!this.horizontal || this.horizontal.size < bytes * 4) {
      this.horizontal?.destroy();
      this.output?.destroy();
      this.horizontal = this.device.createBuffer({ size: bytes * 4, usage: 128 });
      this.output = this.device.createBuffer({ size: bytes, usage: 140 });
      newAllocations += 2;
    }
    if (!this.params) {
      this.params = this.device.createBuffer({ size: 64, usage: 72 });
      newAllocations++;
    }
    this.device.queue.writeBuffer(this.params, 0, params);
    if (!this.pipelines.length)
      this.pipelines = [HORIZONTAL, VERTICAL].map((code, index) => {
        const outputBinding = index === 0 ? 2 : 4;
        const layout = this.device.createBindGroupLayout({ entries: Array.from({ length: outputBinding + 2 }, (_, binding) => ({ binding, visibility: 4, buffer: { type: binding > outputBinding ? 'uniform' as const : binding === outputBinding ? 'storage' as const : 'read-only-storage' as const } })) });
        const pipeline = this.device.createComputePipeline({ layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' } });
        return { pipeline, layout };
      });
    const stages = [[inputs[2], inputs[5], this.horizontal, this.params], [this.horizontal, inputs[0], inputs[1], inputs[6], this.output!, this.params]];
    const encoder = this.device.createCommandEncoder();
    stages.forEach((buffers, i) => {
      const { pipeline, layout } = this.pipelines[i];
      const group = this.device.createBindGroup({ layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
    });
    this.device.queue.submit([encoder.finish()]);
    return { buffer: this.output!, newAllocations, byteLength: bytes };
  }
  dispose() { this.horizontal?.destroy(); this.output?.destroy(); this.params?.destroy(); this.horizontal = this.output = this.params = null; this.pipelines = []; }
}
