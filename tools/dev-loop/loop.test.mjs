import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_IMPLEMENTATION_TIMEOUT_MS,
  DEFAULT_REVIEW_TIMEOUT_MS,
  MAX_REVIEW_PATHS,
  parseReview,
  runLoop,
  runProcess,
  sessionIdFromJsonl,
  validateConfig,
  validateShellCommand,
  verify
} from "./loop.mjs";
import { argumentsFrom, usage } from "./cli.mjs";

test("extracts an OpenCode session id from nested JSONL events", () => {
  const output = [
    JSON.stringify({ type: "start", properties: { sessionID: "ses_123" } }),
    "diagnostic text",
    JSON.stringify({ type: "text", properties: { text: "done" } })
  ].join("\n");
  assert.equal(sessionIdFromJsonl(output), "ses_123");
});

test("accepts a structured Codex decision", () => {
  const review = parseReview(JSON.stringify({
    decision: "revise",
    summary: "Tests are missing",
    findings: [{ severity: "major", message: "Add boundary tests" }],
    next_instruction: "Add boundary tests and rerun verification"
  }));
  assert.equal(review.decision, "revise");
});

test("rejects malformed or extended Codex decisions", () => {
  assert.throws(() => parseReview(JSON.stringify({
    decision: "approve",
    summary: "ok",
    findings: [],
    next_instruction: "",
    extra: true
  })));
  assert.throws(() => parseReview(JSON.stringify({
    decision: "revise",
    summary: "needs work",
    findings: [],
    next_instruction: ""
  })));
});

test("rejects an unknown Codex decision", () => {
  assert.throws(() => parseReview(JSON.stringify({
    decision: "maybe",
    summary: "unknown",
    findings: [],
    next_instruction: ""
  })));
});

test("validates safe defaults and rejects mutating verification commands", () => {
  const config = validateConfig({
    checkpoint: "CP1",
    verificationCommands: ["npm test"]
  });
  assert.equal(config.model, "opencode-go/deepseek-v4-flash");
  assert.equal(config.maxIterations, 5);
  assert.equal(config.implementationTimeoutMs, DEFAULT_IMPLEMENTATION_TIMEOUT_MS);
  assert.equal(config.reviewTimeoutMs, DEFAULT_REVIEW_TIMEOUT_MS);
  assert.deepEqual(validateConfig({
    checkpoint: "CP1",
    reviewPaths: ["packages/renderer", "tools/dev-loop/*.mjs"],
    verificationCommands: ["npm test"]
  }).reviewPaths, ["packages/renderer", "tools/dev-loop/*.mjs"]);
  assert.throws(() => validateShellCommand("git commit -m forbidden"));
  assert.throws(() => validateShellCommand("rm -rf ./temporary"));
  assert.throws(() => validateShellCommand("npm test\n git status"));
  assert.throws(() => validateConfig({
    checkpoint: "CP7",
    verificationCommands: ["npm test"]
  }));
  for (const reviewPaths of [
    [],
    [""],
    ["/tmp/outside"],
    ["../outside"],
    ["nested/../outside"],
    ["nested/\u0001file"],
    ["C:\\outside"]
  ]) {
    assert.throws(() => validateConfig({ checkpoint: "CP1", reviewPaths, verificationCommands: ["npm test"] }));
  }
  assert.throws(() => validateConfig({
    checkpoint: "CP1",
    reviewPaths: Array.from({ length: MAX_REVIEW_PATHS + 1 }, (_, index) => `path-${index}`),
    verificationCommands: ["npm test"]
  }));
  assert.throws(() => validateConfig({
    checkpoint: "CP1",
    implementationTimeoutMs: 0,
    verificationCommands: ["npm test"]
  }));
  assert.throws(() => validateConfig({
    checkpoint: "CP1",
    reviewTimeoutMs: Infinity,
    verificationCommands: ["npm test"]
  }));
  assert.throws(() => validateConfig({
    checkpoint: "CP1",
    implementationTimeoutMs: 1.5,
    verificationCommands: ["npm test"]
  }));
  expectIssueTask(validateConfig({
    checkpoint: "ISSUE-22",
    verificationCommands: ["npm test"]
  }).checkpoint);
});

function expectIssueTask(value) {
  assert.equal(value, "ISSUE-22");
}

test("stops verification commands after the first non-zero result", async () => {
  const commands = [];
  const result = await verify(
    "/tmp/repo",
    ["first-check", "second-check"],
    async (command, args) => {
      commands.push([command, args]);
      return { code: 1, signal: null, stdout: "failed", stderr: "" };
    },
    () => {}
  );
  assert.equal(result.passed, false);
  assert.equal(result.results.length, 1);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], ["/bin/zsh", ["-lc", "first-check"]]);
});

test("continues the same OpenCode session through revise and records the loop", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ukibori-dev-loop-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "brief.md"), "# test brief\n");

  const calls = [];
  let implementationCount = 0;
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === "opencode") {
      implementationCount += 1;
      return {
        code: 0,
        signal: null,
        stdout: `${JSON.stringify({ sessionID: "ses_test" })}\n`,
        stderr: ""
      };
    }
    if (command === "/bin/zsh") return { code: 0, signal: null, stdout: "ok", stderr: "" };
    if (command === "git") {
      if (args[0] === "status") return { code: 0, signal: null, stdout: " M source.ts\n", stderr: "" };
      if (args[0] === "ls-files") return { code: 0, signal: null, stdout: "", stderr: "" };
      return { code: 0, signal: null, stdout: "diff --git a/source.ts b/source.ts\n", stderr: "" };
    }
    if (command === "codex") {
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      await writeFile(outputPath, JSON.stringify({
        decision: implementationCount === 1 ? "revise" : "approve",
        summary: implementationCount === 1 ? "Please improve it" : "Looks complete",
        findings: [],
        next_instruction: implementationCount === 1 ? "Improve it and rerun checks" : ""
      }));
      return { code: 0, signal: null, stdout: "review event", stderr: "" };
    }
    throw new Error(`unexpected command: ${command}`);
  };

  const result = await runLoop({
    cwd,
    brief: "brief.md",
    checkpoint: "CP1",
    maxIterations: 2,
    model: "opencode-go/deepseek-v4-flash",
    variant: "max",
    implementationTimeoutMs: 1234,
    reviewTimeoutMs: 5678,
    verificationCommands: ["npm test"]
  }, { runner, emit: () => {} });

  assert.equal(result.status, "approved");
  assert.equal(result.iteration, 2);
  const opencodeCalls = calls.filter(({ command }) => command === "opencode");
  assert.equal(opencodeCalls.length, 2);
  assert.equal(opencodeCalls[0].options.timeoutMs, 1234);
  assert.equal(opencodeCalls[1].options.timeoutMs, 1234);
  assert.equal(opencodeCalls[0].args.includes("--auto"), true);
  assert.equal(opencodeCalls[0].args.includes("--session"), false);
  const sessionOption = opencodeCalls[1].args.indexOf("--session");
  assert.equal(opencodeCalls[1].args[sessionOption + 1], "ses_test");
  const codexCall = calls.find(({ command }) => command === "codex");
  assert.equal(codexCall.args.includes("read-only"), true);
  assert.equal(codexCall.args.includes("--auto"), false);
  assert.equal(codexCall.options.timeoutMs, 5678);
  assert.match(await readFile(path.join(cwd, ".codex-loop", "state.json"), "utf8"), /"status": "approve"/);
  assert.match(await readFile(path.join(cwd, ".codex-loop", "logs", "iteration-2-review.json"), "utf8"), /Looks complete/);
});

test("limits every Git evidence command to configured review pathspecs", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ukibori-dev-loop-paths-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "brief.md"), "# test brief\n");
  await writeFile(path.join(cwd, "allowed.txt"), "allowed evidence\n");
  await writeFile(path.join(cwd, "outside.txt"), "outside evidence\n");

  const gitCalls = [];
  const runner = async (command, args) => {
    if (command === "git") {
      gitCalls.push(args);
      if (args[0] === "ls-files") return { code: 0, signal: null, stdout: "allowed.txt\n", stderr: "" };
      return { code: 0, signal: null, stdout: "", stderr: "" };
    }
    if (command === "opencode") {
      return { code: 0, signal: null, stdout: `${JSON.stringify({ sessionID: "ses_paths" })}\n`, stderr: "" };
    }
    if (command === "/bin/zsh") return { code: 0, signal: null, stdout: "ok", stderr: "" };
    if (command === "codex") {
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      await writeFile(outputPath, JSON.stringify({
        decision: "approve",
        summary: "Scoped evidence is complete",
        findings: [],
        next_instruction: ""
      }));
      return { code: 0, signal: null, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${command}`);
  };

  const result = await runLoop({
    cwd,
    brief: "brief.md",
    checkpoint: "CP1",
    reviewPaths: ["allowed.txt", "tools/dev-loop"],
    verificationCommands: ["npm test"]
  }, { runner, emit: () => {} });

  assert.equal(result.status, "approved");
  const expectedPathspec = ["--", "allowed.txt", "tools/dev-loop"];
  assert.deepEqual(gitCalls, [
    ["status", "--short", ...expectedPathspec],
    ["status", "--short", ...expectedPathspec],
    ["diff", "--stat", "HEAD", "--no-ext-diff", ...expectedPathspec],
    ["diff", "HEAD", "--no-ext-diff", ...expectedPathspec],
    ["ls-files", "--others", "--exclude-standard", ...expectedPathspec]
  ]);
  const evidence = await readFile(path.join(cwd, ".codex-loop", "logs", "iteration-1-evidence.json"), "utf8");
  assert.match(evidence, /allowed evidence/);
  assert.doesNotMatch(evidence, /outside evidence/);
});

test("records an OpenCode timeout in state and failure log", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ukibori-dev-loop-timeout-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "brief.md"), "# test brief\n");

  const runner = async (command) => {
    if (command === "git") return { code: 0, signal: null, stdout: "", stderr: "" };
    if (command === "opencode") {
      return { code: null, signal: "SIGTERM", timedOut: true, stdout: "partial stream", stderr: "" };
    }
    throw new Error(`unexpected command: ${command}`);
  };

  await assert.rejects(runLoop({
    cwd,
    brief: "brief.md",
    checkpoint: "CP1",
    implementationTimeoutMs: 37,
    verificationCommands: ["npm test"]
  }, { runner, emit: () => {} }), /OpenCode timed out after 37ms/);

  const state = JSON.parse(await readFile(path.join(cwd, ".codex-loop", "state.json"), "utf8"));
  assert.equal(state.status, "failed");
  assert.match(state.error.message, /OpenCode timed out after 37ms/);
  assert.match(
    await readFile(path.join(cwd, ".codex-loop", "logs", "iteration-1-failure.log"), "utf8"),
    /opencode: OpenCode timed out after 37ms/
  );
});

test("runProcess terminates and marks a process that exceeds its timeout", async () => {
  const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 25 });
  assert.equal(result.timedOut, true);
});

test("stops after the configured maximum number of revisions", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ukibori-dev-loop-max-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "brief.md"), "# test brief\n");
  let implementationCount = 0;
  const runner = async (command, args) => {
    if (command === "opencode") {
      implementationCount += 1;
      return { code: 0, signal: null, stdout: `${JSON.stringify({ sessionID: "ses_max" })}\n`, stderr: "" };
    }
    if (command === "/bin/zsh") return { code: 0, signal: null, stdout: "ok", stderr: "" };
    if (command === "git") return { code: 0, signal: null, stdout: "", stderr: "" };
    if (command === "codex") {
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      await writeFile(outputPath, JSON.stringify({
        decision: "revise",
        summary: "Still needs work",
        findings: [{ severity: "minor", message: "Keep checking" }],
        next_instruction: "Keep checking"
      }));
      return { code: 0, signal: null, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${command}`);
  };

  const result = await runLoop({
    cwd,
    brief: "brief.md",
    checkpoint: "CP1",
    maxIterations: 2,
    verificationCommands: ["npm test"]
  }, { runner, emit: () => {} });

  assert.deepEqual(result, { status: "max_iterations", iteration: 2, sessionId: "ses_max" });
  assert.equal(implementationCount, 2);
  assert.match(await readFile(path.join(cwd, ".codex-loop", "state.json"), "utf8"), /"status": "max_iterations"/);
});

test("parses CLI overrides and advertises the DeepSeek default", () => {
  assert.deepEqual(argumentsFrom(["--checkpoint=CP2", "--max-iterations", "3"]), {
    checkpoint: "CP2",
    "max-iterations": "3"
  });
  assert.match(usage(), /opencode-go\/deepseek-v4-flash/);
  assert.throws(() => argumentsFrom(["--unknown"]));
});
