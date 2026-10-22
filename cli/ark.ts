#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { gateAnswer, gatePacket } from "./gate";
import { hookToolCall } from "./hook";
import { preflight } from "./preflight";
import { artifactRecord, findingsRecord, logRoute } from "./record";
import { advance, replay, start } from "./run";
import { runTest } from "./test";
import { wsCreate } from "./ws";

const usage = `ark ${pkg.version}

Usage: ark <command> [options]

Commands:
  run start <ID>                          Start the run for a local ticket, or show the existing one
  run replay <run_id> [--check]           Rebuild state.json from the ledger (--check: exit 1 if it differs)
  advance <run_id> <event> [--data json]  Move the run along a legal transition
  ws create <run_id> [--repo path]        Create the run's worktree for a repo (default: the project root), push disabled
  test <run_id> --acs ID,.. [--red-green] [--repo name]
                                          Run the AC-tagged tests in the worktree; --red-green proves them on base then head
  gate packet <run_id> <G0|G1|G2>         Build the gate packet from run artifacts and print its sha256
  gate answer <run_id> <gate> <answer> --packet <sha256>
                                          Record a gate answer (G0: accept|edit|abort, G1: approve|change|abort, G2: approve|send_back|abort)
  preflight                               Refuse (exit 1) unless .omp/config.yml puts validate and review-x on another provider than implement, and review-s on the same one
  log route [<run_id>] <playbook> "<why>" Record route.chosen, the first event after run.started (no run_id: the active run)
  findings record <run_id> <file.json>    Validate the judged findings and record them (judging state)
  artifact record <run_id> <implementer|validator|reviewer> <file.json>
                                          Schema-check an agent's output and keep it as artifacts/<agent>/<n>.json
  hook tool_call                          Read {tool,input,cwd} JSON on stdin; exit 1 with the reason when the main session may not make the call
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
} else if (args[0] === "gate" && args[1] === "packet" && args.length === 4) {
  run = () => gatePacket(args[2], args[3]);
} else if (args[0] === "gate" && args[1] === "answer") {
  const packet = flag("--packet");
  if (packet && args.length === 5) run = () => gateAnswer(args[2], args[3], args[4], packet);
} else if (args[0] === "advance") {
  const i = args.indexOf("--data");
  const data = i < 0 ? undefined : args[i + 1];
  const rest = i < 0 ? args.slice(1) : [...args.slice(1, i), ...args.slice(i + 2)];
  if (rest.length === 2 && (i < 0 || data !== undefined)) run = () => advance(rest[0], rest[1], data);
} else if (args[0] === "ws" && args[1] === "create") {
  const repo = flag("--repo");
  if (args.length === 3) run = () => wsCreate(args[2], repo);
} else if (args[0] === "test") {
  const acs = flag("--acs");
  const repo = flag("--repo");
  const rg = args.indexOf("--red-green");
  if (rg >= 0) args.splice(rg, 1);
  if (args.length === 2 && acs) run = () => runTest(args[1], acs.split(","), repo, rg >= 0);
} else if (args[0] === "preflight" && args.length === 1) {
  run = preflight;
} else if (args[0] === "log" && args[1] === "route" && (args.length === 4 || args.length === 5)) {
  run = () => logRoute(args.slice(2));
} else if (args[0] === "findings" && args[1] === "record" && args.length === 4) {
  run = () => findingsRecord(args[2], args[3]);
} else if (args[0] === "artifact" && args[1] === "record" && args.length === 5) {
  run = () => artifactRecord(args[2], args[3], args[4]);
} else if (args[0] === "hook" && args[1] === "tool_call" && args.length === 2) {
  run = () => (hookToolCall(readFileSync(0, "utf8")), "");
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
