import { beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
let projectOneDirectory: string;
let projectTwoDirectory: string;
let orcaDirectory: string;
let terminalLog: string;
let searchStateFile: string;
let orcaFailureFile: string;

function projectConfig(workspace: string, ticketSource: string, model: string) {
  return {
    workspace,
    ticket_source: ticketSource,
    suites: [{ name: "cli", level: "integration", repo: ".", command: "bun test", parser: "bun" }],
    roles: {
      chief: { harness: "omp", model },
      implementer: { harness: "omp", model },
      validator: { harness: "codex", model: "gpt-6" },
      reviewer: { harness: "omp", model: "pi/review" },
    },
  };
}

function setOrca(terminals: object[], runs: object[] = []): void {
  process.env.TEST_ORCA_TERMINALS = JSON.stringify(terminals);
  process.env.TEST_ORCA_RUNS = JSON.stringify(runs);
}

function writeMetrics(
  projectName: string,
  ticketId: string,
  closedAt: string,
  outcome: string,
  metrics: object,
) {
  const ticketFile = writeTicket(projectName, ticketId, [
    { id: `${ticketId}-AC1`, text: "Close a test run" },
  ]);
  const started = ark("run", "start", ticketFile, "--project", projectName);
  if (started.code !== 0) throw new Error(`could not start metrics fixture: ${started.err}`);
  const run = started.out.trim();
  const runDirectory = join(process.env.ARK_HOME as string, "projects", projectName, "runs", run);
  recordEvaluation(runDirectory);
  writeFileSync(join(runDirectory, "plan.yml"), "steps: []\n");
  appendEvent(runDirectory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(runDirectory),
    steps: [],
  });
  appendEvent(runDirectory, "gate.answered", { gate: "plan", answer: "approve" });
  if (outcome === "handed_off")
    appendEvent(runDirectory, "test.completed", {
      passed: true,
      criteria: {},
      heads: {},
      suites: [],
    });
  appendEvent(runDirectory, "run.closed", { outcome });
  const eventsFile = join(runDirectory, "events.ndjson");
  const events = readFileSync(eventsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; time: string });
  const closeEvent = events.findLast((event) => event.type === "run.closed");
  if (!closeEvent) throw new Error(`metrics fixture run ${run} did not close`);
  closeEvent.time = closedAt;
  writeFileSync(eventsFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  writeFileSync(join(runDirectory, "metrics.json"), JSON.stringify(metrics));
  return runDirectory;
}

async function startUi(): Promise<{ process: Bun.Subprocess; baseUrl: string }> {
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

async function json<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function writeFakeOrca(): void {
  const fakeOrca = join(orcaDirectory, "orca");
  writeFileSync(
    fakeOrca,
    `#!/bin/sh
if [ "$(cat "$TEST_ORCA_FAILURE_FILE")" = "1" ]; then exit 1; fi
if [ "$1" = "terminal" ] && [ "$2" = "list" ]; then
  printf '{"result":{"terminals":%s}}' "$TEST_ORCA_TERMINALS"
  exit 0
fi
if [ "$1" = "terminal" ] && [ "$2" = "send" ]; then
  printf '%s\\n' "$*" >> "$TEST_TERMINAL_LOG"
  printf '{"result":{}}'
  exit 0
fi
if [ "$1" = "terminal" ] && [ "$2" = "switch" ]; then
  printf '%s\\n' "$*" >> "$TEST_TERMINAL_LOG"
  printf '{"result":{}}'
  exit 0
fi
if [ "$1" = "orchestration" ] && [ "$2" = "run-list" ]; then
  printf '{"result":{"runs":%s}}' "$TEST_ORCA_RUNS"
  exit 0
fi
if [ "$1" = "search" ]; then
  case "$(cat "$TEST_SEARCH_STATE_FILE")" in
    disabled) printf '{"result":{"kind":"unavailable","reason":"disabled"}}' ;;
    empty) printf '{"result":{"kind":"success","hits":[]}}' ;;
    *) printf '{"result":{"kind":"success","hits":[{"sessionId":"session-7","title":"Agent session result","cwd":"%s","snippet":"session needle"}]}}' "$TEST_SESSION_CWD" ;;
  esac
  exit 0
fi
exit 2
`,
  );
  chmodSync(fakeOrca, 0o755);
}

beforeEach(() => {
  tempArkHome();
  projectOneDirectory = writeProject("one", projectConfig(tempGitRepo(), "local", "pi/lead"));
  projectTwoDirectory = writeProject("two", projectConfig(tempGitRepo(), "github", "pi/other"));
  orcaDirectory = mkdtempSync(join(tmpdir(), "ark-hub-orca-"));
  terminalLog = join(mkdtempSync(join(tmpdir(), "ark-hub-actions-")), "terminal.log");
  searchStateFile = join(mkdtempSync(join(tmpdir(), "ark-hub-search-")), "state");
  orcaFailureFile = join(mkdtempSync(join(tmpdir(), "ark-hub-orca-fail-")), "state");
  writeFileSync(searchStateFile, "hit");
  writeFileSync(orcaFailureFile, "0");
  process.env.PATH = `${orcaDirectory}:${process.env.PATH}`;
  process.env.TEST_TERMINAL_LOG = terminalLog;
  process.env.TEST_SESSION_CWD = projectOneDirectory;
  process.env.TEST_SEARCH_STATE_FILE = searchStateFile;
  process.env.TEST_ORCA_FAILURE_FILE = orcaFailureFile;
  process.env.ARK_OMP_SESSIONS = mkdtempSync(join(tmpdir(), "ark-hub-omp-"));
  process.env.ARK_CLAUDE_SESSIONS = mkdtempSync(join(tmpdir(), "ark-hub-claude-"));
  process.env.ARK_CODEX_SESSIONS = mkdtempSync(join(tmpdir(), "ark-hub-codex-"));
  setOrca([]);
  writeFakeOrca();
});

test("ARK-181-AC1 returns ticket-file fields and keeps unreadable tickets", async () => {
  const ticketFile = writeTicket("one", "ARK-181-ONE", [], "File title");
  writeFileSync(
    ticketFile,
    "---\nid: ARK-181-ONE\ntitle: File title\nstatus: ready\nmilestone: M7\ndepends_on: [ARK-100]\n---\nFile body\n",
  );
  writeFileSync(join(projectOneDirectory, "README.md"), "wrong README data");
  writeFileSync(join(projectOneDirectory, "tickets", "BROKEN.md"), "not frontmatter");
  const otherTicket = writeTicket("two", "ARK-181-TWO", [], "Other project ticket");

  await withUi(async (baseUrl) => {
    const answer = await json<{
      tickets: {
        project: string;
        id: string;
        title: string | null;
        status: string;
        milestone: string | null;
        depends_on: string[];
        file: string;
      }[];
    }>(baseUrl, "/api/backlog");
    expect(answer.tickets).toContainEqual({
      project: "one",
      id: "ARK-181-ONE",
      title: "File title",
      status: "ready",
      milestone: "M7",
      depends_on: ["ARK-100"],
      file: ticketFile,
    });
    expect(answer.tickets.find((ticket) => ticket.id === "BROKEN")).toMatchObject({
      title: null,
      status: "unreadable",
    });
    expect(answer.tickets.some((ticket) => ticket.id === "README")).toBe(false);
    expect(answer.tickets.some((ticket) => ticket.file === otherTicket)).toBe(true);
  });
});

test("ARK-181-AC1 approve-and-queue sends only the exact live-chief instruction", async () => {
  setOrca(
    [
      {
        handle: "term_chief",
        connected: true,
        worktreePath: JSON.parse(await Bun.file(join(projectOneDirectory, "ark.yml")).text())
          .workspace,
        agentIdentity: "omp",
      },
    ],
    [{ objective: "Master Chief: one tickets", coordinator_handle: "term_chief" }],
  );
  await withUi(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/actions/chief-instruction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "one", instruction: "approve-and-queue" }),
    });
    expect(response.status).toBe(200);
    expect(await Bun.file(terminalLog).text()).toContain(
      "terminal send --terminal term_chief --text Hub: approve and queue the proposed tickets in the order shown. The human asked for it. --enter --json",
    );
    const unavailable = await fetch(`${baseUrl}/api/actions/chief-instruction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "two", instruction: "approve-and-queue" }),
    });
    expect(unavailable.status).toBe(409);
    expect((await Bun.file(terminalLog).text()).trim().split("\n")).toHaveLength(1);
  });
});

test("ARK-181-AC2 lists every Orca agent and reads measured session usage", async () => {
  const codexSession = join(
    process.env.ARK_CODEX_SESSIONS as string,
    "2026",
    "11",
    "01",
    "rollout-codex-1.jsonl",
  );
  mkdirSync(dirname(codexSession), { recursive: true });
  writeFileSync(
    codexSession,
    [
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: projectOneDirectory, model_provider: "openai" },
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-6" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-11-01T10:00:00Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 25, output_tokens: 7 },
            total_token_usage: { total_tokens: 32 },
          },
        },
      }),
    ].join("\n"),
  );
  const ompFolder = join(projectOneDirectory, "worker");
  const opaqueFolder = mkdtempSync(join(tmpdir(), "ark-hub-outsider-"));
  const ompSessionDirectory = join(process.env.ARK_OMP_SESSIONS as string, "project-one");
  mkdirSync(ompSessionDirectory, { recursive: true });
  writeFileSync(
    join(ompSessionDirectory, "session.jsonl"),
    `${JSON.stringify({ type: "session", cwd: ompFolder, id: "worker-session" })}\n${JSON.stringify({ type: "message", message: { role: "assistant", model: "pi/task", usage: { input: 12, output: 4, cost: { total: 0.35 } } } })}\n`,
  );
  setOrca([
    {
      handle: "term_lead",
      connected: true,
      agentIdentity: "omp",
      model: "pi/lead",
      worktreePath: projectOneDirectory,
      preview: "ready\nLead output",
    },
    {
      handle: "term_worker",
      connected: false,
      agentIdentity: "omp",
      model: "pi/task",
      worktreePath: ompFolder,
      preview: "worker output",
    },
    {
      handle: "term_external",
      connected: true,
      agentIdentity: "custom",
      model: "custom-v1",
      worktreePath: opaqueFolder,
      preview: "external output",
    },
    {
      handle: "term_codex",
      connected: true,
      agentIdentity: "codex",
      model: "gpt-6",
      worktreePath: projectOneDirectory,
      preview: "Codex output",
    },
  ]);

  await withUi(async (baseUrl) => {
    const answer = await json<{
      state: string;
      agents: {
        terminal: string;
        state: string;
        harness: string;
        model: string;
        cost: { usd: number | "unavailable"; tokens: number };
        last_line: string | null;
        project: string;
      }[];
    }>(baseUrl, "/api/agents");
    expect(answer.state).toBe("ok");
    expect(answer.agents).toHaveLength(4);
    expect(answer.agents.find((agent) => agent.terminal === "term_lead")).toMatchObject({
      state: "live",
      harness: "omp",
      model: "pi/lead",
      project: "one",
      last_line: "Lead output",
    });
    expect(answer.agents.find((agent) => agent.terminal === "term_worker")).toMatchObject({
      state: "exited",
      harness: "omp",
      model: "pi/task",
      project: "one",
      last_line: "worker output",
      cost: { usd: 0.35 },
    });
    expect(answer.agents.find((agent) => agent.terminal === "term_external")).toMatchObject({
      state: "live",
      harness: "custom",
      model: "custom-v1",
      project: "other",
      last_line: "external output",
      cost: { usd: "unavailable" },
    });
    expect(answer.agents.find((agent) => agent.terminal === "term_codex")).toMatchObject({
      state: "live",
      harness: "codex",
      model: "gpt-6",
      project: "one",
      last_line: "Codex output",
      cost: { tokens: 32 },
    });
    const noSession = answer.agents.find((agent) => agent.terminal === "term_external");
    expect(noSession?.cost.usd).not.toBe(0);
  });
});

test("ARK-181-AC2 reports an unknown agent list when Orca fails", async () => {
  writeFileSync(orcaFailureFile, "1");
  await withUi(async (baseUrl) => {
    expect(await json(baseUrl, "/api/agents")).toEqual({ state: "unknown", agents: null });
  });
});

test("ARK-181-AC3 aggregates only the selected week and preserves unknown metrics", async () => {
  writeMetrics("one", "ARK-181-METRICS-MERGED", "2026-10-28T12:00:00.000Z", "handed_off", {
    cost: { total_usd: 4 },
    time: { wall_seconds: 100, gate_wait_seconds: 20 },
  });
  writeMetrics("one", "ARK-181-METRICS-ABORTED", "2026-10-29T12:00:00.000Z", "aborted", {
    cost: { total_usd: 8 },
    time: { wall_seconds: 300, gate_wait_seconds: 40 },
  });
  const outsideRunDirectory = writeMetrics(
    "two",
    "ARK-181-METRICS-OUTSIDE",
    "2026-11-02T12:00:00.000Z",
    "handed_off",
    {
      cost: { total_usd: 99 },
      time: { wall_seconds: 999, gate_wait_seconds: 999 },
      override_rate: 1,
      design_rounds: 9,
    },
  );
  writeMetrics("one", "ARK-181-METRICS-UNKNOWN", "2026-10-30T12:00:00.000Z", "aborted", {
    time: { wall_seconds: 200, gate_wait_seconds: 30 },
  });

  await withUi(async (baseUrl) => {
    const answer = await json<{
      runs: { run: string; outcome: string }[];
      runs_by_outcome: Record<string, number>;
      cost_by_day: { day: string; usd: number | "unavailable"; includes_unknown: boolean }[];
      median_wall_seconds: number;
      median_gate_wait_seconds: number;
      override_rate: { value: number | "unavailable" };
      design_rounds: { value: number | "unavailable" };
    }>(baseUrl, "/api/metrics?week=2026-10-28");
    expect(answer.runs).toHaveLength(3);
    expect(answer.runs_by_outcome).toEqual({ handed_off: 1, aborted: 2 });
    expect(answer.median_wall_seconds).toBe(200);
    expect(answer.median_gate_wait_seconds).toBe(30);
    expect(answer.override_rate.value).toBe("unavailable");
    expect(answer.design_rounds.value).toBe("unavailable");
    expect(answer.cost_by_day).toContainEqual({
      day: "2026-10-28",
      usd: 4,
      includes_unknown: false,
    });
    expect(answer.cost_by_day).toContainEqual({
      day: "2026-10-29",
      usd: 8,
      includes_unknown: false,
    });
    expect(answer.cost_by_day).toContainEqual({
      day: "2026-10-30",
      usd: "unavailable",
      includes_unknown: true,
    });
    expect(answer.runs.some((run) => run.run === basename(outsideRunDirectory))).toBe(false);
  });
});

test("ARK-181-AC4 finds tickets, runs, plans, retros and Orca session hits with link targets", async () => {
  const ticketFile = writeTicket("one", "ARK-181-SEARCH", [], "Titleneedle ticket title");
  writeFileSync(
    ticketFile,
    "---\nid: ARK-181-SEARCH\ntitle: Titleneedle ticket title\nstatus: proposed\n---\nBodyneedle in the ticket body.\n",
  );
  const searchRun = "2026-11-01-Runneedle";
  const runDirectory = join(projectOneDirectory, "runs", searchRun);
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(join(runDirectory, "plan.md"), "# Planneedle plan\n");
  writeFileSync(join(runDirectory, "retro.md"), "# Retroneedle retro\n");
  process.env.TEST_SESSION_CWD = projectOneDirectory;

  await withUi(async (baseUrl) => {
    const search = (query: string) =>
      json<{
        hits: { kind: string; target: Record<string, string> }[];
        orca: { state: string };
      }>(baseUrl, `/api/search?q=${query}`);
    const title = await search("Titleneedle");
    const body = await search("Bodyneedle");
    const run = await search("Runneedle");
    const plan = await search("Planneedle");
    const retro = await search("Retroneedle");
    const session = await search("Sessionneedle");

    expect(title.hits.find((hit) => hit.kind === "ticket")).toMatchObject({
      target: { view: "backlog", project: "one", ticket: "ARK-181-SEARCH" },
    });
    expect(body.hits.find((hit) => hit.kind === "ticket")).toMatchObject({
      target: { view: "backlog", project: "one", ticket: "ARK-181-SEARCH" },
    });
    expect(run.hits.find((hit) => hit.kind === "run")).toMatchObject({
      target: { view: "run", run: searchRun },
    });
    expect(plan.hits.find((hit) => hit.kind === "plan")).toMatchObject({
      target: { view: "run", run: searchRun, file: "plan.md" },
    });
    expect(retro.hits.find((hit) => hit.kind === "retro")).toMatchObject({
      target: { view: "run", run: searchRun, file: "retro.md" },
    });
    expect(session.orca.state).toBe("enabled");
    expect(session.hits.find((hit) => hit.kind === "session")).toMatchObject({
      target: { view: "session", session: "session-7" },
    });
  });
});

test("ARK-181-AC4 distinguishes disabled Orca history from enabled no-session-matches", async () => {
  const ticketFile = writeTicket("one", "ARK-181-LOCAL", [], "Only-local-needle");
  writeFileSync(
    ticketFile,
    "---\nid: ARK-181-LOCAL\ntitle: Local ticket\nstatus: proposed\n---\nOnly-local-needle\n",
  );
  writeFileSync(searchStateFile, "disabled");
  await withUi(async (baseUrl) => {
    const disabled = await json<{ orca: { state: string }; hits: { kind: string }[] }>(
      baseUrl,
      "/api/search?q=Only-local-needle",
    );
    expect(disabled.orca.state).toBe("disabled");
    expect(disabled.hits.map((hit) => hit.kind)).toContain("ticket");
    writeFileSync(searchStateFile, "empty");
    const enabled = await json<{ orca: { state: string }; hits: { kind: string }[] }>(
      baseUrl,
      "/api/search?q=session-only-needle",
    );
    expect(enabled.orca.state).toBe("enabled");
    expect(enabled.hits.some((hit) => hit.kind === "session")).toBe(false);
  });
});

test("ARK-181-AC5 returns project configuration and chief state through Orca failures", async () => {
  const chiefWorkspace = JSON.parse(await Bun.file(join(projectOneDirectory, "ark.yml")).text())
    .workspace as string;
  setOrca(
    [
      {
        handle: "term_chief",
        connected: true,
        worktreePath: chiefWorkspace,
        agentIdentity: "omp",
        model: "pi/lead",
      },
    ],
    [{ objective: "Master Chief: one tickets", coordinator_handle: "term_chief" }],
  );
  await withUi(async (baseUrl) => {
    const answer = await json<{
      projects: {
        name: string;
        ticket_source: string;
        roles: Record<string, { harness: string; model: string }>;
        chief: { state: string };
      }[];
    }>(baseUrl, "/api/projects");
    expect(answer.projects).toContainEqual(
      expect.objectContaining({
        name: "one",
        ticket_source: "local",
        chief: { state: "live", handle: "term_chief", harness: "omp", model: "pi/lead" },
        roles: expect.objectContaining({ validator: { harness: "codex", model: "gpt-6" } }),
      }),
    );
    expect(answer.projects).toContainEqual(
      expect.objectContaining({
        name: "two",
        ticket_source: "github",
        chief: { state: "missing" },
        roles: expect.objectContaining({ implementer: { harness: "omp", model: "pi/other" } }),
      }),
    );
    writeFileSync(orcaFailureFile, "1");
    const failedOrca = await json<{
      projects: { name: string; ticket_source: string; chief: { state: string } }[];
    }>(baseUrl, "/api/projects");
    expect(failedOrca.projects.find((project) => project.name === "one")).toMatchObject({
      ticket_source: "local",
      chief: { state: "unknown" },
    });
  });
});

async function withHeadlessChrome<T>(
  url: string,
  callback: (evaluate: (expression: string) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  await using view = new Bun.WebView({
    backend: "chrome",
    width: 1280,
    height: 900,
  });
  await view.navigate(url);
  return await callback(async (expression) => view.evaluate(expression));
}

test(
  "ARK-181-AC6 renders, filters, opens details and switches an agent in headless Chrome",
  { timeout: 60_000 },
  async () => {
    writeTicket("one", "ARK-181-CHROME-ONE", [], "One project ticket");
    writeTicket("two", "ARK-181-CHROME-TWO", [], "Two project ticket");
    setOrca([
      {
        handle: "term_one",
        connected: true,
        agentIdentity: "omp",
        model: "pi/task",
        worktreePath: projectOneDirectory,
        preview: "One agent output",
      },
      {
        handle: "term_two",
        connected: true,
        agentIdentity: "omp",
        model: "pi/task",
        worktreePath: projectTwoDirectory,
        preview: "Two agent output",
      },
    ]);
    writeFileSync(searchStateFile, "disabled");
    writeMetrics("one", "ARK-181-CHROME-METRICS-ONE", "2026-10-29T12:00:00.000Z", "handed_off", {
      cost: { total_usd: 1 },
      time: { wall_seconds: 60, gate_wait_seconds: 10 },
    });
    writeMetrics("two", "ARK-181-CHROME-METRICS-TWO", "2026-10-29T12:00:00.000Z", "handed_off", {
      cost: { total_usd: 2 },
      time: { wall_seconds: 120, gate_wait_seconds: 20 },
    });
    for (const project of ["one", "two"]) {
      const projectDirectory = project === "one" ? projectOneDirectory : projectTwoDirectory;
      const runDirectory = join(
        projectDirectory,
        "runs",
        `2026-11-01-${project}-CHROME-SEARCH-NEEDLE`,
      );
      mkdirSync(runDirectory, { recursive: true });
      writeFileSync(join(runDirectory, "plan.md"), "# Chrome-search-needle plan");
    }

    await withUi(async (baseUrl) =>
      withHeadlessChrome(baseUrl, async (evaluate) => {
        const waitFor = async (expression: string) => {
          for (let attempt = 0; attempt < 80; attempt++) {
            const ready = await evaluate(expression);
            if (ready) return;
            // The page and API are separate processes; wait for the rendered DOM condition.
            await Bun.sleep(100);
          }
          throw new Error(`Chrome condition timed out: ${expression}`);
        };
        await waitFor("Boolean(document.querySelector('[data-view=backlog]'))");
        const viewButtons = await evaluate(
          "[...document.querySelectorAll('nav.vbar button')].map((button) => [button.textContent.trim(), button.getAttribute('data-view')])",
        );
        expect(viewButtons).toHaveLength(8);
        for (const view of ["backlog", "agents", "metrics", "search", "projects"]) {
          const clicked = await evaluate(
            `(() => { const button = [...document.querySelectorAll('nav.vbar button')].find((candidate) => candidate.dataset.view === '${view}'); button?.click(); return Boolean(button); })()`,
          );
          expect(clicked).toBe(true);
          await waitFor(`Boolean(document.querySelector('.scroll[data-view="${view}"]'))`);
          await waitFor(
            `Boolean(document.querySelector('.scroll[data-view="${view}"] button, .scroll[data-view="${view}"] input'))`,
          );
          if (view === "metrics")
            await waitFor(
              `!document.querySelector('.scroll[data-view="metrics"]').innerText.includes('Reading metrics')`,
            );
          if (view === "search") {
            await evaluate(
              "(() => { const input = document.querySelector('input[aria-label=\"Search text\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Chrome-search-needle'); input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('form').requestSubmit(); })()",
            );
            await waitFor("Boolean(document.querySelector('[data-hit=plan]'))");
          }
          const allText = await evaluate(
            `document.querySelector('.scroll[data-view="${view}"]').innerText`,
          );
          expect(String(allText).toLowerCase()).toContain("one");
          expect(String(allText).toLowerCase()).toContain("two");
          await evaluate(
            "[...document.querySelectorAll('.chips button')].find((button) => button.textContent.trim().toLowerCase().startsWith('one'))?.click()",
          );
          await waitFor(
            `document.querySelector('.scroll[data-view="${view}"]').innerText.toLowerCase().includes('one')`,
          );
          const filteredText = await evaluate(
            `document.querySelector('.scroll[data-view="${view}"]').innerText`,
          );
          expect(String(filteredText).toLowerCase()).not.toContain("two");
          await evaluate(
            "[...document.querySelectorAll('.chips button')].find((button) => button.getAttribute('aria-pressed') === 'false' && button.textContent.trim().toLowerCase().startsWith('all'))?.click()",
          );
        }

        await evaluate(
          "[...document.querySelectorAll('nav.vbar button')].find((button) => button.dataset.view === 'backlog')?.click()",
        );
        await waitFor(
          "Boolean(document.querySelector('[data-ticket=\"one:ARK-181-CHROME-ONE\"] button'))",
        );
        await evaluate(
          "document.querySelector('[data-ticket=\"one:ARK-181-CHROME-ONE\"] button').click()",
        );
        await waitFor(
          "document.querySelector('aside.detail').innerText.includes('One project ticket')",
        );
        const detailText = await evaluate("document.querySelector('aside.detail').innerText");
        expect(String(detailText)).toContain("One project ticket");

        await evaluate(
          "[...document.querySelectorAll('nav.vbar button')].find((button) => button.dataset.view === 'agents')?.click()",
        );
        await waitFor("Boolean(document.querySelector('[data-agent=term_one] button'))");
        await evaluate("document.querySelector('[data-agent=term_one] button').click()");
        await waitFor(
          "document.querySelector('aside.detail button')?.textContent.includes('Open in Orca')",
        );
        await evaluate("document.querySelector('aside.detail button').click()");
        await waitFor("Boolean(document.querySelector('[data-agent=term_one]'))");
        for (let attempt = 0; attempt < 40 && !(await Bun.file(terminalLog).exists()); attempt++) {
          // Orca switching runs as a child process, so wait for its durable output.
          await Bun.sleep(25);
        }
        expect(await Bun.file(terminalLog).text()).toContain("terminal switch --terminal term_one");

        await evaluate(
          "[...document.querySelectorAll('nav.vbar button')].find((button) => button.dataset.view === 'search')?.click()",
        );
        await waitFor("Boolean(document.querySelector('input[aria-label=\"Search text\"]'))");
        await evaluate(
          "(() => { const input = document.querySelector('input[aria-label=\"Search text\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Chrome-search-needle'); input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('form').requestSubmit(); })()",
        );
        await waitFor(
          "document.querySelector('.s-needs')?.innerText.includes('Orca history is disabled')",
        );
        expect(await evaluate("document.querySelector('.s-needs').innerText")).toContain(
          "Orca history is disabled",
        );
      }),
    );
  },
);
