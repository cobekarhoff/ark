import { expect, test, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../../cli/events.ts";
import { planHash } from "../../cli/plan.ts";
import {
  ark,
  codexDay,
  isoAgo,
  startHub,
  stopHub,
  tempArkHome,
  tempDirectory,
  tempGitRepo,
  useCleanup,
  writeProject,
  writeTicket,
} from "./helpers.ts";

useCleanup();
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 1000 } });

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

test.beforeEach(() => {
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
  orcaBinDirectory = tempDirectory("ark-map-orca-");
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
  writeFileSync(eventFile, `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
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

const at = (minutesAgo: number) => isoAgo(minutesAgo * 60_000);

/** Runs `callback` against a fresh `ark ui` hub that is stopped afterwards. */
async function withUi(callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const hub = await startHub();
  try {
    await callback(hub.baseUrl);
  } finally {
    await stopHub(hub.process);
  }
}

/** Opens the hub and waits for the app shell, the earliest point at which keys are handled. */
async function openApp(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl);
  await expect(page.locator('.vbar button[aria-current="page"]')).toBeVisible();
}

test("ARK-180-AC4 Map selection lights connected path, dims unrelated nodes, and fills detail", async ({
  page,
}) => {
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
  appendEvent(other.directory, "gate.answered", { gate: "plan", answer: "approve" });
  appendEvent(other.directory, "step.started", {
    step: "build",
    role: "implementer",
    repo: ".",
    round: 1,
  });
  const waiting = startRun("ARK-180-MAPUI3", "Waiting run");
  planGate(waiting.directory);
  setOrca([run.runId, other.runId, waiting.runId]);
  await withUi(async (baseUrl) => {
    await openApp(page, baseUrl);
    await page.keyboard.press("2");
    const buildStep = page.locator(`[data-node="step:${run.runId}:build"]`);
    await expect(buildStep).toBeAttached();
    await buildStep.dispatchEvent("click");
    const detail = page.locator(".app > aside.detail:not([hidden]) h2");
    await expect(detail).toHaveText("build");
    await expect(buildStep).toHaveAttribute("data-lit", "true");
    await expect(page.locator(`[data-node="run:${run.runId}"]`)).toHaveAttribute(
      "data-lit",
      "true",
    );
    await expect(page.locator(`[data-node="run:${other.runId}"]`)).toHaveAttribute(
      "data-lit",
      "false",
    );
    await expect(page.locator(`[data-node="step:${other.runId}:build"]`)).toHaveAttribute(
      "data-lit",
      "false",
    );
    await expect(page.locator(".node.cursor")).toHaveAttribute(
      "data-node",
      `step:${run.runId}:build`,
    );
    const badge = page.locator(`[data-badge="run:${waiting.runId}"]`);
    await expect(badge).toBeAttached();
    await badge.dispatchEvent("click");
    await expect(detail).toHaveText("ARK-180-MAPUI3");
  });
});

test("ARK-180-AC4 Map keyboard navigation, dimming and replay controls update the rendered graph", async ({
  page,
}) => {
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
  await withUi(async (baseUrl) => {
    await openApp(page, baseUrl);
    await page.keyboard.press("2");
    await expect(page.locator("[data-node]").first()).toBeAttached();
    await page.locator(`[data-node="run:${run.runId}"]`).dispatchEvent("click");
    const cursor = page.locator(".node.cursor");
    await expect(cursor).toHaveAttribute("data-node", `run:${run.runId}`);
    await page.keyboard.press("j");
    await expect(cursor).not.toHaveAttribute("data-node", `run:${run.runId}`);
    await page.keyboard.press("k");
    await expect(cursor).toHaveAttribute("data-node", `run:${run.runId}`);
    const graph = page.locator(".graph");
    await page.keyboard.press("v");
    await expect(graph).not.toHaveClass(/\bdim\b/);
    await page.keyboard.press("v");
    await expect(graph).toHaveClass(/\bdim\b/);
    const asOf = page.locator("[data-testid=asof]");
    const liveTime = await asOf.textContent();
    await page.keyboard.press("[");
    await expect(asOf).not.toHaveText("live");
    const replayTime = await asOf.textContent();
    expect(replayTime).not.toBe(liveTime);
    await page.keyboard.press("]");
    await page.keyboard.press("l");
    await expect(asOf).toHaveText("live");
  });
});

test("ARK-180-AC5 Timeline zoom cycles across supported windows and cost burn preserves unknown", async ({
  page,
}) => {
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
  const codexRoot = tempDirectory("ark-codex-ui-");
  process.env.ARK_CODEX_SESSIONS = codexRoot;
  mkdirSync(join(codexRoot, ...codexDay()), { recursive: true });
  writeFileSync(
    join(codexRoot, ...codexDay(), "rollout-ui.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { cwd: join(run.directory, "workspace") } })}\n${JSON.stringify({ type: "event_msg", timestamp: at(5), payload: { type: "token_count", info: { last_token_usage: { input_tokens: 4, output_tokens: 2 }, total_token_usage: { total_tokens: 6 } } } })}\n`,
  );
  const ompRoot = tempDirectory("ark-omp-ui-");
  process.env.ARK_OMP_SESSIONS = ompRoot;
  mkdirSync(join(ompRoot, "sessions"), { recursive: true });
  const priced = (id: string, minutesAgo: number, total: number) =>
    JSON.stringify({
      type: "message",
      id,
      timestamp: at(minutesAgo),
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet",
        content: [],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
        },
      },
    });
  writeFileSync(
    join(ompRoot, "sessions", "session.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: "omp", timestamp: at(13 * 60), cwd: join(run.directory, "workspace") })}\n${priced("before", 13 * 60, 0.4)}\n${priced("first", 30, 0.25)}\n`,
  );
  await withUi(async (baseUrl) => {
    await openApp(page, baseUrl);
    await page.keyboard.press("3");
    await expect(page.locator("[data-lane]").first()).toBeAttached();
    for (const hours of ["24h", "1h", "12h"]) {
      await page.keyboard.press("w");
      await expect(page.locator("[data-testid=window]")).toHaveText(hours);
    }
    await page.keyboard.press("b");
    const burn = page.locator("[data-testid=burn]");
    await expect(burn).toBeAttached();
    await expect(burn).toContainText("?");
    // The first priced message in the window counts: $0.25, not $0.00.
    await expect(page.locator("[data-testid=burn] b").first()).toHaveText("$0.25");
  });
});

test("ARK-180-AC5 clicking an open Timeline gate runs its Plannotator action", async ({ page }) => {
  const run = startRun("ARK-180-GATEUI1", "Gate action");
  planGate(run.directory);
  writeFileSync(join(run.directory, "plan.md"), "# Plan\n");
  writeFileSync(join(run.directory, "plan.yml"), "steps: []\n");
  appendEvent(run.directory, "gate.answered", { gate: "plan", answer: "change" });
  setOrca([run.runId]);
  const actionLog = join(tempDirectory("ark-gate-action-"), "actions.log");
  process.env.ORCA_ACTION_LOG = actionLog;
  const plannotator = join(orcaBinDirectory, "plannotator");
  writeFileSync(
    plannotator,
    `#!/bin/sh
if [ "$1" = "sessions" ] && [ "$2" = "--json" ]; then printf '[]'; exit 0; fi
printf '%s\\n' "$*" >> "$ORCA_ACTION_LOG"
`,
  );
  chmodSync(plannotator, 0o755);
  await withUi(async (baseUrl) => {
    await openApp(page, baseUrl);
    await page.keyboard.press("3");
    const gate = page.locator("[data-kind=gate][data-open=true]");
    await expect(gate.first()).toBeAttached();
    await gate.first().evaluate((element) => (element as HTMLElement).click());
    await expect
      .poll(() => {
        try {
          return readFileSync(actionLog, "utf8");
        } catch {
          return "";
        }
      })
      .toContain(join(run.directory, "plan.md"));
  });
});

test("ARK-180-AC5 Timeline lane selection stays separate from Home and Map selection", async ({
  page,
}) => {
  const run = startRun("ARK-180-SELECT1", "Shared run");
  planGate(run.directory);
  setOrca([run.runId]);
  await withUi(async (baseUrl) => {
    await page.goto(baseUrl);
    const homeRow = page.locator(`[data-run="${run.runId}"] .row-main`);
    await expect(page.locator(`[data-run="${run.runId}"]`)).toBeAttached();
    await homeRow.evaluate((element) => (element as HTMLElement).click());
    const homeCursor = page.locator(`.row.cursor[data-run="${run.runId}"]`);
    await expect(homeCursor).toBeAttached();
    const homeSelection = await homeCursor.getAttribute("data-run");
    await page.keyboard.press("2");
    const mapCursor = page.locator(`.node.cursor[data-node="run:${run.runId}"]`);
    await expect(mapCursor).toBeAttached();
    const mapSelection = await page.locator(".node.cursor").getAttribute("data-node");
    await page.keyboard.press("3");
    await expect(page.locator("[data-lane]").first()).toBeAttached();
    const laneHeader = page.locator(`[data-lane="run:${run.runId}"] .lh`);
    await laneHeader.evaluate((element) => (element as HTMLElement).click());
    await expect(laneHeader).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("1");
    await expect(homeCursor).toHaveAttribute("data-run", homeSelection as string);
    await page.keyboard.press("2");
    await expect(mapCursor).toBeAttached();
    await expect(page.locator(".node.cursor")).toHaveAttribute("data-node", mapSelection as string);
  });
});
