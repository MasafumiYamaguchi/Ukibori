// #46 node-side environment metadata collector (§16): CPU benchmarks embed
// the machine fingerprint that produced the numbers. Unavailable fields are
// `unknown`, never guessed. Browser-side metadata is collected inside the
// browser harness (it needs the live GPUAdapter/GPUDevice).
//
// Baseline provenance contract: a committed baseline must be generated on a
// CLEAN working tree at the recorded commit, so `git checkout <commit>`
// reproduces the exact runner. `workingTreeDirty` is computed by the
// runners and must be `false` in committed baselines (the runners refuse to
// write a baseline when the tree is dirty unless `--allow-dirty` is given).

import { execSync } from "node:child_process";
import { cpus, release, type, platform, arch } from "node:os";

export function gitCommitSync() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", cwd: process.cwd() }).trim();
  } catch {
    return "unknown";
  }
}

export function gitStatusPorcelain() {
  try {
    return execSync("git status --porcelain", { encoding: "utf8", cwd: process.cwd() });
  } catch {
    return "";
  }
}

/** Pure dirty-tree detection over `git status --porcelain` output. */
export function isWorkingTreeDirty({ porcelain }) {
  return porcelain !== null && porcelain !== undefined && porcelain.trim().length > 0;
}

export function collectNodeEnvironment() {
  const cpusInfo = cpus();
  const firstCpu = cpusInfo.length > 0 ? cpusInfo[0] : null;
  return {
    timestamp: new Date().toISOString(),
    os: `${type()} ${release()}`,
    platform,
    arch,
    cpuModel: firstCpu?.model ?? "unknown",
    cpuCores: cpusInfo.length,
    nodeVersion: process.version,
    commit: gitCommitSync(),
    workingTreeDirty: isWorkingTreeDirty({ porcelain: gitStatusPorcelain() }),
  };
}