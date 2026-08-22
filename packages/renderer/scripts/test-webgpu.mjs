#!/usr/bin/env node
// #25 real-GPU parity runner (npm run test:webgpu -w ukibori-renderer).
//
// Reproducible browser integration test:
//
//   1. builds `ukibori-renderer` FIRST and tests its bundled public ESM
//      output (dist/index.js)
//   2. creates a unique isolated temporary directory and copies ONLY the
//      bundle (+ source map) and the test harness (parity.html/.mjs) into it
//   3. serves only that directory on 127.0.0.1 (ephemeral port) and runs
//      Chrome 151 headless with `--enable-unsafe-webgpu` and the Metal
//      ANGLE backend (GPU is NEVER disabled) under an isolated profile
//   4. the page requests a real adapter/device, runs SceneUploader +
//      HeightPass, performs test-only staging readback and compares every
//      fixture against the CPU oracle
//   5. the runner polls the harness result through the Chrome DevTools
//      Protocol (deterministic completion; no virtual-time race), prints one
//      unambiguous marker and exits 0 ONLY on a real-adapter PASS; FAIL and
//      SKIP (no WebGPU/adapter/Chrome) both exit nonzero
//
// Cleanup is unconditional: the browser and server are terminated and ONLY
// the exact temporary directory this script created is removed, including
// on failure.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER_PASS = "UKIBORI_WEBGPU_PASS";
const MARKER_FAIL = "UKIBORI_WEBGPU_FAIL";
const MARKER_SKIP = "UKIBORI_WEBGPU_SKIP";

/**
 * Parse ONLY the first line of the harness result with an anchored exact
 * marker token (`UKIBORI_WEBGPU_PASS/FAIL/SKIP`). The first line decides
 * the outcome: a FAIL detail line that happens to contain the word
 * `UKIBORI_WEBGPU_PASS` later in the text must NOT flip the result.
 * The marker must be followed by whitespace or end-of-line, so a forged
 * first token such as `UKIBORI_WEBGPU_PASS-evil` (hyphen, underscore or
 * letter suffix) is NOT accepted. Returns the exact marker token, or null
 * when the first line carries none.
 */
export function parseResultMarker(text) {
  const firstLine = String(text).split("\n", 1)[0].trim();
  const match = /^(UKIBORI_WEBGPU_(?:PASS|FAIL|SKIP))(?:[ \t]|$)/.exec(firstLine);
  return match === null ? null : match[1];
}

async function publishResult(text) {
  const resultPath = process.env.WEBGPU_RESULT_PATH;
  if (resultPath !== undefined && resultPath.length > 0) {
    await writeFile(resultPath, text, "utf8");
  }
  console.log(text);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Real WebGPU headless: unsafe-WebGPU flag; the ANGLE backend is pinned to
// Metal on macOS and left at the platform default elsewhere (Windows D3D11).
// Never disable the GPU.
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
// bounded wait for the SIGKILLed Chrome to actually exit before the profile
// directory is deleted (killing sends the signal; exit is asynchronous)
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

/**
 * SIGKILL the Chrome child and wait (bounded) for its exit. The caller must
 * not delete the browser's profile/temp directory before the process has
 * actually terminated; this never hangs when the child already exited.
 */
async function terminateChrome(chrome) {
  if (chrome === null || chrome.exitCode !== null) {
    return; // never spawned or already exited
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

async function main() {
  // 1. build the public renderer ESM first. The output is buffered so the
  //    dedicated WEBGPU_RESULT_PATH file can always begin with the anchored
  //    marker even when npm adds banners to the full human-readable log.
  const build = spawnSync("npm", ["run", "build", "-w", "ukibori-renderer"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    // Windows resolves npm via npm.cmd, which requires a shell to spawn.
    shell: process.platform === "win32",
  });
  const buildOutput = (build.stdout ?? "") + (build.stderr ?? "");
  if (build.status !== 0) {
    process.stderr.write(buildOutput);
    await publishResult(`${MARKER_FAIL} ukibori-renderer build failed; aborting`);
    process.exit(1);
  }
  const bundle = join(pkgRoot, "dist", "index.js");
  if (!existsSync(bundle)) {
    await publishResult(`${MARKER_FAIL} bundle not found at ${bundle}`);
    process.exit(1);
  }
  if (!existsSync(CHROME)) {
    await publishResult(
      `${MARKER_SKIP} headless Chrome not found at ${CHROME} ` +
        "(set CHROME_PATH to the chrome binary); real-GPU parity cannot run on this machine " +
        "(SKIP is a failure: only a real-adapter PASS counts)",
    );
    process.exit(1);
  }

  // 2. unique isolated temp directory with ONLY the bundle + harness.
  const tmp = await mkdtemp(join(tmpdir(), "ukibori-webgpu-"));
  let chrome = null;
  let server = null;
  let cdp = null;
  try {
    const profileDir = join(tmp, "chrome-profile");
    await mkdir(profileDir, { recursive: true });
    for (const file of ["parity.html", "parity.mjs", "catalog.mjs", "oracle.mjs"]) {
      await copyFile(join(pkgRoot, "test-browser", file), join(tmp, file));
    }
    await copyFile(bundle, join(tmp, "index.js"));
    const mapFile = bundle + ".map";
    if (existsSync(mapFile)) {
      await copyFile(mapFile, join(tmp, "index.js.map"));
    }

    // 3. serve ONLY this directory on 127.0.0.1 (basename-only file lookup).
    server = createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
      const name = pathname === "/" ? "parity.html" : basename(pathname);
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

    // 4. isolated Chrome profile + real WebGPU + CDP for deterministic
    //    completion (never disabling the GPU).
    const cdpPort = await freePort();
    const url = `http://127.0.0.1:${port}/parity.html`;
    chrome = spawn(CHROME, [...CHROME_FLAGS, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, url], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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

    // 5. attach to the page target and poll the harness result block.
    let target = null;
    const targetDeadline = Date.now() + CDP_TARGET_TIMEOUT_MS;
    while (target === null && Date.now() < targetDeadline && chrome.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
        const targets = await response.json();
        target = targets.find((t) => t.type === "page" && t.url.includes("parity.html")) ?? null;
      } catch {
        // chrome not ready yet
      }
      if (target === null) {
        await sleep(150);
      }
    }

    let result = null;
    if (target !== null) {
      cdp = connectCdp(target.webSocketDebuggerUrl, {});
      await cdp.ready;
      await cdp.send("Runtime.enable");
      const deadline = Date.now() + RESULT_TIMEOUT_MS;
      while (result === null && Date.now() < deadline && chrome.exitCode === null) {
        const response = await cdp.send("Runtime.evaluate", {
          expression: `document.getElementById("result") ? document.getElementById("result").textContent : ""`,
          returnByValue: true,
        });
        const text = response.result?.result?.value;
        if (typeof text === "string" && parseResultMarker(text) !== null) {
          result = text;
          break;
        }
        await sleep(200);
      }
    }
    clearTimeout(killTimer);

    if (result !== null) {
      await publishResult(result);
      // The FIRST LINE carries the marker; FAIL takes precedence by the
      // parsed marker token, never by substring search (a FAIL detail may
      // legitimately mention UKIBORI_WEBGPU_PASS and must still exit 1).
      const marker = parseResultMarker(result);
      if (marker === MARKER_PASS) {
        console.log(`test:webgpu: ${MARKER_PASS}`);
        process.exitCode = 0;
      } else if (marker === MARKER_FAIL) {
        console.log(`test:webgpu: ${MARKER_FAIL}`);
        process.exitCode = 1;
      } else if (marker === MARKER_SKIP) {
        console.log(`test:webgpu: ${MARKER_SKIP}`);
        // SKIP (no WebGPU, no adapter) is NOT a success: only a real
        // adapter PASS satisfies the #26 verification gate.
        process.exitCode = 1;
      } else {
        console.log(`${MARKER_FAIL} harness produced no recognized marker on the first line`);
        process.exitCode = 1;
      }
    } else {
      await publishResult(
        `${MARKER_FAIL} harness produced no result within ${RESULT_TIMEOUT_MS}ms ` +
          `(chrome exited ${chrome.exitCode ?? "still running"})`,
      );
      const trace = chromeStderr.trim().split("\n").slice(-15).join("\n");
      if (trace.length > 0) {
        console.log("chrome stderr tail:\n" + trace);
      }
      process.exitCode = 1;
    }
  } finally {
    // 6. terminate the browser and server and remove ONLY our temp dir,
    //    including on failure. The child exit is awaited (bounded) BEFORE
    //    the profile/temp directory is deleted.
    if (cdp !== null) {
      cdp.close();
    }
    await terminateChrome(chrome);
    if (server !== null) {
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    await rm(tmp, { recursive: true, force: true });
    // Keep build details in the full log; CI parses the dedicated result file.
    if (buildOutput.trim().length > 0) {
      console.log("test:webgpu: renderer build output:\n" + buildOutput.trimEnd());
    }
  }
}

// Run as a CLI only when this file is the entry module; importing it from
// tests (parseResultMarker) must not launch a browser.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch(async (error) => {
    await publishResult(`${MARKER_FAIL} runner failed: ${error}`).catch(() => {});
    process.exit(1);
  });
}
