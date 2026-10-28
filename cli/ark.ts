#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { acUpdate } from "./ac";
import { doctor } from "./doctor";
import { gateAnswer, gatePacket } from "./gate";
import { closeRun, mr } from "./mr";
import { hookToolCall } from "./hook";
import { launch } from "./launch";
import { preflight } from "./preflight";
import { artifactRecord, findingsRecord, logRoute } from "./record";
import { advance, replay, start } from "./run";
import { runTest, type TestMode } from "./test";
import { traceCheck } from "./trace";
import { wsCreate } from "./ws";

const usage = `ark ${pkg.version}

Usage: ark <command> [options]

Commands:
  run start <ID>                          Start the next run for a local ticket, or show the open one (run ids are <date>-<ticket>-<n>)
  run close <run_id> <merged|abandoned>   Record the outcome of opened MRs; needs the human's matching ask answer in the main OMP session (outside OMP also typed on /dev/tty)
  run replay <run_id> [--check]           Rebuild state.json from the ledger (--check: exit 1 if it differs)
  advance <run_id> <event> [--data json]  Move the run along a legal transition
  ws create <run_id> [--repo path]        Create the run's worktree for a repo (default: the project root), push disabled
  test <run_id> --acs ID,.. [--red-green|--preservation] [--as validator] [--repo name]
                                          Run the AC-tagged tests in the worktree; --red-green proves new behavior (fails on base, passes on head), --preservation preserved behavior (passes on both); --as validator records a validator step
  trace-check <run_id>                    Build trace-matrix.md from ac.yml and the recorded test evidence; exit 1 listing why it fails
  gate packet <run_id> <G0|G1|G2|GE>      Build the gate packet from run artifacts and print its sha256 (GE is the escalation gate)
  gate answer <run_id> <gate> <answer> --packet <sha256>
                                          G0: accept|edit|abort, G1: approve|change|abort, G2: approve|send_back|abort, GE: one_more_round|take_over|abort; needs the human's matching ask answer in the main OMP session (outside OMP also typed on /dev/tty)
  ac update <run_id>                      After a G0 edit, re-read the ticket's acceptance criteria into the run (then build a new G0 packet)
  mr <run_id>                             Push the run branches and open a merge request (a GitHub pull request) per repo; prints close_packet: <sha256> once an MR is open (ark.yml mr: false hands the ready branches off instead, never after an MR was opened)
  preflight                               Refuse (exit 1) unless every model validate and review-x can reach (comma candidates, retry.fallbackChains, global and project OMP config) is on another vendor than implement, and every review-s model on the same one
  log route [<run_id>] <playbook> "<why>" Record route.chosen, the first event after run.started (no run_id: the active run)
  findings record <run_id> <file.json>    Validate the judged findings and record them (judging state)
  artifact record <run_id> <implementer|validator|reviewer> <file.json>
                                          Schema-check an agent's output and keep it as artifacts/<agent>/<n>.json
  doctor                                  Check the git host: the default branch must include admins, require a PR and passing checks, and forbid force pushes (exit 1 otherwise)
  launch [omp args]                       Start omp as the orchestrator: no bash, eval or lsp, typed ark_* tools, git and gh without credentials (only ark_mr has them)
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
} else if (args[0] === "trace-check" && args.length === 2) {
  run = () => traceCheck(args[1]);
} else if (args[0] === "gate" && args[1] === "packet" && args.length === 4) {
  run = () => gatePacket(args[2], args[3]);
} else if (args[0] === "gate" && args[1] === "answer") {
  const packet = flag("--packet");
  if (packet && args.length === 5) run = () => gateAnswer(args[2], args[3], args[4], packet);
} else if (args[0] === "ac" && args[1] === "update" && args.length === 3) {
  run = () => acUpdate(args[2]);
} else if (args[0] === "run" && args[1] === "close" && args.length === 4) {
  run = () => closeRun(args[2], args[3]);
} else if (args[0] === "advance") {
  const i = args.indexOf("--data");
  const data = i < 0 ? undefined : args[i + 1];
  const rest = i < 0 ? args.slice(1) : [...args.slice(1, i), ...args.slice(i + 2)];
  if (rest.length === 2 && (i < 0 || data !== undefined)) run = () => advance(rest[0], rest[1], data);
} else if (args[0] === "ws" && args[1] === "create") {
  const repo = flag("--repo");
  if (args.length === 3) run = () => wsCreate(args[2], repo);
} else if (args[0] === "mr" && args.length === 2) {
  run = () => mr(args[1]);
} else if (args[0] === "test") {
  const acs = flag("--acs");
  const repo = flag("--repo");
  const as = flag("--as");
  const proofs: string[] = args.filter((a) => a === "--red-green" || a === "--preservation");
  const rest = args.filter((a) => !proofs.includes(a));
  const mode: TestMode = proofs[0] === "--red-green" ? "red-green" : proofs[0] ? "preservation" : "green";
  if (rest.length === 2 && acs && proofs.length <= 1) run = () => runTest(rest[1], acs.split(","), repo, mode, as);
} else if (args[0] === "preflight" && args.length === 1) {
  run = preflight;
} else if (args[0] === "log" && args[1] === "route" && (args.length === 4 || args.length === 5)) {
  run = () => logRoute(args.slice(2));
} else if (args[0] === "findings" && args[1] === "record" && args.length === 4) {
  run = () => findingsRecord(args[2], args[3]);
} else if (args[0] === "artifact" && args[1] === "record" && args.length === 5) {
  run = () => artifactRecord(args[2], args[3], args[4]);
} else if (args[0] === "doctor" && args.length === 1) {
  run = doctor;
} else if (args[0] === "launch") {
  run = () => (process.exitCode = launch(args.slice(1)), "");
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
