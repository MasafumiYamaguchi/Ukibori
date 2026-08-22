#!/usr/bin/env node
// Real-Chrome integration runner for the UkiboriDom WebGPU path
// (npm run test:webgpu -w ukibori-dom).
//
//   1. builds `ukibori-renderer` first (the dom-layer bundles against its
//      dist ESM) and bundles the in-page harness + ukibori-dom SOURCE with
//      esbuild into a single self-contained module
//   2. copies ONLY the harness files into a unique isolated temp directory,
//      serves it on 127.0.0.1 (ephemeral port)
//   3. runs headless Chrome with `--enable-unsafe-webgpu` (GPU is NEVER
//      disabled) under an isolated profile; on Windows the default D3D11
//      ANGLE backend is used, on macOS Metal
//   4. polls the harness result through the Chrome DevTools Protocol and
//      exits 0 ONLY on a real-adapter PASS (FAIL and SKIP both exit nonzero)
//
// Cleanup is unconditional (browser, server, temp dir), including on failure.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const MARKER_PASS = "UKIBORI_DOM_GPU_PASS";
const MARKER_FAIL = "UKIBORI_DOM_GPU_FAIL";
const MARKER_SKIP = "UKIBORI_DOM_GPU_SKIP";

/** Anchored FIRST-LINE marker parse (a FAIL detail mentioning PASS must not flip). */
export function parseResultMarker(text) {
  const firstLine = String(text).split("\n", 1)[0].trim();
  const match = /^(UKIBORI_DOM_GPU_(?:PASS|FAIL|SKIP))(?:[ \t]|$)/.exec(firstLine);
  return match === null ? null : match[1];
}

const PROBE_MARKER = /UKIBORI_DOM_GPU_PROBE_(?:PASS|TRANSPARENT|FAIL)/;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

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

// Real WebGPU headless: never disable the GPU. Windows uses the default
// D3D11 ANGLE backend; macOS pins Metal like the renderer parity runner.
const CHROME_FLAGS = [
  "--headless=new",
  "--enable-unsafe-webgpu",
  ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
  "--no-first-run",
  "--no-default-browser-check",
];

const RESULT_TIMEOUT_MS = 180_000;
const CHROME_TIMEOUT_MS = 240_000;
const CDP_TARGET_TIMEOUT_MS = 60_000;
const CHROME_EXIT_WAIT_MS = 10_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".map": "application/json",
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function freePort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const port = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

async function terminateChrome(chrome) {
  if (chrome === null || chrome.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolveExit) => {
    chrome.once("exit", resolveExit);
  });
  try {
    chrome.kill("SIGKILL");
  } catch {
    // already exited between the check and the kill
  }
  await Promise.race([exited, sleep(CHROME_EXIT_WAIT_MS)]);
}

function connectCdp(wsUrl, { onMessage }) {
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
    if (onMessage !== undefined) {
      onMessage(message);
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

/** Bundle the in-page harness (+ ukibori-dom source) with the workspace esbuild. */
async function bundleHarness(outfile) {
  const requireFromRepo = createRequire(join(repoRoot, "package.json"));
  const esbuild = requireFromRepo("esbuild");
  await esbuild.build({
    entryPoints: [join(pkgRoot, "test-browser", "dom-gpu.mjs")],
    bundle: true,
    format: "esm",
    target: "chrome120",
    platform: "browser",
    outfile,
    logLevel: "silent",
  });
}

async function publishResult(text) {
  const resultPath = process.env.WEBGPU_RESULT_PATH;
  if (resultPath !== undefined && resultPath.length > 0) {
    await writeFile(resultPath, text, "utf8");
  }
  console.log(text);
}

async function main() {
  // 1. build the renderer dist ESM the dom-layer bundle imports.
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = spawnSync(npmCommand, ["run", "build", "-w", "ukibori-renderer"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    // Windows resolves npm via npm.cmd, which requires a shell to spawn.
    shell: process.platform === "win32",
  });
  if (build.status !== 0) {
    process.stderr.write((build.stdout ?? "") + (build.stderr ?? ""));
    await publishResult(`${MARKER_FAIL} ukibori-renderer build failed; aborting`);
    process.exit(1);
  }

  if (!existsSync(CHROME)) {
    await publishResult(
      `${MARKER_SKIP} headless Chrome not found at ${CHROME} ` +
        "(set CHROME_PATH to the chrome binary); the dom WebGPU integration cannot run here " +
        "(SKIP is a failure: only a real-adapter PASS counts)",
    );
    process.exit(1);
  }

  const tmp = await mkdtemp(join(tmpdir(), "ukibori-dom-webgpu-"));
  let server = null;
  let probeOutcome = null;
  try {
    const profileDir = join(tmp, "chrome-profile");
    await mkdir(profileDir, { recursive: true });
    await bundleHarness(join(tmp, "dom-gpu-app.js"));
    // Raw renderer ESM for the harness's unbundled-module control probes.
    await writeFile(
      join(tmp, "renderer-index.js"),
      await readFile(join(pkgRoot, "..", "renderer", "dist", "index.js")),
      "utf8",
    );
    for (const page of ["dom-gpu.html", "probe.html"]) {
      await writeFile(join(tmp, page), await readFile(join(pkgRoot, "test-browser", page)), "utf8");
    }

    server = createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
      const name = pathname === "/" ? "dom-gpu.html" : basename(pathname);
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

    /**
     * One headless Chrome session navigating to `page`; polls #result until
     * the given marker regex matches. Deterministic completion via CDP.
     */
    async function launchAndPoll(pageName, markerRegex) {
      const cdpPort = await freePort();
      const sessionProfile = join(profileDir, pageName.replace(/\.html$/, ""));
      await mkdir(sessionProfile, { recursive: true });
      const url = `http://127.0.0.1:${port}/${pageName}`;
      const chrome = spawn(
        CHROME,
        [...CHROME_FLAGS, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${sessionProfile}`, url],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let chromeStderr = "";
      chrome.stderr.on("data", (chunk) => {
        chromeStderr += chunk;
      });
      const killTimer = setTimeout(() => {
        try {
          chrome.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, CHROME_TIMEOUT_MS);
      try {
        let target = null;
        const targetDeadline = Date.now() + CDP_TARGET_TIMEOUT_MS;
        while (target === null && Date.now() < targetDeadline && chrome.exitCode === null) {
          try {
            const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
            const targets = await response.json();
            target = targets.find((t) => t.type === "page" && t.url.includes(pageName)) ?? null;
          } catch {
            // chrome not ready yet
          }
          if (target === null) {
            await sleep(150);
          }
        }

        let result = null;
        if (target !== null) {
          const cdp = connectCdp(target.webSocketDebuggerUrl, {});
          await cdp.ready;
          await cdp.send("Runtime.enable");
          const deadline = Date.now() + RESULT_TIMEOUT_MS;
          while (result === null && Date.now() < deadline && chrome.exitCode === null) {
            const response = await cdp.send("Runtime.evaluate", {
              expression: `document.getElementById("result") ? document.getElementById("result").textContent : ""`,
              returnByValue: true,
            });
            const text = response.result?.result?.value;
            if (typeof text === "string" && markerRegex.test(text.split("\n", 1)[0])) {
              result = text;
              break;
            }
            await sleep(200);
          }
          cdp.close();
        }
        if (result === null) {
          const trace = chromeStderr.trim().split("\n").slice(-10).join("\n");
          result = `${MARKER_FAIL} ${pageName} produced no result within ${RESULT_TIMEOUT_MS}ms` +
            (trace.length > 0 ? `\nchrome stderr tail:\n${trace}` : "");
        }
        return result;
      } finally {
        clearTimeout(killTimer);
        await terminateChrome(chrome);
      }
    }

    // Phase A: minimal self-contained control (no ukibori-dom code).
    probeOutcome = await launchAndPoll("probe.html", PROBE_MARKER);
    console.log(`PROBE: ${probeOutcome.split("\n")[0]}`);

    // Phase B: the full integration harness.
    const result = await launchAndPoll("dom-gpu.html", /UKIBORI_DOM_GPU_(?:PASS|FAIL|SKIP)/);
    await publishResult(result);
    const marker = parseResultMarker(result);
    console.log(`test:webgpu(dom): ${marker}`);
    process.exitCode = marker === MARKER_PASS ? 0 : 1;
  } finally {
    if (server !== null) {
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    await rm(tmp, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch(async (error) => {
    await publishResult(`${MARKER_FAIL} runner failed: ${error}`).catch(() => {});
    process.exit(1);
  });
}
