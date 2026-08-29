// #46 browser-side environment metadata collector (#16): GPU/DOM benchmark
// harnesses call this with the live GPUAdapter/GPUDevice (or nulls). Fields
// are `unknown` when unavailable - never guessed.

export function isHeadlessUserAgent(userAgent) {
  return /HeadlessChrome\//.test(userAgent);
}

export function detectHeadless({ userAgent, webdriver }) {
  return webdriver === true || isHeadlessUserAgent(userAgent);
}

function parseBrowserVersion(userAgent) {
  if (typeof userAgent !== "string" || userAgent.length === 0) {
    return { browser: "unknown", version: "unknown" };
  }
  const chrome = /Chrome\/(\d+\.\d+)/.exec(userAgent);
  const firefox = /Firefox\/(\d+\.\d+)/.exec(userAgent);
  const safari = /Version\/(\d+\.\d+).*Safari/.exec(userAgent);
  if (chrome !== null) {
    return { browser: "chrome", version: chrome[1] };
  }
  if (firefox !== null) {
    return { browser: "firefox", version: firefox[1] };
  }
  if (safari !== null) {
    return { browser: "safari", version: safari[1] };
  }
  return { browser: "unknown", version: "unknown" };
}

export function collectBrowserEnvironment({ adapter = null, device = null } = {}) {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "unknown";
  const parsed = parseBrowserVersion(userAgent);
  const env = {
    timestamp: new Date().toISOString(),
    userAgent,
    browser: parsed.browser,
    browserVersion: parsed.version,
    // explicit UA information (not a guess): HeadlessChrome appears in the
    // UA of headless Chrome regardless of the webdriver automation flag
    headless: detectHeadless({
      userAgent,
      webdriver: typeof navigator !== "undefined" && navigator.webdriver === true,
    }),
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
    maxComputeWorkgroupsPerDimension: "unknown",
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
    if (typeof device.limits?.maxComputeWorkgroupsPerDimension === "number") {
      env.maxComputeWorkgroupsPerDimension = device.limits.maxComputeWorkgroupsPerDimension;
    }
  }
  if (typeof navigator !== "undefined" && navigator.gpu?.getPreferredCanvasFormat !== undefined) {
    env.canvasPreferredFormat = navigator.gpu.getPreferredCanvasFormat();
  }
  return env;
}