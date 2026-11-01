import { createHash } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

const repositoryRoot = join(import.meta.dir, "..");
let projectDirectory: string;
let orcaBinDirectory: string;

function projectConfigFor(workspace: string): Record<string, unknown> {
  return {
    workspace,
    ticket_source: "local",
    suites: [{ name: "cli", level: "integration", repo: ".", command: "bun test", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "pi/task" },
      validator: { harness: "omp", model: "pi/validate" },
      reviewer: { harness: "omp", model: "pi/validate" },
    },
  };
}

beforeEach(() => {
  for (const name of [
    "ORCA_FAIL",
    "ORCA_RUN_LIST_FAIL",
    "ORCA_RUN_LIST_FAIL_MARKER",
    "ORCA_DELAY",
    "ORCA_ACTION_LOG",
    "PLANNOTATOR_DATA_DIR",
  ])
    delete process.env[name];
  tempArkHome();
  projectDirectory = writeProject("demo", projectConfigFor(tempGitRepo()));
  orcaBinDirectory = mkdtempSync(join(tmpdir(), "ark-orca-"));
  process.env.ORCA_TERMINALS = "[]";
  process.env.ORCA_RUNS = "[]";
  process.env.ORCA_TASKS = "[]";
  process.env.ORCA_WORKERS = "[]";
  const fakeOrca = join(orcaBinDirectory, "orca");
  writeFileSync(
    fakeOrca,
    `#!/bin/sh
if [ "$ORCA_FAIL" = "1" ]; then exit 1; fi
if [ "$ORCA_DELAY" = "1" ]; then sleep 8; fi
if [ "$1" = "terminal" ]; then
  case "$2" in
    show) printf '{"result":{"terminal":{"connected":true,"agentIdentity":"omp"}}}' ;;
    list) printf '{"result":{"terminals":%s}}' "$ORCA_TERMINALS" ;;
    switch) printf '%s\\n' "$*" >> "$ORCA_ACTION_LOG"; printf '{"result":{}}' ;;
    *) exit 2 ;;
  esac
  exit 0
fi
case "$2" in
  run-list)
    if [ "$ORCA_RUN_LIST_FAIL" = "1" ]; then
      : > "$ORCA_RUN_LIST_FAIL_MARKER"
      exit 1
    fi
    printf '{"result":{"runs":%s}}' "$ORCA_RUNS"
    ;;
  task-list) printf '{"result":{"tasks":%s}}' "$ORCA_TASKS" ;;
  worker-list) printf '{"result":{"workers":%s}}' "$ORCA_WORKERS" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(fakeOrca, 0o755);
  process.env.PATH = `${orcaBinDirectory}:${process.env.PATH}`;
});

function startRun(
  ticketId: string,
  title: string,
  criteria = [{ id: `${ticketId}-AC1`, text: "It works" }],
): { runId: string; directory: string } {
  const ticketFile = writeTicket("demo", ticketId, criteria, title);
  const result = ark("run", "start", ticketFile, "--project", "demo");
  expect(result.code).toBe(0);
  const runId = result.out.trim();
  const directory = join(projectDirectory, "runs", runId);
  recordEvaluation(directory);
  return { runId, directory };
}

function setOrcaRuns(runIds: string[], workers: object[] = [], tasks: object[] = []): void {
  process.env.ORCA_RUNS = JSON.stringify(
    runIds.map((runId) => ({
      id: `orca-${runId}`,
      objective: `Ark run ${runId}`,
      coordinator_handle: "term_lead",
    })),
  );
  process.env.ORCA_TASKS = JSON.stringify(tasks);
  process.env.ORCA_WORKERS = JSON.stringify(workers);
}

async function startUi(): Promise<{ process: Bun.Subprocess; port: number }> {
  const uiProcess = Bun.spawn(["bun", join(repositoryRoot, "cli", "ark.ts"), "ui", "--port", "0"], {
    env: { ...process.env, ARK_HOME: process.env.ARK_HOME },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = uiProcess.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`ark ui exited before serving: ${output}`);
    output += new TextDecoder().decode(chunk.value);
  }
  const port = Number(output.match(/127\.0\.0\.1:(\d+)/)?.[1]);
  if (!port) throw new Error(`ark ui did not print its listening port: ${output}`);
  return { process: uiProcess, port };
}

async function withUi<T>(callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const uiServer = await startUi();
  try {
    return await callback(`http://127.0.0.1:${uiServer.port}`);
  } finally {
    uiServer.process.kill();
    await uiServer.process.exited;
  }
}

function planGate(directory: string): void {
  recordEvaluation(directory);
  writeFileSync(join(directory, "plan.yml"), "steps: []\n");
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps: [{ id: "build", role: "implementer", repo: "." }],
  });
}

type Hub = {
  projects: { name: string; chief: Record<string, unknown> }[];
  runs: Record<string, any>[];
  needs_me: Record<string, any>[];
  readers: { orca: string; plannotator: string };
};

/** The first orca read runs in the background after start; wait for it unless orca is meant to fail. */
async function hubState(baseUrl: string, orcaSettled = true): Promise<Hub> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const data = (await (await fetch(`${baseUrl}/api/state`)).json()) as Hub;
    if (!orcaSettled || data.readers.orca === "ok") return data;
    await Bun.sleep(100);
  }
  throw new Error("orca was never read");
}

test("ARK-168-AC2 serves each run's state", async () => {
  const firstRun = startRun("ARK-168-A", "First dashboard run");
  const secondRun = startRun("ARK-168-B", "Second dashboard run");
  planGate(firstRun.directory);
  appendEvent(firstRun.directory, "gate.answered", { gate: "plan", answer: "approve" });
  appendEvent(firstRun.directory, "step.started", {
    step: "build",
    role: "implementer",
    repo: ".",
    round: 1,
  });
  appendEvent(firstRun.directory, "step.finished", { step: "build", outcome: "succeeded" });
  appendEvent(firstRun.directory, "test.completed", {
    passed: true,
    heads: {},
    suites: [],
    criteria: { "ARK-168-A-AC1": "passing" },
  });
  appendEvent(firstRun.directory, "merge_request.opened", {
    repo: ".",
    url: "https://example.test/pull/17",
    number: 17,
  });
  setOrcaRuns(
    [firstRun.runId, secondRun.runId],
    [
      {
        dispatchId: "dispatch-1",
        taskId: "task-1",
        agentTerminalHandle: "term_worker",
        projection: {
          provider: { model: "pi/task" },
          stage: { activity: "working" },
          liveness: { verdict: "live" },
        },
      },
    ],
    [{ id: "task-1", task_title: "Build dashboard" }],
  );

  await withUi(async (baseUrl) => {
    const page = await fetch(baseUrl);
    expect(page.status).toBe(200);
    const data = await hubState(baseUrl);
    const dashboardRun = data.runs.find((run) => run.run === firstRun.runId);
    const planningRun = data.runs.find((run) => run.run === secondRun.runId);
    expect(dashboardRun).toMatchObject({
      ticket: { id: "ARK-168-A", title: "First dashboard run" },
      phase: "merge_requests_open",
      steps: [{ id: "build", role: "implementer", status: "succeeded" }],
      merge_requests: [{ repo: ".", url: "https://example.test/pull/17", number: 17 }],
      agents: [
        { role: "run lead", terminal: "term_lead", liveness: "live", model: "omp" },
        {
          role: "worker",
          title: "Build dashboard",
          terminal: "term_worker",
          model: "pi/task",
          liveness: "live",
          activity: "working",
        },
      ],
    });
    expect(planningRun).toMatchObject({ ticket: { id: "ARK-168-B" }, phase: "planning" });
  });
});

test("ARK-168-AC2 updates gate state in the JSON after ark gate record", async () => {
  const run = startRun("ARK-168-C", "Refresh dashboard");
  planGate(run.directory);
  setOrcaRuns([]);

  await withUi(async (baseUrl) => {
    const before = await hubState(baseUrl);
    expect(before.needs_me).toContainEqual(
      expect.objectContaining({ id: `gate:${run.runId}:plan`, kind: "gate" }),
    );
    expect(ark("gate", "record", run.runId, "plan", "change").code).toBe(0);
    const after = await hubState(baseUrl);
    expect(after.runs.find((dashboardRun) => dashboardRun.run === run.runId)?.gates.plan).toBe(
      "change",
    );
  });
});

test("ARK-168-AC2 keeps listing runs when Orca fails", async () => {
  const run = startRun("ARK-168-D", "Orca unavailable");
  setOrcaRuns([]);
  process.env.ORCA_FAIL = "1";

  await withUi(async (baseUrl) => {
    const data = await hubState(baseUrl, false);
    expect(data.readers.orca).toBe("unknown");
    expect(data.runs).toContainEqual(
      expect.objectContaining({
        run: run.runId,
        ticket: { id: "ARK-168-D", title: "Orca unavailable" },
        agents: [],
      }),
    );
  });
  delete process.env.ORCA_FAIL;
});

test("ARK-168-AC3 gives agents an Orca terminal switch action", async () => {
  const run = startRun("ARK-168-E", "Worker action");
  setOrcaRuns(
    [run.runId],
    [{ dispatchId: "dispatch-1", taskId: "task-1", agentTerminalHandle: "term_abc" }],
    [{ id: "task-1", task_title: "Worker task" }],
  );

  await withUi(async (baseUrl) => {
    const data = await hubState(baseUrl);
    const agents = data.runs.find((dashboardRun) => dashboardRun.run === run.runId)?.agents;
    expect(agents?.find((agent: Record<string, any>) => agent.role === "run lead")).toMatchObject({
      action: { name: "orca-terminal-switch", params: { handle: "term_lead" } },
    });
    expect(agents?.find((agent: Record<string, any>) => agent.role === "worker")).toMatchObject({
      terminal: "term_abc",
      action: { name: "orca-terminal-switch", params: { handle: "term_abc" } },
    });
  });
});

test("ARK-168-AC3 gives a waiting plan gate its Plannotator action", async () => {
  const run = startRun("ARK-168-F", "Plan action");
  planGate(run.directory);
  setOrcaRuns([]);

  await withUi(async (baseUrl) => {
    const data = await hubState(baseUrl);
    expect(data.needs_me.find((item) => item.id === `gate:${run.runId}:plan`)).toMatchObject({
      source: "ark",
      action: { name: "plannotator-annotate", params: { kind: "plan", run: run.runId } },
    });
  });
});

function setEventTime(directory: string, eventType: string, time: string): void {
  const eventFile = join(directory, "events.ndjson");
  const events = readFileSync(eventFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const event = events.find((candidate) => candidate.type === eventType);
  if (!event) throw new Error(`missing ${eventType} in ${directory}`);
  event.time = time;
  writeFileSync(eventFile, `${events.map((candidate) => JSON.stringify(candidate)).join("\n")}\n`);
}

function readyRun(run: { runId: string; directory: string }, step = "build"): void {
  planGate(run.directory);
  appendEvent(run.directory, "gate.answered", { gate: "plan", answer: "approve" });
  appendEvent(run.directory, "step.started", { step, role: "implementer", repo: ".", round: 1 });
}

function startProjectRun(
  project: string,
  ticketId: string,
  title: string,
): { runId: string; directory: string } {
  const ticketFile = writeTicket(
    project,
    ticketId,
    [{ id: `${ticketId}-AC1`, text: "It works" }],
    title,
  );
  const result = ark("run", "start", ticketFile, "--project", project);
  expect(result.code).toBe(0);
  const runId = result.out.trim();
  return {
    runId,
    directory: join(process.env.ARK_HOME as string, "projects", project, "runs", runId),
  };
}

function setMasterChiefs(terminals: object[]): void {
  process.env.ORCA_TERMINALS = JSON.stringify(terminals);
}

async function waitForBrowserValue<T>(
  view: InstanceType<typeof Bun.WebView>,
  expression: string,
): Promise<T> {
  return (await view.evaluate(
    `(() => {
      const { promise, resolve } = Promise.withResolvers();
      const observer = new MutationObserver(() => {
        const value = (${expression});
        if (value) {
          observer.disconnect();
          resolve(value);
        }
      });
      observer.observe(document, { childList: true, subtree: true, attributes: true });
      const value = (${expression});
      if (value) {
        observer.disconnect();
        resolve(value);
      }
      return promise;
    })()`,
  )) as T;
}

test(
  "ARK-176-AC1 serves Bun's HTML app and pushes run changes over SSE while Orca is slow",
  { timeout: 10_000 },
  async () => {
    const run = startRun("ARK-176-A", "SSE update");
    readyRun(run);
    setOrcaRuns([]);
    process.env.ORCA_DELAY = "1";

    await withUi(async (baseUrl) => {
      const page = await fetch(baseUrl);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("script");
      expect(html).toContain("src=");

      const response = await fetch(`${baseUrl}/api/events`);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const stream = response.body?.getReader();
      if (!stream) throw new Error("missing SSE body");
      try {
        await stream.read();
        const before = Date.now();
        appendEvent(run.directory, "step.finished", { step: "build", outcome: "succeeded" });
        let pushed = "";
        while (Date.now() - before < 4_500) {
          const chunk = await Promise.race([
            stream.read(),
            Bun.sleep(4_500).then(() => ({ done: true as const, value: undefined })),
          ]);
          if (chunk.done) break;
          pushed += new TextDecoder().decode(chunk.value);
          if (pushed.includes('"story":"ARK-176-A is building: 1 of 1 steps done"')) break;
        }
        expect(pushed).toContain('"story":"ARK-176-A is building: 1 of 1 steps done"');
        expect(Date.now() - before).toBeLessThan(5_000);
      } finally {
        await stream.cancel();
      }
    });
  },
);

test(
  "ARK-176-AC2 merges Needs-me items across projects and sorts oldest first",
  { timeout: 10_000 },
  async () => {
    const firstRun = startRun("ARK-176-B1", "Older gate");
    planGate(firstRun.directory);
    const secondProject = writeProject("other", projectConfigFor(tempGitRepo()));
    const secondRun = startProjectRun("other", "ARK-176-B2", "Newer gate");
    planGate(secondRun.directory);
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date(Date.now() - 30_000).toISOString();
    setEventTime(firstRun.directory, "plan.checked", older);
    setEventTime(secondRun.directory, "plan.checked", newer);
    setOrcaRuns([]);

    await withUi(async (baseUrl) => {
      const items = (await (await fetch(`${baseUrl}/api/needs-me`)).json()) as Record<
        string,
        unknown
      >[];
      const gates = items.filter((item) => item.kind === "gate");
      expect(gates).toHaveLength(2);
      expect(gates.map((item) => item.project)).toContain("demo");
      expect(gates.map((item) => item.project)).toContain(basename(secondProject));
      expect(gates[0]).toMatchObject({
        id: `gate:${firstRun.runId}:plan`,
        kind: "gate",
        source: "ark",
        project: "demo",
        ticket: "ARK-176-B1",
        title: "plan gate: Older gate",
        since: older,
        action: { name: "plannotator-annotate" },
      });
      expect(Date.parse(gates[0].since as string)).toBeLessThan(
        Date.parse(gates[1].since as string),
      );
      for (const field of ["id", "kind", "source", "project", "ticket", "title", "since", "action"])
        expect(gates[0]).toHaveProperty(field);
    });
  },
);

test(
  "ARK-176-AC3 lists and opens a waiting strategy gate in Plannotator",
  { timeout: 10_000 },
  async () => {
    const run = startRun("ARK-176-S", "Strategy gate");
    planGate(run.directory);
    writeFileSync(join(run.directory, "strategies.md"), "# Strategies\n");
    // This worktree predates strategy.recorded; append the future event after valid run setup.

    const eventFile = join(run.directory, "events.ndjson");
    const events = readFileSync(eventFile, "utf8").trim().split("\n");
    appendFileSync(
      eventFile,
      `${JSON.stringify({
        seq: events.length + 1,
        time: new Date().toISOString(),
        type: "strategy.recorded",
        data: {
          count: 2,
          recommended: "a",
          cards: ["a", "b"],
          reason: "Choose an approach",
          card_text: { a: "First", b: "Second" },
        },
      })}\n`,
    );
    const commandLog = join(mkdtempSync(join(tmpdir(), "ark-strategy-action-")), "calls.txt");
    process.env.ORCA_ACTION_LOG = commandLog;
    const plannotator = join(orcaBinDirectory, "plannotator");
    writeFileSync(
      plannotator,
      `#!/bin/sh
if [ "$1" = "sessions" ] && [ "$2" = "--json" ]; then printf '[]'; exit 0; fi
printf '%s\\n' "$*" >> "$ORCA_ACTION_LOG"
`,
    );
    chmodSync(plannotator, 0o755);
    setOrcaRuns([]);

    await withUi(async (baseUrl) => {
      const items = (await (await fetch(`${baseUrl}/api/needs-me`)).json()) as Record<
        string,
        any
      >[];
      const strategyGate = items.find((item) => item.id === `gate:${run.runId}:strategy`);
      const response = await fetch(`${baseUrl}/api/actions/plannotator-annotate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "strategy", run: run.runId }),
      });
      // The action launches Plannotator as a detached process; wait for its real filesystem signal.
      for (let attempt = 0; attempt < 50 && !(await Bun.file(commandLog).exists()); attempt++)
        await Bun.sleep(20);
      const commands = (
        await Bun.file(commandLog)
          .text()
          .catch(() => "")
      )
        .trim()
        .split("\n");

      expect({ strategyGate, commands, status: response.status }).toMatchObject({
        strategyGate: {
          kind: "gate",
          title: "strategy gate: Strategy gate",
          action: {
            name: "plannotator-annotate",
            params: { kind: "strategy", run: run.runId },
          },
        },
        commands: [`annotate ${join(run.directory, "strategies.md")}`],
        status: 200,
      });
    });
  },
);

test(
  "ARK-176-AC3 reports every waiting source and keeps timed-out Orca liveness unknown",
  { timeout: 15_000 },
  async () => {
    const waitingGate = startRun("ARK-176-C1", "Gate");
    planGate(waitingGate.directory);
    const readyMerge = startRun("ARK-176-C2", "Ready MR");
    readyRun(readyMerge);
    appendEvent(readyMerge.directory, "step.finished", { step: "build", outcome: "succeeded" });
    appendEvent(readyMerge.directory, "test.completed", {
      passed: true,
      heads: {},
      suites: [],
      criteria: { "ARK-176-C2-AC1": "passing" },
    });
    appendEvent(readyMerge.directory, "step.started", {
      step: "review",
      role: "reviewer",
      repo: ".",
      round: 1,
    });
    appendEvent(readyMerge.directory, "step.finished", { step: "review", outcome: "succeeded" });
    appendEvent(readyMerge.directory, "merge_request.opened", {
      repo: ".",
      url: "https://example.test/pull/31",
      number: 31,
    });
    const closedRun = startRun("ARK-176-C3", "Closed retro");
    writeFileSync(
      join(closedRun.directory, "retro.md"),
      "## Close check\n\nWaiting for answers.\n",
    );
    appendEvent(closedRun.directory, "run.closed", { outcome: "aborted" });
    mkdirSync(join(projectDirectory, "tickets"), { recursive: true });
    writeFileSync(
      join(projectDirectory, "tickets", "ARK-176-C4.md"),
      "---\nid: ARK-176-C4\ntitle: Proposed\nstatus: proposed\n---\n",
    );
    const orcaRunIds = [waitingGate.runId, readyMerge.runId, closedRun.runId];
    setOrcaRuns(
      orcaRunIds,
      [
        {
          taskId: "task-stuck",
          agentTerminalHandle: "term_stuck",
          projection: { liveness: { verdict: "stuck" } },
        },
      ],
      [{ id: "task-stuck", task_title: "Stuck worker" }],
    );

    const dataDirectory = mkdtempSync(join(tmpdir(), "plannotator-data-"));
    mkdirSync(join(dataDirectory, "inbox"), { recursive: true });
    writeFileSync(join(dataDirectory, "inbox", "inbox.json"), JSON.stringify({ port: 0 }));
    const inboxServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          `event: message\ndata: ${JSON.stringify({ result: { structuredContent: { threads: [{ thread_id: "thread-1", subject: "Inbox question", last_at: new Date().toISOString(), questions: { open: 1 } }] } } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    writeFileSync(
      join(dataDirectory, "inbox", "inbox.json"),
      JSON.stringify({ port: inboxServer.port }),
    );
    process.env.PLANNOTATOR_DATA_DIR = dataDirectory;
    const plannotator = join(orcaBinDirectory, "plannotator");
    writeFileSync(plannotator, "#!/bin/sh\nprintf '[]'\n");
    chmodSync(plannotator, 0o755);
    process.env.ORCA_RUNS = JSON.stringify(
      orcaRunIds.map((runId) => ({
        id: `orca-${runId}`,
        objective: `Ark run ${runId}`,
        coordinator_handle: null,
      })),
    );
    try {
      await withUi(async (baseUrl) => {
        let data: Hub | null = null;
        for (let attempt = 0; attempt < 50; attempt++) {
          data = await hubState(baseUrl);
          if (data.readers.orca === "ok" && data.readers.plannotator === "ok") break;
          await Bun.sleep(100);
        }
        if (!data) throw new Error("hub state was not available");
        const itemByKind = new Map(data.needs_me.map((item) => [item.kind, item]));
        expect([...itemByKind.keys()].sort((left, right) => left.localeCompare(right))).toEqual([
          "agent",
          "gate",
          "mr",
          "question",
          "retro",
          "ticket",
        ]);
        expect(itemByKind.get("gate")).toMatchObject({ source: "ark", ticket: "ARK-176-C1" });
        expect(itemByKind.get("mr")).toMatchObject({ source: "ark", ticket: "ARK-176-C2" });
        expect(itemByKind.get("question")).toMatchObject({
          source: "plannotator",
          title: "Inbox question",
        });
        expect(itemByKind.get("agent")).toMatchObject({
          source: "orca",
          title: expect.stringContaining("stuck"),
        });
        expect(itemByKind.get("ticket")).toMatchObject({ source: "ark", ticket: "ARK-176-C4" });
        expect(itemByKind.get("retro")).toMatchObject({ source: "ark", ticket: "ARK-176-C3" });
      });

      process.env.ORCA_DELAY = "1";
      await withUi(async (baseUrl) => {
        let timedOut: Hub | null = null;
        for (let attempt = 0; attempt < 50; attempt++) {
          timedOut = await hubState(baseUrl, false);
          if (timedOut.readers.plannotator === "ok") break;
          await Bun.sleep(100);
        }
        expect(timedOut?.readers.orca).toBe("unknown");
        expect(timedOut?.needs_me.some((item) => item.kind === "agent")).toBe(false);
      });
    } finally {
      await inboxServer.stop(true);
    }
  },
);

test(
  "ARK-176-AC4 returns Master Chief states and live run counts",
  { timeout: 10_000 },
  async () => {
    const run = startRun("ARK-176-D", "Chief and run", [
      { id: "ARK-176-D-AC1", text: "One passes" },
      { id: "ARK-176-D-AC2", text: "One fails" },
    ]);
    readyRun(run);
    appendEvent(run.directory, "step.finished", { step: "build", outcome: "succeeded" });
    appendEvent(run.directory, "test.completed", {
      passed: false,
      heads: {},
      suites: [],
      criteria: { "ARK-176-D-AC1": "passing", "ARK-176-D-AC2": "failing" },
    });
    setOrcaRuns([run.runId]);
    const workspacePath = JSON.parse(
      readFileSync(join(process.env.ARK_HOME as string, "projects", "demo", "ark.yml"), "utf8"),
    ).workspace as string;
    setMasterChiefs([
      {
        handle: "term_chief",
        connected: true,
        worktreePath: workspacePath,
        agentIdentity: "omp",
        model: "pi/task",
      },
    ]);
    writeProject("missing", projectConfigFor(tempGitRepo()));

    await withUi(async (baseUrl) => {
      const data = await hubState(baseUrl);
      expect(data.projects).toContainEqual({
        name: "demo",
        chief: { state: "live", handle: "term_chief", harness: "omp", model: "pi/task" },
      });
      expect(data.projects).toContainEqual({ name: "missing", chief: { state: "missing" } });
      expect(data.runs.find((item) => item.run === run.runId)).toMatchObject({
        phase: "building",
        round: 1,
        steps: [{ id: "build", status: "succeeded" }],
        ac: { passing: 1, failing: 1, total: 2 },
        cost: { usd: "unknown" },
        story: "ARK-176-D is building: 1 of 1 steps done, AC2 failing",
      });
    });
  },
);

test("ARK-176-AC4 reports unknown Master Chief state when Orca run-list fails", async () => {
  const workspacePath = JSON.parse(
    readFileSync(join(process.env.ARK_HOME as string, "projects", "demo", "ark.yml"), "utf8"),
  ).workspace as string;
  setMasterChiefs([
    {
      handle: "term_chief",
      connected: true,
      worktreePath: workspacePath,
      agentIdentity: "omp",
      model: "pi/task",
    },
  ]);
  setOrcaRuns([]);
  const runListFailureMarker = join(mkdtempSync(join(tmpdir(), "ark-orca-failure-")), "read");
  process.env.ORCA_RUN_LIST_FAIL_MARKER = runListFailureMarker;
  process.env.ORCA_RUN_LIST_FAIL = "1";

  await withUi(async (baseUrl) => {
    for (
      let attempt = 0;
      attempt < 50 && !(await Bun.file(runListFailureMarker).exists());
      attempt++
    )
      await Bun.sleep(20);
    expect(await Bun.file(runListFailureMarker).exists()).toBe(true);
    // The child process has signaled the failure; allow its rejected result to reach the hub.
    await Bun.sleep(50);
    const data = await hubState(baseUrl, false);
    expect(data.projects).toContainEqual({ name: "demo", chief: { state: "unknown" } });
  });
});

test(
  "ARK-176-AC5 restricts action commands and rejects foreign origins and unknown actions",
  { timeout: 10_000 },
  async () => {
    const run = startRun("ARK-176-E", "Action target");
    readyRun(run);
    writeFileSync(join(run.directory, "plan.md"), "# Plan\n");
    const commandLog = join(mkdtempSync(join(tmpdir(), "ark-actions-")), "calls.txt");
    process.env.ORCA_ACTION_LOG = commandLog;
    const plannotator = join(orcaBinDirectory, "plannotator");
    writeFileSync(
      plannotator,
      `#!/bin/sh
if [ "$1" = "sessions" ] && [ "$2" = "--json" ]; then printf '[]'; exit 0; fi
printf '%s %s\\n' "$0" "$*" >> "$ORCA_ACTION_LOG"
`,
    );
    chmodSync(plannotator, 0o755);
    const openerName = process.platform === "darwin" ? "open" : "xdg-open";
    const opener = join(orcaBinDirectory, openerName);
    writeFileSync(opener, `#!/bin/sh\nprintf '${openerName} %s\\n' "$*" >> "$ORCA_ACTION_LOG"\n`);
    chmodSync(opener, 0o755);
    setOrcaRuns([]);

    await withUi(async (baseUrl) => {
      const actions: { name: string; params: Record<string, unknown> }[] = [
        { name: "orca-terminal-switch", params: { handle: "term_abc" } },
        { name: "plannotator-session", params: { index: 3 } },
        { name: "plannotator-annotate", params: { kind: "plan", run: run.runId } },
        { name: "plannotator-inbox", params: {} },
      ];
      for (const action of actions) {
        const response = await fetch(`${baseUrl}/api/actions/${action.name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(action.params),
        });
        expect(response.status).toBe(200);
      }
      appendEvent(run.directory, "merge_request.opened", {
        repo: ".",
        url: "https://example.test/pull/45",
        number: 45,
      });
      const mergeResponse = await fetch(`${baseUrl}/api/actions/open-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.test/pull/45" }),
      });
      expect(mergeResponse.status).toBe(200);

      const foreign = await fetch(`${baseUrl}/api/actions/plannotator-inbox`, {
        method: "POST",
        headers: { origin: "https://attacker.test", "content-type": "application/json" },
        body: "{}",
      });
      const unknown = await fetch(`${baseUrl}/api/actions/not-an-action`, {
        method: "POST",
        headers: { origin: baseUrl, "content-type": "application/json" },
        body: "{}",
      });
      expect(foreign.status).toBe(403);
      expect(unknown.status).toBe(404);
      const commands = (await Bun.file(commandLog).text()).trim().split("\n");
      expect(commands).toContain("terminal switch --terminal term_abc");
      expect(commands).toContain(`${plannotator} sessions --open 3`);
      expect(commands).toContain(`${plannotator} annotate ${join(run.directory, "plan.md")}`);
      expect(commands).toContain(`${plannotator} inbox --open`);
      expect(commands).toContain(`${openerName} https://example.test/pull/45`);
      expect(commands).toHaveLength(5);
      expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
    });
  },
);

test(
  "ARK-176-AC6 labels workspace MRs and clears running steps on closed runs",
  { timeout: 10_000 },
  async () => {
    const run = startRun("ARK-176-F", "Closed step");
    readyRun(run);
    appendEvent(run.directory, "step.finished", { step: "build", outcome: "succeeded" });
    appendEvent(run.directory, "step.started", {
      step: "review",
      role: "reviewer",
      repo: ".",
      round: 1,
    });
    appendEvent(run.directory, "merge_request.opened", {
      repo: ".",
      url: "https://example.test/pull/29",
      number: 29,
    });
    appendEvent(run.directory, "run.closed", { outcome: "aborted" });
    setOrcaRuns([]);
    const projectConfig = JSON.parse(
      readFileSync(join(process.env.ARK_HOME as string, "projects", "demo", "ark.yml"), "utf8"),
    );

    await withUi(async (baseUrl) => {
      const data = await hubState(baseUrl);
      expect(data.runs.find((item) => item.run === run.runId)).toMatchObject({
        merge_requests: [{ label: `${basename(projectConfig.workspace)} #29`, number: 29 }],
        steps: [
          { id: "build", status: "succeeded" },
          { id: "review", status: "stopped" },
        ],
      });
      expect(data.runs.find((item) => item.run === run.runId)?.steps).not.toContainEqual(
        expect.objectContaining({ status: "running" }),
      );
    });
  },
);

test(
  "ARK-176-AC3 keeps a closed run in Needs me until all three Close check answers exist",
  { timeout: 15_000 },
  async () => {
    const run = startRun("ARK-176-R", "Partial retro");
    appendEvent(run.directory, "run.closed", { outcome: "aborted" });
    setOrcaRuns([]);
    const retroPath = join(run.directory, "retro.md");
    const retroShown = async (baseUrl: string) =>
      (await hubState(baseUrl)).needs_me.some(
        (item) => item.kind === "retro" && item.ticket === "ARK-176-R",
      );

    writeFileSync(retroPath, "## Close check\n\n- Biggest pain: slow tests\n- Change now:\n");
    await withUi(async (baseUrl) => expect(await retroShown(baseUrl)).toBe(true));

    writeFileSync(
      retroPath,
      "## Close check\n\n- Biggest pain: slow tests\n- Change now: cache\n- Surprise: none\n",
    );
    await withUi(async (baseUrl) => expect(await retroShown(baseUrl)).toBe(false));
  },
);

test(
  "ARK-176-AC7 Home renders panels, age colors, and filters all project data",
  { timeout: 30_000 },
  async () => {
    const olderRun = startRun("ARK-176-G1", "Older project run");
    planGate(olderRun.directory);
    setEventTime(
      olderRun.directory,
      "plan.checked",
      new Date(Date.now() - 150 * 60_000).toISOString(),
    );
    const secondProject = writeProject("other", projectConfigFor(tempGitRepo()));
    const newerRun = startProjectRun("other", "ARK-176-G2", "Newer project run");
    planGate(newerRun.directory);
    setEventTime(
      newerRun.directory,
      "plan.checked",
      new Date(Date.now() - 45 * 60_000).toISOString(),
    );
    const liveRun = startRun("ARK-176-G3", "Live project run");
    readyRun(liveRun);
    appendEvent(liveRun.directory, "step.finished", { step: "build", outcome: "succeeded" });
    const workspacePath = JSON.parse(
      readFileSync(join(process.env.ARK_HOME as string, "projects", "demo", "ark.yml"), "utf8"),
    ).workspace as string;
    setMasterChiefs([
      {
        handle: "term_chief",
        connected: true,
        worktreePath: workspacePath,
        agentIdentity: "omp",
        model: "pi/task",
      },
    ]);
    setOrcaRuns(
      [olderRun.runId, newerRun.runId, liveRun.runId],
      [
        {
          taskId: "task-1",
          agentTerminalHandle: "term_agent",
          projection: { liveness: { verdict: "live" }, stage: { activity: "working" } },
        },
      ],
      [{ id: "task-1", task_title: "UI agent" }],
    );
    process.env.ORCA_RUNS = JSON.stringify(
      [olderRun.runId, newerRun.runId, liveRun.runId].map((runId) => ({
        id: `orca-${runId}`,
        objective: `Ark run ${runId}`,
        coordinator_handle: null,
      })),
    );

    await using view = new Bun.WebView({ backend: "chrome", width: 1440, height: 1000 });
    await withUi(async (baseUrl) => {
      await view.navigate(baseUrl);
      await waitForBrowserValue(view, "document.querySelector('[data-need]')?.dataset.need");
      const homeText = await view.evaluate("document.body.innerText");
      for (const label of [
        "Agents working",
        "Gates waiting",
        "Cost today",
        "Live runs",
        "Needs me",
        "Master Chief",
        "worker",
      ])
        expect(homeText).toContain(label);
      expect(homeText).toContain("Welcome, steps finished: 1; items waiting for you: 2.");
      expect(homeText).toContain("demo\nlive · omp · pi/task");
      expect(homeText).toContain("other\nmissing");
      expect(await view.evaluate("document.querySelector('[data-heat=hot]') !== null")).toBe(true);
      expect(await view.evaluate("document.querySelector('[data-heat=warm]') !== null")).toBe(true);
      expect(homeText).toContain("ARK-176-G1 waits for you to approve its plan");
      expect(homeText).toContain("ARK-176-G3 is building: 1 of 1 steps done");
      await view.click('button.chip[aria-pressed="false"]');
      const filtered = (await view.evaluate("document.body.innerText")) as string;
      expect(filtered).toContain("ARK-176-G1");
      expect(filtered).toContain("ARK-176-G3 is building: 1 of 1 steps done");
      expect(filtered).not.toContain("ARK-176-G2");
      expect(await view.evaluate("document.querySelectorAll('.stats .tile').length")).toBe(4);
      expect(await view.evaluate("document.querySelectorAll('[data-run]').length")).toBe(2);
      expect(await view.evaluate("document.querySelectorAll('[data-need]').length")).toBe(1);
      expect(await view.evaluate("document.querySelectorAll('.achip').length")).toBe(4);
      expect(await view.evaluate("document.querySelectorAll('.chief-item').length")).toBe(1);
      expect(filtered).toContain(basename(secondProject));
    });
  },
);

test(
  "ARK-176-AC8 keyboard navigation, actions, overlays, and focus mode work in Home",
  { timeout: 30_000 },
  async () => {
    const firstRun = startRun("ARK-176-H1", "First keyboard item");
    planGate(firstRun.directory);
    writeFileSync(join(firstRun.directory, "plan.md"), "# Plan\n");
    const secondRun = startRun("ARK-176-H2", "Second keyboard item");
    planGate(secondRun.directory);
    const thirdRun = startRun("ARK-176-H3", "Third keyboard item");
    planGate(thirdRun.directory);
    setOrcaRuns([]);
    const actionLog = join(mkdtempSync(join(tmpdir(), "ark-key-actions-")), "calls.txt");
    process.env.ORCA_ACTION_LOG = actionLog;
    writeFileSync(
      join(orcaBinDirectory, "plannotator"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$ORCA_ACTION_LOG"\n`,
    );
    chmodSync(join(orcaBinDirectory, "plannotator"), 0o755);

    await using view = new Bun.WebView({ backend: "chrome", width: 1280, height: 900 });
    await withUi(async (baseUrl) => {
      await view.navigate(baseUrl);
      await waitForBrowserValue(view, "document.querySelectorAll('[data-need]').length === 3");
      const selectedBefore = await view.evaluate(
        "document.querySelector('[data-need][aria-current=true]')?.dataset.need",
      );
      await view.press("j");
      const selectedDown = await view.evaluate(
        "document.querySelector('[data-need][aria-current=true]')?.dataset.need",
      );
      expect(selectedDown).not.toBe(selectedBefore);
      await view.press("k");
      expect(
        await view.evaluate(
          "document.querySelector('[data-need][aria-current=true]')?.dataset.need",
        ),
      ).toBe(selectedBefore);
      await view.press("p");
      await waitForBrowserValue(view, "document.querySelector('#toasts .toast')?.textContent");
      const expectedAction = join(firstRun.directory, "plan.md");
      let actionOutput = "";
      // The action launches a detached process; wait for its real side effect, not the HTTP response.

      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          actionOutput = await Bun.file(actionLog).text();
        } catch {}
        if (actionOutput.includes(expectedAction)) break;
        await Bun.sleep(100);
      }
      expect(actionOutput).toContain(expectedAction);
      await view.press("Enter");
      expect(await view.evaluate("document.querySelector('.detail h2')?.textContent")).toContain(
        "First keyboard item",
      );
      await view.press("k", { modifiers: ["Meta"] });
      expect(
        await view.evaluate("document.querySelector('[aria-label=\"Command palette\"]') !== null"),
      ).toBe(true);
      await view.press("Escape");
      expect(
        await view.evaluate("document.querySelector('[aria-label=\"Command palette\"]') === null"),
      ).toBe(true);
      await view.press("?");
      expect(await view.evaluate("document.querySelector('#sheet-title')?.textContent")).toBe(
        "Keyboard shortcuts",
      );
      await view.press("Escape");
      expect(await view.evaluate("document.querySelector('#sheet-title') === null")).toBe(true);
      await view.press("z");
      expect(
        await view.evaluate("document.querySelector('.app')?.getAttribute('data-focus')"),
      ).toBe("true");
      await view.press("z");
      expect(
        await view.evaluate("document.querySelector('.app')?.getAttribute('data-focus')"),
      ).toBe("false");
    });
  },
);

test("ARK-176-AC9 keeps the hub design reference byte-identical", () => {
  const checksumFile = join(repositoryRoot, "docs", "design", "hub", "SHA256SUMS");
  const checksums = new Map(
    readFileSync(checksumFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [checksum, filename] = line.split(/\s+/) as [string, string];
        return [filename, checksum];
      }),
  );
  for (const filename of ["variant-d2.html", "data.js"]) {
    const file = readFileSync(join(repositoryRoot, "docs", "design", "hub", filename));
    expect(createHash("sha256").update(file).digest("hex")).toBe(checksums.get(filename)!);
  }
});
function runArkWithEnvironment(environment: Record<string, string>, ...arguments_: string[]) {
  return Bun.spawnSync([process.execPath, join(repositoryRoot, "cli", "ark.ts"), ...arguments_], {
    env: { ...process.env, ...environment },
  });
}

function writeCommand(directory: string, name: string, contents: string): string {
  const command = join(directory, name);
  writeFileSync(command, `#!/bin/sh\n${contents}\n`);
  chmodSync(command, 0o755);
  return command;
}

async function waitForCondition(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await condition()) return;
    await Bun.sleep(100);
  }
  throw new Error("condition was not reached");
}

function setupNotifier(): { log: string; commandDirectory: string } {
  const commandDirectory = mkdtempSync(join(tmpdir(), "ark-notifier-"));
  const log = join(commandDirectory, "notifier.log");
  writeCommand(commandDirectory, "notifier", `printf '%s\\n' "$@" >> "${log}"`);
  return { log, commandDirectory };
}

test("ARK-178-AC1 install writes a restarting LaunchAgent and loads it", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "ark-install-home-"));
  const arkHomeDirectory = mkdtempSync(join(tmpdir(), "ark-install-state-"));
  const commandDirectory = mkdtempSync(join(tmpdir(), "ark-install-bin-"));
  const launchLog = join(commandDirectory, "launchctl.log");
  const notifierCommand = writeCommand(commandDirectory, "terminal-notifier", "exit 0");
  writeCommand(commandDirectory, "launchctl", `printf '%s\\n' "$*" >> "${launchLog}"`);

  const result = runArkWithEnvironment(
    {
      HOME: temporaryHome,
      ARK_HOME: arkHomeDirectory,
      ARK_NOTIFIER: notifierCommand,
      ARK_LAUNCHCTL: join(commandDirectory, "launchctl"),
      PATH: commandDirectory,
    },
    "ui",
    "install",
  );
  const plist = join(temporaryHome, "Library", "LaunchAgents", "dev.ark.hub.plist");
  const contents = readFileSync(plist, "utf8");
  expect(result.exitCode).toBe(0);
  expect(contents).toContain("<key>RunAtLoad</key><true/>");
  expect(contents).toContain("<key>KeepAlive</key><true/>");
  expect(contents).toContain(`<string>${join(repositoryRoot, "cli", "ark.ts")}</string>`);
  expect(contents).toContain(`<string>${process.execPath}</string>`);
  expect(contents).toContain("<string>ui</string>");
  expect(contents).toContain(`<key>ARK_NOTIFIER</key><string>${notifierCommand}</string>`);
  expect(readFileSync(launchLog, "utf8").trim()).toBe(`load -w ${plist}`);
});

test("ARK-178-AC1 repeating install leaves the LaunchAgent unchanged", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "ark-install-home-"));
  const arkHomeDirectory = mkdtempSync(join(tmpdir(), "ark-install-state-"));
  const commandDirectory = mkdtempSync(join(tmpdir(), "ark-install-bin-"));
  const launchLog = join(commandDirectory, "launchctl.log");
  const launchctlCommand = writeCommand(
    commandDirectory,
    "launchctl",
    `printf '%s\\n' "$*" >> "${launchLog}"`,
  );
  const notifierCommand = writeCommand(commandDirectory, "terminal-notifier", "exit 0");
  const environment = {
    HOME: temporaryHome,
    ARK_HOME: arkHomeDirectory,
    ARK_NOTIFIER: notifierCommand,
    ARK_LAUNCHCTL: launchctlCommand,
    PATH: commandDirectory,
  };

  const firstResult = runArkWithEnvironment(environment, "ui", "install");
  const plist = join(temporaryHome, "Library", "LaunchAgents", "dev.ark.hub.plist");
  const firstContents = readFileSync(plist, "utf8");
  const secondResult = runArkWithEnvironment(environment, "ui", "install");

  expect(firstResult.exitCode).toBe(0);
  expect(secondResult.exitCode).toBe(0);
  expect(readFileSync(plist, "utf8")).toBe(firstContents);
  expect(readFileSync(launchLog, "utf8").trim().split("\n")).toEqual([`load -w ${plist}`]);
});

test("ARK-178-AC1 install exits 1 with the launchctl error when load fails", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "ark-install-home-"));
  const arkHomeDirectory = mkdtempSync(join(tmpdir(), "ark-install-state-"));
  const commandDirectory = mkdtempSync(join(tmpdir(), "ark-install-bin-"));
  const notifierCommand = writeCommand(commandDirectory, "terminal-notifier", "exit 0");
  const launchctlCommand = writeCommand(
    commandDirectory,
    "launchctl",
    `echo "Load failed: 5: Input/output error" >&2; exit 5`,
  );

  const result = runArkWithEnvironment(
    {
      HOME: temporaryHome,
      ARK_HOME: arkHomeDirectory,
      ARK_NOTIFIER: notifierCommand,
      ARK_LAUNCHCTL: launchctlCommand,
      PATH: commandDirectory,
    },
    "ui",
    "install",
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Load failed: 5: Input/output error");
  expect(result.stdout.toString()).not.toContain("It is running now");
});

test("ARK-178-AC1 install refuses a missing notifier without writing the LaunchAgent", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "ark-install-home-"));
  const arkHomeDirectory = mkdtempSync(join(tmpdir(), "ark-install-state-"));
  const commandDirectory = mkdtempSync(join(tmpdir(), "ark-install-empty-bin-"));
  const result = runArkWithEnvironment(
    {
      HOME: temporaryHome,
      ARK_HOME: arkHomeDirectory,
      ARK_NOTIFIER: "not-installed-notifier",
      PATH: commandDirectory,
    },
    "ui",
    "install",
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("not-installed-notifier is not installed");
  expect(existsSync(join(temporaryHome, "Library", "LaunchAgents", "dev.ark.hub.plist"))).toBe(
    false,
  );
});

test("ARK-178-AC1 uninstall removes the LaunchAgent twice and keeps notification history", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "ark-uninstall-home-"));
  const arkHomeDirectory = mkdtempSync(join(tmpdir(), "ark-uninstall-state-"));
  const commandDirectory = mkdtempSync(join(tmpdir(), "ark-uninstall-bin-"));
  const launchLog = join(commandDirectory, "launchctl.log");
  const launchctlCommand = writeCommand(
    commandDirectory,
    "launchctl",
    `printf '%s\\n' "$*" >> "${launchLog}"`,
  );
  const notifierCommand = writeCommand(commandDirectory, "terminal-notifier", "exit 0");
  const environment = {
    HOME: temporaryHome,
    ARK_HOME: arkHomeDirectory,
    ARK_NOTIFIER: notifierCommand,
    ARK_LAUNCHCTL: launchctlCommand,
    PATH: commandDirectory,
  };
  const installed = runArkWithEnvironment(environment, "ui", "install");
  const plist = join(temporaryHome, "Library", "LaunchAgents", "dev.ark.hub.plist");
  const history = join(arkHomeDirectory, "hub", "notifications.ndjson");
  mkdirSync(join(arkHomeDirectory, "hub"), { recursive: true });
  writeFileSync(history, '{"id":"kept"}\n');

  const firstRemoval = runArkWithEnvironment(environment, "ui", "uninstall");
  const missingAfterFirstRemoval = !existsSync(plist);
  const secondRemoval = runArkWithEnvironment(environment, "ui", "uninstall");

  expect(installed.exitCode).toBe(0);
  expect(firstRemoval.exitCode).toBe(0);
  expect(secondRemoval.exitCode).toBe(0);
  expect(missingAfterFirstRemoval).toBe(true);
  expect(readFileSync(history, "utf8")).toBe('{"id":"kept"}\n');
  expect(readFileSync(launchLog, "utf8").trim().split("\n")).toEqual([
    `load -w ${plist}`,
    `unload ${plist}`,
  ]);
});

test(
  "ARK-178-AC2 a new gate notifies exactly once across repeated polls",
  { timeout: 15_000 },
  async () => {
    const { log, commandDirectory } = setupNotifier();
    process.env.ARK_NOTIFIER = join(commandDirectory, "notifier");
    const uiServer = await startUi();
    try {
      const initialState = await hubState(`http://127.0.0.1:${uiServer.port}`);
      expect(initialState.needs_me).toHaveLength(0);
      // Let the one-second notification poll establish its first empty Ark baseline before adding the gate.
      await Bun.sleep(1100);
      const newRun = startRun("ARK-178-N1", "New gate notification");
      planGate(newRun.directory);
      const gateId = `gate:${newRun.runId}:plan`;
      await waitForCondition(async () => {
        const currentState = (await (
          await fetch(`http://127.0.0.1:${uiServer.port}/api/state`)
        ).json()) as Hub;
        return currentState.needs_me.some((item) => item.id === gateId);
      });
      await waitForCondition(async () => {
        try {
          return (await Bun.file(log).text()).includes(gateId);
        } catch {
          return false;
        }
      });
      // The one-second server poll is the behavior under test; wait beyond two ticks to catch duplicates.
      await Bun.sleep(2200);
      expect(
        (await Bun.file(log).text()).split("\n").filter((line) => line.includes(`#item=${gateId}`)),
      ).toHaveLength(1);
    } finally {
      uiServer.process.kill();
      await uiServer.process.exited;
    }
  },
);

test(
  "ARK-178-AC2 existing gates stay quiet through polls and a server restart",
  { timeout: 15_000 },
  async () => {
    const newRun = startRun("ARK-178-N2", "Gate exists before startup");
    planGate(newRun.directory);
    const { log, commandDirectory } = setupNotifier();
    process.env.ARK_NOTIFIER = join(commandDirectory, "notifier");
    for (let restart = 0; restart < 2; restart++) {
      await withUi(async (baseUrl) => {
        await hubState(baseUrl);
        // Exercise the hub's real startup and refresh intervals rather than advancing fake timers.
        await Bun.sleep(1300);
      });
    }
    expect(await Bun.file(log).exists()).toBe(false);
  },
);

test(
  "ARK-178-AC2 a delayed Orca source establishes its baseline without a notification",
  { timeout: 20_000 },
  async () => {
    const newRun = startRun("ARK-178-N3", "Orca agent existed before read");
    readyRun(newRun);
    const { log, commandDirectory } = setupNotifier();
    process.env.ARK_NOTIFIER = join(commandDirectory, "notifier");
    const failMarker = join(commandDirectory, "orca-fails");
    writeFileSync(failMarker, "");
    process.env.ORCA_RUNS = JSON.stringify([
      { id: "orca-existing-run", objective: `Ark run ${newRun.runId}`, coordinator_handle: null },
    ]);
    process.env.ORCA_TASKS = JSON.stringify([
      { id: "old-worker", task_title: "Existing stuck worker" },
    ]);
    process.env.ORCA_WORKERS = JSON.stringify([
      {
        taskId: "old-worker",
        agentTerminalHandle: "term_old_worker",
        projection: { liveness: { verdict: "stuck" }, stage: { activity: "working" } },
      },
    ]);
    process.env.ORCA_RUN_LIST_FAIL_MARKER = failMarker;
    process.env.ORCA_RUN_LIST_FAIL = "1";
    writeFileSync(
      join(orcaBinDirectory, "orca"),
      readFileSync(join(orcaBinDirectory, "orca"), "utf8").replace(
        'if [ "$ORCA_RUN_LIST_FAIL" = "1" ]; then',
        'if [ -f "$ORCA_RUN_LIST_FAIL_MARKER" ]; then',
      ),
    );

    const uiServer = await startUi();
    try {
      const baseUrl = `http://127.0.0.1:${uiServer.port}`;
      await waitForCondition(async () => Bun.file(failMarker).exists());
      const initiallyUnavailable = (await hubState(baseUrl, false)).readers.orca === "unknown";
      await Bun.file(failMarker).delete();
      await waitForCondition(async () => (await hubState(baseUrl)).readers.orca === "ok");
      await waitForCondition(async () => {
        const state = (await (await fetch(`${baseUrl}/api/state`)).json()) as Hub & {
          agents: { liveness: string }[];
        };
        return state.agents.some((agent) => agent.liveness === "stuck");
      });
      // Give the next one-second notification poll a chance to evaluate the delayed source.
      await Bun.sleep(1300);
      expect(initiallyUnavailable).toBe(true);
      expect(await Bun.file(log).exists()).toBe(false);
    } finally {
      uiServer.process.kill();
      await uiServer.process.exited;
    }
  },
);

test(
  "ARK-178-AC3 a notification is persisted and opening its item marks it acted",
  { timeout: 15_000 },
  async () => {
    const { log, commandDirectory } = setupNotifier();
    process.env.ARK_NOTIFIER = join(commandDirectory, "notifier");
    const uiServer = await startUi();
    const baseUrl = `http://127.0.0.1:${uiServer.port}`;
    try {
      await hubState(baseUrl);
      // Let the first refresh and Ark notification baseline complete before the new run appears.
      await Bun.sleep(1100);
      const newRun = startRun("ARK-178-N4", "Persisted notification item");
      planGate(newRun.directory);
      const notificationId = `gate:${newRun.runId}:plan`;
      await waitForCondition(async () => {
        try {
          return (await Bun.file(log).text()).includes(notificationId);
        } catch {
          return false;
        }
      });
      const history = join(process.env.ARK_HOME as string, "hub", "notifications.ndjson");
      const notificationRecord = JSON.parse((await Bun.file(history).text()).trim());
      expect(notificationRecord.id).toBe(notificationId);
      expect(Number.isNaN(Date.parse(notificationRecord.time))).toBe(false);
      expect(notificationRecord.item).toEqual({
        kind: "gate",
        project: "demo",
        title: "plan gate: Persisted notification item",
      });

      const actionResponse = await fetch(`${baseUrl}/api/notifications/acted`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: notificationId }),
      });
      const notifiedState = (await (await fetch(`${baseUrl}/api/state`)).json()) as Hub & {
        notifications: { id: string; acted: boolean }[];
      };
      expect(actionResponse.status).toBe(200);
      expect(notifiedState.notifications.find((entry) => entry.id === notificationId)?.acted).toBe(
        true,
      );
    } finally {
      uiServer.process.kill();
      await uiServer.process.exited;
    }
  },
);

test(
  "ARK-178-AC3 the Notifications view orders persisted rows newest first with acted text",
  { timeout: 30_000 },
  async () => {
    const historyDirectory = join(process.env.ARK_HOME as string, "hub");
    mkdirSync(historyDirectory, { recursive: true });
    const history = join(historyDirectory, "notifications.ndjson");
    const notifications = [
      {
        id: "gate:oldest:plan",
        time: "2026-01-01T10:00:00.000Z",
        item: { kind: "gate", project: "demo", title: "Oldest gate" },
      },
      {
        id: "gate:newest:plan",
        time: "2026-01-03T10:00:00.000Z",
        item: { kind: "gate", project: "demo", title: "Newest gate" },
      },
      {
        id: "gate:middle:plan",
        time: "2026-01-02T10:00:00.000Z",
        item: { kind: "gate", project: "demo", title: "Middle gate" },
      },
    ];
    writeFileSync(
      history,
      `${[
        ...notifications.map((notification) => JSON.stringify(notification)),
        JSON.stringify({ acted: "gate:middle:plan", time: "2026-01-02T11:00:00.000Z" }),
      ].join("\n")}\n`,
    );
    await using view = new Bun.WebView({ backend: "chrome", width: 1280, height: 900 });
    await withUi(async (baseUrl) => {
      await view.navigate(baseUrl);
      await waitForBrowserValue(
        view,
        "document.querySelectorAll('[data-notification]').length === 3",
      );
      const displayedNotifications = (await view.evaluate(
        `Array.from(document.querySelectorAll('[data-notification]')).map((row) => ({
          id: row.dataset.notification,
          text: row.innerText,
        }))`,
      )) as { id: string; text: string }[];
      expect(displayedNotifications.map((notification) => notification.id)).toEqual([
        "gate:newest:plan",
        "gate:middle:plan",
        "gate:oldest:plan",
      ]);
      expect(displayedNotifications.map((notification) => notification.text)).toEqual(
        expect.arrayContaining([expect.stringContaining("yes"), expect.stringContaining("no")]),
      );
      expect(displayedNotifications[0]?.text).toContain("no");
      expect(displayedNotifications[1]?.text).toContain("yes");
      expect(displayedNotifications[2]?.text).toContain("no");
    });
  },
);

test(
  "ARK-178-AC4 a notification opens the hub at its item and records that it was acted on",
  { timeout: 30_000 },
  async () => {
    const { log, commandDirectory } = setupNotifier();
    process.env.ARK_NOTIFIER = join(commandDirectory, "notifier");
    const uiServer = await startUi();
    await using view = new Bun.WebView({ backend: "chrome", width: 1280, height: 900 });
    try {
      const baseUrl = `http://127.0.0.1:${uiServer.port}`;
      await hubState(baseUrl);
      // Let the first refresh and Ark notification baseline complete before the new run appears.
      await Bun.sleep(1100);
      const newRun = startRun("ARK-178-N5", "Notification click target");
      planGate(newRun.directory);
      const notificationId = `gate:${newRun.runId}:plan`;
      await waitForCondition(async () => {
        try {
          const argumentsLog = await Bun.file(log).text();
          return argumentsLog.includes(notificationId) && argumentsLog.includes("-open");
        } catch {
          return false;
        }
      });
      const argumentsLog = await Bun.file(log).text();
      expect(argumentsLog).toContain(`http://127.0.0.1:${uiServer.port}/#item=${notificationId}`);

      await view.navigate(`${baseUrl}/#item=${encodeURIComponent(notificationId)}`);
      await waitForBrowserValue(
        view,
        `document.querySelector('[data-need="${notificationId}"]')?.dataset.need`,
      );
      await waitForCondition(async () => {
        const apiState = (await (await fetch(`${baseUrl}/api/state`)).json()) as Hub & {
          notifications: { id: string; acted: boolean }[];
        };
        return apiState.notifications.find((entry) => entry.id === notificationId)?.acted === true;
      });
      expect(await view.evaluate("location.hash")).toBe("");
      expect(await view.evaluate("document.querySelector('.detail h2')?.textContent")).toContain(
        "Notification click target",
      );
    } finally {
      uiServer.process.kill();
      await uiServer.process.exited;
    }
  },
);
