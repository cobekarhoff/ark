import { afterAll, beforeAll, expect, jest, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ProjectAnswer, RunConversation } from "../hub/conversation.ts";
import type {
  RunDetail,
  RunView,
  Snapshot,
  TicketCases,
  TranscriptEntry,
  TranscriptPage,
} from "../hub/types.ts";
import { parseTicketDocument } from "../hub/ticket-document.ts";
import { createSnapshotReader } from "../hub/snapshot.ts";
import { isHubName, proxyPort } from "../cli/proxy.ts";
import { serve } from "../hub/server.ts";
import { activityOf } from "../hub/sources.ts";
import { stuckAgents } from "../hub/page/derive.ts";
import { stepTimeText } from "../hub/progress.ts";
import { readTranscriptPage } from "../hub/transcript.ts";
import { UsageIndex } from "../hub/usage.ts";
import {
  appendRawEvent,
  fakeGateEnvironment,
  ompSessionText,
  commitCase,
  orcaAnswersFor,
  repoProjectConfig,
  repoRunFixture,
  submodulePointerSha,
  writeRepoWorkspace,
  today,
  transcriptText,
  type ExtraEntry,
  type SessionHarness,
  runDirectoryOf,
  writeBacklogTicket,
  writeEventLog,
  writeFakeToolState,
  writeOmpSession,
  writeRoadmap,
  writeRun,
  writeSessionFile,
} from "./hub-fixtures.ts";
import { installProcessFakes } from "./resources-fixtures.ts";
import {
  installFakeTools,
  startHub,
  stopHub,
  tempArkHome,
  writeFakeCommand,
  writeProject,
  type StartedHub,
} from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const root = resolve(import.meta.dir, "..");
const hubs: StartedHub["process"][] = [];
const indexes: UsageIndex[] = [];
let savedEnvironment: NodeJS.ProcessEnv;

beforeAll(() => {
  savedEnvironment = { ...process.env };
});

afterAll(async () => {
  for (const index of indexes) index.close();
  await Promise.all(hubs.map(stopHub));
  for (const key of Object.keys(process.env))
    if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
});

const scratch = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** An ARK_HOME with empty session roots, so no test reads the real `~/.omp`, `~/.claude` or `~/.codex`. */
function isolatedEnvironment(): { sessions: string } {
  tempArkHome();
  const sessions = scratch("ark-omp-sessions-");
  process.env.ARK_OMP_SESSIONS = sessions;
  process.env.ARK_CLAUDE_SESSIONS = scratch("ark-claude-sessions-");
  process.env.ARK_CODEX_SESSIONS = scratch("ark-codex-sessions-");
  // The `resources` source reads `/bin/ps -E`, which Linux does not support: without a fake its slot never turns ok.
  installProcessFakes(scratch("ark-process-fakes-")).setProcesses([]);
  return { sessions };
}

async function start() {
  const hub = await startHub();
  hubs.push(hub.process);
  return hub;
}

interface Pushes {
  close(): void;
  blocked(): Promise<void>;
  next(): Promise<string>;
}

/**
 * The hub's `/events` stream: `next()` resolves with the next pushed snapshot (JSON text) and has no
 * deadline of its own. The test ends on the event, or the harness timeout of the file fails it.
 */
async function openPushes(baseUrl: string): Promise<Pushes> {
  const controller = new AbortController();
  const reader = (
    await fetch(`${baseUrl}/events`, { signal: controller.signal })
  ).body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let onBlocked: (() => void) | undefined;
  return {
    close: () => controller.abort(),
    /** Resolves when `next()` has no buffered push left and waits on the stream. */
    blocked: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      onBlocked = resolve;
      return promise;
    },
    async next(): Promise<string> {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end >= 0) {
          const message = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          if (message.startsWith("data: ")) return message.slice(6);
          continue;
        }
        onBlocked?.();
        onBlocked = undefined;
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the event stream ended");
        buffered += decoder.decode(chunk.value);
      }
    },
  };
}

/**
 * The test's gate: stops the hub (SIGSTOP; Bun's `kill` cannot send it), starts `work`, waits until `work` is blocked
 * on the push stream (the hold is observed, not assumed), moves the fake clock 10 s past the old push deadline while the
 * hub is stopped, then releases the hub (SIGCONT). A deadline in the wait would fire on that clock; no wall time passes.
 */
async function heldPastTenSeconds<T>(
  hub: { process: { pid: number } },
  pushes: Pushes,
  work: () => Promise<T>,
): Promise<T> {
  process.kill(hub.process.pid, "SIGSTOP");
  jest.useFakeTimers();
  const reached = pushes.blocked();
  const waiting = work();
  try {
    await Promise.race([reached, waiting]);
    const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(hub.process.pid)]).stdout;
    expect(state.toString().trim()).toStartWith("T");
    jest.advanceTimersByTime(10_001);
  } finally {
    jest.useRealTimers();
    process.kill(hub.process.pid, "SIGCONT");
  }
  return waiting;
}

// ---------------------------------------------------------------- AC1

const readDoc = (path: string) => readFileSync(join(root, path), "utf8");

// ---------------------------------------------------------------- AC2

test("ARK-277-AC2 every route of the hub but open-in-orca answers POST, PUT, PATCH and DELETE with 404 or 405", async () => {
  isolatedEnvironment();
  const run = `${today()}-ARK-801-1`;
  writeRun({ project: "p", run, ticket: { id: "ARK-801", title: "Open" }, phase: "building" });
  writeBacklogTicket({ project: "p", id: "ARK-801", title: "Open", status: "ready" });
  installFakeTools({ orca: orcaAnswersFor(run) });
  const { baseUrl } = await start();

  const html = await (await fetch(`${baseUrl}/`)).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  expect(assets.length).toBeGreaterThan(0);
  const served = ["/", "/api/snapshot", "/events", `/api/run/${run}`, ...assets];
  // A route that does not exist answers a write method like a route that does.
  const unserved = ["/nope", "/api/nope", "/api/snapshot/extra", "/assets/nope.js"];

  // The routes are live: a GET gets 200, so the write methods below are tried on real routes.
  for (const route of served) {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}${route}`, { signal: controller.signal });
    expect(response.status, route).toBe(200);
    controller.abort();
  }
  for (const route of [...served, ...unserved])
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(`${baseUrl}${route}`, { method, body: "{}" });
      expect([404, 405], `${method} ${route}`).toContain(response.status);
    }
  // The one route that takes a POST (ADR 0009) still refuses every other method.
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${baseUrl}/api/open-in-orca`, { method });
    expect(response.status, `${method} /api/open-in-orca`).toBe(405);
  }
});

// ---------------------------------------------------------------- ARK-284

/** One raw HTTP request, so a test can set a `Host` that `fetch` would not send. */
async function rawPost(baseUrl: string, host: string, origin: string, body: string) {
  const { port } = new URL(baseUrl);
  const { promise, resolve } = Promise.withResolvers<string>();
  let answer = "";
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: Number(port),
    socket: {
      data: (_socket, data) => void (answer += data.toString()),
      close: () => resolve(answer),
    },
  });
  socket.write(
    `POST /api/open-in-orca HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
  );
  return Number((await promise).match(/^HTTP\/1\.1 (\d+)/)?.[1]);
}

test("ARK-284-AC1 open-in-orca answers 200, 403, 400 and 502, runs only terminal switch, and never sends text", async () => {
  isolatedEnvironment();
  const run = `${today()}-ARK-805-1`;
  writeRun({ project: "p", run, ticket: { id: "ARK-805", title: "Open" }, phase: "building" });
  const state = installFakeTools({ orca: orcaAnswersFor(run) });
  const { baseUrl } = await start();
  const own = new URL(baseUrl).host;
  const post = (terminal: unknown, origin: string | null = baseUrl) =>
    fetch(`${baseUrl}/api/open-in-orca`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ terminal }),
    });
  const switches = () =>
    readFileSync(join(state, "orca.log"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("terminal switch"));
  // The snapshot lists the terminals as live after the first Orca read.
  for (let tries = 0; tries < 50; tries++) {
    const snapshot = (await (await fetch(`${baseUrl}/api/snapshot`)).json()) as Snapshot;
    if (Array.isArray(snapshot.runs) && Array.isArray(snapshot.runs[0]?.agents)) break;
    await Bun.sleep(100);
  }

  expect((await post("term-worker")).status).toBe(200);
  expect(switches()).toEqual(["terminal switch --terminal term-worker"]);
  expect((await post("term-worker", "http://evil.example")).status).toBe(403);
  expect((await post("term-worker", null)).status).toBe(403);
  expect(await rawPost(baseUrl, "evil.example", baseUrl, '{"terminal":"term-worker"}')).toBe(403);
  expect(await rawPost(baseUrl, own, baseUrl, '{"terminal":"term-worker"}')).toBe(200);
  expect((await post("term-unlisted")).status).toBe(400);
  expect((await post("--help; rm -rf /")).status).toBe(400);
  expect((await post(42)).status).toBe(400);
  expect(switches()).toHaveLength(2);
  expect(readFileSync(join(state, "orca.log"), "utf8")).not.toContain("terminal send");

  writeFakeToolState(state, { orca: orcaAnswersFor(run), orcaSwitchFails: true });
  expect((await post("term-worker")).status).toBe(502);
});

// ---------------------------------------------------------------- AC5

test("ARK-277-AC5 the usage index parses only session files whose size or mtime changed, and a closed run costs what metrics.json says", async () => {
  const { sessions } = isolatedEnvironment();
  const openRun = writeRun({
    project: "p",
    run: `${today()}-ARK-802-1`,
    ticket: { id: "ARK-802", title: "Open" },
    phase: "building",
  });
  // A closed run with metrics.json and no session file: its cost can only come from metrics.json.
  const closedRun = writeRun({
    project: "p",
    run: `${today()}-ARK-803-1`,
    ticket: { id: "ARK-803", title: "Closed" },
    phase: "closed",
    metricsCostUsd: 12.34,
  });
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);
  const files = ["a", "b", "c"].map((name, number) =>
    writeOmpSession(sessions, name, join(openRun, "workspace"), [
      { time: at(100 + number), costUsd: 0.5 },
    ]),
  );
  const index = new UsageIndex();
  indexes.push(index);

  await index.refresh([openRun]);
  expect(index.parseCount).toBe(3);
  expect(index.runCost(openRun, false, []).total).toBeCloseTo(1.5, 10);

  await index.refresh([openRun]);
  expect(index.parseCount).toBe(3); // nothing changed: 0 files parsed

  // The file grows: its size changes.
  appendFileSync(
    files[0],
    ompSessionText(join(openRun, "workspace"), [{ time: at(1), costUsd: 0.25 }])
      .split("\n")
      .slice(1)
      .join("\n"),
  );
  await index.refresh([openRun]);
  expect(index.parseCount).toBe(4); // that 1 file
  expect(index.runCost(openRun, false, []).total).toBeCloseTo(1.75, 10);

  // Same size, new mtime: parsed again, once.
  const stat = statSync(files[1]);
  utimesSync(files[1], stat.atime, new Date(stat.mtimeMs + 5000));
  await index.refresh([openRun]);
  expect(index.parseCount).toBe(5);

  await index.refresh([openRun]);
  expect(index.parseCount).toBe(5);

  // The closed run reads metrics.json: no session file is parsed for it.
  const before = index.parseCount;
  expect(index.runCost(closedRun, true, []).total).toBe(12.34);
  await index.refresh([openRun]);
  expect(index.parseCount).toBe(before);
});

test("ARK-277-AC5 a usage worker that crashes fails its file, never hangs the refresh, and the next refresh is answered", async () => {
  const { sessions } = isolatedEnvironment();
  const openRun = writeRun({
    project: "p",
    run: `${today()}-ARK-804-1`,
    ticket: { id: "ARK-804", title: "Open" },
    phase: "building",
  });
  const cwd = join(openRun, "workspace");
  // A worker that throws on its first request, outside the parser's try, and is the real worker
  // afterwards. It loads the real module at run time because it must answer only after the crash.
  const marker = join(scratch("ark-worker-"), "crashed");
  const stub = join(dirname(marker), "worker.ts");
  writeFileSync(
    stub,
    `import { existsSync, writeFileSync } from "node:fs";
self.onmessage = async (event) => {
  if (!existsSync(${JSON.stringify(marker)})) {
    writeFileSync(${JSON.stringify(marker)}, "");
    setTimeout(() => { throw new Error("crash"); }, 0);
    return;
  }
  await import(${JSON.stringify(join(root, "hub", "usage-worker.ts"))});
  self.onmessage(event);
};
`,
  );
  const index = new UsageIndex(pathToFileURL(stub));
  indexes.push(index);

  const first = writeOmpSession(sessions, "a", cwd, [{ time: new Date(), costUsd: 0.5 }]);
  await index.refresh([openRun]);
  expect(index.runCost(openRun, false, []).total).toBeNull(); // the file whose worker crashed is failed

  rmSync(first);
  writeOmpSession(sessions, "b", cwd, [{ time: new Date(), costUsd: 0.75 }]);
  await index.refresh([openRun]);
  expect(index.runCost(openRun, false, []).total).toBeCloseTo(0.75, 10);
});

// ---------------------------------------------------------------- AC6

// The usage index lives in memory in a Bun Worker pool (hub-server measured a full snapshot of 300
// files and 101 MB in 148 ms). The sqlite clause of the AC ("if memory cannot meet the budget ...
// delete and rebuild usage.sqlite") does not apply: the hub keeps no sqlite file, so there is
// nothing to delete. This test holds the CPU-time and latency budgets of the memory index.
test("ARK-T127 ARK-277-AC6 a cold hub serves a full snapshot with under 5 s of CPU time and / answers at a p75 under 200 ms meanwhile", async () => {
  const { sessions } = isolatedEnvironment();
  const answersChecked = 20;
  const runCount = 5;
  const filesPerRun = 60; // 300 session files
  const costPerMessage = 0.001;
  const runs = Array.from({ length: runCount }, (_, number) => {
    const run = `${today()}-ARK-81${number}-1`;
    const directory = writeRun({
      project: "p",
      run,
      ticket: { id: `ARK-81${number}`, title: `Open ${number}` },
      phase: "building",
    });
    return { run, directory };
  });
  const answers = orcaAnswersFor(runs[0].run);
  // The queue source reads the Tasks of this Run; the fixture project is `p`.
  answers.runs?.push({ id: "orca-chief", objective: "Master Chief: p tickets" });
  installFakeTools({ orca: answers });

  // 300 files, 100 MB or more in total: each file has the same number of messages.
  const message = { time: new Date(), costUsd: costPerMessage };
  const messageBytes =
    ompSessionText("/x", [message, message]).length - ompSessionText("/x", [message]).length;
  const messagesPerFile = Math.ceil((100 * 1024 * 1024) / (runCount * filesPerRun) / messageBytes);
  let totalBytes = 0;
  for (const { directory } of runs) {
    const body = ompSessionText(
      join(directory, "workspace"),
      Array.from({ length: messagesPerFile }, () => message),
    );
    for (let number = 0; number < filesPerRun; number++) {
      const file = join(sessions, `${directory.split("/").at(-1)}-${number}.jsonl`);
      writeFileSync(file, body);
      totalBytes += statSync(file).size;
    }
  }
  expect(readdirSync(sessions).length).toBe(300);
  expect(totalBytes).toBeGreaterThanOrEqual(100 * 1024 * 1024);
  const expectedCost = filesPerRun * messagesPerFile * costPerMessage;

  // The fake orca holds every call until the test releases it, so the snapshot cannot be full while the
  // answers of `/` are sampled: the samples do not depend on how fast the host schedules this process.
  const gate = join(scratch("ark-gate-"), "release");
  process.env[fakeGateEnvironment] = gate;
  process.env.ARK_ORCA_TIMEOUT_MS = "600000"; // far above any host stall: only the release decides
  let hub: StartedHub;
  try {
    hub = await start();
  } finally {
    delete process.env[fakeGateEnvironment];
    delete process.env.ARK_ORCA_TIMEOUT_MS;
  }
  const { baseUrl } = hub;
  const pushes = await openPushes(baseUrl);
  const latencies: number[] = [];
  let snapshot: Snapshot;
  try {
    for (let sample = 0; sample < answersChecked; sample++) {
      const requestedAt = performance.now();
      await (await fetch(`${baseUrl}/`)).arrayBuffer();
      latencies.push(performance.now() - requestedAt);
    }
    writeFileSync(gate, ""); // release: the hub builds the full snapshot now
    // The wait ends on the event: the push that carries the full snapshot.
    for (;;) {
      const candidate = JSON.parse(await pushes.next()) as Snapshot;
      if (
        Object.values(candidate.sources).every((source) => source.ok) &&
        Array.isArray(candidate.runs) &&
        candidate.runs.every((run: RunView) => run.cost_usd !== null)
      ) {
        snapshot = candidate;
        break;
      }
    }
  } finally {
    writeFileSync(gate, "");
    pushes.close();
  }
  expect(latencies).toHaveLength(answersChecked);

  // CPU time of the hub (the usage Workers run in its process) from the OS accounting of the child,
  // read after it exited: the same source on macOS and Linux, and a host stall does not move it.
  await stopHub(hub.process);
  const cpuSeconds = Number(hub.process.resourceUsage()?.cpuTime.total ?? 0n) / 1e6;
  expect(cpuSeconds).toBeGreaterThan(0);
  expect(cpuSeconds).toBeLessThan(5); // 1.5 s measured for the full snapshot
  const p75 = [...latencies].sort((left, right) => left - right)[
    Math.ceil(latencies.length * 0.75) - 1
  ];
  expect(p75).toBeLessThan(200);
  const runViews = snapshot.runs;
  if (!Array.isArray(runViews)) throw new Error("the snapshot has no runs");
  expect(runViews).toHaveLength(runCount);
  for (const run of runViews) expect(run.cost_usd).toBeCloseTo(expectedCost, 6);
}, 60_000);

test("ARK-T127 the CPU time read from a child counts its work and not a stall", async () => {
  const cpuSecondsOf = async (child: Bun.Subprocess) => {
    await child.exited;
    return Number(child.resourceUsage()?.cpuTime.total ?? 0n) / 1e6;
  };
  // The busy child spends 0.4 s of CPU time, whatever the wall time that takes.
  const busy = Bun.spawn(
    ["bun", "-e", "while (process.cpuUsage().user + process.cpuUsage().system < 400_000);"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  // The stalled child is stopped and continued, then ends on the closing of its input: no work.
  const stalled = Bun.spawn(["bun", "-e", "for await (const chunk of Bun.stdin.stream());"], {
    stdin: "pipe",
    stdio: ["pipe", "ignore", "ignore"],
  });
  process.kill(stalled.pid, "SIGSTOP");
  process.kill(stalled.pid, "SIGCONT");
  void stalled.stdin.end();
  const [busySeconds, stalledSeconds] = await Promise.all([
    cpuSecondsOf(busy),
    cpuSecondsOf(stalled),
  ]);
  expect(busySeconds).toBeGreaterThanOrEqual(0.4);
  expect(stalledSeconds).toBeLessThan(busySeconds);
});

test("ARK-284-AC7 a transcript page holds 200 entries, a tool call at the page end gets its result, and a crashed worker fails the request", async () => {
  const directory = scratch("ark-transcript-");
  const file = join(directory, "big.jsonl");
  const record = (message: unknown) =>
    JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:00Z", message });
  const lines = [JSON.stringify({ type: "session", cwd: directory })];
  for (let i = 0; i < 199; i++)
    lines.push(record({ role: "user", content: [{ type: "text", text: `m${i}` }] }));
  // Entry 200 is a tool call whose result is the next line, so the page ends between them.
  lines.push(
    record({
      role: "assistant",
      content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }],
    }),
  );
  lines.push(
    record({
      role: "toolResult",
      toolCallId: "t",
      isError: true,
      content: [{ type: "text", text: `first\n${"x".repeat(100_000)}` }],
    }),
  );
  for (let i = 0; i < 50; i++)
    lines.push(record({ role: "user", content: [{ type: "text", text: `n${i}` }] }));
  writeFileSync(file, `${lines.join("\n")}\n`);

  const first = readTranscriptPage(file, "omp", 0);
  expect(first.entries).toHaveLength(200);
  expect(first.entries[199]).toMatchObject({ kind: "tool", status: "error", result: "first" });
  expect(JSON.stringify(first).length).toBeLessThan(40_000);
  const second = readTranscriptPage(file, "omp", first.next!);
  expect(second.entries).toHaveLength(50);
  expect(second.next).toBeNull();

  // A worker that dies on the request rejects it, and the next request gets a new worker.
  const stub = join(directory, "worker.ts");
  writeFileSync(
    stub,
    'self.onmessage = () => setTimeout(() => { throw new Error("crash"); }, 0);\n',
  );
  const index = new UsageIndex(pathToFileURL(stub));
  indexes.push(index);
  const failure = await index.transcript(file, "omp", 0).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(Error);
});

// ---------------------------------------------------------------- AC12

const hasOldHubImport = (file: string): string | null => {
  const text = readFileSync(join(root, file), "utf8");
  for (const [, specifier] of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    if (/react-compiler|babel/.test(specifier)) return specifier;
    if (!specifier.startsWith(".")) continue;
    const target = relative(root, resolve(dirname(join(root, file)), specifier));
    if (target === "ui" || target.startsWith("ui/") || target.startsWith("cli/hub"))
      return specifier;
  }
  return null;
};

test("ARK-277-AC12 the old hub is gone and no file imports it", () => {
  for (const path of ["ui", "cli/hub", "ui/react-compiler.ts"])
    expect(existsSync(join(root, path)), path).toBe(false);

  const oldHubTests = [
    "test/hub-views.test.ts",
    "test/hub-clock.test.ts",
    "test/hub-plan-since.test.ts",
    "test/ui.test.ts",
    "test/run-detail.test.ts",
    "test/map-timeline.test.ts",
    "test/usage-limit.test.ts",
    "test/pw/finished.pw.ts",
    "test/pw/hub-views.pw.ts",
    "test/pw/map-timeline.pw.ts",
    "test/pw/run-detail.pw.ts",
    "test/pw/ui.pw.ts",
    "test/pw/usage-limit.pw.ts",
  ];
  for (const path of oldHubTests) expect(existsSync(join(root, path)), path).toBe(false);

  for (const path of ["bunfig.toml", "package.json", "bun.lock"])
    expect(readDoc(path), path).not.toMatch(/react-compiler|babel/i);

  const importers: string[] = [];
  for (const file of new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs}").scanSync({
    cwd: root,
    onlyFiles: true,
  })) {
    if (/^(node_modules|test-results|\.git)\//.test(file)) continue;
    const found = hasOldHubImport(file);
    if (found) importers.push(`${file} imports ${found}`);
  }
  expect(importers).toEqual([]);
});

test("ARK-T258 ark ui serves the hub from hub/", async () => {
  isolatedEnvironment();
  installFakeTools({});
  const child = Bun.spawn(["bun", join(root, "cli", "ark.ts"), "ui", "--port", "0"], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  hubs.push(child);
  let output = "";
  let baseUrl = "";
  for await (const chunk of child.stdout) {
    output += new TextDecoder().decode(chunk);
    const port = output.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (port) {
      baseUrl = `http://127.0.0.1:${port}`;
      break;
    }
  }
  expect(baseUrl, output).not.toBe("");
  expect((await fetch(`${baseUrl}/api/snapshot`)).status).toBe(200);
  expect(await (await fetch(`${baseUrl}/`)).text()).toContain('<div id="root"></div>');
});

// ---------------------------------------------------------------- AC13

// ---------------------------------------------------------------- ARK-284

/** The run page's read of one run, once the usage index has listed at least `count` session files. */
async function detailWithSessions(baseUrl: string, run: string, count: number): Promise<RunDetail> {
  for (let tries = 0; tries < 150; tries++) {
    const response = await fetch(`${baseUrl}/api/run/${run}`);
    if (response.ok) {
      const detail = (await response.json()) as RunDetail;
      if (detail.sessions_ready && detail.sessions.length >= count) return detail;
    }
    await Bun.sleep(100);
  }
  throw new Error(`the hub never listed ${count} session files of ${run}`);
}

const transcriptUrl = (baseUrl: string, run: string, file: string, cursor: number | string) =>
  `${baseUrl}/api/run/${run}/transcript?file=${encodeURIComponent(file)}&cursor=${cursor}`;

const resultUrl = (baseUrl: string, run: string, file: string, call: string) =>
  `${baseUrl}/api/run/${run}/transcript/result?file=${encodeURIComponent(file)}&call=${encodeURIComponent(call)}`;

test("ARK-284-AC1 with orca down the hub keeps serving, open-in-orca answers 400 and runs nothing, and no run file changes", async () => {
  isolatedEnvironment();
  const run = `${today()}-ARK-806-1`;
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-806", title: "Orca down" },
    phase: "building",
  });
  const events = readFileSync(join(directory, "events.ndjson"), "utf8");
  const state = installFakeTools({ orca: orcaAnswersFor(run), orcaMode: "down" });
  const { baseUrl } = await start();
  let snapshot: Snapshot;
  do {
    await Bun.sleep(100);
    snapshot = (await (await fetch(`${baseUrl}/api/snapshot`)).json()) as Snapshot;
  } while (
    snapshot.sources.orca.ok === false &&
    snapshot.runs === "unknown" &&
    !snapshot.sources.ark.ok
  );

  for (const route of ["/", "/nope", "/api/snapshot", `/api/run/${run}`])
    expect((await fetch(`${baseUrl}${route}`)).status, route).toBe(route === "/nope" ? 404 : 200);
  // Orca never listed a terminal, so the hub knows no live handle: 400, and no `orca` call.
  const answer = await fetch(`${baseUrl}/api/open-in-orca`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ terminal: "term-worker" }),
  });
  expect(answer.status).toBe(400);
  const log = existsSync(join(state, "orca.log"))
    ? readFileSync(join(state, "orca.log"), "utf8")
    : "";
  expect(log).not.toContain("terminal switch");
  expect(log).not.toContain("terminal send");
  expect(readFileSync(join(directory, "events.ndjson"), "utf8")).toBe(events);
});

test("ARK-284-AC5 each session file maps whole to its step, the run lead or unassigned, and a file outside the run folder is not listed", async () => {
  const { sessions } = isolatedEnvironment();
  const run = `${today()}-ARK-807-1`;
  const started = new Date(Date.now() - 3_600_000);
  const at = (seconds: number) => new Date(started.getTime() + seconds * 1000);
  const step = (id: string, needs: string[], startedAfter: number, finishedAfter: number) => ({
    id,
    role: "implementer",
    harness: "omp",
    model: "m",
    needs,
    startedAfter,
    finishedAfter,
  });
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-807", title: "Run lead and 2 workers in one worktree" },
    phase: "building",
    startedAt: started,
    steps: [step("step-a", [], 100, 600), step("step-b", ["step-a"], 700, 1200)],
  });
  // The anchor worktree: the run lead and both workers share one cwd.
  const worktree = join(directory, "workspace");
  const put = (name: string, cwd: string, startSeconds: number) =>
    writeSessionFile(
      sessions,
      `${name}.jsonl`,
      transcriptText("omp", { cwd, start: at(startSeconds), tag: name }),
    );
  put("lead", worktree, 30); // starts before the first step, still written now: the run lead
  put("worker-a", worktree, 150); // starts inside the window of step-a
  put("worker-b", worktree, 750); // starts inside the window of step-b
  put("gap", worktree, 650); // starts between the two windows: in no window
  put("elsewhere", join(directory, "..", "elsewhere"), 150); // cwd outside the run folder
  installFakeTools({ orca: orcaAnswersFor(run) });
  const { baseUrl } = await start();

  const detail = await detailWithSessions(baseUrl, run, 4);
  const ownerOf = Object.fromEntries(
    detail.sessions.map((session) => [
      session.file.split("/").at(-1)!.replace(".jsonl", ""),
      session.owner,
    ]),
  );
  expect(ownerOf).toEqual({
    lead: { kind: "lead" },
    "worker-a": { kind: "step", step: "step-a" },
    "worker-b": { kind: "step", step: "step-b" },
    gap: { kind: "unassigned" },
  });
  // Whole files: each file has exactly one owner, and the lead's file spans both windows.
  const lead = detail.sessions.find((session) => session.owner.kind === "lead")!;
  expect(Date.parse(lead.start!)).toBeLessThan(started.getTime() + 100_000);
  expect(Date.parse(lead.end)).toBeGreaterThan(started.getTime() + 1_200_000);
  expect(detail.sessions.map((session) => session.file)).toHaveLength(
    new Set(detail.sessions.map((session) => session.file)).size,
  );
});

// The current start path records step.started after the worker launched, so a worker file starts before its step.
test.each([
  ["A: no other file", false],
  ["B: an earlier unrecorded file", true],
])(
  "ARK-T309 a worker file recorded by worker.started that starts before the first step goes to its step, never to the run lead (%s)",
  async (variant, withLead) => {
    const { sessions } = isolatedEnvironment();
    const run = `${today()}-ARK-81${withLead ? 1 : 0}-1`;
    const started = new Date(Date.now() - 3_600_000);
    const at = (seconds: number) => new Date(started.getTime() + seconds * 1000);
    const directory = writeRun({
      project: "p",
      run,
      ticket: { id: "ARK-810", title: variant },
      phase: "building",
      startedAt: started,
      steps: [
        {
          id: "build",
          role: "implementer",
          harness: "omp",
          model: "m",
          needs: [],
          startedAfter: 100,
          finishedAfter: 150,
        },
      ],
    });
    const worktree = join(directory, "workspace");
    const put = (name: string, startSeconds: number) =>
      writeSessionFile(
        sessions,
        `${name}.jsonl`,
        transcriptText("omp", { cwd: worktree, start: at(startSeconds), tag: name }),
      );
    const worker = put("worker", 90);
    if (withLead) put("lead", 50);
    appendRawEvent(
      directory,
      "worker.started",
      { step: "build", dispatch: "ctx_1", terminal: "term_1", harness: "omp", session: worker },
      5000,
    );
    installFakeTools({ orca: orcaAnswersFor(run) });
    const { baseUrl } = await start();

    const detail = await detailWithSessions(baseUrl, run, withLead ? 2 : 1);
    const ownerOf = Object.fromEntries(
      detail.sessions.map((session) => [
        session.file.split("/").at(-1)!.replace(".jsonl", ""),
        session.owner,
      ]),
    );
    expect(ownerOf).toEqual({
      worker: { kind: "step", step: "build" },
      ...(withLead ? { lead: { kind: "lead" } } : {}),
    });
  },
);

test("ARK-T75 a run in the older event form (no worker.started, or session unknown) maps each file by the start window of its step", async () => {
  const { sessions } = isolatedEnvironment();
  const run = `${today()}-ARK-812-1`;
  const started = new Date(Date.now() - 3_600_000);
  const at = (seconds: number) => new Date(started.getTime() + seconds * 1000);
  const step = (id: string, needs: string[], startedAfter: number, finishedAfter: number) => ({
    id,
    role: "implementer",
    harness: "omp",
    model: "m",
    needs,
    startedAfter,
    finishedAfter,
  });
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-812", title: "Older event form" },
    phase: "building",
    startedAt: started,
    steps: [step("step-a", [], 100, 600), step("step-b", ["step-a"], 700, 1200)],
  });
  // step-a has no worker.started; step-b has one whose session is unknown.
  appendRawEvent(
    directory,
    "worker.started",
    { step: "step-b", dispatch: "ctx_1", terminal: "term_1", harness: "omp", session: "unknown" },
    5000,
  );
  const worktree = join(directory, "workspace");
  const put = (name: string, startSeconds: number) =>
    writeSessionFile(
      sessions,
      `${name}.jsonl`,
      transcriptText("omp", { cwd: worktree, start: at(startSeconds), tag: name }),
    );
  put("lead", 30);
  put("worker-a", 150);
  put("worker-b", 750);
  put("gap", 650);
  installFakeTools({ orca: orcaAnswersFor(run) });
  const { baseUrl } = await start();

  const detail = await detailWithSessions(baseUrl, run, 4);
  expect(
    Object.fromEntries(
      detail.sessions.map((session) => [
        session.file.split("/").at(-1)!.replace(".jsonl", ""),
        session.owner,
      ]),
    ),
  ).toEqual({
    lead: { kind: "lead" },
    "worker-a": { kind: "step", step: "step-a" },
    "worker-b": { kind: "step", step: "step-b" },
    gap: { kind: "unassigned" },
  });
});

test("ARK-T75 sessionsOf and modelsOf give the run lead, steps, rework rounds, gaps and stage sessions the same owners", async () => {
  const { sessions } = isolatedEnvironment();
  const directory = writeRun({
    project: "p",
    run: `${today()}-ARK-809-1`,
    ticket: { id: "ARK-809", title: "Owners of session files" },
    phase: "building",
  });
  const worktree = join(directory, "workspace");
  const started = Date.now() - 3_600_000;
  const at = (seconds: number) => new Date(started + seconds * 1000);
  // step-a runs twice (a rework round); step-b between the rounds.
  const windows = [
    {
      id: "step-a",
      role: "implementer",
      repo: ".",
      start: at(100).getTime(),
      end: at(600).getTime(),
    },
    {
      id: "step-b",
      role: "reviewer",
      repo: ".",
      start: at(700).getTime(),
      end: at(1200).getTime(),
    },
    {
      id: "step-a",
      role: "implementer",
      repo: ".",
      start: at(1300).getTime(),
      end: at(1800).getTime(),
    },
  ];
  // The evaluator ends at 50 s; the Designer works from 50 s to 90 s.
  const stages = {
    evaluationEnd: at(50).getTime(),
    designStart: at(50).getTime(),
    designEnd: at(90).getTime(),
  };
  const put = (name: string, startSeconds: number, replySeconds: number) =>
    writeOmpSession(
      sessions,
      name,
      worktree,
      [{ time: at(replySeconds), costUsd: 0.01, model: `model-${name}` }],
      at(startSeconds),
    );
  put("evaluator", 10, 20); // starts first, before the first step: never the run lead
  put("designer", 60, 70);
  put("lead", 30, 1500);
  put("worker-a1", 150, 200);
  put("gap-1", 650, 660);
  put("worker-b", 750, 800);
  put("gap-2", 1250, 1260);
  put("worker-a2", 1350, 1400);

  const index = new UsageIndex();
  indexes.push(index);
  await index.refresh([directory]);
  const ownerOf = Object.fromEntries(
    index
      .sessionsOf(directory, windows, started, stages)
      .map((session) => [session.file.split("/").at(-1)!.replace(".jsonl", ""), session.owner]),
  );
  expect(ownerOf).toEqual({
    evaluator: { kind: "unassigned" },
    designer: { kind: "unassigned" },
    lead: { kind: "lead" },
    "worker-a1": { kind: "step", step: "step-a" },
    "gap-1": { kind: "unassigned" },
    "worker-b": { kind: "step", step: "step-b" },
    "gap-2": { kind: "unassigned" },
    "worker-a2": { kind: "step", step: "step-a" },
  });
  expect(Object.fromEntries(index.modelsOf(directory, windows, started, stages))).toEqual({
    evaluator: "model-evaluator",
    designer: "model-designer",
    lead: "model-lead",
    "step-a": "model-worker-a2",
    "step-b": "model-worker-b",
  });
});

/** Writes a session file of about `bytes` bytes: records no transcript shows, then `tail` messages, then one tool call `late` with its result. */
function writeBigSession(file: string, cwd: string, start: Date, bytes: number, tail: number) {
  const descriptor = openSync(file, "w");
  try {
    writeSync(
      descriptor,
      `${JSON.stringify({ type: "session", version: 3, id: "big", timestamp: start.toISOString(), cwd })}\n`,
    );
    const filler = `${JSON.stringify({ type: "model_change", id: "x", model: "x".repeat(1000) })}\n`;
    const chunk = Buffer.from(filler.repeat(1000));
    for (let written = 0; written < bytes; written += chunk.length) writeSync(descriptor, chunk);
    for (let number = 0; number < tail; number++)
      writeSync(
        descriptor,
        `${JSON.stringify({
          type: "message",
          timestamp: new Date(start.getTime() + (number + 1) * 1000).toISOString(),
          message: { role: "user", content: [{ type: "text", text: `tail ${number}` }] },
        })}\n`,
      );
    const at = (second: number) => new Date(start.getTime() + second * 1000).toISOString();
    writeSync(
      descriptor,
      `${JSON.stringify({
        type: "message",
        timestamp: at(tail + 1),
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "late", name: "bash", arguments: { command: "echo" } }],
        },
      })}\n${JSON.stringify({
        type: "message",
        timestamp: at(tail + 2),
        message: {
          role: "toolResult",
          toolCallId: "late",
          isError: false,
          content: [{ type: "text", text: "late result\nsecond line" }],
        },
      })}\n`,
    );
  } finally {
    closeSync(descriptor);
  }
}

const percentile95 = (durations: number[]) =>
  [...durations].sort((left, right) => left - right)[Math.ceil(durations.length * 0.95) - 1];

test("ARK-T277 while the worker thread reads a 200 MB session file and a result read is queued behind it, / and /nope answer with a p95 below 200 ms, and the pages hold 200 entries", async () => {
  const { sessions } = isolatedEnvironment();
  const run = `${today()}-ARK-808-1`;
  const started = new Date(Date.now() - 3_600_000);
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-808", title: "Big session file" },
    phase: "closed",
    startedAt: started,
  });
  // 200 MB of records that make no entry, then 250 messages: the first page has to read it all.
  const file = join(sessions, "big.jsonl");
  writeBigSession(file, join(directory, "workspace"), started, 200 * 1024 * 1024, 250);
  expect(statSync(file).size).toBeGreaterThanOrEqual(200 * 1024 * 1024);
  // 201 tool calls with a 20,000-character argument each: page 1 holds 200 of them, the next page the last.
  const heavy = [
    JSON.stringify({ type: "session", cwd: join(directory, "workspace") }),
    ...Array.from({ length: 201 }, (_, number) =>
      JSON.stringify({
        type: "message",
        timestamp: new Date(started.getTime() + (number + 1) * 1000).toISOString(),
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `h${number}`,
              name: "bash",
              arguments: { command: "x".repeat(20_000) },
            },
          ],
        },
      }),
    ),
  ];
  const heavyFile = writeSessionFile(sessions, "heavy.jsonl", `${heavy.join("\n")}\n`);
  // A 3-repo run in the load: its branches are read by the background reader, never on a request.
  const workspace = scratch("ark-repo-workspace-");
  const branch = "ark/ARK-809-fixture";
  const { bases } = writeRepoWorkspace(workspace, branch, {
    "core-lib": { ahead: 3 },
    service: { ahead: 2 },
    web: { ahead: 0, gitlink: { pin: "vendor/service", sha: submodulePointerSha } },
  });
  writeProject("p", repoProjectConfig(workspace));
  const repoRun = `${today()}-ARK-809-1`;
  writeRun(
    repoRunFixture({
      project: "p",
      run: repoRun,
      ticket: { id: "ARK-809", title: "Three repos" },
      repoCount: 3,
      mode: "building",
      workspace,
      branch,
      bases,
    }),
  );
  installFakeTools({ orca: orcaAnswersFor(run) });
  const { baseUrl } = await start();
  const repos = openRunOf(
    await snapshotWhen(baseUrl, (snapshot) =>
      Array.isArray(snapshot.runs)
        ? snapshot.runs.find((candidate) => candidate.run === repoRun)?.repos?.[0].state === "ahead"
        : false,
    ),
    repoRun,
  ).repos;
  expect(repos?.map((entry) => entry.repo)).toEqual(["core-lib", "service", "web"]);
  try {
    await detailWithSessions(baseUrl, run, 2);

    // A result read of a call at the end of the file joins the queue: the same slot, the same scan.
    const resultRead = fetch(resultUrl(baseUrl, run, file, "late"));
    // Six page reads queue on the one transcript worker: it stays busy while the samples are taken.
    const url = transcriptUrl(baseUrl, run, file, 0);
    let finished = false;
    const reads = Promise.all(
      Array.from({ length: 6 }, async () => (await fetch(url)).json() as Promise<TranscriptPage>),
    ).finally(() => (finished = true));
    const latencies: Record<string, number[]> = { "/": [], "/nope": [] };
    let samplesWhileReading = 0;
    for (let round = 0; round < 200 && !finished; round++) {
      for (const route of ["/", "/nope"]) {
        const requestedAt = performance.now();
        await (await fetch(`${baseUrl}${route}`)).arrayBuffer();
        latencies[route].push(performance.now() - requestedAt);
      }
      if (!finished) samplesWhileReading += 1;
    }
    expect(
      samplesWhileReading,
      "the worker was not busy long enough to sample",
    ).toBeGreaterThanOrEqual(100);
    for (const [route, durations] of Object.entries(latencies))
      expect(percentile95(durations), `p95 of ${route}`).toBeLessThan(200);

    const [first] = await reads;
    const result = await resultRead;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      text: "late result\nsecond line",
      size: 23,
      cut: false,
    });
    expect(first.entries).toHaveLength(200);
    expect(first.entries[0]).toMatchObject({ kind: "message", role: "user", text: "tail 0" });
    expect(first.next).not.toBeNull();
    const second = (await (
      await fetch(transcriptUrl(baseUrl, run, file, first.next!))
    ).json()) as TranscriptPage;
    expect(second.entries).toHaveLength(51);
    expect(second.entries[0]).toMatchObject({ text: "tail 200" });
    expect(second.next).toBeNull();

    const heavyPage = await fetch(transcriptUrl(baseUrl, run, heavyFile, 0));
    const heavyBody = await heavyPage.text();
    const heavyFirst = JSON.parse(heavyBody) as TranscriptPage;
    expect(heavyFirst.entries).toHaveLength(200);
    expect(heavyFirst.next).not.toBeNull();
    // 200 calls of 20,000 characters: 4 MB, and no more than 5 MB.
    expect(heavyBody.length).toBeGreaterThan(4_000_000);
    expect(heavyBody.length).toBeLessThanOrEqual(5_000_000);
    const heavySecond = (await (
      await fetch(transcriptUrl(baseUrl, run, heavyFile, heavyFirst.next!))
    ).json()) as TranscriptPage;
    expect(heavySecond.entries).toHaveLength(1);
    expect(heavySecond.next).toBeNull();
  } finally {
    rmSync(file, { force: true });
  }
}, 120_000);

test("ARK-284-AC7 a transcript request that fails answers 502 or 404, a bad cursor or a foreign file is refused, and the next page still answers", async () => {
  const { sessions } = isolatedEnvironment();
  const run = `${today()}-ARK-809-1`;
  const started = new Date(Date.now() - 3_600_000);
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-809", title: "Failing read" },
    phase: "closed",
    startedAt: started,
  });
  const cwd = join(directory, "workspace");
  const gone = writeSessionFile(
    sessions,
    "gone.jsonl",
    transcriptText("omp", { cwd, start: started, tag: "gone" }),
  );
  const kept = writeSessionFile(
    sessions,
    "kept.jsonl",
    transcriptText("omp", { cwd, start: new Date(started.getTime() + 60_000), tag: "kept" }),
  );
  installFakeTools({ orca: orcaAnswersFor(run) });
  const { baseUrl } = await start();
  await detailWithSessions(baseUrl, run, 2);

  // The file vanishes after the index listed it: the worker's read fails (502) or the next
  // refresh already dropped it (404). Never a 200 and never a hung request.
  rmSync(gone);
  expect([404, 502]).toContain((await fetch(transcriptUrl(baseUrl, run, gone, 0))).status);
  expect((await fetch(transcriptUrl(baseUrl, run, kept, 0))).status).toBe(200);
  expect((await fetch(transcriptUrl(baseUrl, run, kept, "-1"))).status).toBe(400);
  expect((await fetch(transcriptUrl(baseUrl, run, kept, "abc"))).status).toBe(400);
  // A path the index did not list for this run is never read.
  expect((await fetch(transcriptUrl(baseUrl, run, "/etc/passwd", 0))).status).toBe(404);
  expect((await fetch(transcriptUrl(baseUrl, "no-such-run", kept, 0))).status).toBe(404);
});

// ---------------------------------------------------------------- ARK-324

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;
const sessionHarnesses: SessionHarness[] = ["omp", "claude", "codex"];
/** A text of exactly `length` characters that starts with `prefix`. `€` takes 3 bytes, so a byte count and a character count differ. */
const sizedText = (prefix: string, length: number) => prefix + "€".repeat(length - prefix.length);
const cutNote = (count: number) => `… (+${count} characters cut)`;
const firstLineOf = (text: string) =>
  text
    .split("\n")
    .find((line) => line.trim() !== "")!
    .trim();

/** A closed run with one session file of each harness holding `extra` entries, a second run that owns none, and the hub serving them. */
async function longTranscriptRun(ticket: string, extra: ExtraEntry[]) {
  const { sessions } = isolatedEnvironment();
  const run = `${today()}-${ticket}-1`;
  const otherRun = `${today()}-${ticket}-2`;
  const started = new Date(Date.now() - 3_600_000);
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: ticket, title: "Long transcript" },
    phase: "closed",
    startedAt: started,
  });
  writeRun({
    project: "p",
    run: otherRun,
    ticket: { id: ticket, title: "Other run" },
    phase: "closed",
    startedAt: started,
  });
  const roots: Record<SessionHarness, string> = {
    omp: sessions,
    claude: process.env.ARK_CLAUDE_SESSIONS as string,
    codex: process.env.ARK_CODEX_SESSIONS as string,
  };
  const files = {} as Record<SessionHarness, string>;
  sessionHarnesses.forEach((harness, index) => {
    files[harness] = writeSessionFile(
      roots[harness],
      `${harness}.jsonl`,
      transcriptText(harness, {
        cwd: join(directory, "workspace"),
        start: new Date(started.getTime() + (index + 1) * 60_000),
        tag: harness,
        extra,
      }),
    );
  });
  installFakeTools({ orca: orcaAnswersFor(run) });
  const { baseUrl } = await start();
  await detailWithSessions(baseUrl, run, sessionHarnesses.length);
  return { baseUrl, run, otherRun, files };
}

test("ARK-T271 a transcript page of an omp, a Claude and a Codex file sends a tool call's arguments up to 20 KB and message, context and thinking text up to 32 KB, cuts longer text with a count of the cut characters, keeps valid arguments and keeps the result as its first line", async () => {
  const tail = "TAIL-271";
  const long = { command: sizedText("L30:", 30_000) };
  const { baseUrl, run, files } = await longTranscriptRun("ARK-901", [
    { kind: "call", id: "l30", args: long, result: `short result\nsecond line\n${tail}` },
    { kind: "call", id: "l20", args: { command: sizedText("L20:", 20_000) } },
    { kind: "call", id: "l21", args: { command: sizedText("L21:", 20_001) } },
    { kind: "call", args: { command: "noid-command" }, result: "never read" },
    { kind: "user", text: sizedText("U40:", 40_000) },
    { kind: "assistant", text: sizedText("A32:", 32_000) },
    { kind: "assistant", text: sizedText("A33:", 32_001) },
    { kind: "thinking", text: sizedText("T40:", 40_000) },
    { kind: "context", text: sizedText("C40:", 40_000) },
  ]);
  for (const harness of sessionHarnesses) {
    const response = await fetch(transcriptUrl(baseUrl, run, files[harness], 0));
    expect(response.status, harness).toBe(200);
    const body = await response.text();
    // The whole response is valid JSON, and no line after the first of a result is in it.
    const page = JSON.parse(body) as TranscriptPage;
    expect(body, harness).not.toContain(tail);
    const textOf = (prefix: string) => {
      const found = page.entries
        .flatMap((entry) => (entry.kind === "tool" ? [] : [entry.text]))
        .find((text) => text.startsWith(prefix));
      expect(found, `${harness} ${prefix}`).toBeDefined();
      return found as string;
    };
    // Text over 32,000 characters is cut to 32,000, with the real count of the rest.
    expect(textOf("U40:"), harness).toBe(
      sizedText("U40:", 40_000).slice(0, 32_000) + cutNote(8000),
    );
    expect(textOf("T40:"), harness).toBe(
      sizedText("T40:", 40_000).slice(0, 32_000) + cutNote(8000),
    );
    expect(textOf("C40:"), harness).toBe(
      sizedText("C40:", 40_000).slice(0, 32_000) + cutNote(8000),
    );
    expect(textOf("A32:"), harness).toBe(sizedText("A32:", 32_000));
    expect(textOf("A33:"), harness).toBe(sizedText("A33:", 32_001).slice(0, 32_000) + cutNote(1));

    const tools = page.entries.filter((entry): entry is ToolEntry => entry.kind === "tool");
    const call = (id: string) => {
      const found = tools.find((entry) => entry.callId === id);
      expect(found, `${harness} ${id}`).toBeDefined();
      return found as ToolEntry;
    };
    // A cut argument is still valid JSON: the string field holds the cut and its note.
    expect(JSON.parse(call("l30").args).command, harness).toBe(
      sizedText("L30:", 30_000).slice(0, 20_000) + cutNote(10_000),
    );
    // The row summary is the start of the command, parsed from the whole call.
    expect(call("l30").summary.startsWith("L30:"), harness).toBe(true);
    expect(call("l30").summary.length, harness).toBeLessThanOrEqual(400);
    expect(JSON.parse(call("l20").args).command, harness).toBe(sizedText("L20:", 20_000));
    expect(JSON.parse(call("l21").args).command, harness).toBe(
      sizedText("L21:", 20_001).slice(0, 20_000) + cutNote(1),
    );
    // The result stays its first line.
    expect(call("l30").result, harness).toBe("short result");
    // A record with no string id gives an entry with no call id.
    const noId = tools.find((entry) => entry.summary === "noid-command");
    expect(noId, harness).toBeDefined();
    expect(noId && "callId" in noId, harness).toBe(false);
  }
});

test("ARK-T272 the transcript result route answers the full text of one tool result up to 64 KB with its size and whether it was cut, from the worker thread, and answers 404 for an unknown call, a call with no result yet and a file outside the run", async () => {
  const tail = "TAIL-272";
  const texts = {
    ok: `first line\nsecond line\n${tail}`,
    json: JSON.stringify({ alpha: 1, beta: [1, 2, 3] }, null, 2),
    failed: `boom\n${tail}`,
    plain: "plain first\nplain second",
  };
  const sizes = {
    r64: sizedText("R64:", 64_000),
    r65: sizedText("R65:", 64_001),
    r100: sizedText("R100:", 100_000),
  };
  const { baseUrl, run, otherRun, files } = await longTranscriptRun("ARK-902", [
    { kind: "call", id: "ok", args: { command: "a" }, result: texts.ok },
    { kind: "call", id: "json", args: { command: "b" }, result: texts.json },
    { kind: "call", id: "failed", args: { command: "c" }, result: texts.failed, failed: true },
    {
      kind: "call",
      id: "plain",
      args: { command: "d" },
      result: texts.plain,
      codexOutput: "plain",
    },
    { kind: "call", id: "r64", args: { command: "e" }, result: sizes.r64 },
    { kind: "call", id: "r65", args: { command: "f" }, result: sizes.r65 },
    { kind: "call", id: "r100", args: { command: "g" }, result: sizes.r100 },
    { kind: "call", id: "live", args: { command: "h" } },
  ]);
  for (const harness of sessionHarnesses) {
    const file = files[harness];
    const page = (await (
      await fetch(transcriptUrl(baseUrl, run, file, 0))
    ).json()) as TranscriptPage;
    const tools = page.entries.filter((entry): entry is ToolEntry => entry.kind === "tool");
    // The full text carries what the page cut its first line from, in the shape of each harness.
    for (const [call, text] of Object.entries(texts)) {
      const response = await fetch(resultUrl(baseUrl, run, file, call));
      expect(response.status, `${harness} ${call}`).toBe(200);
      expect(await response.json(), `${harness} ${call}`).toEqual({
        text,
        size: text.length,
        cut: false,
      });
      expect(tools.find((entry) => entry.callId === call)?.result, `${harness} ${call}`).toBe(
        firstLineOf(text),
      );
    }
    expect(tools.find((entry) => entry.callId === "failed")?.status, harness).toBe("error");
    // 64,000 characters are whole; one more, or 100,000, comes cut to 64,000 with the size of the whole.
    for (const [call, full] of Object.entries(sizes)) {
      const answer = (await (await fetch(resultUrl(baseUrl, run, file, call))).json()) as {
        text: string;
        size: number;
        cut: boolean;
      };
      expect(answer.text, `${harness} ${call}`).toBe(full.slice(0, 64_000));
      expect(answer.size, `${harness} ${call}`).toBe(full.length);
      expect(answer.cut, `${harness} ${call}`).toBe(full.length > 64_000);
    }

    const refused: [string, string][] = [
      ["an unknown call", resultUrl(baseUrl, run, file, "nope")],
      ["a call with no result yet", resultUrl(baseUrl, run, file, "live")],
      ["no call", resultUrl(baseUrl, run, file, "")],
      ["a foreign file", resultUrl(baseUrl, run, "/etc/passwd", "ok")],
      ["a path with ..", resultUrl(baseUrl, run, `${file}/../../../../etc/passwd`, "ok")],
      ["a file of another run", resultUrl(baseUrl, otherRun, file, "ok")],
      ["an unknown run", resultUrl(baseUrl, "no-such-run", file, "ok")],
    ];
    for (const [name, url] of refused) {
      const response = await fetch(url);
      expect(response.status, `${harness} ${name}`).toBe(404);
      expect(await response.text(), `${harness} ${name}`).not.toContain("first line");
    }
  }

  // A file that vanishes after the index listed it: the worker's read fails, never a 200; the next result answers.
  rmSync(files.omp);
  expect([404, 502]).toContain((await fetch(resultUrl(baseUrl, run, files.omp, "ok"))).status);
  expect((await fetch(resultUrl(baseUrl, run, files.claude, "ok"))).status).toBe(200);

  // A worker that dies on the request rejects it.
  const stub = join(scratch("ark-result-"), "worker.ts");
  writeFileSync(stub, 'self.onmessage = () => { throw new Error("crash"); };\n');
  const index = new UsageIndex(pathToFileURL(stub));
  indexes.push(index);
  const failure = await index.transcriptResult(files.claude, "claude", "ok").catch((err) => err);
  expect(failure).toBeInstanceOf(Error);
});

// ---------------------------------------------------------------- ARK-285

/** Polls `/api/snapshot` until `ready` holds; fails with the last snapshot after the timeout. */
async function snapshotWhen(
  baseUrl: string,
  ready: (snapshot: Snapshot) => boolean,
  timeoutMilliseconds = 20_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMilliseconds;
  let snapshot: Snapshot;
  do {
    await Bun.sleep(100);
    snapshot = (await (await fetch(`${baseUrl}/api/snapshot`)).json()) as Snapshot;
    if (ready(snapshot)) return snapshot;
  } while (Date.now() < deadline);
  throw new Error(`the snapshot never reached the state: ${JSON.stringify(snapshot)}`);
}

const openRunOf = (snapshot: Snapshot, run: string): RunView => {
  if (snapshot.runs === "unknown") throw new Error("runs are unknown");
  const found = snapshot.runs.find((candidate) => candidate.run === run);
  if (!found) throw new Error(`no open run ${run}`);
  return found;
};

test("ARK-T125 the provider-limits interval is the value of ARK_HUB_INTERVAL_MS, ARK_PROVIDER_LIMITS_MS wins over it, and 60 s when both are unset", async () => {
  const intervalWith = async (
    variables: Record<string, string | undefined>,
    tag: string,
  ): Promise<Record<string, number>> => {
    const names = ["ARK_HUB_INTERVAL_MS", "ARK_PROVIDER_LIMITS_MS"];
    const saved = names.map((name) => process.env[name]);
    for (const name of names) {
      if (variables[name] === undefined) delete process.env[name];
      else process.env[name] = variables[name];
    }
    try {
      // The variables are read when the module loads: a fresh load per value is the boundary under test.
      const loaded = await import(`../hub/snapshot.ts?interval=${tag}`);
      return loaded.intervalMilliseconds as Record<string, number>;
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
    }
  };
  const all = await intervalWith({ ARK_HUB_INTERVAL_MS: "100" }, "all");
  expect(Object.values(all).every((milliseconds) => milliseconds === 100)).toBe(true);
  expect(
    (await intervalWith({ ARK_HUB_INTERVAL_MS: "100", ARK_PROVIDER_LIMITS_MS: "500" }, "own"))
      .providerLimits,
  ).toBe(500);
  expect((await intervalWith({ ARK_PROVIDER_LIMITS_MS: "500" }, "limits")).providerLimits).toBe(
    500,
  );
  expect((await intervalWith({}, "unset")).providerLimits).toBe(60_000);
});

test("ARK-T125 ARK-285-AC2 omp usage is read in the background at the interval of ARK_PROVIDER_LIMITS_MS for each provider and window, and a failed read keeps the last value with its age", async () => {
  isolatedEnvironment();
  const resetsAt = Date.now() + 3_600_000;
  const fetchedAt = Date.now() - 5000;
  const limit = (id: string, usedFraction: number) => ({
    window: { id, resetsAt: resetsAt + (id === "7d" ? 86_400_000 : 0) },
    amount: { usedFraction },
  });
  const state = installFakeTools({
    ompMode: "once",
    ompUsage: {
      reports: [
        {
          provider: "anthropic",
          fetchedAt,
          // Two limits of the 7d window: the fuller one counts. A 1h window is not shown.
          limits: [limit("5h", 0.25), limit("7d", 0.4), limit("7d", 0.6), limit("1h", 0.9)],
        },
        { provider: "openai-codex", fetchedAt, limits: [limit("5h", 0)] },
      ],
    },
  });
  process.env.ARK_PROVIDER_LIMITS_MS = "500";
  const { baseUrl } = await start();
  delete process.env.ARK_PROVIDER_LIMITS_MS; // the hub holds its own copy

  const first = await snapshotWhen(
    baseUrl,
    (snapshot) => snapshot.provider_limits !== "unknown" && snapshot.sources.providerLimits.ok,
  );
  const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
  expect(first.provider_limits).toEqual([
    {
      provider: "anthropic",
      window: "5h",
      used_fraction: 0.25,
      resets_at: iso(resetsAt),
      fetched_at: iso(fetchedAt),
    },
    {
      provider: "anthropic",
      window: "7d",
      used_fraction: 0.6,
      resets_at: iso(resetsAt + 86_400_000),
      fetched_at: iso(fetchedAt),
    },
    {
      provider: "openai-codex",
      window: "5h",
      used_fraction: 0,
      resets_at: iso(resetsAt),
      fetched_at: iso(fetchedAt),
    },
  ]);

  // The second read happens one interval (ARK_PROVIDER_LIMITS_MS) after the first, and the fake exits 1 then:
  // the failed read in a snapshot is the event, so the test waits on it and on nothing else.
  const failed = await snapshotWhen(baseUrl, (snapshot) => !snapshot.sources.providerLimits.ok);
  expect(Number(readFileSync(join(state, "omp.count"), "utf8"))).toBeGreaterThanOrEqual(2);
  expect(failed.provider_limits).toEqual(first.provider_limits);
  expect(failed.sources.providerLimits.read_at).toBe(first.sources.providerLimits.read_at);
}, 60_000);

test("ARK-285-AC3 each agent is waiting on a prompt, idle N min, working or unknown from orca worktree ps, and a failed read gives unknown and then keeps the last value", async () => {
  isolatedEnvironment();
  const run = `${today()}-ARK-815-1`;
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-815", title: "Stuck agents" },
    phase: "building",
  });
  const stepTasks = {
    prompt: "prompt (implementer, .)", // agentWait present
    blocked: "blocked (validator, .)", // state waiting
    quiet: "quiet (implementer, .)", // working, no update for 10 min
    waiter: "waiter (implementer, .)", // working in `wait`, no update for 20 min
    ghost: "ghost (validator, .)", // in the worker list, not in worktree ps
  };
  const minutesAgo = (minutes: number, extraSeconds = 0) =>
    Date.now() - minutes * 60_000 - extraSeconds * 1000;
  const orca = {
    terminals: [
      { handle: "term-lead", connected: true, agentIdentity: "omp" },
      ...Object.keys(stepTasks).map((name) => ({
        handle: `term-${name}`,
        connected: true,
        agentIdentity: "omp",
      })),
    ],
    runs: [{ id: `orca-${run}`, objective: `Ark run ${run}`, coordinator_handle: "term-lead" }],
    workers: Object.keys(stepTasks).map((name) => ({
      taskId: `task-${name}`,
      state: "running",
      agentTerminalHandle: `term-${name}`,
    })),
    tasks: Object.entries(stepTasks).map(([name, title]) => ({ id: `task-${name}`, title })),
    worktrees: [
      {
        path: join(directory, "workspace"),
        agents: [
          {
            taskTitle: "ARK-815 run lead",
            state: "working",
            toolName: "bash",
            updatedAt: Date.now(),
          },
          {
            taskTitle: stepTasks.prompt,
            state: "working",
            toolName: "bash",
            updatedAt: Date.now(),
            agentWait: { reason: "approval", source: "hook" },
            lastAssistantMessage: "Run it?\n\nbun test test/hub.test.ts\n",
          },
          {
            taskTitle: stepTasks.blocked,
            state: "blocked",
            toolName: "bash",
            updatedAt: Date.now(),
          },
          {
            taskTitle: stepTasks.quiet,
            state: "working",
            toolName: "bash",
            updatedAt: minutesAgo(10, 5),
            lastOutputAt: null,
          },
          {
            taskTitle: stepTasks.waiter,
            state: "working",
            toolName: "wait",
            updatedAt: minutesAgo(20),
            lastOutputAt: minutesAgo(20),
          },
          // An agent that only `ps` lists: added as running, with its own activity.
          { taskTitle: "extra (implementer, .)", state: "working", updatedAt: Date.now() },
        ],
      },
      // A worktree outside runs/<run>/workspace is not a run's.
      {
        path: join(directory, "elsewhere"),
        agents: [{ taskTitle: "stray (implementer, .)", state: "waiting" }],
      },
    ],
  };
  const state = installFakeTools({ orca, orcaPsFails: true });
  const { baseUrl } = await start();
  const textOf = (snapshot: Snapshot) => {
    const agents = openRunOf(snapshot, run).agents;
    if (agents === "unknown") throw new Error("agents are unknown");
    return Object.fromEntries(
      agents.map((agent) => [agent.step ?? agent.role, agent.activity.text]),
    );
  };

  // `ps` has never answered: nothing is guessed.
  const unknown = await snapshotWhen(
    baseUrl,
    (snapshot) => snapshot.sources.orca.ok && snapshot.runs !== "unknown",
  );
  expect(unknown.sources.agentWait).toEqual({ ok: false, read_at: null });
  expect(Object.values(textOf(unknown)).every((text) => text === "unknown")).toBe(true);

  writeFakeToolState(state, { orca, orcaPsFails: false });
  const answered = await snapshotWhen(baseUrl, (snapshot) => snapshot.sources.agentWait.ok);
  expect(textOf(answered)).toEqual({
    "run lead": "working",
    prompt: "waiting on a prompt",
    blocked: "waiting on a prompt",
    quiet: "idle 10 min",
    waiter: "working",
    ghost: "unknown",
    extra: "working",
  });
  const agents = openRunOf(answered, run).agents;
  if (agents === "unknown") throw new Error("agents are unknown");
  const extra = agents.find((agent) => agent.step === "extra");
  expect(extra).toMatchObject({ presence: "running", terminal: null });
  expect(agents.find((agent) => agent.step === "prompt")?.activity.last_line).toBe(
    "bun test test/hub.test.ts",
  );

  // A later failed read keeps the last answer and its age.
  writeFakeToolState(state, { orca, orcaPsFails: true });
  const stale = await snapshotWhen(baseUrl, (snapshot) => !snapshot.sources.agentWait.ok);
  expect(textOf(stale)).toEqual(textOf(answered));
  expect(stale.sources.agentWait.read_at).not.toBeNull();
}, 60_000);

test("ARK-285-AC4 an open MR gets its AC status and only its own testcases with file, line and result, and a run not in merge_requests_open gets none", async () => {
  isolatedEnvironment();
  const mergeRequest = "https://github.com/example/repo/pull/81";
  const runOf = (ticket: string) => `${today()}-${ticket}-1`;
  const steps = [
    { id: "impl", role: "implementer", harness: "omp", model: "m", needs: [] as string[] },
    { id: "review", role: "reviewer", harness: "omp", model: "m", needs: ["impl"] },
  ];
  const open = runOf("ARK-816");
  const openDirectory = writeRun({
    project: "p",
    run: open,
    ticket: { id: "ARK-816", title: "Open MR" },
    phase: "merge_requests_open",
    criteria: ["ARK-816-AC1", "ARK-816-AC2", "ARK-816-AC3"],
    steps,
    mergeRequests: [{ repo: ".", url: mergeRequest, number: 81 }],
  });
  const seq = readFileSync(join(openDirectory, "events.ndjson"), "utf8").trim().split("\n").length;
  appendRawEvent(
    openDirectory,
    "test.completed",
    {
      passed: false,
      heads: {},
      criteria: { "ARK-816-AC1": "passing", "ARK-816-AC2": "failing", "ARK-816-AC3": "missing" },
    },
    seq + 1,
  );
  // The report holds 2 tickets. AC1 has two cases; AC10 must not count for AC1; the name carries `'`.
  const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test">
  <testsuite name="test/a.test.ts" file="test/a.test.ts">
    <testcase name="ARK-816-AC1 lists the runs" classname="" file="test/a.test.ts" line="10" />
    <testcase name="ARK-816-AC1 doesn&apos;t list a closed run" classname="" file="test/a.test.ts" line="22" />
    <testcase name="ARK-816-AC2 refuses a bad token" classname="" file="test/a.test.ts" line="31">
      <failure type="AssertionError">expected 200 to be 401 &gt; here</failure>
    </testcase>
    <testcase name="ARK-816-AC10 another AC" classname="" file="test/a.test.ts" line="40" />
    <testcase name="ARK-999-AC1 other ticket passes" classname="" file="test/b.test.ts" line="5" />
    <testcase name="ARK-999-AC2 other ticket fails" classname="" file="test/b.test.ts" line="9">
      <failure type="AssertionError">no</failure>
    </testcase>
    <testcase name="a helper without an AC id" classname="" file="test/b.test.ts" line="14" />
  </testsuite>
</testsuites>
`;
  mkdirSync(join(openDirectory, "results"), { recursive: true });
  writeFileSync(join(openDirectory, "results", "cli.report"), report);
  mkdirSync(join(openDirectory, "findings"), { recursive: true });
  // The reviewer's file counts; a newer file of another step does not.
  writeFileSync(
    join(openDirectory, "findings", "review.md"),
    "### P1: a\n\n### P2: b\n\n### P2 (accepted): c\n\n### P3: d\n\nA line with ### P1 inside.\n",
  );
  writeFileSync(join(openDirectory, "findings", "round-1.md"), "### P1: x\n### P1: y\n");

  // Same report in a run that is building: no evidence.
  const building = runOf("ARK-817");
  const buildingDirectory = writeRun({
    project: "p",
    run: building,
    ticket: { id: "ARK-817", title: "Building" },
    phase: "building",
    criteria: ["ARK-816-AC1"],
  });
  mkdirSync(join(buildingDirectory, "results"), { recursive: true });
  writeFileSync(join(buildingDirectory, "results", "cli.report"), report);

  installFakeTools({});
  const { baseUrl } = await start();
  const snapshot = await snapshotWhen(
    baseUrl,
    (current) => current.sources.evidence.ok && current.runs !== "unknown",
  );

  const evidence = openRunOf(snapshot, open).evidence;
  expect(evidence?.criteria.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: "ARK-816/AC1", status: "passing" },
    { id: "ARK-816/AC2", status: "failing" },
    { id: "ARK-816/AC3", status: "missing" },
  ]);
  const proof = (id: string) => evidence?.criteria.find((criterion) => criterion.id === id)?.proof;
  expect(proof("ARK-816/AC1")).toEqual([
    { name: "ARK-816-AC1 lists the runs", file: "test/a.test.ts", line: 10, result: "pass" },
    {
      name: "ARK-816-AC1 doesn't list a closed run",
      file: "test/a.test.ts",
      line: 22,
      result: "pass",
    },
  ]);
  expect(proof("ARK-816/AC2")).toEqual([
    { name: "ARK-816-AC2 refuses a bad token", file: "test/a.test.ts", line: 31, result: "fail" },
  ]);
  expect(proof("ARK-816/AC3")).toEqual([]);
  // Testcases of the other ticket are shown nowhere.
  expect(JSON.stringify(snapshot)).not.toContain("ARK-999");

  expect(evidence?.findings).toEqual({
    path: "findings/review.md",
    link: `/api/run/${encodeURIComponent(open)}/file?path=${encodeURIComponent("findings/review.md")}`,
    p1: 1,
    p2: 2,
    p3: 1,
  });
  const file = await fetch(`${baseUrl}${evidence!.findings!.link}`);
  expect(file.status).toBe(200);
  expect(await file.text()).toContain("### P1: a");

  expect(openRunOf(snapshot, building).evidence).toBeNull();
}, 60_000);

test("ARK-285-AC4 one gh pr view call gives the checks, diff size and creation time, and a failing gh gives unknown, not a guess", async () => {
  isolatedEnvironment();
  const passing = "https://github.com/example/repo/pull/82";
  const failingChecks = "https://github.com/example/repo/pull/83";
  const mute = "https://github.com/example/repo/pull/84";
  const createdAt = new Date(Date.now() - 7_200_000).toISOString();
  const ticketOf = (ticket: string, url: string, number: number) =>
    writeRun({
      project: "p",
      run: `${today()}-${ticket}-1`,
      ticket: { id: ticket, title: `MR ${number}` },
      phase: "merge_requests_open",
      mergeRequests: [{ repo: ".", url, number }],
    });
  ticketOf("ARK-818", passing, 82);
  ticketOf("ARK-819", failingChecks, 83);
  ticketOf("ARK-820", mute, 84);
  const state = installFakeTools({
    failingMergeRequestViews: [mute],
    mergeRequestViews: {
      [passing]: {
        state: "OPEN",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "lint",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: "https://ci.example/lint",
          },
          // A StatusContext, and a link that is not http(s): the link is dropped.
          {
            __typename: "StatusContext",
            context: "legacy",
            state: "SUCCESS",
            targetUrl: "javascript:alert(1)",
          },
        ],
        additions: 120,
        deletions: 30,
        changedFiles: 7,
        createdAt,
      },
      [failingChecks]: {
        state: "OPEN",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "lint",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: "https://ci.example/lint",
          },
          {
            __typename: "CheckRun",
            name: "tests",
            status: "IN_PROGRESS",
            conclusion: "",
            detailsUrl: "https://ci.example/tests",
          },
          {
            __typename: "CheckRun",
            name: "e2e",
            status: "COMPLETED",
            conclusion: "TIMED_OUT",
            detailsUrl: "https://ci.example/e2e",
          },
        ],
        additions: 1,
        deletions: 2,
        changedFiles: 3,
        createdAt,
      },
    },
  });
  const { baseUrl } = await start();
  const snapshot = await snapshotWhen(
    baseUrl,
    (current) =>
      current.runs !== "unknown" &&
      current.runs
        .flatMap((run) => run.merge_requests)
        .every((request) => request.url === mute || request.state !== "unknown") &&
      current.runs.length === 3,
  );
  const requestOf = (url: string) =>
    (snapshot.runs as RunView[])
      .flatMap((run) => run.merge_requests)
      .find((request) => request.url === url)!;

  expect(requestOf(passing)).toMatchObject({
    state: "open",
    ci: "passing",
    additions: 120,
    deletions: 30,
    changed_files: 7,
    created_at: createdAt,
    checks: [
      { name: "lint", url: "https://ci.example/lint", result: "pass" },
      { name: "legacy", url: null, result: "pass" },
    ],
  });
  expect(requestOf(failingChecks)).toMatchObject({
    ci: "failing",
    checks: [
      { name: "lint", result: "pass" },
      { name: "tests", result: "pending" },
      { name: "e2e", url: "https://ci.example/e2e", result: "fail" },
    ],
  });
  // The failing gh: nothing is made up.
  expect(requestOf(mute)).toMatchObject({
    state: "unknown",
    ci: "unknown",
    checks: [],
    additions: null,
    deletions: null,
    changed_files: null,
    created_at: null,
  });
  expect(snapshot.sources.github.ok).toBe(false);

  // One `gh pr view --json` call for each MR and read, and no `pr checks`.
  const calls = readFileSync(join(state, "gh.log"), "utf8").trim().split("\n");
  for (const call of calls) {
    expect(call).toStartWith("pr view ");
    expect(call).toEndWith(
      "--json state,statusCheckRollup,additions,deletions,changedFiles,createdAt",
    );
  }
}, 60_000);

test("ARK-285-AC6 the median and p90 of step time by role come from the finished steps of closed runs, next to the time in the current step", async () => {
  isolatedEnvironment();
  const closedRun = (ticket: string, implementer: number, reviewer: number) =>
    writeRun({
      project: "p",
      run: `${today()}-${ticket}-1`,
      ticket: { id: ticket, title: `Closed ${ticket}` },
      phase: "closed",
      steps: [
        {
          id: "build",
          role: "implementer",
          harness: "omp",
          model: "m",
          needs: [],
          startedAfter: 40,
          finishedAfter: 40 + implementer,
        },
        {
          id: "check",
          role: "reviewer",
          harness: "omp",
          model: "m",
          needs: ["build"],
          startedAfter: 1000,
          finishedAfter: 1000 + reviewer,
        },
        // A step that never started has no time.
        { id: "later", role: "reviewer", harness: "omp", model: "m", needs: ["check"] },
      ],
    });
  // Implementer: 100, 200, 600 s: median 200, p90 600 (nearest rank). Reviewer: 60, 60, 120.
  closedRun("ARK-821", 100, 60);
  closedRun("ARK-822", 200, 60);
  closedRun("ARK-823", 600, 120);

  // An open run: one step done, one running for 6 min, one pending; round 1 of 3.
  const open = `${today()}-ARK-824-1`;
  const startedAt = new Date(Date.now() - 3_600_000);
  writeRun({
    project: "p",
    run: open,
    ticket: { id: "ARK-824", title: "Open" },
    phase: "building",
    startedAt,
    steps: [
      {
        id: "plan-tests",
        role: "validator",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 40,
        finishedAfter: 100,
      },
      {
        id: "build",
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 3600 - 361,
      },
      { id: "check", role: "reviewer", harness: "omp", model: "m", needs: ["build"] },
    ],
  });
  installFakeTools({});
  const { baseUrl } = await start();
  const snapshot = await snapshotWhen(baseUrl, (current) => current.runs !== "unknown");

  expect(snapshot.role_times).toEqual({
    implementer: { median: 200, p90: 600, count: 3 },
    reviewer: { median: 60, p90: 120, count: 3 },
  });
  const { progress } = openRunOf(snapshot, open);
  expect(progress).toMatchObject({ steps_done: 1, steps_total: 3, round: 1, round_budget: 3 });
  expect(progress?.current).toMatchObject({
    step: "build",
    role: "implementer",
    typical_seconds: 200,
    slow_above_seconds: 600,
  });
  const elapsed = (Date.now() - Date.parse(progress!.current!.started_at)) / 1000;
  expect(stepTimeText("implementer", elapsed, snapshot.role_times.implementer)).toBe(
    "implementer 6 min · typical 3 · slow above 10",
  );
  // No role with a closed run behind it: the time stands alone, and no ETA is ever sent.
  expect(stepTimeText("validator", 90, snapshot.role_times.validator)).toBe("validator 2 min");
  expect(JSON.stringify(snapshot)).not.toMatch(/\beta\b/i);
}, 60_000);

test("ARK-285-AC2 an omp that never answers leaves usage unknown, not a guess, and the hub keeps serving", async () => {
  isolatedEnvironment();
  installFakeTools({ ompMode: "down" });
  const { baseUrl } = await start();
  const snapshot = await snapshotWhen(
    baseUrl,
    (current) => current.sources.orca.ok && current.sources.github.ok,
  );
  expect(snapshot.provider_limits).toBe("unknown");
  expect(snapshot.sources.providerLimits.ok).toBe(false);
  expect(snapshot.sources.providerLimits.read_at).toBeNull();
  expect((await fetch(`${baseUrl}/`)).status).toBe(200);
}, 60_000);

test("ARK-285-AC11 with every new reader running and an open MR with a 17000-case report, / and /nope answer with a p95 below 200 ms", async () => {
  isolatedEnvironment();
  const mergeRequest = "https://github.com/example/repo/pull/85";
  const run = `${today()}-ARK-830-1`;
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-830", title: "Big report" },
    phase: "merge_requests_open",
    criteria: ["ARK-830-AC1"],
    mergeRequests: [{ repo: ".", url: mergeRequest, number: 85 }],
  });
  const cases = Array.from(
    { length: 17_000 },
    (_, index) =>
      `<testcase name="${index % 50 === 0 ? "ARK-830-AC1 " : "other "}${index}" file="test/a.test.ts" line="${index}" />`,
  );
  mkdirSync(join(directory, "results"), { recursive: true });
  writeFileSync(
    join(directory, "results", "cli.report"),
    `<?xml version="1.0"?>\n<testsuites><testsuite name="a">\n${cases.join("\n")}\n</testsuite></testsuites>\n`,
  );
  installFakeTools({
    orca: orcaAnswersFor(run),
    ompUsage: {
      reports: [
        {
          provider: "anthropic",
          fetchedAt: Date.now(),
          limits: [
            {
              window: { id: "5h", resetsAt: Date.now() + 3_600_000 },
              amount: { usedFraction: 0.8 },
            },
          ],
        },
      ],
    },
  });
  const { baseUrl } = await start();
  const sample = async () => {
    const latencies: Record<string, number[]> = { "/": [], "/nope": [] };
    for (let round = 0; round < 100; round++)
      for (const route of ["/", "/nope"]) {
        const requestedAt = performance.now();
        await (await fetch(`${baseUrl}${route}`)).arrayBuffer();
        latencies[route].push(performance.now() - requestedAt);
      }
    for (const [route, durations] of Object.entries(latencies))
      expect(percentile95(durations), `p95 of ${route}`).toBeLessThan(200);
  };
  await sample(); // while the readers make their first pass
  const snapshot = await snapshotWhen(
    baseUrl,
    (current) =>
      current.sources.evidence.ok &&
      current.sources.providerLimits.ok &&
      current.sources.agentWait.ok &&
      current.sources.github.ok,
  );
  expect(openRunOf(snapshot, run).evidence?.criteria[0].proof.length).toBe(340);
  await sample(); // with every reader answered and cached
}, 120_000);

test("ARK-285-AC3 after one good Orca read, a failing read keeps a stale waiting agent and still reports a quiet run as idle 60 min", () => {
  const minutes = 60;
  const run = {
    run: "r",
    updated_at: "then",
    waiting: [],
    plan: [{ id: "build", status: "running" }],
    agents: [{ step: "build", activity: { kind: "working", text: "working", last_line: null } }],
  };
  const snapshotOf = (ok: boolean, agents: unknown[]): Snapshot =>
    ({
      runs: [{ ...run, agents }],
      sources: { agentWait: { ok, read_at: "earlier" } },
    }) as unknown as Snapshot;
  const age = () => minutes * 60_000;
  const stuck = (snapshot: Snapshot) => stuckAgents(snapshot, age).map((item) => item.text);

  expect(stuck(snapshotOf(false, run.agents))).toEqual(["idle 60\u00a0min"]);
  expect(stuck(snapshotOf(true, run.agents))).toEqual([]);
  const waiting = [{ step: "build", activity: { kind: "waiting", text: "waiting on a prompt" } }];
  expect(stuck(snapshotOf(false, waiting))).toEqual(["waiting on a prompt"]);
});

test("ARK-T25 ticket text and criteria are read from the ticket's own file and served by /api/ticket/<project>/<id>, never in the snapshot, and a front-matter id with ../ reads nothing outside", async () => {
  isolatedEnvironment();
  const home = process.env.ARK_HOME as string;
  writeBacklogTicket({
    project: "p",
    id: "ARK-840",
    title: "Readable",
    status: "ready",
    problem: "Why it hurts",
    change: "What changes",
    criteria: [{ id: "ARK-840-AC1", text: "It works" }],
  });
  writeFileSync(join(home, "outside.md"), "## Problem\n\nOUTSIDE TICKET DIRECTORY\n");
  writeFileSync(
    join(home, "projects", "p", "tickets", "ARK-841.md"),
    '---\nid: ../../../outside\ntitle: "Planted"\n---\n## Problem\n\nOwn text\n',
  );
  const { baseUrl } = await start();
  const snapshot = await snapshotWhen(
    baseUrl,
    (current) => current.tickets !== "unknown" && current.tickets.length === 2,
  );
  if (snapshot.tickets === "unknown") throw new Error("tickets are unknown");
  const documentOf = async (id: string) =>
    ((await (await fetch(`${baseUrl}/api/ticket/p/${id}`)).json()) as { document: unknown })
      .document;
  expect(await documentOf("ARK-840")).toEqual({
    problem: "Why it hurts",
    change: "What changes",
    evidence: "",
    criteria: [{ id: "AC1", text: "It works", method: "test", verified_by: [] }],
  });
  expect(((await documentOf("..%2F..%2F..%2Foutside")) as { problem: string }).problem).toBe(
    "Own text",
  );
  expect(JSON.stringify(snapshot)).not.toContain("OUTSIDE TICKET DIRECTORY");
  for (const id of ["ARK-840", "..%2F..%2F..%2Foutside"])
    expect(await (await fetch(`${baseUrl}/api/ticket/p/${id}`)).text()).not.toContain(
      "OUTSIDE TICKET DIRECTORY",
    );
});

type PushedTicket = Record<string, unknown> & { id: string; signature: string };

/** The body of ARK-T76 and ARK-T130: `late` stops the hub while the test subscribes and while it edits, and the test releases it. */
async function slimTicketsAreDelivered(late: boolean) {
  isolatedEnvironment();
  installFakeTools({});
  const filler = "A sentence of ticket text that only the ticket page needs to read. ".repeat(40);
  let ticketBytes = 0;
  const writeTickets = () => {
    write(1, `A reason. DOC-MARKER-XYZ ${filler}`);
    for (let index = 2; index <= 200; index++) write(index, `A reason. ${filler}`);
    expect(ticketBytes).toBeGreaterThan(200 * 2800);
  };
  const write = (index: number, problem: string) => {
    const id = `ARK-${index}`;
    ticketBytes += statSync(
      writeBacklogTicket({
        project: "p",
        id,
        title: `Ticket ${index}`,
        status: "ready",
        kind: "feature",
        milestone: "M4",
        dependsOn: index > 1 ? ["ARK-1"] : [],
        problem,
        change: "What changes.",
        criteria: [{ id: `${id}-AC1`, text: "It works" }],
      }),
    ).size;
  };
  if (!late) writeTickets();
  // ARK-T130 (late): the hub is stopped before the 200 tickets are written and again across the body edit. Each wait
  // starts on a stopped hub and stays blocked while the test moves its clock past the old 10 s push deadline.
  const hub = await start();
  const { baseUrl } = hub;
  const ticketsOf = (json: string) => (JSON.parse(json) as { tickets: PushedTicket[] }).tickets;
  const pushes = await openPushes(baseUrl);
  const hold = <T>(work: () => Promise<T>): Promise<T> =>
    late ? heldPastTenSeconds(hub, pushes, work) : work();
  let before = "";
  try {
    if (late) await pushes.next(); // the subscription is acknowledged by the hub's first push
    before = await hold(async () => {
      if (late) writeTickets();
      for (;;) {
        const text = await pushes.next();
        const { tickets } = JSON.parse(text) as Snapshot;
        if (tickets !== "unknown" && tickets.length === 200) return text;
      }
    });
    expect(before).not.toContain("DOC-MARKER-XYZ");
    const tickets = ticketsOf(before);
    // Taken before the matchers below, which Bun may write into the object they match.
    const signatures = new Map(tickets.map((ticket) => [ticket.id, ticket.signature]));
    for (const ticket of tickets) {
      expect("document" in ticket).toBe(false);
      expect(ticket).toMatchObject({
        project: "p",
        title: expect.stringMatching(/^Ticket \d+$/),
        status: "ready",
        kind: "feature",
        milestone: "M4",
        depends_on: ticket.id === "ARK-1" ? [] : ["ARK-1"],
        why: "A reason.",
        signature: expect.any(String),
      });
    }
    expect(before.length / ticketBytes).toBeLessThan(0.15);

    // A body-only edit: the front matter stays, so only the signature tells the page.
    const file = join(process.env.ARK_HOME as string, "projects", "p", "tickets", "ARK-1.md");
    const signatureBefore = signatures.get("ARK-1");
    const pushed = await hold(async () => {
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("DOC-MARKER-XYZ", "BODY-EDIT-TEXT and a little more"),
      );
      for (;;) {
        const next = ticketsOf(await pushes.next());
        if (ticketOf(next, "ARK-1").signature !== signatureBefore) return next;
      }
    });
    const after = JSON.stringify(pushed);
    expect(after).not.toContain("BODY-EDIT-TEXT");
    expect(after).not.toContain("DOC-MARKER-XYZ");
    for (const ticket of pushed)
      if (ticket.id !== "ARK-1") expect(ticket.signature).toEqual(signatures.get(ticket.id) ?? "");
  } finally {
    pushes.close();
  }
}

test("ARK-T76 snapshot and push tickets carry no document, keep the fields other pages read, and stay under 15% of the ticket text", () =>
  slimTicketsAreDelivered(false));

test("ARK-T130 ARK-T76 passes when the hub answers late: the 200-ticket snapshot and the push after a body edit end on their events", () =>
  slimTicketsAreDelivered(true));

const ticketOf = (tickets: PushedTicket[], id: string): PushedTicket => {
  const found = tickets.find((ticket) => ticket.id === id);
  if (!found) throw new Error(`no ticket ${id}`);
  return found;
};

test("ARK-T77 ARK-329/AC2 GET /api/ticket/<project>/<id> answers one ticket document read at request time, and an unknown project, an unknown ticket or a path outside the tickets folder answers 404", async () => {
  isolatedEnvironment();
  const home = process.env.ARK_HOME as string;
  const write = (problem: string) =>
    writeBacklogTicket({
      project: "p",
      id: "ARK-840",
      title: "Readable",
      status: "ready",
      problem,
      change: "What changes",
      criteria: [{ id: "ARK-840-AC1", text: "It works", verifiedBy: ["ARK-T1"] }],
    });
  const file = write("Why it hurts");
  writeFileSync(join(home, "outside.md"), "## Problem\n\nOUTSIDE TICKET DIRECTORY\n");
  writeFileSync(join(dirname(file), "ARK-842.md"), "this file has no front matter\n");
  const { baseUrl } = await start();
  await snapshotWhen(
    baseUrl,
    (current) => current.tickets !== "unknown" && current.tickets.length === 2,
  );
  const port = Number(new URL(baseUrl).port);
  // `sendRequest` keeps `..` and `%2e` in the path as written; `fetch` would fold them away.
  const get = (path: string) => sendRequest(port, { path });

  const found = await get("/api/ticket/p/ARK-840");
  expect(found.status).toBe(200);
  expect(JSON.parse(found.text).document).toEqual({
    problem: "Why it hurts",
    change: "What changes",
    evidence: "",
    criteria: [{ id: "AC1", text: "It works", method: "test", verified_by: ["ARK-T1"] }],
  });

  write("Changed text");
  expect(JSON.parse((await get("/api/ticket/p/ARK-840")).text).document.problem).toBe(
    "Changed text",
  );

  for (const path of ["/api/ticket/nope/ARK-840", "/api/ticket/p/ARK-999"])
    expect((await get(path)).status).toBe(404);
  for (const path of [
    "/api/ticket/p/../../outside",
    "/api/ticket/p/..%2F..%2F..%2Foutside",
    "/api/ticket/p/%2e%2e%2f%2e%2e%2foutside",
    "/api/ticket/p/..",
    "/api/ticket/p/..%2F..%2F..%2Foutside.md",
  ]) {
    const answer = await get(path);
    expect(answer.status, path).toBe(404);
    expect(answer.text, path).not.toContain("OUTSIDE TICKET DIRECTORY");
  }

  const cases = await get("/api/ticket/p/ARK-840/cases");
  expect(cases.status).toBe(200);
  expect("document" in JSON.parse(cases.text)).toBe(false);

  const unreadable = await get("/api/ticket/p/ARK-842");
  expect(unreadable.status).toBe(200);
  expect(JSON.parse(unreadable.text)).toEqual({ document: null });

  expect((await get("/api/ticket/p/%E0%A4%A")).status).toBe(400);
  expect((await get("/")).status).toBe(200);
});

// ---------------------------------------------------------------- ARK-314

test("ARK-T23 ticket parser returns method and verified_by with legacy ids", () => {
  isolatedEnvironment();
  const criteria = (rows: NonNullable<Parameters<typeof writeBacklogTicket>[0]["criteria"]>) =>
    parseTicketDocument(
      readFileSync(
        writeBacklogTicket({
          project: "p",
          id: "ARK-900",
          title: "T",
          status: "ready",
          criteria: rows,
        }),
        "utf8",
      ),
    ).criteria;

  const parsed = criteria([
    { id: "ARK-900-AC1", text: "one", method: "inspection", verifiedBy: ["ARK-T1", "ARK-T2"] },
    { id: "AC2", text: "two", manual: true, verifiedBy: [] },
    { id: "AC3", text: "three", verifiedBy: ["ARK-T3"] },
    { id: "ARK-243-AC4", text: "four" },
    { id: "AC5", text: "five", manual: true, method: "analysis" },
  ]);
  expect(parsed.map(({ id, method, verified_by }) => [id, method, verified_by])).toEqual([
    ["AC1", "inspection", ["ARK-T1", "ARK-T2"]],
    ["AC2", "demonstration", []],
    ["AC3", "test", ["ARK-T3"]],
    ["AC4", "test", []],
    ["AC5", "analysis", []],
  ]);
  expect(parsed.map(({ text }) => text)).toEqual(["one", "two", "three", "four", "five"]);

  // One AC written in both forms is listed once.
  const both = criteria([
    { id: "ARK-900-AC1", text: "same", verifiedBy: ["ARK-T1"] },
    { id: "AC1", text: "same", verifiedBy: ["ARK-T1"] },
  ]);
  expect(both.map(({ id }) => id)).toEqual(["AC1"]);
});

test("ARK-T24 hub reads local test cases and zephyr evidence without a Zephyr call", async () => {
  isolatedEnvironment();
  const zephyrRequests: string[] = [];
  const zephyr = Bun.serve({
    port: 0,
    fetch: (request) => (zephyrRequests.push(request.url), new Response("{}")),
  });
  stoppers.push(() => zephyr.stop(true));

  const repository = scratch("ark-cases-");
  const front = (changedBy: string, extra: Record<string, string> = {}) => ({
    title: "ARK-T1 first case",
    level: "integration",
    technique: "boundary values",
    priority: "high",
    risk: "the first defect",
    status: "active",
    changed_by: changedBy,
    ...extra,
  });
  commitCase(repository, "ARK-T1", front("2026-01-01-ARK-1-1"));
  commitCase(repository, "ARK-T1", front("2026-02-02-ARK-2-1"));
  commitCase(
    repository,
    "ARK-T2",
    front("2026-01-01-ARK-1-1", {
      title: "ARK-T2 second case",
      status: "retired",
      retired_reason: "replaced by ARK-T1",
    }),
  );
  writeProject("loc", { workspace: repository, ticket_source: "local", test_case_source: "local" });
  writeProject("zep", {
    workspace: scratch("ark-zephyr-"),
    ticket_source: "local",
    test_case_source: "zephyr",
    zephyr_url: `http://127.0.0.1:${zephyr.port}`,
  });
  for (const project of ["loc", "zep"])
    writeBacklogTicket({
      project,
      id: "ARK-900",
      title: "Cases",
      status: "ready",
      criteria: [{ id: "AC1", text: "one", verifiedBy: ["ARK-T1", "ARK-T2", "ARK-T99"] }],
    });
  const run = `${today()}-ARK-900-1`;
  const directory = writeRun({
    project: "zep",
    run,
    ticket: { id: "ARK-900", title: "Cases" },
    phase: "merge_requests_open",
  });
  const record = (id: string, extra: Record<string, unknown>) => {
    const folder = join(directory, "results", "evidence", id, "head");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "result.json"),
      JSON.stringify({ id, name: `${id} first case`, status: "pass", sha: "9b85039", ...extra }),
    );
  };
  record("ARK-T1", { version: 3 });
  record("ARK-T2", {});
  // Project `run`: main holds ARK-T1 (one version) and ARK-T5; the run checkout holds ARK-T1 changed and ARK-T4 added.
  const main = scratch("ark-main-");
  commitCase(main, "ARK-T1", front("main-1", { title: "ARK-T1 main title" }));
  commitCase(main, "ARK-T5", front("main-only", { title: "ARK-T5 only in main" }));
  writeProject("run", { workspace: main, ticket_source: "local", test_case_source: "local" });
  writeBacklogTicket({
    project: "run",
    id: "ARK-900",
    title: "Cases",
    status: "ready",
    criteria: [{ id: "AC1", text: "one", verifiedBy: ["ARK-T1", "ARK-T4", "ARK-T5"] }],
  });
  const runDirectory = writeRun({
    project: "run",
    run: `${today()}-ARK-900-2`,
    ticket: { id: "ARK-900", title: "Cases" },
    phase: "merge_requests_open",
  });
  const checkout = join(runDirectory, "workspace");
  commitCase(checkout, "ARK-T1", front("2026-02-02-ARK-2-1", { title: "ARK-T1 main title" }));
  commitCase(
    checkout,
    "ARK-T1",
    front("2026-11-06-ARK-900-1", { title: "ARK-T1 changed in the run" }),
  );
  commitCase(
    checkout,
    "ARK-T4",
    front("2026-11-06-ARK-900-1", { title: "ARK-T4 added in the run" }),
  );
  const { baseUrl } = await start();
  await snapshotWhen(
    baseUrl,
    (current) =>
      current.tickets !== "unknown" && current.tickets.length === 3 && current.runs !== "unknown",
  );
  const casesOf = async (project: string): Promise<TicketCases> => {
    const response = await fetch(`${baseUrl}/api/ticket/${project}/ARK-900/cases`);
    expect(response.status).toBe(200);
    return response.json();
  };

  const local = await casesOf("loc");
  expect(local.cases.map(({ id }) => id)).toEqual(["ARK-T1", "ARK-T2", "ARK-T99"]);
  const [first, second, absent] = local.cases;
  expect(first).toMatchObject({
    title: "ARK-T1 first case",
    level: "integration",
    technique: "boundary values",
    priority: "high",
    risk: "the first defect",
    status: "active",
    changed_by: "2026-02-02-ARK-2-1",
  });
  expect(first.versions?.map((version) => version.changed_by)).toEqual([
    "2026-02-02-ARK-2-1",
    "2026-01-01-ARK-1-1",
  ]);
  expect(second).toMatchObject({ status: "retired", reason: "replaced by ARK-T1" });
  expect(absent).toEqual({ id: "ARK-T99", missing: true });

  const zep = await casesOf("zep");
  expect(zep.cases[0]).toMatchObject({
    id: "ARK-T1",
    name: "ARK-T1 first case",
    status: "pass",
    sha: "9b85039",
    version: 3,
  });
  expect(zep.cases[1]).toMatchObject({
    id: "ARK-T2",
    name: "ARK-T2 first case",
    status: "pass",
    sha: "9b85039",
  });
  expect("version" in zep.cases[1]).toBe(false);
  expect(zep.cases[2]).toEqual({ id: "ARK-T99", missing: true });
  expect(zephyrRequests).toEqual([]);

  // A run whose checkout holds an unmerged case and a changed case: the run wins, the workspace fills the rest.
  const changed = await casesOf("run");
  expect(changed.cases.map(({ id }) => id)).toEqual(["ARK-T1", "ARK-T4", "ARK-T5"]);
  const [changedCase, addedCase, mainOnlyCase] = changed.cases;
  expect(changedCase).toMatchObject({
    title: "ARK-T1 changed in the run",
    changed_by: "2026-11-06-ARK-900-1",
  });
  expect(changedCase.versions?.map((version) => version.changed_by)).toEqual([
    "2026-11-06-ARK-900-1",
    "2026-02-02-ARK-2-1",
  ]);
  expect(addedCase).toMatchObject({
    title: "ARK-T4 added in the run",
    status: "active",
    changed_by: "2026-11-06-ARK-900-1",
  });
  expect(addedCase.versions).toHaveLength(1);
  expect(mainOnlyCase).toMatchObject({ title: "ARK-T5 only in main", changed_by: "main-only" });
  expect(mainOnlyCase.versions).toHaveLength(1);
});

// ---------------------------------------------------------------- ARK-298

const ownName = "hub.ark-1.localhost";

/** One HTTP request through `node:http`, which sends exactly the `Host` and headers given (Bun `fetch` may not). */
function sendRequest(
  port: number,
  { method = "GET", path = "/api/snapshot", headers = {}, body }: SendOptions,
): Promise<{ status: number; text: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
  const request = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (response) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => void (text += chunk));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
  });
  request.on("error", reject);
  request.end(body);
  return promise;
}
type SendOptions = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
};

/** A hub in this process on a free port, with or without a name. */
async function serveInProcess(name?: string) {
  isolatedEnvironment();
  const reader = createSnapshotReader();
  const server = await serve(reader, 0, name);
  stoppers.push(async () => {
    reader.stop();
    await server.stop(true);
  });
  return server.port as number;
}
const stoppers: Array<() => Promise<void>> = [];
afterAll(async () => void (await Promise.all(stoppers.map((stop) => stop()))));

/** `bun hub/main.ts --port 0 …` to its exit, for a start that must fail. */
const runHub = (...args: string[]) =>
  spawnSync("bun", [join(root, "hub", "main.ts"), "--port", "0", ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });

test("ARK-298-AC1 a bad --name exits 1 with a message that names --name, and the hub does not start", () => {
  for (const bad of ["Bad_Name.localhost", "example.com", "localhost"]) {
    const result = runHub("--name", bad);
    expect(result.status, bad).toBe(1);
    expect(result.stderr, bad).toContain("--name");
    expect(result.stdout, bad).not.toContain("Ark hub on");
  }
});

test("ARK-298-AC2 GET accepts the hub's own name alone or with port 80, and no other host, port or Origin", async () => {
  const port = await serveInProcess(ownName);
  const get = (host: string, origin?: string) =>
    sendRequest(port, { headers: { Host: host, ...(origin ? { Origin: origin } : {}) } });

  expect((await get(ownName, `http://${ownName}`)).status).toBe(200);
  expect((await get(`${ownName}:80`)).status).toBe(200);
  expect((await get(`127.0.0.1:${port}`)).status).toBe(200);
  expect((await get(`localhost:${port}`)).status).toBe(200);
  for (const host of ["other.localhost", `${ownName}:9999`, "evil.com"])
    expect((await get(host)).status, host).toBe(403);
  expect((await get(ownName, "http://other.localhost")).status).toBe(403);

  // Without a name the same host is foreign.
  const unnamed = await serveInProcess();
  expect((await sendRequest(unnamed, { headers: { Host: ownName } })).status).toBe(403);
  expect(
    (await sendRequest(unnamed, { headers: { Host: ownName, Origin: `http://${ownName}` } }))
      .status,
  ).toBe(403);
});

test("ARK-298-AC3 open-in-orca needs one same authority in Origin and Host, from 127.0.0.1:<port>, the name, or the name with port 80", async () => {
  const port = await serveInProcess(ownName);
  const body = '{"terminal":"x"}';
  const post = (host: string, origin?: string) =>
    sendRequest(port, {
      method: "POST",
      path: "/api/open-in-orca",
      headers: {
        Host: host,
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
        ...(origin ? { Origin: origin } : {}),
      },
      body,
    });
  const own = `127.0.0.1:${port}`;

  // Past the Host check: 400, because the handle is not live.
  for (const authority of [ownName, `${ownName}:80`, own])
    expect((await post(authority, `http://${authority}`)).status, authority).toBe(400);

  const foreign: Array<[string, string | undefined]> = [
    [ownName, undefined],
    [`localhost:${port}`, `http://localhost:${port}`],
    ["other.localhost", "http://other.localhost"],
    [ownName, `http://${own}`],
    [own, `http://${ownName}`],
    [ownName, `http://${ownName}:80`],
    [`${ownName}:9999`, `http://${ownName}:9999`],
  ];
  for (const [host, origin] of foreign) {
    const answer = await post(host, origin);
    expect([answer.status, answer.text], `${host} ${origin}`).toEqual([403, "foreign origin"]);
  }
});

test("ARK-298-AC4 the hub prints its name on line 2, and trusts only Host and Origin", async () => {
  const hub = Bun.spawn(["bun", join(root, "hub", "main.ts"), "--port", "0", "--name", ownName], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  hubs.push(hub);
  let output = "";
  for await (const chunk of hub.stdout) {
    output += new TextDecoder().decode(chunk);
    if (output.split("\n").length > 2) break;
  }
  const [first, second] = output.split("\n");
  expect(first).toMatch(/^Ark hub on http:\/\/127\.0\.0\.1:\d+$/);
  expect(second).toBe(`Ark hub name http://${ownName}`);
  const port = Number(first?.match(/127\.0\.0\.1:(\d+)/)?.[1]);

  expect(
    (
      await sendRequest(port, {
        headers: { Host: `127.0.0.1:${port}`, "X-Forwarded-Host": "evil.localhost" },
      })
    ).status,
  ).toBe(200);
  expect(
    (await sendRequest(port, { headers: { Host: "evil.localhost", "X-Forwarded-Host": ownName } }))
      .status,
  ).toBe(403);
  expect(
    (await sendRequest(port, { headers: { Host: "evil.localhost", Origin: `http://${ownName}` } }))
      .status,
  ).toBe(403);
});

test("ARK-298-AC6 the hub name rule in cli/proxy.ts matches the ticket", () => {
  expect(proxyPort).toBe(80);
  for (const good of ["ark.localhost", "hub.ark-284-1.localhost", `${"a".repeat(63)}.localhost`])
    expect(isHubName(good), good).toBe(true);
  for (const bad of [
    "localhost",
    "Ark.localhost",
    "a_b.localhost",
    "-a.localhost",
    "a-.localhost",
    "a..localhost",
    `${"a".repeat(64)}.localhost`,
    "ark.example.com",
    "ark.localhost\n",
    "ark.localhost:80",
    "",
  ])
    expect(isHubName(bad), JSON.stringify(bad)).toBe(false);
});

// ---------------------------------------------------------------- ARK-291

const projectFolder = (project: string) =>
  join(process.env.ARK_HOME as string, "projects", project);

test("ARK-291-AC2 the snapshot has roadmap per project (the readRoadmap result, an error with its line, or none with the ticket_source) and why per ticket", async () => {
  isolatedEnvironment();
  installFakeTools({});
  // Project `full`: a valid file. ARK-701 has a two-sentence Problem, ARK-702 a Why, ARK-703 neither.
  writeBacklogTicket({
    project: "full",
    id: "ARK-701",
    title: "Ranked",
    status: "ready",
    milestone: "M4",
    problem: "The first sentence. The second sentence.",
  });
  writeFileSync(
    join(projectFolder("full"), "tickets", "ARK-702.md"),
    "---\nid: ARK-702\ntitle: Why only\nstatus: ready\n---\n## Why\n\nBecause it is needed! More words.\n",
  );
  writeFileSync(
    join(projectFolder("full"), "tickets", "ARK-703.md"),
    "---\nid: ARK-703\ntitle: No text\nstatus: ready\n---\n## Change\n\nSomething.\n",
  );
  // Inline code marks and a sub-heading directly under the first sentence never reach `why` or the title.
  writeFileSync(
    join(projectFolder("full"), "tickets", "ARK-704.md"),
    "---\nid: ARK-704\ntitle: Show `ark chief state`\nstatus: ready\n---\n## Problem\n\nRun `ark chief state` first\n### Run leads\nMore words.\n",
  );
  writeRoadmap("full", { vision: "Ship it.", now: ["ARK-701"] });
  // Project `bare`: tickets, no ROADMAP.md, ticket_source jira in ark.yml.
  writeBacklogTicket({ project: "bare", id: "ARK-710", title: "Bare", status: "ready" });
  writeFileSync(join(projectFolder("bare"), "ark.yml"), "ticket_source: jira\n");
  // Project `broken`: a milestone row with an unknown state on line 9 of the file.
  writeBacklogTicket({ project: "broken", id: "ARK-720", title: "Broken", status: "ready" });
  writeFileSync(
    join(projectFolder("broken"), "ROADMAP.md"),
    "# Roadmap\n\n## Vision\n\nA vision.\n\n## Milestones\n\n| id | name | outcome | state |\n| M1 | One | Out | sideways |\n",
  );

  const { baseUrl } = await start();
  const snapshot = await snapshotWhen(
    baseUrl,
    (current) => current.tickets !== "unknown" && current.roadmap !== "unknown",
  );
  if (snapshot.roadmap === "unknown" || snapshot.tickets === "unknown")
    throw new Error("unreachable");

  const full = snapshot.roadmap.full;
  if (!("vision" in full)) throw new Error(`full has no roadmap: ${JSON.stringify(full)}`);
  expect(full.vision).toBe("Ship it.");
  expect(full.now.map((item) => item.id)).toEqual(["ARK-701"]);
  expect(full.unranked.map((item) => item.id)).toEqual(["ARK-702", "ARK-703", "ARK-704"]);
  expect(full.unranked.find((item) => item.id === "ARK-704")?.title).toBe("Show ark chief state");
  expect(snapshot.roadmap.bare).toEqual({ none: "jira" });
  const broken = snapshot.roadmap.broken;
  if (!("error" in broken)) throw new Error(`broken has no error: ${JSON.stringify(broken)}`);
  expect(broken.error).toMatch(/^line 10: .*sideways/);

  const tickets = snapshot.tickets;
  const why = (id: string) => tickets.find((ticket) => ticket.id === id)?.why;
  expect(why("ARK-701")).toBe("The first sentence.");
  expect(why("ARK-702")).toBe("Because it is needed!");
  expect(why("ARK-703")).toBeNull();
  expect(why("ARK-704")).toBe("Run ark chief state first");
});

test("ARK-291-AC2 a change to ROADMAP.md reaches a client of the event stream within 5 s", async () => {
  isolatedEnvironment();
  installFakeTools({});
  writeBacklogTicket({ project: "p", id: "ARK-701", title: "Ranked", status: "ready" });
  writeRoadmap("p", { vision: "Before the change.", now: ["ARK-701"] });
  const { baseUrl } = await start();
  await snapshotWhen(baseUrl, (current) => current.roadmap !== "unknown");

  const controller = new AbortController();
  const reader = (
    await fetch(`${baseUrl}/events`, { signal: controller.signal })
  ).body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const readUntil = async (text: string, milliseconds: number): Promise<number> => {
    const startedAt = performance.now();
    const deadline = startedAt + milliseconds;
    while (!seen.includes(text) && performance.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(1, deadline - performance.now())).then(() => null),
      ]);
      if (chunk === null || chunk.done) break;
      seen += decoder.decode(chunk.value);
    }
    expect(seen).toContain(text);
    return performance.now() - startedAt;
  };
  try {
    await readUntil("Before the change.", 5000);
    writeRoadmap("p", { vision: "After the change.", now: ["ARK-701"] });
    expect(await readUntil("After the change.", 5000)).toBeLessThan(5000);
  } finally {
    controller.abort();
  }
});

test("ARK-291-AC10 with a ROADMAP.md present, / and /nope answer with a p95 below 200 ms", async () => {
  isolatedEnvironment();
  installFakeTools({});
  for (let number = 0; number < 40; number++)
    writeBacklogTicket({
      project: "p",
      id: `ARK-${800 + number}`,
      title: `Ticket ${number}`,
      status: number % 5 === 0 ? "done" : "ready",
      milestone: "M4",
      problem: "A reason. More.",
    });
  writeRoadmap("p", { now: ["ARK-801", "ARK-802"], next: ["ARK-803"], later: ["ARK-804"] });
  const { baseUrl } = await start();
  await snapshotWhen(baseUrl, (current) => {
    const roadmap = current.roadmap;
    return roadmap !== "unknown" && "vision" in roadmap.p;
  });
  for (const route of ["/", "/nope"]) {
    const durations: number[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      const startedAt = performance.now();
      await (await fetch(`${baseUrl}${route}`)).arrayBuffer();
      durations.push(performance.now() - startedAt);
    }
    const p95 = durations.toSorted((left, right) => left - right)[
      Math.ceil(durations.length * 0.95) - 1
    ];
    expect(p95, route).toBeLessThan(200);
  }
});

// ---------------------------------------------------------------- ARK-293

test("ARK-293-AC1 an agent in Orca state done shows done, also 60 min old, with agentWait null or set, and is never stuck; the other kinds keep their ARK-285-AC3 result", () => {
  const now = Date.now();
  const minutesAgo = (minutes: number) => now - minutes * 60_000;
  const agents = {
    doneOld: { state: "done", updatedAt: minutesAgo(60), lastOutputAt: minutesAgo(60) },
    doneNullWait: { state: "done", updatedAt: now, agentWait: null },
    doneWithWait: { state: "done", updatedAt: now, agentWait: { source: "hook", since: now } },
    prompt: { state: "working", updatedAt: now, agentWait: { source: "hook", since: now } },
    waiting: { state: "waiting", updatedAt: now },
    blocked: { state: "blocked", updatedAt: now },
    idle: { state: "working", toolName: "bash", updatedAt: minutesAgo(10) },
    working: { state: "working", toolName: "bash", updatedAt: now },
    unknown: {},
  };
  const activities = Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [name, activityOf(agent, now)]),
  );
  const kinds = Object.fromEntries(Object.entries(activities).map(([name, a]) => [name, a.kind]));
  expect(kinds).toEqual({
    doneOld: "done",
    doneNullWait: "done",
    doneWithWait: "done",
    prompt: "waiting",
    waiting: "waiting",
    blocked: "waiting",
    idle: "idle",
    working: "working",
    unknown: "unknown",
  });
  for (const name of ["doneOld", "doneNullWait", "doneWithWait"])
    expect(activities[name]).toMatchObject({ kind: "done", text: "done" });

  // Home's Stuck agents list holds the stuck kinds and none of the done agents.
  const snapshot = {
    runs: [
      {
        run: "r",
        updated_at: "now",
        waiting: [],
        plan: [],
        agents: Object.entries(activities).map(([name, activity]) => ({
          step: name,
          activity,
        })),
      },
    ],
    sources: { agentWait: { ok: true, read_at: "now" } },
  } as unknown as Snapshot;
  expect(stuckAgents(snapshot, () => 0).map((item) => item.step)).toEqual([
    "prompt",
    "waiting",
    "blocked",
    "idle",
  ]);
});

/** The messages of one fixture session file: each one a model, in order. */
const modelMessages = (...models: string[]) =>
  models.map((model, number) => ({
    time: new Date(Date.now() - 600_000 + number),
    costUsd: 0.01,
    model,
  }));

test("ARK-293-AC2 an agent gets the model Orca reports, else the last message of its newest session file, else the plan model (planned), and a run lead the roles.chief model (configured)", async () => {
  const { sessions } = isolatedEnvironment();
  writeProject("p", {
    workspace: scratch("ark-workspace-"),
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "m" },
      validator: { harness: "omp", model: "m" },
      reviewer: { harness: "omp", model: "m" },
      chief: { harness: "claude", model: "claude-opus" },
    },
  });
  const started = new Date(Date.now() - 3_600_000);
  const at = (seconds: number) => new Date(started.getTime() + seconds * 1000);
  const ids = [
    "orca",
    "single",
    "newest",
    "changes",
    "bare",
    "emptynew",
    "lastunknown",
    "noharness",
  ];
  const step = (id: string, number: number) => ({
    id,
    role: "implementer",
    harness: "omp",
    model: `plan/${id}`,
    needs: [],
    startedAfter: 100 + number * 600,
    finishedAfter: 600 + number * 600,
  });
  const run = `${today()}-ARK-293-1`;
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-293", title: "Models" },
    phase: "building",
    startedAt: started,
    steps: ids.map(step),
  });
  const cwd = join(directory, "workspace");
  const put = (name: string, startSeconds: number, ...models: string[]) =>
    writeOmpSession(sessions, name, cwd, modelMessages(...models), at(startSeconds));
  const windowOf = (id: string) => 100 + ids.indexOf(id) * 600 + 10;
  put("lead", 30, "lead-session"); // before the first step: the run lead
  put("orca-file", windowOf("orca"), "ignored-session"); // Orca reports a model: this file is not read
  put("single-file", windowOf("single"), "single-session");
  // The newest file of a step wins, whatever its name or start say.
  const older = put("newest-old", windowOf("newest"), "old-session");
  put("newest-new", windowOf("newest") + 5, "new-session");
  const past = new Date(Date.now() - 60_000);
  utimesSync(older, past, past);
  // A model change in the last message: the last one is the model.
  put("changes-file", windowOf("changes"), "first-model", "second-model", "last-model");
  // The newest file holds no message, or its last message names no model: the older model is not shown.
  const olderEmpty = put("emptynew-old", windowOf("emptynew"), "obsolete-model");
  put("emptynew-new", windowOf("emptynew") + 5);
  utimesSync(olderEmpty, past, past);
  put("lastunknown-file", windowOf("lastunknown"), "known-model", "unknown");
  // Orca names no harness for this agent: the plan's stays beside the session model.
  put("noharness-file", windowOf("noharness"), "session-model");
  // A run with no session file: a lead with no model gets roles.chief.
  const bareRun = `${today()}-ARK-294-1`;
  writeRun({
    project: "p",
    run: bareRun,
    ticket: { id: "ARK-294", title: "No model" },
    phase: "building",
  });

  const answers = orcaAnswersFor(run);
  const workerNames = ids;
  installFakeTools({
    orca: {
      terminals: [
        { handle: "term-lead", connected: true, agentIdentity: "omp" },
        { handle: "term-lead-2", connected: true, agentIdentity: "omp" },
        ...workerNames.map((name) => ({
          handle: `term-${name}`,
          connected: true,
          ...(name === "noharness" ? {} : { agentIdentity: "omp" }),
        })),
      ],
      runs: [
        ...answers.runs!,
        {
          id: `orca-${bareRun}`,
          objective: `Ark run ${bareRun}`,
          coordinator_handle: "term-lead-2",
        },
      ],
      workers: workerNames.map((name) => ({
        taskId: `task-${name}`,
        state: "running",
        agentTerminalHandle: `term-${name}`,
        ...(name === "orca" ? { projection: { provider: { model: "orca/reported" } } } : {}),
      })),
      tasks: workerNames.map((name) => ({ id: `task-${name}`, title: `${name} (implementer, .)` })),
    },
  });
  const { baseUrl } = await start();
  const snapshot = await snapshotWhen(baseUrl, (current) => {
    if (current.runs === "unknown") return false;
    const agents = current.runs.find((candidate) => candidate.run === run)?.agents;
    return (
      Array.isArray(agents) &&
      agents.some((agent) => agent.step === "changes" && agent.model !== null)
    );
  });
  const modelsOf = (name: string) => {
    const agents = openRunOf(snapshot, name).agents;
    if (agents === "unknown") throw new Error("agents are unknown");
    return Object.fromEntries(agents.map((agent) => [agent.step ?? agent.role, agent]));
  };
  const agents = modelsOf(run);
  const shown = (name: string) => [agents[name].model, agents[name].planned];
  expect(shown("orca")).toEqual(["orca/reported", null]);
  expect(shown("single")).toEqual(["single-session", null]);
  expect(shown("newest")).toEqual(["new-session", null]);
  expect(shown("changes")).toEqual(["last-model", null]);
  expect(shown("run lead")).toEqual(["lead-session", null]);
  expect(shown("emptynew")).toEqual([
    null,
    { harness: "omp", model: "plan/emptynew", source: "plan" },
  ]);
  expect(shown("lastunknown")).toEqual([
    null,
    { harness: "omp", model: "plan/lastunknown", source: "plan" },
  ]);
  expect([agents.noharness.harness, agents.noharness.model, agents.noharness.planned]).toEqual([
    "omp",
    "session-model",
    null,
  ]);
  expect(shown("bare")).toEqual([null, { harness: "omp", model: "plan/bare", source: "plan" }]);
  expect(agents["run lead"].harness).toBe("omp");
  expect(modelsOf(bareRun)["run lead"]).toMatchObject({
    model: null,
    planned: { harness: "claude", model: "claude-opus", source: "configured" },
  });
}, 60_000);

test("ARK-T82 the recorded real prompt wait gives waiting, by agentWait alone too", () => {
  const raw = readDoc("test/fixtures/orca-agent-wait.json");
  const entry = JSON.parse(raw);
  expect(entry.agentWait).toMatchObject({ source: "hook" });
  const activity = activityOf(entry, Date.now());
  expect(activity.kind).toBe("waiting");
  // The state alone is not what holds it: with state `working` the agentWait object still does.
  expect(activityOf({ ...entry, state: "working" }, Date.now()).kind).toBe("waiting");
});

test("ARK-293-AC5 the run page reads session models from the parse the cost already holds: no second parse, no request, and the last message of the newest file", async () => {
  const { sessions } = isolatedEnvironment();
  const directory = writeRun({
    project: "p",
    run: `${today()}-ARK-295-1`,
    ticket: { id: "ARK-295", title: "No new read" },
    phase: "building",
  });
  const cwd = join(directory, "workspace");
  writeOmpSession(sessions, "lead", cwd, modelMessages("one-model", "two-model"));
  const index = new UsageIndex();
  indexes.push(index);
  await index.refresh([directory]);
  const parsed = index.parseCount;
  expect(parsed).toBe(1);

  const first = index.modelsOf(directory, [], Date.now() - 3_600_000);
  for (let read = 0; read < 5; read++) index.modelsOf(directory, [], Date.now() - 3_600_000);
  expect(first.get("lead")).toBe("two-model");
  expect(index.parseCount).toBe(parsed);
  await index.refresh([directory]);
  expect(index.parseCount).toBe(parsed);
});

test("ARK-293-AC3 Master Chief listed by Orca and by worktree ps is one agent of a run", async () => {
  isolatedEnvironment();
  const run = `${today()}-ARK-296-1`;
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-296", title: "Chief once" },
    phase: "building",
  });
  const answers = orcaAnswersFor(run);
  installFakeTools({
    orca: {
      ...answers,
      terminals: [
        ...answers.terminals!,
        { handle: "term-chief", connected: true, agentIdentity: "omp", model: "chief-model" },
      ],
      runs: [
        ...answers.runs!,
        {
          id: "orca-chief",
          objective: "Master Chief: p tickets",
          coordinator_handle: "term-chief",
        },
      ],
      worktrees: [
        {
          path: join(directory, "workspace"),
          agents: [
            { taskTitle: "Master Chief: p tickets", state: "working", updatedAt: Date.now() },
          ],
        },
      ],
    },
  });
  const { baseUrl } = await start();
  const snapshot = await snapshotWhen(baseUrl, (current) => {
    if (current.runs === "unknown") return false;
    const agents = current.runs.find((candidate) => candidate.run === run)?.agents;
    return Array.isArray(agents) && agents.some((agent) => agent.activity.kind === "working");
  });
  const agents = openRunOf(snapshot, run).agents;
  if (agents === "unknown") throw new Error("agents are unknown");
  const chiefs = agents.filter((agent) => agent.role === "Master Chief");
  expect(chiefs).toHaveLength(1);
  expect(chiefs[0]).toMatchObject({ model: "chief-model", presence: "live" });
  expect(chiefs[0].activity.kind).toBe("working");
}, 60_000);

// ---------------------------------------------------------------- ARK-335 gate age

type LogEvent = { after: number; type: string; data: Record<string, unknown> };

test("ARK-T311 A gate item's age starts at the event that opened the gate and never moves with later events", async () => {
  isolatedEnvironment();
  installFakeTools({});
  const started = new Date(Date.now() - 3 * 3_600_000);
  const at = (second: number) => new Date(started.getTime() + second * 1000).toISOString();
  const ticketOf = (number: number) => `ARK-${number}`;
  const runOf = (number: number) => `${today()}-${ticketOf(number)}-1`;
  const gateOf = (number: number, kind: string) => `gate:${runOf(number)}:${kind}`;
  const opening = (number: number, criteria: string[]): LogEvent[] => [
    {
      after: 0,
      type: "run.started",
      data: {
        run: runOf(number),
        project: "p",
        ticket: { id: ticketOf(number), title: `Ticket ${number}` },
        criteria,
        round_budget: 1,
      },
    },
    {
      after: 10,
      type: "evaluation.recorded",
      data: { blockers: [], risks: [], surfaces: ["none"] },
    },
  ];
  const approved = (number: number, afterApproval: LogEvent[] = []): LogEvent[] => [
    ...opening(number, [`${ticketOf(number)}-AC1`]),
    {
      after: 20,
      type: "plan.checked",
      data: {
        valid: true,
        plan_hash: "h",
        steps: [{ id: "build", role: "implementer", repo: "." }],
      },
    },
    {
      after: 30,
      type: "gate.answered",
      data: { gate: "plan", answer: "approve" },
    },
    ...afterApproval,
  ];
  const build = (round: number, after: number): LogEvent[] => [
    {
      after,
      type: "step.started",
      data: { step: "build", role: "implementer", repo: ".", round },
    },
    {
      after: after + 10,
      type: "step.finished",
      data: { step: "build", outcome: "succeeded" },
    },
  ];
  const failedTest = (after: number): LogEvent => ({
    after,
    type: "test.completed",
    data: { passed: false, criteria: {} },
  });
  const logs: Record<number, LogEvent[]> = {
    // A: the budget is spent and escalation.requested follows the failed test.
    1: approved(1, [
      ...build(1, 40),
      failedTest(60),
      { after: 70, type: "escalation.requested", data: {} },
    ]),
    // B: the failed test spent the budget and no escalation.requested exists.
    2: approved(2, [...build(1, 40), failedTest(60)]),
    // C: an earlier escalation was answered (one more round); a failed test spends the new budget.
    3: approved(3, [
      ...build(1, 40),
      failedTest(60),
      { after: 70, type: "escalation.requested", data: {} },
      {
        after: 80,
        type: "gate.answered",
        data: { gate: "escalation", answer: "one_more_round" },
      },
      ...build(2, 90),
      failedTest(120),
    ]),
    // D: a criteria gate, a strategy gate and a plan gate.
    4: opening(4, []),
    5: [
      ...opening(5, ["ARK-5-AC1"]),
      {
        after: 20,
        type: "strategy.recorded",
        data: { count: 2, cards: ["S1", "S2"], recommended: "S1", reason: "" },
      },
    ],
    6: [
      ...opening(6, ["ARK-6-AC1"]),
      {
        after: 25,
        type: "plan.checked",
        data: {
          valid: true,
          plan_hash: "h",
          steps: [{ id: "build", role: "implementer", repo: "." }],
        },
      },
    ],
    // E and F: two budget-spent escalations; E opened first.
    7: approved(7, [...build(1, 40), failedTest(65)]),
    8: approved(8, [...build(1, 400), failedTest(420)]),
  };
  for (const [number, events] of Object.entries(logs)) {
    const directory = writeRun({
      project: "p",
      run: runOf(Number(number)),
      ticket: { id: ticketOf(Number(number)), title: `Ticket ${number}` },
      phase: "building",
      startedAt: started,
    });
    writeEventLog(directory, started, events);
  }
  const { baseUrl } = await start();
  const gatesOf = (snapshot: Snapshot) => (snapshot.gates === "unknown" ? [] : snapshot.gates);
  const before = await snapshotWhen(baseUrl, (snapshot) => gatesOf(snapshot).length === 8);
  const sinceOf = (snapshot: Snapshot) =>
    Object.fromEntries(gatesOf(snapshot).map((gate) => [gate.id, gate.since]));
  const expected = {
    [gateOf(1, "escalation")]: at(70),
    [gateOf(2, "escalation")]: at(60),
    [gateOf(3, "escalation")]: at(120), // not at(70): that request was answered
    [gateOf(4, "criteria")]: at(0),
    [gateOf(5, "strategy")]: at(20),
    [gateOf(6, "plan")]: at(25),
    [gateOf(7, "escalation")]: at(65),
    [gateOf(8, "escalation")]: at(420),
  };
  expect(sinceOf(before)).toEqual(expected);
  // Oldest gate first: the order is by opening time.
  const order = Object.entries(expected)
    .toSorted(([, left], [, right]) => left.localeCompare(right))
    .map(([id]) => id);
  expect(gatesOf(before).map((gate) => gate.id)).toEqual(order);

  // Three later events on every gated run: the newest event of a run is not its gate's age.
  for (const number of Object.keys(logs).map(Number))
    for (const extra of [1, 2, 3])
      appendRawEvent(
        runDirectoryOf("p", runOf(number)),
        "evaluation.recorded",
        { blockers: [], risks: [], surfaces: ["none"] },
        logs[number].length + extra,
      );
  const after = await snapshotWhen(
    baseUrl,
    (snapshot) =>
      snapshot.runs !== "unknown" &&
      snapshot.runs.every((run) => Date.parse(run.updated_at) > Date.now() - 60_000),
  );
  expect(sinceOf(after)).toEqual(expected);
  expect(gatesOf(after).map((gate) => gate.id)).toEqual(gatesOf(before).map((gate) => gate.id));
}, 60_000);

// ---------------------------------------------------------------- ARK-344: the hub reads every Orca message

type ConversationHead = {
  truncated: boolean;
  stale: boolean;
  directory: "loading" | "ready";
  read_at: string;
};
type RunReply = ConversationHead & RunConversation;
type ProjectReply = ConversationHead & ProjectAnswer;

/** Appends an event with an explicit time to a run's log, so the times of a fixture are exact. */
function appendEventAt(
  directory: string,
  time: string,
  type: string,
  data: Record<string, unknown>,
): void {
  const file = join(directory, "events.ndjson");
  const seq = readFileSync(file, "utf8").split("\n").filter(Boolean).length + 1;
  appendFileSync(file, `${JSON.stringify({ seq, time, type, data })}\n`);
}

/**
 * Two Ark runs, Master Chief, a run lead, five workers (implementer, validator, reviewer and two planning
 * titles), a brainstorm session and two unknown handles. Handle kinds as Orca sends them: `structworker_*`
 * (run leads), `dispatch:ctx_*`, `term_*` and `run:<Orca Run id>`. The lead is only in Master Chief's
 * worker-list; each worker answers to a dispatch id, a terminal or an agent terminal handle.
 */
function conversationFixture() {
  const run = `${today()}-ARK-840-1`;
  const otherRun = `${today()}-ARK-841-1`;
  const base = Date.now();
  const at = (minutesAgo: number) => new Date(base - minutesAgo * 60_000).toISOString();
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-840", title: "Conversation" },
    phase: "building",
    steps: [
      {
        id: "impl-api",
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 100,
        finishedAfter: 200,
      },
      // No step.finished: an open span.
      {
        id: "spec-cases-write",
        role: "validator",
        harness: "omp",
        model: "m",
        needs: ["impl-api"],
        startedAfter: 300,
      },
    ],
  });
  writeRun({
    project: "p",
    run: otherRun,
    ticket: { id: "ARK-841", title: "Other" },
    phase: "building",
  });
  // Round 1 of impl-api ran on worker w1; round 2 runs on worker w6.
  appendEventAt(directory, at(46), "worker.started", {
    step: "impl-api",
    dispatch: "ctx_w1",
    terminal: "term_w1",
  });
  // In time order: an auto answer, a human answer, a second round of impl-api, a second human answer.
  appendEventAt(directory, at(45), "gate.answered", {
    gate: "plan",
    answer: "approve",
    by: "auto",
  });
  appendEventAt(directory, at(40), "gate.answered", {
    gate: "plan",
    answer: "revise",
    by: "human",
  });
  appendEventAt(directory, at(35), "step.started", {
    step: "impl-api",
    role: "implementer",
    repo: ".",
    round: 2,
  });
  appendEventAt(directory, at(34), "worker.started", {
    step: "impl-api",
    dispatch: "ctx_w6",
    terminal: "term_w6",
  });
  appendEventAt(directory, at(32), "step.finished", { step: "impl-api", outcome: "succeeded" });
  appendEventAt(directory, at(20), "gate.answered", {
    gate: "plan",
    answer: "approve",
    by: "human",
  });

  const message = (
    id: string,
    type: string,
    from: string,
    to: string,
    minutesAgo: number,
    rest: Partial<{
      delivered: string | null;
      thread: string | null;
      payload: Record<string, unknown> | null;
      runId: string | null;
    }> = {},
  ) => ({
    id,
    type,
    from_handle: from,
    to_handle: to,
    subject: `subject of ${id}`,
    body: `SECRET-BODY ${id}`,
    thread_id: rest.thread ?? null,
    run_id: rest.runId === undefined ? "orca-chief-p" : rest.runId,
    payload: rest.payload ?? null,
    created_at: at(minutesAgo),
    delivered_at: rest.delivered ?? null,
  });
  const messages = [
    // Question: no delivered time recorded.
    message("msg_1", "question", "structworker_lead", "run:orca-chief-p", 50),
    // Escalation, delivered one minute later, relayed to the lead on the same thread.
    message("msg_2", "escalation", "dispatch:ctx_lead", "run:orca-chief-p", 30, {
      delivered: at(29),
      thread: "thr_1",
      payload: { kind: "stuck", attempts: 2 },
    }),
    message("msg_3", "status", "run:orca-chief-p", "dispatch:ctx_lead", 25, {
      delivered: at(24),
      thread: "thr_1",
    }),
    message("msg_4", "worker_done", "dispatch:ctx_w1", "structworker_lead", 34),
    message("msg_5", "status", "term_w2", `run:orca-${run}`, 33, { runId: `orca-${run}` }),
    message("msg_6", "status", "term_w3a", "dispatch:ctx_lead", 32),
    message("msg_7", "worker_done", "dispatch:ctx_w4", "structworker_lead", 31),
    message("msg_8", "worker_done", "term_w5", "structworker_lead", 30),
    // A brainstorm session that asks Master Chief.
    message("msg_9", "question", "term_brain", "run:orca-chief-p", 15, { runId: null }),
    // Two handles that no list knows.
    message("msg_10", "status", "term_unknown", "term_ghost", 14, { runId: null }),
    // The lead of another Ark run.
    message("msg_11", "question", "structworker_lead2", "run:orca-chief-p", 10, {
      runId: `orca-${otherRun}`,
    }),
    // A worker asks its run lead: no human answer waits on it.
    message("msg_12", "question", "dispatch:ctx_w1", "structworker_lead", 5),
  ];
  const worker = (
    name: string,
    fields: { dispatchId?: string; terminal?: string; agentTerminalHandle?: string },
  ) => ({ taskId: `task-${name}`, state: "running", ...fields });
  const orca = {
    terminals: [],
    runs: [
      {
        id: "orca-chief-p",
        objective: "Master Chief: p tickets",
        coordinator_handle: "term_chief",
      },
      {
        id: `orca-${run}`,
        objective: `Ark run ${run}`,
        coordinator_handle: "structworker_lead",
      },
      {
        id: `orca-${otherRun}`,
        objective: `Ark run ${otherRun}`,
        coordinator_handle: "structworker_lead2",
      },
    ],
    workersByRun: {
      "orca-chief-p": [
        worker("lead", { dispatchId: "ctx_lead", terminal: "structworker_lead" }),
        worker("lead2", { dispatchId: "ctx_lead2", terminal: "structworker_lead2" }),
      ],
      [`orca-${run}`]: [
        worker("w1", { dispatchId: "ctx_w1", terminal: "term_w1" }),
        worker("w2", { terminal: "term_w2" }),
        worker("w3", { agentTerminalHandle: "term_w3a" }),
        worker("w4", { dispatchId: "ctx_w4" }),
        worker("w5", { terminal: "term_w5" }),
        worker("w6", { dispatchId: "ctx_w6", terminal: "term_w6" }),
      ],
    },
    tasks: [
      { id: "task-w1", title: "impl-api (implementer, .)" },
      { id: "task-w2", title: "spec-cases-write (validator, .)" },
      { id: "task-w3", title: "review-1 (reviewer, .)" },
      { id: "task-w4", title: `evaluator (${run})` },
      { id: "task-w5", title: `test-case-writer (${run})` },
      { id: "task-w6", title: "impl-api (implementer, .)" },
    ],
    messages,
  };
  return { run, otherRun, at, messages, orca };
}

async function conversationWhen<Reply extends ConversationHead>(
  baseUrl: string,
  ready: (reply: Reply) => boolean,
  path = "/api/conversation",
): Promise<Reply> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fetch(`${baseUrl}${path}`);
    const body = await response.text();
    if (response.status === 200 && ready(JSON.parse(body) as Reply)) return JSON.parse(body);
    if (Date.now() > deadline)
      throw new Error(
        `the conversation never reached the state: ${response.status} ${body.slice(0, 300)}`,
      );
    await delay(50);
  }
}

const allMessagesOf = (reply: ProjectReply) => [
  ...reply.runs.flatMap((run) => run.messages),
  ...reply.other.messages,
];
const agentsOf = (reply: ProjectReply) => [
  ...reply.runs.flatMap((run) => run.agents),
  ...reply.other.agents,
];
/** The agent that sent (`from`) or received (`to`) a message, from the project answer. */
const agentOfMessage = (reply: ProjectReply, id: string, side: "from" | "to") => {
  const found = allMessagesOf(reply).find((message) => message.id === id)!;
  return agentsOf(reply).find((agent) => agent.id === found[side])!;
};

test("ARK-T319 the hub reads the full Orca inbox in the background, keeps the last good value, and marks it truncated or stale", async () => {
  isolatedEnvironment();
  const { run, messages, orca } = conversationFixture();
  const state = installFakeTools({ orca });
  process.env.ARK_HUB_INTERVAL_MS = "100";
  const { baseUrl } = await start();
  delete process.env.ARK_HUB_INTERVAL_MS;
  // The liveness read is `--limit 200 --full`; the conversation read names a larger limit.
  const fullReads = () =>
    readFileSync(join(state, "orca.log"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("orchestration inbox") && !line.includes("--limit 200 "));

  // A good read: below the limit, nothing stale, every field kept.
  const first = await conversationWhen<ProjectReply>(baseUrl, (reply) => !reply.stale);
  const limit = Number(
    fullReads()
      .at(-1)!
      .match(/--limit (\d+)/)![1],
  );
  expect(fullReads().at(-1)).toContain("--full");
  expect(fullReads().at(-1)).toContain("--json");
  expect(limit).toBeGreaterThan(messages.length);
  expect(first.truncated).toBe(false);
  expect(first.read_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(allMessagesOf(first)).toHaveLength(messages.length);
  const kept = (id: string) => allMessagesOf(first).find((message) => message.id === id)!;
  expect(kept("msg_1")).toMatchObject({ delivered_at: null, thread_id: null });
  expect(kept("msg_2")).toMatchObject({
    thread_id: "thr_1",
    delivered_at: messages[1].delivered_at,
  });
  const body = (await (await fetch(`${baseUrl}/api/conversation/message/msg_2`)).json()) as {
    body: string;
    payload: unknown;
    delivered_at: string;
  };
  expect(body).toMatchObject({
    body: "SECRET-BODY msg_2",
    payload: { kind: "stuck", attempts: 2 },
  });
  expect(await (await fetch(`${baseUrl}/api/conversation/message/msg_1`)).json()).toMatchObject({
    payload: null,
    delivered_at: null,
  });

  // No body reaches the snapshot or a pushed frame.
  const pushes = await openPushes(baseUrl);
  const frame = await pushes.next();
  pushes.close();
  const snapshotText = await (await fetch(`${baseUrl}/api/snapshot`)).text();
  expect(frame).not.toContain("SECRET-BODY");
  expect(snapshotText).not.toContain("SECRET-BODY");

  // A failed read keeps the first value with its read time; the other Orca sources stay ok.
  writeFakeToolState(state, { orca, orcaInboxFails: true });
  const stale = await conversationWhen<ProjectReply>(baseUrl, (reply) => reply.stale);
  expect(stale.read_at).toBe(first.read_at);
  expect(allMessagesOf(stale)).toEqual(allMessagesOf(first));
  const afterFailure = (await (await fetch(`${baseUrl}/api/snapshot`)).json()) as Snapshot;
  expect(afterFailure.sources.orca.ok).toBe(true);
  expect(openRunOf(afterFailure, run).run).toBe(run);

  // Recovery: fresh and not stale.
  writeFakeToolState(state, { orca });
  const fresh = await conversationWhen<ProjectReply>(baseUrl, (reply) => !reply.stale);
  expect(Date.parse(fresh.read_at)).toBeGreaterThan(Date.parse(first.read_at));

  // Exactly the limit: truncated. One fewer: not. (Old messages, outside the default window, keep the answers small.)
  const filler = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      ...messages[0],
      id: `msg_fill_${index}`,
      created_at: "2020-01-01T00:00:00.000Z",
    }));
  writeFakeToolState(state, { orca: { ...orca, messages: filler(limit) } });
  expect(
    (await conversationWhen<ProjectReply>(baseUrl, (reply) => reply.truncated)).truncated,
  ).toBe(true);
  writeFakeToolState(state, { orca: { ...orca, messages: filler(limit - 1) } });
  expect(
    (await conversationWhen<ProjectReply>(baseUrl, (reply) => !reply.truncated)).truncated,
  ).toBe(false);
}, 90_000);

test("ARK-T320 every message handle maps to Master Chief, a run lead, a worker with step and role, a session agent, or an unmapped agent", async () => {
  isolatedEnvironment();
  const { run, otherRun, messages, orca } = conversationFixture();
  installFakeTools({ orca });
  const { baseUrl } = await start();
  const reply = await conversationWhen<ProjectReply>(baseUrl, () => true);

  // No message is dropped, whatever its handles.
  expect(new Set(allMessagesOf(reply).map((message) => message.id))).toEqual(
    new Set(messages.map((message) => message.id)),
  );
  const of = (id: string, side: "from" | "to") => agentOfMessage(reply, id, side);

  expect(of("msg_1", "to").kind).toBe("chief"); // run:<Master Chief Run id>
  const lead = of("msg_1", "from"); // structworker_*
  expect(lead).toMatchObject({ kind: "run_lead" });
  expect(of("msg_2", "from").id).toBe(lead.id); // dispatch:ctx_*
  expect(of("msg_3", "to").id).toBe(lead.id);
  expect(of("msg_5", "to").id).toBe(lead.id); // run:<Ark run's Orca Run id>
  expect(of("msg_11", "from")).toMatchObject({ kind: "run_lead" });
  expect(of("msg_11", "from").id).not.toBe(lead.id);

  // A worker answers to its dispatch id, terminal or agent terminal handle; step and role come from the task title.
  expect(of("msg_4", "from")).toMatchObject({
    kind: "worker",
    step: "impl-api",
    role: "implementer",
    group: "Implementers",
  });
  expect(of("msg_5", "from")).toMatchObject({
    kind: "worker",
    step: "spec-cases-write",
    role: "validator",
    group: "Validators",
  });
  expect(of("msg_6", "from")).toMatchObject({
    kind: "worker",
    step: "review-1",
    role: "reviewer",
    group: "Reviewers",
  });
  expect(of("msg_7", "from")).toMatchObject({
    kind: "worker",
    role: "evaluator",
    group: "Planning",
  });
  expect(of("msg_8", "from")).toMatchObject({
    kind: "worker",
    role: "test-case-writer",
    group: "Planning",
  });

  // A terminal that sent to Master Chief and is neither lead nor worker is a session; the rest is unmapped with the raw handle.
  expect(of("msg_9", "from")).toMatchObject({ kind: "session", handle: "term_brain" });
  expect(of("msg_10", "from")).toMatchObject({ kind: "unmapped", handle: "term_unknown" });
  expect(of("msg_10", "to")).toMatchObject({ kind: "unmapped", handle: "term_ghost" });
  expect(reply.other.messages.map((message) => message.id).sort()).toEqual(["msg_10", "msg_9"]);

  // Each message sits with the run that owns it.
  const owned = (name: string) => reply.runs.find((candidate) => candidate.run === name)!;
  expect(owned(otherRun).messages.map((message) => message.id)).toEqual(["msg_11"]);
  expect(
    owned(run)
      .messages.map((message) => message.id)
      .sort(),
  ).toEqual(
    ["msg_1", "msg_12", "msg_2", "msg_3", "msg_4", "msg_5", "msg_6", "msg_7", "msg_8"].sort(),
  );
}, 60_000);

test("ARK-T321 the conversation routes answer agents, role groups, spans, events, messages, human answers and question times from the worker thread", async () => {
  isolatedEnvironment();
  const { run, otherRun, at, messages, orca } = conversationFixture();
  const state = installFakeTools({ orca });
  // Slow Orca calls: the handle directory read outlasts the 2 s wait, so the first value is the early one.
  writeFileSync(join(state, "orca.sleep"), "3");
  const { baseUrl } = await start();
  const early = await conversationWhen<ProjectReply>(baseUrl, () => true);
  expect(early.directory).toBe("loading");
  writeFileSync(join(state, "orca.sleep"), "0");
  await conversationWhen<ProjectReply>(baseUrl, (reply) => reply.directory === "ready");

  // The run route.
  const answer = await conversationWhen<RunReply>(
    baseUrl,
    () => true,
    `/api/run/${run}/conversation`,
  );
  expect(answer.agents.filter((agent) => agent.kind === "chief")).toHaveLength(1);
  expect(answer.agents.filter((agent) => agent.kind === "run_lead")).toHaveLength(1);
  const workers = answer.agents.filter((agent) => agent.kind === "worker");
  expect(
    workers.map((agent) => agent.group).sort((left, right) => left!.localeCompare(right!)),
  ).toEqual(["Implementers", "Implementers", "Planning", "Planning", "Reviewers", "Validators"]);
  const spans = (step: string) => answer.spans.filter((span) => span.step === step);
  expect(spans("impl-api")).toHaveLength(2); // two rounds
  expect(spans("impl-api")[1]).toMatchObject({ start: at(35), end: at(32), group: "Implementers" });
  // Each round names the worker its own worker.started recorded.
  const agentOf = (handle: string) => workers.find((agent) => agent.id.endsWith(`:${handle}`))!.id;
  expect(spans("impl-api").map((span) => span.agent)).toEqual([
    agentOf("ctx_w1"),
    agentOf("ctx_w6"),
  ]);
  // No worker.started follows this step.started: no agent.
  expect(spans("spec-cases-write")[0].agent).toBeNull();
  expect(spans("spec-cases-write")).toEqual([
    expect.objectContaining({ end: null, role: "validator", group: "Validators" }),
  ]);
  expect(answer.events!.map((event) => event.type)).toContain("step.started");
  expect(answer.events!.filter((event) => event.type === "gate.answered")).toHaveLength(4);
  // Human answers only: the auto answer and the plan answer with no `by` are not the human's.
  expect(answer.answers.map((entry) => entry.time)).toEqual([at(40), at(20)]);
  expect(answer.messages.map((message) => message.id)).not.toContain("msg_11");
  expect(answer.messages.find((message) => message.id === "msg_3")).toMatchObject({
    body: "SECRET-BODY msg_3",
    thread_id: "thr_1",
  });

  // Question times: the first human answer at or after delivery (sent, when delivery is not recorded); never created_at as delivered.
  expect(answer.questions).toEqual([
    {
      id: "msg_1",
      sent: messages[0].created_at,
      delivered: null,
      answered: at(40),
      pickup_seconds: "not recorded",
    },
    {
      id: "msg_2",
      sent: messages[1].created_at,
      delivered: messages[1].delivered_at,
      answered: at(20),
      pickup_seconds: 60,
    },
    {
      id: "msg_12",
      sent: messages[11].created_at,
      delivered: null,
      answered: null,
      pickup_seconds: "not recorded",
    },
  ]);
  expect((await fetch(`${baseUrl}/api/run/no-such-run/conversation`)).status).toBe(404);

  // The project route: a window holds both runs and no body; another window is empty; bad values give 400.
  const window = (since: string, until: string) =>
    `/api/conversation?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
  const text = await (await fetch(`${baseUrl}${window(at(120), at(0))}`)).text();
  expect(text).not.toContain("SECRET-BODY");
  const project = JSON.parse(text) as ProjectReply;
  expect(project.runs.map((entry) => entry.run).sort()).toEqual([run, otherRun].sort());
  const projectRun = project.runs.find((entry) => entry.run === run)!;
  expect(projectRun.questions).toEqual(answer.questions);
  expect(projectRun.spans).toEqual(answer.spans);
  expect(projectRun.answers).toEqual(answer.answers);
  expect(projectRun.messages.every((message) => !("body" in message))).toBe(true);
  const narrow = JSON.parse(
    await (await fetch(`${baseUrl}${window(at(36), at(24))}`)).text(),
  ) as ProjectReply;
  expect(
    allMessagesOf(narrow)
      .map((message) => message.id)
      .sort(),
  ).toEqual(["msg_2", "msg_3", "msg_4", "msg_5", "msg_6", "msg_7", "msg_8"].sort());
  const empty = (await (
    await fetch(`${baseUrl}${window("2000-01-01T00:00:00Z", "2000-01-02T00:00:00Z")}`)
  ).json()) as ProjectReply;
  expect(empty.runs).toEqual([]);
  expect(empty.other.messages).toEqual([]);
  for (const query of [
    "?since=yesterday",
    "?until=not-a-time",
    `?since=${encodeURIComponent(at(0))}&until=${encodeURIComponent(at(60))}`,
  ])
    expect((await fetch(`${baseUrl}/api/conversation${query}`)).status, query).toBe(400);

  // The message route: one body from memory; an unknown or hostile id reads nothing and answers 404.
  const one = await fetch(`${baseUrl}/api/conversation/message/msg_9`);
  expect(one.status).toBe(200);
  expect(await one.json()).toMatchObject({ id: "msg_9", body: "SECRET-BODY msg_9" });
  for (const id of ["msg_none", "..%2F..%2Fetc%2Fpasswd", "..%2Fevents.ndjson", "a%00b", "%ZZ"])
    expect((await fetch(`${baseUrl}/api/conversation/message/${id}`)).status, id).toBe(404);
  expect((await fetch(`${baseUrl}/api/conversation/message/a/b`)).status).toBe(404);

  // The routes are GET only, and / still answers while builds run.
  expect((await fetch(`${baseUrl}/api/conversation`, { method: "POST" })).status).toBe(405);
  const builds = Array.from({ length: 10 }, () => fetch(`${baseUrl}/api/run/${run}/conversation`));
  expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
  for (const build of await Promise.all(builds)) expect(build.status).toBe(200);
}, 60_000);

// AC4 of ARK-344: the budgets of the 2,000-message case ARK-T322.
const pageBudgetMilliseconds = 200;
const conversationBudgetMilliseconds = 1000;
test("ARK-T322 with 2,000 messages and 20 runs the hub pages keep their p95 and the project conversation answers within 1 s", async () => {
  isolatedEnvironment();
  const base = Date.now();
  const runs = Array.from(
    { length: 20 },
    (_, index) => `${today()}-ARK-9${String(index).padStart(2, "0")}-1`,
  );
  const orcaRuns: unknown[] = [
    { id: "orca-chief-p", objective: "Master Chief: p tickets", coordinator_handle: "term_chief" },
  ];
  const chiefWorkers: unknown[] = [];
  const workersByRun: Record<string, unknown[]> = {};
  const messages: unknown[] = [];
  const bodyText = "x".repeat(900); // a body of realistic size
  runs.forEach((run, index) => {
    writeRun({
      project: "p",
      run,
      ticket: { id: `ARK-9${String(index).padStart(2, "0")}`, title: `Load ${index}` },
      phase: "building",
      steps: [
        {
          id: "impl",
          role: "implementer",
          harness: "omp",
          model: "m",
          needs: [],
          startedAfter: 100,
          finishedAfter: 200,
        },
      ],
    });
    orcaRuns.push({
      id: `orca-${run}`,
      objective: `Ark run ${run}`,
      coordinator_handle: `structworker_${index}`,
    });
    chiefWorkers.push({
      taskId: "task-lead",
      dispatchId: `ctx_lead${index}`,
      terminal: `structworker_${index}`,
    });
    workersByRun[`orca-${run}`] = [
      { taskId: "task-impl", state: "running", dispatchId: `ctx_w${index}` },
    ];
    for (let number = 0; number < 100; number++) {
      const worker = number % 2 === 0;
      messages.push({
        id: `msg_${index}_${number}`,
        type: number % 10 === 0 ? "question" : "status",
        from_handle: worker ? `dispatch:ctx_w${index}` : `structworker_${index}`,
        to_handle: worker ? `structworker_${index}` : "run:orca-chief-p",
        subject: `subject ${index} ${number}`,
        body: bodyText,
        thread_id: null,
        run_id: `orca-${run}`,
        payload: null,
        created_at: new Date(base - (index * 100 + number) * 60_000).toISOString(),
        delivered_at:
          number % 3 === 0
            ? null
            : new Date(base - (index * 100 + number) * 60_000 + 5000).toISOString(),
      });
    }
  });
  expect(messages).toHaveLength(2000);
  installFakeTools({
    orca: {
      terminals: [],
      runs: orcaRuns,
      workersByRun: { "orca-chief-p": chiefWorkers, ...workersByRun },
      tasks: [{ id: "task-impl", title: "impl (implementer, .)" }],
      messages,
    },
  });
  const { baseUrl } = await start();
  // 20 runs and 2,000 messages sit 100 minutes apart, so a 48 h window holds them all.
  const path = `/api/conversation?since=${encodeURIComponent(new Date(base - 48 * 3_600_000).toISOString())}&until=${encodeURIComponent(new Date(base + 60_000).toISOString())}`;
  const timed = async () => {
    const requestedAt = performance.now();
    const response = await fetch(`${baseUrl}${path}`);
    const reply = (await response.json()) as ProjectReply;
    return { milliseconds: performance.now() - requestedAt, status: response.status, reply };
  };
  // The first conversation request waits for the first read, so wait for it on the cheap message route; then ask for the
  // full value (directory ready, not the early one). The first ready answer is the cold build.
  const deadline = Date.now() + 60_000;
  while ((await fetch(`${baseUrl}/api/conversation/message/msg_0_0`)).status !== 200) {
    if (Date.now() > deadline) throw new Error("the inbox was never read");
    await delay(50);
  }
  let cold = await timed();
  while (cold.reply.directory !== "ready") {
    if (Date.now() > deadline) throw new Error("the handle directory was never read");
    await delay(50);
    cold = await timed();
  }
  expect(cold.status).toBe(200);
  expect(allMessagesOf(cold.reply)).toHaveLength(2000);
  expect(cold.reply.runs).toHaveLength(20);
  expect(cold.milliseconds, "cold /api/conversation").toBeLessThan(conversationBudgetMilliseconds);

  // / and /nope while the conversation is requested again and again.
  let building = true;
  const conversationTimes: number[] = [];
  // Four clients ask at once, so the worker's queue is never empty.
  const background = Promise.all(
    Array.from({ length: 4 }, async () => {
      while (building) conversationTimes.push((await timed()).milliseconds);
    }),
  );
  const latencies: Record<string, number[]> = { "/": [], "/nope": [] };
  for (let round = 0; round < 100; round++)
    for (const route of ["/", "/nope"]) {
      const requestedAt = performance.now();
      await (await fetch(`${baseUrl}${route}`)).arrayBuffer();
      latencies[route].push(performance.now() - requestedAt);
    }
  building = false;
  await background;
  const p95 = Object.fromEntries(
    Object.entries(latencies).map(([route, durations]) => [route, percentile95(durations)]),
  );
  console.log(
    `ARK-T322 cold=${cold.milliseconds.toFixed(0)}ms warm-max=${Math.max(...conversationTimes).toFixed(0)}ms builds=${conversationTimes.length} p95(/)=${p95["/"].toFixed(1)}ms p95(/nope)=${p95["/nope"].toFixed(1)}ms`,
  );
  for (const [route, value] of Object.entries(p95))
    expect(value, `p95 of ${route}`).toBeLessThan(pageBudgetMilliseconds);
  expect(Math.max(...conversationTimes), "/api/conversation under load").toBeLessThan(
    conversationBudgetMilliseconds,
  );
}, 120_000);

// ---------------------------------------------------------------- ARK-339

const repoUrl = (repo: string, number: number) =>
  `https://github.com/example/${repo}/pull/${number}`;

const detailOf = async (baseUrl: string, run: string): Promise<RunDetail> =>
  (await (await fetch(`${baseUrl}/api/run/${run}`)).json()) as RunDetail;

/**
 * Puts a `git` first on PATH that sleeps 1 s before `ls-tree` and passes every other command through. The hub reads
 * git with spawnSync, so each run that reads a pointer holds its repo facts back by 1 s while the fake `gh` answers
 * at once: the facts of a run publish well after its merge request shows `merged`, on any host.
 */
function delayLsTree(): void {
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git is not on PATH");
  writeFakeCommand(
    "git",
    `for argument in "$@"; do [ "$argument" = ls-tree ] && sleep 1; done\nexec ${realGit} "$@"`,
  );
}

/** The `bump_state` of each bump step in a run's repo graph, keyed by the bump step. */
const bumpStates = (view: RunView) =>
  Object.fromEntries(
    (view.repos ?? []).flatMap((entry) =>
      entry.depends_on.map((edge) => [edge.bump, edge.bump_state] as const),
    ),
  );

test("ARK-T358 The run snapshot of a multi-repo run carries its repos in repoGraph order, step repos, MR waits and bump states, and a run with no usable graph carries none", async () => {
  isolatedEnvironment();
  const workspace = scratch("ark-repo-workspace-");
  const branch = "ark/ARK-339-fixture";
  const { bases } = writeRepoWorkspace(workspace, branch, {
    "core-lib": { ahead: 3 },
    service: { ahead: 2 },
    web: { ahead: 0, gitlink: { pin: "vendor/service", sha: submodulePointerSha } },
    e2e: { ahead: 1 },
  });
  writeProject("p", repoProjectConfig(workspace));
  const fixture = (run: string, id: string, mode: "building" | "mr" | "handed_off", count: 3 | 4) =>
    repoRunFixture({
      project: "p",
      run,
      ticket: { id, title: `Repo graph ${id}` },
      repoCount: count,
      mode,
      workspace,
      branch,
      bases,
    });
  const mrRun = `${today()}-ARK-901-1`;
  const handedOff = `${today()}-ARK-902-1`;
  writeRun(fixture(mrRun, "ARK-901", "mr", 3));
  writeRun(fixture(handedOff, "ARK-902", "handed_off", 4));
  // The same run in a project whose ark.yml does not load: the branch is there, its state is not known.
  const unknownRun = `${today()}-ARK-903-1`;
  writeRun({ ...fixture(unknownRun, "ARK-903", "handed_off", 3), project: "no-config" });
  // One step repo with a repos list, an old plan with no repos list, and a cycle.
  const step = (id: string, repo: string, needs: string[]) => ({
    id,
    role: "implementer",
    harness: "omp",
    model: "m",
    needs,
    repo,
    startedAfter: 20,
  });
  const oneRepo = `${today()}-ARK-904-1`;
  writeRun({
    project: "p",
    run: oneRepo,
    ticket: { id: "ARK-904", title: "One step repo" },
    phase: "building",
    steps: [step("a-impl", "a", [])],
    repos: [
      {
        repo: "a",
        why: "a",
        depends_on: [{ repo: "lib", kind: "package", pin: "lib", evidence: "f:1" }],
      },
      { repo: "lib", why: "lib" },
    ],
  });
  const oldPlan = `${today()}-ARK-905-1`;
  writeRun({
    project: "p",
    run: oldPlan,
    ticket: { id: "ARK-905", title: "Old plan" },
    phase: "building",
    steps: [step("b-impl", "b", ["a-impl"]), step("a-impl", "a", [])],
  });
  const cyclic = `${today()}-ARK-906-1`;
  writeRun({
    project: "p",
    run: cyclic,
    ticket: { id: "ARK-906", title: "Cycle" },
    phase: "building",
    steps: [step("a-impl", "a", []), step("b-impl", "b", [])],
    repos: [
      {
        repo: "a",
        why: "a",
        depends_on: [{ repo: "b", kind: "package", pin: "b", evidence: "f:1" }],
      },
      {
        repo: "b",
        why: "b",
        depends_on: [{ repo: "a", kind: "package", pin: "a", evidence: "f:1" }],
      },
    ],
  });
  installFakeTools({
    orca: orcaAnswersFor(mrRun),
    mergeRequestViews: {
      [repoUrl("core-lib", 11)]: {
        state: "MERGED",
        statusCheckRollup: [],
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        createdAt: new Date().toISOString(),
      },
    },
  });
  delayLsTree();
  const { baseUrl } = await start();

  // The MR run: repos in merge order (the plan lists them the other way round), each with its facts.
  // Control: the MR loop shows `merged` while the repo-facts loop still holds its facts back, so the bump reads
  // unknown. This is the read race of ARK-468: a test that reads the bump after this wait alone is red.
  const merged = (next: Snapshot) => {
    const early = Array.isArray(next.runs) ? next.runs.find((run) => run.run === mrRun) : undefined;
    return early?.merge_requests.some((request) => request.state === "merged") === true;
  };
  const mergedOnly = await snapshotWhen(baseUrl, merged);
  expect(bumpStates(openRunOf(mergedOnly, mrRun))["web-bump"]).toBe(
    "points at upstream branch unknown",
  );
  // The facts of the run are read: a repo of the run has its branch measured, in the read that sets the pointer.
  // Loaded here, not at the top of the file: the helper is the fix of ARK-468, and a static import of a module that
  // does not exist yet would fail every test of this file, not only these two.
  const { waitForRepoFacts } = await import("./hub-facts-wait");
  const snapshot = await snapshotWhen(baseUrl, waitForRepoFacts(mrRun));
  const view = openRunOf(snapshot, mrRun);
  expect(view.repos?.map(({ repo, order, why }) => [repo, order, why])).toEqual([
    ["core-lib", 1, "Shared <b>core</b> types"],
    ["service", 2, "Service that consumes the core"],
    ["web", 3, "Web app that embeds the service"],
  ]);
  expect(view.plan?.map(({ id, repo }) => [id, repo])).toContainEqual(["web-bump", "web"]);
  expect(view.merge_requests.map(({ repo, order, waits_for }) => [repo, order, waits_for])).toEqual(
    [
      ["core-lib", 1, []],
      ["service", 2, [11]],
      ["web", 3, [12]],
    ],
  );
  // The upstream MR's state is in the same list: !11 merged, so service's wait is met.
  expect(view.merge_requests.find((request) => request.number === 11)?.state).toBe("merged");
  const bumps = Object.fromEntries(
    (view.repos ?? []).flatMap((entry) =>
      entry.depends_on.map((edge) => [edge.bump, edge.bump_state] as const),
    ),
  );
  // A recorded refresh wins; a submodule not refreshed shows the pointer its worktree records.
  expect(bumps).toEqual({
    "service-bump": "refreshed to 1.4.0",
    "web-bump": `points at upstream branch ${submodulePointerSha.slice(0, 8)}`,
  });
  expect(view.repos?.map((entry) => [entry.repo, entry.state, entry.mr])).toEqual([
    ["core-lib", "merged", 11],
    ["service", "open", 12],
    ["web", "open", 13],
  ]);

  // The runs with no usable graph stay in the snapshot with no graph and no throw.
  expect(openRunOf(snapshot, oneRepo).repos).toBeNull();
  expect(openRunOf(snapshot, cyclic).repos).toBeNull();
  expect(openRunOf(snapshot, cyclic).plan?.map((entry) => entry.id)).toEqual(["a-impl", "b-impl"]);
  // An old plan has no repos list: the order comes from step needs, and there are no edges.
  expect(
    openRunOf(snapshot, oldPlan).repos?.map((entry) => [entry.repo, entry.depends_on]),
  ).toEqual([
    ["a", []],
    ["b", []],
  ]);

  // A closed handed_off run has no MR card but keeps its repos, in hand-off order, with the branch of each.
  // The ticket chain is set from the same background read as the run's branches: once it shows, the facts are in.
  const chained = await snapshotWhen(baseUrl, (next) =>
    Array.isArray(next.ticket_runs)
      ? next.ticket_runs.find((entry) => entry.ticket === "ARK-902")?.chain?.[0].state === "ahead"
      : false,
  );
  const closed = await detailOf(baseUrl, handedOff);
  expect(closed.view.merge_requests).toEqual([]);
  expect(
    closed.view.repos?.map((entry) => [entry.repo, entry.state, entry.branch, entry.mr]),
  ).toEqual([
    ["core-lib", "ahead", { name: branch, ahead: 3 }, null],
    ["service", "ahead", { name: branch, ahead: 2 }, null],
    ["web", "clean", { name: branch, ahead: 0 }, null],
    ["e2e", "ahead", { name: branch, ahead: 1 }, null],
  ]);
  // No MR will exist for a hand-off run: a package bump is worded from its done step, a submodule from its pointer.
  expect(
    Object.fromEntries(
      (closed.view.repos ?? []).flatMap((entry) =>
        entry.depends_on.map((edge) => [edge.bump, edge.bump_state] as const),
      ),
    ),
  ).toEqual({
    "service-bump": "bump step done",
    "web-bump": `points at upstream branch ${submodulePointerSha.slice(0, 8)}`,
    "e2e-bump": "bump step done",
  });
  // The ticket chain of a closed newest run holds the same order and states.
  const newest = Array.isArray(chained.ticket_runs)
    ? chained.ticket_runs.find((entry) => entry.ticket === "ARK-902")
    : undefined;
  expect(newest?.chain?.map(({ repo, order, state }) => [repo, order, state])).toEqual([
    ["core-lib", 1, "ahead"],
    ["service", 2, "ahead"],
    ["web", 3, "clean"],
    ["e2e", 4, "ahead"],
  ]);

  // No ark.yml: the branch shows, its state is unknown, never a guess.
  const unknown = await detailOf(baseUrl, unknownRun);
  expect(unknown.view.repos?.map((entry) => [entry.state, entry.branch])).toEqual([
    ["unknown", { name: branch, ahead: null }],
    ["unknown", { name: branch, ahead: null }],
    ["unknown", { name: branch, ahead: null }],
  ]);

  // The design reference is in the tree.
  for (const file of ["hybrid-1.html", "data.js"])
    expect(existsSync(join(root, "docs/design/repo-graph", file)), file).toBe(true);
});

test("ARK-T393 A submodule bump whose downstream worktree is missing still reads upstream branch unknown, after the repo facts are read", async () => {
  isolatedEnvironment();
  const workspace = scratch("ark-repo-workspace-");
  const branch = "ark/ARK-339-fixture";
  const { bases } = writeRepoWorkspace(workspace, branch, {
    "core-lib": { ahead: 3 },
    service: { ahead: 2 },
    web: { ahead: 0, gitlink: { pin: "vendor/service", sha: submodulePointerSha } },
  });
  writeProject("p", repoProjectConfig(workspace));
  const fixture = (run: string, id: string, owner: string) =>
    repoRunFixture({
      project: "p",
      run,
      ticket: { id, title: `Missing worktree ${id}` },
      repoCount: 3,
      mode: "mr",
      workspace,
      branch,
      bases,
      owner,
    });
  const controlRun = `${today()}-ARK-911-1`;
  const missingRun = `${today()}-ARK-912-1`;
  writeRun(fixture(controlRun, "ARK-911", "control"));
  // The same run, whose web worktree path was never created: only the workspace repo holds the gitlink.
  const missing = fixture(missingRun, "ARK-912", "missing");
  writeRun({
    ...missing,
    worktrees: missing.worktrees?.map((worktree) =>
      worktree.repo === "web" ? { ...worktree, path: join(workspace, "never-created") } : worktree,
    ),
  });
  const merged = {
    state: "MERGED",
    statusCheckRollup: [],
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    createdAt: new Date().toISOString(),
  };
  installFakeTools({
    orca: orcaAnswersFor(controlRun),
    mergeRequestViews: {
      "https://github.com/control/core-lib/pull/11": merged,
      "https://github.com/missing/core-lib/pull/11": merged,
    },
  });
  delayLsTree();
  const { baseUrl } = await start();

  // Loaded here, not at the top of the file: the helper is the fix of ARK-468, and a static import of a module that
  // does not exist yet would fail every test of this file, not only these two.
  const { waitForRepoFacts } = await import("./hub-facts-wait");
  const snapshot = await snapshotWhen(baseUrl, waitForRepoFacts(controlRun, missingRun));

  // The control proves the facts were read and a pointer can be found; the missing run must not invent one.
  expect(bumpStates(openRunOf(snapshot, controlRun))["web-bump"]).toBe(
    `points at upstream branch ${submodulePointerSha.slice(0, 8)}`,
  );
  const missingView = openRunOf(snapshot, missingRun);
  expect(bumpStates(missingView)["web-bump"]).toBe("points at upstream branch unknown");
  expect(missingView.repos?.map((entry) => [entry.repo, entry.branch?.ahead])).toEqual([
    ["core-lib", 3],
    ["service", 2],
    ["web", 0],
  ]);
});
