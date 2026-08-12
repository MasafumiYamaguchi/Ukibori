#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { runLoop, validateConfig } from "./loop.mjs";

const VALUE_OPTIONS = new Set(["config", "checkpoint", "max-iterations", "model", "variant"]);

export function usage() {
  return `Usage: npm run dev:loop -- [options]

Runs OpenCode as the implementer and codex exec as a read-only reviewer.
The default implementer is opencode-go/deepseek-v4-flash (variant: max).

Options:
  --config <file>       Config file (default: .codex-loop.json)
  --checkpoint <name>   Override checkpoint, for example CP4
  --max-iterations <n>  Override the iteration limit
  --model <id>          Override the OpenCode model
  --variant <name>      Override the model variant
  -h, --help            Show this help`;
}

export function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    const equalsIndex = argument.indexOf("=");
    const name = (equalsIndex === -1 ? argument.slice(2) : argument.slice(2, equalsIndex));
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    let value = equalsIndex === -1 ? argv[index + 1] : argument.slice(equalsIndex + 1);
    if (equalsIndex === -1) index += 1;
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    result[name] = value;
  }
  return result;
}

export async function readConfig(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read config ${configPath}: ${error.message}`);
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsFrom(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const cwd = process.cwd();
  const configPath = path.resolve(cwd, args.config ?? ".codex-loop.json");
  const config = await readConfig(configPath);
  const resolved = validateConfig({
    ...config,
    cwd,
    checkpoint: args.checkpoint ?? config.checkpoint,
    maxIterations: args["max-iterations"] === undefined
      ? config.maxIterations
      : Number(args["max-iterations"]),
    model: args.model ?? config.model,
    variant: args.variant ?? config.variant
  });

  console.log(`Implementer: ${resolved.model} (${resolved.variant})`);
  console.log(`Checkpoint: ${resolved.checkpoint}`);
  const result = await runLoop(resolved);
  console.log(JSON.stringify(result, null, 2));
  return result.status === "approved" ? 0 : 2;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint && import.meta.url === entrypoint) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
