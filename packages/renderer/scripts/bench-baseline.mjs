#!/usr/bin/env node
// #46 baseline orchestrator (npm run bench:baseline): regenerates the
// committed baseline in ONE command, with strict provenance guarantees:
//
//   1. clean working tree check (the generating tree MUST be clean so
//      `git checkout <commit>` reproduces the runner)
//   2. renderer build
//   3. renderer unit + benchmark helper tests
//   4. GPU benchmark  -> packages/renderer/benchmark-results.json
//   5. CPU benchmark  -> packages/renderer/benchmark-results-cpu.json
//   6. DOM benchmark  -> packages/ukibori-dom/benchmark-results-dom.json
//   7. report generation from ALL THREE documents
//   8. provenance consistency validation (same commit, clean tree, schema)
//   9. summary
//
// The baseline JSON files are written DIRECTLY into the repo by the
// individual runners (their dirty-tree guard runs BEFORE the write, so the
// tree is clean at measurement time). The orchestrator pins the starting
// commit and verifies every result document records it.
//
// Usage: npm run bench:baseline [-- --skip-tests]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crossDocumentProvenanceProblem } from "./bench/lib/provenance.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..");
const rendererPkg = join(repoRoot, "packages", "renderer");
const domPkg = join(repoRoot, "packages", "ukibori-dom");

const skipTests = process.argv.includes("--skip-tests");

function sh(command, args, { cwd = repoRoot } = {}) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(`bench:baseline: command failed: ${command} ${args.join(" ")}`);
    process.exit(1);
  }
}

/**
 * The known pre-existing environment failures on this repository's test
 * suite (`.mjs` imports from `.ts` under this vitest/node version, present
 * on master): the baseline orchestrator tolerates EXACTLY this set and
 * nothing else — any other failure aborts the run.
 */
const KNOWN_PREEXISTING_TEST_FAILURES = [
  "src/wasm-browser-contract.test.ts",
  "src/gpu/issue30-contract.test.ts",
  "src/gpu/test-browser-contract.test.ts",
  "src/wasm/determinism.test.ts",
];

function runRendererTests() {
  const result = spawnSync("npm", ["test", "-w", "ukibori-renderer"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  const failedFiles = [...new Set(
    (output.match(/FAIL\s+([\w./-]+\.test\.ts)/g) ?? []).map((m) => m.replace(/^FAIL\s+/, "")),
  )];
  const unexpected = failedFiles.filter((f) => !KNOWN_PREEXISTING_TEST_FAILURES.includes(f));
  if (unexpected.length > 0) {
    console.error(`bench:baseline: UNEXPECTED test failures: ${unexpected.join(", ")}`);
    process.exit(1);
  }
  if (failedFiles.length > 0) {
    console.warn(
      `bench:baseline: ${failedFiles.length} KNOWN pre-existing environment failure(s) ` +
        `tolerated: ${failedFiles.join(", ")} (present on master under this vitest/node)`,
    );
  }
  if ((output.match(/Tests\s+(\d+)\s+passed/) ?? [])[1] === undefined) {
    console.error("bench:baseline: could not confirm passing tests in the renderer run");
    process.exit(1);
  }
}

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

const RESULT_FILES = [
  join(rendererPkg, "benchmark-results.json"),
  join(rendererPkg, "benchmark-results-cpu.json"),
  join(domPkg, "benchmark-results-dom.json"),
];

function main() {
  console.log("bench:baseline: #46 reproducible baseline regeneration");
  console.log("======================================================");

  // 1. clean tree + starting commit
  const startingCommit = gitOutput(["rev-parse", "HEAD"]);
  const porcelain = gitOutput(["status", "--porcelain"]);
  if (porcelain.length > 0) {
    console.error("bench:baseline: working tree is NOT clean:");
    console.error(porcelain.split("\n").slice(0, 10).join("\n"));
    console.error("commit the implementation first, then run bench:baseline on the clean tree");
    process.exit(1);
  }
  console.log(`starting commit: ${startingCommit}`);
  console.log("working tree: clean");

  // 2. renderer build
  console.log("\n[1/7] building ukibori-renderer...");
  sh("npm", ["run", "build", "-w", "ukibori-renderer"]);

  // 3. tests
  if (!skipTests) {
    console.log("\n[2/7] renderer unit + benchmark helper tests...");
    runRendererTests();
  } else {
    console.log("\n[2/7] tests skipped (--skip-tests)");
  }

  // 4-6. benchmarks (GPU default: warmup 5 / samples 20 / retained 200;
  // CPU: warmup 3 / samples 8; DOM: warmup 5 / samples 20). The result
  // files land in a TEMP staging dir during the runs: each runner's dirty-
  // tree guard checks the tree at its own start, and the tree must stay
  // clean between runs (a result file written into the repo would trip the
  // next runner's guard). The staged files are copied into the repo only
  // AFTER all runs complete.
  const stagingDir = mkdtempSync(join(tmpdir(), "ukibori-baseline-"));
  const staged = RESULT_FILES.map((f) => join(stagingDir, dirname(f).split("\\").pop() + "-" + basename(f)));
  const stagePath = (index) => staged[index];

  console.log("\n[3/7] GPU benchmark (warmup 5, samples 20, retained 200)...");
  sh("node", [
    "scripts/bench-gpu.mjs",
    "--suite", "all",
    "--samples", "20",
    "--warmup", "5",
    "--retained-frames", "200",
    "--json", stagePath(0),
  ], { cwd: rendererPkg });

  console.log("\n[4/7] CPU benchmark (warmup 3, samples 8)...");
  sh("node", [
    "scripts/bench-cpu.mjs",
    "--warmup", "3",
    "--samples", "8",
    "--resolution", "320x180",
    "--json", stagePath(1),
  ], { cwd: rendererPkg });

  console.log("\n[5/7] DOM benchmark (warmup 5, samples 20)...");
  sh("node", [
    "scripts/bench-dom.mjs",
    "--samples", "20",
    "--warmup", "5",
    "--json", stagePath(2),
  ], { cwd: domPkg });

  // stage the results into the repo AFTER all runs (the tree is clean
  // during every run, so every document records workingTreeDirty=false)
  for (const [index, file] of RESULT_FILES.entries()) {
    copyFileSync(stagePath(index), file);
  }

  // 7. report from ALL THREE documents
  console.log("\n[6/7] generating report from all three result documents...");
  sh("node", [
    join(rendererPkg, "scripts", "bench-report.mjs"),
    "--results",
    RESULT_FILES.join(","),
    "--out",
    join(rendererPkg, "benchmark-report.md"),
  ]);

  // 8. provenance consistency validation
  console.log("\n[7/7] provenance validation...");
  const docs = RESULT_FILES.map((f) => JSON.parse(readFileSync(f, "utf8")));
  const problem = crossDocumentProvenanceProblem(docs);
  if (problem !== null) {
    console.error(`bench:baseline: provenance validation FAILED: ${problem}`);
    process.exit(1);
  }
  for (const [index, doc] of docs.entries()) {
    if (doc.commit !== startingCommit) {
      console.error(
        `bench:baseline: result ${index} records commit ${doc.commit} but the run started at ${startingCommit}`,
      );
      process.exit(1);
    }
    if (doc.workingTreeDirty !== false) {
      console.error(`bench:baseline: result ${index} reports workingTreeDirty=${doc.workingTreeDirty}`);
      process.exit(1);
    }
  }

  // 9. summary
  console.log("\nbench:baseline: DONE");
  console.log(`  commit:            ${startingCommit}`);
  console.log(`  workingTreeDirty:  false (all documents)`);
  for (const [index, file] of RESULT_FILES.entries()) {
    console.log(`  ${file}: ${docs[index].cases.length} cases`);
  }
  console.log(`  report:            ${join(rendererPkg, "benchmark-report.md")}`);
  console.log("commit the regenerated JSONs + report as the baseline commit (Commit B).");
}

main();