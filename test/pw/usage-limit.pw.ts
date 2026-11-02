import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Item } from "../../cli/hub/types.ts";
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

const workerHandle = "term_limit";
let orcaStateDirectory: string;
let terminalLog: string;
let runId: string;

const limitLine = (waitSeconds: number) =>
  JSON.stringify({
    type: "error",
    error: { type: "usage_limit_reached", resets_in_seconds: waitSeconds },
  });

test.beforeEach(() => {
  tempArkHome();
  const projectDirectory = writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [
      {
        name: "cli",
        level: "integration",
        repo: ".",
        command: "bun test",
        parser: "bun",
      },
    ],
    roles: {
      implementer: { harness: "omp", model: "pi/task" },
      validator: { harness: "omp", model: "pi/task" },
      reviewer: { harness: "omp", model: "pi/task" },
    },
  });
  orcaStateDirectory = tempDirectory("ark199-state-");
  terminalLog = join(orcaStateDirectory, "terminal.log");
  process.env.ORCA_STATE_DIRECTORY = orcaStateDirectory;
  process.env.ARK_OMP_SESSIONS = tempDirectory("ark199-omp-");
  process.env.ARK_CLAUDE_SESSIONS = tempDirectory("ark199-claude-");
  process.env.ARK_CODEX_SESSIONS = tempDirectory("ark199-codex-");

  const ticketFile = writeTicket("demo", "ARK-199-LIMIT", [
    { id: "ARK-199-LIMIT-AC1", text: "Any criterion" },
  ]);
  const started = ark("run", "start", ticketFile, "--project", "demo");
  expect(started.code).toBe(0);
  runId = started.out.trim();
  recordEvaluation(join(projectDirectory, "runs", runId));

  writeFileSync(
    join(orcaStateDirectory, "run-list"),
    JSON.stringify({
      result: {
        runs: [
          {
            id: "orca-run",
            objective: `Ark run ${runId}`,
            coordinator_handle: "term_lead",
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(orcaStateDirectory, "task-list"),
    JSON.stringify({
      result: { tasks: [{ id: "task-limit", task_title: "limit-tests" }] },
    }),
  );
  writeFileSync(
    join(orcaStateDirectory, "worker-list"),
    JSON.stringify({
      result: {
        workers: [
          {
            taskId: "task-limit",
            agentTerminalHandle: workerHandle,
            projection: {
              liveness: { verdict: "live" },
              provider: { model: "pi/task" },
            },
          },
        ],
      },
    }),
  );
  writeFileSync(join(orcaStateDirectory, `tail-${workerHandle}`), JSON.stringify([]));

  // Per-terminal tails and a read failure switch, so one test can change what each refresh reads.
  writeFakeOrca(`if [ "$1" = "terminal" ]; then
  case "$2" in
    show) printf '{"result":{"terminal":{"connected":true,"agentIdentity":"omp"}}}' ;;
    list) cat "$ORCA_STATE_DIRECTORY/terminal-list" 2>/dev/null || printf '{"result":{"terminals":[]}}' ;;
    switch) printf '%s\\n' "$*" >> "$ORCA_STATE_DIRECTORY/terminal.log"; printf '{"result":{}}' ;;
    read)
      printf '%s\\n' "$4" >> "$ORCA_STATE_DIRECTORY/reads.log"
      if [ -e "$ORCA_STATE_DIRECTORY/fail-$4" ]; then
        printf 'failed %s\\n' "$4" >> "$ORCA_STATE_DIRECTORY/read.log"
        exit 1
      fi
      if [ -e "$ORCA_STATE_DIRECTORY/tail-$4" ]; then
        printf '{"result":{"terminal":{"tail":%s}}}' "$(cat "$ORCA_STATE_DIRECTORY/tail-$4")"
      else
        printf '{"result":{"terminal":{"tail":[]}}}'
      fi
      ;;
    *) exit 2 ;;
  esac
  exit 0
fi
cat "$ORCA_STATE_DIRECTORY/$2"`);
});

test("ARK-199-AC3 the headless Map lists the usage_limit item on its agent node, as the API counts it", async ({
  page,
}) => {
  writeFileSync(
    join(orcaStateDirectory, `tail-${workerHandle}`),
    JSON.stringify([limitLine(4805)]),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const hub = await startHub();
  try {
    // The hub refreshes Orca every 3 seconds.
    await expect
      .poll(async () => {
        const state = (await (await fetch(`${hub.baseUrl}/api/state`)).json()) as {
          needs_me: Item[];
        };
        return state.needs_me.filter((item) => item.kind === "usage_limit").length;
      })
      .toBe(1);
    await page.goto(hub.baseUrl);
    await expect(page.locator("nav.vbar")).toBeVisible();
    await page.keyboard.press("2");
    const node = page.locator(`[data-node="agent:${runId}:${workerHandle}"]`);
    await expect(node).toBeAttached();
    await node.dispatchEvent("click");
    await expect(page.locator("aside.detail button.btn.primary")).toHaveText(["Open in Orca"]);
  } finally {
    await stopHub(hub.process);
  }
});

test("ARK-199-AC3 headless Home shows the usage_limit item with a countdown and its action switches Orca to the agent", async ({
  page,
}) => {
  writeFileSync(
    join(orcaStateDirectory, `tail-${workerHandle}`),
    JSON.stringify([limitLine(4805)]),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const hub = await startHub();
  try {
    await page.goto(hub.baseUrl);
    const row = page.locator(`[data-need^="limit:"]`);
    // 4805 seconds is 80 minutes and a few seconds, so the page rounds up to 1h 21m or 1h 20m.
    await expect(row.locator("[data-countdown]")).toHaveText(/^codex · resets in 1h 2?[01]m$/);
    await row.locator("button.act").click();
    await expect
      .poll(() => {
        try {
          return readFileSync(terminalLog, "utf8");
        } catch {
          return "";
        }
      })
      .toContain(`terminal switch --terminal ${workerHandle}`);
  } finally {
    await stopHub(hub.process);
  }
});
