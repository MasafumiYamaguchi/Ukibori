#!/usr/bin/env node
// #52 glyph lighting ablation runner (npm run ablation:glyph -w ukibori-dom).
//
// Drives test-browser/glyph-lighting.html in headless Chrome over a REAL
// WebGPU adapter:
//
//   1. bundles the in-page harness (+ ukibori-dom source) with esbuild
//   2. serves it on 127.0.0.1 (ephemeral port)
//   3. for each condition (light direction x DOM-ink state x DPR) calls
//      window.__prepare and captures a full-page screenshot for the visual
//      evidence; the canvas-side light response comes back as JSON
//   4. prints the JSON report and writes it (+ the PNGs) to --out
//      (default: a unique temp directory; printed at the end)
//
// Evidence-only tool: exit code 0 when the harness ran, 1 when the harness
// itself failed. Whether the numbers settle the root cause is a report-level
// judgement, not an exit code.

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
      ["run", "build", "-w", "ukibori-renderer"],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: process.platform === "win32" },
    );
    if (build.status !== 0) {
      throw new Error("ukibori-renderer build failed:\n" + (build.stdout ?? "") + (build.stderr ?? ""));
    }
    await esbuild.build({
      entryPoints: [join(pkgRoot, "test-browser", "glyph-lighting.mjs")],
      bundle: true,
      format: "esm",
      target: "chrome120",
      platform: "browser",
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
      ];
      const alignment = [];
      for (const alignmentCase of cases) {
        const config = await evaluateAwaitJson(
          cdp,
          `window.__configureAlignment(${JSON.stringify(alignmentCase)})`,
        );
        // The DOM ink must be VISIBLE for the measurement (debug override).
        await evaluateAwaitJson(cdp, `Promise.resolve(window.__setInk(true))`);
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
    const jsonPath = join(outDir, "glyph-ablation-report.json");
    writeFileSync(jsonPath, JSON.stringify(parsed, null, 2), "utf8");
    console.log(JSON.stringify(parsed, null, 2));
    console.log(`\nreport: ${jsonPath}`);
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


