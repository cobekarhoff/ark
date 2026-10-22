#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { advance, replay, start } from "./run";

const usage = `ark ${pkg.version}

Usage: ark <command> [options]

Commands:
  run start <ID>                          Start the run for a local ticket, or show the existing one
  run replay <run_id> [--check]           Rebuild state.json from the ledger (--check: exit 1 if it differs)
  advance <run_id> <event> [--data json]  Move the run along a legal transition
  --version                               Print the version
  --help                                  Print this help
`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2 - Number(name === "--check"))[1];
};

let run: (() => string) | undefined;
if (args[0] === "--version") {
  console.log(pkg.version);
  process.exit(0);
} else if (args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(usage);
  process.exit(0);
} else if (args[0] === "run" && args[1] === "start" && args.length === 3) {
  run = () => start(args[2]);
} else if (args[0] === "run" && args[1] === "replay") {
  const check = args.includes("--check");
  const rest = args.slice(2).filter((a) => a !== "--check");
  if (rest.length === 1) run = () => replay(rest[0], check);
} else if (args[0] === "advance") {
  const i = args.indexOf("--data");
  const data = i < 0 ? undefined : args[i + 1];
  const rest = i < 0 ? args.slice(1) : [...args.slice(1, i), ...args.slice(i + 2)];
  if (rest.length === 2 && (i < 0 || data !== undefined)) run = () => advance(rest[0], rest[1], data);
}

if (!run) {
  process.stderr.write(`ark: unknown command or bad arguments '${args.join(" ")}'\n\n${usage}`);
  process.exit(2);
}
try {
  process.stdout.write(run());
} catch (e) {
  process.stderr.write(`ark: ${(e as Error).message}\n`);
  process.exit(1);
}
