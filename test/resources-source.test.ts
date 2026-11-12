import type { Subprocess } from "bun";
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createResourcesReader, type ResourcesContext } from "../hub/resources.ts";
import { createSnapshotReader } from "../hub/snapshot.ts";
import type { Agent, Snapshot } from "../hub/types.ts";
import { runDirectoryOf, today, writeRun } from "./hub-fixtures.ts";
import { installFakeTools, setFakeHost, tempArkHome } from "./helpers.ts";
import { macOnly } from "./orphan-runners.ts";
import {
  installProcessFakes,
  secretEnvironment,
  secrets,
  whenFilesChange,
  writeStartedTicket,
  type FakeProcess,
  type ProcessFakes,
} from "./resources-fixtures.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, "..");
let savedEnvironment: NodeJS.ProcessEnv;
const hubs: { process: Subprocess<"ignore", "pipe", "pipe">; closePage: () => void }[] = [];

afterEach(() => {
  delete process.env.ARK_NOW;
});

beforeAll(() => {
  savedEnvironment = { ...process.env };
});

afterAll(async () => {
  for (const hub of hubs) {
    hub.closePage();
    hub.process.kill();
    await hub.process.exited;
  }
  for (const key of Object.keys(process.env))
    if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
});

const scratch = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** An ARK_HOME and empty session roots, so no test reads the real `~/.omp`, `~/.claude` or `~/.codex`. */
function isolatedEnvironment(): string {
  const home = tempArkHome();
  process.env.ARK_OMP_SESSIONS = scratch("ark-omp-sessions-");
  process.env.ARK_CLAUDE_SESSIONS = scratch("ark-claude-sessions-");
  process.env.ARK_CODEX_SESSIONS = scratch("ark-codex-sessions-");
  process.env.ARK_HUB_INTERVAL_MS = "150";
  return home;
}

/** Starts the hub with its whole output kept, and one open page so it samples. */
async function startLoggedHub() {
  const process_ = Bun.spawn(["bun", join(root, "hub", "main.ts"), "--port", "0"], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let log = "";
  const address = Promise.withResolvers<string>();
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      log += new TextDecoder().decode(chunk);
      const port = log.match(/127\.0\.0\.1:(\d+)/)?.[1];
      if (port) address.resolve(`http://127.0.0.1:${port}`);
    }
  };
  void collect(process_.stdout as ReadableStream<Uint8Array>);
  void collect(process_.stderr as ReadableStream<Uint8Array>);
  const baseUrl = await address.promise;
  const page = new AbortController();
  fetch(`${baseUrl}/events`, { signal: page.signal }).catch(() => {});
  const hub = { process: process_, baseUrl, log: () => log, closePage: () => page.abort() };
  hubs.push(hub);
  return hub;
}

/** The first pushed snapshot (the stream's own current one included) for which `ready` holds: an event wait. */
async function snapshotWhen(
  baseUrl: string,
  ready: (snapshot: Snapshot) => boolean,
): Promise<Snapshot> {
  const controller = new AbortController();
  try {
    const reader = (
      await fetch(`${baseUrl}/events`, { signal: controller.signal })
    ).body!.getReader();
    let buffered = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the event stream ended");
      buffered += new TextDecoder().decode(chunk.value);
      const messages = buffered.split("\n\n");
      buffered = messages.pop() ?? "";
      for (const message of messages) {
        if (!message.startsWith("data: ")) continue;
        const snapshot: Snapshot = JSON.parse(message.slice(6));
        if (ready(snapshot)) return snapshot;
      }
    }
  } finally {
    controller.abort();
  }
}

/** What the hub recorded for one agent in a run's `resources.json`; undefined until the file holds it. */
function agentRecord(file: string, handle: string): { peak_mb: number; cpu_s: number } | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")).agents?.[handle];
  } catch {
    return undefined;
  }
}

/** The first pushed snapshot that already holds a resources reading. */
async function firstPushWithResources(baseUrl: string): Promise<string> {
  const controller = new AbortController();
  try {
    const reader = (
      await fetch(`${baseUrl}/events`, { signal: controller.signal })
    ).body!.getReader();
    let buffered = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the event stream ended");
      buffered += new TextDecoder().decode(chunk.value);
      for (const message of buffered.split("\n\n"))
        if (message.startsWith("data: ") && !message.includes('"resources":"unknown"'))
          return message.slice(6);
    }
  } finally {
    controller.abort();
  }
}

function orcaWithAgents(run: string, handles: string[]) {
  return {
    terminals: [
      { handle: "term-lead", connected: true, agentIdentity: "omp" },
      ...handles.map((handle) => ({ handle, connected: true, agentIdentity: "omp" })),
    ],
    runs: [{ id: `orca-${run}`, objective: `Ark run ${run}`, coordinator_handle: "term-lead" }],
    workers: handles.map((handle, index) => ({
      taskId: `task-${index}`,
      state: "running",
      agentTerminalHandle: handle,
      projection: { provider: { model: "openai/gpt-worker-model" } },
    })),
    tasks: handles.map((handle, index) => ({
      id: `task-${index}`,
      title: `step-${handle} (implementer, .)`,
    })),
  };
}

type Fixture = {
  runA: string;
  runB: string;
  runC: string;
  processes: FakeProcess[];
  fakes: ProcessFakes;
  directoryA: string;
};

/** ARK-T288's world: RUN-A and RUN-B open, RUN-C closed, agent H1 on RUN-A, one process of each owner kind. */
function ownerFixture(): Fixture {
  const home = isolatedEnvironment();
  const runA = `${today()}-ARK-901-1`;
  const runB = `${today()}-ARK-902-1`;
  const runC = `${today()}-ARK-903-1`;
  const directoryA = writeRun({
    project: "p",
    run: runA,
    ticket: { id: "ARK-901", title: "A" },
    phase: "building",
  });
  writeRun({ project: "p", run: runB, ticket: { id: "ARK-902", title: "B" }, phase: "building" });
  writeRun({ project: "p", run: runC, ticket: { id: "ARK-903", title: "C" }, phase: "closed" });
  installFakeTools({ orca: orcaWithAgents(runA, ["H1"]) });
  const fakes = installProcessFakes(join(home, "fakes"));
  // This test process is alive, so its ticket counts; `ark test` itself is not in the fake process list.
  writeStartedTicket(runB, process.pid);
  const baseCheckout = mkdtempSync(join(tmpdir(), "ark-base-"));
  const environment = (...more: string[]) => [`PATH=/usr/bin`, ...secretEnvironment, ...more];
  const processes: FakeProcess[] = [
    {
      pid: 41001,
      command: "/opt/bun/bin/bun test --parallel test/a.test.ts",
      environment: environment("ORCA_TERMINAL_HANDLE=H1"),
      directory: "/Users/someone/repo",
    },
    {
      pid: 41002,
      parent: 41001,
      command: "git status --short",
      environment: environment("ORCA_TERMINAL_HANDLE=H1"),
      directory: join(runDirectoryOf("p", runC), "workspace"),
    },
    {
      pid: 41003,
      command: "node /repo/node_modules/playwright/cli.js test",
      // A value with a space: the text after the first NAME=value word is environment, and the last
      // ORCA_TERMINAL_HANDLE= word belongs to no agent.
      environment: environment("NOTE=a", "b", "ORCA_TERMINAL_HANDLE=EVIL"),
      directory: join(directoryA, "workspace"),
    },
    {
      pid: 41004,
      group: process.pid,
      command: "/Applications/Chromium.app/Contents/MacOS/Chromium --headless=new",
      environment: environment(),
      directory: "/Users/someone/elsewhere",
    },
    {
      pid: 41005,
      group: process.pid,
      command: "/opt/bun/bin/bun test base.test.ts",
      environment: environment(),
      directory: baseCheckout,
    },
    {
      pid: 41006,
      elapsed: "11-00:00:00",
      command: "node /srv/site/node_modules/astro/astro.js preview",
      environment: environment(),
      directory: join(runDirectoryOf("p", runC), "workspace"),
    },
    {
      pid: 41007,
      command: "sleep 1000",
      environment: environment(),
      directory: "/tmp/unrelated",
    },
  ];
  fakes.setProcesses(processes);
  return { runA, runB, runC, processes, fakes, directoryA };
}

function resourcesOf(snapshot: Snapshot): Exclude<Snapshot["resources"], "unknown"> {
  if (snapshot.resources === "unknown") throw new Error("no resources reading");
  return snapshot.resources;
}

const ownersOf = (snapshot: Snapshot) =>
  Object.fromEntries(resourcesOf(snapshot).processes.map((found) => [found.pid, found.owner]));

const needles = [...secrets.names, secrets.token, secrets.awsValue, "EVIL"];

function expectNoSecret(label: string, text: string): void {
  for (const needle of needles)
    expect(text.includes(needle), `${label} holds ${needle}`).toBe(false);
}

test("ARK-T288 the resources source gives every process to one owner in the AC1 order and serves no env variable", async () => {
  const fixture = ownerFixture();
  const hub = await startLoggedHub();
  const { baseUrl } = hub;
  const snapshot = await snapshotWhen(
    baseUrl,
    (found) =>
      found.resources !== "unknown" &&
      found.resources.processes.some(
        (entry) => entry.pid === 41001 && entry.owner.kind === "agent",
      ),
  );

  expect(ownersOf(snapshot)).toEqual({
    41001: { kind: "agent", handle: "H1" },
    // The agent's handle wins over the cwd in the closed run's folder.
    41002: { kind: "agent", handle: "H1" },
    // A handle that is no agent's (the EVIL word of the value with a space) leaves the cwd to decide.
    41003: { kind: "run", run: fixture.runA },
    41004: { kind: "admission", run: fixture.runB },
    // The base checkout has no run id in its name and a cwd outside runs/<run>/: only admission owns it.
    41005: { kind: "admission", run: fixture.runB },
    41006: { kind: "leftover", run: fixture.runC },
    41007: { kind: "other" },
  });
  const resources = resourcesOf(snapshot);
  expect(resources.processes).toHaveLength(7);
  expect(resources.degraded).toBe(false);
  const kinds = Object.fromEntries(resources.processes.map((entry) => [entry.pid, entry.kind]));
  expect(kinds).toEqual({
    41001: "bun test",
    41002: "git",
    41003: "playwright",
    41004: "chromium",
    41005: "bun test",
    41006: "other",
    41007: "other",
  });
  const leftover = resources.processes.find((entry) => entry.pid === 41006)!;
  expect(leftover.age_seconds).toBe(11 * 86_400);
  expect(leftover.command).toBe("node /srv/site/node_modules/astro/astro.js preview");
  // One read of every process with the environment: `/bin/ps -E -ww` by its flags.
  expect(fixture.fakes.psCalls()).toMatch(/-E -ww/);

  // Every output of the hub: the snapshot, the history route, a pushed snapshot, the run file and the hub's log.
  const history = await (await fetch(`${baseUrl}/api/resources/history`)).text();
  const pushed = await firstPushWithResources(baseUrl);
  const file = join(fixture.directoryA, "results", "resources.json");
  await whenFilesChange(fixture.directoryA, () => agentRecord(file, "H1"));
  const written = readFileSync(file, "utf8");
  expect(JSON.parse(written).agents.H1.peak_mb).toBeGreaterThan(0);
  expectNoSecret("snapshot", JSON.stringify(snapshot));
  expectNoSecret("history", history);
  expectNoSecret("push", pushed);
  expectNoSecret("resources.json", written);
  expectNoSecret("hub log", hub.log());
  // The pushed snapshot is a real push of the same reading.
  expect(JSON.parse(pushed).resources.processes).toHaveLength(7);
});

test("ARK-T288 with lsof failing the handle and admission owners stay, the cwd owners fall to other, and the reading says degraded", async () => {
  const fixture = ownerFixture();
  fixture.fakes.failLsof(true);
  const { baseUrl } = await startLoggedHub();
  const snapshot = await snapshotWhen(
    baseUrl,
    (found) =>
      found.resources !== "unknown" &&
      found.resources.degraded &&
      found.resources.processes.some(
        (entry) => entry.pid === 41001 && entry.owner.kind === "agent",
      ),
  );

  expect(ownersOf(snapshot)).toEqual({
    41001: { kind: "agent", handle: "H1" },
    41002: { kind: "agent", handle: "H1" },
    41003: { kind: "other" },
    41004: { kind: "admission", run: fixture.runB },
    41005: { kind: "admission", run: fixture.runB },
    41006: { kind: "other" },
    41007: { kind: "other" },
  });
  expect(resourcesOf(snapshot).processes).toHaveLength(7);
  expectNoSecret("snapshot", JSON.stringify(snapshot));
});

test("ARK-T288 with a ps that rejects -E the resources slot reports its error, shows no process and the other sources stay fresh", async () => {
  const fixture = ownerFixture();
  fixture.fakes.rejectEnvironment(true);
  const { baseUrl, log } = await startLoggedHub();
  await whenFilesChange(process.env.ARK_HOME as string, () =>
    fixture.fakes.psCalls().includes("-E") ? true : undefined,
  );
  const snapshot = await snapshotWhen(
    baseUrl,
    (found) => found.sources.orca.ok && found.sources.ark.ok,
  );
  expect(fixture.fakes.psCalls()).toContain("-E");
  expect(snapshot.resources).toBe("unknown");
  expect(snapshot.sources.resources.ok).toBe(false);
  expectNoSecret("snapshot", JSON.stringify(snapshot));
  expectNoSecret("hub log", log());
});

test("ARK-T288 a child of the ark test runner reaches the admission through its parent, below the handle and the open run, above a leftover; an ended runner owns nothing", async () => {
  const fixture = ownerFixture();
  // `ark test` is alive in the real world: the ticket holds the pid of that runner, and the suite is a detached child.
  const runnerProcess = Bun.spawn(["sleep", "30"]);
  const endedRunner = Bun.spawn(["true"]);
  await endedRunner.exited;
  const suite = 42_001;
  try {
    writeStartedTicket(fixture.runB, runnerProcess.pid);
    writeStartedTicket(fixture.runC, endedRunner.pid);
    const child = (pid: number, overrides: Partial<FakeProcess>): FakeProcess => ({
      pid,
      parent: suite,
      group: suite,
      command: "bun test x.test.ts",
      directory: "/tmp",
      ...overrides,
    });
    fixture.fakes.setProcesses([
      { pid: runnerProcess.pid, command: "bun cli/ark.ts test", directory: "/Users/someone/repo" },
      child(suite, { parent: runnerProcess.pid, command: "sh -c bun test" }),
      child(suite + 1, {}),
      // The suite's cwd is in a closed run's folder: the admission still owns it, it is no leftover.
      child(suite + 2, { directory: join(runDirectoryOf("p", fixture.runC), "workspace") }),
      // An open run's folder beats the admission, and the handle of an agent beats both.
      child(suite + 3, { directory: join(fixture.directoryA, "workspace") }),
      child(suite + 4, { environment: ["ORCA_TERMINAL_HANDLE=H1"] }),
      // A group held only by a ticket of a runner that has ended is nobody's.
      { pid: 43_001, group: endedRunner.pid, command: "bun test y.test.ts", directory: "/tmp" },
    ]);
    const { baseUrl } = await startLoggedHub();
    const snapshot = await snapshotWhen(
      baseUrl,
      (found) =>
        found.resources !== "unknown" &&
        found.resources.processes.some(
          (entry) => entry.pid === suite + 4 && entry.owner.kind === "agent",
        ),
    );
    expect(ownersOf(snapshot)).toEqual({
      [runnerProcess.pid]: { kind: "admission", run: fixture.runB },
      [suite]: { kind: "admission", run: fixture.runB },
      [suite + 1]: { kind: "admission", run: fixture.runB },
      [suite + 2]: { kind: "admission", run: fixture.runB },
      [suite + 3]: { kind: "run", run: fixture.runA },
      [suite + 4]: { kind: "agent", handle: "H1" },
      43_001: { kind: "other" },
    });
  } finally {
    runnerProcess.kill();
  }
});

test("ARK-T288 the history keeps the points stamped at or after now minus 24 hours and drops the older ones", async () => {
  isolatedEnvironment();
  installProcessFakes(join(process.env.ARK_HOME as string, "fakes")).setProcesses([]);
  const reader = createResourcesReader();
  const context = { runs: [], agents: new Map<string, Agent[]>() };
  const base = Date.parse("2026-11-12T12:00:00Z");
  const clockAt = (offsetSeconds: number) => {
    process.env.ARK_NOW = new Date(base + offsetSeconds * 1000).toISOString();
  };
  const stamps = async () => reader.history().load.map((point) => Date.parse(point.ts) - base);
  // C: 24 h 00 m 01 s old at T, B: exactly 24 h old, A: 23 h 59 m 59 s old, D: one hour old.
  for (const offset of [-86_401, -86_400, -86_399, -3600]) {
    clockAt(offset);
    expect(await reader.read(context)).not.toBeNull();
  }
  clockAt(0);
  expect((await stamps()).map((milliseconds) => milliseconds / 1000)).toEqual([
    -86_400, -86_399, -3600,
  ]);
  clockAt(2);
  await reader.read(context);
  expect((await stamps()).map((milliseconds) => milliseconds / 1000)).toEqual([-3600, 2]);
  clockAt(3602);
  await reader.read(context);
  expect((await stamps()).map((milliseconds) => milliseconds / 1000)).toEqual([-3600, 2, 3602]);
});

test("ARK-T288 GET /api/resources/history serves a foreign Host nothing", async () => {
  ownerFixture();
  const { baseUrl } = await startLoggedHub();
  const { port } = new URL(baseUrl);
  const { promise, resolve: done } = Promise.withResolvers<string>();
  let answer = "";
  await Bun.connect({
    hostname: "127.0.0.1",
    port: Number(port),
    socket: {
      data: (_socket, data) => void (answer += data.toString()),
      close: () => done(answer),
    },
  }).then((socket) =>
    socket.write(
      "GET /api/resources/history HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    ),
  );
  expect(Number((await promise).match(/^HTTP\/1\.1 (\d+)/)?.[1])).toBe(403);
  const own = await fetch(`${baseUrl}/api/resources/history`);
  expect(own.status).toBe(200);
  expect(Object.keys(await own.json())).toEqual(["cpu", "pressure", "swap", "disk", "load"]);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    expect([404, 405]).toContain(
      (await fetch(`${baseUrl}/api/resources/history`, { method, body: "{}" })).status,
    );
});

macOnly(
  "ARK-T289 the hub snapshot carries the swap level of the host reading and the core count next to load",
  async () => {
    ownerFixture();
    setFakeHost({ freePercent: 50, swapGigabytes: 6.5 });
    const { baseUrl } = await startLoggedHub();
    const snapshot = await snapshotWhen(baseUrl, (found) => found.resources !== "unknown");
    const { host } = resourcesOf(snapshot);
    expect(host.swap).toMatchObject({ used_gb: 6.5, level: "red" });
    expect(host.cpu.cores).toBeGreaterThan(0);
    expect(host.load.five).not.toBeNull();
    setFakeHost({ freePercent: null, swapGigabytes: null });
    const unread = await snapshotWhen(
      baseUrl,
      (found) => found.resources !== "unknown" && found.resources.host.swap.level === "unchecked",
    );
    expect(resourcesOf(unread).host.swap).toEqual({
      used_gb: null,
      total_gb: null,
      level: "unchecked",
    });
  },
);

// ---------------------------------------------------------------- ARK-T292

const start = Date.parse("2026-11-12T12:00:00Z");
const handles = ["H1", "H2", "H3", "H4"];

function agentOf(handle: string): Agent {
  return {
    role: "implementer",
    harness: "omp",
    model: null,
    title: handle,
    step: `step-${handle}`,
    planned: null,
    terminal: handle,
    presence: "live",
    activity: { text: "working" } as Agent["activity"],
  };
}

test("ARK-T292 the hub records the maximum memory and the last cumulative CPU of each agent, and each span with no sample as a gap, and keeps suites", async () => {
  const home = isolatedEnvironment();
  const fakes = installProcessFakes(join(home, "fakes"));
  const directory = join(home, "projects", "p", "runs", "RUN-A");
  const results = join(directory, "results");
  mkdirSync(results, { recursive: true });
  const suites = {
    unit: { head: { peak_mb: 700, cpu_s: 30, wall_s: 60, wait_s: 0 } },
    e2e: { head: { peak_mb: 450, cpu_s: 55, wall_s: 90, wait_s: 0 } },
  };
  writeFileSync(join(results, "resources.json"), JSON.stringify({ suites }));
  const context = {
    runs: [
      { run: "RUN-A", directory, closed: false },
      { run: "RUN-OLD", directory: join(home, "projects", "p", "runs", "RUN-OLD"), closed: true },
    ],
    agents: new Map([["RUN-A", handles.map(agentOf)]]),
  };
  const read = () => JSON.parse(readFileSync(join(results, "resources.json"), "utf8"));
  const sample = async (
    reader: { read(context: ResourcesContext): Promise<unknown> },
    offsetSeconds: number,
    readings: Record<string, [megabytes: number, cpuSeconds: number]>,
  ) => {
    process.env.ARK_NOW = new Date(start + offsetSeconds * 1000).toISOString();
    fakes.setProcesses(
      Object.entries(readings).map(([handle, [megabytes, cpuSeconds]], index) => ({
        pid: 52_000 + index,
        command: `omp work-${handle}`,
        environment: [...secretEnvironment, `ORCA_TERMINAL_HANDLE=${handle}`],
        memoryMegabytes: megabytes,
        cpuSeconds,
      })),
    );
    expect(await reader.read(context)).not.toBeNull();
    expect(read().suites).toEqual(suites);
  };
  const agentsOf = () =>
    Object.fromEntries(
      Object.entries(read().agents as Record<string, { peak_mb: number; cpu_s: number }>).map(
        ([handle, use]) => [handle, [use.peak_mb, use.cpu_s]],
      ),
    );

  const first = createResourcesReader();
  await sample(first, 0, { H1: [300, 10], H2: [200, 4], H3: [100, 2], H4: [50, 1] });
  await sample(first, 5, { H1: [500, 14], H2: [200, 4], H3: [100, 2], H4: [50, 1] });
  expect(read().gaps).toBeUndefined();
  // The last page closes: the hub pauses. 5 minutes pass with no sample (H1 would read 900 MB meanwhile).
  first.flush();
  await sample(first, 305, { H1: [400, 20], H2: [250, 9], H3: [100, 2], H4: [50, 1] });
  // Memory is the maximum (500, not 400); CPU is the last cumulative value (20), never the sum 10+14+20.
  expect(agentsOf()).toEqual({ H1: [500, 20], H2: [250, 9], H3: [100, 2], H4: [50, 1] });
  expect(read().gaps).toEqual([
    { from: new Date(start + 5000).toISOString(), to: new Date(start + 305_000).toISOString() },
  ]);

  // The hub restarts (SIGTERM: stop() pauses and flushes), and 2 minutes later a new hub samples H1 and H2 only.
  first.flush();
  const second = createResourcesReader();
  await sample(second, 425, { H1: [350, 26], H2: [150, 12] });
  // A lower reading never lowers a peak, and an agent that is absent keeps its entry.
  expect(agentsOf()).toEqual({ H1: [500, 26], H2: [250, 12], H3: [100, 2], H4: [50, 1] });
  expect(read().gaps).toEqual([
    { from: new Date(start + 5000).toISOString(), to: new Date(start + 305_000).toISOString() },
    { from: new Date(start + 305_000).toISOString(), to: new Date(start + 425_000).toISOString() },
  ]);
  // Samples in a row add nothing.
  await sample(second, 430, { H1: [350, 27], H2: [150, 12] });
  expect(read().gaps).toHaveLength(2);
  expect(read().agents.H1.cpu_s).toBe(27);
  expect(JSON.stringify(read())).not.toContain(secrets.token);
  // The hub dies with no flush (SIGKILL): the stamp each sample left still lets the next hub record the span.
  const third = createResourcesReader();
  await sample(third, 1000, { H1: [350, 28], H2: [150, 12] });
  const crashGap = read().gaps.at(-1);
  expect(read().gaps).toHaveLength(3);
  expect(crashGap.to).toBe(new Date(start + 1_000_000).toISOString());
  expect(Date.parse(crashGap.from)).toBeGreaterThanOrEqual(start + 430_000 - 60_000);
  expect(Date.parse(crashGap.from)).toBeLessThanOrEqual(start + 430_000);
});

test("ARK-T292 closing the last hub page writes the time of the last sample, so the next sample records the gap", async () => {
  const home = isolatedEnvironment();
  const run = `${today()}-ARK-904-1`;
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-904", title: "pause" },
    phase: "building",
  });
  installFakeTools({ orca: orcaWithAgents(run, ["H1"]) });
  const fakes = installProcessFakes(join(home, "fakes"));
  fakes.setProcesses([
    {
      pid: 53_000,
      command: "omp work",
      environment: ["ORCA_TERMINAL_HANDLE=H1"],
      memoryMegabytes: 40,
    },
  ]);
  const reader = createSnapshotReader();
  const file = join(directory, "results", "resources.json");
  const stop = reader.subscribe(() => {});
  try {
    const recorded = await whenFilesChange(directory, () => agentRecord(file, "H1"));
    expect(recorded.peak_mb).toBe(40);
  } finally {
    stop();
  }
  expect(Date.parse(JSON.parse(readFileSync(file, "utf8")).sampled_until)).not.toBeNaN();
  reader.stop();
});
