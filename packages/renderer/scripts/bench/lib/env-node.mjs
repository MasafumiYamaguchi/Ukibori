// #46 node-side environment metadata collector (§16): CPU benchmarks embed
// the machine fingerprint that produced the numbers. Unavailable fields are
// `unknown`, never guessed. Browser-side metadata is collected inside the
// browser harness (it needs the live GPUAdapter/GPUDevice).

import { execSync } from "node:child_process";
import { cpus, release, type, platform, arch } from "node:os";

export function gitCommitSync() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", cwd: process.cwd() }).trim();
  } catch {
    return "unknown";
  }
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
  };
}