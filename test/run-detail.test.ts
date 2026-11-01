import { beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import type { RunDetail } from "../cli/hub/detail.ts";
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
let orcaDirectory: string;
let orcaStateDirectory: string;
let orcaTailFile: string;
let ompDirectory: string;
let claudeDirectory: string;
let codexDirectory: string;

beforeEach(() => {
  tempArkHome();
  projectDirectory = writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "cli", level: "integration", repo: ".", command: "bun test", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "pi/task" },
      validator: { harness: "omp", model: "pi/validate" },
      reviewer: { harness: "omp", model: "pi/validate" },
    },
  });
  orcaDirectory = mkdtempSync(join(tmpdir(), "ark179-orca-"));
  orcaStateDirectory = mkdtempSync(join(tmpdir(), "ark179-orca-state-"));
  orcaTailFile = join(orcaStateDirectory, "tail.json");
  ompDirectory = mkdtempSync(join(tmpdir(), "ark179-omp-"));
  claudeDirectory = mkdtempSync(join(tmpdir(), "ark179-claude-"));
  codexDirectory = mkdtempSync(join(tmpdir(), "ark179-codex-"));
  process.env.ARK_OMP_SESSIONS = ompDirectory;
  process.env.ARK_CLAUDE_SESSIONS = claudeDirectory;
  process.env.ARK_CODEX_SESSIONS = codexDirectory;
  process.env.ORCA_STATE_DIRECTORY = orcaStateDirectory;
  process.env.ORCA_TAIL_FILE = orcaTailFile;
  process.env.ORCA_READ_FAIL_HANDLE = "";
  writeFileSync(join(orcaStateDirectory, "run-list"), '{"result":{"runs":[]}}');
  writeFileSync(join(orcaStateDirectory, "task-list"), '{"result":{"tasks":[]}}');
  writeFileSync(join(orcaStateDirectory, "worker-list"), '{"result":{"workers":[]}}');
  writeFileSync(orcaTailFile, "[]");
  const fakeOrca = join(orcaDirectory, "orca");
  writeFileSync(
    fakeOrca,
    `#!/bin/sh
if [ "$1" = "terminal" ]; then
  case "$2" in
    show) printf '{"result":{"terminal":{"connected":true,"agentIdentity":"omp"}}}' ;;
    list) printf '{"result":{"terminals":[]}}' ;;
    read)
      if [ "$4" = "$ORCA_READ_FAIL_HANDLE" ]; then exit 1; fi
      printf '{"result":{"terminal":{"tail":%s}}}' "$(cat "$ORCA_TAIL_FILE")"
      ;;
    *) exit 2 ;;
  esac
  exit 0
fi
cat "$ORCA_STATE_DIRECTORY/$2"
`,
  );
  chmodSync(fakeOrca, 0o755);
  process.env.PATH = `${orcaDirectory}:${process.env.PATH}`;
});

function startRun(
  ticketId: string,
  criteria = [{ id: `${ticketId}-AC1`, text: "First criterion" }],
): { runId: string; directory: string } {
  const ticketFile = writeTicket("demo", ticketId, criteria, `${ticketId} detail`);
  const result = ark("run", "start", ticketFile, "--project", "demo");
  expect(result.code).toBe(0);
  const runId = result.out.trim();
  const directory = join(projectDirectory, "runs", runId);
  recordEvaluation(directory);
  return { runId, directory };
}

async function startUi(): Promise<{ process: Bun.Subprocess; baseUrl: string }> {
  const uiProcess = Bun.spawn(["bun", join(repositoryRoot, "cli", "ark.ts"), "ui", "--port", "0"], {
    env: {
      ...process.env,
      PATH: `${orcaDirectory}:${process.env.PATH}`,
      ARK_HOME: process.env.ARK_HOME,
    },
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
  return { process: uiProcess, baseUrl: `http://127.0.0.1:${port}` };
}

async function withUi<T>(callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await startUi();
  try {
    return await callback(server.baseUrl);
  } finally {
    server.process.kill();
    await server.process.exited;
  }
}

async function waitForOrca(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = (await (await fetch(`${baseUrl}/api/state`)).json()) as {
      readers: { orca: string };
    };
    if (state.readers.orca === "ok") return;
    await Bun.sleep(100);
  }
  throw new Error("hub Orca refresh did not settle");
}

async function detail(baseUrl: string, runId: string): Promise<RunDetail> {
  const response = await fetch(`${baseUrl}/api/runs/${runId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as RunDetail;
}

type EventRecord = { time: string; type: string };

function setRunStart(directory: string, time: number): void {
  const file = join(directory, "events.ndjson");
  const events = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as EventRecord);
  events[0].time = new Date(time).toISOString();
  writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function readyForBuild(directory: string): void {
  writeFileSync(join(directory, "plan.yml"), "steps: []\n");
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps: [],
  });
  appendEvent(directory, "gate.answered", { gate: "plan", answer: "approve" });
}

function addSession(root: string, relativePath: string, contents: string): void {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function setOrcaRun(runId: string, workers: object[], tasks: object[]): void {
  writeFileSync(
    join(orcaStateDirectory, "run-list"),
    JSON.stringify({
      result: {
        runs: [
          { id: `orca-${runId}`, objective: `Ark run ${runId}`, coordinator_handle: "term_lead" },
        ],
      },
    }),
  );
  writeFileSync(join(orcaStateDirectory, "worker-list"), JSON.stringify({ result: { workers } }));
  writeFileSync(join(orcaStateDirectory, "task-list"), JSON.stringify({ result: { tasks } }));
}

function setEventTimes(directory: string, replacements: Record<string, string[]>): void {
  const file = join(directory, "events.ndjson");
  const events = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as EventRecord);
  for (const [type, times] of Object.entries(replacements)) {
    let index = 0;
    for (const event of events) if (event.type === type) event.time = times[index++];
  }
  writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

test("ARK-179-AC1 run detail returns phase times, gate waits and both step rounds", async () => {
  const run = startRun("ARK-179-TIMELINE");
  const start = Date.now() - 90_000;
  readyForBuild(run.directory);
  appendEvent(run.directory, "step.started", {
    step: "build",
    role: "implementer",
    repo: ".",
    round: 1,
  });
  appendEvent(run.directory, "step.finished", { step: "build", outcome: "failed" });
  appendEvent(run.directory, "step.started", {
    step: "build",
    role: "implementer",
    repo: ".",
    round: 2,
  });
  appendEvent(run.directory, "test.completed", { passed: true, criteria: {}, suites: [] });
  const times = [10, 20, 30, 40, 50, 60].map((seconds) =>
    new Date(start + seconds * 1000).toISOString(),
  );
  setEventTimes(run.directory, {
    "plan.checked": [times[0]],
    "gate.answered": [times[1]],
    "step.started": [times[2], times[4]],
    "step.finished": [times[3]],
    "test.completed": [times[5]],
  });

  await withUi(async (baseUrl) => {
    const result = await detail(baseUrl, run.runId);
    expect(result.timeline.map((row) => row.at)).toContain(times[1]);
    expect(result.gates).toContainEqual(
      expect.objectContaining({
        gate: "plan",
        asked: times[0],
        answered: times[1],
        wait_seconds: 10,
      }),
    );
    expect(result.rounds).toEqual([
      { round: 1, at: times[2], steps: ["build"] },
      { round: 2, at: times[4], steps: ["build"] },
    ]);
  });
});

test("ARK-179-AC2 run detail joins AC results to suite reports and marks a missing report unavailable", async () => {
  const run = startRun("ARK-179-PROOF", [
    { id: "ARK-179-AC1", text: "Pass" },
    { id: "ARK-179-AC2", text: "Fail" },
  ]);
  readyForBuild(run.directory);
  appendEvent(run.directory, "test.completed", {
    passed: false,
    criteria: { "ARK-179-AC1": "passed", "ARK-179-AC2": "failed" },
    suites: [
      { name: "cli", level: "integration" },
      { name: "missing", level: "integration" },
    ],
  });
  mkdirSync(join(run.directory, "results"), { recursive: true });
  writeFileSync(
    join(run.directory, "results", "cli.report"),
    '<testsuite><testcase name="ARK-179-AC1 accepts valid input"/><testcase name="ARK-179-AC2 rejects invalid input"><failure/></testcase></testsuite>',
  );
  await withUi(async (baseUrl) => {
    const result = await detail(baseUrl, run.runId);
    if (result.ac_proof.state !== "ok") throw new Error("test proof was unavailable");
    const firstCriterion = result.ac_proof.criteria.find(
      (criterion) => criterion.id === "ARK-179-AC1",
    );
    const secondCriterion = result.ac_proof.criteria.find(
      (criterion) => criterion.id === "ARK-179-AC2",
    );
    expect(firstCriterion?.status).toBe("passed");
    expect(firstCriterion?.cases).toContainEqual(
      expect.objectContaining({
        name: "ARK-179-AC1 accepts valid input",
        status: "passed",
        report: "results/cli.report",
      }),
    );
    expect(secondCriterion?.status).toBe("failed");
    expect(secondCriterion?.cases).toContainEqual(
      expect.objectContaining({
        name: "ARK-179-AC2 rejects invalid input",
        status: "failed",
        report: "results/cli.report",
      }),
    );
    expect(secondCriterion?.cases).toContainEqual(
      expect.objectContaining({ status: "unavailable", report: "results/missing.report" }),
    );
  });
});

test("ARK-179-AC3 run detail uses shared OMP, Claude and Codex usage with unknown cost and wall time", async () => {
  const run = startRun("ARK-179-COST");
  readyForBuild(run.directory);
  appendEvent(run.directory, "step.started", {
    step: "build",
    role: "implementer",
    repo: "repos/platform",
    round: 1,
  });
  writeFileSync(
    join(run.directory, "plan.yml"),
    "steps:\n  - id: build\n    role: implementer\n    repo: repos/platform\n    needs: []\n    criteria: [ARK-179-AC1]\n",
  );
  const currentTime = new Date().toISOString();
  const omp = readFileSync(join(import.meta.dir, "fixtures", "retro", "omp", "build.jsonl"), "utf8")
    .replaceAll("__RUN__", run.directory)
    .replaceAll(/2026-10-29T[^"]+/g, currentTime);
  const claude = readFileSync(
    join(import.meta.dir, "fixtures", "retro", "claude", "lead.jsonl"),
    "utf8",
  ).replaceAll("__RUN__", run.directory);
  addSession(ompDirectory, "workspace/session-build.jsonl", omp);
  addSession(claudeDirectory, "workspace/session-lead.jsonl", claude);
  const codexRecords = [
    { type: "session_meta", payload: { cwd: run.directory, model_provider: "openai" } },
    { type: "turn_context", payload: { model: "codex-test" } },
    {
      type: "event_msg",
      timestamp: currentTime,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 20, output_tokens: 5 },
          total_token_usage: { total_tokens: 25 },
        },
      },
    },
  ];
  addSession(
    codexDirectory,
    "2026/11/01/rollout.jsonl",
    `${codexRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  setOrcaRun(
    run.runId,
    [
      {
        taskId: "task-build",
        agentTerminalHandle: "term-build",
        projection: { liveness: { verdict: "live" } },
      },
    ],
    [{ id: "task-build", task_title: "build" }],
  );

  await withUi(async (baseUrl) => {
    await waitForOrca(baseUrl);
    const result = await detail(baseUrl, run.runId);
    expect(result.cost).toMatchObject({ usd: "unknown", tokens: 99_105 });
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        id: "build",
        cost: expect.objectContaining({ usd: expect.any(Number), tokens: 32_120 }),
        wall_seconds: expect.any(Number),
      }),
    );
    expect(result.agents.length).toBeGreaterThan(0);
    expect(
      result.agents.every(
        (agent) => typeof agent.wall_seconds === "number" || agent.wall_seconds === "unknown",
      ),
    ).toBe(true);
    expect(
      result.agents.every(
        (agent) =>
          typeof agent.cost === "string" || ("tokens" in agent.cost && "usd" in agent.cost),
      ),
    ).toBe(true);
  });
});

test("ARK-179-AC4 run detail returns the last 20 lines and unknown for a failed Orca read", async () => {
  const run = startRun("ARK-179-OUTPUT");
  readyForBuild(run.directory);
  appendEvent(run.directory, "step.started", {
    step: "build",
    role: "implementer",
    repo: ".",
    round: 1,
  });
  setOrcaRun(
    run.runId,
    [
      {
        taskId: "task-one",
        agentTerminalHandle: "term-good",
        projection: { liveness: { verdict: "live" } },
      },
      {
        taskId: "task-two",
        agentTerminalHandle: "term-bad",
        projection: { liveness: { verdict: "live" } },
      },
    ],
    [
      { id: "task-one", task_title: "build" },
      { id: "task-two", task_title: "review" },
    ],
  );
  const lines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
  writeFileSync(orcaTailFile, JSON.stringify(lines));
  process.env.ORCA_READ_FAIL_HANDLE = "term-bad";
  const started = Date.now();
  await withUi(async (baseUrl) => {
    await waitForOrca(baseUrl);
    const result = await detail(baseUrl, run.runId);
    expect(result.agents.find((agent) => agent.terminal === "term-good")?.output).toEqual(
      lines.slice(-20),
    );
    expect(result.agents.find((agent) => agent.terminal === "term-bad")?.output).toBe("unknown");
  });
  expect(Date.now() - started).toBeLessThan(5000);
});

test("ARK-179-AC5 run detail splits gate, CI, paused, stalled and working time into the wall interval", async () => {
  const run = startRun("ARK-179-TIME");
  const start = Date.now() - 100_000;
  setRunStart(run.directory, start);
  readyForBuild(run.directory);
  setEventTimes(run.directory, {
    "plan.checked": [new Date(start + 40_000).toISOString()],
    "gate.answered": [new Date(start + 50_000).toISOString()],
  });
  writeFileSync(
    join(run.directory, "history.ndjson"),
    [
      { time: new Date(start + 10_000).toISOString(), kind: "ci", subject: "mr", state: "pending" },
      { time: new Date(start + 20_000).toISOString(), kind: "ci", subject: "mr", state: "passing" },
      {
        time: new Date(start + 30_000).toISOString(),
        kind: "liveness",
        subject: "term",
        state: "paused",
      },
      {
        time: new Date(start + 40_000).toISOString(),
        kind: "liveness",
        subject: "term",
        state: "live",
      },
      {
        time: new Date(start + 60_000).toISOString(),
        kind: "liveness",
        subject: "term",
        state: "stuck",
      },
      {
        time: new Date(start + 70_000).toISOString(),
        kind: "liveness",
        subject: "term",
        state: "live",
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );

  await withUi(async (baseUrl) => {
    const result = await detail(baseUrl, run.runId);
    expect(result.time_split).toMatchObject({ waiting_human: 10, waiting_ci_or_paused: 20 });
    expect(result.time_split.working).toBeGreaterThan(0);
    expect(result.time_split.stalled).toBeGreaterThan(0);
    const total = Object.values(result.time_split).reduce((sum, seconds) => sum + seconds, 0);
    expect(Math.abs(total - result.wall_seconds)).toBeLessThan(0.01);
  });
});

test("ARK-179-AC5 run detail marks pre-collection time unavailable and records the stuck interval", async () => {
  await withUi(async (baseUrl) => {
    const run = startRun("ARK-179-UNCOLLECTED");
    const start = Date.now() - 30_000;
    setRunStart(run.directory, start);
    setOrcaRun(
      run.runId,
      [
        {
          taskId: "task-stuck",
          agentTerminalHandle: "term-stuck",
          projection: { liveness: { verdict: "stuck" } },
        },
      ],
      [{ id: "task-stuck", task_title: "stuck step" }],
    );
    const before = await detail(baseUrl, run.runId);
    expect(before.time_split.unavailable).toBeGreaterThan(0);
    expect(before.time_split.working).toBe(0);
    // The UI polls Orca on its real three-second refresh cadence; wait for its durable history write.
    for (
      let attempt = 0;
      attempt < 40 && !existsSync(join(run.directory, "history.ndjson"));
      attempt++
    )
      await Bun.sleep(100);
    const history = readFileSync(join(run.directory, "history.ndjson"), "utf8");
    const after = await detail(baseUrl, run.runId);
    expect(history).toMatch(/"time":"[^"]+".*"kind":"liveness".*"state":"stuck"/);
    expect(after.time_split.unavailable).toBeGreaterThan(0);
    expect(after.time_split.working).toBe(0);
    expect(after.time_split.stalled).toBeGreaterThan(0);
  });
});

test("ARK-179-AC6 run detail renders plan and returns available evaluation and strategy cards", async () => {
  const without = startRun("ARK-179-FILES-A");
  const withFiles = startRun("ARK-179-FILES-B");
  writeFileSync(join(without.directory, "plan.md"), "# Plan\n\nRendered plan body.\n");
  writeFileSync(join(withFiles.directory, "plan.md"), "# Plan\n\nSecond plan.\n");
  writeFileSync(
    join(withFiles.directory, "evaluation.md"),
    "## Risks\n\n- CI can lag.\n\n## Blockers\n\n## Surfaces\n\n- web_ui\n",
  );
  writeFileSync(
    join(withFiles.directory, "strategies.md"),
    "## S1 Run detail\n\nApproach: Existing hub\n\nMockup: mockups/detail.html\n\nRecommended: yes\n",
  );
  mkdirSync(join(withFiles.directory, "mockups"), { recursive: true });
  writeFileSync(join(withFiles.directory, "mockups", "detail.html"), "<h1>Detail</h1>");
  await withUi(async (baseUrl) => {
    const missing = await detail(baseUrl, without.runId);
    const available = await detail(baseUrl, withFiles.runId);
    if (missing.plan.state !== "ok") throw new Error("plan was unavailable");
    expect(missing.plan.html).toContain("Rendered plan body.");
    expect(missing.evaluation).toEqual({ state: "not available" });
    expect(missing.strategies).toEqual({ state: "not available" });
    if (available.evaluation.state !== "ok") throw new Error("evaluation was unavailable");
    if (available.strategies.state !== "ok") throw new Error("strategies were unavailable");
    expect(available.evaluation.risks).toContain("CI can lag.");
    expect(available.strategies.cards).toContainEqual(
      expect.objectContaining({
        recommended: true,
        mockups: [{ path: "mockups/detail.html", exists: true }],
      }),
    );
  });
});

test(
  "ARK-179-AC7 headless run detail shows every panel and refreshes step state and output without reload",
  { timeout: 30_000 },
  async () => {
    const run = startRun("ARK-179-PAGE", [{ id: "ARK-179-AC1", text: "Build succeeds" }]);
    readyForBuild(run.directory);
    writeFileSync(join(run.directory, "plan.md"), "# Detail plan\n");
    writeFileSync(
      join(run.directory, "evaluation.md"),
      "## Risks\n\n- Delayed CI\n\n## Blockers\n\n## Surfaces\n\n- web_ui\n",
    );
    writeFileSync(
      join(run.directory, "strategies.md"),
      "## S1 Simple\n\nApproach: Build\n\nMockup: mockups/detail.html\n",
    );
    mkdirSync(join(run.directory, "results"), { recursive: true });
    writeFileSync(
      join(run.directory, "results", "cli.report"),
      '<testsuite><testcase name="ARK-179-AC1 build works"/></testsuite>',
    );
    appendEvent(run.directory, "test.completed", {
      passed: true,
      criteria: { "ARK-179-AC1": "passed" },
      suites: [{ name: "cli", level: "integration" }],
    });
    appendEvent(run.directory, "step.started", {
      step: "build",
      role: "implementer",
      repo: ".",
      round: 1,
    });
    writeFileSync(
      join(run.directory, "plan.yml"),
      "steps:\n  - id: build\n    role: implementer\n    repo: .\n    needs: []\n    criteria: [ARK-179-AC1]\n",
    );
    setOrcaRun(
      run.runId,
      [
        {
          taskId: "task-build",
          agentTerminalHandle: "term-build",
          projection: { liveness: { verdict: "live" } },
        },
      ],
      [{ id: "task-build", task_title: "build" }],
    );
    writeFileSync(orcaTailFile, JSON.stringify(["first output"]));
    await using view = new Bun.WebView({ backend: "chrome", width: 1440, height: 1000 });
    await withUi(async (baseUrl) => {
      await waitForOrca(baseUrl);
      await view.navigate(`${baseUrl}/#run=${run.runId}`);
      const detailSelector = `[data-run-detail="${run.runId}"]`;
      for (let attempt = 0; attempt < 40; attempt++) {
        if (await view.evaluate(`document.querySelector('${detailSelector}') !== null`)) break;
        await Bun.sleep(100);
      }
      expect(await view.evaluate(`document.querySelector('${detailSelector}') !== null`)).toBe(
        true,
      );
      const sections = (await view.evaluate(
        `Array.from(document.querySelectorAll('${detailSelector} [data-detail-section]')).map((element) => element.getAttribute('data-detail-section'))`,
      )) as string[];
      expect(sections).toEqual(
        expect.arrayContaining([
          "timeline",
          "step-graph",
          "step-list",
          "ac-proof",
          "plan",
          "strategies",
          "evaluation",
          "live-agents",
          "time-split",
          "run-lead-message",
        ]),
      );
      expect(
        await view.evaluate(
          `document.querySelector('${detailSelector} [data-detail-cost]') !== null`,
        ),
      ).toBe(true);
      expect(
        await view.evaluate(
          `document.querySelector('${detailSelector} [data-output="lines"]').textContent`,
        ),
      ).toContain("first output");
      expect(
        await view.evaluate(
          `document.querySelector('${detailSelector} [data-slot="run-lead-message"]') !== null`,
        ),
      ).toBe(true);
      const pageUrl = await view.evaluate("location.href");
      appendEvent(run.directory, "step.finished", { step: "build", outcome: "succeeded" });
      writeFileSync(orcaTailFile, JSON.stringify(["updated output"]));
      for (let attempt = 0; attempt < 80; attempt++) {
        const currentText = (await view.evaluate("document.body.innerText")) as string;
        const stepState = await view.evaluate(
          `document.querySelector('${detailSelector} [data-step-node="build"] span').textContent`,
        );
        if (currentText.includes("updated output") && stepState === "implementer · succeeded")
          break;
        await Bun.sleep(100);
      }
      const updated = (await view.evaluate("document.body.innerText")) as string;
      expect(updated).toContain("updated output");
      expect(
        await view.evaluate(
          `document.querySelector('${detailSelector} [data-step-node="build"] span').textContent`,
        ),
      ).toBe("implementer · succeeded");
      expect(await view.evaluate("location.href")).toBe(pageUrl);
    });
  },
);
