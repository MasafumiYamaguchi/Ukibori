#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const chrome = process.env.CHROME_PATH ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "/usr/bin/google-chrome");
const marker = /UKIBORI_REACT_GPU_PROFILING_(?:PASS|FAIL)/;
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function freePort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const port = probe.address().port;
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

async function main() {
  if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const workspace of ["ukibori-renderer", "ukibori-dom"]) {
    const built = spawnSync(npm, ["run", "build", "-w", workspace], { cwd: repoRoot, stdio: "inherit" });
    if (built.status !== 0) throw new Error(`${workspace} build failed`);
  }

  const temp = await mkdtemp(join(tmpdir(), "ukibori-react-gpu-profiling-"));
  let server;
  let browser;
  try {
    const requireFromRepo = createRequire(join(repoRoot, "package.json"));
    await requireFromRepo("esbuild").build({
      entryPoints: [join(pkgRoot, "test-browser", "gpu-profiling.tsx")],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "chrome120",
      outfile: join(temp, "gpu-profiling-app.js"),
    });
    await writeFile(join(temp, "gpu-profiling.html"), await readFile(join(pkgRoot, "test-browser", "gpu-profiling.html")));
    server = createServer((req, res) => {
      const name = new URL(req.url ?? "/", "http://127.0.0.1").pathname.slice(1) || "gpu-profiling.html";
      readFile(join(temp, name)).then((body) => {
        res.writeHead(200, { "Content-Type": extname(name) === ".html" ? "text/html" : "text/javascript" });
        res.end(body);
      }).catch(() => { res.writeHead(404); res.end(); });
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = server.address().port;
    const cdpPort = await freePort();
    const profile = join(temp, "profile");
    await mkdir(profile);
    browser = spawn(chrome, [
      "--headless=new", "--enable-unsafe-webgpu",
      ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
      `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
      `http://127.0.0.1:${port}/gpu-profiling.html`,
    ], { stdio: "ignore" });

    let target;
    const targetDeadline = Date.now() + 60_000;
    while (!target && Date.now() < targetDeadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        target = list.find((item) => item.type === "page");
      } catch {}
      if (!target) await sleep(150);
    }
    if (!target) throw new Error("Chrome DevTools target unavailable");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolveOpen, rejectOpen) => { socket.onopen = resolveOpen; socket.onerror = rejectOpen; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    };
    const send = (method, params = {}) => new Promise((resolveSend) => {
      const requestId = ++id;
      pending.set(requestId, resolveSend);
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const deadline = Date.now() + 180_000;
    let output = "";
    while (!marker.test(output) && Date.now() < deadline) {
      const response = await send("Runtime.evaluate", {
        expression: "document.getElementById('result')?.textContent ?? ''", returnByValue: true,
      });
      output = response.result?.result?.value ?? "";
      if (!marker.test(output)) await sleep(200);
    }
    socket.close();
    console.log(output || "UKIBORI_REACT_GPU_PROFILING_FAIL no result");
    process.exitCode = output.startsWith("UKIBORI_REACT_GPU_PROFILING_PASS") ? 0 : 1;
  } finally {
    if (browser && browser.exitCode === null) {
      const exited = new Promise((resolveExit) => browser.once("exit", resolveExit));
      browser.kill("SIGKILL");
      await Promise.race([exited, sleep(10_000)]);
    }
    if (server) await new Promise((resolveClose) => server.close(resolveClose));
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(`UKIBORI_REACT_GPU_PROFILING_FAIL ${error}`); process.exit(1); });
