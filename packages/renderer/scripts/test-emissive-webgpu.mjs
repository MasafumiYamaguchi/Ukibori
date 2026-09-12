// Optional native Dawn runner; uses a real adapter, never a null backend.
import { runEmissiveParity } from '../test-browser/emissive-parity.mjs';
import * as api from '../dist/index.js';
const { create, globals } = await import(process.env.UKIBORI_WEBGPU_MODULE ?? 'webgpu');
Object.assign(globalThis, globals);
const gpu = create(['enable-dawn-features=allow_unsafe_apis']);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error('No WebGPU adapter available: emissive parity NOT verified');
const device = await adapter.requestDevice();
try { console.log(JSON.stringify({ adapter:adapter.info.description, ...(await runEmissiveParity(api,device)) },null,2)); }
finally { device.destroy(); }
