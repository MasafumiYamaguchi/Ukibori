import { EmissiveBloomPass } from "./emissive-bloom-pass";
import type { GpuComputeDeviceLike, GpuComputePipelineLike, GpuBindGroupLayoutLike } from './height-pass';
import type { GpuBufferLike } from './uploader';
import type { GpuTimestampWritesLike } from './timestamp-profiler';
import type { EffectiveEmissiveEffects } from '../emissive-effects';
import { EMISSIVE_EFFECTS_WGSL } from './emissive-effects-wgsl';
/** Screen-space illumination followed by optional separable HDR bloom; no readbacks. */
export class EmissiveEffectsPass {
  private output: GpuBufferLike | null = null;
  private params: GpuBufferLike | null = null;
  private layout: GpuBindGroupLayoutLike | null = null;
  private pipeline: GpuComputePipelineLike | null = null;
  private readonly bloom: EmissiveBloomPass;
  constructor(private readonly device: GpuComputeDeviceLike) { this.bloom = new EmissiveBloomPass(device); }
  dispatch(buffers: readonly GpuBufferLike[], width: number, height: number, materialCount: number, dpr: number, exposure: number, options: EffectiveEmissiveEffects, shadowColor: readonly number[], shadowAlpha: number, timestampWrites?: GpuTimestampWritesLike): {
    buffer: GpuBufferLike;
    newAllocations: number;
    byteLength: number;
  } {
    const bytes = width * height * 4, limits = this.device.limits;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limits.maxStorageBufferBindingSize || bytes > (limits.maxBufferSize ?? Infinity))
      throw new Error('emissive output exceeds device limits');
    if (Math.ceil(width / 8) > (limits.maxComputeWorkgroupsPerDimension ?? 65535) || Math.ceil(height / 8) > (limits.maxComputeWorkgroupsPerDimension ?? 65535) || (limits.maxStorageBuffersPerShaderStage ?? 8) < 8)
      throw new Error('emissive dispatch exceeds device limits');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !Number.isFinite(dpr) || dpr <= 0) throw new RangeError('invalid emissive extent or dpr');
    const required = [bytes, bytes, bytes, bytes, bytes * 3, Math.max(4, materialCount * 64), bytes];
    if (buffers.length !== 7 || buffers.some((buffer, i) => buffer.size < required[i])) throw new RangeError('invalid emissive input buffer');
    if (options.bloomIntensity > 0 && options.bloomRadius > 0 && (bytes * 4 > limits.maxStorageBufferBindingSize || bytes * 4 > (limits.maxBufferSize ?? Infinity))) throw new RangeError('bloom intermediate exceeds device limits');
    let newAllocations = 0;
    if (!this.output || this.output.size < bytes) {
      this.output?.destroy();
      this.output = this.device.createBuffer({ size: bytes, usage: 140 });
      newAllocations++;
    }
    if (!this.params) {
      this.params = this.device.createBuffer({ size: 64, usage: 72 });
      newAllocations++;
    }
    if (!this.pipeline) {
      this.layout = this.device.createBindGroupLayout({ entries: [...Array.from({ length: 8 }, (_, binding) => ({ binding, visibility: 4, buffer: { type: binding === 7 ? 'storage' as const : 'read-only-storage' as const } })), { binding: 8, visibility: 4, buffer: { type: 'uniform' } }] });
      const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
      this.pipeline = this.device.createComputePipeline({ layout, compute: { module: this.device.createShaderModule({ code: EMISSIVE_EFFECTS_WGSL }), entryPoint: 'main' } });
    }
    const data = new ArrayBuffer(64), v = new DataView(data);
    [width, height, options.quality, materialCount].forEach((n, i) => v.setUint32(i * 4, n, true));
    [dpr, Math.min(65504, exposure), options.lightIntensity, options.lightRadius, options.bloomIntensity, options.bloomRadius, options.threshold, Math.round(shadowAlpha * 255) / 255, ...shadowColor.map(n => n / 255), 0].forEach((n, i) => v.setFloat32(16 + i * 4, n, true));
    const bloomParams = new Uint8Array(data.slice(0));
    v.setFloat32(32, 0, true); // Gaussian bloom runs after illumination.
    this.device.queue.writeBuffer(this.params, 0, new Uint8Array(data));
    const group = this.device.createBindGroup({ layout: this.layout!, entries: [...buffers, this.output, this.params].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : undefined);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    if (options.bloomIntensity > 0 && options.bloomRadius > 0) {
      const result = this.bloom.dispatch([this.output, ...buffers.slice(1)], width, height, bloomParams);
      return { ...result, newAllocations: newAllocations + result.newAllocations };
    }
    return { buffer: this.output, newAllocations, byteLength: bytes };
  }
  dispose() { this.bloom.dispose(); this.output?.destroy(); this.params?.destroy(); this.output = null; this.params = null; this.pipeline = null; this.layout = null; }
}
