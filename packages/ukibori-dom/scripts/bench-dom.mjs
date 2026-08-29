#!/usr/bin/env node
// #46 DOM integration benchmark runner (npm run bench:dom -w ukibori-dom).
//
//   1. builds ukibori-renderer + bundles the dom harness (dom-bench.mjs +
//      ukibori-dom source) with esbuild
//   2. serves the isolated bundle on 127.0.0.1 and runs headless Chrome
//      (GPU never disabled; the DOM benchmark runs the CPU control backend
//      so the numbers isolate DOM measurement from GPU work)
//   3. parses the `SUMMARY <json>` line and writes the versioned result
//      document to --json (default benchmark-results-dom.json)
//
// Usage:
//   node scripts/bench-dom.mjs [--surfaces 1,10,100,500] [--json out.json]

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitCommitSync, gitStatusPorcelain, isWorkingTreeDirty } from "../../renderer/scripts/bench/lib/env-node.mjs";

const MARKER_PASS = "UKIBORI_DOM_BENCH_PASS";
const MARKER_FAIL = "UKIBORI_DOM_BENCH_FAIL";
const MARKER_SKIP = "UKIBORI_DOM_BENCH_SKIP";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pkgRoot, "..", "..");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const surfacesArg = flag("--surfaces", process.env.BENCH_DOM_SURFACES ?? "1,10,50,100,250,500,1000");
const samplesArg = flag("--samples", process.env.BENCH_SAMPLES ?? "5");
const warmupArg = flag("--warmup", process.env.BENCH_WARMUP ?? "5");
const allowDirty = args.includes("--allow-dirty") || process.env.BENCH_ALLOW_DIRTY === "1";
const jsonPath = flag("--json", join(pkgRoot, "benchmark-results-dom.json"));

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

async function bundleHarness(outfile) {
  const requireFromRepo = createRequire(join(repoRoot, "package.json"));
  const esbuild = requireFromRepo("esbuild");
  const benchLib = join(repoRoot, "packages", "renderer", "scripts", "bench", "lib");
  await esbuild.build({
    entryPoints: [join(pkgRoot, "test-browser", "dom-bench.mjs")],
    bundle: true,
    format: "esm",
    target: "chrome120",
    platform: "browser",
    outfile,
    logLevel: "silent",
    loader: { ".ts": "ts" },
    alias: {
      "@ukibori-bench/stats": join(benchLib, "stats.mjs"),
      "@ukibori-bench/schema": join(benchLib, "schema.mjs"),
    },
  });
}

async function main() {
  if (!existsSync(CHROME)) {
    console.error(
      `${MARKER_SKIP} headless Chrome not found at ${CHROME} ` +
        "(set CHROME_PATH); the DOM benchmark cannot run on this machine",
    );
    process.exit(1);
  }
  const rendererBundle = join(repoRoot, "packages", "renderer", "dist", "index.js");
  if (!existsSync(rendererBundle)) {
    console.error(
      `${MARKER_FAIL} renderer bundle not found at ${rendererBundle}  - run ` +
        "`npm run build -w ukibori-renderer` first",
    );
    process.exit(1);
  }

  const tmp = await mkdtemp(join(tmpdir(), "ukibori-bench-dom-"));
  let server = null;
  let chrome = null;
  let cdp = null;
  try {
    console.log(`bench:dom: preparing temp dir ${tmp}`);
    const profileDir = join(tmp, "chrome-profile");
    await mkdir(profileDir, { recursive: true });
    await bundleHarness(join(tmp, "dom-bench-app.js"));
    await writeFile(join(tmp, "dom-bench.html"), await readFile(join(pkgRoot, "test-browser", "dom-bench.html")), "utf8");

    server = createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
      const relative = pathname === "/" ? "dom-bench.html" : pathname.replace(/^\/+/, "");
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
    console.log(`bench:dom: serving on 127.0.0.1:${port}`);

    const cdpPort = await freePort();
    const query = new URLSearchParams({ surfaces: surfacesArg, samples: samplesArg, warmup: warmupArg });
    const url = `http://127.0.0.1:${port}/dom-bench.html?${query}`;
    chrome = spawn(
      CHROME,
      [...CHROME_FLAGS, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, url],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    console.log(`bench:dom: chrome spawned, url=${url}`);
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
        target = targets.find((t) => t.type === "page" && t.url.includes("dom-bench.html")) ?? null;
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
          }
        },
      });
      await cdp.ready;
      await cdp.send("Runtime.enable");
      const deadline = Date.now() + RESULT_TIMEOUT_MS;
      while (result === null && Date.now() < deadline && chrome.exitCode === null) {
        const response = await cdp.send("Runtime.evaluate", {
          expression: `document.getElementById("result") ? document.getElementById("result").textContent : ""`,
          returnByValue: true,
        });
        const text = response.result?.result?.value;
        if (typeof text === "string" && /^UKIBORI_DOM_BENCH_(?:PASS|FAIL|SKIP)/.test(text.split("\n", 1)[0])) {
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
      const commit = gitCommitSync();
      const dirty = isWorkingTreeDirty({ porcelain: gitStatusPorcelain() });
      if (dirty && !allowDirty) {
        console.error(
          `${MARKER_FAIL} working tree is DIRTY: a baseline must be generated on a clean tree ` +
            `(pass --allow-dirty for dev runs)`,
        );
        console.error(gitStatusPorcelain().split("\n").slice(0, 10).join("\n"));
        process.exitCode = 1;
        return;
      }
      payload.commit = commit;
      payload.workingTreeDirty = dirty;
      await mkdir(dirname(jsonPath), { recursive: true });
      await writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
      console.log(
        `bench:dom: wrote ${jsonPath}  - ${payload.cases.length} cases, schema v${payload.schemaVersion}, ` +
          `commit ${payload.commit}, workingTreeDirty=${payload.workingTreeDirty}`, 
      );
      process.exitCode = 0;
    } else if (marker === MARKER_SKIP) {
      console.error("bench:dom: SKIP  - only a real-adapter PASS counts");
      process.exitCode = 1;
    } else {
      console.error("bench:dom: FAIL");
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