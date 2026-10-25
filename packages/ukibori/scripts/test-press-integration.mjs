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
const marker = /UKIBORI_PRESS_INTEGRATION_(?:PASS|FAIL)/;
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

  const temp = await mkdtemp(join(tmpdir(), "ukibori-react-press-integration-"));
  let server;
  let browser;
  try {
    const requireFromRepo = createRequire(join(repoRoot, "package.json"));
    await requireFromRepo("esbuild").build({
      entryPoints: [join(pkgRoot, "test-browser", "press-integration.tsx")],
      bundle: true,
      alias: { ukibori: join(pkgRoot, "src", "index.ts") },
      format: "esm",
      platform: "browser",
      target: "chrome120",
      outfile: join(temp, "press-integration-app.js"),
    });
    await writeFile(join(temp, "press-integration.html"), await readFile(join(pkgRoot, "test-browser", "press-integration.html")));
    server = createServer((req, res) => {
      const name = new URL(req.url ?? "/", "http://127.0.0.1").pathname.slice(1) || "press-integration.html";
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
      "--headless=new", "--enable-unsafe-webgpu", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--force-device-scale-factor=1", "--window-size=800,600",
      ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
      `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
      `http://127.0.0.1:${port}/press-integration.html${process.env.DYNAMIC_GRAIN === "1" ? "?grain=1" : ""}`,
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
    const evaluate = async expression => {
      const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.result?.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails));
      return response.result?.result?.value;
    };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitForProbe = async (search) => {
      const readyUntil = Date.now() + 20000;
      const ready = `Boolean(window.pressProbe)${search ? ` && location.search === ${JSON.stringify(search)}` : ""}`;
      while (!await evaluate(ready) && Date.now() < readyUntil) await pause(25);
      if (!await evaluate(ready)) throw new Error("press fixture not ready");
    };
    await waitForProbe();
    await send("Page.bringToFront");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const rows = [];
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const state = () => evaluate("window.pressProbe.state()");
    const key = (type, value, code, vk) => send("Input.dispatchKeyEvent", { type, key: value, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    for (const backend of ["webgpu", "cpu", "css"]) {
      const prepared = await evaluate(`window.pressProbe.prepare(${JSON.stringify(backend)})`);
      check(prepared.backend === backend, `requested ${backend}, got ${prepared.backend}`);
      check(prepared.sameNode, "hydration replaced the button");
      await key("keyDown", "Tab", "Tab", 9); await key("keyUp", "Tab", "Tab", 9);
      let focused = await state();
      if (!focused.focused) { await evaluate("document.querySelector('button').focus()"); focused = await state(); }
      check(focused.focused && focused.focusVisible, `${backend} keyboard focus-visible`);
      const before = await state();
      await key("keyDown", " ", "Space", 32); await pause(45); const mid = await state();
      check(mid.progress > 0 && mid.progress < 1, `${backend} no intermediate press ${JSON.stringify(mid)}`);
      await pause(250); check((await state()).progress === 1, `${backend} press incomplete: ${JSON.stringify(await state())}`);
      await key("keyUp", " ", "Space", 32); await pause(250); const selected = await state();
      check(selected.pressed !== before.pressed && selected.clicks === before.clicks + 1, `${backend} native Space activation failed`);
      check(selected.progress === (selected.pressed === "true" ? 0.375 : 0), `${backend} selected transition incomplete`);
      // Trusted touch input; a browser-generated pointercancel follows touchCancel.
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: selected.x, y: selected.y, id: 1 }] });
      await pause(250); check((await state()).progress === 1, `${backend} touch press`);
      await send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      await pause(200); check((await state()).progress < 1, `${backend} touch cancel stuck`);
      const idle = await evaluate("window.pressProbe.idle()");
      const reduced = await evaluate(`window.pressProbe.prepare(${JSON.stringify(backend)}, true)`);
      await key("keyDown", "Enter", "Enter", 13); await pause(10); check((await state()).progress === 1, `${backend} reduced-motion not immediate`);
      await key("keyUp", "Enter", "Enter", 13);
      const disabled = await evaluate(`window.pressProbe.prepare(${JSON.stringify(backend)}, true, true)`);
      check(disabled.disabled && disabled.progress === 0, `${backend} disabled stayed pressed`);
      rows.push({ backend, mid, selected, idle, reduced, disabled });
    }
    const disposed = [];
    for (const backend of ["webgpu", "cpu"]) {
      if (disposed.length) {
        await send("Page.navigate", { url: `http://127.0.0.1:${port}/press-integration.html?unmount=${backend}` });
        await waitForProbe(`?unmount=${backend}`);
      }
      const beforeUnmount = await evaluate(`window.pressProbe.prepare(${JSON.stringify(backend)}, false, false)`);
      await evaluate("document.querySelector('button').focus()");
      await key("keyDown", " ", "Space", 32); await pause(35);
      const transition = await state();
      check(transition.progress > beforeUnmount.progress && transition.progress < 1, `${backend} unmount probe did not start a transition`);
      disposed.push({ backend, ...await evaluate("window.pressProbe.finish()") });
    }
    await evaluate(`document.getElementById('result').textContent = 'UKIBORI_PRESS_INTEGRATION_PASS\\n' + JSON.stringify(${JSON.stringify({ rows, disposed })}, null, 2)`);
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
    if (process.env.PRESS_RESULT_PATH) await writeFile(resolve(repoRoot, process.env.PRESS_RESULT_PATH), output);
    console.log(output || "UKIBORI_PRESS_INTEGRATION_FAIL no result");
    process.exitCode = output.startsWith("UKIBORI_PRESS_INTEGRATION_PASS") ? 0 : 1;
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

main().catch((error) => { console.error(`UKIBORI_PRESS_INTEGRATION_FAIL ${error}`); process.exit(1); });
