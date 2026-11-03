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

test("ARK-284-AC2 Home and the run page show Open in Orca for each live agent, Master Chief included, ended for a released one and a no-button label for one running but not listed", async ({
  page,
}) => {
  isolate();
  const run = runId("ARK-831");
  writeRun({ project: "p", run, ticket: { id: "ARK-831", title: "Agents" }, phase: "building" });
  const answers = orcaWithReleasedWorker(run);
  const state = installFakeTools({ orca: answers });
  const baseUrl = await launch();
  const home = page.locator(`[data-testid="run"][data-run="${run}"]`);
  const button = (handle: string) =>
    page.locator(`[data-testid="open-in-orca"][data-terminal="${handle}"]`);

  await open(page, baseUrl, "");
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

  // Home: a button for the live agents, Master Chief too; the released one says why it has none.
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

  // The run page shows the same.
  await open(page, baseUrl, `run/${run}`);
  await expect(page.getByTestId("open-in-orca")).toHaveCount(3);
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

test("ARK-284-AC3 a closed run opens from its Backlog row and from its Map node, and both lead to the newest run", async ({
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

  // Map: the node of a ticket with a run links to its newest run; a closed one opens too.
  await open(page, baseUrl, "map");
  await expect(page.locator('[data-testid="map-node"][data-ticket="ARK-841"] a')).toHaveAttribute(
    "href",
    `#/run/${newer}`,
  );
  await page.getByTestId("map-finished").click();
  const node = page.locator('[data-testid="map-node"][data-ticket="ARK-842"] a');
  await expect(node).toHaveAttribute("href", `#/run/${only}`);
  await node.click();
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
