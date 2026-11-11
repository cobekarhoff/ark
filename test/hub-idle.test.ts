// ARK-365: the hub pushes only on a data change, reads nothing while no page is open, runs once
// per Ark repo, and reads Plannotator only while a gate is open. Real `hub/main.ts` processes with
// fake `orca`, `plannotator`, `gh` and `omp` on PATH; every source interval comes from ARK_HUB_INTERVAL_MS.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Snapshot, SourceName } from "../hub/types.ts";
import { appendRawEvent, runDirectoryOf, today, writeRun } from "./hub-fixtures.ts";
import { tempArkHome } from "./helpers.ts";

setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, "..");
let savedEnvironment: NodeJS.ProcessEnv;
const processes: Subprocess[] = [];
const clients: Client[] = [];

beforeAll(() => {
  savedEnvironment = { ...process.env };
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  for (const hold of ["orca.hold", "gh.hold"])
    rmSync(join(process.env.ARK_FAKE_STATE ?? tmpdir(), hold), { force: true });
});

afterAll(() => {
  for (const key of Object.keys(process.env))
    if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
});

// Real time is the thing under test here: idle periods and read rates are counted on the platform clock.
const sleep = (milliseconds: number) => delay(milliseconds);

async function until<Value>(
  what: string,
  check: () => Value | undefined | false | null,
  milliseconds = 15_000,
): Promise<Value> {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const found = check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}

// ---------------------------------------------------------------- fake tools

const validView = JSON.stringify({
  state: "OPEN",
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "ci",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://ci.example/run/1",
    },
  ],
  additions: 12,
  deletions: 3,
  changedFiles: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
});

type Fixture = {
  state: string;
  path: string;
  /** Lines the tool has logged: for orca, the `terminal list` reads. */
  reads(tool: "orca" | "plannotator" | "gh"): number;
  /** Every orca call, whatever the command. */
  orcaCalls(): number;
  control(name: string, on: boolean): void;
  setLeadModel(model: string): void;
  setSessions(sessions: unknown[]): void;
};

/** A fresh ARK_HOME, isolated session roots and fake tools. Each fake appends a line per call and answers from a control file. */
function fixture(): Fixture {
  tempArkHome();
  process.env.ARK_OMP_SESSIONS = mkdtempSync(join(tmpdir(), "ark-omp-sessions-"));
  process.env.ARK_CLAUDE_SESSIONS = mkdtempSync(join(tmpdir(), "ark-claude-sessions-"));
  process.env.ARK_CODEX_SESSIONS = mkdtempSync(join(tmpdir(), "ark-codex-sessions-"));
  const state = mkdtempSync(join(tmpdir(), "ark-hub-idle-state-"));
  process.env.ARK_FAKE_STATE = state;
  const bin = mkdtempSync(join(tmpdir(), "ark-hub-idle-bin-"));
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nS='${state}'\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // Only `terminal list` holds and fails on request, so one source flips and the others stay still.
  script(
    "orca",
    `echo "$*" >> "$S/orca.log"
if [ "$1 $2" = "terminal list" ]; then
  echo x >> "$S/orca.terminal-list"
  waited=0
  while [ -e "$S/orca.hold" ] && [ "$waited" -lt 1500 ]; do sleep 0.02; waited=$((waited + 1)); done
  [ -e "$S/orca.fail" ] && exit 1
  cat "$S/orca.terminals"
  exit 0
fi
case "$1 $2" in
  "orchestration run-list") cat "$S/orca.runs" ;;
  "orchestration worker-list") echo '{"result":{"workers":[]}}' ;;
  "orchestration task-list") echo '{"result":{"tasks":[]}}' ;;
  "orchestration inbox") echo '{"result":{"messages":[]}}' ;;
  "worktree ps") echo '{"result":{"worktrees":[]}}' ;;
  *) exit 1 ;;
esac`,
  );
  script(
    "plannotator",
    `echo "$*" >> "$S/plannotator.log"
[ -e "$S/plannotator.fail" ] && exit 1
cat "$S/plannotator.sessions"`,
  );
  script(
    "gh",
    `echo "$*" >> "$S/gh.log"
waited=0
while [ -e "$S/gh.hold" ] && [ "$waited" -lt 1500 ]; do sleep 0.02; waited=$((waited + 1)); done
[ -e "$S/gh.fail" ] && exit 1
cat "$S/gh.view"`,
  );
  script("omp", `echo '{"reports":[]}'`);
  writeFileSync(join(state, "gh.view"), validView);
  writeFileSync(join(state, "plannotator.sessions"), "[]");
  process.env.PATH = `${bin}:${savedEnvironment.PATH}`;
  const lines = (file: string) =>
    existsSync(join(state, file))
      ? readFileSync(join(state, file), "utf8").split("\n").filter(Boolean).length
      : 0;
  const fake: Fixture = {
    state,
    path: process.env.PATH,
    reads: (tool) => lines(tool === "orca" ? "orca.terminal-list" : `${tool}.log`),
    orcaCalls: () => lines("orca.log"),
    control(name, on) {
      if (on) writeFileSync(join(state, name), "");
      else rmSync(join(state, name), { force: true });
    },
    setLeadModel(model) {
      writeFileSync(
        join(state, "orca.terminals"),
        JSON.stringify({
          result: {
            terminals: [{ handle: "term-lead", connected: true, agentIdentity: "omp", model }],
          },
        }),
      );
    },
    setSessions: (sessions) =>
      writeFileSync(join(state, "plannotator.sessions"), JSON.stringify(sessions)),
  };
  fake.setLeadModel("model-A");
  return fake;
}

/** Orca lists an "Ark run <id>" lead for each given run, so the lead's model shows the terminal set. */
const orcaRunsFor = (fake: Fixture, runs: string[]) =>
  writeFileSync(
    join(fake.state, "orca.runs"),
    JSON.stringify({
      result: {
        runs: runs.map((run) => ({
          id: `orca-${run}`,
          objective: `Ark run ${run}`,
          coordinator_handle: "term-lead",
        })),
      },
    }),
  );

// ---------------------------------------------------------------- runs

const project = "p";
const mergeRequestUrl = "https://github.com/o/r/pull/1";

/** A run in `building` with one merge request. */
function buildingRun(number: number): string {
  const run = `${today()}-ARK-9${number}-1`;
  writeRun({
    project,
    run,
    ticket: { id: `ARK-9${number}`, title: `Idle ${number}` },
    phase: "building",
    mergeRequests: [{ repo: "r", url: mergeRequestUrl, number: 1 }],
  });
  return run;
}

const planChecked = { valid: true, plan_hash: "fixture", steps: [] };

/** A run in `planning` with no checked plan: no gate is open until `openGate`. */
function planningRun(number: number): string {
  const run = `${today()}-ARK-8${number}-1`;
  writeRun({
    project,
    run,
    ticket: { id: `ARK-8${number}`, title: `Gate ${number}` },
    phase: "planning",
  });
  const file = join(runDirectoryOf(project, run), "events.ndjson");
  const kept = readFileSync(file, "utf8").trimEnd().split("\n").slice(0, -1); // drop plan.checked
  writeFileSync(file, `${kept.join("\n")}\n`);
  return run;
}

const eventCount = (run: string) =>
  readFileSync(join(runDirectoryOf(project, run), "events.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean).length;

const openGate = (run: string) =>
  appendRawEvent(runDirectoryOf(project, run), "plan.checked", planChecked, eventCount(run) + 1);

const closeGate = (run: string) =>
  appendRawEvent(
    runDirectoryOf(project, run),
    "gate.answered",
    { gate: "plan", answer: "approve" },
    eventCount(run) + 1,
  );

const planDocument = (run: string) => join(runDirectoryOf(project, run), "plan.md");

// ---------------------------------------------------------------- hub processes and pages

type Hub = {
  child: Subprocess<"ignore", "pipe", "pipe">;
  output(): string;
  /** The port of "Ark hub on http://127.0.0.1:<port>", once printed. */
  port(): number | undefined;
  baseUrl(): string;
  exited: Promise<number>;
};

/** `bun <repository>/hub/main.ts --port <port>`. The hub has its own copy of the environment. */
function spawnHub(
  options: { interval?: number; repository?: string; port?: number | string } = {},
): Hub {
  const environment: Record<string, string | undefined> = { ...process.env };
  if (options.interval) environment.ARK_HUB_INTERVAL_MS = String(options.interval);
  const child = Bun.spawn(
    [
      "bun",
      join(options.repository ?? root, "hub", "main.ts"),
      "--port",
      String(options.port ?? 0),
    ],
    { env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  processes.push(child);
  let text = "";
  void (async () => {
    for await (const chunk of child.stdout) text += new TextDecoder().decode(chunk);
  })();
  const port = () =>
    text.match(/Ark hub on http:\/\/127\.0\.0\.1:(\d+)/)?.[1]
      ? Number(text.match(/Ark hub on http:\/\/127\.0\.0\.1:(\d+)/)![1])
      : undefined;
  return {
    child,
    output: () => text,
    port,
    baseUrl: () => `http://127.0.0.1:${port()}`,
    exited: child.exited,
  };
}

async function startHub(options: Parameters<typeof spawnHub>[0] = {}): Promise<Hub> {
  const hub = spawnHub(options);
  await until("the hub to print its port", () => hub.port());
  return hub;
}

type Client = { pushes: Snapshot[]; close(): void };

/** One `/events` page: every pushed snapshot, in order. */
function connect(hub: Hub): Client {
  const controller = new AbortController();
  const pushes: Snapshot[] = [];
  void (async () => {
    try {
      const response = await fetch(`${hub.baseUrl()}/events`, { signal: controller.signal });
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of response.body!) {
        buffered += decoder.decode(chunk, { stream: true });
        for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
          const message = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          if (message.startsWith("data: ")) pushes.push(JSON.parse(message.slice(6)));
        }
      }
    } catch {
      // The page was closed.
    }
  })();
  const client = { pushes, close: () => controller.abort() };
  clients.push(client);
  return client;
}

/** `/api/snapshot` does not subscribe, so it never wakes the reader. */
const snapshotOf = async (hub: Hub): Promise<Snapshot> =>
  (await fetch(`${hub.baseUrl()}/api/snapshot`)).json();

const readAtOf = (snapshot: Snapshot, source: SourceName) => snapshot.sources[source].read_at;
const okOf = (snapshot: Snapshot, source: SourceName) => snapshot.sources[source].ok;
const allSourcesOk = (snapshot: Snapshot) =>
  Object.values(snapshot.sources).every((source) => source.ok);

const gatesOf = (snapshot: Snapshot) => (snapshot.gates === "unknown" ? [] : snapshot.gates);

const leadModelOf = (snapshot: Snapshot, run: string): string | null => {
  if (snapshot.runs === "unknown") return null;
  const agents = snapshot.runs.find((view) => view.run === run)?.agents;
  return (
    (Array.isArray(agents) && agents.find((agent) => agent.role === "run lead")?.model) || null
  );
};

// ---------------------------------------------------------------- ARK-T240

test("ARK-T240 With no change in any source, 10 reads of every source send 0 pushes after the first, a changed answer pushes once, and a source that fails then recovers pushes on each ok flip and restarts its healthy period", async () => {
  const fake = fixture();
  const building = buildingRun(1);
  const planning = planningRun(1);
  openGate(planning); // open plan gate: Plannotator has a read
  orcaRunsFor(fake, [building]);
  fake.setSessions([{ index: 1, target: planDocument(planning), url: "http://localhost:20000/a" }]);
  const hub = await startHub({ interval: 100 });
  const client = connect(hub);

  // Baseline: every source has answered and the stream has been quiet for a while.
  await until(
    "every source read once and ok",
    () => client.pushes.some(allSourcesOk) && fake.reads("orca") >= 2 && fake.reads("gh") >= 2,
  );
  let quietSince = Date.now();
  let seen = client.pushes.length;
  while (Date.now() - quietSince < 600) {
    await sleep(50);
    if (client.pushes.length !== seen) {
      seen = client.pushes.length;
      quietSince = Date.now();
    }
  }
  const baselinePushes = client.pushes.length;
  const baseline = client.pushes.at(-1)!;
  const startReads = {
    orca: fake.reads("orca"),
    plannotator: fake.reads("plannotator"),
    gh: fake.reads("gh"),
  };

  // 10 reads of every source, no change: no push, no read_at moved.
  await until(
    "10 more reads of each source",
    () =>
      fake.reads("orca") >= startReads.orca + 10 &&
      fake.reads("plannotator") >= startReads.plannotator + 10 &&
      fake.reads("gh") >= startReads.gh + 10,
  );
  expect(client.pushes.length).toBe(baselinePushes);
  const quiet = await snapshotOf(hub);
  expect(quiet.sources).toEqual(baseline.sources);

  // A changed answer pushes once, and shows the new terminal set.
  const afterReads = (tool: "orca" | "plannotator" | "gh", more: number) => {
    const target = fake.reads(tool) + more;
    return until(`${more} more ${tool} reads`, () => fake.reads(tool) >= target);
  };
  fake.setLeadModel("model-B");
  await until(
    "the changed answer",
    () => leadModelOf(client.pushes.at(-1)!, building) === "model-B",
  );
  await afterReads("orca", 2);
  expect(client.pushes.length).toBe(baselinePushes + 1);

  // Each source: fail (one push, ok false), later failed reads push nothing, recover (one push, new healthy period).
  const sources = [
    { name: "github", tool: "gh", control: "gh.fail" },
    { name: "orca", tool: "orca", control: "orca.fail" },
    { name: "plannotator", tool: "plannotator", control: "plannotator.fail" },
  ] as const;
  for (const { name, tool, control } of sources) {
    const before = client.pushes.at(-1)!;
    const healthyStart = readAtOf(before, name);
    const others = (snapshot: Snapshot) =>
      Object.fromEntries(
        Object.entries(snapshot.sources)
          .filter(([other]) => other !== name)
          .map(([other, source]) => [other, source.read_at]),
      );
    const pushesBefore = client.pushes.length;

    fake.control(control, true);
    await until(`${name} failing`, () => !okOf(client.pushes.at(-1)!, name));
    await afterReads(tool, 3);
    expect(client.pushes.length).toBe(pushesBefore + 1);
    const failed = client.pushes.at(-1)!;
    expect(readAtOf(failed, name)).not.toBeNull();
    expect(others(failed)).toEqual(others(before));
    expect(hub.child.exitCode).toBeNull();

    fake.control(control, false);
    await until(`${name} recovering`, () => okOf(client.pushes.at(-1)!, name));
    await afterReads(tool, 3);
    expect(client.pushes.length).toBe(pushesBefore + 2);
    const recovered = client.pushes.at(-1)!;
    expect(Date.parse(readAtOf(recovered, name)!)).toBeGreaterThan(Date.parse(healthyStart!));
    expect(others(recovered)).toEqual(others(before));
    expect(hub.child.exitCode).toBeNull();
  }
});

// ---------------------------------------------------------------- ARK-T241

test("ARK-T241 With no page connected the hub runs no Orca, Plannotator or GitHub read, the first page gets fresh data within 5 s, and a quick disconnect and reconnect starts no second loop", async () => {
  const fake = fixture();
  const building = buildingRun(2);
  const planning = planningRun(2);
  openGate(planning);
  orcaRunsFor(fake, [building]);
  fake.setSessions([{ index: 1, target: planDocument(planning), url: "http://localhost:20000/a" }]);
  const hub = await startHub({ interval: 100 });
  const everyCall = () => fake.orcaCalls() + fake.reads("plannotator") + fake.reads("gh");

  // Step 1: no page, no read, no child process.
  await sleep(1500);
  expect(everyCall()).toBe(0);
  const idle = await snapshotOf(hub);
  for (const source of ["orca", "plannotator", "github"] as const)
    expect(readAtOf(idle, source)).toBeNull();
  const children = spawnSync("pgrep", ["-P", String(hub.child.pid)]);
  expect(children.stdout.toString().trim()).toBe("");

  // Step 2: the first page gets every source fresh within 5 s.
  const connectedAt = Date.now();
  let client = connect(hub);
  await until(
    "fresh data for orca, plannotator and github",
    () =>
      client.pushes.some((push) =>
        (["orca", "plannotator", "github"] as const).every(
          (source) => okOf(push, source) && Date.parse(readAtOf(push, source)!) > connectedAt,
        ),
      ),
    5000,
  );

  // Step 3: reads run at the interval.
  const counts = () => [fake.reads("orca"), fake.reads("plannotator"), fake.reads("gh")];
  const windowOf = async () => {
    const start = counts();
    await sleep(2000);
    return counts().map((count, index) => count - start[index]);
  };
  const firstWindow = await windowOf();
  for (const reads of firstWindow) {
    expect(reads).toBeGreaterThanOrEqual(5);
    expect(reads).toBeLessThan(25);
  }

  // Step 4: a read in flight when the last page leaves is discarded: no publish, no re-armed timer.
  const holdAndLeave = async (answer: "model-B" | "fail") => {
    const before = await snapshotOf(hub);
    expect(leadModelOf(before, building)).toBe("model-A");
    expect(okOf(before, "orca")).toBe(true);
    fake.control("orca.hold", true);
    const target = fake.reads("orca") + 1;
    await until("an orca read in flight", () => fake.reads("orca") >= target);
    client.close();
    if (answer === "fail") fake.control("orca.fail", true);
    else fake.setLeadModel("model-B");
    await sleep(200); // the hub sees the disconnect
    const readsBefore = fake.reads("orca");
    const during = await snapshotOf(hub);
    expect(leadModelOf(during, building)).toBe("model-A");
    fake.control("orca.hold", false);
    await sleep(1500);
    expect(fake.reads("orca")).toBe(readsBefore);
    const after = await snapshotOf(hub);
    expect(leadModelOf(after, building)).toBe("model-A");
    expect(okOf(after, "orca")).toBe(true);
    expect(readAtOf(after, "orca")).toBe(readAtOf(before, "orca"));
  };
  await holdAndLeave("model-B");
  fake.setLeadModel("model-A");
  fake.control("orca.fail", false);
  const reconnectReads = fake.reads("orca");
  client = connect(hub);
  await until("the loops to run again", () => fake.reads("orca") >= reconnectReads + 2);
  await holdAndLeave("fail");
  fake.control("orca.fail", false);

  // Step 5: a quick disconnect and reconnect starts no second loop.
  for (let round = 0; round < 5; round++) {
    const page = connect(hub);
    await until("the page to connect", () => page.pushes.length > 0);
    page.close();
  }
  client = connect(hub);
  await until("the last page to connect", () => client.pushes.length > 0);
  await sleep(200);
  const churnWindow = await windowOf();
  churnWindow.forEach((reads, index) => {
    expect(reads).toBeLessThan(1.5 * firstWindow[index]);
    expect(reads).toBeGreaterThanOrEqual(0.5 * firstWindow[index]);
  });

  // Step 6: no page, no read.
  client.close();
  await sleep(500); // a read in flight ends
  const settled = everyCall();
  await sleep(1500);
  expect(everyCall()).toBe(settled);

  // Step 7: every tool fails; the hub stays up and the page gets the failures.
  for (const control of ["orca.fail", "plannotator.fail", "gh.fail"]) fake.control(control, true);
  client = connect(hub);
  await until("the failed sources", () =>
    client.pushes.some((push) =>
      (["orca", "plannotator", "github"] as const).every((source) => !okOf(push, source)),
    ),
  );
  expect(hub.child.exitCode).toBeNull();
  expect((await fetch(`${hub.baseUrl()}/api/snapshot`)).status).toBe(200);
});

// ---------------------------------------------------------------- ARK-T242

/** A copy of the Ark repo at another path: the lock key is the repo path of `hub/lock.ts`. */
function copyOfRepository(): string {
  const copy = mkdtempSync(join(tmpdir(), "ark-hub-copy-"));
  for (const name of ["hub", "cli", "skills", "package.json"])
    cpSync(join(root, name), join(copy, name), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(copy, "node_modules"));
  return copy;
}

const lockFiles = () =>
  readdirSync(process.env.ARK_HOME!).filter((file) => /^hub-.*\.lock$/.test(file));
const refusalOf = (port: number) => `Ark hub already runs on http://127.0.0.1:${port}`;

test("ARK-T242 A second hub on the same Ark repo refuses to start, exits 0, names the port of the running hub, and takes over a lock left by a dead pid", async () => {
  fixture();
  const a = await startHub();
  const portA = a.port()!;

  // Step 2: same repo, port 0: refused, exit 0, names P, never listens.
  const b = spawnHub();
  expect(await b.exited).toBe(0);
  expect(b.output()).toContain(refusalOf(portA));
  expect(b.output()).not.toContain("Ark hub on http");

  // Step 3: same repo on the fixed port P: the same refusal.
  const c = spawnHub({ port: portA });
  expect(await c.exited).toBe(0);
  expect(c.output()).toContain(refusalOf(portA));

  // Step 4: another repo path has its own lock and port.
  const otherRepository = copyOfRepository();
  const d = await startHub({ repository: otherRepository });
  expect(d.port()).not.toBe(portA);

  // Step 5: two hubs of a fresh repo at once: one stays up, the other exits 0 and names it.
  const racedRepository = copyOfRepository();
  const first = spawnHub({ repository: racedRepository });
  const second = spawnHub({ repository: racedRepository });
  await Promise.race([first.exited, second.exited]);
  const [loser, winner] = first.child.exitCode === null ? [second, first] : [first, second];
  expect(await loser.exited).toBe(0);
  await until("the surviving hub to print its port", () => winner.port());
  expect(winner.child.exitCode).toBeNull();
  expect(loser.output()).toContain(refusalOf(winner.port()!));

  for (const hub of [d, winner]) {
    hub.child.kill("SIGTERM");
    await hub.exited;
  }
  expect(lockFiles()).toHaveLength(1); // hub A's

  // Step 6: a lock left by a killed hub does not block a start.
  a.child.kill("SIGKILL");
  await a.exited;
  expect(lockFiles()).toHaveLength(1);
  const e = await startHub();
  expect(e.port()).not.toBeUndefined();
  expect(e.output()).not.toContain("already runs");
  expect((await fetch(`${e.baseUrl()}/api/snapshot`)).status).toBe(200);
  // The lock now names hub E: a second start names E's port.
  const refused = spawnHub();
  expect(await refused.exited).toBe(0);
  expect(refused.output()).toContain(refusalOf(e.port()!));

  // Step 7: SIGTERM removes the lock and a new hub starts.
  e.child.kill("SIGTERM");
  expect(await e.exited).toBe(0);
  expect(lockFiles()).toHaveLength(0);
  const f = await startHub();
  expect(f.port()).not.toBeUndefined();
});

// ---------------------------------------------------------------- ARK-T243

test("ARK-T243 The hub reads Plannotator only while a run has an open gate, reads at once when a gate opens, and clears review_url when the gate closes", async () => {
  const fake = fixture();
  const url = (run: string) => `http://localhost:20000/${run}`;
  const runs = [1, 2, 3, 4, 5].map(planningRun);
  const [, second, third, fourth, fifth] = runs;
  fake.setSessions(runs.map((run, index) => ({ index, target: planDocument(run), url: url(run) })));
  const reviewUrlOf = (snapshot: Snapshot, run: string) =>
    gatesOf(snapshot).find((gate) => gate.run === run)?.review_url ?? null;

  // Steps 1 and 3 to 6: a hub at 100 ms.
  const hub = await startHub({ interval: 100 });
  const client = connect(hub);
  const latest = () => client.pushes.at(-1)!;
  await until("the first push", () => client.pushes.length > 0);

  // Step 1: no gate, no Plannotator call, no review link, the source is not failed.
  await sleep(1500);
  expect(fake.reads("plannotator")).toBe(0);
  expect(gatesOf(await snapshotOf(hub))).toEqual([]);
  expect(okOf(await snapshotOf(hub), "plannotator")).toBe(true);

  // Step 3: an open gate is read at the interval and has its link.
  openGate(second);
  await until(
    "the review link of the open gate",
    () => reviewUrlOf(latest(), second) === url(second),
  );
  const opened = fake.reads("plannotator");
  await until("reads at the interval", () => fake.reads("plannotator") >= opened + 5);

  // Step 4: the answered gate stops the reads and clears the link; the source is not failed.
  closeGate(second);
  await until("the gate gone", () => gatesOf(latest()).length === 0);
  expect(reviewUrlOf(latest(), second)).toBeNull();
  await sleep(400); // a read in flight finishes
  const closed = fake.reads("plannotator");
  await sleep(1000);
  expect(fake.reads("plannotator")).toBe(closed);
  expect(okOf(await snapshotOf(hub), "plannotator")).toBe(true);

  // Step 5: a failing Plannotator with a gate open shows failed, keeps no link and does not stop the hub; closing the gate clears the failure.
  fake.control("plannotator.fail", true);
  openGate(third);
  await until("the failed read", () => !okOf(latest(), "plannotator"));
  expect(reviewUrlOf(latest(), third)).toBeNull();
  expect(hub.child.exitCode).toBeNull();
  closeGate(third);
  await until("the failure cleared", () => okOf(latest(), "plannotator"));
  fake.control("plannotator.fail", false);

  // Step 6: reads continue while any gate is open; the closed run has no link.
  openGate(fourth);
  openGate(fifth);
  await until(
    "both links",
    () =>
      reviewUrlOf(latest(), fourth) === url(fourth) && reviewUrlOf(latest(), fifth) === url(fifth),
  );
  closeGate(fourth);
  await until("the closed run without its link", () => reviewUrlOf(latest(), fourth) === null);
  await sleep(400);
  const withOne = fake.reads("plannotator");
  await until("reads continue", () => fake.reads("plannotator") >= withOne + 5);
  expect(reviewUrlOf(latest(), fifth)).toBe(url(fifth));
  client.close();
  hub.child.kill("SIGTERM");
  await hub.exited;
  rmSync(join(fake.state, "plannotator.log"));

  // Step 2: at 60 s the opening gate still gets its link at once (the Ark file read wakes the Plannotator read).
  const opening = planningRun(6);
  fake.setSessions([{ index: 1, target: planDocument(opening), url: url(opening) }]);
  const slow = await startHub({ interval: 60_000 });
  const slowClient = connect(slow);
  await until("the first push", () => slowClient.pushes.length > 0);
  await until("the first reads", () => okOf(slowClient.pushes.at(-1)!, "ark"));
  openGate(opening);
  await until(
    "the review link, not 60 s later",
    () => slowClient.pushes.some((push) => reviewUrlOf(push, opening) === url(opening)),
    5000,
  );
  slowClient.close();
  slow.child.kill("SIGTERM");
  await slow.exited;

  // Step 7: a gate that is open when the first page connects is read with the first wake.
  rmSync(join(fake.state, "plannotator.log"));
  const idle = await startHub({ interval: 60_000 });
  await sleep(300);
  expect(fake.reads("plannotator")).toBe(0);
  const wake = connect(idle);
  await until(
    "the review link on the first wake",
    () => wake.pushes.some((push) => reviewUrlOf(push, opening) === url(opening)),
    5000,
  );
  expect(fake.reads("plannotator")).toBe(1);
});

// ---------------------------------------------------------------- ARK-T244

test("ARK-T244 Hubs that start at once on a lock left by a dead pid give the lock to exactly one, and every other one names it", async () => {
  fixture();
  const lockPath = join(
    process.env.ARK_HOME!,
    `hub-${createHash("sha1").update(root).digest("hex").slice(0, 12)}.lock`,
  );
  const go = join(process.env.ARK_FAKE_STATE!, "go");
  const code = `
    import { existsSync } from "node:fs";
    import { acquireLock } from ${JSON.stringify(join(root, "hub", "lock.ts"))};
    console.log("ready");
    while (!existsSync(${JSON.stringify(go)})) {}
    console.log(JSON.stringify({ pid: process.pid, holder: acquireLock(1234) }));
    setInterval(() => {}, 1000);`;
  const racers = 12;
  for (let round = 0; round < 12; round++) {
    rmSync(go, { force: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, port: 1234 }));
    const children = Array.from({ length: racers }, () => {
      const child = Bun.spawn(["bun", "-e", code], {
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      processes.push(child);
      const lines: string[] = [];
      void (async () => {
        let text = "";
        for await (const chunk of child.stdout) {
          text += new TextDecoder().decode(chunk);
          lines.splice(0, lines.length, ...text.split("\n").filter(Boolean));
        }
      })();
      return lines;
    });
    await until("every racer to be ready", () => children.every((lines) => lines.length >= 1));
    writeFileSync(go, "");
    await until("every racer to answer", () => children.every((lines) => lines.length >= 2));
    const answers = children.map(
      (lines) => JSON.parse(lines[1]) as { pid: number; holder: unknown },
    );
    const winners = answers.filter((answer) => answer.holder === null);
    expect(winners).toHaveLength(1);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(winners[0].pid);
    for (const answer of answers) {
      if (answer.holder !== null) expect(answer.holder).toMatchObject({ pid: winners[0].pid });
    }
    for (const child of processes.splice(0)) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
});

// ---------------------------------------------------------------- ARK-T245

test("ARK-T245 A GitHub read released after the last page left changes nothing the next page sees, and the next page's own read shows the new answer", async () => {
  const fake = fixture();
  const run = buildingRun(3);
  const hub = await startHub({ interval: 100 });
  const stateOf = (snapshot: Snapshot) =>
    snapshot.runs === "unknown"
      ? null
      : (snapshot.runs.find((view) => view.run === run)?.merge_requests[0]?.state ?? null);
  const closedView = JSON.stringify({ state: "CLOSED", statusCheckRollup: [] });

  let client = connect(hub);
  await until("an open merge request", () =>
    client.pushes.some((push) => stateOf(push) === "open"),
  );

  // Hold the next GitHub read, drop the last page, then let the read answer "closed".
  fake.control("gh.hold", true);
  const target = fake.reads("gh") + 1;
  await until("a GitHub read in flight", () => fake.reads("gh") >= target);
  client.close();
  await sleep(200); // the hub sees the disconnect
  writeFileSync(join(fake.state, "gh.view"), closedView);
  fake.control("gh.hold", false);
  await until("the late read to end", () => {
    const children = spawnSync("pgrep", ["-P", String(hub.child.pid)]);
    return children.stdout.toString().trim() === "";
  });
  await snapshotOf(hub);

  // The next page: its Ark read must not publish the discarded answer.
  fake.control("gh.hold", true);
  const resumed = fake.reads("gh") + 1;
  client = connect(hub);
  await until("the next GitHub read in flight", () => fake.reads("gh") >= resumed);
  await until("the first push", () => client.pushes.length > 0);
  expect(client.pushes.map(stateOf)).not.toContain("closed");

  fake.control("gh.hold", false);
  await until("the new answer", () => client.pushes.some((push) => stateOf(push) === "closed"));
});
