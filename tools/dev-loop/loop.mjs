import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";
export const DEFAULT_VARIANT = "max";
export const DEFAULT_MAX_ITERATIONS = 5;
export const DEFAULT_IMPLEMENTATION_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_REVIEW_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_ITERATIONS = 50;
export const MAX_REVIEW_PATHS = 64;
export const MAX_TIMEOUT_MS = 2_147_483_647;
export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary", "findings", "next_instruction"],
  properties: {
    decision: { enum: ["approve", "revise", "blocked"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "message"],
        properties: {
          severity: { enum: ["critical", "major", "minor"] },
          message: { type: "string" }
        }
      }
    },
    next_instruction: { type: "string" }
  }
};

const CONFIG_KEYS = new Set([
  "brief",
  "checkpoint",
  "maxIterations",
  "model",
  "variant",
  "verificationCommands",
  "cwd",
  "reviewPaths",
  "implementationTimeoutMs",
  "reviewTimeoutMs"
]);
const CHECKPOINT_PATTERN = /^(?:CP[1-6]|ISSUE-[1-9]\d*)$/;
const MAX_VALUE_LENGTH = 256;
const MAX_COMMAND_LENGTH = 4096;
const MAX_PROCESS_OUTPUT_CHARS = 2_000_000;
const MAX_REVIEW_INPUT_CHARS = 180_000;
const MAX_UNTRACKED_FILE_CHARS = 40_000;
const PROCESS_KILL_GRACE_MS = 1_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;
const SHELL_PATH = "/bin/zsh";
const MUTATING_GIT_COMMAND =
  /\bgit\b[^;&|]*\b(?:add|am|apply|branch|checkout|cherry-pick|clean|commit|config|merge|mv|push|rebase|reset|restore|rm|stash|switch|tag|update-index)\b/i;
const DIRECT_DESTRUCTIVE_COMMAND = /(?:^|[;&|({])\s*(?:rm|rmdir)\s+(?:-[^;&|\s]*r[^;&|\s]*|--recursive)\b/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clipText(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} characters]`;
}

function outputText(result) {
  return `${result?.stdout ?? ""}${result?.stderr ?? ""}`;
}

function assertBoundedString(value, name, { allowWhitespace = true } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_VALUE_LENGTH) {
    throw new Error(`${name} must be a non-empty string of at most ${MAX_VALUE_LENGTH} characters`);
  }
  if (value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
  if (!allowWhitespace && /\s/.test(value)) {
    throw new Error(`${name} must not contain whitespace`);
  }
}

export function validateShellCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("verificationCommands must contain non-empty strings");
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`verification commands must be at most ${MAX_COMMAND_LENGTH} characters`);
  }
  if (command.includes("\0") || /[\r\n]/.test(command)) {
    throw new Error("verification commands must not contain NULs or newlines");
  }
  if (MUTATING_GIT_COMMAND.test(command) || DIRECT_DESTRUCTIVE_COMMAND.test(command)) {
    throw new Error("verification commands may not run mutating git or recursive removal commands");
  }
  return command.trim();
}

function validateTimeout(value, name) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`${name} must be a positive integer no greater than ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function validateReviewPath(value, index) {
  const name = `reviewPaths[${index}]`;
  assertBoundedString(value, name);
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
  if (
    path.isAbsolute(value) ||
    /^[\\/]/.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`${name} must be a repository-relative pathspec without ..`);
  }
  return value;
}

function validateReviewPaths(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("reviewPaths must be a non-empty array");
  }
  if (value.length > MAX_REVIEW_PATHS) {
    throw new Error(`reviewPaths must contain at most ${MAX_REVIEW_PATHS} pathspecs`);
  }
  return value.map(validateReviewPath);
}

export function validateConfig(input) {
  if (!isPlainObject(input)) throw new Error("loop config must be a JSON object");
  const unknownKeys = Object.keys(input).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`unknown loop config key: ${unknownKeys[0]}`);
  }

  const config = {
    brief: input.brief ?? "DEEPSEEK_IMPLEMENTATION_BRIEF.md",
    checkpoint: input.checkpoint,
    maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    model: input.model ?? DEFAULT_MODEL,
    variant: input.variant ?? DEFAULT_VARIANT,
    verificationCommands: input.verificationCommands,
    implementationTimeoutMs: input.implementationTimeoutMs === undefined
      ? DEFAULT_IMPLEMENTATION_TIMEOUT_MS
      : input.implementationTimeoutMs,
    reviewTimeoutMs: input.reviewTimeoutMs === undefined
      ? DEFAULT_REVIEW_TIMEOUT_MS
      : input.reviewTimeoutMs,
    ...(input.reviewPaths === undefined ? {} : { reviewPaths: input.reviewPaths }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd })
  };

  assertBoundedString(config.brief, "brief");
  if (path.isAbsolute(config.brief) || config.brief.split(/[\\/]/).includes("..")) {
    throw new Error("brief must be a repository-relative path");
  }
  assertBoundedString(config.checkpoint, "checkpoint", { allowWhitespace: false });
  if (!CHECKPOINT_PATTERN.test(config.checkpoint)) {
    throw new Error("checkpoint must be CP1 through CP6 or ISSUE-<number>");
  }
  if (!Number.isInteger(config.maxIterations) || config.maxIterations < 1 || config.maxIterations > MAX_ITERATIONS) {
    throw new Error(`maxIterations must be an integer from 1 through ${MAX_ITERATIONS}`);
  }
  assertBoundedString(config.model, "model", { allowWhitespace: false });
  assertBoundedString(config.variant, "variant", { allowWhitespace: false });
  if (!Array.isArray(config.verificationCommands) || config.verificationCommands.length === 0) {
    throw new Error("verificationCommands must be a non-empty array");
  }
  config.verificationCommands = config.verificationCommands.map(validateShellCommand);
  config.implementationTimeoutMs = validateTimeout(config.implementationTimeoutMs, "implementationTimeoutMs");
  config.reviewTimeoutMs = validateTimeout(config.reviewTimeoutMs, "reviewTimeoutMs");
  if (config.reviewPaths !== undefined) config.reviewPaths = validateReviewPaths(config.reviewPaths);
  if (config.cwd !== undefined) assertBoundedString(config.cwd, "cwd");
  return config;
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;
    const maxOutputChars = options.maxOutputChars ?? MAX_PROCESS_OUTPUT_CHARS;
    let timer;
    let killTimer;
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, PROCESS_KILL_GRACE_MS);
      }, options.timeoutMs);
    }
    const append = (current, chunk) => {
      const text = chunk.toString();
      if (current.length >= maxOutputChars) {
        truncated = true;
        return current;
      }
      if (current.length + text.length > maxOutputChars) {
        truncated = true;
        return current + text.slice(0, maxOutputChars - current.length);
      }
      return current + text;
    };
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
      options.onStdout?.(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
      options.onStderr?.(chunk.toString());
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      if (timedOut) {
        resolve({ code: null, signal: "SIGTERM", stdout, stderr, truncated, timedOut: true });
      } else {
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolve({ code, signal, stdout, stderr, truncated, timedOut });
    });
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

export function sessionIdFromJsonl(output) {
  const candidates = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["sessionID", "sessionId", "session_id"].includes(key) && typeof child === "string" && child.trim()) {
        candidates.push(child.trim());
      } else {
        visit(child);
      }
    }
  };
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line));
    } catch {
      // OpenCode can print non-JSON diagnostics alongside JSONL events.
    }
  }
  if (candidates.length === 0) {
    try {
      visit(JSON.parse(output));
    } catch {
      // A malformed or non-JSON response is handled by the missing-session check.
    }
  }
  return candidates.at(-1);
}

function assertExactKeys(value, expected, name) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unexpected or missing fields`);
  }
}

export function parseReview(text) {
  let review;
  try {
    review = JSON.parse(text);
  } catch (error) {
    throw new Error(`Codex review is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(review)) throw new Error("Codex review must be a JSON object");
  assertExactKeys(review, ["decision", "summary", "findings", "next_instruction"], "Codex review");
  if (!REVIEW_SCHEMA.properties.decision.enum.includes(review.decision)) {
    throw new Error(`Codex returned an unknown decision: ${review.decision}`);
  }
  if (typeof review.summary !== "string") throw new Error("Codex review summary must be a string");
  if (!Array.isArray(review.findings)) throw new Error("Codex review findings must be an array");
  for (const finding of review.findings) {
    if (!isPlainObject(finding)) throw new Error("Codex review findings must contain objects");
    assertExactKeys(finding, ["severity", "message"], "Codex review finding");
    if (!REVIEW_SCHEMA.properties.findings.items.properties.severity.enum.includes(finding.severity)) {
      throw new Error(`Codex returned an unknown finding severity: ${finding.severity}`);
    }
    if (typeof finding.message !== "string") throw new Error("Codex review finding message must be a string");
  }
  if (typeof review.next_instruction !== "string") {
    throw new Error("Codex review next_instruction must be a string");
  }
  if (review.decision === "revise" && review.next_instruction.trim().length === 0) {
    throw new Error("Codex revise decisions must include next_instruction");
  }
  return review;
}

async function readAgentInstructions(cwd) {
  const paths = [];
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, "AGENTS.md");
    try {
      const details = await stat(candidate);
      if (details.isFile()) paths.unshift(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    text: await readFile(filePath, "utf8")
  })));
}

function agentInstructionText(instructions) {
  if (instructions.length === 0) return "AGENTS.mdはリポジトリとその親ディレクトリに見つかりませんでした。";
  return instructions
    .map(({ filePath, text }) => `--- ${filePath} ---\n${clipText(text, MAX_REVIEW_INPUT_CHARS)}`)
    .join("\n");
}

function implementationPrompt({ brief, checkpoint, feedback, agentInstructions }) {
  return [
    "あなたは実装担当です。作業ディレクトリ内のファイルを実際に編集してください。",
    `実装指示書: ${brief}`,
    `今回の対象: ${checkpoint} のみ`,
    "指示書と以下のAGENTS.md指示を読み、対象チェックポイントの完了条件をすべて満たしてください。",
    agentInstructionText(agentInstructions),
    "この非対話実行では権限が自動承認されます。対象リポジトリの外を変更しないでください。既存変更を削除・上書きせず、コミット、push、git reset、git cleanなどの破壊的なGit操作は実行しないでください。",
    "必要な検証を実行し、指示書所定の形式で報告したら停止してください。",
    feedback ? `Codexからの前回レビュー:\n${feedback}` : "これは最初の実装です。"
  ].join("\n\n");
}

function reviewPrompt({ briefText, checkpoint, baselineStatus, diff, status, verification, report, agentInstructions }) {
  return [
    "あなたは実装者の上司として厳格にコードレビューしてください。ファイルを変更してはいけません。",
    `対象チェックポイント: ${checkpoint}`,
    "Codexの実行環境はread-onlyです。コミット、push、git reset、git cleanなどの書き込み操作を試みないでください。",
    "完了条件、差分、検証結果がすべて証明された場合だけapproveを選んでください。検証失敗を無視してapproveしてはいけません。",
    "修正可能ならreviseと具体的なnext_instruction、外部判断が必要ならblockedを返してください。最終回答はoutput schemaに一致するJSONだけにしてください。",
    `\n--- 実装指示書 ---\n${clipText(briefText, MAX_REVIEW_INPUT_CHARS)}`,
    `\n--- AGENTS.md ---\n${agentInstructionText(agentInstructions)}`,
    `\n--- ループ開始前の既存変更（今回の実装者による変更として扱わない） ---\n${clipText(baselineStatus, MAX_REVIEW_INPUT_CHARS)}`,
    `\n--- git status --short ---\n${clipText(status, MAX_REVIEW_INPUT_CHARS)}`,
    `\n--- git diff / 未追跡ファイル ---\n${clipText(diff, MAX_REVIEW_INPUT_CHARS)}`,
    `\n--- 検証結果 ---\n${clipText(JSON.stringify(verification, null, 2), MAX_REVIEW_INPUT_CHARS)}`,
    `\n--- OpenCode報告・イベント ---\n${clipText(report, MAX_REVIEW_INPUT_CHARS)}`
  ].join("\n");
}

function withReviewPathspec(args, reviewPaths) {
  return reviewPaths === undefined ? args : [...args, "--", ...reviewPaths];
}

function processFailure(label, result, timeoutMs) {
  if (result?.timedOut) return new Error(`${label} timed out after ${timeoutMs}ms`);
  return new Error(`${label} failed with exit code ${result?.code}`);
}

async function gitEvidence(cwd, runner, reviewPaths) {
  const status = await runner("git", withReviewPathspec(["status", "--short"], reviewPaths), { cwd });
  if (status.code !== 0) throw new Error(`git status failed with exit code ${status.code}`);
  const statResult = await runner(
    "git",
    withReviewPathspec(["diff", "--stat", "HEAD", "--no-ext-diff"], reviewPaths),
    { cwd }
  );
  if (statResult.code !== 0) throw new Error(`git diff --stat failed with exit code ${statResult.code}`);
  const diffResult = await runner("git", withReviewPathspec(["diff", "HEAD", "--no-ext-diff"], reviewPaths), { cwd });
  if (diffResult.code !== 0) throw new Error(`git diff failed with exit code ${diffResult.code}`);
  const untrackedResult = await runner(
    "git",
    withReviewPathspec(["ls-files", "--others", "--exclude-standard"], reviewPaths),
    { cwd }
  );
  if (untrackedResult.code !== 0) throw new Error(`git ls-files failed with exit code ${untrackedResult.code}`);

  const untracked = [];
  for (const relativePath of String(untrackedResult.stdout ?? "").split(/\r?\n/).filter(Boolean)) {
    const filePath = path.resolve(cwd, relativePath);
    const relative = path.relative(cwd, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      const contents = await readFile(filePath, "utf8");
      untracked.push(`--- untracked: ${relative} ---\n${clipText(contents, MAX_UNTRACKED_FILE_CHARS)}`);
    } catch (error) {
      untracked.push(`--- untracked: ${relative} (unreadable: ${error.message}) ---`);
    }
  }

  return {
    status: clipText(outputText(status), MAX_REVIEW_INPUT_CHARS),
    diff: clipText([
      outputText(statResult),
      outputText(diffResult),
      untracked.join("\n")
    ].filter(Boolean).join("\n"), MAX_REVIEW_INPUT_CHARS)
  };
}

export async function verify(cwd, commands, runner, emit = () => {}) {
  const results = [];
  for (const command of commands) {
    emit(`\n[verify] ${command}\n`);
    const result = await runner(SHELL_PATH, ["-lc", command], {
      cwd,
      shell: false,
      onStdout: emit,
      onStderr: emit
    });
    const entry = {
      command,
      exitCode: result.code,
      signal: result.signal ?? null,
      output: clipText(outputText(result), 30_000)
    };
    results.push(entry);
    if (result.code !== 0) {
      emit(`\n[verify] stopped after a failed command: ${command}\n`);
      return { passed: false, failedCommand: command, results };
    }
  }
  return { passed: true, failedCommand: null, results };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function recordFailure(statePath, state, error) {
  try {
    await writeJson(statePath, {
      ...state,
      status: "failed",
      error: { message: error instanceof Error ? error.message : String(error) }
    });
  } catch {
    // Preserve the original failure if the diagnostic state cannot be written.
  }
}

async function removeIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function runLoop(config, dependencies = {}) {
  const normalized = validateConfig(config);
  const cwd = path.resolve(normalized.cwd ?? process.cwd());
  const runner = dependencies.runner ?? runProcess;
  const emit = dependencies.emit ?? ((value) => process.stdout.write(value));
  const stateDir = path.join(cwd, ".codex-loop");
  const logsDir = path.join(stateDir, "logs");
  const statePath = path.join(stateDir, "state.json");
  const schemaPath = path.join(stateDir, "review-schema.json");
  const reviewPath = path.join(stateDir, "review.json");
  await mkdir(logsDir, { recursive: true });
  const state = {
    status: "starting",
    checkpoint: normalized.checkpoint,
    maxIterations: normalized.maxIterations,
    model: normalized.model,
    variant: normalized.variant,
    implementationTimeoutMs: normalized.implementationTimeoutMs,
    reviewTimeoutMs: normalized.reviewTimeoutMs,
    ...(normalized.reviewPaths === undefined ? {} : { reviewPaths: normalized.reviewPaths }),
    iteration: 0,
    sessionId: null
  };
  await writeJson(statePath, state);

  let briefText;
  let agentInstructions;
  try {
    const briefPath = path.resolve(cwd, normalized.brief);
    const relativeBrief = path.relative(cwd, briefPath);
    if (!relativeBrief || relativeBrief.startsWith("..") || path.isAbsolute(relativeBrief)) {
      throw new Error("brief must resolve inside the repository");
    }
    const [repositoryPath, resolvedBriefPath] = await Promise.all([realpath(cwd), realpath(briefPath)]);
    const realRelativeBrief = path.relative(repositoryPath, resolvedBriefPath);
    if (!realRelativeBrief || realRelativeBrief.startsWith("..") || path.isAbsolute(realRelativeBrief)) {
      throw new Error("brief must resolve inside the repository");
    }
    briefText = await readFile(resolvedBriefPath, "utf8");
    agentInstructions = await readAgentInstructions(cwd);
  } catch (error) {
    await recordFailure(statePath, state, error);
    throw error;
  }

  await writeJson(schemaPath, REVIEW_SCHEMA);
  const baselineStatusResult = await runner(
    "git",
    withReviewPathspec(["status", "--short"], normalized.reviewPaths),
    { cwd }
  );
  if (baselineStatusResult.code !== 0) {
    throw new Error(`baseline git status failed with exit code ${baselineStatusResult.code}`);
  }
  const baselineStatus = outputText(baselineStatusResult);
  await writeFile(path.join(stateDir, "baseline-status.txt"), baselineStatus);
  let sessionId;
  let feedback = "";
  let lastVerification;
  let lastReview;

  for (let iteration = 1; iteration <= normalized.maxIterations; iteration += 1) {
    const iterationState = { ...state, status: "implementing", iteration, sessionId };
    let phase = "opencode";
    try {
      emit(`\n=== iteration ${iteration}/${normalized.maxIterations}: OpenCode (${normalized.model}, ${normalized.variant}) ===\n`);
      const args = [
        "run",
        "--auto",
        "--dir",
        cwd,
        "--model",
        normalized.model,
        "--variant",
        normalized.variant,
        "--format",
        "json"
      ];
      if (sessionId) args.push("--session", sessionId);
      args.push(implementationPrompt({
        brief: normalized.brief,
        checkpoint: normalized.checkpoint,
        feedback,
        agentInstructions
      }));
      const implementation = await runner("opencode", args, {
        cwd,
        timeoutMs: normalized.implementationTimeoutMs,
        onStdout: emit,
        onStderr: emit
      });
      await writeFile(
        path.join(logsDir, `iteration-${iteration}-opencode.jsonl`),
        `${implementation.stdout ?? ""}${implementation.stderr ?? ""}`
      );
      if (implementation.code !== 0 || implementation.timedOut) {
        throw processFailure("OpenCode", implementation, normalized.implementationTimeoutMs);
      }
      sessionId = sessionIdFromJsonl(`${implementation.stdout ?? ""}${implementation.stderr ?? ""}`) ?? sessionId;
      if (!sessionId) throw new Error("OpenCode did not return a session ID; refusing to start a detached iteration");

      await writeJson(statePath, {
        ...iterationState,
        status: "verifying",
        sessionId
      });
      phase = "verification";
      const verification = await verify(cwd, normalized.verificationCommands, runner, emit);
      lastVerification = verification;
      await writeJson(path.join(logsDir, `iteration-${iteration}-verification.json`), verification);
      phase = "git-evidence";
      const evidence = await gitEvidence(cwd, runner, normalized.reviewPaths);
      await writeJson(path.join(logsDir, `iteration-${iteration}-evidence.json`), evidence);
      await writeJson(statePath, {
        ...iterationState,
        status: "reviewing",
        sessionId,
        verification
      });

      phase = "codex";
      const prompt = reviewPrompt({
        briefText,
        checkpoint: normalized.checkpoint,
        baselineStatus,
        diff: evidence.diff,
        status: evidence.status,
        verification,
        report: `${implementation.stdout ?? ""}${implementation.stderr ?? ""}`,
        agentInstructions
      });

      emit(`\n=== iteration ${iteration}/${normalized.maxIterations}: Codex review (read-only) ===\n`);
      await removeIfPresent(reviewPath);
      const reviewRun = await runner("codex", [
        "exec",
        "-C",
        cwd,
        "-s",
        "read-only",
        "--color",
        "never",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        reviewPath,
        "-"
      ], {
        cwd,
        input: prompt,
        timeoutMs: normalized.reviewTimeoutMs,
        onStdout: emit,
        onStderr: emit
      });
      await writeFile(
        path.join(logsDir, `iteration-${iteration}-codex.log`),
        `${reviewRun.stdout ?? ""}${reviewRun.stderr ?? ""}`
      );
      if (reviewRun.code !== 0 || reviewRun.timedOut) {
        throw processFailure("Codex review", reviewRun, normalized.reviewTimeoutMs);
      }
      const review = parseReview(await readFile(reviewPath, "utf8"));
      lastReview = review;
      await writeJson(path.join(logsDir, `iteration-${iteration}-review.json`), review);
      await writeJson(statePath, {
        ...iterationState,
        status: review.decision,
        sessionId,
        verification,
        review
      });
      emit(`\n[decision] ${review.decision}: ${review.summary}\n`);

      if (review.decision === "approve") {
        if (!verification.passed) {
          throw new Error("Codex approved while verification was failing; stopping for human review");
        }
        if (review.findings.some(({ severity }) => severity === "critical" || severity === "major")) {
          throw new Error("Codex approved with critical or major findings; stopping for human review");
        }
        return { status: "approved", iteration, review, sessionId };
      }
      if (review.decision === "blocked") return { status: "blocked", iteration, review, sessionId };
      feedback = review.next_instruction;
    } catch (error) {
      try {
        await writeFile(
          path.join(logsDir, `iteration-${iteration}-failure.log`),
          `${phase}: ${error instanceof Error ? error.message : String(error)}\n`
        );
      } catch {
        // Preserve the original failure if the diagnostic log cannot be written.
      }
      await recordFailure(statePath, { ...iterationState, sessionId }, error);
      throw error;
    }
  }

  await writeJson(statePath, {
    ...state,
    status: "max_iterations",
    iteration: normalized.maxIterations,
    sessionId,
    verification: lastVerification,
    review: lastReview
  });
  return { status: "max_iterations", iteration: normalized.maxIterations, sessionId };
}
