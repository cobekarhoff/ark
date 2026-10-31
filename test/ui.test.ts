import { beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers.ts";

const repositoryRoot = join(import.meta.dir, "..");
let projectDirectory: string;
let orcaBinDirectory: string;

beforeEach(() => {
  delete process.env.ORCA_FAIL;
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
  orcaBinDirectory = mkdtempSync(join(tmpdir(), "ark-orca-"));
  const fakeOrca = join(orcaBinDirectory, "orca");
  writeFileSync(
    fakeOrca,
    `#!/bin/sh
if [ "$ORCA_FAIL" = "1" ]; then exit 1; fi
if [ "$1" = "terminal" ]; then printf '{"result":{"terminal":{"connected":true,"agentIdentity":"omp"}}}'; exit 0; fi
case "$2" in
  run-list) printf '{"result":{"runs":%s}}' "$ORCA_RUNS" ;;
  task-list) printf '{"result":{"tasks":%s}}' "$ORCA_TASKS" ;;
  worker-list) printf '{"result":{"workers":%s}}' "$ORCA_WORKERS" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(fakeOrca, 0o755);
  process.env.PATH = `${orcaBinDirectory}:${process.env.PATH}`;
});

function startRun(ticketId: string, title: string): { runId: string; directory: string } {
  const ticketFile = writeTicket(
    "demo",
    ticketId,
    [{ id: `${ticketId}-AC1`, text: "It works" }],
    title,
  );
  const result = ark("run", "start", ticketFile, "--project", "demo");
  expect(result.code).toBe(0);
  const runId = result.out.trim();
  return { runId, directory: join(projectDirectory, "runs", runId) };
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
  writeFileSync(join(directory, "plan.yml"), "steps: []\n");
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps: [{ id: "build", role: "implementer", repo: "." }],
  });
}

test("ARK-168-AC1 documents the control center, Orca, and Plannotator split", () => {
  const adr = Bun.file(join(repositoryRoot, "docs/adr/0007-control-center.md"));
  const prd = Bun.file(join(repositoryRoot, "docs/prd.md"));
  const earlierAdr = Bun.file(
    join(repositoryRoot, "docs/adr/0002-gate-answers-need-a-terminal.md"),
  );
  return Promise.all([adr.text(), prd.text(), earlierAdr.text()]).then(
    ([adrText, prdText, earlierAdrText]) => {
      expect(adrText).toContain("**Ark control center** (`ark ui`) is the high-level view");
      expect(adrText).toContain("**Orca** is where the human watches agents work");
      expect(adrText).toContain("**Plannotator** is where the human answers gates");
      expect(adrText).toContain("ADR 0002 is unchanged.");
      expect(prdText).toContain(
        "Orca shows agents, Plannotator takes gate answers, and Ark may show a read-only overview (ADR 0007).",
      );
      expect(earlierAdrText).toContain(
        "Human answers require an Oh My Pi (OMP) ask or a controlling terminal",
      );
      expect(earlierAdrText).toContain("Missing or malformed proof refuses everywhere.");
    },
  );
});

type Hub = {
  runs: Record<string, any>[];
  needs_me: Record<string, any>[];
  readers: { orca: string };
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
