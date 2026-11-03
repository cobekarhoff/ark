import { expect, test, type Page, type Request } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendRawEvent,
  orcaAnswersFor,
  today,
  writeBacklogTicket,
  writeOmpSession,
  writeRun,
  type FixtureRun,
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
  const pages = await Promise.all(["", "run", "backlog", "map"].map(() => context.newPage()));
  await Promise.all(
    ["", "run", "backlog", "map"].map((hash, index) => open(pages[index], baseUrl, hash)),
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
  await expect(page.getByTestId("agent").first()).toBeVisible(); // Orca answered: the first load is complete
  const firstLoad = requests.length;

  const firstLoadPaths = requests.map((request) => new URL(request.url()).pathname);
  expect(firstLoadPaths.filter((path) => path === "/events")).toHaveLength(1);
  for (const path of firstLoadPaths)
    expect(path === "/" || path === "/events" || path.startsWith("/assets/"), path).toBe(true);

  const views = [
    ["Home", "Open runs"],
    ["Run", "Plan DAG"],
    ["Backlog", "Backlog"],
    ["Map", "Map"],
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

  // The one request after it is the Run view's read of its run (`GET /api/run/<run>`, ARK-284).
  const later = requests.slice(firstLoad).map((request) => new URL(request.url()).pathname);
  expect(later.length).toBeGreaterThan(0);
  for (const path of later) expect(path).toBe(`/api/run/${run}`);
});

// ---------------------------------------------------------------- AC7

test("ARK-277-AC7 Home shows Needs me first, then each open run with its agents, MR, CI state and cost", async ({
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
  const needsMe = await page.getByText("Needs me").first().boundingBox();
  expect(needsMe!.y).toBeLessThan((await runA.boundingBox())!.y);
  expect((await gate.boundingBox())!.y).toBeLessThan((await runA.boundingBox())!.y);

  // Run A: ticket, title, phase, agents with role, harness and model, MR with state and CI, cost.
  await expect(runA).toContainText("ARK-701");
  await expect(runA).toContainText("Run with a failing MR");
  await expect(runA.locator("[data-phase]")).toHaveAttribute("data-phase", "merge_requests_open");
  const lead = runA.locator('[data-testid="agent"][data-role="run lead"]');
  await expect(lead).toContainText("omp");
  await expect(lead).toContainText("anthropic/claude-lead-model");
  const worker = runA.locator('[data-testid="agent"][data-role="implementer"]');
  await expect(worker).toContainText("codex");
  await expect(worker).toContainText("openai/gpt-worker-model");
  await expect(runA.getByTestId("mr")).toHaveAttribute("data-state", "open");
  await expect(runA.getByTestId("mr")).toContainText("!71");
  await expect(runA.getByTestId("ci")).toHaveAttribute("data-ci", "failing");
  await expect(runA.getByTestId("cost")).toHaveText("$1.25");

  // Run B has no session: its cost is unknown, never $0.
  await expect(runB.locator("[data-phase]")).toHaveAttribute("data-phase", "awaiting_criteria");
  await expect(runB.getByTestId("cost")).toHaveText("unknown");

  // No review open: the gate shows its question instead of a link.
  writeFileSync(join(state, "plannotator.sessions"), "[]");
  await expect(gate.getByTestId("gate-link")).toHaveCount(0, { timeout: 20_000 });
  await expect(gate).toContainText("Run at a gate");
  await expect(gate).toContainText(/acceptance criteria/i);
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
  await expect(rows).toHaveCount(5);
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
  await expect(rows).toHaveCount(3); // the text filter alone: ARK-921 joins

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

test("ARK-277-AC10 the Map draws one node for each ticket and one edge for each depends_on, colored by the newest run's phase", async ({
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
  await open(page, baseUrl, "map");

  // Default: tickets whose newest run is not closed (901, 903) and their direct neighbours (902,
  // 904), live work first. 905 has no run and no neighbour in a run: hidden until Show all tickets.
  const nodes = page.getByTestId("map-node");
  await expect(nodes).toHaveCount(4);
  await expect(page.locator('[data-testid="map-node"][data-ticket="ARK-905"]')).toHaveCount(0);
  expect(
    await nodes.evaluateAll((all) =>
      all.slice(0, 2).map((node) => node.getAttribute("data-ticket")),
    ),
  ).toEqual(["ARK-901", "ARK-903"]);
  // A node is a link: to the newest run, or to the Backlog row when there is none.
  const hrefOf = (ticket: string) =>
    page.locator(`[data-testid="map-node"][data-ticket="${ticket}"] a`).getAttribute("href");
  expect(await hrefOf("ARK-901")).toBe(`#/run/${encodeURIComponent(runId("ARK-901", 2))}`);
  expect(await hrefOf("ARK-902")).toBe("#/backlog/ARK-902");
  await page.getByRole("button", { name: "Show all tickets" }).click();
  await expect(nodes).toHaveCount(5);
  const expectedPhase: Record<string, string> = {
    "ARK-901": "building",
    "ARK-902": "no run",
    "ARK-903": "planning",
    "ARK-904": "no run",
    "ARK-905": "no run",
  };
  const fills = new Map<string, string>();
  for (const [ticket, phase] of Object.entries(expectedPhase)) {
    const node = page.locator(`[data-testid="map-node"][data-ticket="${ticket}"]`);
    await expect(node).toHaveAttribute("data-phase", phase);
    fills.set(ticket, await node.locator("rect").evaluate((box) => getComputedStyle(box).fill));
  }
  // The color is the phase: ARK-902, ARK-904 and ARK-905 share one, building and planning differ from it and each other.
  expect(new Set(["ARK-902", "ARK-904", "ARK-905"].map((id) => fills.get(id))).size).toBe(1);
  expect(new Set([fills.get("ARK-901"), fills.get("ARK-903"), fills.get("ARK-902")]).size).toBe(3);

  const edges = page.getByTestId("map-edge");
  await expect(edges).toHaveCount(4);
  const drawn = await edges.evaluateAll((paths) =>
    paths.map((path) => `${path.getAttribute("data-from")}>${path.getAttribute("data-to")}`),
  );
  expect(drawn.sort()).toEqual(
    ["ARK-901>ARK-902", "ARK-901>ARK-903", "ARK-902>ARK-904", "ARK-903>ARK-904"].sort(),
  );

  // No step nodes: the plan of the building run does not reach the Map.
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

  const agents = page.locator(`[data-testid="run"][data-run="${run}"] td`).nth(3);
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
  await open(page, baseUrl, "");

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
  // pr checks still answers: its fact is shown, the state is not made up.
  await expect(request.getByTestId("ci")).toHaveAttribute("data-ci", "passing");
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
  await open(page, baseUrl, "");

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
