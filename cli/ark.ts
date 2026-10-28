#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import packageMetadata from "../package.json" with { type: "json" };
import { acceptanceCriteriaUpdate } from "./acceptance-criteria";
import { doctor } from "./doctor";
import { gateAnswer, gatePacket } from "./gate";
import { closeRun, mergeRequestOpen } from "./merge-request";
import { hookToolCall } from "./hook";
import { launch } from "./launch";
import { preflight } from "./preflight";
import { artifactRecord, findingsRecord, logRoute } from "./record";
import { advance, replay, start } from "./run";
import { runTest, type TestMode } from "./test";
import { traceCheck } from "./trace";
import { worktreeCreate } from "./worktree";

const usage = `ark ${packageMetadata.version}

Usage: ark <command> [options]

Commands:
  run start <ID>                          Start the next run for a local ticket, or show the open one (run ids are <date>-<ticket>-<n>)
  run close <run_id> <merged|abandoned>   Record each opened merge request (MR) outcome; needs the human's matching ask answer in the main Oh My Pi (OMP) session (outside OMP also typed on /dev/tty)
  run replay <run_id> [--check]           Rebuild state.json from the ledger (--check: exit 1 if it differs)
  advance <run_id> <event> [--data json]  Move the run along a legal transition
  worktree create <run_id> [--repo path]        Create the run's worktree for a repo (default: the project root), push disabled
  test <run_id> --criteria ID,.. [--red-green|--preservation] [--as validator] [--repo name]
                                          Run tests tagged with an acceptance criterion (AC) in the worktree; --red-green proves new behavior (fails on base, passes on head), --preservation preserved behavior (passes on both); --as validator records a validator step
  trace-check <run_id>                    Build trace-matrix.md from ac.yml and the recorded test evidence; exit 1 listing why it fails
  gate packet <run_id> <criteria|plan|evidence|escalation>      Build the gate packet from run artifacts and print its 256-bit Secure Hash Algorithm (SHA-256) hash; setup is reserved and unimplemented
  gate answer <run_id> <gate> <answer> --packet <sha256>
                                          criteria: accept|edit|abort, plan: approve|change|abort, evidence: approve|send_back|abort, escalation: one_more_round|take_over|abort; needs the human's matching ask answer in the main OMP session (outside OMP also typed on /dev/tty)
  acceptance-criteria update <run_id>                      After a criteria edit, re-read the ticket's acceptance criteria into the run (then build a new criteria packet)
  merge-request open <run_id>                             Push the run branches and open a merge request (a GitHub pull request) per repo; prints close_packet: <sha256> once a merge request is open (ark.yml merge_requests: false hands the ready branches off instead, never after a merge request was opened)
  preflight                               Refuse (exit 1) unless every model validate and review-x can reach (comma candidates, retry.fallbackChains, global and project OMP config) is on another vendor than implement, and every review-s model on the same one
  log route [<run_id>] <playbook> "<why>" Record route.chosen, the first event after run.started (no run_id: the active run)
  findings record <run_id> <file.json>    Validate the judged findings and record them (judging state)
  artifact record <run_id> <implementer|validator|reviewer> <file.json>
                                          Schema-check an agent's output and keep it as artifacts/<agent>/<n>.json
  doctor                                  Check the git host: the default branch must include admins, require a pull request and passing checks, and forbid force pushes (exit 1 otherwise)
  launch [omp args]                       Start omp as the orchestrator: no bash, eval or lsp, typed ark_* tools, git and gh without credentials (only ark_merge_request_open has them)
  hook tool_call                          Read {tool,input,cwd} JavaScript Object Notation (JSON) on stdin; exit 1 with the reason when the main session may not make the call
  --version                               Print the version
  --help                                  Print this help
`;

const argumentsList = process.argv.slice(2);
const flag = (name: string) => {
  const i = argumentsList.indexOf(name);
  return i < 0 ? undefined : argumentsList.splice(i, 2 - Number(name === "--check"))[1];
};

let run: (() => string) | undefined;
if (argumentsList[0] === "--version") {
  console.log(packageMetadata.version);
  process.exit(0);
} else if (argumentsList[0] === "--help" || argumentsList[0] === "-h") {
  process.stdout.write(usage);
  process.exit(0);
} else if (argumentsList[0] === "run" && argumentsList[1] === "start" && argumentsList.length === 3) {
  run = () => start(argumentsList[2]);
} else if (argumentsList[0] === "run" && argumentsList[1] === "replay") {
  const check = argumentsList.includes("--check");
  const remainingArguments = argumentsList.slice(2).filter((a) => a !== "--check");
  if (remainingArguments.length === 1) run = () => replay(remainingArguments[0], check);
} else if (argumentsList[0] === "trace-check" && argumentsList.length === 2) {
  run = () => traceCheck(argumentsList[1]);
} else if (argumentsList[0] === "gate" && argumentsList[1] === "packet" && argumentsList.length === 4) {
  run = () => gatePacket(argumentsList[2], argumentsList[3]);
} else if (argumentsList[0] === "gate" && argumentsList[1] === "answer") {
  const packet = flag("--packet");
  if (packet && argumentsList.length === 5) run = () => gateAnswer(argumentsList[2], argumentsList[3], argumentsList[4], packet);
} else if (argumentsList[0] === "acceptance-criteria" && argumentsList[1] === "update" && argumentsList.length === 3) {
  run = () => acceptanceCriteriaUpdate(argumentsList[2]);
} else if (argumentsList[0] === "run" && argumentsList[1] === "close" && argumentsList.length === 4) {
  run = () => closeRun(argumentsList[2], argumentsList[3]);
} else if (argumentsList[0] === "advance") {
  const i = argumentsList.indexOf("--data");
  const data = i < 0 ? undefined : argumentsList[i + 1];
  const remainingArguments = i < 0 ? argumentsList.slice(1) : [...argumentsList.slice(1, i), ...argumentsList.slice(i + 2)];
  if (remainingArguments.length === 2 && (i < 0 || data !== undefined)) run = () => advance(remainingArguments[0], remainingArguments[1], data);
} else if (argumentsList[0] === "worktree" && argumentsList[1] === "create") {
  const repo = flag("--repo");
  if (argumentsList.length === 3) run = () => worktreeCreate(argumentsList[2], repo);
} else if (argumentsList[0] === "merge-request" && argumentsList[1] === "open" && argumentsList.length === 3) {
  run = () => mergeRequestOpen(argumentsList[2]);
} else if (argumentsList[0] === "test") {
  const criteria = flag("--criteria");
  const repo = flag("--repo");
  const role = flag("--as");
  const proofFlags: string[] = argumentsList.filter((a) => a === "--red-green" || a === "--preservation");
  const remainingArguments = argumentsList.filter((a) => !proofFlags.includes(a));
  const mode: TestMode = proofFlags[0] === "--red-green" ? "red-green" : proofFlags[0] ? "preservation" : "green";
  if (remainingArguments.length === 2 && criteria && proofFlags.length <= 1) run = () => runTest(remainingArguments[1], criteria.split(","), repo, mode, role);
} else if (argumentsList[0] === "preflight" && argumentsList.length === 1) {
  run = preflight;
} else if (argumentsList[0] === "log" && argumentsList[1] === "route" && (argumentsList.length === 4 || argumentsList.length === 5)) {
  run = () => logRoute(argumentsList.slice(2));
} else if (argumentsList[0] === "findings" && argumentsList[1] === "record" && argumentsList.length === 4) {
  run = () => findingsRecord(argumentsList[2], argumentsList[3]);
} else if (argumentsList[0] === "artifact" && argumentsList[1] === "record" && argumentsList.length === 5) {
  run = () => artifactRecord(argumentsList[2], argumentsList[3], argumentsList[4]);
} else if (argumentsList[0] === "doctor" && argumentsList.length === 1) {
  run = doctor;
} else if (argumentsList[0] === "launch") {
  run = () => (process.exitCode = launch(argumentsList.slice(1)), "");
} else if (argumentsList[0] === "hook" && argumentsList[1] === "tool_call" && argumentsList.length === 2) {
  run = () => (hookToolCall(readFileSync(0, "utf8")), "");
}

if (!run) {
  process.stderr.write(`ark: unknown command or bad arguments '${argumentsList.join(" ")}'\n\n${usage}`);
  process.exit(2);
}
try {
  process.stdout.write(run());
} catch (error) {
  process.stderr.write(`ark: ${(error as Error).message}\n`);
  process.exit(1);
}
