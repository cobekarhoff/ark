import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
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
import type { RunDetail, RunView, Snapshot, TranscriptPage } from "../hub/types.ts";
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
  ompSessionText,
  orcaAnswersFor,
  today,
  transcriptText,
  writeBacklogTicket,
  writeFakeToolState,
  writeOmpSession,
  writeRoadmap,
  writeRun,
  writeSessionFile,
} from "./hub-fixtures.ts";
import {
  installFakeTools,
  startHub,
  stopHub,
  tempArkHome,
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
  return { sessions };
}

async function start() {
  const hub = await startHub();
  hubs.push(hub.process);
  return hub;
}

// ---------------------------------------------------------------- AC1

const readDoc = (path: string) => readFileSync(join(root, path), "utf8");
const statusOf = (path: string) => readDoc(path).match(/^status: (.*)$/m)?.[1] ?? "";
const viewNames = ["Home", "Runs", "Roadmap"];
const namesViews = (text: string) =>
  viewNames.every((name) => new RegExp(`\\b${name}\\b`).test(text));

test("ARK-277-AC1 ADR 0009 is accepted, ADR 0008 is superseded by it, and ADR 0007 and R13 name the views", () => {
  expect(statusOf("docs/adr/0009-hub-is-a-read-only-live-view.md")).toBe("accepted");
  const superseded = statusOf("docs/adr/0008-hub-steers-through-master-chief.md");
  expect(superseded).toStartWith("superseded");
  expect(superseded).toContain("ADR 0009");

  expect(namesViews(statusOf("docs/adr/0007-control-center.md"))).toBe(true);
  const lines = readDoc("docs/prd.md").split("\n");
  const row = (id: string) => lines.find((line) => line.startsWith(`| ${id} `)) ?? "";
  expect(row("R13")).not.toBe("");
  expect(namesViews(row("R13"))).toBe(true);
});

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
// nothing to delete. This test holds the 5 s and 200 ms budgets of the memory index.
test("ARK-277-AC6 a cold hub serves a full snapshot within 5 s of its start and / answers in under 200 ms meanwhile", async () => {
  const { sessions } = isolatedEnvironment();
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
  installFakeTools({ orca: orcaAnswersFor(runs[0].run) });

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

  const startedAt = performance.now();
  const { baseUrl } = await start();
  const latencies: number[] = [];
  let fullAfter = Infinity;
  let snapshot: Snapshot | undefined;
  while (performance.now() - startedAt < 15_000) {
    const requestedAt = performance.now();
    await (await fetch(`${baseUrl}/`)).arrayBuffer();
    latencies.push(performance.now() - requestedAt);
    snapshot = (await (await fetch(`${baseUrl}/api/snapshot`)).json()) as Snapshot;
    const sourcesOk = Object.values(snapshot.sources).every((source) => source.ok);
    if (
      sourcesOk &&
      Array.isArray(snapshot.runs) &&
      snapshot.runs.every((run: RunView) => run.cost_usd !== null)
    ) {
      fullAfter = performance.now() - startedAt;
      break;
    }
    await Bun.sleep(25);
  }

  expect(fullAfter).toBeLessThan(5000);
  expect(latencies.length).toBeGreaterThan(0);
  const p95 = [...latencies].sort((left, right) => left - right)[
    Math.ceil(latencies.length * 0.95) - 1
  ];
  expect(p95).toBeLessThan(200);
  const runViews = snapshot?.runs;
  if (!Array.isArray(runViews)) throw new Error("the snapshot has no runs");
  expect(runViews).toHaveLength(runCount);
  for (const run of runViews) expect(run.cost_usd).toBeCloseTo(expectedCost, 6);
}, 60_000);

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

test("ARK-277-AC12 ark ui serves the hub in hub/", async () => {
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
  const snapshot = await (await fetch(`${baseUrl}/api/snapshot`)).json();
  expect(Object.keys(snapshot.sources).sort()).toEqual([
    "agentWait",
    "ark",
    "evidence",
    "github",
    "orca",
    "plannotator",
    "providerLimits",
    "usage",
  ]);
  expect(await (await fetch(`${baseUrl}/`)).text()).toContain('<div id="root"></div>');
});

// ---------------------------------------------------------------- AC13

test("ARK-277-AC13 the human check on the real ARK_HOME shows 3 view times below 1 s and human: ok", () => {
  const lines = readDoc("docs/evidence/ARK-277-ac13.md").split("\n");
  for (const view of ["home", "run", "backlog"]) {
    const line = lines.find((candidate) => candidate.startsWith(`${view}: `));
    const milliseconds = Number(line?.slice(view.length + 2));
    expect(Number.isFinite(milliseconds), `${view}: ${line}`).toBe(true);
    expect(milliseconds, view).toBeLessThan(1000);
  }
  expect(lines).toContain("human: ok");
});

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

/** Writes a session file of about `bytes` bytes: records no transcript shows, then `tail` messages. */
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
  } finally {
    closeSync(descriptor);
  }
}

const percentile95 = (durations: number[]) =>
  [...durations].sort((left, right) => left - right)[Math.ceil(durations.length * 0.95) - 1];

test("ARK-284-AC7 while the worker thread reads a 200 MB session file, / and /nope answer with a p95 below 200 ms, and the pages hold 200 entries", async () => {
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
  installFakeTools({ orca: orcaAnswersFor(run) });
  const { baseUrl } = await start();
  try {
    await detailWithSessions(baseUrl, run, 1);

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
    expect(first.entries).toHaveLength(200);
    expect(first.entries[0]).toMatchObject({ kind: "message", role: "user", text: "tail 0" });
    expect(first.next).not.toBeNull();
    const second = (await (
      await fetch(transcriptUrl(baseUrl, run, file, first.next!))
    ).json()) as TranscriptPage;
    expect(second.entries).toHaveLength(50);
    expect(second.entries[0]).toMatchObject({ text: "tail 200" });
    expect(second.next).toBeNull();
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

test("ARK-284-AC9 typecheck, lint and format:check exit 0 (bun test is this run)", () => {
  for (const script of ["typecheck", "lint", "format:check"]) {
    const result = spawnSync("bun", ["run", script], { cwd: root, encoding: "utf8" });
    expect(result.status, `bun run ${script}\n${result.stdout}${result.stderr}`).toBe(0);
  }
}, 300_000);

test("ARK-284-AC10 the human check on the real ARK_HOME is recorded in docs/evidence/ARK-284-ac10.md with human: ok", () => {
  expect(readDoc("docs/evidence/ARK-284-ac10.md").split("\n")).toContain("human: ok");
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

test("ARK-285-AC2 omp usage is read in the background for each provider and window, and a failed read keeps the last value with its age", async () => {
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
  const { baseUrl } = await start();

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

  // The second read happens 60 s after the first, and the fake exits 1 then.
  const countFile = join(state, "omp.count");
  const deadline = Date.now() + 90_000;
  while (Number(existsSync(countFile) ? readFileSync(countFile, "utf8") : 0) < 2) {
    expect(Date.now(), "omp usage was not read a second time").toBeLessThan(deadline);
    await Bun.sleep(500);
  }
  const failed = await snapshotWhen(baseUrl, (snapshot) => !snapshot.sources.providerLimits.ok);
  expect(failed.provider_limits).toEqual(first.provider_limits);
  expect(failed.sources.providerLimits.read_at).toBe(first.sources.providerLimits.read_at);
}, 150_000);

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
  expect(extra).toMatchObject({ live: false, running: true, terminal: null });
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
    { id: "ARK-816-AC1", status: "passing" },
    { id: "ARK-816-AC2", status: "failing" },
    { id: "ARK-816-AC3", status: "missing" },
  ]);
  const proof = (id: string) => evidence?.criteria.find((criterion) => criterion.id === id)?.proof;
  expect(proof("ARK-816-AC1")).toEqual([
    { name: "ARK-816-AC1 lists the runs", file: "test/a.test.ts", line: 10, result: "pass" },
    {
      name: "ARK-816-AC1 doesn't list a closed run",
      file: "test/a.test.ts",
      line: 22,
      result: "pass",
    },
  ]);
  expect(proof("ARK-816-AC2")).toEqual([
    { name: "ARK-816-AC2 refuses a bad token", file: "test/a.test.ts", line: 31, result: "fail" },
  ]);
  expect(proof("ARK-816-AC3")).toEqual([]);
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

test("ARK-285-AC1 docs/design/hub-v2 holds hybrid-1.html and data.js, ADR 0009 names Home, Runs and Roadmap and says Runs replaces Map, and Map.tsx is gone", () => {
  for (const file of ["hybrid-1.html", "data.js"])
    expect(readFileSync(join(root, "docs/design/hub-v2", file), "utf8").length).toBeGreaterThan(0);
  const line = readDoc("docs/adr/0009-hub-is-a-read-only-live-view.md")
    .split("\n")
    .find((candidate) => candidate.includes("The hub shows"));
  expect(line).toContain("The hub shows Home, Runs and Roadmap");
  expect(line).toContain("Runs replaces Map");
  expect(line).not.toContain("Run, Backlog and Map");
  expect(existsSync(join(root, "hub/page/Map.tsx"))).toBe(false);
});

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

test("ARK-285-AC11 typecheck, lint and format:check exit 0 (bun test is this run)", () => {
  for (const script of ["typecheck", "lint", "format:check"]) {
    const result = spawnSync("bun", ["run", script], { cwd: root, encoding: "utf8" });
    expect(result.status, `bun run ${script}\n${result.stdout}${result.stderr}`).toBe(0);
  }
}, 300_000);

test("ARK-285-AC12 the human check on the real ARK_HOME is recorded in docs/evidence/ARK-285-ac12.md with human: ok", () => {
  const evidence = readDoc("docs/evidence/ARK-285-ac12.md");
  for (const part of ["Home", "Runs", "run page", "ticket page", "light", "dark", "usage"])
    expect(evidence, part).toContain(part);
  expect(evidence).toMatch(/usage[^\n]*(match|equal)/i);
  expect(evidence.split("\n")).toContain("human: ok");
});

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

test("ARK-285-AC11 ticket text arrives in the snapshot from the ticket's own file, there is no /api/ticket route, and a front-matter id with ../ reads nothing outside", async () => {
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
  const documents = Object.fromEntries(snapshot.tickets.map((t) => [t.title, t.document]));
  expect(documents.Readable).toEqual({
    problem: "Why it hurts",
    change: "What changes",
    criteria: [{ id: "ARK-840-AC1", text: "It works" }],
  });
  expect(documents.Planted?.problem).toBe("Own text");
  expect(JSON.stringify(snapshot)).not.toContain("OUTSIDE TICKET DIRECTORY");
  for (const id of ["ARK-840", "..%2F..%2F..%2Foutside"])
    expect((await fetch(`${baseUrl}/api/ticket/p/${id}`)).status).toBe(404);
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

test("ARK-293-AC4 the recorded real prompt wait gives waiting, by agentWait alone too, and docs/evidence/ARK-293-ac4.md holds its raw JSON, the text the hub shows and human: ok", () => {
  const raw = readDoc("test/fixtures/orca-agent-wait.json");
  const entry = JSON.parse(raw);
  expect(entry.agentWait).toMatchObject({ source: "hook" });
  const activity = activityOf(entry, Date.now());
  expect(activity.kind).toBe("waiting");
  // The state alone is not what holds it: with state `working` the agentWait object still does.
  expect(activityOf({ ...entry, state: "working" }, Date.now()).kind).toBe("waiting");

  const evidence = readDoc("docs/evidence/ARK-293-ac4.md");
  expect(evidence).toContain(raw.trim());
  expect(evidence).toContain(activity.text);
  expect(evidence.split("\n")).toContain("human: ok");
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
  expect(chiefs[0]).toMatchObject({ model: "chief-model", live: true });
  expect(chiefs[0].activity.kind).toBe("working");
}, 60_000);
