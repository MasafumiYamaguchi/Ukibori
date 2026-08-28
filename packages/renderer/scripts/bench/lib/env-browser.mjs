// #46 browser-side environment metadata collector (§16): GPU/DOM benchmark
// harnesses call this with the live GPUAdapter/GPUDevice (or nulls). Fields
// are `unknown` when unavailable — never guessed.

export function collectBrowserEnvironment({ adapter = null, device = null } = {}) {
  const env = {
    timestamp: new Date().toISOString(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    devicePixelRatio: typeof devicePixelRatio !== "undefined" ? devicePixelRatio : "unknown",
    webgpuAvailable: typeof navigator !== "undefined" && navigator.gpu !== undefined,
    adapterName: "unknown",
    adapterArchitecture: "unknown",
    adapterBackend: "unknown",
    adapterDevice: "unknown",
    adapterVendor: "unknown",
    timestampQuerySupported: false,
    canvasPreferredFormat: "unknown",
    maxStorageBufferBindingSize: "unknown",
  };
  if (adapter !== null && adapter !== undefined) {
    const info = adapter.info;
    if (info !== undefined) {
      env.adapterName = info.description ?? "unknown";
      env.adapterArchitecture = info.architecture ?? "unknown";
      env.adapterBackend = info.backend ?? "unknown";
      env.adapterDevice = info.device ?? "unknown";
      env.adapterVendor = info.vendor ?? "unknown";
    }
  }
  if (device !== null && device !== undefined) {
    env.timestampQuerySupported = device.features?.has("timestamp-query") === true;
    if (typeof device.limits?.maxStorageBufferBindingSize === "number") {
      env.maxStorageBufferBindingSize = device.limits.maxStorageBufferBindingSize;
    }
  }
  if (typeof navigator !== "undefined" && navigator.gpu?.getPreferredCanvasFormat !== undefined) {
    env.canvasPreferredFormat = navigator.gpu.getPreferredCanvasFormat();
  }
  return env;
}