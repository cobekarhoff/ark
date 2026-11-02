import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../../cli/events.ts";
import { planHash } from "../../cli/plan.ts";
import {
  ark,
  isoAgo,
  recordEvaluation,
  startHub,
  stopHub,
  tempArkHome,
  tempDirectory,
  tempGitRepo,
  useCleanup,
  writeFakeOrca,
  writeProject,
  writeTicket,
} from "./helpers.ts";

useCleanup();
test.describe.configure({ mode: "serial" });

let projectOneDirectory: string;
let projectTwoDirectory: string;
let terminalLog: string;
let searchStateFile: string;

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

test.beforeEach(() => {
  tempArkHome();
  projectOneDirectory = writeProject("one", projectConfig(tempGitRepo(), "local", "pi/lead"));
  projectTwoDirectory = writeProject("two", projectConfig(tempGitRepo(), "github", "pi/other"));
  terminalLog = join(tempDirectory("ark-hub-actions-"), "terminal.log");
  searchStateFile = join(tempDirectory("ark-hub-search-"), "state");
  const orcaFailureFile = join(tempDirectory("ark-hub-orca-fail-"), "state");
  writeFileSync(searchStateFile, "hit");
  writeFileSync(orcaFailureFile, "0");
  process.env.TEST_TERMINAL_LOG = terminalLog;
  process.env.TEST_SESSION_CWD = projectOneDirectory;
  process.env.TEST_SEARCH_STATE_FILE = searchStateFile;
  process.env.TEST_ORCA_FAILURE_FILE = orcaFailureFile;
  process.env.ARK_OMP_SESSIONS = tempDirectory("ark-hub-omp-");
  process.env.ARK_CLAUDE_SESSIONS = tempDirectory("ark-hub-claude-");
  process.env.ARK_CODEX_SESSIONS = tempDirectory("ark-hub-codex-");
  setOrca([]);
  writeFakeOrca(`if [ "$(cat "$TEST_ORCA_FAILURE_FILE")" = "1" ]; then exit 1; fi
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
exit 2`);
});

test("ARK-181-AC6 renders, filters, opens details and switches an agent in headless Chrome", async ({
  page,
}) => {
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
  // The metrics view defaults to the clock's UTC week, so closed runs must be dated at the clock.
  const closedAt = isoAgo(0);
  writeMetrics("one", "ARK-181-CHROME-METRICS-ONE", closedAt, "handed_off", {
    cost: { total_usd: 1 },
    time: { wall_seconds: 60, gate_wait_seconds: 10 },
  });
  writeMetrics("two", "ARK-181-CHROME-METRICS-TWO", closedAt, "handed_off", {
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

  const hub = await startHub();
  try {
    await page.goto(hub.baseUrl);
    await expect(page.locator("[data-view=backlog]")).toBeAttached();
    await expect(page.locator("nav.vbar button")).toHaveCount(8);
    const viewButton = (view: string) => page.locator(`nav.vbar button[data-view="${view}"]`);
    for (const view of ["backlog", "agents", "metrics", "search", "projects"]) {
      const scroll = page.locator(`.scroll[data-view="${view}"]`);
      await viewButton(view).click();
      await expect(scroll).toBeAttached();
      await expect(scroll.locator("button, input").first()).toBeAttached();
      if (view === "metrics")
        await expect(scroll).not.toContainText("Reading metrics", { useInnerText: true });
      if (view === "search") {
        await page.locator('input[aria-label="Search text"]').fill("Chrome-search-needle");
        await page.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
        await expect(page.locator("[data-hit=plan]").first()).toBeAttached();
      }
      await expect(scroll).toContainText(/one/i, { useInnerText: true });
      await expect(scroll).toContainText(/two/i, { useInnerText: true });
      await page
        .locator(".chips button")
        .filter({ hasText: /^\s*one/i })
        .first()
        .click();
      await expect(scroll).toContainText(/one/i, { useInnerText: true });
      await expect(scroll).not.toContainText(/two/i, { useInnerText: true });
      await page
        .locator('.chips button[aria-pressed="false"]')
        .filter({ hasText: /^\s*all/i })
        .first()
        .click();
    }

    await viewButton("backlog").click();
    await page.locator('[data-ticket="one:ARK-181-CHROME-ONE"] button').click();
    await expect(page.locator("aside.detail")).toContainText("One project ticket", {
      useInnerText: true,
    });

    await viewButton("agents").click();
    await page.locator("[data-agent=term_one] button").click();
    await expect(page.locator("aside.detail button").first()).toContainText("Open in Orca");
    await page.locator("aside.detail button").first().click();
    await expect(page.locator("[data-agent=term_one]")).toBeAttached();
    // Orca switching runs as a child process, so wait for its durable output.
    await expect
      .poll(() => (existsSync(terminalLog) ? readFileSync(terminalLog, "utf8") : ""))
      .toContain("terminal switch --terminal term_one");

    await viewButton("search").click();
    await page.locator('input[aria-label="Search text"]').fill("Chrome-search-needle");
    await page.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect(page.locator(".s-needs")).toContainText("Orca history is disabled", {
      useInnerText: true,
    });
  } finally {
    await stopHub(hub.process);
  }
});
