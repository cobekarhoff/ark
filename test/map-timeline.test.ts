import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers.ts";

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

describe.serial("map and timeline integration tests", () => {
  beforeEach(() => {
    for (const name of [
      "ORCA_FAIL",
      "ORCA_RUN_LIST_FAIL",
      "ORCA_ACTION_LOG",
      "PLANNOTATOR_DATA_DIR",
      "GH_CHECKS",
      "GH_CHECKS_FILE",
      "ORCA_WORKERS_FILE",
      "ARK_CODEX_SESSIONS",
      "ARK_OMP_SESSIONS",
    ])
      delete process.env[name];
    tempArkHome();
    projectDirectory = writeProject("demo", projectConfigFor(tempGitRepo()));
    orcaBinDirectory = mkdtempSync(join(tmpdir(), "ark-map-orca-"));
    process.env.ORCA_TERMINALS = "[]";
    process.env.ORCA_RUNS = "[]";
    process.env.ORCA_TASKS = "[]";
    process.env.ORCA_WORKERS = "[]";
    const orca = join(orcaBinDirectory, "orca");
    writeFileSync(
      orca,
      `#!/bin/sh
if [ "$ORCA_FAIL" = "1" ]; then exit 1; fi
if [ "$1" = "terminal" ]; then
  case "$2" in
    show) printf '{"result":{"terminal":{"connected":true,"agentIdentity":"omp"}}}' ;;
    list) printf '{"result":{"terminals":%s}}' "$ORCA_TERMINALS" ;;
    switch) printf '%s\\\\n' "$*" >> "$ORCA_ACTION_LOG"; printf '{"result":{}}' ;;
    *) exit 2 ;;
  esac
  exit 0
fi
case "$2" in
  run-list) if [ "$ORCA_RUN_LIST_FAIL" = "1" ]; then exit 1; fi; printf '{"result":{"runs":%s}}' "$ORCA_RUNS" ;;
  task-list) printf '{"result":{"tasks":%s}}' "$ORCA_TASKS" ;;
  worker-list)
    if [ -n "$ORCA_WORKERS_FILE" ]; then
      printf '{"result":{"workers":'
      cat "$ORCA_WORKERS_FILE"
      printf '}}'
    else
      printf '{"result":{"workers":%s}}' "$ORCA_WORKERS"
    fi
    ;;
  *) exit 2 ;;
esac
`,
    );
    chmodSync(orca, 0o755);
    const gh = join(orcaBinDirectory, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
if [ -n "$GH_CHECKS_FILE" ]; then cat "$GH_CHECKS_FILE"; else printf '%s' "$GH_CHECKS"; fi
`,
    );
    chmodSync(gh, 0o755);
    process.env.PATH = `${orcaBinDirectory}:${process.env.PATH}`;
  });

  function startRun(ticketId: string, title = ticketId): { runId: string; directory: string } {
    const ticketFile = writeTicket(
      "demo",
      ticketId,
      [{ id: `${ticketId}-AC1`, text: "It works" }],
      title,
    );
    const result = ark("run", "start", ticketFile, "--project", "demo");
    if (result.code !== 0) throw new Error(`ark run start failed: ${result.out}\n${result.err}`);
    const runId = result.out.trim();
    const directory = join(projectDirectory, "runs", runId);
    appendEvent(directory, "evaluation.recorded", { blockers: [], risks: [], surfaces: ["none"] });
    appendEvent(directory, "strategy.recorded", {
      count: 1,
      recommended: "S1",
      cards: ["S1"],
      reason: "only approach",
      card_text: { S1: "Only" },
    });
    return { runId, directory };
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

  function setEventTime(directory: string, type: string, time: string): void {
    const eventFile = join(directory, "events.ndjson");
    const events = readFileSync(eventFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const event = events.find((candidate) => candidate.type === type);
    if (!event) throw new Error(`missing ${type}`);
    event.time = time;
    writeFileSync(eventFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  }

  function setOrca(runIds: string[], workers: object[] = [], tasks: object[] = []): void {
    process.env.ORCA_RUNS = JSON.stringify(
      runIds.map((runId) => ({
        id: `orca-${runId}`,
        objective: `Ark run ${runId}`,
        coordinator_handle: "term_lead",
      })),
    );
    process.env.ORCA_WORKERS = JSON.stringify(workers);
    process.env.ORCA_TASKS = JSON.stringify(tasks);
  }

  async function startUi(): Promise<{ process: Bun.Subprocess; baseUrl: string }> {
    const uiProcess = Bun.spawn(
      ["bun", join(repositoryRoot, "cli", "ark.ts"), "ui", "--port", "0"],
      {
        env: { ...process.env, ARK_HOME: process.env.ARK_HOME },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
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
    const uiServer = await startUi();
    try {
      return await callback(uiServer.baseUrl);
    } finally {
      uiServer.process.kill();
      await uiServer.process.exited;
    }
  }

  async function waitForBrowserValue<T>(
    view: InstanceType<typeof Bun.WebView>,
    expression: string,
  ): Promise<T> {
    return (await view.evaluate(`(() => {
    const { promise, resolve } = Promise.withResolvers();
    const observer = new MutationObserver(() => {
      const value = (${expression});
      if (value) { observer.disconnect(); resolve(value); }
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true });
    const value = (${expression});
    if (value) { observer.disconnect(); resolve(value); }
    return promise;
  })()`)) as T;
  }
  async function waitForAgentState(
    baseUrl: string,
    title: string,
    liveness: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = (await (await fetch(`${baseUrl}/api/state`)).json()) as {
        agents: { title: string; liveness: string }[];
      };
      if (state.agents.some((agent) => agent.title === title && agent.liveness === liveness))
        return;
      await Bun.sleep(50);
    }
    throw new Error(`Orca never reported ${title} as ${liveness}`);
  }

  function writeHistory(events: Record<string, unknown>[]): void {
    const directory = join(process.env.ARK_HOME as string, "hub");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "history.ndjson"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  }

  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  test("ARK-180-AC1 map API returns every node kind, node states and needs-you counts", async () => {
    const run = startRun("ARK-180-MAP1", "Map graph");
    planGate(run.directory);
    appendEvent(run.directory, "gate.answered", { gate: "plan", answer: "approve" });
    appendEvent(run.directory, "step.started", {
      step: "build",
      role: "implementer",
      repo: ".",
      round: 1,
    });
    appendEvent(run.directory, "merge_request.opened", {
      repo: ".",
      url: "https://example.test/pull/18",
      number: 18,
    });
    const waitingRun = startRun("ARK-180-MAP1B", "Waiting run");
    planGate(waitingRun.directory);
    setOrca(
      [run.runId, waitingRun.runId],
      [
        {
          dispatchId: "dispatch",
          taskId: "task",
          agentTerminalHandle: "term_worker",
          projection: { liveness: { verdict: "stuck" } },
        },
      ],
      [{ id: "task", task_title: "stuck worker" }],
    );
    process.env.ORCA_TERMINALS = JSON.stringify([
      {
        handle: "term_lead",
        connected: true,
        worktreePath: JSON.parse(readFileSync(join(projectDirectory, "ark.yml"), "utf8")).workspace,
        agentIdentity: "omp",
      },
    ]);
    await withUi(async (baseUrl) => {
      await waitForAgentState(baseUrl, "stuck worker", "stuck");
      const response = await fetch(`${baseUrl}/api/map`);
      const graph = (await response.json()) as { nodes: Record<string, unknown>[] };
      expect(response.status).toBe(200);
      expect(graph.nodes.map((node) => node.kind)).toEqual(
        expect.arrayContaining(["project", "chief", "run", "step", "agent", "mr"]),
      );
      expect(
        graph.nodes.every(
          (node) => typeof node.state === "string" && typeof node.needs_you === "number",
        ),
      ).toBe(true);
      expect(graph.nodes.find((node) => node.id === `run:${waitingRun.runId}`)).toMatchObject({
        needs_you: 2,
      });
      expect(graph.nodes.find((node) => node.id === `run:${run.runId}`)).toMatchObject({
        needs_you: 1,
      });
      expect(graph.nodes.find((node) => node.id === `step:${run.runId}:build`)).toMatchObject({
        state: "running",
        needs_you: 0,
      });
      expect(
        graph.nodes.find((node) => node.id === `agent:${run.runId}:term_worker`),
      ).toMatchObject({
        state: "stuck",
      });
    });
  });

  test("ARK-180-AC1 map API retains event runs and reports unknown liveness when Orca fails", async () => {
    const run = startRun("ARK-180-MAP2");
    setOrca([run.runId]);
    process.env.ORCA_FAIL = "1";
    await withUi(async (baseUrl) => {
      const graph = (await (await fetch(`${baseUrl}/api/map`)).json()) as {
        nodes: Record<string, unknown>[];
      };
      expect(graph.nodes.some((node) => node.id === `run:${run.runId}`)).toBe(true);
      expect(graph.nodes.find((node) => node.kind === "agent")).toMatchObject({ state: "unknown" });
      expect(graph.nodes.find((node) => node.kind === "chief")).toMatchObject({ state: "unknown" });
    });
  });

  test("ARK-180-AC2 map API reconstructs a past step and marks later runs not_started", async () => {
    const first = startRun("ARK-180-PAST1");
    planGate(first.directory);
    appendEvent(first.directory, "gate.answered", { gate: "plan", answer: "approve" });
    appendEvent(first.directory, "step.started", {
      step: "build",
      role: "implementer",
      repo: ".",
      round: 1,
    });
    appendEvent(first.directory, "step.finished", { step: "build", outcome: "succeeded" });
    setEventTime(first.directory, "run.started", at(50));
    setEventTime(first.directory, "evaluation.recorded", at(49));
    setEventTime(first.directory, "strategy.recorded", at(48));
    setEventTime(first.directory, "plan.checked", at(40));
    setEventTime(first.directory, "gate.answered", at(35));
    setEventTime(first.directory, "step.started", at(30));
    setEventTime(first.directory, "step.finished", at(10));
    const second = startRun("ARK-180-PAST2");
    setEventTime(second.directory, "run.started", at(1));
    const chosenTime = at(5);
    writeFileSync(
      join(process.env.ARK_HOME as string, "hub.json"),
      JSON.stringify({ last_seen: at(60) }),
    );
    await withUi(async (baseUrl) => {
      const graph = (await (
        await fetch(`${baseUrl}/api/map?at=${encodeURIComponent(chosenTime)}`)
      ).json()) as { nodes: Record<string, unknown>[] };
      expect(graph.nodes.find((node) => node.id === `step:${first.runId}:build`)).toMatchObject({
        state: "succeeded",
      });
      expect(graph.nodes.find((node) => node.id === `run:${second.runId}`)).toMatchObject({
        state: "not_started",
      });
    });
  });

  test("ARK-180-AC2 map API leaves replay start absent without a saved visit and rejects pre-event time as not_started", async () => {
    const run = startRun("ARK-180-PAST3");
    const firstEvent = at(5);
    setEventTime(run.directory, "run.started", at(1));
    setEventTime(run.directory, "evaluation.recorded", at(0.8));
    setEventTime(run.directory, "strategy.recorded", at(0.6));
    // Set run start before all subsequent events; query before it.
    setEventTime(run.directory, "run.started", firstEvent);
    await withUi(async (baseUrl) => {
      const graph = (await (
        await fetch(`${baseUrl}/api/map?at=${encodeURIComponent(at(10))}`)
      ).json()) as { replay: Record<string, unknown>; nodes: Record<string, unknown>[] };
      expect(graph.replay).not.toHaveProperty("from");
      expect(graph.nodes.find((node) => node.id === `run:${run.runId}`)).toMatchObject({
        state: "not_started",
      });
    });
  });

  test("ARK-180-AC2 map API labels history outside collection and in a restart gap unavailable", async () => {
    const run = startRun("ARK-180-HISTORY1");
    const collectionStart = at(90);
    const lastTick = at(60);
    const restart = at(30);
    const stuck = at(80);
    writeHistory([
      { seq: 1, time: collectionStart, type: "collector.started" },
      {
        seq: 2,
        time: stuck,
        type: "state.changed",
        key: `agent:${run.runId}:term_worker`,
        state: "stuck",
      },
      { seq: 3, time: lastTick, type: "collector.tick" },
      { seq: 4, time: restart, type: "collector.started" },
    ]);
    await withUi(async (baseUrl) => {
      const getGraph = async (minutesAgo: number) =>
        (await (
          await fetch(`${baseUrl}/api/map?at=${encodeURIComponent(at(minutesAgo))}`)
        ).json()) as { nodes: Record<string, unknown>[] };
      expect((await getGraph(120)).nodes.find((node) => node.kind === "agent")?.state).toBe(
        "unavailable",
      );
      expect((await getGraph(75)).nodes.find((node) => node.kind === "agent")?.state).toBe("stuck");
      expect((await getGraph(45)).nodes.find((node) => node.kind === "agent")?.state).toBe(
        "unavailable",
      );
    });
  });

  test(
    "ARK-180-AC3 history collector logs agent and CI changes once across unchanged refreshes",
    { timeout: 30_000 },
    async () => {
      const run = startRun("ARK-180-COLLECT1");
      planGate(run.directory);
      appendEvent(run.directory, "gate.answered", { gate: "plan", answer: "approve" });
      appendEvent(run.directory, "merge_request.opened", {
        repo: ".",
        url: "https://example.test/pull/30",
        number: 30,
      });
      const worker = {
        taskId: "task",
        agentTerminalHandle: "term_worker",
        projection: { liveness: { verdict: "live" }, stage: { activity: "working" } },
      };
      const fixtureDirectory = mkdtempSync(join(tmpdir(), "ark-history-refresh-"));
      const workerFile = join(fixtureDirectory, "workers.json");
      const checksFile = join(fixtureDirectory, "checks.json");
      writeFileSync(workerFile, JSON.stringify([worker]));
      writeFileSync(checksFile, '[{"bucket":"pending"}]');
      process.env.ORCA_WORKERS_FILE = workerFile;
      process.env.GH_CHECKS_FILE = checksFile;
      setOrca([run.runId], [], [{ id: "task", task_title: "worker" }]);
      process.env.ORCA_TERMINALS = JSON.stringify([
        {
          handle: "term_lead",
          connected: true,
          worktreePath: JSON.parse(readFileSync(join(projectDirectory, "ark.yml"), "utf8"))
            .workspace,
          agentIdentity: "omp",
        },
      ]);
      await withUi(async (baseUrl) => {
        await waitForAgentState(baseUrl, "worker", "live");
        // The hub refreshes every three seconds; hold the source steady for two refreshes.
        await Bun.sleep(6_500);
        writeFileSync(
          workerFile,
          JSON.stringify([
            {
              ...worker,
              projection: { liveness: { verdict: "stuck" }, stage: { activity: "working" } },
            },
          ]),
        );
        writeFileSync(checksFile, '[{"bucket":"fail"}]');
        await waitForAgentState(baseUrl, "worker", "stuck");
        const entries = readFileSync(
          join(process.env.ARK_HOME as string, "hub", "history.ndjson"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string; key?: string; state?: string });
        expect(entries[0]?.type).toBe("collector.started");
        const changes = entries.filter((event) => event.type === "state.changed");
        expect(
          changes
            .filter((event) => event.key === `agent:${run.runId}:term_worker`)
            .map((event) => event.state),
        ).toEqual(["live", "stuck"]);
        expect(
          changes
            .filter((event) => event.key === "ci:https://example.test/pull/30")
            .map((event) => event.state),
        ).toEqual(["pending", "failing"]);
      });
    },
  );

  test("ARK-180-AC3 timeline API includes chief, run and standalone agent lanes with event and history segments", async () => {
    const run = startRun("ARK-180-TIME1");
    planGate(run.directory);
    appendEvent(run.directory, "gate.answered", { gate: "plan", answer: "approve" });
    appendEvent(run.directory, "step.started", {
      step: "build",
      role: "implementer",
      repo: ".",
      round: 1,
    });
    appendEvent(run.directory, "merge_request.opened", {
      repo: ".",
      url: "https://example.test/pull/1",
      number: 1,
    });
    setEventTime(run.directory, "run.started", at(300));
    setEventTime(run.directory, "plan.checked", at(290));
    setEventTime(run.directory, "gate.answered", at(280));
    setEventTime(run.directory, "step.started", at(270));
    setEventTime(run.directory, "merge_request.opened", at(260));
    const waitingRun = startRun("ARK-180-TIME1B");
    planGate(waitingRun.directory);
    const workspace = JSON.parse(readFileSync(join(projectDirectory, "ark.yml"), "utf8")).workspace;
    process.env.ORCA_TERMINALS = JSON.stringify([
      { handle: "term_lead", connected: true, worktreePath: workspace, agentIdentity: "omp" },
    ]);
    writeHistory([
      { seq: 1, time: at(320), type: "collector.started" },
      {
        seq: 2,
        time: at(250),
        type: "state.changed",
        key: `agent:${run.runId}:worker`,
        state: "stuck",
        activity: "working",
      },
      {
        seq: 3,
        time: at(240),
        type: "state.changed",
        key: "agent:old-run:standalone",
        state: "stuck",
        activity: "working",
      },
      {
        seq: 4,
        time: at(230),
        type: "state.changed",
        key: "ci:https://example.test/pull/1",
        state: "pending",
      },
    ]);
    await withUi(async (baseUrl) => {
      const timeline = (await (await fetch(`${baseUrl}/api/timeline?hours=12`)).json()) as {
        lanes: { id: string; kind: string; segments: { kind: string; to: string | null }[] }[];
      };
      expect(timeline.lanes.map((lane) => lane.kind)).toEqual(
        expect.arrayContaining(["chief", "run", "agent"]),
      );
      const runLane = timeline.lanes.find((lane) => lane.id === `run:${run.runId}`)!;
      expect(runLane.segments.map((segment) => segment.kind)).toEqual(
        expect.arrayContaining(["phase", "gate", "worker", "stall", "ci"]),
      );
      const waitingLane = timeline.lanes.find((lane) => lane.id === `run:${waitingRun.runId}`)!;
      expect(waitingLane.segments.find((segment) => segment.kind === "gate")?.to).toBeNull();
    });
  });

  test("ARK-180-AC3 timeline API applies each supported window and rejects unsupported hours", async () => {
    const run = startRun("ARK-180-TIME2");
    planGate(run.directory);
    appendEvent(run.directory, "gate.answered", { gate: "plan", answer: "approve" });
    appendEvent(run.directory, "step.started", {
      step: "build",
      role: "implementer",
      repo: ".",
      round: 1,
    });
    appendEvent(run.directory, "step.finished", { step: "build", outcome: "succeeded" });
    setEventTime(run.directory, "step.started", at(300));
    setEventTime(run.directory, "step.finished", at(299));
    await withUi(async (baseUrl) => {
      for (const hours of [1, 12, 24]) {
        const response = await fetch(`${baseUrl}/api/timeline?hours=${hours}`);
        expect(response.status).toBe(200);
        const timeline = (await response.json()) as {
          hours: number;
          lanes: { segments: { item?: string }[] }[];
        };
        expect(timeline.hours).toBe(hours);
        expect(
          timeline.lanes.find((lane) =>
            lane.segments.some((segment) => segment.item === `step:${run.runId}:build`),
          ) !== undefined,
        ).toBe(hours !== 1);
      }
      expect((await fetch(`${baseUrl}/api/timeline?hours=2`)).status).toBe(400);
    });
  });

  test("ARK-180-AC3 timeline API exposes rising priced usage and unknown Codex cost without estimating", async () => {
    const run = startRun("ARK-180-COST1");
    const ompRoot = mkdtempSync(join(tmpdir(), "ark-omp-"));
    const codexRoot = mkdtempSync(join(tmpdir(), "ark-codex-"));
    process.env.ARK_OMP_SESSIONS = ompRoot;
    process.env.ARK_CODEX_SESSIONS = codexRoot;
    mkdirSync(join(ompRoot, "sessions"), { recursive: true });
    writeFileSync(
      join(ompRoot, "sessions", "session.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "omp", timestamp: at(20), cwd: join(run.directory, "workspace") })}\n${JSON.stringify({ type: "message", id: "m1", timestamp: at(15), message: { role: "assistant", provider: "anthropic", model: "claude-sonnet", content: [], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } } })}\n`,
    );
    mkdirSync(join(codexRoot, "2026", "11", "01"), { recursive: true });
    writeFileSync(
      join(codexRoot, "2026", "11", "01", "rollout-session.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { cwd: join(run.directory, "workspace") } })}\n${JSON.stringify({ type: "event_msg", timestamp: at(10), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 40, output_tokens: 10 }, total_token_usage: { total_tokens: 50 } } } })}\n`,
    );
    await withUi(async (baseUrl) => {
      const timeline = (await (await fetch(`${baseUrl}/api/timeline?hours=12`)).json()) as {
        lanes: { id: string; cost: { usd: number | string; series: { usd: number | string }[] } }[];
      };
      const cost = timeline.lanes.find((lane) => lane.id === `run:${run.runId}`)!.cost;
      expect(cost.series.map((point) => point.usd)).toEqual([0.03, "unknown"]);
      expect(cost.usd).toBe("unknown");
    });
  });

  test(
    "ARK-180-AC4 Map selection lights connected path, dims unrelated nodes, and fills detail",
    { timeout: 30_000 },
    async () => {
      const run = startRun("ARK-180-MAPUI1", "Map selection");
      planGate(run.directory);
      appendEvent(run.directory, "gate.answered", { gate: "plan", answer: "approve" });
      appendEvent(run.directory, "step.started", {
        step: "build",
        role: "implementer",
        repo: ".",
        round: 1,
      });
      const other = startRun("ARK-180-MAPUI2", "Other run");
      planGate(other.directory);
      setOrca([run.runId, other.runId]);
      await using view = new Bun.WebView({ backend: "chrome", width: 1440, height: 1000 });
      await withUi(async (baseUrl) => {
        await view.navigate(baseUrl);
        await view.press("2");
        await waitForBrowserValue(
          view,
          `document.querySelector('[data-node="step:${run.runId}:build"]')?.dataset.node`,
        );
        await view.evaluate(
          `document.querySelector('[data-node="step:${run.runId}:build"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }))`,
        );
        const states = JSON.parse(
          await view.evaluate(
            `JSON.stringify({ selected: document.querySelector('[data-node="step:${run.runId}:build"]')?.dataset.lit, connected: document.querySelector('[data-node="run:${run.runId}"]')?.dataset.lit, unrelated: document.querySelector('[data-node="run:${other.runId}"]')?.dataset.lit, detail: document.querySelector('.app > aside.detail:not([hidden]) h2')?.textContent, cursor: document.querySelector('.node.cursor')?.dataset.node })`,
          ),
        );
        expect(states).toEqual({
          selected: "true",
          connected: "true",
          unrelated: "false",
          detail: "build",
          cursor: `step:${run.runId}:build`,
        });
        await waitForBrowserValue(
          view,
          `document.querySelector('[data-badge="run:${other.runId}"]') !== null`,
        );
        await view.evaluate(
          `document.querySelector('[data-badge="run:${other.runId}"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }))`,
        );
        expect(
          await view.evaluate(
            "document.querySelector('.app > aside.detail:not([hidden]) h2')?.textContent",
          ),
        ).toBe("ARK-180-MAPUI2");
      });
    },
  );

  test(
    "ARK-180-AC4 Map keyboard navigation, dimming and replay controls update the rendered graph",
    { timeout: 30_000 },
    async () => {
      const run = startRun("ARK-180-MAPKEY1");
      planGate(run.directory);
      appendEvent(run.directory, "gate.answered", { gate: "plan", answer: "approve" });
      appendEvent(run.directory, "step.started", {
        step: "build",
        role: "implementer",
        repo: ".",
        round: 1,
      });
      setEventTime(run.directory, "run.started", at(40));
      setEventTime(run.directory, "plan.checked", at(30));
      setEventTime(run.directory, "gate.answered", at(20));
      setEventTime(run.directory, "step.started", at(10));
      writeFileSync(
        join(process.env.ARK_HOME as string, "hub.json"),
        JSON.stringify({ last_seen: at(60) }),
      );
      setOrca([run.runId]);
      await using view = new Bun.WebView({ backend: "chrome", width: 1440, height: 1000 });
      await withUi(async (baseUrl) => {
        await view.navigate(baseUrl);
        await view.press("2");
        await waitForBrowserValue(view, "document.querySelector('[data-node]')?.dataset.node");
        await view.evaluate(
          `document.querySelector('[data-node="run:${run.runId}"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`,
        );
        await waitForBrowserValue(
          view,
          `document.querySelector('.node.cursor')?.dataset.node === 'run:${run.runId}'`,
        );
        await view.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }))`);
        await waitForBrowserValue(
          view,
          `document.querySelector('.node.cursor')?.dataset.node !== 'run:${run.runId}'`,
        );
        await view.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }))`);
        await waitForBrowserValue(
          view,
          `document.querySelector('.node.cursor')?.dataset.node === 'run:${run.runId}'`,
        );
        await view.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "v" }))`);
        await waitForBrowserValue(
          view,
          "!document.querySelector('.graph')?.classList.contains('dim')",
        );
        await view.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "v" }))`);
        await waitForBrowserValue(
          view,
          "document.querySelector('.graph')?.classList.contains('dim')",
        );
        const liveTime = await view.evaluate(
          "document.querySelector('[data-testid=asof]')?.textContent",
        );
        await view.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "[" }))`);
        await waitForBrowserValue(
          view,
          "document.querySelector('[data-testid=asof]')?.textContent !== 'live'",
        );
        const replayTime = await view.evaluate(
          "document.querySelector('[data-testid=asof]')?.textContent",
        );
        expect(replayTime).not.toBe(liveTime);
        await view.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "]" }))`);
        await view.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "l" }))`);
        await waitForBrowserValue(
          view,
          "document.querySelector('[data-testid=asof]')?.textContent === 'live'",
        );
      });
    },
  );

  test(
    "ARK-180-AC5 Timeline zoom cycles across supported windows and cost burn preserves unknown",
    { timeout: 30_000 },
    async () => {
      const run = startRun("ARK-180-TIMEUI1");
      planGate(run.directory);
      appendEvent(run.directory, "gate.answered", { gate: "plan", answer: "approve" });
      appendEvent(run.directory, "step.started", {
        step: "build",
        role: "implementer",
        repo: ".",
        round: 1,
      });
      setOrca([run.runId]);
      const codexRoot = mkdtempSync(join(tmpdir(), "ark-codex-ui-"));
      process.env.ARK_CODEX_SESSIONS = codexRoot;
      mkdirSync(join(codexRoot, "2026", "11", "01"), { recursive: true });
      writeFileSync(
        join(codexRoot, "2026", "11", "01", "rollout-ui.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { cwd: join(run.directory, "workspace") } })}\n${JSON.stringify({ type: "event_msg", timestamp: at(5), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 4, output_tokens: 2 }, total_token_usage: { total_tokens: 6 } } } })}\n`,
      );
      await using view = new Bun.WebView({ backend: "chrome", width: 1440, height: 1000 });
      await withUi(async (baseUrl) => {
        await view.navigate(baseUrl);
        await view.press("3");
        await waitForBrowserValue(view, "!!document.querySelector('[data-lane]')");
        for (const hours of ["24h", "1h", "12h"]) {
          await view.press("w");
          await waitForBrowserValue(
            view,
            `document.querySelector('[data-testid=window]')?.textContent === '${hours}'`,
          );
        }
        await view.press("b");
        await waitForBrowserValue(view, "!!document.querySelector('[data-testid=burn]')");
        expect(
          await view.evaluate("document.querySelector('[data-testid=burn]')?.textContent"),
        ).toContain("?");
      });
    },
  );

  test(
    "ARK-180-AC5 clicking an open Timeline gate runs its Plannotator action",
    { timeout: 30_000 },
    async () => {
      const run = startRun("ARK-180-GATEUI1", "Gate action");
      planGate(run.directory);
      writeFileSync(join(run.directory, "plan.md"), "# Plan\n");
      writeFileSync(join(run.directory, "plan.yml"), "steps: []\n");
      appendEvent(run.directory, "gate.answered", { gate: "plan", answer: "change" });
      setOrca([run.runId]);
      const actionLog = join(mkdtempSync(join(tmpdir(), "ark-gate-action-")), "actions.log");
      process.env.ORCA_ACTION_LOG = actionLog;
      const plannotator = join(orcaBinDirectory, "plannotator");
      writeFileSync(plannotator, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$ORCA_ACTION_LOG"\n`);
      chmodSync(plannotator, 0o755);
      await using view = new Bun.WebView({ backend: "chrome", width: 1440, height: 1000 });
      await withUi(async (baseUrl) => {
        await view.navigate(baseUrl);
        await view.press("3");
        await waitForBrowserValue(
          view,
          "!!document.querySelector('[data-kind=gate][data-open=true]')",
        );
        await view.evaluate(
          `document.querySelector('[data-kind="gate"][data-open="true"]')?.click()`,
        );
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            const output = readFileSync(actionLog, "utf8");
            if (output.includes(join(run.directory, "plan.md"))) break;
          } catch {}
          await Bun.sleep(100);
        }
        expect(readFileSync(actionLog, "utf8")).toContain(join(run.directory, "plan.md"));
      });
    },
  );

  test(
    "ARK-180-AC5 Timeline lane selection stays separate from Home and Map selection",
    { timeout: 30_000 },
    async () => {
      const run = startRun("ARK-180-SELECT1", "Shared run");
      planGate(run.directory);
      setOrca([run.runId]);
      await using view = new Bun.WebView({ backend: "chrome", width: 1440, height: 1000 });
      await withUi(async (baseUrl) => {
        await view.navigate(baseUrl);
        await waitForBrowserValue(view, `!!document.querySelector('[data-run="${run.runId}"]')`);
        await view.evaluate(
          `document.querySelector('[data-run="${run.runId}"] .row-main')?.click()`,
        );
        await waitForBrowserValue(
          view,
          `!!document.querySelector('.row.cursor[data-run="${run.runId}"]')`,
        );
        const homeSelection = await view.evaluate(
          `document.querySelector('.row.cursor[data-run="${run.runId}"]')?.dataset.run`,
        );
        await view.press("2");
        await waitForBrowserValue(
          view,
          `!!document.querySelector('.node.cursor[data-node="run:${run.runId}"]')`,
        );
        const mapSelection = await view.evaluate(
          "document.querySelector('.node.cursor')?.dataset.node",
        );
        await view.press("3");
        await waitForBrowserValue(view, "!!document.querySelector('[data-lane]')");
        await view.evaluate(
          `document.querySelector('[data-lane="run:${run.runId}"] .lh')?.click()`,
        );
        expect(
          await view.evaluate(
            `document.querySelector('[data-lane="run:${run.runId}"] .lh')?.getAttribute('aria-pressed')`,
          ),
        ).toBe("true");
        await view.press("1");
        expect(
          await view.evaluate(
            `document.querySelector('.row.cursor[data-run="${run.runId}"]')?.dataset.run`,
          ),
        ).toBe(homeSelection);
        await view.press("2");
        await waitForBrowserValue(
          view,
          `!!document.querySelector('.node.cursor[data-node="run:${run.runId}"]')`,
        );
        expect(await view.evaluate("document.querySelector('.node.cursor')?.dataset.node")).toBe(
          mapSelection,
        );
      });
    },
  );
});
