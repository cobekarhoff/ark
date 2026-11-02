import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../../cli/events.ts";
import { planHash } from "../../cli/plan.ts";
import {
  ark,
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

let projectDirectory: string;
let orcaStateDirectory: string;
let orcaTailFile: string;

test.beforeEach(() => {
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
  orcaStateDirectory = tempDirectory("ark179-orca-state-");
  orcaTailFile = join(orcaStateDirectory, "tail.json");
  process.env.ARK_OMP_SESSIONS = tempDirectory("ark179-omp-");
  process.env.ARK_CLAUDE_SESSIONS = tempDirectory("ark179-claude-");
  process.env.ARK_CODEX_SESSIONS = tempDirectory("ark179-codex-");
  process.env.ORCA_STATE_DIRECTORY = orcaStateDirectory;
  process.env.ORCA_TAIL_FILE = orcaTailFile;
  process.env.ORCA_READ_FAIL_HANDLE = "";
  writeFileSync(join(orcaStateDirectory, "run-list"), '{"result":{"runs":[]}}');
  writeFileSync(join(orcaStateDirectory, "task-list"), '{"result":{"tasks":[]}}');
  writeFileSync(join(orcaStateDirectory, "worker-list"), '{"result":{"workers":[]}}');
  writeFileSync(orcaTailFile, "[]");
  writeFakeOrca(`if [ "$1" = "terminal" ]; then
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
cat "$ORCA_STATE_DIRECTORY/$2"`);
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

test("ARK-179-AC7 headless run detail shows every panel and refreshes step state and output without reload", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  const hub = await startHub();
  try {
    await expect
      .poll(async () => {
        const state = await (await page.request.get(`${hub.baseUrl}/api/state`)).json();
        return state.readers.orca;
      })
      .toBe("ok");
    await page.goto(`${hub.baseUrl}/#run=${run.runId}`);
    const detail = page.locator(`[data-run-detail="${run.runId}"]`);
    await expect(detail).toBeVisible();
    await expect
      .poll(() =>
        detail
          .locator("[data-detail-section]")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-detail-section")),
          ),
      )
      .toEqual(
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
    await expect(detail.locator("[data-detail-cost]").first()).toBeAttached();
    await expect(detail.locator('[data-output="lines"]').first()).toContainText("first output");
    await expect(detail.locator('[data-slot="run-lead-message"]').first()).toBeAttached();
    const pageUrl = page.url();
    appendEvent(run.directory, "step.finished", { step: "build", outcome: "succeeded" });
    writeFileSync(orcaTailFile, JSON.stringify(["updated output"]));
    await expect(page.locator("body")).toContainText("updated output");
    await expect(detail.locator('[data-step-node="build"] span').first()).toHaveText(
      "implementer · succeeded",
    );
    expect(page.url()).toBe(pageUrl);
  } finally {
    await stopHub(hub.process);
  }
});
