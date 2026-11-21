import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fake `orca` and `gh` for the companion commands (ARK-480). It is separate from test/fake-orca.ts,
// whose worker list is empty and whose `worker-stop`, `send` and `run-list` do nothing useful.
//
// Orca: `run-list`, `worker-list` (the live rows of Master Chief's Run: the rows the fake started,
// then `leads`), `worker-start` (refused unless `--worktree path:<x>` is one of `knownWorktrees`, as
// real Orca answers selector_not_found), `worker-stop`, `send` and `terminal list`. The live rows are
// files, one for each Dispatch, and ids come from exclusive file creation, so processes that run at
// once cannot race inside the fake. Every call is logged to calls.jsonl; every `send` that was
// delivered is logged to delivered.jsonl. Settings live in config.json, which a test edits.
// gh: `pr view` answers from gh.json: pass, fail (the named checks failed) or error (exit 1).
const orcaScript = `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
const directory = process.env.FAKE_COMPANION_DIR;
const args = process.argv.slice(2);
appendFileSync(join(directory, "calls.jsonl"), JSON.stringify(args) + "\\n");
const configFile = join(directory, "config.json");
const config = JSON.parse(readFileSync(configFile, "utf8"));
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const reply = (result) => console.log(JSON.stringify({ ok: true, result }));
const fail = (message) => { console.error(message); process.exit(1); };
const pause = (milliseconds) => {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};
const [group, verb] = args;
const word = group === "orchestration" ? verb : group + " " + verb;
if (config.failAll || (config.failVerbs ?? []).includes(word)) fail("orca is not reachable");
if ((config.hangVerbs ?? []).includes(word)) {
  pause(config.hangMilliseconds ?? 8000);
  appendFileSync(join(directory, "hung-done.jsonl"), JSON.stringify(args) + "\\n");
}
const workersDirectory = join(directory, "workers");
const liveRows = () =>
  readdirSync(workersDirectory).sort().map((name) => JSON.parse(readFileSync(join(workersDirectory, name), "utf8")));
const nextNumber = () => {
  for (let number = 1; ; number++) {
    try {
      closeSync(openSync(join(directory, "ids", String(number)), "wx"));
      return number;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
};
if (word === "run-list") reply({ runs: config.runs, nextCursor: null });
else if (word === "worker-list") {
  const wanted = flag("--terminal-state");
  let leadRows = config.leads;
  if (config.leadsOnRead) {
    // The call log already holds this call, so its worker-list count minus one is the index of this read.
    const readIndex = readFileSync(join(directory, "calls.jsonl"), "utf8")
      .split("\\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call[1] === "worker-list").length - 1;
    const scripted = config.leadsOnRead[Math.min(readIndex, config.leadsOnRead.length - 1)];
    if (!Array.isArray(scripted)) fail(scripted.fail);
    leadRows = scripted;
  }
  const rows = [...liveRows(), ...leadRows].filter((row) => !wanted || (row.terminalState ?? "active") === wanted);
  reply({ workers: flag("--run") === config.chiefRunId ? rows : [], nextCursor: null });
} else if (word === "task-list") reply({ tasks: [] });
else if (word === "worker-start") {
  const worktree = (flag("--worktree") ?? "").replace(/^path:/, "");
  if (!config.knownWorktrees.map((known) => resolve(known)).includes(resolve(worktree)))
    fail("selector_not_found: no worktree " + worktree);
  const title = flag("--task-title") ?? "";
  if ((config.failStartFor ?? []).some((name) => title === "Companion: " + name)) fail("worker-start refused");
  pause(config.delayMilliseconds ?? 0);
  const number = nextNumber();
  const row = {
    dispatchId: "ctx_" + number,
    terminal: "term_" + number,
    liveness: "live",
    terminalState: "active",
    workspace: "host_1::" + worktree,
    title,
  };
  writeFileSync(join(workersDirectory, row.dispatchId + ".json"), JSON.stringify(row));
  appendFileSync(join(directory, "started.jsonl"), JSON.stringify(args) + "\\n");
  for (const harness of ["omp", "claude", "codex"]) {
    const folder = join(directory, "sessions", harness, "scratch");
    mkdirSync(folder, { recursive: true });
    // Like the harness: the session file holds the cwd, then the first prompt (the spec). A sync
    // tells the companion's session from Master Chief's by that prompt.
    writeFileSync(
      join(folder, "session-" + number + ".jsonl"),
      [
        JSON.stringify({ type: "session", id: "session-" + number, timestamp: new Date().toISOString(), cwd: worktree }),
        JSON.stringify({ type: "message", id: "prompt-" + number, message: { role: "user", content: flag("--spec") ?? "" } }),
      ].join("\\n") + "\\n",
    );
  }
  reply({ dispatchId: row.dispatchId, taskId: "task_" + number, runId: flag("--run"), terminal: row.terminal, workspace: worktree });
} else if (word === "worker-stop") {
  pause(config.delayMilliseconds ?? 0);
  // Like real Orca: a stopped worker that was kept open stays live and retained until it is released.
  const file = join(workersDirectory, flag("--dispatch") + ".json");
  const row = JSON.parse(readFileSync(file, "utf8"));
  if (row.liveness === "live") writeFileSync(file, JSON.stringify({ ...row, terminalState: "retained" }));
  reply({});
} else if (word === "worker-release") {
  const file = join(workersDirectory, flag("--dispatch") + ".json");
  const row = JSON.parse(readFileSync(file, "utf8"));
  if (config.releaseError) fail(config.releaseError);
  writeFileSync(file, JSON.stringify({ ...row, liveness: "exited", terminalState: "released" }));
  reply({});
} else if (word === "send") {
  const to = flag("--to");
  pause(config.delayMilliseconds ?? 0);
  if ((config.hangSendTo ?? []).includes(to)) {
    pause(config.hangMilliseconds ?? 8000);
    appendFileSync(join(directory, "hung-done.jsonl"), JSON.stringify(args) + "\\n");
  }
  if ((config.failSendTo ?? []).includes(to)) fail("send refused for " + to + (config.failSendError ? ": " + config.failSendError : ""));
  if (config.failSendOnce) {
    writeFileSync(configFile, JSON.stringify({ ...config, failSendOnce: false }));
    fail("send failed once");
  }
  appendFileSync(join(directory, "delivered.jsonl"), JSON.stringify(args) + "\\n");
  reply({});
} else if (word === "terminal list") reply({ terminals: config.terminals });
else process.exit(2);
`;

const ghScript = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.env.FAKE_COMPANION_DIR;
const args = process.argv.slice(2);
appendFileSync(join(directory, "gh-calls.jsonl"), JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(join(directory, "gh.json"), "utf8"));
if (state.mode === "error") { console.error("gh: cannot reach the host"); process.exit(1); }
if (args[0] !== "pr" || args[1] !== "view") process.exit(2);
const checks = [{ name: "build", conclusion: "SUCCESS" }, ...(state.failed ?? []).map((name) => ({ name, conclusion: "FAILURE" }))];
console.log(JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: checks }));
`;

/** A `worker-list` row of a worker the fake started. */
export type WorkerRowOfFake = {
  dispatchId: string;
  terminal: string;
  title: string;
  liveness: "live" | "exited";
  terminalState: "active" | "retained" | "released" | "closed";
};

/** The `orca orchestration` rows a test lists for Master Chief's Run. */
export type FakeLead = { dispatchId: string; terminal?: string; workspace: string };

export type FakeCompanionConfig = {
  /** `run-list --full` rows. Default: Master Chief's Run `Master Chief: <project> tickets`. */
  runs: { id: string; objective: string; coordinator_handle?: string }[];
  /** The Orca Run id `worker-list --run` answers for. */
  chiefRunId: string;
  /** Run leads: rows of Master Chief's Run that the fake did not start. */
  leads: FakeLead[];
  /** One answer for each `worker-list` read, counted from the call log: the lead rows (a structured lead has no `terminal`) or `{ fail }`, which exits 1 with that text. The last entry answers every later read. Off by default: `leads` answers. */
  leadsOnRead?: (FakeLead[] | { fail: string })[];
  /** `terminal list` rows. Default: the connected Master Chief terminal in the workspace. */
  terminals: { handle: string; connected: boolean; worktreePath: string }[];
  /** The worktrees `worker-start` accepts. Any other path fails like real Orca: selector_not_found. */
  knownWorktrees: string[];
  /** Every verb exits 1: Orca is down. */
  failAll?: boolean;
  /** These verbs (`send`, `run-list`, `worker-list`, `terminal list`) hang for `hangMilliseconds` and then log to hung-done.jsonl. A caller that gave up and killed the fake leaves no mark. Off by default. */
  hangVerbs?: string[];
  /** How long a hung verb holds the call. Default 8 s: longer than a few-second bound, shorter than the 10 s read timeout of cli/orca.ts. */
  hangMilliseconds?: number;
  /** These verbs exit 1 (for example `worker-stop`). */
  failVerbs?: string[];
  /** Companion names whose `worker-start` exits 1. */
  failStartFor?: string[];
  /** `send --to` values whose send exits 1. */
  failSendTo?: string[];
  /** Text that a refused `send` adds to its error (for example `task_not_found`). */
  failSendError?: string;
  /** `send --to` values whose send hangs for `hangMilliseconds` first, while a send to any other recipient answers at once. */
  hangSendTo?: string[];
  /** The next `send` exits 1, then sends work again. */
  failSendOnce?: boolean;
  /** `worker-start`, `worker-stop` and `send` each take this long, so processes overlap in the fake. */
  delayMilliseconds?: number;
  /** `worker-release` exits 1 with this text (for example `dispatch_inactive`). */
  releaseError?: string;
};

export type Delivered = {
  to: string;
  from?: string;
  subject: string;
  body: string;
  type?: string;
};

export type StartedWorker = {
  title: string;
  run?: string;
  keepOpen: boolean;
  worktree: string;
  agent?: string;
  model?: string;
  spec: string;
};

export type FakeCompanionTools = {
  /** Merges `patch` into config.json. */
  configure(patch: Partial<FakeCompanionConfig>): void;
  /** Every `orca` call, as argument lists, in order. */
  calls(): string[][];
  /** The `orca orchestration <verb>` calls only. */
  verbs(): string[];
  clearCalls(): void;
  /** The `send` calls that were delivered. */
  sent(): Delivered[];
  /** Each `worker-start` the fake accepted, in order. */
  started(): StartedWorker[];
  /** Dispatch ids that have a live row now. */
  live(): string[];
  /** Every row the fake holds, released ones too. */
  rows(): WorkerRowOfFake[];
  /** The worker of `dispatch` sent worker_done and sits idle: liveness live, terminalState retained, as real Orca lists a kept-open worker. */
  retain(dispatch: string): void;
  /** The worker of `dispatch` closed: liveness exited, no longer running. */
  close(dispatch: string): void;
  /** What `gh pr view` answers: `pass`, `fail` with the failed check names, or `error`. */
  setCi(mode: "pass" | "fail" | "error", failed?: string[]): void;
  /** The `gh` calls, as argument lists. */
  ghCalls(): string[][];
  /** The hung calls that ended by themselves, as argument lists: the caller waited for them. */
  hungDone(): string[][];
};

const flagOf = (args: string[], name: string): string | undefined =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

const environmentNames = [
  "PATH",
  "ARK_OMP_SESSIONS",
  "ARK_CLAUDE_SESSIONS",
  "ARK_CODEX_SESSIONS",
  "ORCA_AGENT_SESSION_ID",
  "ARK_PROJECT",
  "FAKE_COMPANION_DIR",
] as const;

let directory = "";
let original: Record<string, string | undefined> = {};

const readLines = (name: string): string[][] =>
  existsSync(join(directory, name))
    ? readFileSync(join(directory, name), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
    : [];
const readConfig = (): FakeCompanionConfig =>
  JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));

function setRow(dispatch: string, patch: Partial<WorkerRowOfFake>): void {
  const file = join(directory, "workers", `${dispatch}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
}

const handle: FakeCompanionTools = {
  configure: (patch) =>
    writeFileSync(join(directory, "config.json"), JSON.stringify({ ...readConfig(), ...patch })),
  calls: () => readLines("calls.jsonl"),
  verbs: () =>
    readLines("calls.jsonl").map((args) =>
      args[0] === "orchestration" ? args[1] : `${args[0]} ${args[1]}`,
    ),
  clearCalls: () => {
    for (const name of [
      "calls.jsonl",
      "started.jsonl",
      "delivered.jsonl",
      "gh-calls.jsonl",
      "hung-done.jsonl",
    ])
      rmSync(join(directory, name), { force: true });
  },
  sent: () =>
    readLines("delivered.jsonl").map((args) => ({
      to: flagOf(args, "--to")!,
      from: flagOf(args, "--from"),
      subject: flagOf(args, "--subject")!,
      body: flagOf(args, "--body")!,
      type: flagOf(args, "--type"),
    })),
  started: () =>
    readLines("started.jsonl").map((args) => ({
      title: flagOf(args, "--task-title")!,
      run: flagOf(args, "--run"),
      keepOpen: args.includes("--keep-open"),
      worktree: flagOf(args, "--worktree")!.replace(/^path:/, ""),
      agent: flagOf(args, "--agent"),
      model: flagOf(args, "--model"),
      spec: flagOf(args, "--spec")!,
    })),
  rows: () =>
    readdirSync(join(directory, "workers"))
      .toSorted()
      .map(
        (name) =>
          JSON.parse(readFileSync(join(directory, "workers", name), "utf8")) as WorkerRowOfFake,
      ),
  live: () =>
    handle
      .rows()
      .filter((row) => row.liveness === "live")
      .map((row) => row.dispatchId),
  retain: (dispatch) => setRow(dispatch, { terminalState: "retained" }),
  close: (dispatch) => setRow(dispatch, { liveness: "exited", terminalState: "closed" }),
  setCi: (mode, failed = []) =>
    writeFileSync(join(directory, "gh.json"), JSON.stringify({ mode, failed })),
  ghCalls: () => readLines("gh-calls.jsonl"),
  hungDone: () => readLines("hung-done.jsonl"),
};

function writeExecutable(name: string, text: string): void {
  writeFileSync(join(directory, "bin", name), text);
  chmodSync(join(directory, "bin", name), 0o755);
}

/**
 * Puts the fake `orca` and `gh` first on PATH, with scratch session folders (so no start scans the
 * real ones) and no Orca session: `ORCA_AGENT_SESSION_ID` is deleted, as in the hub process. A test
 * that wants a session sets the variable itself. `workspace` is the connected Master Chief's folder
 * and the one worktree `worker-start` accepts; `project` names Master Chief's Run.
 */
export function installFakeCompanionTools(options: {
  project: string;
  workspace: string;
}): FakeCompanionTools {
  removeFakeCompanionTools();
  original = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  directory = mkdtempSync(join(tmpdir(), "ark-fake-companion-"));
  for (const folder of ["bin", "workers", "ids"]) mkdirSync(join(directory, folder));
  writeExecutable("orca", orcaScript);
  writeExecutable("gh", ghScript);
  const config: FakeCompanionConfig = {
    runs: [
      {
        id: "run_chief",
        objective: `Master Chief: ${options.project} tickets`,
        coordinator_handle: "term_chief",
      },
    ],
    chiefRunId: "run_chief",
    leads: [],
    terminals: [{ handle: "term_chief", connected: true, worktreePath: options.workspace }],
    knownWorktrees: [options.workspace],
  };
  writeFileSync(join(directory, "config.json"), JSON.stringify(config));
  handle.setCi("pass");
  for (const harness of ["omp", "claude", "codex"])
    mkdirSync(join(directory, "sessions", harness), { recursive: true });
  process.env.PATH = `${join(directory, "bin")}:${original.PATH}`;
  process.env.FAKE_COMPANION_DIR = directory;
  process.env.ARK_OMP_SESSIONS = join(directory, "sessions/omp");
  process.env.ARK_CLAUDE_SESSIONS = join(directory, "sessions/claude");
  process.env.ARK_CODEX_SESSIONS = join(directory, "sessions/codex");
  delete process.env.ORCA_AGENT_SESSION_ID;
  delete process.env.ARK_PROJECT;
  return handle;
}

/** Restores the environment and removes the scratch folder. Safe to call twice. */
export function removeFakeCompanionTools(): void {
  if (directory === "") return;
  for (const name of environmentNames) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
  rmSync(directory, { recursive: true, force: true });
  directory = "";
}
