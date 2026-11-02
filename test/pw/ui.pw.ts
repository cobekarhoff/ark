import { expect, test } from "@playwright/test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
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

const basePath = process.env.PATH;
let projectDirectory: string;
let orcaBinDirectory: string;

function projectConfigFor(workspace: string): Record<string, unknown> {
  return {
    workspace,
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
      validator: { harness: "omp", model: "pi/validate" },
      reviewer: { harness: "omp", model: "pi/validate" },
    },
  };
}

test.beforeEach(() => {
  for (const name of [
    "ORCA_FAIL",
    "ORCA_RUN_LIST_FAIL",
    "ORCA_RUN_LIST_FAIL_MARKER",
    "ORCA_DELAY",
    "ORCA_ACTION_LOG",
    "PLANNOTATOR_DATA_DIR",
    "ARK_NOTIFIER",
  ])
    delete process.env[name];
  tempArkHome();
  projectDirectory = writeProject("demo", projectConfigFor(tempGitRepo()));
  process.env.ORCA_TERMINALS = "[]";
  process.env.ORCA_CHIEF_RUNS = "[]";
  process.env.ORCA_RUNS = "[]";
  process.env.ORCA_TASKS = "[]";
  process.env.ORCA_WORKERS = "[]";
  // Earlier tests' stubs must not stay reachable on PATH.
  process.env.PATH = basePath;
  orcaBinDirectory = writeFakeOrca(`if [ "$ORCA_FAIL" = "1" ]; then exit 1; fi
if [ "$ORCA_DELAY" = "1" ]; then sleep 8; fi
if [ "$1" = "terminal" ]; then
  case "$2" in
    show) printf '{"result":{"terminal":{"connected":true,"agentIdentity":"omp"}}}' ;;
    list) printf '{"result":{"terminals":%s}}' "$ORCA_TERMINALS"; exit 0 ;;
    send|switch) printf '%s\\n' "$*" >> "$ORCA_ACTION_LOG"; printf '{"result":{}}' ;;
    create) printf '%s\\n' "$*" >> "$ORCA_ACTION_LOG"; printf '{"result":{"terminal":{"handle":"term_spawned"}}}' ;;
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
    runs=\${ORCA_RUNS#[}; runs=\${runs%]}
    chiefs=\${ORCA_CHIEF_RUNS#[}; chiefs=\${chiefs%]}
    separator=; if [ -n "$runs" ] && [ -n "$chiefs" ]; then separator=,; fi
    printf '{"result":{"runs":[%s%s%s]}}' "$runs" "$separator" "$chiefs"
    ;;
  task-list) printf '{"result":{"tasks":%s}}' "$ORCA_TASKS" ;;
  worker-list) printf '{"result":{"workers":%s}}' "$ORCA_WORKERS" ;;
  *) exit 2 ;;
esac`);
});

function writeCommand(directory: string, name: string, contents: string): string {
  const command = join(directory, name);
  writeFileSync(command, `#!/bin/sh\n${contents}\n`);
  chmodSync(command, 0o755);
  return command;
}

function terminalActionLog(): string[] {
  return readFileSync(process.env.ORCA_ACTION_LOG as string, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
}

function liveChiefTerminal(
  projectWorkspace = JSON.parse(readFileSync(join(projectDirectory, "ark.yml"), "utf8")).workspace,
): object {
  return {
    handle: "term_chief",
    worktreePath: projectWorkspace,
    connected: true,
    agentIdentity: "omp",
  };
}

function openRunSnapshot(runId: string): void {
  process.env.ORCA_RUNS = JSON.stringify([
    {
      id: `orca-${runId}`,
      objective: `Ark run ${runId}`,
      coordinator_handle: "term_lead",
    },
  ]);
  setMasterChiefs([
    liveChiefTerminal(),
    {
      handle: "term_lead",
      worktreePath: JSON.parse(readFileSync(join(projectDirectory, "ark.yml"), "utf8")).workspace,
      connected: true,
      agentIdentity: "omp",
    },
  ]);
}

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

/** Sets the live terminals and, for each, the Master Chief Run its project would have bound it to. */
function setMasterChiefs(terminals: object[]): void {
  process.env.ORCA_TERMINALS = JSON.stringify(terminals);
  const projectsDirectory = join(process.env.ARK_HOME as string, "projects");
  const workspaceToProject = new Map(
    readdirSync(projectsDirectory).map((name) => [
      JSON.parse(readFileSync(join(projectsDirectory, name, "ark.yml"), "utf8")).workspace,
      name,
    ]),
  );
  process.env.ORCA_CHIEF_RUNS = JSON.stringify(
    terminals.flatMap((terminal) => {
      const { handle, worktreePath } = terminal as {
        handle: string;
        worktreePath: string;
      };
      const project = workspaceToProject.get(worktreePath);
      return project
        ? [
            {
              id: `orca-chief-${project}`,
              objective: `Master Chief: ${project} tickets`,
              coordinator_handle: handle,
            },
          ]
        : [];
    }),
  );
}

async function withUi<T>(callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const hub = await startHub();
  try {
    return await callback(hub.baseUrl);
  } finally {
    await stopHub(hub.process);
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
  appendEvent(run.directory, "gate.answered", {
    gate: "plan",
    answer: "approve",
  });
  appendEvent(run.directory, "step.started", {
    step,
    role: "implementer",
    repo: ".",
    round: 1,
  });
}

type Hub = {
  projects: { name: string; chief: Record<string, unknown> }[];
  runs: Record<string, any>[];
  needs_me: Record<string, any>[];
  readers: { orca: string; plannotator: string; plannotator_error: string | null };
};

/** The first orca read runs in the background after start; wait for it. */
async function hubState(baseUrl: string): Promise<Hub> {
  let data: Hub | undefined;
  await expect
    .poll(
      async () => {
        data = (await (await fetch(`${baseUrl}/api/state`)).json()) as Hub;
        return data.readers.orca;
      },
      { message: "orca was never read" },
    )
    .toBe("ok");
  return data as Hub;
}

function setupNotifier(): { log: string; commandDirectory: string } {
  const commandDirectory = tempDirectory("ark-notifier-");
  const log = join(commandDirectory, "notifier.log");
  writeCommand(commandDirectory, "notifier", `printf '%s\\n' "$@" >> "${log}"`);
  return { log, commandDirectory };
}

test("ARK-177-AC4 hub abort dialog sends only after the human confirms", async ({ page }) => {
  const run = startRun("ARK-177-M3", "Confirm abort");
  const actionLog = join(tempDirectory("ark-steering-"), "calls.txt");
  process.env.ORCA_ACTION_LOG = actionLog;
  openRunSnapshot(run.runId);

  await withUi(async (baseUrl) => {
    await page.goto(baseUrl);
    await page.locator(`[data-run="${run.runId}"] button.row-main`).click();
    await page.locator("button.danger").click();
    await expect(page.locator("[role=alertdialog]")).toBeVisible();
    await expect(page.locator(".steer-quote")).toHaveText(
      `Hub: abort run ${run.runId}. The human confirmed it.`,
    );
    await page.locator('[role="alertdialog"] button:not(.danger)').click();
    await expect(page.locator("[role=alertdialog]")).toBeHidden();
    expect(existsSync(actionLog)).toBe(false);
    await page.locator("button.danger").click();
    await page.locator('[role="alertdialog"] button.danger').click();
    await expect.poll(() => existsSync(actionLog)).toBe(true);
    expect(terminalActionLog()).toEqual([
      `terminal send --terminal term_chief --text Hub: abort run ${run.runId}. The human confirmed it. --enter --json`,
    ]);
  });
});

test("ARK-177-AC6 offers Spawn only without a live chief and creates then switches its terminal", async ({
  page,
}) => {
  const arkWorkspace = tempGitRepo();
  const otherWorkspace = tempGitRepo();
  const arkConfig = projectConfigFor(arkWorkspace);
  arkConfig.roles = {
    ...(arkConfig.roles as object),
    chief: { harness: "omp", model: "pi/task" },
  };
  writeProject("ark", arkConfig);
  const otherConfig = projectConfigFor(otherWorkspace);
  otherConfig.roles = {
    ...(otherConfig.roles as object),
    chief: { harness: "omp", model: "pi/task" },
  };
  writeProject("other", otherConfig);
  const actionLog = join(tempDirectory("ark-steering-"), "calls.txt");
  process.env.ORCA_ACTION_LOG = actionLog;
  setMasterChiefs([liveChiefTerminal(otherWorkspace), liveChiefTerminal()]);

  await withUi(async (baseUrl) => {
    await page.goto(baseUrl);
    const state = await hubState(baseUrl);
    expect(state.projects.map(({ name, chief }) => [name, chief.state])).toEqual([
      ["ark", "missing"],
      ["demo", "live"],
      ["other", "live"],
    ]);
    await expect(page.locator("[data-chief=live]").first()).toBeVisible();
    await expect(page.locator("body")).toContainText("Spawn Master Chief");
    const spawnBoxes = page.locator(".chief-box").filter({
      has: page.getByRole("button", { name: "Spawn Master Chief", exact: true }),
    });
    await expect(spawnBoxes.locator("h3 b")).toHaveText(["ark"]);
    await page
      .locator('.chief-box[aria-label="Master Chief for ark"] > .steer-row button.primary')
      .click();
    // Create and switch are two sequential orca calls; wait for both lines.
    await expect.poll(() => (existsSync(actionLog) ? terminalActionLog().length : 0)).toBe(2);
    expect(terminalActionLog()).toEqual([
      `terminal create --worktree path:${arkWorkspace} --title Master Chief: ark --command omp --model pi/task "/skill:ark chief" --json`,
      "terminal switch --terminal term_spawned",
    ]);

    const refusedLive = await fetch(`${baseUrl}/api/actions/chief-spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "other" }),
    });
    expect(refusedLive.status).toBe(409);
    writeProject("no-chief-role", projectConfigFor(tempGitRepo()));
    const refusedMissingRole = await fetch(`${baseUrl}/api/actions/chief-spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "no-chief-role" }),
    });
    expect(refusedMissingRole.status).toBe(400);
    expect(await refusedMissingRole.json()).toMatchObject({
      error: expect.stringContaining("roles.chief"),
    });
    expect(terminalActionLog()).toHaveLength(2);
  });
});

test("ARK-176-AC7 Home renders panels, age colors, and filters all project data", async ({
  page,
}) => {
  const olderRun = startRun("ARK-176-G1", "Older project run");
  planGate(olderRun.directory);
  setEventTime(olderRun.directory, "plan.checked", isoAgo(150 * 60_000));
  const secondProject = writeProject("other", projectConfigFor(tempGitRepo()));
  const newerRun = startProjectRun("other", "ARK-176-G2", "Newer project run");
  planGate(newerRun.directory);
  setEventTime(newerRun.directory, "plan.checked", isoAgo(45 * 60_000));
  const liveRun = startRun("ARK-176-G3", "Live project run");
  readyRun(liveRun);
  appendEvent(liveRun.directory, "step.finished", {
    step: "build",
    outcome: "succeeded",
  });
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
        projection: {
          liveness: { verdict: "live" },
          stage: { activity: "working" },
        },
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

  await page.setViewportSize({ width: 1440, height: 1000 });
  const bodyText = () => page.locator("body").innerText();
  await withUi(async (baseUrl) => {
    await page.goto(baseUrl);
    await expect(page.locator("[data-need]").first()).toBeVisible();
    for (const label of [
      "Agents working",
      "Gates waiting",
      "Cost today",
      "Live runs",
      "Needs me",
      "Master Chief",
      "worker",
    ])
      await expect.poll(bodyText).toContain(label);
    await expect.poll(bodyText).toContain("Welcome, steps finished: 1; items waiting for you: 2.");
    await expect.poll(bodyText).toContain("demo\nlive · omp · pi/task");
    await expect.poll(bodyText).toContain("other\nmissing");
    await expect(page.locator("[data-heat=hot]").first()).toBeAttached();
    await expect(page.locator("[data-heat=warm]").first()).toBeAttached();
    await expect.poll(bodyText).toContain("ARK-176-G1 waits for you to approve its plan");
    await expect.poll(bodyText).toContain("ARK-176-G3 is building: 1 of 1 steps done");
    await page.locator('button.chip[aria-pressed="false"]').first().click();
    await expect(page.locator("[data-run]")).toHaveCount(2);
    await expect(page.locator(".stats .tile")).toHaveCount(4);
    await expect(page.locator("[data-need]")).toHaveCount(1);
    await expect(page.locator(".achip")).toHaveCount(4);
    await expect(page.locator(".chief-item")).toHaveCount(1);
    const filtered = await bodyText();
    expect(filtered).toContain("ARK-176-G1");
    expect(filtered).toContain("ARK-176-G3 is building: 1 of 1 steps done");
    expect(filtered).not.toContain("ARK-176-G2");
    expect(filtered).toContain(basename(secondProject));
  });
});

test("ARK-176-AC8 keyboard navigation, actions, overlays, and focus mode work in Home", async ({
  page,
}) => {
  const firstRun = startRun("ARK-176-H1", "First keyboard item");
  planGate(firstRun.directory);
  writeFileSync(join(firstRun.directory, "plan.md"), "# Plan\n");
  const secondRun = startRun("ARK-176-H2", "Second keyboard item");
  planGate(secondRun.directory);
  const thirdRun = startRun("ARK-176-H3", "Third keyboard item");
  planGate(thirdRun.directory);
  setOrcaRuns([]);
  const actionLog = join(tempDirectory("ark-key-actions-"), "calls.txt");
  process.env.ORCA_ACTION_LOG = actionLog;
  writeCommand(orcaBinDirectory, "plannotator", `printf '%s\\n' "$*" >> "$ORCA_ACTION_LOG"`);

  const selectedNeed = () =>
    page.evaluate(
      () =>
        (document.querySelector("[data-need][aria-current=true]") as HTMLElement | null)?.dataset
          .need,
    );
  await withUi(async (baseUrl) => {
    await page.goto(baseUrl);
    await expect(page.locator("[data-need]")).toHaveCount(3);
    const selectedBefore = await selectedNeed();
    await page.keyboard.press("j");
    await expect.poll(selectedNeed).not.toBe(selectedBefore);
    await page.keyboard.press("k");
    await expect.poll(selectedNeed).toBe(selectedBefore);
    await page.keyboard.press("p");
    await expect(page.locator("#toasts .toast").first()).toBeVisible();
    const expectedAction = join(firstRun.directory, "plan.md");
    // The action launches a detached process; wait for its real side effect, not the HTTP response.
    await expect
      .poll(() => (existsSync(actionLog) ? readFileSync(actionLog, "utf8") : ""))
      .toContain(expectedAction);
    await page.keyboard.press("Enter");
    await expect(page.locator(".detail h2")).toContainText("First keyboard item");
    await page.keyboard.press("Meta+k");
    await expect(page.locator('[aria-label="Command palette"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[aria-label="Command palette"]')).toHaveCount(0);
    await page.keyboard.press("?");
    await expect(page.locator("#sheet-title")).toHaveText("Keyboard shortcuts");
    await page.keyboard.press("Escape");
    await expect(page.locator("#sheet-title")).toHaveCount(0);
    await page.keyboard.press("z");
    await expect(page.locator(".app")).toHaveAttribute("data-focus", "true");
    await page.keyboard.press("z");
    await expect(page.locator(".app")).toHaveAttribute("data-focus", "false");
  });
});

test("ARK-178-AC3 the Notifications view orders persisted rows newest first with acted text", async ({
  page,
}) => {
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
      JSON.stringify({
        acted: "gate:middle:plan",
        time: "2026-01-02T11:00:00.000Z",
      }),
    ].join("\n")}\n`,
  );
  await withUi(async (baseUrl) => {
    await page.goto(baseUrl);
    await expect(page.locator("[data-notification]")).toHaveCount(3);
    const displayedNotifications = await page.locator("[data-notification]").evaluateAll((rows) =>
      rows.map((row) => ({
        id: (row as HTMLElement).dataset.notification as string,
        text: (row as HTMLElement).innerText,
      })),
    );
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
});

test("ARK-178-AC4 a notification opens the hub at its item and records that it was acted on", async ({
  page,
}) => {
  const { log, commandDirectory } = setupNotifier();
  process.env.ARK_NOTIFIER = join(commandDirectory, "notifier");
  const hub = await startHub();
  try {
    const { baseUrl } = hub;
    await hubState(baseUrl);
    // Let the first refresh and Ark notification baseline complete before the new run appears.
    await sleep(1100);
    const newRun = startRun("ARK-178-N5", "Notification click target");
    planGate(newRun.directory);
    const notificationId = `gate:${newRun.runId}:plan`;
    const notifierLog = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
    await expect
      .poll(() => notifierLog().includes(notificationId) && notifierLog().includes("-open"))
      .toBe(true);
    expect(notifierLog()).toContain(`${baseUrl}/#item=${notificationId}`);

    await page.goto(`${baseUrl}/#item=${encodeURIComponent(notificationId)}`);
    await expect(page.locator(`[data-need="${notificationId}"]`)).toBeVisible();
    await expect
      .poll(async () => {
        const apiState = (await (await fetch(`${baseUrl}/api/state`)).json()) as Hub & {
          notifications: { id: string; acted: boolean }[];
        };
        return apiState.notifications.find((entry) => entry.id === notificationId)?.acted;
      })
      .toBe(true);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
    await expect(page.locator(".detail h2")).toContainText("Notification click target");
  } finally {
    await stopHub(hub.process);
  }
});

const leadSlot = '[data-slot="run-lead-message"]';

// Shadow any plannotator on PATH so the hub's session poll does not write to this test's action log.
function shadowPlannotator(): void {
  writeCommand(orcaBinDirectory, "plannotator", "printf '[]'");
}

test("ARK-215-AC1 run detail slot sends a typed message to the live run lead terminal", async ({
  page,
}) => {
  const run = startRun("ARK-215-LIVE", "Slot sends");
  readyRun(run);
  const actionLog = join(tempDirectory("ark-steering-"), "calls.txt");
  process.env.ORCA_ACTION_LOG = actionLog;
  shadowPlannotator();
  openRunSnapshot(run.runId);

  await withUi(async (baseUrl) => {
    await page.goto(`${baseUrl}/#run=${run.runId}`);
    // The slot exists only after the detail page has mounted with its data.
    await expect(page.locator(`${leadSlot} input`)).toBeVisible();
    await expect(page.locator(`${leadSlot} form`)).toBeAttached();
    await page.locator(`${leadSlot} input`).fill("use the smaller step");
    await page.locator(`${leadSlot} button[type=submit]`).click();
    await expect.poll(() => existsSync(actionLog)).toBe(true);
    expect(terminalActionLog()).toEqual([
      "terminal send --terminal term_lead --text use the smaller step --enter --json",
    ]);
  });
});

test("ARK-215-AC2 run detail slot says no run lead is live and sends nothing", async ({ page }) => {
  const run = startRun("ARK-215-NONE", "Slot without lead");
  const actionLog = join(tempDirectory("ark-steering-"), "calls.txt");
  process.env.ORCA_ACTION_LOG = actionLog;
  shadowPlannotator();
  setOrcaRuns([]);

  await withUi(async (baseUrl) => {
    await page.goto(`${baseUrl}/#run=${run.runId}`);
    await expect(page.locator(leadSlot)).toContainText("No run lead is live");
    await expect(page.locator(`${leadSlot} input, ${leadSlot} button`)).toHaveCount(0);
    expect(existsSync(actionLog)).toBe(false);
  });
});

const approveBox = '.chief-box[aria-label="Master Chief for alpha"]';
const proposedTitles = ["Alpha one", "Alpha two", "Alpha three"];

/** Project alpha (own repo, live chief) with ARK-185..187 proposed, one ready ticket, and a send log. */
function seedAlpha(proposed = true): string {
  const workspace = tempGitRepo();
  writeProject("alpha", projectConfigFor(workspace));
  const addStatus = (file: string, status: string) =>
    writeFileSync(file, readFileSync(file, "utf8").replace("---\n", `---\nstatus: ${status}\n`));
  ["ARK-185", "ARK-186", "ARK-187"].forEach((id, index) =>
    addStatus(
      writeTicket("alpha", id, [{ id: `${id}-AC1`, text: "It works" }], proposedTitles[index]),
      proposed ? "proposed" : "draft",
    ),
  );
  addStatus(writeTicket("alpha", "ARK-188", [], "Alpha ready"), "ready");
  const actionLog = join(tempDirectory("ark-steering-"), "calls.txt");
  process.env.ORCA_ACTION_LOG = actionLog;
  setMasterChiefs([{ ...liveChiefTerminal(workspace), handle: "term_alpha" }]);
  return actionLog;
}

test("ARK-258-AC1 Backlog approve names only the open ticket", async ({ page }) => {
  const actionLog = seedAlpha();
  await withUi(async (baseUrl) => {
    await page.goto(baseUrl);
    await page.locator('nav.vbar button[data-view="backlog"]').click();
    await page.locator('[data-ticket="alpha:ARK-185"] button').click();
    await expect(page.locator("aside.detail")).toContainText("ARK-185");
    const request = page.waitForRequest("**/api/actions/chief-instruction");
    await page.locator("aside.detail").getByRole("button", { name: "Approve and queue" }).click();
    expect((await request).postDataJSON()).toMatchObject({ tickets: ["ARK-185"] });
    await expect.poll(() => existsSync(actionLog)).toBe(true);
    const [line, ...rest] = terminalActionLog();
    expect(rest).toEqual([]);
    expect(line).toContain("--terminal term_alpha");
    expect(line).toContain("ARK-185");
    expect(line).not.toMatch(/ARK-18[67]/);
    expect(line).not.toContain("the proposed tickets in the order shown");
  });
});

test("ARK-258-AC2 server answers 400 and sends nothing for a bad ticket list", async () => {
  const actionLog = seedAlpha();
  await withUi(async (baseUrl) => {
    const base = { project: "alpha", instruction: "approve-and-queue" };
    for (const tickets of [
      undefined,
      [],
      ["ARK-188"],
      ["ARK-999"],
      "ARK-185",
      ["ARK-185", 186],
      ["ARK-185", "ARK-185"],
    ]) {
      const response = await fetch(`${baseUrl}/api/actions/chief-instruction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...base, tickets }),
      });
      expect(response.status, JSON.stringify(tickets)).toBe(400);
      expect(existsSync(actionLog)).toBe(false);
    }
  });
});

test("ARK-258-AC3 box approve lists proposed tickets and sends only on confirm", async ({
  page,
}) => {
  const actionLog = seedAlpha();
  await withUi(async (baseUrl) => {
    await page.goto(baseUrl);
    const open = async () => {
      await page.locator(approveBox).getByRole("button", { name: "Approve and queue" }).click();
      const dialog = page.locator("[role=alertdialog]");
      await expect(dialog).toBeVisible();
      return dialog;
    };
    let dialog = await open();
    const rows = dialog.locator(".approve-list li");
    await expect(rows).toHaveCount(3);
    for (const [index, id] of ["ARK-185", "ARK-186", "ARK-187"].entries())
      await expect(rows.nth(index)).toHaveText(`${id} ${proposedTitles[index]}`);
    await expect(dialog).not.toContainText("ARK-188");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(existsSync(actionLog)).toBe(false);
    await page
      .getByRole("group", { name: "Project filter" })
      .locator("button")
      .filter({ hasText: /^alpha/ })
      .click();
    dialog = await open();
    await expect(dialog.locator(".approve-list li")).toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(existsSync(actionLog)).toBe(false);
    dialog = await open();
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => existsSync(actionLog)).toBe(true);
    const [line, ...rest] = terminalActionLog();
    expect(rest).toEqual([]);
    expect([...line.matchAll(/ARK-\d+/g)].map(([id]) => id).sort()).toEqual([
      "ARK-185",
      "ARK-186",
      "ARK-187",
    ]);
  });
});

test("ARK-258-AC4 box approve is disabled with a reason when nothing is proposed", async ({
  page,
}) => {
  seedAlpha(false);
  await withUi(async (baseUrl) => {
    await page.goto(baseUrl);
    const box = page.locator(approveBox);
    await expect(box).toBeVisible();
    await expect(box.getByRole("button", { name: "Approve and queue" })).toBeDisabled();
    await expect(box).toContainText("No proposed tickets");
  });
});

test("ARK-258-AC5 Backlog approve of one ticket shows its toast and sends only that ticket", async ({
  page,
}) => {
  const actionLog = seedAlpha();
  await withUi(async (baseUrl) => {
    await page.goto(baseUrl);
    await page.locator('nav.vbar button[data-view="backlog"]').click();
    await page.locator('[data-ticket="alpha:ARK-185"] button').click();
    await page.locator("aside.detail").getByRole("button", { name: "Approve and queue" }).click();
    await expect(page.locator("#toasts")).toContainText("Approve and queue ARK-185");
    await expect.poll(() => existsSync(actionLog)).toBe(true);
    const [line, ...rest] = terminalActionLog();
    expect(rest).toEqual([]);
    expect([...line.matchAll(/ARK-\d+/g)].map(([id]) => id)).toEqual(["ARK-185"]);
  });
});
