// Optional native Dawn runner. Install webgpu separately or set
// UKIBORI_WEBGPU_MODULE to its absolute index.js; build the renderer first.
// Uses an actual adapter; never substitutes a null backend or CPU mock.
import { runProfileParity } from "../test-browser/profile-parity.mjs";
import * as api from "../dist/index.js";
const { create, globals } = await import(process.env.UKIBORI_WEBGPU_MODULE ?? "webgpu");
Object.assign(globalThis, globals);
const gpu = create(["enable-dawn-features=allow_unsafe_apis"]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error("No WebGPU adapter available: profile parity NOT verified");
const device = await adapter.requestDevice();
try {
  const result = await runProfileParity(api, device);
  console.log(JSON.stringify({ adapter: adapter.info.description, vendor: adapter.info.vendor, ...result }, null, 2));
} finally { device.destroy(); }
