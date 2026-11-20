// ARK-533: the hub answers every request within 1 s on a large home, reports its loop lag and the pass
// time of each source on a health route, logs a slow pass and a loop lag above 1 s, and `ark chief
// state` and `ark services status` print a Hub line that says stalled. Real `hub/main.ts` processes with
// fake `orca`, `gh`, `omp` and `plannotator` on PATH.
//
// Waiting rule (test/wallclock.test.ts, ARK-T126): no timer and no sleep in this file. Every wait is an
// event: a request loop (the requests are the wait), a process exit, a stream read or a marker file of a
// fake tool. A fixed delay that stands for a slow tool lives in a fixture: the fake `orca`,
// `test/fixtures/hub-stall/freeze.sh` and `test/fixtures/hub-stall/delay-proxy.ts`.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { sourceAffects, type Snapshot } from "../hub/types.ts";
import {
  ompSessionText,
  runDirectoryOf,
  today,
  transcriptText,
  writeBacklogTicket,
  writeRun,
} from "./hub-fixtures.ts";
import { tempArkHome, tempGitRepo, writeProject } from "./helpers.ts";

setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, "..");
const fixtures = join(import.meta.dir, "fixtures", "hub-stall");

/** A request must be answered within 1 s (ARK-533/AC1). */
const answerLimitMilliseconds = 1000;
/** A reader pass must hold the event loop for at most 200 ms (ARK-533/AC1). */
const lagLimitMilliseconds = 200;
/** The loop lag line of the log starts above 1 s (ARK-533/AC3). */
const lagLineMilliseconds = 1000;
/** `ark chief state` and `ark services status` call the hub stalled after 5 s (ARK-533/AC4). */
const stallLimitMilliseconds = 5000;
/** The health route keeps the largest lag of the last minute (ARK-533/AC2). */
const windowMilliseconds = 60_000;
/** `ARK_HUB_INTERVAL_MS` of the tests that need a normal pass below its interval and a forced slow pass above it. */
const slowTestIntervalMilliseconds = 4000;
/** The fake `orca` sleeps this long on `terminal list` for a forced slow pass. */
const orcaSleepSeconds = 6;

let savedEnvironment: NodeJS.ProcessEnv;
const processes: Subprocess[] = [];
const pages: { close(): void }[] = [];

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

// ---------------------------------------------------------------- fake tools

const validView = JSON.stringify({
  state: "OPEN",
  statusCheckRollup: [],
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
});

type Stage = {
  home: string;
  state: string;
  /** Lines in `<state>/<file>`; 0 when the file does not exist. */
  lines(file: string): number;
  set(file: string, text: string): void;
  remove(file: string): void;
};

/**
 * A fresh ARK_HOME, session roots and fake tools on PATH. The fake `orca` holds only `terminal list`
 * (the one call the `orca` source makes): while `orca.hold` exists, and for `orca.sleep` seconds. It
 * appends a line to `orca.done` when a call that waited ends.
 */
function stage(): Stage {
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
case "$1 $2" in
  "terminal switch") echo '{"result":{}}' ;;
  "orchestration run-list") cat "$S/orca.runs" ;;
  "orchestration worker-list") echo '{"result":{"workers":[]}}' ;;
  "orchestration task-list") echo '{"result":{"tasks":[]}}' ;;
  "orchestration inbox")
    case " $* " in
      *" --terminal "*) echo '{"result":{"messages":[]}}' ;;
      *) cat "$S/orca.inbox" ;;
    esac ;;
  "worktree ps") echo '{"result":{"worktrees":[]}}' ;;
  *) exit 1 ;;
esac`,
  );
  script("plannotator", `echo '[]'`);
  script("gh", `cat "$S/gh.view"`);
  script("omp", `echo '{"reports":[]}'`);
  // The resources source reads the live CPU and load, which change on every sample; this test is about the readers.
  script("fake-ps", "exit 1");
  script("fake-lsof", "exit 1"); // a real `lsof` takes seconds on a busy host and would be a slow pass of its own
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

const project = "p";

/** Three runs in `building`, so every source has something to read. */
function threeRuns(): string[] {
  return [1, 2, 3].map((number) => {
    const run = `${today()}-ARK-9${number}-1`;
    writeRun({
      project,
      run,
      ticket: { id: `ARK-9${number}`, title: `Stall ${number}` },
      phase: "building",
    });
    return run;
  });
}

// ---------------------------------------------------------------- hub processes and pages

type Hub = {
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
async function startHub(
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
 * the runs and stays true; it stays false if the stream fails.
 */
function openPage(hub: Hub): { close(): void; seen(): boolean } {
  const controller = new AbortController();
  let seen = false;
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
            const snapshot = JSON.parse(message.slice("data: ".length)) as { runs?: unknown };
            if (Array.isArray(snapshot.runs)) seen = true;
          }
      }
    } catch {
      // The page was closed.
    }
  })();
  const page = { close: () => controller.abort(), seen: () => seen };
  pages.push(page);
  return page;
}

// ---------------------------------------------------------------- the health route

type PassHealth = { last_ms: number | null; ended_at: string | number | null; slow: boolean };
type Health = {
  lag_ms: number | null;
  sources: Record<string, PassHealth>;
  slow: string[];
};
type HealthAnswer = { status: number; milliseconds: number; text: string; health: Health };

/** `GET /api/health`: the status, the time of the request and the parsed body (a non-JSON body fails with its text). */
async function readHealth(hub: Hub, headers: Record<string, string> = {}): Promise<HealthAnswer> {
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
async function health(hub: Hub): Promise<HealthAnswer> {
  const answer = await readHealth(hub);
  if (answer.status !== 200)
    throw new Error(`GET /api/health answered ${answer.status}: ${answer.text.slice(0, 200)}`);
  return answer;
}

const endedAt = (pass: PassHealth | undefined): number | null =>
  pass?.ended_at == null
    ? null
    : typeof pass.ended_at === "number"
      ? pass.ended_at
      : Date.parse(pass.ended_at);

/**
 * Reads the route back to back until `done` holds: the requests are the wait. Every answer must
 * be within the answer limit, and each source's `slow` flag must follow its own last pass (duration
 * above the interval). The case timeout is the only upper bound.
 */
async function pollHealth(
  hub: Hub,
  done: (answer: HealthAnswer) => boolean,
  interval = slowTestIntervalMilliseconds,
): Promise<HealthAnswer> {
  for (;;) {
    const answer = await health(hub);
    if (answer.milliseconds > answerLimitMilliseconds)
      throw new Error(`GET /api/health took ${Math.round(answer.milliseconds)} ms`);
    for (const [name, pass] of Object.entries(answer.health.sources ?? {}))
      if (
        pass.last_ms !== null &&
        pass.last_ms !== undefined &&
        pass.slow !== pass.last_ms > interval
      )
        throw new Error(
          `${name}: slow is ${pass.slow} for a pass of ${pass.last_ms} ms, interval ${interval} ms`,
        );
    if (done(answer)) return answer;
  }
}

const snapshotOf = async (hub: Hub): Promise<Snapshot> =>
  (await fetch(`${hub.baseUrl()}/api/snapshot`)).json() as Promise<Snapshot>;

/** `freeze.sh`: stop the hub, hold it, continue it. Resolves when the hub runs again. */
const freeze = (hub: Hub, seconds: number) =>
  Bun.spawn(["sh", join(fixtures, "freeze.sh"), String(hub.pid), String(seconds)], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;

/** Each duration written in a line, in ms: `6100 ms`, `1.45 s`. */
const durationsOf = (line: string): number[] =>
  [...line.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s)\b/g)].map(([, value, unit]) =>
    unit === "ms" ? Number(value) : Number(value) * 1000,
  );

const linesOf = (text: string) => text.split("\n").filter((line) => line.trim() !== "");
const startLine = /^Ark hub on http:\/\/127\.0\.0\.1:\d+$/;

// ---------------------------------------------------------------- ARK-T703

test("ARK-T703 With no page the health route answers and shows no pass and no lag, the hub still reads nothing, and a pass dropped when the last page leaves is not recorded as a pass", async () => {
  const fake = stage();
  threeRuns();
  const idleWindowMilliseconds = 2500; // above the 2000 ms interval
  const settleMilliseconds = 1000;
  const hub = await startHub({ interval: 2000 });

  // Step 1: no page, so no lag and no pass; the route still answers.
  const first = await health(hub);
  expect(first.milliseconds <= answerLimitMilliseconds).toBe(true);
  expect(first.health.lag_ms ?? null, "no page: no measured lag, not 0").toBeNull();
  for (const [name, pass] of Object.entries(first.health.sources ?? {})) {
    expect(pass.last_ms ?? null, `${name} duration with no page`).toBeNull();
    expect(pass.ended_at ?? null, `${name} end time with no page`).toBeNull();
  }
  expect(first.health.slow ?? []).toEqual([]);

  // Step 2: probe for longer than one interval; no read runs.
  const started = performance.now();
  while (performance.now() - started < idleWindowMilliseconds) await health(hub);
  expect(fake.lines("orca.terminal-list"), "an idle hub read Orca").toBe(0);
  expect((await health(hub)).health).toEqual(first.health);

  // Step 3: a page, with a held Orca read in flight and the first lag sample taken.
  fake.set("orca.hold", "");
  const page = openPage(hub);
  await pollHealth(
    hub,
    (answer) =>
      fake.lines("orca.terminal-list") >= 1 &&
      fake.lines("orca.done") === 0 &&
      typeof answer.health.lag_ms === "number",
    2000,
  );

  // Step 4: the last page leaves; the lag goes absent (the hub saw the disconnect) before the release.
  page.close();
  await pollHealth(
    hub,
    (answer) => {
      expect(fake.lines("orca.done"), "the held call ended before the page left").toBe(0);
      return (answer.health.lag_ms ?? null) === null;
    },
    2000,
  );
  fake.remove("orca.hold");

  // Steps 5 and 6: the dropped pass is no pass, at every probe after the release.
  await pollHealth(hub, () => fake.lines("orca.done") >= 1, 2000);
  const released = performance.now();
  do {
    const answer = await health(hub);
    expect(answer.milliseconds <= answerLimitMilliseconds).toBe(true);
    expect(answer.health.sources?.orca?.last_ms ?? null, "duration of a dropped pass").toBeNull();
    expect(endedAt(answer.health.sources?.orca), "end time of a dropped pass").toBeNull();
  } while (performance.now() - released < settleMilliseconds);
  const last = await health(hub);
  expect(last.health.sources?.orca?.last_ms ?? null).toBeNull();
}, 60_000);

// ---------------------------------------------------------------- ARK-T700

test("ARK-T700 The health route answers within 1 s with loop lag (the largest of the last minute) and, for each reader source, last pass duration and end time, and names a source whose last pass took longer than its interval", async () => {
  const fake = stage();
  threeRuns();
  fake.set("orca.sleep", String(orcaSleepSeconds));
  const testStart = Date.now();
  const hub = await startHub({ interval: slowTestIntervalMilliseconds });
  openPage(hub);

  // Step 2: the route answers while the slow Orca pass is in flight.
  await pollHealth(
    hub,
    () => fake.lines("orca.terminal-list") >= 1 && fake.lines("orca.done") === 0,
  );

  // Step 3: the slow pass ended; its duration, end time and slow flag.
  const slow = await pollHealth(hub, (answer) => endedAt(answer.health.sources?.orca) !== null);
  const snapshot = await snapshotOf(hub);
  expect(typeof slow.health.lag_ms, "lag_ms").toBe("number");
  const orca = slow.health.sources.orca;
  expect(orca.last_ms! >= orcaSleepSeconds * 1000, `orca pass took ${orca.last_ms} ms`).toBe(true);
  expect(endedAt(orca)! >= testStart && endedAt(orca)! <= Date.now(), "orca end time").toBe(true);
  expect(orca.slow).toBe(true);
  expect(slow.health.slow).toContain("orca");
  expect(snapshot.sources.orca.ok, "the slow call completed, it did not time out").toBe(true);
  expect(fake.lines("orca.done")).toBeGreaterThanOrEqual(1);
  for (const name of Object.keys(snapshot.sources))
    expect(slow.health.sources[name], `${name} has an entry`).toBeDefined();
  for (const name of ["ark", "usage", "evidence"]) {
    expect(slow.health.sources[name].slow, `${name} slow`).toBe(false);
    expect(slow.health.sources[name].last_ms, `${name} duration`).not.toBeNull();
    expect(endedAt(slow.health.sources[name]), `${name} end time`).not.toBeNull();
  }
  expect(slow.health.slow).not.toContain("ark");
  expect(slow.health.slow).not.toContain("usage");

  // Step 4: a normal pass clears the flag.
  fake.set("orca.sleep", "0");
  const firstEnd = endedAt(orca)!;
  const recovered = await pollHealth(
    hub,
    (answer) => endedAt(answer.health.sources.orca)! > firstEnd && !answer.health.sources.orca.slow,
  );
  expect(recovered.health.sources.orca.last_ms! <= slowTestIntervalMilliseconds).toBe(true);
  expect(recovered.health.slow).not.toContain("orca");

  // Step 5: a 1.5 s freeze is the largest lag the route reports, as soon as the loop runs again.
  await freeze(hub, 1.5);
  const freezeEndedAt = performance.now();
  let requests = 0;
  const frozen = await pollHealth(hub, (answer) => {
    requests += 1;
    expect(requests, "requests after the freeze without a lag of 1 s").toBeLessThanOrEqual(500);
    return (answer.health.lag_ms ?? 0) >= lagLineMilliseconds;
  });
  const frozenLag = frozen.health.lag_ms!;

  // Step 6: after later passes the maximum is still there, not the latest sample.
  const arkEnd = endedAt(frozen.health.sources.ark)!;
  const later = await pollHealth(hub, (answer) => endedAt(answer.health.sources.ark)! > arkEnd);
  expect(later.health.lag_ms!).toBeGreaterThanOrEqual(frozenLag);

  // Step 7: the lag expires with its window.
  const expired = await pollHealth(hub, (answer) => (answer.health.lag_ms ?? 0) < frozenLag);
  expect(
    performance.now() - freezeEndedAt >= windowMilliseconds - 5000,
    `the lag of the freeze expired after ${Math.round(performance.now() - freezeEndedAt)} ms`,
  ).toBe(true);
  expect(expired.health.lag_ms!).toBeLessThan(frozenLag);

  // Step 8: a foreign Origin is refused as on every other GET route.
  const headers = { origin: "http://evil.example" };
  const foreign = await readHealth(hub, headers);
  const foreignSnapshot = await fetch(`${hub.baseUrl()}/api/snapshot`, { headers });
  expect(foreignSnapshot.status).toBe(403);
  expect(foreign.status).toBe(foreignSnapshot.status);
}, 150_000);

// ---------------------------------------------------------------- ARK-T701

test("ARK-T701 The hub logs one line for each pass longer than its interval and one for each loop lag above 1 s, naming the source and the duration, and no line for a normal pass or a lag below 1 s", async () => {
  const fake = stage();
  threeRuns();
  const sourceName =
    /\b(ark|orca|plannotator|github|usage|providerLimits|agentWait|evidence|queue|chiefUnread|resources)\b/;
  const endedTwice = new Map<string, Set<number>>();
  const watchEnds = (answer: HealthAnswer) => {
    for (const [name, pass] of Object.entries(answer.health.sources ?? {})) {
      const ended = endedAt(pass);
      if (ended === null) continue;
      endedTwice.set(name, (endedTwice.get(name) ?? new Set()).add(ended));
    }
  };

  // Scenario A: normal passes write nothing.
  const first = await startHub({ interval: slowTestIntervalMilliseconds });
  openPage(first);
  await pollHealth(first, (answer) => {
    watchEnds(answer);
    return (
      (endedTwice.get("ark")?.size ?? 0) >= 2 &&
      (endedTwice.get("usage")?.size ?? 0) >= 2 &&
      ["orca", "github", "evidence", "queue"].every(
        (name) => (endedTwice.get(name)?.size ?? 0) >= 1,
      )
    );
  });
  expect(linesOf(first.output()), `normal passes wrote a line: ${first.output()}`).toHaveLength(1);
  expect(first.output().trim()).toMatch(startLine);

  // Scenario C: a lag of 0.3 s writes nothing, a lag of 1.5 s writes one line.
  const advance = async () => {
    const before = Math.max(...(endedTwice.get("ark") ?? [0]));
    await pollHealth(first, (answer) => {
      watchEnds(answer);
      return endedAt(answer.health.sources.ark)! > before;
    });
  };
  await freeze(first, 0.3);
  await advance();
  expect(linesOf(first.output()), `a lag of 0.3 s wrote a line: ${first.output()}`).toHaveLength(1);

  await freeze(first, 1.5);
  await advance();
  await advance();
  const lagLines = linesOf(first.output()).slice(1);
  expect(lagLines, "a lag of 1.5 s writes one line").toHaveLength(1);
  expect(lagLines[0]).toMatch(/lag/i);
  expect(Math.max(...durationsOf(lagLines[0])) >= lagLineMilliseconds).toBe(true);
  expect(lagLines[0], "a lag line names no source").not.toMatch(sourceName);

  // Scenario B: two slow passes of orca on a second hub of the same home.
  pages.splice(0).forEach((page) => page.close());
  first.child.kill("SIGTERM");
  await first.exited;
  fake.set("orca.sleep", String(orcaSleepSeconds));
  const second = await startHub({ interval: slowTestIntervalMilliseconds });
  openPage(second);
  const orcaLines = () => linesOf(second.output()).filter((line) => /\borca\b/.test(line));
  endedTwice.clear();
  await pollHealth(second, (answer) => {
    watchEnds(answer);
    return endedAt(answer.health.sources.orca) !== null && orcaLines().length >= 1;
  });
  expect((await snapshotOf(second)).sources.orca.ok, "a completed slow call, not a timeout").toBe(
    true,
  );
  expect(orcaLines(), "one line for the first slow pass").toHaveLength(1);
  expect(Math.max(...durationsOf(orcaLines()[0])) >= orcaSleepSeconds * 1000).toBe(true);
  for (const name of ["ark", "usage", "plannotator", "evidence"])
    expect(
      linesOf(second.output()).filter((line) => new RegExp(`\\b${name}\\b`).test(line)),
      `a normal ${name} pass wrote a line`,
    ).toEqual([]);

  const firstEnd = Math.max(...(endedTwice.get("orca") ?? [0]));
  await pollHealth(
    second,
    (answer) => endedAt(answer.health.sources.orca)! > firstEnd && orcaLines().length >= 2,
  );
  const slowLines = orcaLines();
  expect(slowLines, "one line for each slow pass").toHaveLength(2);
  for (const line of slowLines)
    expect(Math.max(...durationsOf(line)) >= orcaSleepSeconds * 1000, line).toBe(true);
}, 90_000);

// ---------------------------------------------------------------- ARK-T702

/** The output of `ark <arguments>` started with the given home: its exit code, text and the time it took. */
type CommandOutput = { code: number; out: string; err: string; milliseconds: number };

async function runArk(home: string, arkArguments: string[]): Promise<CommandOutput> {
  const started = performance.now();
  const child = Bun.spawn(["bun", join(root, "cli", "ark.ts"), ...arkArguments], {
    env: { ...process.env, ARK_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(child);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err, milliseconds: performance.now() - started };
}

/** `ark chief state` and `ark services status` at the same time. */
const bothCommands = (home: string): Promise<[CommandOutput, CommandOutput]> =>
  Promise.all([
    runArk(home, ["chief", "state", "--project", project]),
    runArk(home, ["services", "status", "--project", project]),
  ]);

const hubLinesOf = (text: string) => linesOf(text).filter((line) => /^Hub\b/.test(line));
const shapeOf = (line: string) => line.replace(/\d+(?:\.\d+)?/g, "N");
/** A Hub line of a live hub: an answer time, then a loop lag, no word stalled. */
const isLiveLine = (line: string) => !/stalled/i.test(line) && durationsOf(line).length >= 2;
const isStalledLine = (line: string) =>
  /stalled/i.test(line) && !/answered/i.test(line) && !/lag/i.test(line);
/** The loop lag a live Hub line reports, in ms (the second duration of the line). */
const lagOfLine = (line: string) => durationsOf(line)[1];
/**
 * Both commands run between two reads of the health route. The route's lag is the largest of a 60 s
 * window, so it can only hold or grow in between: the lag a command prints lies between the reads.
 */
async function commandsBetweenReads(hub: Hub, home: string) {
  const before = (await health(hub)).health.lag_ms!;
  const outputs = await bothCommands(home);
  const after = (await health(hub)).health.lag_ms!;
  return { before, after, outputs };
}

test("ARK-T702 ark chief state and ark services status print a Hub line with the answer time and lag, say stalled after 5 s, and read a missing or dead hub as no hub, not as stalled", async () => {
  const fake = stage();
  const home = fake.home;
  const workspace = tempGitRepo();
  writeProject(project, {
    workspace,
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true {report}", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
      chief: { harness: "claude", model: "claude-opus" },
    },
    concurrency: 3,
    gates: { plan: "auto", strategy: "auto" },
  });
  fake.set(
    "orca.runs",
    JSON.stringify({
      result: { runs: [{ id: "run_chief", objective: `Master Chief: ${project} tickets` }] },
    }),
  );
  const launchctl = join(fake.state, "launchctl");
  writeFileSync(launchctl, "#!/bin/sh\nexit 113\n");
  chmodSync(launchctl, 0o755);
  process.env.HOME = mkdtempSync(join(tmpdir(), "ark-stall-home-"));
  process.env.ARK_LAUNCHCTL = launchctl;
  const lockFiles = (directory: string) =>
    readdirSync(directory).filter((name) => /^hub-[0-9a-f]+\.lock$/.test(name));

  // Step 1: no hub, no lock file: nothing is stalled and nothing is answered.
  expect(lockFiles(home)).toEqual([]);
  const noHubOutputs = async (label: string) => {
    for (const output of await bothCommands(home)) {
      expect(output.code, `${label}: ${output.err}`).toBe(0);
      expect(output.out, label).toMatch(/not installed/);
      expect(
        hubLinesOf(output.out).filter(isStalledLine),
        `${label}: a missing hub is not stalled`,
      ).toEqual([]);
      expect(hubLinesOf(output.out).filter(isLiveLine), `${label}: no hub answered`).toEqual([]);
    }
  };
  await noHubOutputs("no hub");

  // Step 3 (set up first, so step 2 can reuse its lock): a live hub and a page.
  const hub = await startHub({ interval: 2000 });
  openPage(hub);
  const [lockName] = lockFiles(home);
  expect(lockName, "the hub made a lock file in its home").toBeDefined();
  await pollHealth(hub, (answer) => typeof answer.health.lag_ms === "number", 2000);
  const { before, after, outputs: live } = await commandsBetweenReads(hub, home);
  for (const output of live) {
    expect(output.code, output.err).toBe(0);
    const lines = hubLinesOf(output.out);
    expect(lines, "one Hub line").toHaveLength(1);
    expect(isLiveLine(lines[0]), lines[0]).toBe(true);
    expect(durationsOf(lines[0])[0] <= answerLimitMilliseconds, lines[0]).toBe(true);
    expect(
      lagOfLine(lines[0]) >= before && lagOfLine(lines[0]) <= after,
      `${lines[0]}: the route read ${before} ms before and ${after} ms after`,
    ).toBe(true);
  }
  expect(shapeOf(hubLinesOf(live[0].out)[0])).toBe(shapeOf(hubLinesOf(live[1].out)[0]));
  const rowsOf = (text: string) => linesOf(text).filter((line) => !/^Hub\b/.test(line));
  const servicesOf = (text: string) =>
    text.split(/^## /m).find((part) => part.startsWith("Services"))!;
  expect(rowsOf(servicesOf(live[0].out)).slice(1).join("\n").trim()).toBe(
    rowsOf(live[1].out).join("\n").trim(),
  );

  // Step 4: a hub that answers 1.5 s after the request arrived is slow, not stalled.
  const proxyHome = mkdtempSync(join(tmpdir(), "ark-stall-proxy-home-"));
  const arrived = join(fake.state, "proxy.arrived");
  const proxy = Bun.spawn(
    ["bun", join(fixtures, "delay-proxy.ts"), String(hub.port()), "1.5", arrived],
    { stdout: "pipe", stderr: "ignore" },
  );
  processes.push(proxy);
  let proxyOutput = "";
  for await (const chunk of proxy.stdout) {
    proxyOutput += new TextDecoder().decode(chunk);
    if (/proxy on \d+/.test(proxyOutput)) break;
  }
  const proxyPort = Number(/proxy on (\d+)/.exec(proxyOutput)![1]);
  mkdirSync(join(proxyHome, "projects", project), { recursive: true });
  cpSync(
    join(home, "projects", project, "ark.yml"),
    join(proxyHome, "projects", project, "ark.yml"),
  );
  writeFileSync(join(proxyHome, lockName), JSON.stringify({ pid: hub.pid, port: proxyPort }));
  const slowOutput = await runArk(proxyHome, ["services", "status", "--project", project]);
  expect(slowOutput.code, slowOutput.err).toBe(0);
  expect(existsSync(arrived), "the request reached the proxy").toBe(true);
  const slowLines = hubLinesOf(slowOutput.out);
  expect(slowLines, "one Hub line").toHaveLength(1);
  expect(isLiveLine(slowLines[0]), slowLines[0]).toBe(true);
  expect(durationsOf(slowLines[0])[0] >= 1000, slowLines[0]).toBe(true);

  // Step 5: a frozen hub is stalled after 5 s, in both commands, and both commands finish.
  process.kill(hub.pid, "SIGSTOP");
  while (
    !spawnSync("ps", ["-o", "stat=", "-p", String(hub.pid)])
      .stdout.toString()
      .startsWith("T")
  ) {
    // The signal is delivered; the process state is the event.
  }
  const stalled = await bothCommands(home);
  for (const output of stalled) {
    expect(output.code, output.err).toBe(0);
    expect(output.milliseconds >= stallLimitMilliseconds, "the command waited its limit").toBe(
      true,
    );
    const lines = hubLinesOf(output.out);
    expect(lines, "one Hub line").toHaveLength(1);
    expect(isStalledLine(lines[0]), lines[0]).toBe(true);
    expect(output.out, "the services rows are printed").toMatch(/^sweep\s+not installed$/m);
  }
  expect(stalled[0].out, "the other sections of chief state are printed").toMatch(/^## Config/m);

  // Step 6: the hub runs again and answers again.
  process.kill(hub.pid, "SIGCONT");
  // The hub's timer saw the freeze: the route reports a lag of about the stall, and both commands print it.
  const recovered = await pollHealth(
    hub,
    (answer) => (answer.health.lag_ms ?? 0) >= stallLimitMilliseconds - 1000,
    2000,
  );
  const frozenLag = recovered.health.lag_ms!;
  const afterFreeze = await commandsBetweenReads(hub, home);
  expect(afterFreeze.before >= frozenLag).toBe(true);
  for (const output of afterFreeze.outputs) {
    expect(output.code, output.err).toBe(0);
    const lines = hubLinesOf(output.out);
    expect(lines).toHaveLength(1);
    expect(isLiveLine(lines[0]), lines[0]).toBe(true);
    expect(
      lagOfLine(lines[0]) >= frozenLag && lagOfLine(lines[0]) <= afterFreeze.after,
      `${lines[0]}: the route read ${frozenLag} ms after the freeze and ${afterFreeze.after} ms after the commands`,
    ).toBe(true);
  }

  // Step 2: a lock of a dead hub (the hub that ended, its port closed) reads as no hub.
  pages.splice(0).forEach((page) => page.close());
  hub.child.kill("SIGTERM");
  await hub.exited;
  expect(lockFiles(home)).toEqual([lockName]);
  await noHubOutputs("dead lock");

  // Step 7: a hub of another clone of the repo is found.
  const copy = mkdtempSync(join(tmpdir(), "ark-stall-copy-"));
  for (const name of ["hub", "cli", "skills", "package.json"])
    cpSync(join(root, name), join(copy, name), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(copy, "node_modules"));
  const otherHome = mkdtempSync(join(tmpdir(), "ark-stall-other-home-"));
  cpSync(join(home, "projects"), join(otherHome, "projects"), { recursive: true });
  const other = await startHub({
    interval: 2000,
    repository: copy,
    environment: { ARK_HOME: otherHome },
  });
  openPage(other);
  await pollHealth(other, (answer) => typeof answer.health.lag_ms === "number", 2000);
  for (const output of await bothCommands(otherHome)) {
    expect(output.code, output.err).toBe(0);
    const lines = hubLinesOf(output.out);
    expect(lines, "one Hub line").toHaveLength(1);
    expect(
      isLiveLine(lines[0]),
      `the CLI finds a hub its own repo folder did not start: ${lines[0]}`,
    ).toBe(true);
  }
}, 180_000);

// ---------------------------------------------------------------- ARK-T699

const soakMilliseconds = 120_000;
const openRunCount = 40;
const closedRunCount = 210;
const sessionFileCount = 4000;
const filesPerFolder = 16;
const messagesPerFile = 20;
const costPerMessage = 0.25; // exact in binary, so a sum has no rounding
/** 1x1 PNG: the signature is what the image route reads. */
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

type Fixture = {
  openRuns: string[];
  closedRun: string;
  /** The omp session file of the first open run: one tool call `call1` with a result. */
  transcriptFile: string;
  /** The ids of the open runs whose one session file holds only priced messages. */
  pricedRuns: string[];
};

/** 250 runs (40 open) and 4000 session files in the temp home; the cwd of 40 files is inside an open run. */
function largeHome(): Fixture {
  // The project's workspace is a tree of 655 folders (5 x 5 x 5 x 4 below the root): `loadConfig` walks it for repos (ARK-533 profile).
  const workspace = mkdtempSync(join(tmpdir(), "ark-stall-workspace-"));
  const levels = [5, 5, 5, 4];
  const grow = (directory: string, depth: number) => {
    if (depth === levels.length) return;
    for (let number = 0; number < levels[depth]; number++) {
      const child = join(directory, `d${number}`);
      mkdirSync(child);
      grow(child, depth + 1);
    }
  };
  grow(workspace, 0);
  writeProject(project, {
    workspace,
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true {report}", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
      chief: { harness: "claude", model: "claude-opus" },
    },
  });
  const openRuns: string[] = [];
  for (let number = 0; number < openRunCount; number++) {
    const run = `${today()}-ARK-${1000 + number}-1`;
    writeRun({
      project,
      run,
      ticket: { id: `ARK-${1000 + number}`, title: `Open run ${number}` },
      phase: "building",
    });
    openRuns.push(run);
  }
  const closedRuns: string[] = [];
  for (let number = 0; number < closedRunCount; number++) {
    const run = `${today()}-ARK-${2000 + number}-1`;
    writeRun({
      project,
      run,
      ticket: { id: `ARK-${2000 + number}`, title: `Closed run ${number}` },
      phase: "closed",
      metricsCostUsd: 1,
    });
    closedRuns.push(run);
  }
  const sessions = process.env.ARK_OMP_SESSIONS!;
  const started = new Date(Date.now() - 3_000_000);
  const messages = Array.from({ length: messagesPerFile }, (_, index) => ({
    time: new Date(started.getTime() + index * 1000),
    costUsd: costPerMessage,
  }));
  const spacing = sessionFileCount / openRunCount;
  let transcriptFile = "";
  for (let index = 0; index < sessionFileCount; index++) {
    const folder = join(sessions, `folder-${Math.floor(index / filesPerFolder)}`);
    if (index % filesPerFolder === 0) mkdirSync(folder, { recursive: true });
    const owner = index % spacing === 0 ? openRuns[index / spacing] : undefined;
    const cwd = owner
      ? join(runDirectoryOf(project, owner), "workspace")
      : join(tmpdir(), "ark-stall-elsewhere", `folder-${Math.floor(index / filesPerFolder)}`);
    const file = join(folder, `session-${index}.jsonl`);
    writeFileSync(
      file,
      owner === openRuns[0]
        ? transcriptText("omp", {
            cwd,
            start: started,
            tag: "stall",
            extra: [{ kind: "call", id: "call1", args: { command: "ls" }, result: "ok\nsecond" }],
          })
        : ompSessionText(cwd, messages, started),
    );
    if (owner === openRuns[0]) transcriptFile = file;
  }
  const directory = runDirectoryOf(project, openRuns[0]);
  mkdirSync(join(directory, "results", "evidence", "ARK-T1", "head"), { recursive: true });
  writeFileSync(join(directory, "results", "evidence", "ARK-T1", "head", "shot.png"), png);
  writeBacklogTicket({
    project,
    id: "ARK-840",
    title: "Readable",
    status: "ready",
    problem: "Why it hurts",
    change: "What changes",
    criteria: [{ id: "ARK-840-AC1", text: "It works", verifiedBy: ["ARK-T1"] }],
  });
  return {
    openRuns,
    closedRun: closedRuns[0],
    transcriptFile,
    pricedRuns: openRuns.slice(1),
  };
}

/** One inbox message to an open run, so the conversation routes have a message with a body. */
const inboxMessage = (run: string) => ({
  id: "msg_1",
  type: "status",
  from_handle: "term_w1",
  to_handle: `run:orca-${run}`,
  subject: "subject of msg_1",
  body: "BODY msg_1",
  thread_id: null,
  run_id: `orca-${run}`,
  payload: null,
  created_at: new Date(Date.now() - 600_000).toISOString(),
  delivered_at: null,
});

type Probe = {
  label: string;
  count: number;
  answered: number;
  slowest: number;
  /** The number of the request (from 1) that was the slowest, to tell a first read from a steady one. */
  slowestRequest: number;
  /** Statuses that are right before the first read of the data this route depends on. */
  pending: number[];
  settled: boolean;
  wrong: string[];
};

test("ARK-T699 With a page connected, default reader intervals and 250 runs plus 4000 session files, every route answers within 1 s at every probe for 120 s and the loop never lags over 200 ms", async () => {
  const fake = stage();
  const fixture = largeHome();
  const [openRun] = fixture.openRuns;
  // Every open run has a run lead that Orca lists with no harness, so each compose reads `roles.chief` of the project for it.
  fake.set(
    "orca.runs",
    JSON.stringify({
      result: {
        runs: [
          ...fixture.openRuns.map((run, number) => ({
            id: `orca-${run}`,
            objective: `Ark run ${run}`,
            coordinator_handle: `term-${number}`,
          })),
          { id: "orca-chief-p", objective: `Master Chief: ${project} tickets` },
        ],
      },
    }),
  );
  fake.set(
    "orca.terminals",
    JSON.stringify({
      result: {
        terminals: fixture.openRuns.map((_, number) => ({
          handle: `term-${number}`,
          connected: true,
        })),
      },
    }),
  );
  fake.set("orca.inbox", JSON.stringify({ result: { messages: [inboxMessage(openRun)] } }));
  const hub = await startHub(); // the default intervals: 2 s to 60 s
  const baseUrl = hub.baseUrl();
  const page = openPage(hub);
  // Request 1 is cold: a direct run URL asks for its run at once, before any snapshot. The hub answers a route
  // it cannot serve yet with 503 `loading` within 1 s; that is right only until the first snapshot is published.

  const probes = new Map<string, Probe>();
  const probe = async (
    label: string,
    path: string,
    options: { pending?: number[]; method?: string; body?: string } = {},
  ): Promise<string> => {
    const record =
      probes.get(label) ??
      ({
        label,
        count: 0,
        answered: 0,
        slowest: 0,
        slowestRequest: 0,
        pending: options.pending ?? [],
        settled: false,
        wrong: [],
      } satisfies Probe);
    probes.set(label, record);
    const coldAtStart = !page.seen();
    const started = performance.now();
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers:
        options.method === "POST" ? { origin: baseUrl, "content-type": "application/json" } : {},
      body: options.body,
    });
    const text = await response.text();
    record.count += 1;
    const took = performance.now() - started;
    if (took > record.slowest) record.slowestRequest = record.count;
    record.slowest = Math.max(record.slowest, took);
    if (response.status === 200) {
      record.answered += 1;
      record.settled = true;
    } else if (response.status === 503 && text.startsWith("loading") && coldAtStart) {
      // The cold hub: no snapshot had been published when the request left.
    } else if (!(record.pending.includes(response.status) && !record.settled)) {
      record.wrong.push(`${response.status} ${text.slice(0, 80)}`);
    }
    return text;
  };

  const dataRoutes = { pending: [404] };
  const conversationRoutes = { pending: [503] };
  let asset: string | undefined;
  let messageId: string | undefined;
  let largestLag = 0;
  let largestLagAt = 0;
  const firstEnds = new Map<string, number>();
  const lastEnds = new Map<string, number>();
  const run = encodeURIComponent(openRun);
  const base = `/api/run/${run}`;
  const plannedProbes = [
    "GET /",
    "GET /assets/*",
    "GET /api/snapshot",
    "GET /api/resources/history",
    "GET /api/companions",
    "GET /api/health",
    "GET /api/conversation",
    "GET /api/conversation/message/*",
    "GET /api/run/<open>",
    "GET /api/run/<closed>",
    "GET /api/run/<open>/conversation",
    "GET /api/run/<open>/transcript",
    "GET /api/run/<open>/transcript/result",
    "GET /api/run/<open>/file",
    "GET /api/run/<open>/evidence",
    "GET /api/run/<open>/image",
    "GET /api/ticket/<project>/<ticket>",
    "GET /api/ticket/<project>/<ticket>/cases",
    "POST /api/open-in-orca",
  ];
  const deadline = performance.now() + soakMilliseconds;
  while (performance.now() < deadline) {
    const index = await probe("GET /", "/");
    asset ??= /\/assets\/[^"'\s)]+/.exec(index)?.[0];
    if (asset) await probe("GET /assets/*", asset);
    await probe("GET /api/snapshot", "/api/snapshot");
    await probe("GET /api/resources/history", "/api/resources/history");
    await probe("GET /api/companions", "/api/companions");
    const healthText = await probe("GET /api/health", "/api/health");
    try {
      const answer = JSON.parse(healthText) as Health;
      if ((answer.lag_ms ?? 0) > largestLag) {
        largestLag = answer.lag_ms ?? 0;
        largestLagAt = Math.round(deadline - performance.now());
      }
      for (const [name, pass] of Object.entries(answer.sources ?? {})) {
        const ended = endedAt(pass);
        if (ended === null) continue;
        if (!firstEnds.has(name)) firstEnds.set(name, ended);
        lastEnds.set(name, ended);
      }
    } catch {
      // The probe already recorded the status.
    }
    const since = encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString());
    const until = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    const conversation = await probe(
      "GET /api/conversation",
      `/api/conversation?since=${since}&until=${until}`,
      conversationRoutes,
    );
    try {
      const reply = JSON.parse(conversation) as {
        runs?: { messages?: { id: string }[] }[];
        other?: { messages?: { id: string }[] };
      };
      messageId ??= [
        ...(reply.runs ?? []).flatMap((entry) => entry.messages ?? []),
        ...(reply.other?.messages ?? []),
      ][0]?.id;
    } catch {
      // Not read yet: 503 text.
    }
    if (messageId)
      await probe("GET /api/conversation/message/*", `/api/conversation/message/${messageId}`);
    await probe("GET /api/run/<open>", base);
    await probe("GET /api/run/<closed>", `/api/run/${encodeURIComponent(fixture.closedRun)}`);
    await probe("GET /api/run/<open>/conversation", `${base}/conversation`, conversationRoutes);
    const file = encodeURIComponent(fixture.transcriptFile);
    await probe(
      "GET /api/run/<open>/transcript",
      `${base}/transcript?file=${file}&cursor=0`,
      dataRoutes,
    );
    await probe(
      "GET /api/run/<open>/transcript/result",
      `${base}/transcript/result?file=${file}&call=call1`,
      dataRoutes,
    );
    await probe("GET /api/run/<open>/file", `${base}/file?path=ticket.md`);
    await probe("GET /api/run/<open>/evidence", `${base}/evidence`);
    await probe(
      "GET /api/run/<open>/image",
      `${base}/image?path=${encodeURIComponent("results/evidence/ARK-T1/head/shot.png")}`,
    );
    await probe("GET /api/ticket/<project>/<ticket>", `/api/ticket/${project}/ARK-840`, dataRoutes);
    await probe(
      "GET /api/ticket/<project>/<ticket>/cases",
      `/api/ticket/${project}/ARK-840/cases`,
      dataRoutes,
    );
    await probe("POST /api/open-in-orca", "/api/open-in-orca", {
      method: "POST",
      body: JSON.stringify({ terminal: "term-0" }),
      pending: [400],
    });
  }

  const results = [...probes.values()];
  // Every planned probe was built: a fixture that cannot supply a message id or an asset fails here, by name.
  expect(
    plannedProbes.filter((label) => !probes.has(label)),
    "planned probes never built",
  ).toEqual([]);
  // Every route answered, within 1 s at every probe, with the status of a valid request.
  expect(
    results.filter((entry) => entry.answered === 0).map((entry) => entry.label),
    "routes that never answered 200",
  ).toEqual([]);
  expect(
    results
      .filter((entry) => entry.wrong.length > 0)
      .map((entry) => `${entry.label}: ${entry.wrong[0]}`),
    "routes with a wrong status",
  ).toEqual([]);
  expect(
    results
      .filter((entry) => entry.slowest > answerLimitMilliseconds)
      .map(
        (entry) =>
          `${entry.label}: ${Math.round(entry.slowest)} ms at request ${entry.slowestRequest} of ${entry.count}`,
      ),
    "routes slower than 1 s",
  ).toEqual([]);
  // No pass held the loop for more than 200 ms, as the hub reports it.
  expect(
    largestLag <= lagLimitMilliseconds,
    `the largest loop lag was ${largestLag} ms, ${soakMilliseconds - largestLagAt} ms into the soak`,
  ).toBe(true);
  // Speed was not bought by stopping the readers: every reader ended a pass and then another one.
  for (const sourceName of Object.keys(sourceAffects)) {
    expect(lastEnds.has(sourceName), `${sourceName} ended no pass`).toBe(true);
    expect(
      lastEnds.get(sourceName)! > firstEnds.get(sourceName)!,
      `${sourceName} ended one pass in 120 s`,
    ).toBe(true);
  }
  // Nor by dropping data: a cost is the fixture's or unknown, never a smaller number.
  const snapshot = await snapshotOf(hub);
  if (snapshot.runs !== "unknown")
    for (const name of fixture.pricedRuns) {
      const cost = snapshot.runs.find((view) => view.run === name)?.cost_usd;
      expect(
        cost === null || (cost ?? 0) >= messagesPerFile * costPerMessage,
        `${name} cost ${cost}`,
      ).toBe(true);
    }
  hub.child.kill("SIGTERM");
  await hub.exited;
}, 150_000);
