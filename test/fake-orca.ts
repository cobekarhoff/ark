import { afterEach, beforeEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import { tempGitRepo } from "./helpers.ts";

// Fake `orca` for the commands `ark run step` calls: worker-start (--agent and --terminal), terminal
// create, list and close, and the empty run and worker lists. State lives in $FAKE_ORCA_DIR/state.json,
// which a test edits between calls. Every call is logged to calls.jsonl, every worker-start spec to
// workers.jsonl. A worker-start --agent writes one session file for its worktree into the session folder
// of its harness unless the state says `writeSession: false`.
const script = `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.env.FAKE_ORCA_DIR;
const args = process.argv.slice(2);
appendFileSync(join(directory, "calls.jsonl"), JSON.stringify(args) + "\\n");
const stateFile = join(directory, "state.json");
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const reply = (result) => console.log(JSON.stringify({ ok: true, result }));
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const fail = (message) => { console.error(message); process.exit(1); };
const newTerminal = (worktree) => {
  const handle = "term_" + state.next++;
  state.terminals[handle] = { connected: true, worktreePath: worktree };
  return handle;
};
const worktreePath = (selector) => (selector ?? "").replace(/^path:/, "");
const sessionFolders = {
  omp: process.env.ARK_OMP_SESSIONS,
  claude: process.env.ARK_CLAUDE_SESSIONS,
  codex: process.env.ARK_CODEX_SESSIONS,
};
const [group, verb] = args;
if (group === "orchestration" && verb === "worker-start") {
  const worktree = worktreePath(flag("--worktree"));
  const terminal = flag("--terminal");
  appendFileSync(
    join(directory, "workers.jsonl"),
    JSON.stringify({ kind: terminal ? "bind" : "agent", spec: flag("--spec"), args }) + "\\n",
  );
  if (terminal) {
    if (state.failBind) fail("bind refused");
    reply({ dispatchId: "ctx_" + state.next++, effects: [] });
  } else {
    if (state.failWorkerStart) fail("worker-start refused");
    const handle = newTerminal(worktree);
    if (state.writeSession !== false) {
      const folder = join(sessionFolders[flag("--agent")], "scratch");
      mkdirSync(folder, { recursive: true });
      const session = "session-" + state.next++;
      writeFileSync(
        join(folder, session + ".jsonl"),
        JSON.stringify({ type: "session", id: session, timestamp: new Date().toISOString(), cwd: worktree }) + "\\n",
      );
    }
    reply({ dispatchId: "ctx_" + state.next++, effects: [{ kind: "terminal", id: handle }] });
  }
  save();
} else if (group === "terminal" && verb === "create") {
  if (state.failTerminalCreate) fail("terminal create refused");
  const handle = newTerminal(worktreePath(flag("--worktree")));
  save();
  reply({ terminal: { handle } });
} else if (group === "terminal" && verb === "close") {
  delete state.terminals[flag("--terminal")];
  save();
  reply({});
} else if (group === "terminal" && verb === "list") {
  if (state.failList) fail("terminal list refused");
  reply({ terminals: Object.entries(state.terminals).map(([handle, row]) => ({ handle, ...row })) });
} else if (group === "orchestration" && verb === "run-list") reply({ runs: [], nextCursor: null });
else if (group === "orchestration" && verb === "worker-list") reply({ workers: [], nextCursor: null });
else if (group === "orchestration" && verb === "worker-release") reply({});
else process.exit(2);
`;

export type FakeWorkerStart = { kind: "agent" | "bind"; spec: string; args: string[] };

export type FakeOrca = {
  /** The call log: one argument list for each `orca` call, in order. */
  calls(): string[][];
  /** Each `worker-start` the fake received: `agent` (fresh) or `bind` (a restore terminal), with its spec. */
  workers(): FakeWorkerStart[];
  /** Handles the fake holds now, with their `connected` flag. */
  terminals(): Record<string, { connected: boolean }>;
  /** Merges `patch` into the state the fake reads: failWorkerStart, failTerminalCreate, failBind, failList, writeSession, terminals. */
  configure(patch: Record<string, unknown>): void;
};

let directory = "";
const environment = () => ({
  path: process.env.PATH,
  omp: process.env.ARK_OMP_SESSIONS,
  claude: process.env.ARK_CLAUDE_SESSIONS,
  codex: process.env.ARK_CODEX_SESSIONS,
  session: process.env.ORCA_AGENT_SESSION_ID,
});
/** The variables as they were when the fake was installed, so removing it restores what the test file had set. */
let original = environment();
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const readLines = (name: string): unknown[] =>
  existsSync(join(directory, name))
    ? readFileSync(join(directory, name), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
const readState = () => JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));

/** Reads the call log and edits the state of the fake `orca` installed now. */
const handle: FakeOrca = {
  calls: () => readLines("calls.jsonl") as string[][],
  workers: () => readLines("workers.jsonl") as FakeWorkerStart[],
  terminals: () => readState().terminals,
  configure: (patch) =>
    writeFileSync(join(directory, "state.json"), JSON.stringify({ ...readState(), ...patch })),
};

/**
 * Puts the fake `orca` first on PATH, with scratch session folders for omp, claude and codex (so no
 * start scans the real ones) and the run lead's session id. Call it inside a test of a file that
 * registers `removeFakeOrca` in afterEach, or let `useFakeOrca` do both for every test.
 */
export function installFakeOrca(): FakeOrca {
  removeFakeOrca();
  original = environment();
  directory = mkdtempSync(join(tmpdir(), "ark-fake-orca-"));
  mkdirSync(join(directory, "bin"));
  writeFileSync(join(directory, "bin/orca"), script);
  chmodSync(join(directory, "bin/orca"), 0o755);
  writeFileSync(join(directory, "state.json"), JSON.stringify({ next: 1, terminals: {} }));
  for (const harness of ["omp", "claude", "codex"])
    mkdirSync(join(directory, "sessions", harness), { recursive: true });
  process.env.PATH = `${join(directory, "bin")}:${original.path}`;
  process.env.FAKE_ORCA_DIR = directory;
  process.env.ARK_OMP_SESSIONS = join(directory, "sessions/omp");
  process.env.ARK_CLAUDE_SESSIONS = join(directory, "sessions/claude");
  process.env.ARK_CODEX_SESSIONS = join(directory, "sessions/codex");
  process.env.ORCA_AGENT_SESSION_ID = "run-lead-1";
  return handle;
}

/** Undoes `installFakeOrca`: restores the environment and removes the scratch folders. Safe to call twice. */
export function removeFakeOrca(): void {
  if (directory === "") return;
  restore("PATH", original.path);
  restore("ARK_OMP_SESSIONS", original.omp);
  restore("ARK_CLAUDE_SESSIONS", original.claude);
  restore("ARK_CODEX_SESSIONS", original.codex);
  restore("ORCA_AGENT_SESSION_ID", original.session);
  delete process.env.FAKE_ORCA_DIR;
  rmSync(directory, { recursive: true, force: true });
  directory = "";
}

/** The fake `orca` for every test of the calling file. */
export function useFakeOrca(): FakeOrca {
  beforeEach(() => void installFakeOrca());
  afterEach(removeFakeOrca);
  return handle;
}

/** The omp session folder of the fake: put a session file here to be found by a watching start. */
export const fakeSessionFolder = (harness = "omp"): string => join(directory, "sessions", harness);

/**
 * Records a worktree for `repo` in the run (what `ark worktree create` records) at `path`, a scratch git
 * repo by default, so `ark run step start` can start a worker in it. Returns the path.
 */
export function addWorktree(runDirectory: string, repo = ".", path = tempGitRepo()): string {
  appendEvent(runDirectory, "worktree.created", {
    repo,
    path,
    branch: "ark/test",
    base: "main",
  });
  return path;
}
