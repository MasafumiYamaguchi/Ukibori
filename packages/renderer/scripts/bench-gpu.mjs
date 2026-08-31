#!/usr/bin/env node
// #46 real-WebGPU benchmark runner (npm run bench:gpu -w ukibori-renderer).
//
//   1. builds `ukibori-renderer` FIRST and serves the built ESM + the
//      benchmark harness (test-browser/bench-gpu.mjs) from an isolated temp
//      directory on 127.0.0.1
//   2. runs headless Chrome with `--enable-unsafe-webgpu` (GPU NEVER
//      disabled) against bench-gpu.html?suite=<suite>&samples=<n>
//   3. parses the `SUMMARY <json>` line (a versioned benchmark result
//      document, scripts/bench/lib/schema.mjs) and writes it to the
//      requested --json path (default benchmark-results.json in the package
//      root)
//   4. exits 0 on a real-adapter PASS; FAIL/SKIP exit nonzero
//
// Usage:
//   node scripts/bench-gpu.mjs [--suite stage,e2e] [--samples 10]
//        [--json benchmark-results.json] [--width 640] [--height 360]
// Restricted desktop/CI hosts may opt into the diagnostic
// BENCH_CHROME_NO_SANDBOX=1 environment variable; the default remains
// sandboxed.
//
// Suites: stage, e2e, resolution, surface, mask, shadow, reconstruction,
// presentation, submission, upload, partial, retained (default: all).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitCommitSync, gitStatusPorcelain, isWorkingTreeDirty } from "./bench/lib/env-node.mjs";

const MARKER_PASS = "UKIBORI_BENCH_GPU_PASS";
const MARKER_FAIL = "UKIBORI_BENCH_GPU_FAIL";
const MARKER_SKIP = "UKIBORI_BENCH_GPU_SKIP";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const suiteArg = flag("--suite", process.env.BENCH_SUITE ?? "all");
const allowDirty = args.includes("--allow-dirty") || process.env.BENCH_ALLOW_DIRTY === "1";
const samplesArg = flag("--samples", process.env.BENCH_SAMPLES ?? "5");
const warmupArg = flag("--warmup", process.env.BENCH_WARMUP ?? "3");
const widthArg = flag("--width", process.env.BENCH_WIDTH ?? "640");
const heightArg = flag("--height", process.env.BENCH_HEIGHT ?? "360");
const retainedArg = flag("--retained-frames", process.env.BENCH_RETAINED_FRAMES ?? "20");
const jsonPath = flag("--json", join(pkgRoot, "benchmark-results.json"));

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
  // Restricted CI/desktop sandboxes can prevent Chrome's GPU process from
  // creating its profile/sandbox broker. Opt in explicitly for those hosts;
  // the default benchmark remains sandboxed.
  ...(process.env.BENCH_CHROME_NO_SANDBOX === "1"
    ? ["--no-sandbox", "--disable-gpu-sandbox"]
    : []),
  ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
  "--no-first-run",
  "--no-default-browser-check",
];

const RESULT_TIMEOUT_MS = 600_000;
const CHROME_TIMEOUT_MS = 720_000;
const CDP_TARGET_TIMEOUT_MS = 60_000;
const CHROME_EXIT_WAIT_MS = 10_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
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
    // already exited
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

function parseSummaryLine(text) {
  const line = String(text)
    .split("\n")
    .find((l) => l.startsWith("SUMMARY "));
  if (line === undefined) {
    return null;
  }
  try {
    return JSON.parse(line.slice("SUMMARY ".length));
  } catch {
    return null;
  }
}

async function main() {
  if (!existsSync(CHROME)) {
    console.error(
      `${MARKER_SKIP} headless Chrome not found at ${CHROME} ` +
        "(set CHROME_PATH); the GPU benchmark cannot run on this machine",
    );
    process.exit(1);
  }
  const bundle = join(pkgRoot, "dist", "index.js");
  if (!existsSync(bundle)) {
    console.error(
      `${MARKER_FAIL} bundle not found at ${bundle} - run ` +
        "`npm run build -w ukibori-renderer` first",
    );
    process.exit(1);
  }

  const tmp = await mkdtemp(join(tmpdir(), "ukibori-bench-gpu-"));
  let server = null;
  let chrome = null;
  let cdp = null;
  try {
    console.log(`bench:gpu: preparing temp dir ${tmp}`);
    const profileDir = join(tmp, "chrome-profile");
    await mkdir(profileDir, { recursive: true });
    await mkdir(join(tmp, "lib"), { recursive: true });
    // harness + shared bench library + the built public ESM
    for (const file of [
      "bench-gpu.html",
      "bench-gpu.mjs",
      "lib/scenes.mjs",
      "lib/stats.mjs",
      "lib/schema.mjs",
      "lib/env-browser.mjs",
      "lib/presentation-shader.mjs",
    ]) {
      const source = join(pkgRoot, file.startsWith("lib/") ? "scripts/bench" : "test-browser", file);
      const bytes = await readFile(source);
      await writeFile(join(tmp, file), bytes, "utf8");
    }
    await writeFile(join(tmp, "index.js"), await readFile(bundle), "utf8");

    server = createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
      const relative = pathname === "/" ? "bench-gpu.html" : pathname.replace(/^\/+/, "");
      const file = resolve(tmp, relative);
      if (!file.startsWith(resolve(tmp))) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("forbidden");
        return;
      }
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
    console.log(`bench:gpu: serving on 127.0.0.1:${port}`);

    const cdpPort = await freePort();
    const query = new URLSearchParams({
      suite: suiteArg,
      samples: samplesArg,
      warmup: warmupArg,
      width: widthArg,
      height: heightArg,
      retainedFrames: retainedArg,
    });
    const url = `http://127.0.0.1:${port}/bench-gpu.html?${query}`;
    chrome = spawn(
      CHROME,
      [...CHROME_FLAGS, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, url],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    console.log(`bench:gpu: chrome spawned, url=${url}`);
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

    let target = null;
    const targetDeadline = Date.now() + CDP_TARGET_TIMEOUT_MS;
    while (target === null && Date.now() < targetDeadline && chrome.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
        const targets = await response.json();
        target = targets.find((t) => t.type === "page" && t.url.includes("bench-gpu.html")) ?? null;
      } catch {
        // chrome not ready yet
      }
      if (target === null) {
        await sleep(150);
      }
    }

    let result = null;
    const pageErrors = [];
    if (target !== null) {
      cdp = connectCdp(target.webSocketDebuggerUrl, {
        onMessage: (message) => {
          if (message.method === "Runtime.exceptionThrown") {
            const details = message.params?.exceptionDetails;
            pageErrors.push(
              `exception: ${details?.exception?.description ?? details?.text ?? "unknown"}`,
            );
          } else if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
            pageErrors.push(
              `console.error: ${message.params.args?.map((a) => a.value ?? a.description ?? "").join(" ")}`,
            );
          }
        },
      });
      await cdp.ready;
      await cdp.send("Runtime.enable");
      await cdp.send("Log.enable");
      const deadline = Date.now() + RESULT_TIMEOUT_MS;
      while (result === null && Date.now() < deadline && chrome.exitCode === null) {
        const response = await cdp.send("Runtime.evaluate", {
          expression: `document.getElementById("result") ? document.getElementById("result").textContent : ""`,
          returnByValue: true,
        });
        const text = response.result?.result?.value;
        if (typeof text === "string" && /^UKIBORI_BENCH_GPU_(?:PASS|FAIL|SKIP)/.test(text.split("\n", 1)[0])) {
          result = text;
          break;
        }
        await sleep(200);
      }
    }
    clearTimeout(killTimer);

    if (result === null) {
      const trace = chromeStderr.trim().split("\n").slice(-15).join("\n");
      console.error(
        `${MARKER_FAIL} harness produced no result within ${RESULT_TIMEOUT_MS}ms` +
          (pageErrors.length > 0 ? `\npage errors:\n${pageErrors.join("\n")}` : "") +
          (trace.length > 0 ? `\nchrome stderr tail:\n${trace}` : ""),
      );
      process.exitCode = 1;
      return;
    }

    const firstLine = result.split("\n", 1)[0].trim();
    console.log(firstLine);
    const marker = firstLine.split(" ", 1)[0];

if (marker === MARKER_PASS) {
      const payload = parseSummaryLine(result);
      if (payload === null || !Array.isArray(payload.cases)) {
        console.error(`${MARKER_FAIL} harness PASSed but produced no parseable result document`);
        process.exitCode = 1;
        return;
      }
      // merge the node-side commit + dirty-tree provenance into the
      // browser-side document so the saved JSON always carries the exact
      // tested commit and the cleanliness of the generating tree
      const commit = gitCommitSync();
      const dirty = isWorkingTreeDirty({ porcelain: gitStatusPorcelain() });
      if (dirty && !allowDirty) {
        console.error(
          `${MARKER_FAIL} working tree is DIRTY: a baseline must be generated on a clean tree ` +
            `so git checkout <commit> reproduces the runner (pass --allow-dirty for dev runs)`,
        );
        console.error(gitStatusPorcelain().split("\n").slice(0, 10).join("\n"));
        process.exitCode = 1;
        return;
      }
      const doc = payload;
      doc.commit = commit;
      doc.workingTreeDirty = dirty;
      await mkdir(dirname(jsonPath), { recursive: true });
      await writeFile(jsonPath, JSON.stringify(doc, null, 2), "utf8");
      console.log(
        `bench:gpu: wrote ${jsonPath} — ${doc.cases.length} cases, schema v${doc.schemaVersion}, ` +
          `commit ${doc.commit}, workingTreeDirty=${doc.workingTreeDirty}`,
      );
      console.log(`bench:gpu: adapter=${doc.environment?.adapterName ?? "unknown"} backend=${doc.environment?.adapterBackend ?? "unknown"} timestamp-query=${doc.environment?.timestampQuerySupported ?? false}`);
      process.exitCode = 0;
    } else if (marker === MARKER_SKIP) {
      console.error("bench:gpu: SKIP - only a real-adapter PASS counts");
      console.error(result.split("\n").slice(1).join("\n"));
      process.exitCode = 1;
    } else {
      console.error("bench:gpu: FAIL");
      console.error(result.split("\n").slice(1).join("\n"));
      process.exitCode = 1;
    }
  } finally {
    if (cdp !== null) {
      cdp.close();
    }
    await terminateChrome(chrome);
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
    console.error(`${MARKER_FAIL} runner failed: ${error}`);
    process.exit(1);
  });
}
