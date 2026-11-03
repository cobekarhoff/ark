import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
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
import { readTranscriptPage } from "../hub/transcript.ts";
import { UsageIndex } from "../hub/usage.ts";
import {
  ompSessionText,
  orcaAnswersFor,
  today,
  transcriptText,
  writeBacklogTicket,
  writeFakeToolState,
  writeOmpSession,
  writeRun,
  writeSessionFile,
} from "./hub-fixtures.ts";
import { installFakeTools, startHub, stopHub, tempArkHome, type StartedHub } from "./helpers.ts";

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
const viewNames = ["Home", "Run", "Backlog", "Map"];
const namesViews = (text: string) =>
  viewNames.every((name) => new RegExp(`\\b${name}\\b`).test(text));

test("ARK-277-AC1 ADR 0009 is accepted, ADR 0008 is superseded by it, and ADR 0007, R13 and M4 name the four views", () => {
  expect(statusOf("docs/adr/0009-hub-is-a-read-only-live-view.md")).toBe("accepted");
  const superseded = statusOf("docs/adr/0008-hub-steers-through-master-chief.md");
  expect(superseded).toStartWith("superseded");
  expect(superseded).toContain("ADR 0009");

  expect(namesViews(statusOf("docs/adr/0007-control-center.md"))).toBe(true);
  const lines = readDoc("docs/prd.md").split("\n");
  const row = (id: string) => lines.find((line) => line.startsWith(`| ${id} `)) ?? "";
  expect(row("R13")).not.toBe("");
  expect(namesViews(row("R13"))).toBe(true);
  expect(row("M4")).not.toBe("");
  expect(namesViews(row("M4"))).toBe(true);
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
    "ark",
    "github",
    "orca",
    "plannotator",
    "usage",
  ]);
  expect(await (await fetch(`${baseUrl}/`)).text()).toContain('<div id="root"></div>');
});

// ---------------------------------------------------------------- AC13

test("ARK-277-AC13 the human check on the real ARK_HOME shows 4 view times below 1 s and human: ok", () => {
  const lines = readDoc("docs/evidence/ARK-277-ac13.md").split("\n");
  for (const view of ["home", "run", "backlog", "map"]) {
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
