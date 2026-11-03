import { expect, test, type Page, type Request } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import {
  appendRawEvent,
  ompMessagesText,
  orcaAnswersFor,
  today,
  transcriptText,
  transcriptTexts,
  writeBacklogTicket,
  writeEventLog,
  writeFakeToolState,
  writeOmpSession,
  writeRun,
  writeSessionFile,
  type FixtureRun,
  type SessionHarness,
} from "../hub-fixtures.ts";
import {
  installFakeTools,
  startHub,
  stopHub,
  type StartedHub,
  tempArkHome,
  tempDirectory,
  useCleanup,
  writeProject,
} from "./helpers.ts";

useCleanup();
// useCleanup freezes ARK_NOW for the hub clock; the hub reads real time here, as the fixtures do.
test.beforeAll(() => {
  delete process.env.ARK_NOW;
});

const started: StartedHub[] = [];
test.afterEach(async () => {
  await Promise.all(started.splice(0).map((hub) => stopHub(hub.process)));
});

async function launch(): Promise<string> {
  const hub = await startHub();
  started.push(hub);
  return hub.baseUrl;
}

/** A fresh ARK_HOME and empty session roots, so no test reads the real `~/.omp`, `~/.claude` or `~/.codex`. */
function isolate(): { sessions: string } {
  tempArkHome();
  const sessions = tempDirectory("ark-omp-sessions-");
  process.env.ARK_OMP_SESSIONS = sessions;
  process.env.ARK_CLAUDE_SESSIONS = tempDirectory("ark-claude-sessions-");
  process.env.ARK_CODEX_SESSIONS = tempDirectory("ark-codex-sessions-");
  return { sessions };
}

const runId = (ticket: string, number = 1) => `${today()}-${ticket}-${number}`;
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

/** Opens a view and waits for the app to mount (the main heading) before any input. */
async function open(page: Page, baseUrl: string, hash: string): Promise<void> {
  await page.goto(`${baseUrl}/#/${hash}`);
  await expect(page.locator("main h1")).toBeVisible();
}

const percentile95 = (durations: number[]) =>
  [...durations].sort((left, right) => left - right)[Math.ceil(durations.length * 0.95) - 1];

// ---------------------------------------------------------------- AC3

test("ARK-277-AC3 handlers read only memory: p95 under 200 ms on 25 runs and 300 sessions while Orca sleeps 3 s", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { sessions } = isolate();
  const runs: FixtureRun[] = Array.from({ length: 25 }, (_, number) => {
    const ticket = `ARK-${100 + number}`;
    return {
      project: "p",
      run: runId(ticket),
      ticket: { id: ticket, title: `Ticket ${number}` },
      phase: (["building", "planning", "awaiting_criteria", "merge_requests_open"] as const)[
        number % 4
      ],
      mergeRequests:
        number % 4 === 3
          ? [{ repo: ".", url: `https://github.com/example/repo/pull/${number}`, number }]
          : undefined,
    };
  });
  for (const fixture of runs) {
    const directory = writeRun(fixture);
    writeBacklogTicket({
      project: "p",
      id: fixture.ticket.id,
      title: fixture.ticket.title,
      status: "ready",
    });
    for (let file = 0; file < 12; file++)
      writeOmpSession(
        sessions,
        `${fixture.run}-${file}`,
        join(directory, "workspace"),
        Array.from({ length: 20 }, (_, message) => ({ time: ago(60 + message), costUsd: 0.001 })),
      );
  }
  const state = installFakeTools({ orca: orcaAnswersFor(runs[0].run), orcaSleepSeconds: 3 });
  const baseUrl = await launch();

  // One page on each view.
  const context = await browser.newContext();
  const pages = await Promise.all(["", "runs", "backlog"].map(() => context.newPage()));
  await Promise.all(
    ["", "runs", "backlog"].map((hash, index) => open(pages[index], baseUrl, hash)),
  );
  await expect(pages[0].getByTestId("run")).toHaveCount(25);
  // Orca is being called and is slow: its calls outlast the reader's timeout.
  await expect
    .poll(() => {
      const log = join(state, "orca.log");
      return existsSync(log) ? readFileSync(log, "utf8").split("\n").length : 0;
    })
    .toBeGreaterThan(2);

  const timeRoute = async (route: string): Promise<number> => {
    const startedAt = performance.now();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}${route}`, { signal: controller.signal });
    // The event stream never ends: its first chunk is its answer.
    if (route === "/events") await response.body!.getReader().read();
    else await response.arrayBuffer();
    const elapsed = performance.now() - startedAt;
    controller.abort();
    return elapsed;
  };
  for (const route of ["/", "/nope", "/api/snapshot", "/events"]) {
    const durations: number[] = [];
    for (let request = 0; request < 50; request++) durations.push(await timeRoute(route));
    expect(percentile95(durations), `p95 of ${route}`).toBeLessThan(200);
  }

  const snapshot = (await (await fetch(`${baseUrl}/api/snapshot`)).json()) as {
    sources: { orca: { ok: boolean } };
  };
  expect(snapshot.sources.orca.ok).toBe(false); // every Orca call timed out: the page was served anyway
  await context.close();
});

// ---------------------------------------------------------------- AC4

test("ARK-277-AC4 the page sends no request but its first load and one event stream, and an appended event shows on Home within 5 s", async ({
  page,
}) => {
  test.setTimeout(300_000);
  isolate();
  const run = runId("ARK-201");
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-201", title: "Watched run" },
    phase: "building",
    steps: [
      {
        id: "build",
        role: "implementer",
        harness: "omp",
        model: "anthropic/claude-test-model",
        needs: [],
        startedAfter: 40,
      },
    ],
  });
  writeBacklogTicket({ project: "p", id: "ARK-201", title: "Watched run", status: "ready" });
  writeBacklogTicket({
    project: "p",
    id: "ARK-202",
    title: "Next",
    status: "ready",
    dependsOn: ["ARK-201"],
  });
  installFakeTools({ orca: orcaAnswersFor(run) });
  const baseUrl = await launch();

  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  await open(page, baseUrl, "");
  await expect(page.getByTestId("run")).toHaveCount(1);
  await expect(page.getByTestId("stale-label")).toHaveCount(0); // every source answered: the first load is complete
  const firstLoad = requests.length;

  const firstLoadPaths = requests.map((request) => new URL(request.url()).pathname);
  expect(firstLoadPaths.filter((path) => path === "/events")).toHaveLength(1);
  for (const path of firstLoadPaths)
    expect(path === "/" || path === "/events" || path.startsWith("/assets/"), path).toBe(true);

  const views = [
    ["Home", "Needs me"],
    ["Runs", "Runs"],
    ["Backlog", "Backlog"],
  ] as const;
  for (const [name, heading] of views) {
    const viewStartedAt = Date.now();
    await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { name: new RegExp(heading) }).first()).toBeVisible();
    if (name === "Home") {
      // An event appended to the log of the open run reaches Home with no request of the page.
      const appendedAt = Date.now();
      appendRawEvent(
        directory,
        "merge_request.opened",
        { repo: ".", url: "https://github.com/example/repo/pull/77", number: 77 },
        99,
      );
      await expect(page.getByTestId("mr")).toContainText("!77", { timeout: 5000 });
      expect(Date.now() - appendedAt).toBeLessThan(5000);
    }
    // The AC is about 30 s of silence on each view: a real wait, there is no event to wait for.
    await page.waitForTimeout(Math.max(0, 30_000 - (Date.now() - viewStartedAt)));
  }

  // No view reads anything after the first load: Runs and Backlog draw from the snapshot, and the
  // run page (`GET /api/run/<run>`, ARK-284) is not opened here.
  expect(requests.slice(firstLoad).map((request) => new URL(request.url()).pathname)).toEqual([]);
});

// ---------------------------------------------------------------- AC7

test("ARK-277-AC7 Home shows the tiles first, then the gate, each open run with its MR, CI state and cost, and the run page its agents", async ({
  page,
}) => {
  const { sessions } = isolate();
  const mergeRequest = "https://github.com/example/repo/pull/71";
  const reviewUrl = "http://localhost:20000/review/abc";
  const building = writeRun({
    project: "p",
    run: runId("ARK-701"),
    ticket: { id: "ARK-701", title: "Run with a failing MR" },
    phase: "merge_requests_open",
    mergeRequests: [{ repo: ".", url: mergeRequest, number: 71 }],
  });
  const waiting = writeRun({
    project: "p",
    run: runId("ARK-702"),
    ticket: { id: "ARK-702", title: "Run at a gate" },
    phase: "awaiting_criteria",
  });
  writeOmpSession(sessions, "a", join(building, "workspace"), [{ time: ago(100), costUsd: 1.25 }]);
  const state = installFakeTools({
    orca: orcaAnswersFor(runId("ARK-701")),
    failingMergeRequests: [mergeRequest],
    plannotatorSessions: [{ index: 1, target: join(waiting, "ticket.md"), url: reviewUrl }],
  });
  const baseUrl = await launch();
  await open(page, baseUrl, "");

  const runA = page.locator(`[data-testid="run"][data-run="${runId("ARK-701")}"]`);
  const runB = page.locator(`[data-testid="run"][data-run="${runId("ARK-702")}"]`);
  await expect(page.getByTestId("run")).toHaveCount(2);

  // Needs me: one gate, a link to its review, above the runs.
  const gate = page.getByTestId("gate");
  await expect(gate).toHaveCount(1);
  await expect(gate).toContainText("ARK-702");
  await expect(gate.getByTestId("gate-link")).toHaveAttribute("href", reviewUrl);
  const tiles = await page.getByTestId("tile").first().boundingBox();
  expect(tiles!.y).toBeLessThan((await gate.boundingBox())!.y);

  // Run A: ticket, title, phase, cost, and its MR with state and CI in the review queue.
  await expect(runA).toContainText("ARK-701");
  await expect(runA).toContainText("Run with a failing MR");
  await expect(runA.locator("[data-phase]")).toHaveAttribute("data-phase", "merge_requests_open");
  const review = page.locator(`[data-testid="review"][data-run="${runId("ARK-701")}"]`);
  await expect(review.getByTestId("mr")).toHaveAttribute("data-state", "open");
  await expect(review.getByTestId("mr")).toContainText("!71");
  await expect(review.getByTestId("ci")).toHaveAttribute("data-ci", "failing");
  await expect(runA.getByTestId("cost")).toHaveText("$1.25");

  // Run B has no session: its cost is unknown, never $0.
  await expect(runB.locator("[data-phase]")).toHaveAttribute("data-phase", "awaiting_criteria");
  await expect(runB.getByTestId("cost")).toHaveText("unknown");

  // No review open: the gate shows its question instead of a link.
  writeFileSync(join(state, "plannotator.sessions"), "[]");
  await expect(gate.getByTestId("gate-link")).toHaveCount(0, { timeout: 20_000 });
  await expect(gate).toContainText("Run at a gate");
  await expect(gate).toContainText(/acceptance criteria/i);

  // The run page lists the agents with role, harness and model.
  await open(page, baseUrl, `run/${runId("ARK-701")}`);
  const lead = page.locator('[data-testid="agent"][data-role="run lead"]');
  await expect(lead).toContainText("omp");
  await expect(lead).toContainText("anthropic/claude-lead-model");
  const worker = page.locator('[data-testid="agent"][data-role="implementer"]');
  await expect(worker).toContainText("codex");
  await expect(worker).toContainText("openai/gpt-worker-model");
});

// ---------------------------------------------------------------- AC8

test("ARK-277-AC8 the run page draws one node for each plan step and one edge for each dependency", async ({
  page,
}) => {
  const { sessions } = isolate();
  const run = runId("ARK-801");
  const model = "anthropic/claude-sonnet-5-5";
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-801", title: "Plan with 4 steps" },
    phase: "building",
    steps: [
      {
        id: "write-docs",
        role: "implementer",
        harness: "omp",
        model,
        needs: [],
        startedAfter: 40,
        finishedAfter: 100,
      },
      {
        id: "build-server",
        role: "implementer",
        harness: "codex",
        model: "openai/gpt-6",
        needs: ["write-docs"],
        startedAfter: 110,
        finishedAfter: 130,
        outcome: "failed",
      },
      {
        id: "build-page",
        role: "validator",
        harness: "claude",
        model: "anthropic/claude-opus-5",
        needs: ["write-docs"],
        startedAfter: 140,
      },
      {
        id: "review",
        role: "reviewer",
        harness: "omp",
        model,
        needs: ["build-page"],
      },
    ],
  });
  // One message in the window of each started step; `review` never ran: its cost is unknown.
  const start = Date.now() - 3_600_000;
  const inside = (seconds: number) => new Date(start + seconds * 1000);
  writeOmpSession(sessions, "steps", join(directory, "workspace"), [
    { time: inside(70), costUsd: 0.25 },
    { time: inside(120), costUsd: 0.5 },
    { time: inside(150), costUsd: 0.75 },
  ]);
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, `run/${encodeURIComponent(run)}`);

  const nodes = page.getByTestId("step-node");
  await expect(nodes).toHaveCount(4);
  const expected = [
    ["write-docs", "implementer", "omp", model, "succeeded", "done", "$0.25"],
    ["build-server", "implementer", "codex", "openai/gpt-6", "failed", "failed", "$0.50"],
    ["build-page", "validator", "claude", "anthropic/claude-opus-5", "running", "running", "$0.75"],
    ["review", "reviewer", "omp", model, "pending", "pending", "unknown"],
  ];
  for (const [step, role, harness, stepModel, status, label, cost] of expected) {
    const node = page.locator(`[data-testid="step-node"][data-step="${step}"]`);
    await expect(node).toContainText(step);
    await expect(node).toContainText(`${role} · ${harness}`);
    await expect(node).toContainText(stepModel);
    await expect(node).toHaveAttribute("data-status", status);
    await expect(node).toContainText(label);
    await expect(node.getByTestId("step-cost")).toHaveText(cost);
  }

  const edges = page.getByTestId("step-edge");
  await expect(edges).toHaveCount(3);
  // 3 edges drawn (count above) and these 3 present: exactly the dependencies of the plan.
  const drawn = await edges.evaluateAll((paths) =>
    paths.map((path) => `${path.getAttribute("data-from")}>${path.getAttribute("data-to")}`),
  );
  expect(drawn).toEqual(
    expect.arrayContaining([
      "write-docs>build-server",
      "write-docs>build-page",
      "build-page>review",
    ]),
  );
});

// ---------------------------------------------------------------- AC9

test("ARK-277-AC9 Backlog lists and filters the tickets, changes none, and copies the selected IDs in dependency order", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  isolate();
  // ARK-912 depends on ARK-919: dependency order is the reverse of ID order.
  const tickets = [
    {
      id: "ARK-912",
      title: "Show the ledger",
      status: "ready",
      milestone: "M4",
      dependsOn: ["ARK-919"],
    },
    { id: "ARK-915", title: "Rename a flag", status: "ready", milestone: "M4" },
    { id: "ARK-919", title: "Write the ledger", status: "ready", milestone: "M4" },
    { id: "ARK-921", title: "Old ledger cleanup", status: "done", milestone: "M3" },
    { id: "ARK-923", title: "Waiting on a decision", status: "blocked" },
  ];
  for (const ticket of tickets) writeBacklogTicket({ project: "p", ...ticket });
  installFakeTools({});
  const baseUrl = await launch();
  const methods: string[] = [];
  page.on("request", (request) => methods.push(request.method()));
  await open(page, baseUrl, "backlog");

  const rows = page.getByTestId("ticket-row");
  await expect(rows).toHaveCount(4); // the done ticket ARK-921 is hidden behind Show done
  // Each ticket: ID, title, status, milestone and depends_on.
  const ledger = page.locator('[data-testid="ticket-row"][data-ticket="ARK-912"]');
  await expect(ledger).toContainText("ARK-912");
  await expect(ledger).toContainText("Show the ledger");
  await expect(ledger).toContainText("ready");
  await expect(ledger).toContainText("M4");
  await expect(ledger).toContainText("ARK-919");

  await page.getByTestId("filter-status").selectOption("ready");
  await expect(rows).toHaveCount(3);
  await page.getByTestId("filter-text").fill("ledger");
  await expect(rows).toHaveCount(2); // ready and about the ledger: ARK-912 and ARK-919
  await expect(page.locator('[data-testid="ticket-row"][data-ticket="ARK-921"]')).toHaveCount(0);
  await page.getByTestId("filter-status").selectOption("");
  await expect(rows).toHaveCount(2); // the text filter alone: ARK-921 is done, so still hidden
  await page.getByTestId("show-done").check();
  await expect(rows).toHaveCount(3); // Show done: ARK-921 joins
  await page.getByTestId("show-done").uncheck();

  // Nothing here changes a ticket: the only button is the copy button, and the page only reads.
  await expect(page.locator("main button")).toHaveText(["Copy prompt for Master Chief"]);
  await expect(page.locator("main form")).toHaveCount(0);

  await page.getByTestId("filter-text").fill("");
  await page.getByLabel("Select ARK-912").check();
  await page.getByLabel("Select ARK-919").check();
  await page.getByLabel("Select ARK-915").check();
  await page.getByRole("button", { name: "Copy prompt for Master Chief" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const position = (id: string) => copied.indexOf(id);
  expect(position("ARK-915")).toBeGreaterThanOrEqual(0);
  expect(position("ARK-919")).toBeGreaterThanOrEqual(0);
  expect(position("ARK-912")).toBeGreaterThan(position("ARK-919"));
  expect(copied).not.toMatch(/ARK-921|ARK-923/); // only the selected IDs

  expect(methods.filter((method) => method !== "GET")).toEqual([]);
});

// ---------------------------------------------------------------- AC10

test("ARK-277-AC10 Runs draws one node for each ticket and one edge for each depends_on, colored by the newest run's phase", async ({
  page,
}) => {
  isolate();
  const tickets = [
    { id: "ARK-901", dependsOn: [] },
    { id: "ARK-902", dependsOn: ["ARK-901"] },
    { id: "ARK-903", dependsOn: ["ARK-901"] },
    { id: "ARK-904", dependsOn: ["ARK-902", "ARK-903"] },
    { id: "ARK-905", dependsOn: [] },
  ];
  for (const ticket of tickets)
    writeBacklogTicket({ project: "p", title: `Ticket ${ticket.id}`, status: "ready", ...ticket });
  // 3 runs in 3 phases. ARK-901 has an older closed run and a newer building one: the newest counts.
  const ticketOf = (id: string) => ({ id, title: `Ticket ${id}` });
  writeRun({
    project: "p",
    run: runId("ARK-901", 1),
    ticket: ticketOf("ARK-901"),
    phase: "closed",
    startedAt: ago(10_800),
  });
  writeRun({
    project: "p",
    run: runId("ARK-901", 2),
    ticket: ticketOf("ARK-901"),
    phase: "building",
    steps: [
      {
        id: "secret-step",
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 40,
      },
    ],
  });
  writeRun({
    project: "p",
    run: runId("ARK-903"),
    ticket: ticketOf("ARK-903"),
    phase: "planning",
  });
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "runs");

  // Active: tickets with an open run (901, 903) and their direct neighbours that are not done (902,
  // 904). 905 has no run and no neighbour in a run: it shows under Queued.
  const nodes = page.getByTestId("graph-node");
  await expect(nodes).toHaveCount(4);
  await expect(page.locator('[data-testid="graph-node"][data-ticket="ARK-905"]')).toHaveCount(0);
  // A node is a link: to the newest run, or to the ticket page when there is none.
  const hrefOf = (ticket: string) =>
    page.locator(`[data-testid="graph-node"][data-ticket="${ticket}"]`).getAttribute("href");
  expect(await hrefOf("ARK-901")).toBe(`#/run/${encodeURIComponent(runId("ARK-901", 2))}`);
  expect(await hrefOf("ARK-902")).toBe("#/ticket/ARK-902");
  await page.locator('[data-testid="graph-filter"][data-filter="Queued"]').click();
  await expect(nodes).toHaveCount(5);
  const expectedState: Record<string, string> = {
    "ARK-901": "building",
    "ARK-902": "blocked",
    "ARK-903": "needs me", // a planning run waits at its plan gate
    "ARK-904": "blocked",
    "ARK-905": "queued",
  };
  const colors = new Map<string, string>();
  for (const [ticket, state] of Object.entries(expectedState)) {
    const node = page.locator(`[data-testid="graph-node"][data-ticket="${ticket}"]`);
    await expect(node).toHaveAttribute("data-state", state);
    colors.set(ticket, await node.evaluate((box) => getComputedStyle(box).borderTopColor));
  }
  // The color is the phase: ARK-902, ARK-904 and ARK-905 share one, building and planning differ from it and each other.
  expect(new Set(["ARK-902", "ARK-904", "ARK-905"].map((id) => colors.get(id))).size).toBe(1);
  expect(new Set([colors.get("ARK-901"), colors.get("ARK-903"), colors.get("ARK-902")]).size).toBe(
    3,
  );

  const edges = page.getByTestId("graph-edge");
  await expect(edges).toHaveCount(4);
  const drawn = await edges.evaluateAll((paths) =>
    paths.map((path) => `${path.getAttribute("data-from")}>${path.getAttribute("data-to")}`),
  );
  expect(drawn.sort()).toEqual(
    ["ARK-901>ARK-902", "ARK-901>ARK-903", "ARK-902>ARK-904", "ARK-903>ARK-904"].sort(),
  );

  // No step nodes: the plan of the building run does not reach Runs.
  await expect(page.getByTestId("step-node")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("secret-step");
});

// ---------------------------------------------------------------- AC11

test("ARK-277-AC11 a source that stops answering keeps its last good value and shows its age; before a first read the page says unknown", async ({
  page,
}) => {
  test.setTimeout(120_000);
  isolate();
  const run = runId("ARK-111");
  writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-111", title: "Run with live agents" },
    phase: "building",
  });
  const waiting = writeRun({
    project: "p",
    run: runId("ARK-112"),
    ticket: { id: "ARK-112", title: "Run at a gate" },
    phase: "awaiting_criteria",
  });
  const state = installFakeTools({
    orca: orcaAnswersFor(run),
    orcaMode: "down",
    plannotatorMode: "down",
    plannotatorSessions: [
      { index: 1, target: join(waiting, "ticket.md"), url: "http://localhost:20000/review/xyz" },
    ],
  });
  const baseUrl = await launch();
  await open(page, baseUrl, "");

  // The agents are on the run page: a second page in the same browser shows them.
  const runPage = await page.context().newPage();
  await open(runPage, baseUrl, `run/${run}`);
  const agents = runPage.getByTestId("agents");
  const label = (source: string) =>
    page.locator(`[data-testid="stale-label"][data-source="${source}"]`);

  // Before the first good read: unknown, not an empty list.
  await expect(label("orca")).toHaveText("orca unknown");
  await expect(label("plannotator")).toHaveText("plannotator unknown");
  await expect(agents).toHaveText("unknown");
  await expect(agents).not.toContainText("no live agent");

  // Each source now answers each command twice and then fails.
  writeFileSync(join(state, "orca.mode"), "twice");
  writeFileSync(join(state, "plannotator.mode"), "twice");
  await expect(agents).toContainText("openai/gpt-worker-model", { timeout: 20_000 });
  await expect(page.getByTestId("gate-link")).toHaveAttribute(
    "href",
    "http://localhost:20000/review/xyz",
    { timeout: 20_000 },
  );

  // The third read of each fails: the last good value stays, with its age.
  await expect(label("orca")).toHaveText(/^orca as of \d+ s ago$/, { timeout: 30_000 });
  await expect(label("plannotator")).toHaveText(/^plannotator as of \d+ s ago$/, {
    timeout: 30_000,
  });
  await expect(agents).toContainText("openai/gpt-worker-model");
  await expect(agents).toContainText("anthropic/claude-lead-model");
  await expect(page.getByTestId("gate-link")).toHaveCount(1);

  const ageOf = async () =>
    Number((await label("orca").textContent())!.match(/as of (\d+) s ago/)![1]);
  const first = await ageOf();
  await expect.poll(ageOf, { timeout: 10_000 }).toBeGreaterThan(first);
});

// ---------------------------------------------------------------- Regressions of the QE review (F1, F2, F3)

test("ARK-277-AC7 an agent that Orca reports without harness and model shows the plan's, marked planned", async ({
  page,
}) => {
  isolate();
  const run = runId("ARK-710");
  writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-710", title: "Agent without harness" },
    phase: "building",
    steps: [{ id: "build", role: "validator", harness: "omp", model: "plan/model-x", needs: [] }],
  });
  installFakeTools({
    orca: {
      terminals: [{ handle: "term-w", connected: true }],
      runs: [{ id: `orca-${run}`, objective: `Ark run ${run}`, coordinator_handle: null }],
      workers: [{ taskId: "task-1", state: "running", agentTerminalHandle: "term-w" }],
      tasks: [{ id: "task-1", title: "build (validator, .)" }],
    },
  });
  const baseUrl = await launch();
  await open(page, baseUrl, `run/${run}`);

  const agent = page.locator('[data-testid="agent"][data-role="validator"]');
  await expect(agent).toContainText("omp (planned)");
  await expect(agent).toContainText("plan/model-x (planned)");
});

test("ARK-277-AC7 an MR whose gh pr view fails shows unknown, never open", async ({ page }) => {
  isolate();
  const mergeRequest = "https://github.com/example/repo/pull/72";
  writeRun({
    project: "p",
    run: runId("ARK-720"),
    ticket: { id: "ARK-720", title: "Run with a mute gh" },
    phase: "merge_requests_open",
    mergeRequests: [{ repo: ".", url: mergeRequest, number: 72 }],
  });
  installFakeTools({ failingMergeRequestViews: [mergeRequest] });
  const baseUrl = await launch();
  await open(page, baseUrl, "");

  const request = page.getByTestId("mr");
  await expect(request).toContainText("!72");
  await expect(request).toHaveAttribute("data-state", "unknown");
  await expect(request.getByTestId("mr-state")).toHaveText("unknown");
  // The checks come from the same `gh pr view`: with no answer there is no CI fact either.
  await expect(request.getByTestId("ci")).toHaveAttribute("data-ci", "unknown");
});

test("ARK-277-AC7 an unread question and an escalation of live workers wait on Home, a finished worker's do not", async ({
  page,
}) => {
  isolate();
  const run = runId("ARK-721");
  writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-721", title: "Run with questions" },
    phase: "building",
  });
  const message = (type: string, from: string, subject: string, read = 0) => ({
    type,
    from_handle: `dispatch:${from}`,
    to_handle: `run:orca-${run}`,
    subject,
    read,
    created_at: new Date().toISOString(),
  });
  installFakeTools({
    orca: {
      ...orcaAnswersFor(run),
      workers: [
        {
          taskId: "task-1",
          dispatchId: "ctx_live",
          state: "running",
          agentTerminalHandle: "term-worker",
        },
        { taskId: "task-2", dispatchId: "ctx_done", state: "succeeded" },
        {
          taskId: "task-3",
          dispatchId: "ctx_other",
          state: "running",
          agentTerminalHandle: "term-worker",
        },
      ],
      tasks: [
        { id: "task-1", title: "hub-server (implementer, .)" },
        { id: "task-2", title: "hub-page (implementer, .)" },
        { id: "task-3", title: "hub-tests (validator, .)" },
      ],
      messages: [
        message("question", "ctx_live", "which port?"),
        message("escalation", "ctx_other", "tests will not run"),
        message("question", "ctx_done", "finished worker asks"),
        message("question", "ctx_live", "already read", 1),
      ],
    },
  });
  const baseUrl = await launch();
  await open(page, baseUrl, "");

  const rows = page.getByTestId("waiting");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "asked the run lead: which port?" })).toContainText(
    "hub-server",
  );
  await expect(rows.filter({ hasText: "blocked: tests will not run" })).toContainText("hub-tests");
  await expect(page.getByText("Needs me · 2")).toBeVisible();
});

test("ARK-277-AC7 a run lead without harness and model shows roles.chief of ark.yml, marked configured", async ({
  page,
}) => {
  isolate();
  writeProject("p", {
    workspace: tempDirectory("ark-workspace-"),
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "m" },
      validator: { harness: "omp", model: "m" },
      reviewer: { harness: "omp", model: "m" },
      chief: { harness: "claude", model: "claude-opus" },
    },
  });
  const run = runId("ARK-722");
  writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-722", title: "Lead without facts" },
    phase: "building",
  });
  installFakeTools({
    orca: {
      terminals: [{ handle: "term-lead", connected: true }],
      runs: [{ id: `orca-${run}`, objective: `Ark run ${run}`, coordinator_handle: "term-lead" }],
    },
  });
  const baseUrl = await launch();
  await open(page, baseUrl, `run/${run}`);

  const lead = page.locator('[data-testid="agent"][data-role="run lead"]');
  await expect(lead).toContainText("claude (configured)");
  await expect(lead).toContainText("claude-opus (configured)");
});

test("ARK-277-AC9 a file in the tickets folder that is not named like a ticket is not listed", async ({
  page,
}) => {
  isolate();
  writeBacklogTicket({ project: "p", id: "ARK-930", title: "A ticket", status: "ready" });
  writeFileSync(
    join(process.env.ARK_HOME as string, "projects", "p", "tickets", "README.md"),
    "# Tickets\n\n| id | title |\n",
  );
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "backlog");

  await expect(page.getByTestId("ticket-row")).toHaveCount(1);
  await expect(page.getByTestId("ticket-row")).toHaveAttribute("data-ticket", "ARK-930");
});

test("ARK-277-AC11 a hash that does not decode shows the page and a later hash still works", async ({
  page,
}) => {
  isolate();
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "run/%E0%A4%A");

  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
  await expect(page.locator("main")).toContainText("No open run");
  await page.getByRole("link", { name: "Backlog" }).click();
  await expect(page.getByRole("heading", { name: "Backlog" })).toBeVisible();
});

// ---------------------------------------------------------------- ARK-284

const switchCalls = (state: string): string[] => {
  const log = join(state, "orca.log");
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("terminal switch"))
    : [];
};

/** The Orca answers of one open run plus Master Chief, and one worker Orca released. */
function orcaWithReleasedWorker(run: string) {
  const answers = orcaAnswersFor(run);
  return {
    terminals: [
      ...answers.terminals!,
      { handle: "term-chief", connected: true, agentIdentity: "omp", model: "chief-model" },
      { handle: "term-gone", connected: false, agentIdentity: "codex" },
    ],
    runs: [
      ...answers.runs!,
      { id: "orca-chief", objective: "Master Chief: p tickets", coordinator_handle: "term-chief" },
    ],
    workers: [
      ...answers.workers!,
      { taskId: "task-2", state: "released", agentTerminalHandle: "term-gone" },
      // Working, but `terminal list` never lists a `structworker_*` agent session.
      { taskId: "task-3", state: "running", agentTerminalHandle: "structworker_unlisted" },
    ],
    tasks: [
      ...answers.tasks!,
      { id: "task-2", title: "hub-docs (implementer, .)" },
      { id: "task-3", title: "hub-run-page (validator, .)" },
    ],
  };
}

test("ARK-284-AC2 the run page shows Open in Orca for each live agent, Master Chief included, ended for a released one and a no-button label for one running but not listed", async ({
  page,
}) => {
  isolate();
  const run = runId("ARK-831");
  writeRun({ project: "p", run, ticket: { id: "ARK-831", title: "Agents" }, phase: "building" });
  const answers = orcaWithReleasedWorker(run);
  const state = installFakeTools({ orca: answers });
  const baseUrl = await launch();
  const home = page.getByTestId("agents");
  const button = (handle: string) =>
    page.locator(`[data-testid="open-in-orca"][data-terminal="${handle}"]`);

  await open(page, baseUrl, `run/${run}`);
  await expect(home).toBeVisible();
  // Each agent of the snapshot has its handle and live flag.
  await expect
    .poll(async () => {
      const snapshot = await (await fetch(`${baseUrl}/api/snapshot`)).json();
      const agents = Array.isArray(snapshot.runs) ? snapshot.runs[0]?.agents : null;
      return Array.isArray(agents)
        ? agents.map((agent: { terminal: string; live: boolean; running: boolean }) => [
            agent.terminal,
            agent.live,
            agent.running,
          ])
        : [];
    })
    .toEqual(
      expect.arrayContaining([
        ["term-chief", true, false],
        ["term-lead", true, false],
        ["term-worker", true, false],
        ["term-gone", false, false],
        ["structworker_unlisted", false, true],
      ]),
    );

  // The run page: a button for the live agents, Master Chief too; the released one says why it has none.
  for (const handle of ["term-chief", "term-lead", "term-worker"])
    await expect(home.locator(`[data-terminal="${handle}"]`)).toHaveText("Open in Orca");
  await expect(home.locator('[data-testid="agent"][data-role="Master Chief"]')).toHaveCount(1);
  const ended = home.locator('[data-testid="agent"][data-live="false"]', {
    hasText: "ended, not in Orca",
  });
  await expect(ended).toHaveCount(1);
  await expect(ended.getByRole("button")).toHaveCount(0);
  const running = home.locator('[data-testid="agent"]', {
    hasText: "running in Orca, open it from its chat tab",
  });
  await expect(running).toHaveCount(1);
  await expect(running).toContainText("validator");
  await expect(running).toContainText("hub-run-page");
  await expect(running.getByRole("button")).toHaveCount(0);
  await expect(home.getByTestId("open-in-orca")).toHaveCount(3);

  // One click, one `terminal switch` with the live handle: nothing else is run.
  expect(switchCalls(state)).toEqual([]);
  await button("term-worker").click();
  await expect.poll(() => switchCalls(state)).toEqual(["terminal switch --terminal term-worker"]);
  expect(readFileSync(join(state, "orca.log"), "utf8")).not.toContain("terminal send");

  await expect(page.getByTestId("orca-ended")).toHaveText("ended, not in Orca");
  await expect(page.getByTestId("orca-running")).toHaveText(
    "running in Orca, open it from its chat tab",
  );
  await button("term-chief").click();
  await expect
    .poll(() => switchCalls(state))
    .toEqual(["terminal switch --terminal term-worker", "terminal switch --terminal term-chief"]);
});

test("ARK-284-AC2 a failing Orca leaves the button usable and says why, and a closed run has no button", async ({
  page,
}) => {
  isolate();
  const run = runId("ARK-832");
  writeRun({ project: "p", run, ticket: { id: "ARK-832", title: "Failing" }, phase: "building" });
  const closed = runId("ARK-833");
  writeRun({
    project: "p",
    run: closed,
    ticket: { id: "ARK-833", title: "Done" },
    phase: "closed",
  });
  const state = installFakeTools({ orca: orcaAnswersFor(run) });
  const baseUrl = await launch();
  await open(page, baseUrl, `run/${run}`);
  const worker = page.locator('[data-testid="open-in-orca"][data-terminal="term-worker"]');
  await expect(worker).toBeVisible();

  writeFakeToolState(state, { orca: orcaAnswersFor(run), orcaSwitchFails: true });
  await worker.click();
  await expect(worker.locator("xpath=following-sibling::*[1]")).toHaveText("Orca did not answer");
  await expect(worker).toBeEnabled();
  expect(switchCalls(state)).toHaveLength(1);

  // A closed run has no agent in Orca: no button, and the banner says so.
  await open(page, baseUrl, `run/${closed}`);
  await expect(page.getByTestId("closed-banner")).toContainText("no agents in Orca");
  await expect(page.getByTestId("open-in-orca")).toHaveCount(0);
});

test("ARK-284-AC3 a closed run opens from its Backlog row and from its Runs card, and both lead to the newest run", async ({
  page,
}) => {
  isolate();
  const ticket = (id: string) => ({ id, title: `Ticket ${id}` });
  for (const id of ["ARK-841", "ARK-842"])
    writeBacklogTicket({ project: "p", id, title: `Ticket ${id}`, status: "ready" });
  // ARK-841: a closed run and a newer open one. ARK-842: one closed run only.
  const older = runId("ARK-841", 1);
  const newer = runId("ARK-841", 2);
  const only = runId("ARK-842");
  writeRun({
    project: "p",
    run: older,
    ticket: ticket("ARK-841"),
    phase: "closed",
    startedAt: ago(20_000),
  });
  writeRun({
    project: "p",
    run: newer,
    ticket: ticket("ARK-841"),
    phase: "building",
    startedAt: ago(5_000),
  });
  writeRun({
    project: "p",
    run: only,
    ticket: ticket("ARK-842"),
    phase: "closed",
    startedAt: ago(9_000),
  });
  installFakeTools({});
  const baseUrl = await launch();

  // Backlog: the runs of a ticket, newest first; a link opens the closed one.
  await open(page, baseUrl, "backlog");
  const row = page.locator('[data-testid="ticket-row"][data-ticket="ARK-841"]');
  await expect(row.getByTestId("ticket-run")).toHaveCount(2);
  await expect(row.getByTestId("ticket-run")).toHaveText([newer, older]);
  await row.locator(`[data-testid="ticket-run"][data-run="${older}"]`).click();
  await expect(page.locator("main h1")).toContainText("ARK-841");
  await expect(page.getByTestId("closed-banner")).toContainText(older);
  await expect(page.getByTestId("timeline-entry").first()).toBeVisible();

  // Runs: the card of a ticket with an open run links to its newest run; a closed run's card opens too.
  await open(page, baseUrl, "runs");
  await expect(
    page.locator('[data-testid="run-card"][data-lane="Building"][data-ticket="ARK-841"]'),
  ).toHaveAttribute("href", `#/run/${newer}`);
  const card = page.locator(`[data-testid="run-card"][data-lane="Closed"][data-run="${only}"]`);
  await expect(card).toHaveAttribute("href", `#/run/${only}`);
  await card.click();
  await expect(page.locator("main h1")).toContainText("ARK-842");
  await expect(page.getByTestId("closed-banner")).toContainText(only);
  // The open run still opens, with no closed banner.
  await open(page, baseUrl, `run/${newer}`);
  await expect(page.locator("main h1")).toContainText("ARK-841");
  await expect(page.getByTestId("closed-banner")).toHaveCount(0);
});

test("ARK-284-AC4 the run page lists each decision of events.ndjson oldest first with its time, and skips a damaged line", async ({
  page,
}) => {
  isolate();
  const run = runId("ARK-851");
  const started = ago(7_200);
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-851", title: "Decisions" },
    phase: "closed",
    startedAt: started,
  });
  const url = "https://github.com/example/repo/pull/851";
  writeEventLog(
    directory,
    started,
    [
      {
        after: 0,
        type: "run.started",
        data: {
          run,
          project: "p",
          ticket: { id: "ARK-851", title: "Decisions" },
          criteria: ["ARK-851-AC1"],
          round_budget: 3,
        },
      },
      {
        after: 60,
        type: "evaluation.recorded",
        data: { blockers: [], risks: ["r1", "r2"], surfaces: ["ui"] },
      },
      {
        after: 120,
        type: "strategy.recorded",
        data: { count: 2, recommended: "S2", cards: ["S1", "S2"] },
      },
      { after: 180, type: "gate.answered", data: { gate: "strategy", answer: "S2", by: "human" } },
      {
        after: 240,
        type: "plan.checked",
        data: { valid: true, steps: [{ id: "a" }, { id: "b" }] },
      },
      {
        after: 300,
        type: "step.started",
        data: { step: "a", role: "implementer", repo: ".", round: 1 },
      },
      { after: 600, type: "step.finished", data: { step: "a", outcome: "succeeded" } },
      {
        after: 700,
        type: "test.completed",
        data: {
          passed: false,
          criteria: {
            "ARK-851-AC1": "passing",
            "ARK-851-AC2": "passing",
            "ARK-851-AC3": "failing",
          },
        },
      },
      { after: 800, type: "escalation.requested", data: { reason: "the fixture needs a human" } },
      { after: 900, type: "merge_request.opened", data: { repo: ".", url, number: 851 } },
      { after: 1000, type: "run.closed", data: { outcome: "handed_off" } },
    ],
    [{ before: 5, text: '{"seq": 99, "time": "broken' }],
  );
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, `run/${run}`);

  const entries = page.getByTestId("timeline-entry");
  await expect(page.getByTestId("timeline")).toBeVisible();
  const expected = [
    [60, "evaluation.recorded"],
    [120, "strategy.recorded"],
    [180, "gate.answered"],
    [240, "plan.checked"],
    [700, "test.completed"],
    [800, "escalation.requested"],
    [900, "merge_request.opened"],
    [1000, "run.closed"],
  ] as const;
  // One entry per decision type, oldest first; the step events and the damaged line are not there.
  await expect(entries).toHaveCount(expected.length);
  expect(
    await entries.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-type"))),
  ).toEqual(expected.map(([, type]) => type));
  // Each entry shows its time (the event's own).
  expect(
    await entries
      .locator("time")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime"))),
  ).toEqual(expected.map(([after]) => new Date(started.getTime() + after * 1000).toISOString()));
  const entry = (type: string) =>
    page.locator(`[data-testid="timeline-entry"][data-type="${type}"]`);
  await expect(entry("gate.answered")).toContainText("strategy gate: S2");
  await expect(entry("strategy.recorded")).toContainText("2 cards, recommended S2");
  await expect(entry("plan.checked")).toContainText("2 steps");
  await expect(entry("evaluation.recorded")).toContainText("2 risks");
  await expect(entry("escalation.requested")).toContainText("the fixture needs a human");
  await expect(entry("test.completed").getByTestId("timeline-counts")).toContainText("1 fail");
  await expect(entry("test.completed").getByTestId("timeline-counts")).toContainText("2 pass");
  await expect(entry("merge_request.opened").getByRole("link")).toHaveAttribute("href", url);
  await expect(entry("run.closed")).toContainText("handed_off");
});

const toolNames: Record<SessionHarness, string> = { omp: "bash", claude: "Bash", codex: "shell" };

/** What a transcript of `transcriptText(harness)` shows: messages, 2 tool calls, folded thinking. */
async function expectTranscript(page: Page, harness: SessionHarness): Promise<void> {
  const text = transcriptTexts(harness);
  const entries = page.getByTestId("transcript-entry");
  await expect(entries).toHaveCount(5);
  expect(
    await entries.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-kind"))),
  ).toEqual(["message", "thinking", "message", "tool", "tool"]);

  // Messages: role and time.
  const messages = page.locator('[data-testid="transcript-entry"][data-kind="message"]');
  await expect(messages.nth(0).locator(".role")).toHaveText("user");
  await expect(messages.nth(0)).toContainText(text.user);
  await expect(messages.nth(1).locator(".role")).toHaveText("assistant");
  await expect(messages.nth(1)).toContainText(text.assistant);
  for (const index of [0, 1])
    await expect(messages.nth(index).locator("time")).toHaveAttribute(
      "datetime",
      /^\d{4}-\d\d-\d\dT/,
    );

  // Tool calls: name, arguments, ok or error, the first line of the result, never the rest.
  const tools = page.getByTestId("transcript-tool");
  await expect(tools).toHaveCount(2);
  await expect(tools.nth(0)).toHaveAttribute("data-status", "ok");
  await expect(tools.nth(0).locator(".name")).toHaveText(toolNames[harness]);
  await expect(tools.nth(0).locator(".args")).toContainText(text.command);
  await expect(tools.nth(0).locator(".pill")).toHaveText("ok");
  await expect(tools.nth(0).getByTestId("tool-result")).toHaveText(text.okFirstLine);
  await expect(tools.nth(1)).toHaveAttribute("data-status", "error");
  await expect(tools.nth(1).locator(".pill")).toHaveText("error");
  await expect(tools.nth(1).getByTestId("tool-result")).toHaveText(text.failFirstLine);
  await expect(page.locator("body")).not.toContainText(text.tail);
  await expect(page.locator("body")).not.toContainText("second line");

  // Thinking is folded until a click.
  const thinking = page.getByTestId("thinking");
  await expect(thinking).toHaveJSProperty("open", false);
  await expect(thinking.locator("p")).toBeHidden();
  await thinking.locator("summary").click();
  await expect(thinking).toHaveJSProperty("open", true);
  await expect(thinking.locator("p")).toHaveText(text.thinking);
  await expect(page.getByTestId("load-more")).toBeDisabled();
}

test("ARK-284-AC6 a DAG node, the run lead and an unassigned file open their transcript for an omp, a Claude and a Codex session file", async ({
  page,
}) => {
  const { sessions } = isolate();
  const run = runId("ARK-871");
  const started = ago(7_200);
  const at = (seconds: number) => new Date(started.getTime() + seconds * 1000);
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-871", title: "Transcripts" },
    phase: "closed",
    startedAt: started,
    steps: [
      {
        id: "omp-step",
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 60,
        finishedAfter: 600,
      },
    ],
  });
  const cwd = join(directory, "workspace");
  // The step's file starts inside its window, the lead's before the first step, the third after the window.
  writeSessionFile(sessions, "step.jsonl", transcriptText("omp", { cwd, start: at(100) }));
  writeSessionFile(
    process.env.ARK_CLAUDE_SESSIONS as string,
    "lead.jsonl",
    transcriptText("claude", { cwd, start: at(10) }),
  );
  writeSessionFile(
    process.env.ARK_CODEX_SESSIONS as string,
    "loose.jsonl",
    transcriptText("codex", { cwd, start: at(900) }),
  );
  installFakeTools({});
  const baseUrl = await launch();

  await open(page, baseUrl, `run/${run}`);
  await page.locator('[data-testid="step-node"][data-step="omp-step"] a').click();
  await expect(page.locator("main h1")).toHaveText("omp-step");
  await expectTranscript(page, "omp");

  await open(page, baseUrl, `run/${run}`);
  await page.getByTestId("run-lead-link").click();
  await expect(page.locator("main h1")).toHaveText("Run lead");
  await expectTranscript(page, "claude");

  await open(page, baseUrl, `run/${run}`);
  await expect(page.getByTestId("unassigned-file")).toHaveCount(1);
  await page.getByTestId("unassigned-file").getByRole("link").click();
  await expectTranscript(page, "codex");
});

test("ARK-284-AC7 a transcript shows 200 entries a page and Load more adds the next page until the end of the file", async ({
  page,
}) => {
  const { sessions } = isolate();
  const run = runId("ARK-872");
  const started = ago(7_200);
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-872", title: "Paging" },
    phase: "closed",
    startedAt: started,
  });
  writeSessionFile(
    sessions,
    "long.jsonl",
    ompMessagesText(join(directory, "workspace"), started, 450),
  );
  installFakeTools({});
  const baseUrl = await launch();

  await open(page, baseUrl, `run/${run}`);
  await page.getByTestId("run-lead-link").click();
  const entries = page.getByTestId("transcript-entry");
  const more = page.getByTestId("load-more");
  await expect(entries).toHaveCount(200);
  await expect(more).toBeEnabled();
  await more.click();
  await expect(entries).toHaveCount(400);
  await more.click();
  await expect(entries).toHaveCount(450);
  await expect(more).toBeDisabled();
  await expect(page.getByText("End of file · 450 entries")).toBeVisible();
  await expect(entries.last()).toContainText("m449");
});

/** One GET with the path sent as written: a browser or `fetch` would normalize `../` away. */
function rawGet(baseUrl: string, path: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: Number(port), path }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("ARK-284-AC8 the run page links the run files that exist and shows them as text, a missing file has no link, and a path outside the run folder answers 404", async ({
  page,
}) => {
  isolate();
  const run = runId("ARK-881");
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-881", title: "Run files" },
    phase: "closed",
  });
  writeFileSync(join(directory, "plan.md"), "# Plan\n\nPLAN-BODY <b>not markup</b>\n");
  mkdirSync(join(directory, "findings"));
  writeFileSync(join(directory, "findings", "note.md"), "FINDING-BODY\n");
  // Files outside the run folder, reached through symlinks inside it.
  const outside = tempDirectory("ark-outside-");
  writeFileSync(join(outside, "secret.txt"), "TOPSECRET\n");
  symlinkSync(join(outside, "secret.txt"), join(directory, "findings", "leak.md"));
  symlinkSync(outside, join(directory, "results"));
  installFakeTools({});
  const baseUrl = await launch();

  await open(page, baseUrl, `run/${run}`);
  const links = page.getByTestId("run-file-link");
  await expect(links.first()).toBeVisible();
  // Present files have a link; strategies.md, retro.md and both symlinks that leave the folder have none.
  expect(
    await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-path"))),
  ).toEqual(["ticket.md", "plan.md", "findings/note.md"]);
  await links.filter({ hasText: /^plan\.md$/ }).click();
  await expect(page.getByTestId("run-file-text")).toContainText("PLAN-BODY");
  // Text, not markup.
  await expect(page.getByTestId("run-file-text")).toContainText("<b>not markup</b>");
  await expect(page.locator("pre b")).toHaveCount(0);
  await open(page, baseUrl, `run/${run}`);
  await links.filter({ hasText: "note.md" }).click();
  await expect(page.getByTestId("run-file-text")).toContainText("FINDING-BODY");

  // A path that leaves the run folder shows no file.
  await page.goto(`${baseUrl}/#/run/${run}/file/${encodeURIComponent("../ticket.md")}`);
  await expect(page.getByTestId("file-missing")).toBeVisible();

  // The server: the control answers 200, every path out of the folder or to a missing file 404.
  const file = (path: string) => `/api/run/${run}/file?path=${encodeURIComponent(path)}`;
  expect(await rawGet(baseUrl, file("plan.md"))).toMatchObject({ status: 200 });
  const refused = [
    file("../ticket.md"),
    file("../../secret.txt"),
    file("findings/../plan.md"),
    file("./plan.md"),
    file("/etc/passwd"),
    file(join(outside, "secret.txt")),
    file("findings/leak.md"),
    file("results/secret.txt"),
    file("strategies.md"),
    file("retro.md"),
    `/api/run/${run}/file?path=..%2F..%2Fsecret.txt`,
    `/api/run/${run}/../${run}/file?path=../ticket.md`,
    `/api/run/${run}/file/../../../etc/passwd`,
    `/api/run/..%2F${run}/file?path=plan.md`,
    `/api/run/${run}/file`,
  ];
  for (const path of refused) {
    const answer = await rawGet(baseUrl, path);
    expect(answer.status, path).toBe(404);
    expect(answer.body, path).not.toContain("TOPSECRET");
  }
});

// ---------------------------------------------------------------- ARK-285

/** One JUnit report with two passing cases for each passing criterion and one failing case for a failing one. */
function junitReport(criteria: [string, "passing" | "failing"][]): string {
  const cases = criteria.flatMap(([id, status], index) =>
    status === "passing"
      ? [`${id} first`, `${id} second`].map(
          (name, line) =>
            `<testcase name="${name}" file="test/a.test.ts" line="${index * 10 + line + 1}" />`,
        )
      : [
          `<testcase name="${id} fails" file="test/a.test.ts" line="${index * 10 + 1}"><failure type="AssertionError">no</failure></testcase>`,
        ],
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n<testsuite name="a">\n${cases.join("\n")}\n</testsuite>\n</testsuites>\n`;
}

/**
 * An open run in `merge_requests_open`: its MR (the fake `gh` answers for the URL), the test
 * result of each criterion, a JUnit report and a findings file with 1 P1, 2 P2 and 1 P3.
 */
function reviewRun(options: {
  ticket: string;
  title: string;
  number: number;
  criteria: [string, "passing" | "failing"][];
  createdAgo: number;
  conclusion: "SUCCESS" | "FAILURE";
  size: { additions: number; deletions: number; changedFiles: number };
  findings: string;
}) {
  const run = runId(options.ticket);
  const url = `https://github.com/example/repo/pull/${options.number}`;
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: options.ticket, title: options.title },
    phase: "merge_requests_open",
    criteria: options.criteria.map(([id]) => id),
    steps: [{ id: "review", role: "reviewer", harness: "omp", model: "m", needs: [] }],
    mergeRequests: [{ repo: ".", url, number: options.number }],
    startedAt: ago(14_400),
  });
  const events = readFileSync(join(directory, "events.ndjson"), "utf8").trim().split("\n").length;
  appendRawEvent(
    directory,
    "test.completed",
    { passed: true, heads: {}, criteria: Object.fromEntries(options.criteria) },
    events + 1,
  );
  mkdirSync(join(directory, "results"), { recursive: true });
  writeFileSync(join(directory, "results", "cli.report"), junitReport(options.criteria));
  mkdirSync(join(directory, "findings"), { recursive: true });
  writeFileSync(join(directory, "findings", "review.md"), options.findings);
  const view = {
    state: "OPEN",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "lint",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://ci.example/lint",
      },
      {
        __typename: "CheckRun",
        name: "unit",
        status: "COMPLETED",
        conclusion: options.conclusion,
        detailsUrl: "https://ci.example/unit",
      },
    ],
    ...options.size,
    createdAt: ago(options.createdAgo).toISOString(),
  };
  return { run, url, directory, view };
}

const usageAt = (fraction: number) => ({
  reports: [
    {
      provider: "anthropic",
      fetchedAt: Date.now(),
      limits: [
        {
          window: { id: "5h", resetsAt: Date.now() + 4_440_000 },
          amount: { usedFraction: fraction },
        },
      ],
    },
  ],
});

/** Home with 1 gate, 1 stuck agent (a prompt), 2 MRs in review and the 5h window of anthropic at 82%. */
async function homeWithBlockers() {
  isolate();
  const gate = writeRun({
    project: "p",
    run: runId("ARK-501"),
    ticket: { id: "ARK-501", title: "Run at a gate" },
    phase: "awaiting_criteria",
  });
  const stuckRun = runId("ARK-502");
  const stuckDirectory = writeRun({
    project: "p",
    run: stuckRun,
    ticket: { id: "ARK-502", title: "Run with a stuck agent" },
    phase: "building",
    steps: [
      {
        id: "hub-server",
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 120,
      },
    ],
  });
  const older = reviewRun({
    ticket: "ARK-503",
    title: "Ready to merge",
    number: 91,
    criteria: [
      ["ARK-503-AC1", "passing"],
      ["ARK-503-AC2", "passing"],
      ["ARK-503-AC3", "passing"],
    ],
    createdAgo: 10_800,
    conclusion: "SUCCESS",
    size: { additions: 312, deletions: 41, changedFiles: 6 },
    findings: "### P1: a\n\n### P2: b\n\n### P2: c\n\n### P3: d\n",
  });
  const newer = reviewRun({
    ticket: "ARK-504",
    title: "Blocked by a failing test",
    number: 92,
    criteria: [
      ["ARK-504-AC1", "passing"],
      ["ARK-504-AC2", "failing"],
    ],
    createdAgo: 1200,
    conclusion: "FAILURE",
    size: { additions: 158, deletions: 22, changedFiles: 4 },
    findings: "### P1: x\n\n### P1: y\n",
  });
  const orca = {
    ...orcaAnswersFor(stuckRun),
    worktrees: [
      {
        path: join(stuckDirectory, "workspace"),
        agents: [
          {
            taskTitle: "hub-server (implementer, .)",
            state: "working",
            toolName: "bash",
            updatedAt: Date.now(),
            agentWait: { reason: "approval", source: "hook" },
            lastAssistantMessage: "Allow bash?\n\nbun test test/hub.test.ts\n",
          },
        ],
      },
    ],
  };
  installFakeTools({
    orca,
    mergeRequestViews: { [older.url]: older.view, [newer.url]: newer.view },
    ompUsage: usageAt(0.82),
    plannotatorSessions: [
      { index: 1, target: join(gate, "ticket.md"), url: "http://localhost:20000/review/gate" },
    ],
  });
  return { baseUrl: await launch(), older, newer, stuckRun };
}

test("ARK-285-AC5 Home shows the tile strip first, then the blockers, the review queue in merge order and the progress and usage, with Master Chief once", async ({
  page,
}) => {
  const { baseUrl, older, newer, stuckRun } = await homeWithBlockers();
  await open(page, baseUrl, "");

  // The tile strip comes first, in this order, then three columns.
  const tiles = page.getByTestId("tile");
  await expect(tiles).toHaveCount(6);
  await expect(tiles.locator(".tile-label")).toHaveText([
    "Needs me",
    "Reviews waiting",
    "Stuck agents",
    "anthropic 5h limit",
    "Cost today",
    "Open runs",
  ]);
  const value = (name: string) => page.locator(`[data-testid="tile"][data-tile="${name}"] .big`);
  await expect(value("needs-me")).toHaveText("1");
  await expect(value("reviews")).toHaveText("2");
  await expect(value("runs")).toHaveText("4");
  await expect(value("stuck")).toHaveText("1", { timeout: 20_000 });
  await expect(value("usage")).toHaveText("82%", { timeout: 20_000 });
  const strip = (await page.locator(".tiles").boundingBox())!;
  const columns = page.locator(".cols3 > *");
  await expect(columns).toHaveCount(3);
  const boxes = await columns.evaluateAll((nodes) =>
    nodes.map((node) => {
      const { x, y } = node.getBoundingClientRect();
      return { x, y };
    }),
  );
  expect(boxes[0].y).toBeGreaterThan(strip.y + strip.height - 1);
  expect(boxes[0].x).toBeLessThan(boxes[1].x);
  expect(boxes[1].x).toBeLessThan(boxes[2].x);

  // Column 1: the gate, then the stuck agent with its last line and Open in Orca.
  await expect(columns.nth(0).getByTestId("gate")).toContainText("ARK-501");
  const stuck = columns.nth(0).getByTestId("stuck");
  await expect(stuck).toHaveCount(1, { timeout: 20_000 });
  await expect(stuck).toHaveAttribute("data-run", stuckRun);
  await expect(stuck).toContainText("waiting on a prompt");
  await expect(stuck).toContainText("bun test test/hub.test.ts");
  await expect(stuck.getByRole("button", { name: "Open in Orca" })).toBeVisible();

  // Column 2: the review queue in merge order; the older MR is first.
  const reviews = columns.nth(1).getByTestId("review");
  await expect(reviews).toHaveCount(2);
  await expect(reviews.nth(0)).toHaveAttribute("data-run", older.run);
  await expect(reviews.nth(1)).toHaveAttribute("data-run", newer.run);
  const first = reviews.nth(0);
  const second = reviews.nth(1);
  await expect(first.getByTestId("ci")).toHaveAttribute("data-ci", "passing");
  await expect(second.getByTestId("ci")).toHaveAttribute("data-ci", "failing");
  await expect(first.getByTestId("tests")).toHaveText("6 pass · 0 fail", { timeout: 30_000 });
  await expect(second.getByTestId("tests")).toHaveText("2 pass · 1 fail");
  await expect(first.getByTestId("findings")).toContainText("P1 1 · P2 2 · P3 1");
  await expect(second.getByTestId("findings")).toContainText("P1 2 · P2 0 · P3 0");
  await expect(first.getByTestId("findings-link")).toHaveAttribute(
    "href",
    `#/run/${encodeURIComponent(older.run)}/file/${encodeURIComponent("findings/review.md")}`,
  );
  await expect(first.getByTestId("diff")).toHaveText("+312 −41 · 6 files");
  await expect(second.getByTestId("diff")).toHaveText("+158 −22 · 4 files");
  await expect(first.getByTestId("waited")).toHaveText(/^3\s*h/);
  await expect(second.getByTestId("waited")).toHaveText(/^(19|20|21)\s*min/);
  // One square for each AC, red for the failing one.
  await expect(first.getByTestId("ac-square")).toHaveCount(3);
  await expect(second.getByTestId("ac-square")).toHaveCount(2);
  await expect(second.getByTestId("ac-square").nth(1)).toHaveAttribute("data-status", "failing");

  // Column 3: the progress of each open run, and the usage window in red with its reset time.
  await expect(columns.nth(2).getByTestId("run")).toHaveCount(4);
  const window = columns.nth(2).getByTestId("usage-window");
  await expect(window).toHaveAttribute("data-near", "true");
  await expect(window).toContainText("82%");
  await expect(window.getByTestId("usage-reset")).toContainText(/resets \d\d:\d\d/);
  await expect(page.locator('[data-testid="tile"][data-tile="usage"]')).toHaveClass(/alarm/);

  // Master Chief shows once, in the nav, and no row shows (configured).
  await expect(page.getByText("Master Chief")).toHaveCount(1);
  await expect(page.locator("header.top").getByText("Master Chief")).toHaveCount(1);
  await expect(page.getByText("(configured)")).toHaveCount(0);
});

test("ARK-285-AC5 a javascript: URL in a gate or an MR shows as text, never a link", async ({
  page,
}) => {
  isolate();
  const run = runId("ARK-505");
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-505", title: "Hostile link" },
    phase: "merge_requests_open",
    mergeRequests: [{ repo: ".", url: "javascript:alert(1)", number: 5 }],
  });
  writeEventLog(
    directory,
    ago(7200),
    [
      {
        after: 0,
        type: "run.started",
        data: { run, project: "p", ticket: { id: "ARK-505", title: "Hostile link" }, criteria: [] },
      },
      {
        after: 900,
        type: "merge_request.opened",
        data: { repo: ".", url: "javascript:alert(1)", number: 5 },
      },
    ],
    [],
  );
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "");
  await expect(page.getByTestId("mr")).toContainText("!5");
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await open(page, baseUrl, `run/${run}`);
  await expect(page.getByTestId("timeline-entry").first()).toBeVisible();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
});

test("ARK-285-AC7 Runs shows every run on one board and graph with filters, rings of steps done, dashed edges to open tickets and what each run unblocks", async ({
  page,
}) => {
  isolate();
  const step = (id: string, role: string, needs: string[], done: boolean) => ({
    id,
    role,
    harness: "omp",
    model: "m",
    needs,
    startedAfter: done ? 20 : 400,
    ...(done ? { finishedAfter: 300 } : {}),
  });
  const ticket = (id: string, extra: Partial<Parameters<typeof writeBacklogTicket>[0]> = {}) =>
    writeBacklogTicket({ project: "p", id, title: `Title of ${id}`, status: "ready", ...extra });
  const longTitle =
    "A very long title that goes on and on so it needs more than two lines of a card in a lane of the board to show";
  // 2 building: ARK-601 with 1 of 3 steps done, ARK-602 with a long title.
  ticket("ARK-601");
  ticket("ARK-602", { title: longTitle });
  writeRun({
    project: "p",
    run: runId("ARK-601"),
    ticket: { id: "ARK-601", title: "Title of ARK-601" },
    phase: "building",
    steps: [
      step("a", "implementer", [], true),
      step("b", "validator", ["a"], false),
      { id: "c", role: "reviewer", harness: "omp", model: "m", needs: ["b"] },
    ],
  });
  writeRun({
    project: "p",
    run: runId("ARK-602"),
    ticket: { id: "ARK-602", title: longTitle },
    phase: "building",
    steps: [step("only", "implementer", [], false)],
  });
  // 1 queued ticket that waits on a building one; 1 in review that depends on a closed one.
  ticket("ARK-603", { dependsOn: ["ARK-601"] });
  ticket("ARK-604", { dependsOn: ["ARK-611"] });
  reviewRun({
    ticket: "ARK-604",
    title: "Title of ARK-604",
    number: 61,
    criteria: [["ARK-604-AC1", "passing"]],
    createdAgo: 600,
    conclusion: "SUCCESS",
    size: { additions: 1, deletions: 1, changedFiles: 1 },
    findings: "### P3: z\n",
  });
  // 6 closed runs, oldest first: ARK-612 depends on ARK-611.
  for (let number = 1; number <= 6; number++) {
    const id = `ARK-61${number}`;
    ticket(id, { status: "done", ...(number === 2 ? { dependsOn: ["ARK-611"] } : {}) });
    writeRun({
      project: "p",
      run: runId(id),
      ticket: { id, title: `Title of ${id}` },
      phase: "closed",
      startedAt: ago(86_400 - number * 600),
    });
  }
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "runs");
  await expect(page.getByTestId("run-card").first()).toBeVisible();

  // No picker; the five lanes in order.
  await expect(page.getByTestId("run-select")).toHaveCount(0);
  await expect(page.locator("select")).toHaveCount(0);
  await expect(page.getByTestId("lane")).toHaveCount(5);
  expect(
    await page
      .getByTestId("lane")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-lane"))),
  ).toEqual(["Queued", "Building", "Needs me", "Awaiting merge", "Closed"]);
  const lane = (name: string) => page.locator(`[data-testid="lane"][data-lane="${name}"]`);
  await expect(lane("Queued").getByTestId("run-card")).toHaveCount(1);
  await expect(lane("Building").getByTestId("run-card")).toHaveCount(2);
  await expect(lane("Needs me").getByTestId("run-card")).toHaveCount(0);
  await expect(lane("Awaiting merge").getByTestId("run-card")).toHaveCount(1);
  // Closed: the last 5, and a count of the older run.
  await expect(lane("Closed").getByTestId("run-card")).toHaveCount(5);
  await expect(lane("Closed").getByTestId("older-runs")).toHaveText("1 older run in graph");

  // A ring of steps done, from plan.yml: 1 of 3 for ARK-601. A title wraps to 2 lines.
  const ring = lane("Building").locator('[data-ticket="ARK-601"] [data-testid="ring"]');
  await expect(ring).toHaveAttribute("data-steps-done", "1");
  await expect(ring).toHaveAttribute("data-steps-total", "3");
  const wrapped = lane("Building").locator('[data-ticket="ARK-602"] .title2');
  expect(
    await wrapped.evaluate((node) => ({
      clamp: getComputedStyle(node).getPropertyValue("-webkit-line-clamp"),
      cut: node.scrollHeight > node.clientHeight,
    })),
  ).toEqual({ clamp: "2", cut: true });

  // Filters: Active (open runs and the tickets that wait on them), Queued, Old.
  const filter = (name: string) =>
    page.locator(`[data-testid="graph-filter"][data-filter="${name}"]`);
  await expect(filter("Active")).toHaveText(/Active\s*3/);
  await expect(filter("Queued")).toHaveText(/Queued\s*1/);
  await expect(filter("Old")).toHaveText(/Old\s*6/);
  await expect(filter("Active")).toHaveAttribute("aria-pressed", "true");
  const nodes = page.getByTestId("graph-node");
  const ids = async () =>
    (
      await nodes.evaluateAll((all) => all.map((node) => node.getAttribute("data-ticket")))
    ).toSorted((left, right) => (left ?? "").localeCompare(right ?? ""));
  await expect(nodes).toHaveCount(4);
  expect(await ids()).toEqual(["ARK-601", "ARK-602", "ARK-603", "ARK-604"]);
  // An edge from a ticket that is not done is dashed.
  const blocking = page.locator('[data-testid="graph-edge"][data-blocking="true"]');
  await expect(blocking).toHaveCount(1);
  await expect(blocking).toHaveAttribute("data-from", "ARK-601");
  await expect(blocking).toHaveAttribute("data-to", "ARK-603");
  expect(await blocking.evaluate((path) => getComputedStyle(path).strokeDasharray)).not.toBe(
    "none",
  );
  // What finishing a run unblocks.
  await expect(page.locator('[data-testid="unblocks"][data-ticket="ARK-601"]')).toContainText(
    "ARK-603",
  );
  await expect(page.locator('[data-testid="unblocks"][data-ticket="ARK-602"]')).toContainText(
    "unblocks nothing",
  );

  await filter("Queued").click();
  await expect(filter("Queued")).toHaveAttribute("aria-pressed", "true");
  await expect(nodes).toHaveCount(2);
  expect(await ids()).toEqual(["ARK-601", "ARK-603"]);

  await filter("Old").click();
  await expect(nodes).toHaveCount(6);
  expect(await ids()).toEqual([1, 2, 3, 4, 5, 6].map((number) => `ARK-61${number}`));
  // The edge between two closed tickets is satisfied: solid.
  await expect(page.getByTestId("graph-edge")).toHaveCount(1);
  await expect(page.getByTestId("graph-edge")).toHaveAttribute("data-blocking", "false");
  expect(
    await page.getByTestId("graph-edge").evaluate((path) => getComputedStyle(path).strokeDasharray),
  ).toBe("none");
  // The older-runs button opens the Old filter too.
  await filter("Active").click();
  await lane("Closed").getByTestId("older-runs").click();
  await expect(filter("Old")).toHaveAttribute("aria-pressed", "true");

  // A click on a run opens its run page.
  await lane("Building").locator('[data-ticket="ARK-601"]').click();
  await expect(page).toHaveURL(new RegExp(`#/run/${runId("ARK-601")}$`));
  await expect(page.locator("main h1")).toContainText("ARK-601");
});

test("ARK-285-AC8 Backlog groups the tickets, keys move and open them, a ticket opens as a full page with its graph and lists, and Esc returns to the same scroll position", async ({
  page,
}) => {
  isolate();
  const ticket = (
    id: string,
    status: string,
    extra: Partial<Parameters<typeof writeBacklogTicket>[0]> = {},
  ) =>
    writeBacklogTicket({
      project: "p",
      id,
      title: `Title of ${id}`,
      status,
      milestone: "M4",
      ...extra,
    });
  ticket("ARK-701", "ready");
  writeRun({
    project: "p",
    run: runId("ARK-701"),
    ticket: { id: "ARK-701", title: "Title of ARK-701" },
    phase: "building",
  });
  ticket("ARK-702", "in_progress");
  ticket("ARK-703", "ready", {
    dependsOn: ["ARK-701"],
    title: "The ticket page",
    problem:
      "The first line.\n\nSecond paragraph with <b>raw markup</b> in it.\n\n- one bullet\n- another bullet",
    change: "Change the page <script>window.__ran = 1</script>.",
    criteria: [
      { id: "ARK-703-AC1", text: "The page shows the title" },
      { id: "ARK-703-AC2", text: "Esc returns to the list" },
    ],
  });
  ticket("ARK-704", "ready", { dependsOn: ["ARK-703"] });
  ticket("ARK-705", "superseded");
  ticket("ARK-706", "done");
  // Enough proposed tickets that the page scrolls.
  for (let number = 0; number < 40; number++)
    ticket(`ARK-8${String(number).padStart(2, "0")}`, "proposed");
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "backlog");
  const rows = page.getByTestId("ticket-row");
  await expect(rows.first()).toBeVisible();

  // Rows are grouped; done and superseded tickets wait behind Show done.
  expect(
    await page
      .getByTestId("group")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-group"))),
  ).toEqual(["In a run", "In progress", "Ready", "Proposed"]);
  await expect(rows).toHaveCount(44);
  await expect(page.locator('[data-testid="ticket-row"][data-ticket="ARK-706"]')).toHaveCount(0);
  await page.getByTestId("show-done").check();
  await expect(page.locator('[data-testid="ticket-row"][data-ticket="ARK-706"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="ticket-row"][data-ticket="ARK-705"]')).toHaveCount(1);
  await page.getByTestId("show-done").uncheck();

  // j and k move the selection; / focuses the search.
  const selected = page.locator('[data-testid="ticket-row"][aria-current="true"]');
  await expect(selected).toHaveAttribute("data-ticket", "ARK-701");
  await page.keyboard.press("j");
  await expect(selected).toHaveAttribute("data-ticket", "ARK-702");
  await page.keyboard.press("j");
  await expect(selected).toHaveAttribute("data-ticket", "ARK-703");
  await page.keyboard.press("k");
  await expect(selected).toHaveAttribute("data-ticket", "ARK-702");
  await page.keyboard.press("/");
  await expect(page.getByTestId("filter-text")).toBeFocused();
  await page.keyboard.type("ticket page");
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("filter-text")).not.toBeFocused();
  await page.getByTestId("filter-text").fill("");
  await expect(rows).toHaveCount(44);
  await page.keyboard.press("Escape"); // out of the search box: j and k are keys again

  // Move far down the list, so the page has scrolled, then Enter opens the ticket.
  for (let press = 0; press < 30; press++) await page.keyboard.press("j");
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(100);
  const target = (await selected.getAttribute("data-ticket"))!;
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/ticket/${target}$`));
  await expect(page.getByTestId("ticket-page")).toBeVisible();

  // Esc returns to the list: same row, same scroll position.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/backlog$/);
  await expect(selected).toHaveAttribute("data-ticket", target);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);

  // The full page of ARK-703: title, problem, change, numbered criteria, graph and lists.
  await page.locator('[data-testid="ticket-link"]', { hasText: "ARK-703" }).click();
  await expect(page.locator("main h1")).toHaveText("The ticket page");
  await expect(page.getByTestId("ticket-problem")).toContainText("The first line.");
  await expect(page.getByTestId("ticket-problem").locator("li")).toHaveText([
    "one bullet",
    "another bullet",
  ]);
  // The text is escaped: the markup shows as written and nothing runs.
  await expect(page.getByTestId("ticket-problem")).toContainText("<b>raw markup</b>");
  await expect(page.locator(".prose b")).toHaveCount(0);
  await expect(page.getByTestId("ticket-change")).toContainText(
    "<script>window.__ran = 1</script>",
  );
  expect(
    await page.evaluate(() => (window as unknown as { __ran?: number }).__ran),
  ).toBeUndefined();
  const criteria = page.getByTestId("ticket-criterion");
  await expect(criteria).toHaveCount(2);
  await expect(criteria.nth(1)).toContainText("Esc returns to the list");
  expect(
    await page.locator("ol.criteria").evaluate((list) => getComputedStyle(list).listStyleType),
  ).toBe("decimal");
  // Its own dependency graph: the ticket, what it depends on and what it unblocks.
  const graph = page.getByTestId("ticket-graph");
  expect(
    (
      await graph
        .getByTestId("graph-node")
        .evaluateAll((all) => all.map((node) => node.getAttribute("data-ticket")))
    ).toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
  ).toEqual(["ARK-701", "ARK-703", "ARK-704"]);
  await expect(graph.getByTestId("graph-edge")).toHaveCount(2);
  await expect(page.getByTestId("depends-on").getByTestId("dep-link")).toHaveText(["ARK-701"]);
  await expect(page.getByTestId("unblocks-list").getByTestId("unblock-link")).toHaveText([
    "ARK-704",
  ]);
  await page.getByTestId("unblocks-list").getByTestId("unblock-link").click();
  await expect(page).toHaveURL(/#\/ticket\/ARK-704$/);
  await expect(page.locator("main h1")).toHaveText("Title of ARK-704");
});

test("ARK-285-AC9 the run page puts a progress strip, the vertical step plan, then agents, MR evidence and a link to the ticket in the hybrid-1 layout, and keeps the decisions, run files and Open in Orca", async ({
  page,
}) => {
  isolate();
  // One closed run gives the typical time of an implementer and of a validator step: 10 min.
  writeRun({
    project: "p",
    run: runId("ARK-900"),
    ticket: { id: "ARK-900", title: "History" },
    phase: "closed",
    startedAt: ago(172_800),
    steps: [
      {
        id: "old",
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 60,
        finishedAfter: 660,
      },
      {
        id: "older",
        role: "validator",
        harness: "omp",
        model: "m",
        needs: ["old"],
        startedAfter: 700,
        finishedAfter: 1300,
      },
    ],
  });
  const run = runId("ARK-901");
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-901", title: "A run in the new layout" },
    phase: "building",
    startedAt: ago(1800),
    steps: [
      {
        id: "first",
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 60,
        finishedAfter: 600,
      },
      {
        id: "second",
        role: "validator",
        harness: "omp",
        model: "m",
        needs: ["first"],
        startedAfter: 660,
      },
      { id: "third", role: "reviewer", harness: "omp", model: "m", needs: ["second"] },
    ],
  });
  writeFileSync(join(directory, "plan.md"), "# Plan\n");
  writeBacklogTicket({
    project: "p",
    id: "ARK-901",
    title: "A run in the new layout",
    status: "ready",
  });
  const review = reviewRun({
    ticket: "ARK-902",
    title: "A run with an MR",
    number: 93,
    criteria: [
      ["ARK-902-AC1", "passing"],
      ["ARK-902-AC2", "failing"],
    ],
    createdAgo: 900,
    conclusion: "SUCCESS",
    size: { additions: 5, deletions: 2, changedFiles: 1 },
    findings: "### P2: q\n",
  });
  installFakeTools({
    orca: orcaAnswersFor(run),
    mergeRequestViews: { [review.url]: review.view },
  });
  const baseUrl = await launch();
  await open(page, baseUrl, `run/${run}`);

  // Progress strip: steps done, round, the time in the step against its role, cost, start. No ETA.
  const strip = page.locator(".strip");
  await expect(strip.getByTestId("steps-done")).toHaveText("1 of 3");
  await expect(strip.getByTestId("round")).toHaveText("round 1 of 3");
  await expect(strip.getByTestId("step-time")).toHaveText(
    /^validator \d+ min · typical \d+ · slow above \d+$/,
    { timeout: 20_000 },
  );
  await expect(page.locator("main")).not.toContainText(/\bETA\b/);

  // The vertical plan: one step below the other, the strip above the plan, the plan left of the side column.
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  const first = await box('[data-testid="step-node"][data-step="first"]');
  const second = await box('[data-testid="step-node"][data-step="second"]');
  const third = await box('[data-testid="step-node"][data-step="third"]');
  expect(second.y).toBeGreaterThan(first.y + first.height);
  expect(third.y).toBeGreaterThan(second.y + second.height);
  expect(Math.abs(first.x - third.x)).toBeLessThan(2);
  const stripBox = (await strip.boundingBox())!;
  expect(first.y).toBeGreaterThan(stripBox.y + stripBox.height);
  const agents = await box('[data-testid="agents"]');
  expect(agents.x).toBeGreaterThan(first.x + first.width);

  // The side column: agents with Open in Orca, the merge request, a link to the ticket page.
  await expect(page.getByTestId("agents").getByTestId("open-in-orca")).toHaveCount(2);
  await expect(page.getByTestId("evidence")).toContainText("No merge request yet");
  await page.getByTestId("ticket-link").click();
  await expect(page).toHaveURL(/#\/ticket\/ARK-901$/);
  await expect(page.locator("main h1")).toHaveText("A run in the new layout");

  // Still there: the decisions timeline, the run files and the transcript links.
  await open(page, baseUrl, `run/${run}`);
  await expect(page.getByTestId("timeline")).toBeVisible();
  await expect(page.getByTestId("run-file-link").first()).toBeVisible();
  await expect(page.getByTestId("session-link")).toHaveCount(0); // no session file in this fixture
  await expect(page.getByTestId("step-row")).toHaveCount(3);

  // An MR in review shows its evidence: CI, diff size, each AC with its status, the findings.
  await open(page, baseUrl, `run/${review.run}`);
  const evidence = page.getByTestId("evidence");
  await expect(evidence.getByTestId("ci")).toHaveAttribute("data-ci", "passing");
  await expect(evidence).toContainText("+5 −2 · 1 files");
  const criterion = (id: string) =>
    evidence.locator(`[data-testid="evidence-criterion"][data-id="${id}"]`);
  await expect(criterion("ARK-902-AC1")).toHaveAttribute("data-status", "passing", {
    timeout: 30_000,
  });
  await expect(criterion("ARK-902-AC2")).toContainText("some failing");
  await expect(evidence).toContainText("P2 1");
});

type Contrast = { text: string; ratio: number; need: number };

/** Text of the page that is below 4.5:1 (3:1 when large), by the colors the browser computed. */
async function weakContrast(page: Page): Promise<{ checked: number; weak: Contrast[] }> {
  return page.evaluate(() => {
    type Color = { r: number; g: number; b: number; a: number };
    const parse = (css: string): Color => {
      const channels = css.match(/-?[\d.]+%?/g)?.map(Number) ?? [0, 0, 0, 0];
      const srgb = css.startsWith("color(");
      const scale = srgb ? 255 : 1;
      return {
        r: channels[0] * scale,
        g: channels[1] * scale,
        b: channels[2] * scale,
        a: channels[3] ?? 1,
      };
    };
    const over = (top: Color, bottom: Color): Color => {
      const a = top.a + bottom.a * (1 - top.a);
      const mix = (front: number, back: number) =>
        a === 0 ? 0 : (front * top.a + back * bottom.a * (1 - top.a)) / a;
      return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
    };
    const light = (color: Color) => {
      const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const background = (element: Element): Color => {
      let color: Color = { r: 0, g: 0, b: 0, a: 0 };
      for (let node: Element | null = element; node; node = node.parentElement) {
        color = over(color, parse(getComputedStyle(node).backgroundColor));
        if (color.a >= 1) break;
      }
      return over(color, parse(getComputedStyle(document.documentElement).backgroundColor));
    };
    const weak: Contrast[] = [];
    let checked = 0;
    for (const element of document.querySelectorAll("header.top *, main *")) {
      const own = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim() ?? "")
        .join(" ")
        .trim();
      const style = getComputedStyle(element);
      if (own === "" || element.getClientRects().length === 0 || style.visibility === "hidden")
        continue;
      if (element.closest("button:disabled, svg")) continue;
      checked += 1;
      const back = background(element);
      const text = over(
        { ...parse(style.color), a: parse(style.color).a * Number(style.opacity) },
        back,
      );
      const [bright, dark] = [light(text), light(back)].sort((left, right) => right - left);
      const ratio = (bright + 0.05) / (dark + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need)
        weak.push({ text: own.slice(0, 40), ratio: Math.round(ratio * 100) / 100, need });
    }
    return { checked, weak };
  });
}

test("ARK-285-AC10 the theme follows the system, the nav switch sets Auto, Light or Dark and keeps it after a reload, and text keeps its contrast on Home, Runs and a ticket page in both themes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { baseUrl } = await homeWithBlockers();
  for (const [id, status] of [
    ["ARK-511", "ready"],
    ["ARK-512", "ready"],
  ])
    writeBacklogTicket({
      project: "p",
      id,
      title: `Title of ${id}`,
      status,
      dependsOn: id === "ARK-512" ? ["ARK-511"] : [],
      problem: "A problem in words.\n\n- a bullet",
      change: "A change in words.",
      criteria: [{ id: `${id}-AC1`, text: "It works" }],
    });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, baseUrl, "");
  // Wait for every panel the contrast check must see.
  await expect(page.getByTestId("stuck")).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId("review").first().getByTestId("tests")).toHaveText(
    "6 pass · 0 fail",
    {
      timeout: 30_000,
    },
  );

  const theme = (name: string) =>
    page.getByRole("group", { name: "Theme" }).getByRole("button", { name });
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // Auto follows the system scheme.
  await expect(theme("Auto")).toHaveAttribute("aria-pressed", "true");
  const systemLight = await background();
  await page.emulateMedia({ colorScheme: "dark" });
  const systemDark = await background();
  expect(systemDark).not.toBe(systemLight);

  const views = [
    ["Home", ""],
    ["Runs", "runs"],
    ["a ticket page", "ticket/ARK-512"],
  ] as const;
  const before = requests.length;
  for (const [choice, expected] of [
    ["Light", systemLight],
    ["Dark", systemDark],
  ] as const) {
    await theme(choice).click();
    await expect(theme(choice)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(background).toBe(expected);
    for (const [name, hash] of views) {
      await page.evaluate((target) => (location.hash = `#/${target}`), hash);
      await expect(page.locator("main h1")).toBeVisible();
      if (hash === "") await expect(page.getByTestId("tile")).toHaveCount(6);
      if (hash === "runs") await expect(page.getByTestId("lane")).toHaveCount(5);
      if (hash.startsWith("ticket")) await expect(page.getByTestId("ticket-problem")).toBeVisible();
      // A color that still fades from the other theme is not the color the page rests on.
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((fade) => fade.finished.catch(() => undefined))),
      );
      const { checked, weak } = await weakContrast(page);
      expect(checked, `text checked on ${name} in ${choice}`).toBeGreaterThan(20);
      expect(weak, `${name} in ${choice}`).toEqual([]);
    }
  }
  // Switching the theme and the views sent no request but the ticket text.
  expect(requests.slice(before).filter((path) => !path.startsWith("/api/ticket/"))).toEqual([]);

  // The choice stays after a reload, and Auto goes back to the system.
  await page.evaluate(() => (location.hash = "#/"));
  await theme("Light").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(page.locator("main h1")).toBeVisible();
  await expect(theme("Light")).toHaveAttribute("aria-pressed", "true");
  expect(await background()).toBe(systemLight);
  await theme("Auto").click();
  await expect.poll(background).toBe(systemDark);
});
