// Test support of the hub tests that start a real `hub/main.ts` on fake tools (test/hub-stall.test.ts, test/hub-home-lag.test.ts):
// `stage()` (a temp ARK_HOME, empty session roots and the fake `orca`, `gh`, `omp`, `plannotator`, `ps` and `lsof` on PATH),
// `startHub`, the `/events` page, the health route and the health prober. No `test(` here: the tests that use it own the cases.
//
// Waiting rule (test/wallclock.test.ts, ARK-T126): that guard scans only `*.test.ts` and `*.pw.ts` files, so this module is
// outside it; it still holds no timer and no sleep. Every wait is an event: a request loop (the requests are the wait), a
// process exit or a stream read. The `sleep` of the fake `orca` is a fixture, not a wait of the test.
import { afterAll, afterEach, beforeAll } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import type { Snapshot } from "../hub/types.ts";
import { tempArkHome } from "./helpers.ts";
import {
  windowMessage as lagWindowMessage,
  type WindowLine,
  type WindowProbe,
} from "./hub-stall-window.ts";

const root = resolve(import.meta.dir, "..");

let savedEnvironment: NodeJS.ProcessEnv;
export const processes: Subprocess[] = [];
export const pages: { close(): void }[] = [];

/** Registers the hooks of the calling test file: the environment it started with comes back, and every page and process ends. */
export function installHooks(): void {
  beforeAll(() => {
    savedEnvironment = { ...process.env };
  });
  afterEach(() => {
    for (const page of pages.splice(0)) page.close();
    for (const child of processes.splice(0)) {
      try {
        process.kill(child.pid, "SIGCONT"); // a stopped process still ends on SIGKILL, but a CONT keeps the state tidy
      } catch {
        // Already gone.
      }
      child.kill("SIGKILL");
    }
  });
  afterAll(() => {
    for (const key of Object.keys(process.env))
      if (!(key in savedEnvironment)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
  });
}

// ---------------------------------------------------------------- fake tools

const validView = JSON.stringify({
  state: "OPEN",
  statusCheckRollup: [],
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
});

export type Stage = {
  home: string;
  state: string;
  /** Lines in `<state>/<file>`; 0 when the file does not exist. */
  lines(file: string): number;
  set(file: string, text: string): void;
  remove(file: string): void;
};

/**
 * A fresh ARK_HOME, session roots and fake tools on PATH. The fake `orca` holds `terminal list` while `orca.hold`
 * exists and for `orca.sleep` seconds, and appends a line to `orca.done` when a call that waited ends. Its
 * opt-in answers are described where the state files are written: `orca.workers*`, `orca.tasks`, `orca.fail` and
 * `orca.null` by ARK-T734 and ARK-T735 (test/hub-stall.test.ts), `orca.tasks.pending`, `orca.chief-inbox`, `ps.table`
 * and `lsof.table` by ARK-T751 (test/hub-home-lag.test.ts); with none of them every fake answers as it always did.
 */
export function stage(): Stage {
  const home = tempArkHome();
  process.env.ARK_OMP_SESSIONS = mkdtempSync(join(tmpdir(), "ark-stall-omp-"));
  process.env.ARK_CLAUDE_SESSIONS = mkdtempSync(join(tmpdir(), "ark-stall-claude-"));
  process.env.ARK_CODEX_SESSIONS = mkdtempSync(join(tmpdir(), "ark-stall-codex-"));
  const state = mkdtempSync(join(tmpdir(), "ark-stall-state-"));
  const bin = mkdtempSync(join(tmpdir(), "ark-stall-bin-"));
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nS='${state}'\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script(
    "orca",
    `echo "$*" >> "$S/orca.log"
if [ "$1 $2" = "terminal list" ]; then
  echo x >> "$S/orca.terminal-list"
  delayed=0
  waited=0
  while [ -e "$S/orca.hold" ] && [ "$waited" -lt 1500 ]; do delayed=1; sleep 0.02; waited=$((waited + 1)); done
  seconds=$(cat "$S/orca.sleep" 2>/dev/null || echo 0)
  if [ "$seconds" != 0 ]; then delayed=1; sleep "$seconds"; fi
  [ "$delayed" = 1 ] && echo x >> "$S/orca.done"
  cat "$S/orca.terminals"
  exit 0
fi
# Opt-in state files, written only by ARK-T734, ARK-T735 and ARK-T751: worker-list answers orca.workers.<orca run id>, else orca.workers,
# and task-list answers orca.tasks, except a call with --status pending, which answers orca.tasks.pending when that file exists; with none
# of them the answer is the empty list. A call of inbox with --terminal answers orca.chief-inbox when that file exists.
# A line of orca.fail makes one call exit 1: "<verb> <orca run id>" for worker-list and task-list, "run-list", or "inbox" (every inbox call without --terminal).
orcaRunId=""
previousArgument=""
for argument in "$@"; do
  [ "$previousArgument" = "--run" ] && orcaRunId="$argument"
  previousArgument="$argument"
done
if [ -e "$S/orca.fail" ]; then
  failKey="$2"
  case "$2" in
    worker-list|task-list) failKey="$2 $orcaRunId" ;;
    inbox) case " $* " in *" --terminal "*) failKey="" ;; esac ;;
  esac
  [ -n "$failKey" ] && grep -qxF -- "$failKey" "$S/orca.fail" && exit 1
fi
# A line "<verb> <orca run id>" of orca.null (ARK-T735, worker-list or task-list) answers {"result":null}: exit 0, no rows.
if [ -e "$S/orca.null" ] && grep -qxF -- "$2 $orcaRunId" "$S/orca.null"; then echo '{"result":null}'; exit 0; fi
case "$1 $2" in
  "terminal switch") echo '{"result":{}}' ;;
  "orchestration run-list") cat "$S/orca.runs" ;;
  "orchestration worker-list")
    if [ -e "$S/orca.workers.$orcaRunId" ]; then cat "$S/orca.workers.$orcaRunId"
    elif [ -e "$S/orca.workers" ]; then cat "$S/orca.workers"
    else echo '{"result":{"workers":[]}}'; fi ;;
  "orchestration task-list")
    pendingCall=0
    case " $* " in *" --status pending "*) pendingCall=1 ;; esac
    if [ "$pendingCall" = 1 ] && [ -e "$S/orca.tasks.pending" ]; then cat "$S/orca.tasks.pending"
    elif [ -e "$S/orca.tasks" ]; then cat "$S/orca.tasks"
    else echo '{"result":{"tasks":[]}}'; fi ;;
  "orchestration inbox")
    case " $* " in
      *" --terminal "*)
        if [ -e "$S/orca.chief-inbox" ]; then cat "$S/orca.chief-inbox"
        else echo '{"result":{"messages":[]}}'; fi ;;
      *) cat "$S/orca.inbox" ;;
    esac ;;
  "worktree ps") echo '{"result":{"worktrees":[]}}' ;;
  *) exit 1 ;;
esac`,
  );
  script("plannotator", `echo '[]'`);
  script("gh", `cat "$S/gh.view"`);
  script("omp", `echo '{"reports":[]}'`);
  // The resources source reads the live CPU and load, which change on every sample; most tests are about the readers, so
  // by default `ps` and `lsof` fail and the source never samples. ARK-T751 writes ps.table and lsof.table to make them answer.
  script("fake-ps", `if [ -e "$S/ps.table" ]; then cat "$S/ps.table"; else exit 1; fi`);
  // A real `lsof` takes seconds on a busy host and would be a slow pass of its own.
  script("fake-lsof", `if [ -e "$S/lsof.table" ]; then cat "$S/lsof.table"; else exit 1; fi`);
  process.env.ARK_PS = join(bin, "fake-ps");
  process.env.ARK_LSOF = join(bin, "fake-lsof");
  process.env.ARK_READER_TIMEOUT_MS = "30000";
  process.env.PATH = `${bin}:${savedEnvironment.PATH}`;
  const stageState: Stage = {
    home,
    state,
    lines: (file) =>
      existsSync(join(state, file))
        ? readFileSync(join(state, file), "utf8").split("\n").filter(Boolean).length
        : 0,
    set: (file, text) => writeFileSync(join(state, file), text),
    remove: (file) => rmSync(join(state, file), { force: true }),
  };
  stageState.set("gh.view", validView);
  stageState.set("orca.runs", JSON.stringify({ result: { runs: [] } }));
  stageState.set("orca.inbox", JSON.stringify({ result: { messages: [] } }));
  stageState.set(
    "orca.terminals",
    JSON.stringify({
      result: { terminals: [{ handle: "term-lead", connected: true, agentIdentity: "omp" }] },
    }),
  );
  return stageState;
}

// ---------------------------------------------------------------- hub processes and pages

export type Hub = {
  child: Subprocess<"ignore", "pipe", "pipe">;
  pid: number;
  /** Everything the hub wrote to stdout and stderr: what launchd puts in `hub.log`. */
  output(): string;
  port(): number;
  baseUrl(): string;
  exited: Promise<number>;
};

/**
 * `bun <repository>/hub/main.ts --port 0` with the test's environment. The default intervals apply unless
 * `interval` is given: `ARK_HUB_INTERVAL_MS` and `ARK_PROVIDER_LIMITS_MS` come out of the environment.
 */
export async function startHub(
  options: { interval?: number; repository?: string; environment?: Record<string, string> } = {},
): Promise<Hub> {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    ...options.environment,
  };
  delete environment.ARK_HUB_INTERVAL_MS;
  delete environment.ARK_PROVIDER_LIMITS_MS;
  if (options.interval) environment.ARK_HUB_INTERVAL_MS = String(options.interval);
  const child = Bun.spawn(
    ["bun", join(options.repository ?? root, "hub", "main.ts"), "--port", "0"],
    {
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  processes.push(child);
  let text = "";
  const { promise: printed, resolve: found, reject: failed } = Promise.withResolvers<number>();
  const follow = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      text += new TextDecoder().decode(chunk);
      const printedPort = /Ark hub on http:\/\/127\.0\.0\.1:(\d+)/.exec(text)?.[1];
      if (printedPort) found(Number(printedPort));
    }
  };
  void follow(child.stdout);
  void follow(child.stderr);
  // The port line is the event; the hub exiting first is a failure with its output.
  void child.exited.then(() => failed(new Error(`the hub exited before it served: ${text}`)));
  const port = await printed;
  return {
    child,
    pid: child.pid,
    output: () => text,
    port: () => port,
    baseUrl: () => `http://127.0.0.1:${port}`,
    exited: child.exited,
  };
}

/**
 * One page: `GET /events` held open and read until `close()`. `seen()` turns true at the first push that holds
 * the runs and stays true; it stays false if the stream fails. `latest()` is the last push, parsed.
 */
export function openPage(hub: Hub): {
  close(): void;
  seen(): boolean;
  latest(): Snapshot | undefined;
} {
  const controller = new AbortController();
  let seen = false;
  let latest: Snapshot | undefined;
  void (async () => {
    try {
      const response = await fetch(`${hub.baseUrl()}/events`, { signal: controller.signal });
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of response.body!) {
        buffered += decoder.decode(chunk, { stream: true });
        const messages = buffered.split("\n\n");
        buffered = messages.pop() ?? "";
        for (const message of messages)
          if (message.startsWith("data: ")) {
            const snapshot = JSON.parse(message.slice("data: ".length)) as Snapshot;
            if (Array.isArray(snapshot.runs)) seen = true;
            latest = snapshot;
          }
      }
    } catch {
      // The page was closed.
    }
  })();
  const page = { close: () => controller.abort(), seen: () => seen, latest: () => latest };
  pages.push(page);
  return page;
}

// ---------------------------------------------------------------- the health route

export type PassHealth = {
  last_ms: number | null;
  ended_at: string | number | null;
  slow: boolean;
};
export type Health = {
  lag_ms: number | null;
  sources: Record<string, PassHealth>;
  slow: string[];
};
export type HealthAnswer = { status: number; milliseconds: number; text: string; health: Health };

/** `GET /api/health`: the status, the time of the request and the parsed body (a non-JSON body fails with its text). */
export async function readHealth(
  hub: Hub,
  headers: Record<string, string> = {},
): Promise<HealthAnswer> {
  const started = performance.now();
  const response = await fetch(`${hub.baseUrl()}/api/health`, { headers });
  const text = await response.text();
  const milliseconds = performance.now() - started;
  let health: Health | undefined;
  try {
    health = JSON.parse(text) as Health;
  } catch {
    // Reported below with the text.
  }
  if (response.status === 200 && health === undefined)
    throw new Error(`GET /api/health answered 200 with a body that is not JSON: ${text}`);
  return { status: response.status, milliseconds, text, health: health as Health };
}

/** An answer that must be a 200 with the fields of the route. */
export async function health(hub: Hub): Promise<HealthAnswer> {
  const answer = await readHealth(hub);
  if (answer.status !== 200)
    throw new Error(`GET /api/health answered ${answer.status}: ${answer.text.slice(0, 200)}`);
  return answer;
}

export const endedAt = (pass: PassHealth | undefined): number | null =>
  pass?.ended_at == null
    ? null
    : typeof pass.ended_at === "number"
      ? pass.ended_at
      : Date.parse(pass.ended_at);

export const snapshotOf = async (hub: Hub): Promise<Snapshot> =>
  (await fetch(`${hub.baseUrl()}/api/snapshot`)).json() as Promise<Snapshot>;

/**
 * Health probes of one hub, and the hub's new output lines stamped with the time of the probe that read them:
 * the input of `windowMessage` (ARK-T730). `untilPasses` reads the route back to back until each of the `sources`
 * has ended `count` more passes; the requests are the wait. `caseId` starts the message.
 */
export function healthProber(hub: Hub, options: { caseId: string; sources: string[] }) {
  const startEpoch = Date.now();
  const start = performance.now();
  const probes: WindowProbe[] = [];
  const lines: WindowLine[] = [];
  let outputRead = 0;
  const probe = async (): Promise<Health> => {
    const { health: answer } = await health(hub);
    const at = Math.round(performance.now() - start);
    probes.push({
      at,
      lag_ms: answer.lag_ms ?? null,
      sources: answer.sources as WindowProbe["sources"],
    });
    const output = hub.output();
    const wholeEnd = output.lastIndexOf("\n") + 1;
    if (wholeEnd > outputRead) {
      for (const text of output.slice(outputRead, wholeEnd).split("\n"))
        if (text.length > 0) lines.push({ at, text });
      outputRead = wholeEnd;
    }
    return answer;
  };
  return {
    probe,
    async untilPasses(count: number): Promise<void> {
      const last = new Map<string, number | null>();
      const passes = new Map<string, number>();
      const first = (await probe()).sources;
      for (const name of options.sources) {
        last.set(name, endedAt(first?.[name]));
        passes.set(name, 0);
      }
      while ([...passes.values()].some((done) => done < count)) {
        const sources = (await probe()).sources;
        for (const name of options.sources) {
          const ended = endedAt(sources?.[name]);
          if (ended !== null && ended !== last.get(name)) {
            last.set(name, ended);
            passes.set(name, passes.get(name)! + 1);
          }
        }
      }
    },
    /** The largest `lag_ms` of the probes from index `since` on. */
    largestLag: (since = 0) =>
      Math.max(0, ...probes.slice(since).map((entry) => entry.lag_ms ?? 0)),
    probeCount: () => probes.length,
    message: () => `${options.caseId} ${lagWindowMessage(probes, lines, startEpoch)}`,
  };
}
