#!/usr/bin/env node
// #52 glyph lighting ablation runner (npm run ablation:glyph -w ukibori-dom).
//
// Drives test-browser/glyph-lighting.html in headless Chrome over a REAL
// WebGPU adapter. The page renders the current Playground glyph fixture
// (Playground typography/layout copied from demo/src/index.css) through the
// REAL production React components (<Ukibori> / <Surface> / <UkiboriText>,
// fixed 2x source-mask rasterization — no copied rasterizer):
//
//   1. builds the published ukibori-renderer / ukibori-dom / ukibori packages
//      and bundles the in-page harness (+ React) with esbuild
//   2. serves it on 127.0.0.1 (ephemeral port)
//   3. for each condition (light direction x DOM-ink state x DPR) calls
//      window.__prepare and captures a full-page screenshot for the visual
//      evidence; the canvas-side light response comes back as JSON
//   4. runs window.__runShadowVerification: numeric presented-frame readback
//      for the review lights (default / reversed / grazing) and the
//      provider-global bias 0.5 vs 0.15 (shadow existence/length, centroid
//      reversal, grazing reach, acne, other roundedRect impact). The gate
//      also asserts the Playground bias-adoption DECISION (0.15 must add
//      receiver shadow pixels at the default and grazing lights; other
//      roundedRect surfaces stay within the small tolerance) and the COMPUTED
//      Playground fixture typography + fixed-2x mask (the harness styles are
//      pinned to demo/src/index.css by glyph-lighting-css.test.mjs)
//   5. prints the JSON reports and writes them (+ the PNGs) to --out
//      (default: a unique temp directory; printed at the end)
//
// Evidence-only tool: exit code 0 when the harness ran, 1 when the harness
// itself failed. Whether the numbers settle the root cause is a report-level
// judgement, not an exit code.
//
// Environment: GLYPH_ABLATION_DEVICE_SCALE=2 launches Chrome with
// --force-device-scale-factor=2 (the page then reports devicePixelRatio 2;
// the fixed-2x production raster is independent of it — the mask dimensions
// stay exactly 2x the logical box).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".map": "application/json",
};

function findChrome() {
  if (process.env.CHROME_PATH !== undefined) {
    return process.env.CHROME_PATH;
  }
  const candidates =
    process.platform === "win32"
      ? [
          join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
          join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
          join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => candidate.length > 0 && existsSync(candidate)) ?? candidates[0];
}

const CHROME = findChrome();
const CHROME_FLAGS = [
  "--headless=new",
  "--enable-unsafe-webgpu",
  ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
  ...(process.env.GLYPH_ABLATION_DEVICE_SCALE
    ? [`--force-device-scale-factor=${process.env.GLYPH_ABLATION_DEVICE_SCALE}`]
    : []),
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=520,560",
];

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function freePort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const port = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const ready = new Promise((resolveReady, rejectReady) => {
    ws.onopen = () => resolveReady();
    ws.onerror = () => rejectReady(new Error("CDP websocket failed"));
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolveSend) => {
      const id = nextId++;
      pending.set(id, resolveSend);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const close = () => {
    try {
      ws.close();
    } catch {
      // already closed
    }
  };
  return { ready, send, close };
}

async function evaluateJson(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  if (response.result?.result?.type === "promise") {
    // awaited below by the caller via awaitPromise variant
  }
  return response.result?.result?.value;
}

async function evaluateAwaitJson(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(`evaluate failed: ${JSON.stringify(response.exceptionDetails)}`);
  }
  return response.result?.result?.value;
}

let ALIGNMENT_MODE = false;

/**
 * Fail-fast assertions for the NUMERIC shadow verification. Any empty required
 * case, wrong direction, non-increasing grazing distance or physically
 * implausible metric is a hard failure: the runner exits nonzero and never
 * prints GLYPH_ABLATION_RUN_OK.
 */
export function shadowAssertionFailures(report, label) {
  const failures = [];
  const cases = report && report.cases ? report.cases : {};
  const get = (name, bias) => (cases[name] ? cases[name][`bias${bias}`] : undefined);
  for (const name of ["default", "reversed", "grazing"]) {
    for (const bias of ["0.5", "0.15"]) {
      const c = get(name, bias);
      if (c === undefined) {
        failures.push(`${label}: missing required case ${name}/bias${bias}`);
        continue;
      }
      if (!(c.count > 0)) failures.push(`${label}: empty shadow case ${name}/bias${bias} (count=${c.count})`);
      if (!(c.localP90 > 0)) failures.push(`${label}: no local caster reach for ${name}/bias${bias}`);
      if (c.unattributed > c.count * 0.1) {
        failures.push(`${label}: unattributed shadow pixels ${name}/bias${bias} = ${c.unattributed}/${c.count}`);
      }
    }
  }
  const d05 = get("default", "0.5");
  const r05 = get("reversed", "0.5");
  const g05 = get("grazing", "0.5");
  const d015 = get("default", "0.15");
  const g015 = get("grazing", "0.15");
  // GATE metric = robust (90th-percentile) local receiver-plane reach. A 2px
  // relief projects ~2px at z=1 and ~5.7px at z=0.35 (bias + march + pixel
  // quantization shorten the measured extent); the raw max is dominated by the
  // rare counter-spanning attribution and stays informational.
  const within = (c, lo, hi) => c !== undefined && c.localP90 >= lo && c.localP90 <= hi;
  if (!within(d05, 1.0, 3.5)) failures.push(`${label}: default reach ${d05 && d05.localP90} outside [1,3.5] CSS px`);
  if (!within(r05, 1.0, 3.5)) failures.push(`${label}: reversed reach ${r05 && r05.localP90} outside [1,3.5] CSS px`);
  if (!within(g05, 2.0, 7.5)) failures.push(`${label}: grazing reach ${g05 && g05.localP90} outside [2,7.5] CSS px`);
  if (d015 !== undefined && !within(d015, 1.0, 3.5)) {
    failures.push(`${label}: default(0.15) reach ${d015.localP90} outside [1,3.5] CSS px`);
  }
  if (g015 !== undefined && !within(g015, 2.0, 8.0)) {
    failures.push(`${label}: grazing(0.15) reach ${g015.localP90} outside [2,8.0] CSS px`);
  }
  const alignmentOk = (c) => c !== undefined && c.meanAlignmentWithLight > 0.9;
  if (!alignmentOk(d05)) failures.push(`${label}: default displacement not anti-light (align=${d05 && d05.meanAlignmentWithLight})`);
  if (!alignmentOk(r05)) failures.push(`${label}: reversed displacement not anti-light (align=${r05 && r05.meanAlignmentWithLight})`);
  if (!alignmentOk(g05)) failures.push(`${label}: grazing displacement not anti-light (align=${g05 && g05.meanAlignmentWithLight})`);
  const verification = report && report.verification ? report.verification : {};
  if (verification.directionReverses !== true) {
    failures.push(`${label}: local caster-to-shadow displacement does not reverse`);
  }
  if (verification.grazingDistanceIncreasesAt05 !== true) {
    failures.push(`${label}: grazing local distance does not increase at bias 0.5`);
  }
  if (verification.grazingDistanceIncreasesAt015 !== true) {
    failures.push(`${label}: grazing local distance does not increase at bias 0.15`);
  }

  // --- Playground fixture fidelity: computed typography + fixed-2x mask ---
  // The harness must reproduce the ACTUAL Playground conditions
  // (demo/src/index.css .demo-play-panel / .ukibori-text); the browser report
  // records the COMPUTED values and this gate checks them, so a harness or
  // stylesheet drift can never pass as Playground evidence.
  const fixture = report && report.fixture ? report.fixture : null;
  const typography = fixture ? fixture.typography : undefined;
  const expected = fixture ? fixture.expectedTypography : undefined;
  if (typography === undefined || typography === null) {
    failures.push(`${label}: missing fixture.typography (computed Playground typography)`);
  } else if (expected === undefined || expected === null) {
    failures.push(`${label}: missing fixture.expectedTypography`);
  } else {
    if (typography.fontWeight !== expected.fontWeight) {
      failures.push(`${label}: fixture fontWeight ${typography.fontWeight} != ${expected.fontWeight}`);
    }
    const fontSize = Number.parseFloat(typography.fontSize);
    if (!Number.isFinite(fontSize) || fontSize <= 0) {
      failures.push(`${label}: fixture fontSize not a positive length (${typography.fontSize})`);
    } else {
      const expectedSize = expected.fontSizeRem * 16; // rem root default
      if (Math.abs(fontSize - expectedSize) > 0.5) {
        failures.push(
          `${label}: fixture fontSize ${fontSize}px != ${expectedSize}px (${expected.fontSizeRem}rem)`,
        );
      }
      const lineHeight = Number.parseFloat(typography.lineHeight);
      if (!Number.isFinite(lineHeight) || Math.abs(lineHeight - fontSize) > 0.5) {
        failures.push(
          `${label}: fixture lineHeight ${typography.lineHeight} != fontSize ${fontSize}px (line-height: ${expected.lineHeightRatio})`,
        );
      }
      const letterSpacing = Number.parseFloat(typography.letterSpacing);
      const expectedSpacing = expected.letterSpacingEm * fontSize;
      if (!Number.isFinite(letterSpacing) || Math.abs(letterSpacing - expectedSpacing) > 0.5) {
        failures.push(
          `${label}: fixture letterSpacing ${typography.letterSpacing} != ${expectedSpacing}px (${expected.letterSpacingEm}em)`,
        );
      }
    }
    const family = typeof typography.fontFamily === "string" ? typography.fontFamily.toLowerCase() : "";
    if (!expected.fontFamilyIncludes.some((token) => family.includes(token))) {
      failures.push(
        `${label}: fixture fontFamily missing monospace/Cascadia/Consolas fallback (${typography.fontFamily})`,
      );
    }
  }
  const mask = fixture ? fixture.mask : undefined;
  if (mask === undefined || mask === null || typeof mask.width !== "number" || typeof mask.height !== "number") {
    failures.push(`${label}: missing fixture.mask dimensions`);
  } else if (!Array.isArray(mask.logical) || mask.logical.length !== 2) {
    failures.push(`${label}: missing fixture.mask.logical box`);
  } else if (mask.width !== mask.logical[0] * 2 || mask.height !== mask.logical[1] * 2) {
    failures.push(
      `${label}: fixture mask ${mask.width}x${mask.height} is not exactly 2x the logical box ${mask.logical.join("x")}`,
    );
  }

  // --- Bias-adoption decision: the Playground provider-global 0.15 override
  // is a regression-gated DECISION, not just "it still renders". 0.15 must
  // add cast-shadow receiver pixels at the default and grazing Playground
  // lights, while leaving the other roundedRect surface within tolerance. ---
  const decision = report && report.biasDecision ? report.biasDecision : undefined;
  if (decision === undefined || decision === null) {
    failures.push(`${label}: missing biasDecision`);
  } else {
    if (!(decision.defaultReceiverGain > 0)) {
      failures.push(
        `${label}: bias 0.15 does not add default-light receiver shadow pixels (gain=${decision.defaultReceiverGain})`,
      );
    }
    if (!(decision.grazingReceiverGain > 0)) {
      failures.push(
        `${label}: bias 0.15 does not add grazing-light receiver shadow pixels (gain=${decision.grazingReceiverGain})`,
      );
    }
    const tolerance = typeof decision.sidePanelTolerance === "number" ? decision.sidePanelTolerance : 0;
    if (!(decision.sidePanelSurfaceChanged <= tolerance)) {
      failures.push(
        `${label}: side roundedRect glyph-surface change ${decision.sidePanelSurfaceChanged} > tolerance ${tolerance}`,
      );
    }
    if (!(decision.sidePanelReceiverChanged <= tolerance)) {
      failures.push(
        `${label}: side roundedRect receiver change ${decision.sidePanelReceiverChanged} > tolerance ${tolerance}`,
      );
    }
  }
  return failures;
}

const LIGHT_DPR_GROUPS = [
  { key: "dpr-1-ink-visible", dpr: 1 },
  { key: "dpr-1.5-ink-visible", dpr: 1.5 },
  { key: "dpr-2-ink-visible", dpr: 2 },
  { key: "dpr-1-ink-suppressed", dpr: 1 },
];

function isPositiveFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCanvasSummary(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isPositiveFiniteNumber(value[0]) &&
    isPositiveFiniteNumber(value[1])
  );
}

function isRegionSize(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    isPositiveFiniteNumber(value.w) &&
    isPositiveFiniteNumber(value.h)
  );
}

/**
 * Fail-fast assertions for the light-response matrix: every required
 * direction must have an opaque presented frame, valid two-number canvas
 * metadata, a valid numeric region w/h AND the requested numeric
 * `debugState().dpr`; both opposite pairs must compare pixels; and the
 * DPR 1 / 1.5 / 2 visible group canvas summaries must EXIST and scale
 * correctly (misscaled, missing or mislabeled DPR evidence must never pass).
 */
export function lightAssertionFailures(report) {
  const failures = [];
  const canvasByKey = {};
  for (const { key, dpr } of LIGHT_DPR_GROUPS) {
    const entry = report && report[key];
    if (entry === undefined || entry === null) {
      failures.push(`missing group ${key}`);
      continue;
    }
    for (const direction of ["left", "right", "top", "bottom"]) {
      const label = `${key}/${direction}`;
      const item = entry[direction];
      if (item === undefined || item === null) {
        failures.push(`${label}: missing entry`);
        continue;
      }
      if (!Array.isArray(item.mean)) {
        failures.push(`${label}: no opaque presented frame`);
      }
      if (typeof item.dpr !== "number" || !Number.isFinite(item.dpr)) {
        failures.push(`${label}: missing/non-numeric debugState dpr`);
      } else if (item.dpr !== dpr) {
        failures.push(`${label}: debugState dpr ${item.dpr} != requested ${dpr}`);
      }
      if (!isCanvasSummary(item.canvas)) {
        failures.push(
          `${label}: missing/malformed canvas (expected two positive numbers, got ${JSON.stringify(item.canvas)})`,
        );
      } else if (canvasByKey[key] === undefined) {
        canvasByKey[key] = item.canvas;
      } else if (canvasByKey[key][0] !== item.canvas[0] || canvasByKey[key][1] !== item.canvas[1]) {
        failures.push(`${label}: canvas ${item.canvas.join("x")} disagrees with group ${canvasByKey[key].join("x")}`);
      }
      if (!isRegionSize(item.region)) {
        failures.push(`${label}: missing/malformed region w/h`);
        continue;
      }
      if (!isCanvasSummary(item.canvas)) {
        // Canvas failure already recorded; cannot compare dimensions.
        continue;
      }
      const expectedW = Math.floor(item.region.w * dpr);
      const expectedH = Math.floor(item.region.h * dpr);
      if (item.canvas[0] !== expectedW || item.canvas[1] !== expectedH) {
        failures.push(
          `${label}: canvas ${item.canvas.join("x")} != expected ${expectedW}x${expectedH} at dpr ${dpr}`,
        );
      }
    }
    for (const delta of ["delta-right-left", "delta-bottom-top"]) {
      const item = entry[delta];
      if (item === undefined || !(item.n > 0)) {
        failures.push(`${key}/${delta}: no compared pixels`);
      }
    }
  }
  // Cross-group scale checks REQUIRE the three visible DPR summaries; absence
  // of a summary (missing group / malformed canvas) is an explicit failure.
  const summary = (key) => {
    const canvas = canvasByKey[key];
    if (!isCanvasSummary(canvas)) {
      failures.push(`light matrix: missing canvas summary for ${key}`);
      return null;
    }
    return canvas;
  };
  const base = summary("dpr-1-ink-visible");
  const oneAndHalf = summary("dpr-1.5-ink-visible");
  const doubled = summary("dpr-2-ink-visible");
  // The scene region can be fractional (content-sized mask surfaces), so the
  // per-direction canvas check uses floor(region * dpr) while the cross-group
  // scale check allows the 1-px floor rounding of a fractional region.
  if (
    base &&
    doubled &&
    (Math.abs(doubled[0] - base[0] * 2) > 1 || Math.abs(doubled[1] - base[1] * 2) > 1)
  ) {
    failures.push(
      `light matrix: dpr-2 canvas ${doubled.join("x")} is not 2x the dpr-1 canvas ${base.join("x")}`,
    );
  }
  if (base && oneAndHalf && !(oneAndHalf[0] > base[0] && oneAndHalf[1] > base[1])) {
    failures.push(`light matrix: dpr-1.5 canvas ${oneAndHalf.join("x")} did not scale above dpr-1`);
  }
  return failures;
}

export function compareShadowPasses(a, b) {
  const differences = [];
  const casesA = (a && a.cases) || {};
  const casesB = (b && b.cases) || {};
  for (const name of Object.keys(casesA)) {
    for (const bias of Object.keys(casesA[name])) {
      const x = casesA[name][bias];
      const y = casesB[name] && casesB[name][bias];
      if (y === undefined) {
        differences.push(`${name}/${bias} missing in pass 2`);
        continue;
      }
      if (x.count !== y.count) differences.push(`${name}/${bias} count ${x.count} != ${y.count}`);
      if (x.localP90 !== y.localP90) {
        differences.push(`${name}/${bias} localP90 ${x.localP90} != ${y.localP90}`);
      }
      if (Math.abs(x.horizontalMax - y.horizontalMax) > 0.2) {
        differences.push(`${name}/${bias} horizontalMax ${x.horizontalMax} != ${y.horizontalMax}`);
      }
      if (Math.abs(x.rayMax - y.rayMax) > 0.2) {
        differences.push(`${name}/${bias} rayMax ${x.rayMax} != ${y.rayMax}`);
      }
    }
  }
  return { stable: differences.length === 0, differences };
}

const CONDITIONS = [
  // canvas light-response matrix (DOM ink visible, matching production today)
  ...["left", "right", "top", "bottom"].map((direction) => ({ direction, dpr: 1, ink: true })),
  ...["left", "right", "top", "bottom"].map((direction) => ({ direction, dpr: 1.5, ink: true })),
  ...["left", "right", "top", "bottom"].map((direction) => ({ direction, dpr: 2, ink: true })),
  // DOM ink suppression at DPR 1: canvas response must be unchanged
  ...["left", "right", "top", "bottom"].map((direction) => ({ direction, dpr: 1, ink: false })),
];

const SCREENSHOT_CONDITIONS = [
  { direction: "left", dpr: 1, ink: true },
  { direction: "right", dpr: 1, ink: true },
  { direction: "top", dpr: 1, ink: true },
  { direction: "bottom", dpr: 1, ink: true },
  { direction: "left", dpr: 1, ink: false },
  { direction: "right", dpr: 1, ink: false },
  { direction: "top", dpr: 1, ink: false },
  { direction: "bottom", dpr: 1, ink: false },
  { direction: "left", dpr: 2, ink: true },
  { direction: "left", dpr: 2, ink: false },
];

function screenshotName(condition) {
  return `glyph-${condition.direction}-dpr${String(condition.dpr).replace(".", "-")}-${condition.ink ? "ink" : "noink"}.png`;
}

async function main() {
  // Modes: "light" (default; light-response matrix + screenshots) and
  // "alignment" (#52 DOM-ink vs mask-ink measurement matrix).
  ALIGNMENT_MODE = process.argv.slice(2).includes("alignment");
  const outArg =
    process.argv
      .slice(2)
      .find((arg) => !arg.startsWith("--") && arg !== "alignment") ?? process.env.GLYPH_ABLATION_OUT;
  const outDir = resolve(outArg ?? mkdtempSyncSafe());
  mkdirSync(outDir, { recursive: true });

  const requireFromRepo = createRequire(join(repoRoot, "package.json"));
  const esbuild = requireFromRepo("esbuild");
  const tmp = await mkdtemp(join(tmpdir(), "ukibori-52-ablation-"));
  let server = null;
  let chrome = null;
  try {
    const build = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "build", "-w", "ukibori-renderer", "-w", "ukibori-dom", "-w", "ukibori"],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: process.platform === "win32" },
    );
    if (build.status !== 0) {
      throw new Error("ukibori package build failed:\n" + (build.stdout ?? "") + (build.stderr ?? ""));
    }
    await esbuild.build({
      entryPoints: [join(pkgRoot, "test-browser", "glyph-lighting.mjs")],
      bundle: true,
      format: "esm",
      target: "chrome120",
      platform: "browser",
      // React/react-dom are bundled from the workspace node_modules; their
      // CJS entry points read process.env.NODE_ENV.
      define: { "process.env.NODE_ENV": '"production"' },
      outfile: join(tmp, "glyph-lighting-app.js"),
      logLevel: "silent",
    });
    for (const page of ["glyph-lighting.html"]) {
      await writeFile(join(tmp, page), await readFile(join(pkgRoot, "test-browser", page)), "utf8");
    }

    server = createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
      const name = pathname === "/" ? "glyph-lighting.html" : basename(pathname);
      const file = join(tmp, name);
      readFile(file)
        .then((data) => {
          res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
          res.end(data);
        })
        .catch(() => {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not found");
        });
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = server.address().port;

    if (!existsSync(CHROME)) {
      throw new Error(`headless Chrome not found at ${CHROME} (set CHROME_PATH)`);
    }
    const cdpPort = await freePort();
    const profile = join(tmp, "chrome-profile");
    mkdirSync(profile, { recursive: true });
    const url = `http://127.0.0.1:${port}/glyph-lighting.html`;
    chrome = spawn(CHROME, [...CHROME_FLAGS, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, url], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let target = null;
    const targetDeadline = Date.now() + 60_000;
    while (target === null && Date.now() < targetDeadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
        const targets = await response.json();
        target = targets.find((t) => t.type === "page" && t.url.includes("glyph-lighting")) ?? null;
      } catch {
        // chrome not ready yet
      }
      if (target === null) {
        await sleep(150);
      }
    }
    if (target === null) {
      throw new Error("CDP page target never appeared");
    }
    const cdp = connectCdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    const browserVersionResponse = await cdp.send("Browser.getVersion");
    const browserInfo = browserVersionResponse.result ?? null;

    // Wait for the harness to become ready (or fail).
    const readyDeadline = Date.now() + 120_000;
    let ready = null;
    while (ready === null && Date.now() < readyDeadline) {
      const text = await evaluateJson(cdp, `document.getElementById("result") ? document.getElementById("result").textContent.slice(0, 400) : ""`);
      if (typeof text === "string" && text.startsWith("GLYPH_ABLATION_READY")) {
        ready = true;
      } else if (typeof text === "string" && (text.startsWith("GLYPH_ABLATION_FAIL") || text.startsWith("GLYPH_ABLATION_SKIP"))) {
        ready = text;
      } else {
        await sleep(200);
      }
    }
    if (ready !== true) {
      throw new Error(`harness not ready: ${ready}`);
    }

    for (const condition of CONDITIONS) {
      await evaluateAwaitJson(
        cdp,
        `window.__prepare(${JSON.stringify(condition)})`,
      );
    }
    const lightReport = await evaluateAwaitJson(cdp, `window.__report()`);
    writeFileSync(join(outDir, "light-response-report.json"), JSON.stringify(lightReport, null, 2), "utf8");
    const lightFailures = lightAssertionFailures(lightReport);
    for (const failure of lightFailures) {
      console.error(`LIGHT_ASSERT_FAIL ${failure}`);
    }
    if (lightFailures.length > 0) {
      throw new Error(`light-response matrix failed: ${lightFailures.join("; ")}`);
    }

    // NUMERIC shadow verification (presented-frame GPU readback), run TWICE
    // consecutively. Each pass re-captures the six required cases and must
    // satisfy the fail-fast assertions; the two passes must also agree.
    const shadowPasses = [];
    for (let pass = 1; pass <= 2; pass++) {
      const passReport = await evaluateAwaitJson(cdp, `window.__runShadowVerification()`);
      const failures = shadowAssertionFailures(passReport, `pass ${pass}`);
      for (const failure of failures) {
        console.error(`SHADOW_ASSERT_FAIL ${failure}`);
      }
      shadowPasses.push({ report: passReport, failures });
    }
    const assertionsPassed = shadowPasses.every((pass) => pass.failures.length === 0);
    const determinism = compareShadowPasses(shadowPasses[0].report, shadowPasses[1].report);
    const shadowReport = {
      ...shadowPasses[0].report,
      browser: browserInfo,
      assertions: {
        passed: assertionsPassed,
        stable: determinism.stable,
        differences: determinism.differences,
        pass1: shadowPasses[0].failures,
        pass2: shadowPasses[1].failures,
      },
      secondPass: {
        cases: shadowPasses[1].report.cases,
        verification: shadowPasses[1].report.verification,
        biasDecision: shadowPasses[1].report.biasDecision,
        biasImpact: shadowPasses[1].report.biasImpact,
        runtime: shadowPasses[1].report.runtime,
      },
    };
    const shadowPath = join(outDir, "shadow-verification-report.json");
    writeFileSync(shadowPath, JSON.stringify(shadowReport, null, 2), "utf8");
    if (!assertionsPassed || !determinism.stable) {
      throw new Error(
        `glyph shadow verification failed (assertionsPassed=${assertionsPassed}, stable=${determinism.stable}); see ${shadowPath}`,
      );
    }

    for (const condition of SCREENSHOT_CONDITIONS) {
      // readback:false keeps the presented frame untouched for the capture.
      await evaluateAwaitJson(
        cdp,
        `window.__prepare(${JSON.stringify({ ...condition, readback: false })})`,
      );
      await sleep(150); // let the compositor settle for the capture
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const data = shot.result?.data;
      if (typeof data !== "string") {
        throw new Error(`captureScreenshot failed for ${JSON.stringify(condition)}: ${JSON.stringify(shot).slice(0, 300)}`);
      }
      writeFileSync(join(outDir, screenshotName(condition)), Buffer.from(data, "base64"));
    }

    if (ALIGNMENT_MODE) {
      // #52 alignment matrix: real DOM ink bounds (screenshot round-trip)
      // vs the rasterized mask ink bounds, across glyph shapes / sizes/DPR.
      const cases = [
        { text: "PLAY", fontWeight: 700, fontPx: 32, dpr: 1 },
        { text: "PLAY", fontWeight: 700, fontPx: 64, dpr: 1 },
        { text: "PLAY", fontWeight: 700, fontPx: 96, dpr: 1 },
        { text: "illii", fontWeight: 400, fontPx: 64, dpr: 1 },
        { text: "OM", fontWeight: 900, fontPx: 64, dpr: 1 },
        { text: "PLAY", fontWeight: 700, fontPx: 64, dpr: 1.5 },
        { text: "PLAY", fontWeight: 700, fontPx: 64, dpr: 2 },
        // #52 fidelity fixture: a constrained box wraps the text into
        // multiple lines -> canDelegateInk false -> the DOM ink stays
        // visible (the physical mask remains geometry only).
        { text: "PLAY STOP WAIT", fontWeight: 700, fontPx: 48, dpr: 1, constrainWidth: 140 },
        // #52 review round 3 typography fixtures: text-transform is DOM-only
        // typography the canvas raster cannot mirror (the raster draws the
        // raw "play") -> canDelegateInk false -> DOM ink stays visible.
        { text: "play", fontWeight: 700, fontPx: 64, dpr: 1, textTransform: "uppercase" },
        // Non-default letter-spacing IS mirrorable (canvas letterSpacing,
        // set + read-back verified) -> the faithful delegation stands and
        // the mask ink must still coincide with the DOM ink.
        { text: "PLAY", fontWeight: 700, fontPx: 64, dpr: 1, letterSpacing: "2px" },
      ];
      const alignment = [];
      for (const alignmentCase of cases) {
        const config = await evaluateAwaitJson(
          cdp,
          `window.__configureAlignment(${JSON.stringify(alignmentCase)})`,
        );
        // The DOM ink must be VISIBLE for the measurement (debug override),
        // with the physical overlay canvas hidden so the segmented bbox is
        // PURE DOM ink (fixed-2x relief bevels are otherwise included).
        await evaluateAwaitJson(cdp, `Promise.resolve(window.__setInk(true))`);
        await evaluateAwaitJson(cdp, `Promise.resolve(window.__setOverlayVisible(false))`);
        await sleep(120);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        const data = shot.result?.data;
        if (typeof data !== "string") {
          throw new Error(`alignment capture failed for ${JSON.stringify(alignmentCase)}`);
        }
        const domInk = await evaluateAwaitJson(
          cdp,
          `window.__measureInk("data:image/png;base64,${data}")`,
        );
        await evaluateAwaitJson(cdp, `Promise.resolve(window.__setOverlayVisible(true))`);
        alignment.push({
          case: alignmentCase,
          mask: config,
          domInk,
        });
      }
      const jsonPath = join(outDir, "alignment-report.json");
      writeFileSync(jsonPath, JSON.stringify({ alignment }, null, 2), "utf8");
      console.log(JSON.stringify({ alignment }, null, 2));
      console.log(`\nalignment report: ${jsonPath}`);
    }

    const report = await evaluateAwaitJson(cdp, `JSON.stringify({ report: window.__report(), alignment: window.__alignment })`);
    const parsed = JSON.parse(report);
    parsed.browser = browserInfo;
    parsed.runtime = shadowReport.runtime;
    parsed.shadowVerification = shadowReport;
    const jsonPath = join(outDir, "glyph-ablation-report.json");
    writeFileSync(jsonPath, JSON.stringify(parsed, null, 2), "utf8");
    console.log(JSON.stringify({ shadowVerification: shadowReport }, null, 2));
    console.log(JSON.stringify(parsed, null, 2));
    console.log(`\nreport: ${jsonPath}`);
    console.log(`shadow verification: ${shadowPath}`);
    console.log(`screenshots: ${outDir}`);
    cdp.close();
    console.log("GLYPH_ABLATION_RUN_OK");
  } finally {
    if (chrome !== null && chrome.exitCode === null) {
      const exited = new Promise((resolveExit) => chrome.once("exit", resolveExit));
      try {
        chrome.kill("SIGKILL");
      } catch {
        // already exited
      }
      await Promise.race([exited, sleep(10_000)]);
    }
    if (server !== null) {
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    // Chrome releases its profile files asynchronously; retry the cleanup so
    // a lingering AV/index handle cannot fail the whole run.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rm(tmp, { recursive: true, force: true });
        break;
      } catch {
        await sleep(500);
      }
    }
  }
}

function mkdtempSyncSafe() {
  return join(tmpdir(), `ukibori-52-ablation-${String(process.pid)}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error && error.stack ? error.stack : error);
      process.exit(1);
    });
}


