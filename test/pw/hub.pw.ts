import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  appendRawEvent,
  commitCase,
  ompMessagesText,
  orcaAnswersFor,
  today,
  transcriptText,
  transcriptTexts,
  writeBacklogTicket,
  writeEventLog,
  writeFakeToolState,
  writeOmpSession,
  writeRoadmap,
  writeRun,
  writeSessionFile,
  type FixtureRun,
  type SessionHarness,
} from "../hub-fixtures.ts";
import {
  checkpoint,
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
  const pages = await Promise.all(["", "runs", "roadmap"].map(() => context.newPage()));
  await Promise.all(
    ["", "runs", "roadmap"].map((hash, index) => open(pages[index], baseUrl, hash)),
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
    ["Roadmap", "Roadmap"],
  ] as const;
  // The page clock runs from here; the real Date.now steps (the Home append below) are the test's own, not the page's.
  await page.clock.install();
  for (const [name, heading] of views) {
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
    // The AC is about 30 s of silence on each view: advance the page clock, no real wait.
    const before = requests.length;
    await page.clock.fastForward(30_000);
    expect(
      requests.slice(before).map((request) => request.url()),
      `${name} after 30 s`,
    ).toEqual([]);
  }

  // No view reads anything after the first load: Runs and Roadmap draw from the snapshot, and the
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

test("ARK-277-AC9 Roadmap lists and filters the tickets, changes none, and copies the review IDs in dependency order", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  isolate();
  // ARK-912 depends on ARK-919: dependency order is the reverse of ID order. The three proposed
  // tickets wait in Needs your review.
  const tickets = [
    {
      id: "ARK-912",
      title: "Show the ledger",
      status: "proposed",
      milestone: "M4",
      dependsOn: ["ARK-919"],
    },
    { id: "ARK-915", title: "Rename a flag", status: "proposed", milestone: "M4" },
    { id: "ARK-919", title: "Write the ledger", status: "proposed", milestone: "M4" },
    { id: "ARK-921", title: "Old ledger cleanup", status: "done", milestone: "M3" },
    { id: "ARK-923", title: "Waiting on a decision", status: "blocked" },
  ];
  for (const ticket of tickets) writeBacklogTicket({ project: "p", ...ticket });
  writeRoadmap("p", { now: ["ARK-915", "ARK-919"], next: ["ARK-912"] });
  installFakeTools({});
  const baseUrl = await launch();
  const methods: string[] = [];
  page.on("request", (request) => methods.push(request.method()));
  await open(page, baseUrl, "roadmap");

  const rows = page.getByTestId("ticket-row");
  await expect(rows).toHaveCount(4); // the done ticket ARK-921 is in no list
  // Each ticket: ID, title, status, milestone and depends_on.
  const ledger = page.locator('[data-testid="ticket-row"][data-ticket="ARK-912"]');
  await expect(ledger).toContainText("ARK-912");
  await expect(ledger).toContainText("Show the ledger");
  await expect(ledger).toContainText("proposed");
  await expect(ledger).toContainText("M4");
  await expect(ledger).toContainText("Blocked by");
  await expect(ledger).toContainText("ARK-919");

  await page.getByTestId("filter-text").fill("ledger");
  await expect(rows).toHaveCount(2); // about the ledger and not finished: ARK-912 and ARK-919
  await expect(page.locator('[data-testid="ticket-row"][data-ticket="ARK-921"]')).toHaveCount(0);

  // Nothing here changes a ticket: the page has no form, and the copy button only copies.
  await expect(page.locator("main form")).toHaveCount(0);

  await page.getByTestId("filter-text").fill("");
  await page.getByRole("button", { name: "Copy prompt for Master Chief" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Evaluate ARK-915, ARK-919, ARK-912.",
  );

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
  writeRoadmap("p", { now: ["ARK-930"] });
  writeFileSync(
    join(process.env.ARK_HOME as string, "projects", "p", "tickets", "README.md"),
    "# Tickets\n\n| id | title |\n",
  );
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "roadmap");

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
  await page.getByRole("link", { name: "Roadmap" }).click();
  await expect(page.getByRole("heading", { name: "Roadmap" })).toBeVisible();
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

test("ARK-284-AC3 a closed run opens from its Roadmap row and from its Runs card, and both lead to the newest run", async ({
  page,
}) => {
  isolate();
  const ticket = (id: string) => ({ id, title: `Ticket ${id}` });
  for (const id of ["ARK-841", "ARK-842"])
    writeBacklogTicket({ project: "p", id, title: `Ticket ${id}`, status: "ready" });
  writeRoadmap("p", { now: ["ARK-841", "ARK-842"] });
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

  // Roadmap: the runs of a ticket, newest first; a link opens the closed one.
  await open(page, baseUrl, "roadmap");
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
  project?: string;
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
    project: options.project ?? "p",
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

const usageAt = (fraction: number, baseInstant = Date.now()) => ({
  reports: [
    {
      provider: "anthropic",
      fetchedAt: Date.now(),
      limits: [
        {
          window: { id: "5h", resetsAt: baseInstant + 4_440_000 },
          amount: { usedFraction: fraction },
        },
      ],
    },
  ],
});

/** Home with 1 gate, 1 stuck agent (a prompt), 2 MRs in review and the 5h window of anthropic at 82%. The usage reset is `baseInstant` + 74 min: the page compares it with its own clock, every age with the server's. */
async function homeWithBlockers(baseInstant = Date.now(), holdOrca = false) {
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
  const tools = installFakeTools({
    orca,
    mergeRequestViews: { [older.url]: older.view, [newer.url]: newer.view },
    ompUsage: usageAt(0.82, baseInstant),
    plannotatorSessions: [
      { index: 1, target: join(gate, "ticket.md"), url: "http://localhost:20000/review/gate" },
    ],
  });
  // A test-owned gate: every fake Orca call waits until the test removes this file, so the first snapshot is late.
  const orcaGate = join(tools, "orca.gate");
  if (holdOrca) writeFileSync(orcaGate, "");
  return { baseUrl: await launch(), older, newer, stuckRun, orcaGate };
}

/** The fixture and the page clock share one instant in UTC, so the reset form (HH:MM or date and time) never depends on when the suite runs. */
test.describe("the usage reset on a frozen clock", () => {
  test.use({ timezoneId: "UTC" });
  const day = new Date().toISOString().slice(0, 10);
  const at = (time: string) => Date.parse(`${day}T${time}:00Z`);

  test("ARK-285-AC5 Home shows the tile strip first, then the blockers, the review queue in merge order and the progress and usage, with Master Chief once", async ({
    page,
  }) => {
    await checkHomeWithBlockers(page, at("12:00"), /resets \d\d:\d\d/);
  });
  test("ARK-301-AC1 page clock at 23:30 UTC: the reset falls on the next day and shows its date", async ({
    page,
  }) => {
    await checkHomeWithBlockers(page, at("23:30"), /resets \d\d \w{3} 00:\d\d/);
  });
  test("ARK-301-AC1 page clock at 12:00 UTC: the reset falls on the same day and shows HH:MM only", async ({
    page,
  }) => {
    await checkHomeWithBlockers(page, at("12:00"), /resets 13:\d\d/);
  });
});

async function checkHomeWithBlockers(page: Page, baseInstant: number, reset: RegExp) {
  await page.clock.setFixedTime(baseInstant);
  const { baseUrl, older, newer, stuckRun } = await homeWithBlockers(baseInstant);
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
  await expect(window.getByTestId("usage-reset")).toContainText(reset);
  await expect(page.locator('[data-testid="tile"][data-tile="usage"]')).toHaveClass(/alarm/);

  // Master Chief shows once, in the nav, and no row shows (configured).
  await expect(page.getByText("Master Chief")).toHaveCount(1);
  await expect(page.locator("header.top").getByText("Master Chief")).toHaveCount(1);
  await expect(page.getByText("(configured)")).toHaveCount(0);
}

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

test("ARK-T26 Roadmap lists the tickets by horizon, keys move and open them, a ticket opens as a full page with its graph and lists, and Esc returns to the same scroll position", async ({
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
  const proposed = Array.from(
    { length: 40 },
    (_, number) => `ARK-8${String(number).padStart(2, "0")}`,
  );
  for (const id of proposed) ticket(id, "proposed");
  writeRoadmap("p", {
    now: ["ARK-701"],
    next: ["ARK-702", "ARK-703"],
    later: ["ARK-704", ...proposed, "ARK-705", "ARK-706"],
  });
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "roadmap");
  const rows = page.getByTestId("ticket-row");
  await expect(rows.first()).toBeVisible();
  await checkpoint(page, "roadmap-list");

  // Sections in horizon order; a done or superseded ticket is in no list, though ROADMAP.md lists it.
  expect(
    await page
      .getByTestId("roadmap-section")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-section"))),
  ).toEqual(["Now", "Next", "Later", "Unranked"]);
  await expect(rows).toHaveCount(44);
  await expect(page.locator('[data-testid="ticket-row"][data-ticket="ARK-706"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="ticket-row"][data-ticket="ARK-705"]')).toHaveCount(0);

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

  // Enter on a button belongs to the button, even with a row selected.
  await page.keyboard.press("j");
  await expect(selected).toHaveCount(1);
  await page.getByTestId("view-list").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/#\/roadmap$/);
  await page.locator("body").click({ position: { x: 1, y: 1 } });

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
  await expect(page).toHaveURL(/#\/roadmap$/);
  await expect(selected).toHaveAttribute("data-ticket", target);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);

  // The full page of ARK-703: title, problem, change, numbered criteria, graph and lists.
  await page
    .locator('[data-testid="ticket-row"][data-ticket="ARK-703"] [data-testid="ticket-link"]')
    .click();
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
  await checkpoint(page, "ticket-criteria");
  await expect(criteria).toHaveCount(2);
  await expect(criteria.nth(1)).toContainText("Esc returns to the list");
  // ARK-314: each criterion shows its own id (AC1, AC2) in place of a list number.
  await expect(criteria.locator(".crit-head .mono")).toHaveText(["AC1", "AC2"]);
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

test("ARK-T131 ARK-285-AC9 the run page puts a progress strip, the vertical step plan, then agents, MR evidence and a link to the ticket in the hybrid-1 layout, and keeps the decisions, run files and Open in Orca", async ({
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

  // A test-owned late layout (nothing in product code): once released, a 400 ms transition grows the strip by 1000 px and moves the plan and the side column.
  await page.addStyleTag({
    content:
      ".strip { transition: padding-bottom 400ms, margin-right 400ms; } html.late .strip { padding-bottom: 1000px; margin-right: 40px; }",
  });
  const stripSelector = ".strip";
  const [stripBefore] = await settledBoxes(page, [stripSelector]);
  await page.evaluate(() => document.documentElement.classList.add("late"));
  await checkpoint(page, "layout-released");
  // Read every box in one frame, after the late layout settled.
  const [first, second, third, stripBox, agents] = await settledBoxes(page, [
    '[data-testid="step-node"][data-step="first"]',
    '[data-testid="step-node"][data-step="second"]',
    '[data-testid="step-node"][data-step="third"]',
    stripSelector,
    '[data-testid="agents"]',
  ]);
  // The forced change happened: the strip grew by the 1000 px the hook adds.
  expect(stripBox.height).toBeGreaterThanOrEqual(stripBefore.height + 999);
  await checkpoint(page, "layout-settled");
  // The vertical plan: one step below the other, the strip above the plan, the plan left of the side column.
  expect(second.y).toBeGreaterThan(first.y + first.height);
  expect(third.y).toBeGreaterThan(second.y + second.height);
  expect(Math.abs(first.x - third.x)).toBeLessThan(2);
  expect(first.y).toBeGreaterThan(stripBox.y + stripBox.height);
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
  await expect(criterion("ARK-902/AC1")).toHaveAttribute("data-status", "passing", {
    timeout: 30_000,
  });
  await expect(criterion("ARK-902/AC2")).toContainText("some failing");
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

test("ARK-T96 the theme follows the system, the nav switch sets Auto, Light or Dark and keeps it after a reload, and text keeps its contrast on Home, Runs and a ticket page in both themes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The fake Orca is held: the first snapshot is late until the test releases it.
  const { baseUrl, orcaGate } = await homeWithBlockers(Date.now(), true);
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
  // Held: the agent probe has not answered, so no action button exists yet.
  const actions = page.locator(".btn.primary:not(:disabled), .btn-orca:not(:disabled)");
  await expect(page.getByTestId("stuck")).toHaveCount(1, { timeout: 20_000 });
  await expect(actions).toHaveCount(0);
  rmSync(orcaGate);
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
  // Switching the theme and the views sent no request but the document read of each ticket page opening (ARK-329).
  expect(requests.slice(before)).toEqual(["/api/ticket/p/ARK-512", "/api/ticket/p/ARK-512"]);

  // In Dark, a primary button and Open in Orca keep 4.5:1 for their white 13px text while hovered.
  await theme("Dark").click();
  await open(page, baseUrl, "");
  await expect(page.getByTestId("stuck")).toHaveCount(1);
  // The buttons render after the stuck row once the agent probe answers: wait, don't count once.
  await expect(actions.first()).toBeVisible({ timeout: 20_000 });
  for (let index = 0; index < (await actions.count()); index++) {
    const action = actions.nth(index);
    // Hover state reached (a snapshot push may re-render the button and drop it: hover again), then the color transition (a Web Animation) finished.
    await expect(async () => {
      await action.hover();
      expect(await action.evaluate((element) => element.matches(":hover"))).toBe(true);
    }).toPass();
    await action.evaluate(async (element) => {
      await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)));
      await Promise.all(
        element.getAnimations().map((fade) => fade.finished.catch(() => undefined)),
      );
    });
    await checkpoint(page, "hover-state-final");
    const ratio = await action.evaluate((element) => {
      const channels = (css: string) =>
        css
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number);
      const light = (css: string) => {
        const [r, g, b] = channels(css).map((channel) => {
          const value = channel / 255;
          return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const style = getComputedStyle(element);
      const [one, two] = [light(style.color), light(style.backgroundColor)].sort((a, b) => b - a);
      return (one + 0.05) / (two + 0.05);
    });
    expect(ratio, `hovered action ${index} in Dark`).toBeGreaterThanOrEqual(4.5);
  }

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

test("ARK-T123 every test runs on its own worker slot with its own ARK_HOME and its own hub port", async () => {
  expect(test.info().config.fullyParallel).toBe(true);
  expect(test.info().config.workers).toBeGreaterThanOrEqual(2);
  // Two tests of one run would collide on these three if they were shared.
  const firstHome = tempArkHome();
  const secondHome = tempArkHome();
  expect(firstHome).not.toBe(secondHome);
  installFakeTools({});
  const firstHub = await launch();
  const secondHub = await launch();
  expect(new URL(firstHub).port).not.toBe("0");
  expect(new URL(firstHub).port).not.toBe(new URL(secondHub).port);
});

test("ARK-T124 the 30 s page-clock silence check sees a 25 s poll and stays empty without one", async ({
  page,
}) => {
  isolate();
  installFakeTools({});
  const baseUrl = await launch();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await open(page, baseUrl, "");
  await page.clock.install();

  // No poll: 30 s of page time send nothing.
  const quiet = requests.length;
  await page.clock.fastForward(30_000);
  expect(requests.slice(quiet)).toEqual([]);

  // The injected fault: a poll every 25 s. fastForward fires it, so the same check now fails.
  await page.evaluate(() => {
    setInterval(() => void fetch("/api/snapshot"), 25_000);
  });
  const polled = requests.length;
  await page.clock.fastForward(30_000);
  await expect.poll(() => requests.slice(polled)).toContain("/api/snapshot");
});

test("ARK-T128 the first action of Home is visible and its hover colour final after a late first snapshot", async ({
  page,
}) => {
  // The fake Orca is held, so the first snapshot is late until the test releases it.
  const { baseUrl, orcaGate } = await homeWithBlockers(Date.now(), true);
  const actions = page.locator(".btn.primary:not(:disabled), .btn-orca:not(:disabled)");
  await open(page, baseUrl, "");
  await expect(actions).toHaveCount(0);
  rmSync(orcaGate);
  const action = actions.first();
  await expect(action).toBeVisible();
  await expect(async () => {
    await action.hover();
    expect(await action.evaluate((element) => element.matches(":hover"))).toBe(true);
  }).toPass();
  await action.evaluate(async (element) => {
    await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)));
    await Promise.all(element.getAnimations().map((fade) => fade.finished.catch(() => undefined)));
  });
  await checkpoint(page, "hover-state-final");
  // The transition has ended: a second read of the colour is the same as the first.
  const colour = () => action.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await colour()).toBe(await colour());
});

test("ARK-285-AC1 #/map redirects to #/runs and the nav has no Map", async ({ page }) => {
  isolate();
  installFakeTools({});
  const baseUrl = await launch();
  await page.goto(`${baseUrl}/#/map`);
  await expect(page.getByTestId("lane")).toHaveCount(5);
  await expect(page).toHaveURL(/#\/runs$/);
  const links = page.getByRole("navigation", { name: "Views" }).getByRole("link");
  await expect(links).toHaveText(["Home", "Runs", "Roadmap"]);
});

test("ARK-T27 Home, Runs and Roadmap send no request after the first load, and a ticket page and a run page read only their own text", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { baseUrl, older, stuckRun } = await homeWithBlockers();
  writeBacklogTicket({
    project: "p",
    id: "ARK-521",
    title: "Ticket",
    status: "ready",
    criteria: [{ id: "AC1", text: "It works", method: "test", verifiedBy: ["ARK-T1"] }],
  });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await open(page, baseUrl, "");
  // Every reader has answered: the first load is complete.
  await expect(page.getByTestId("stuck")).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId("review").first().getByTestId("tests")).toHaveText(
    "6 pass · 0 fail",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("stale-label")).toHaveCount(0);
  const firstLoad = requests.splice(0);
  expect(firstLoad.filter((path) => path === "/events")).toHaveLength(1);
  for (const path of firstLoad)
    expect(path === "/" || path === "/events" || path.startsWith("/assets/"), path).toBe(true);

  const nav = page.getByRole("navigation", { name: "Views" });
  for (const [name, heading] of [
    ["Runs", "Runs"],
    ["Roadmap", "Roadmap"],
    ["Home", "Needs me"],
  ] as const) {
    await nav.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { name: new RegExp(heading) }).first()).toBeVisible();
  }
  await page.waitForTimeout(2000);
  expect(requests.splice(0)).toEqual([]);

  // The ticket page reads its text once (ARK-329) and, amended AC7 of ARK-314, its test cases once.
  await open(page, baseUrl, "ticket/ARK-521");
  await expect(page.getByTestId("ticket-page")).toBeVisible();
  await checkpoint(page, "ticket-page-requests");
  await page.waitForTimeout(1000);
  expect(requests.filter((path) => path.startsWith("/api/ticket"))).toEqual([
    "/api/ticket/p/ARK-521",
    "/api/ticket/p/ARK-521/cases",
  ]);
  // The run page does read (`/api/run`, from ARK-284): the one place the page goes past AC11.
  await open(page, baseUrl, `run/${stuckRun}`);
  await expect(page.getByTestId("timeline")).toBeVisible();
  await open(page, baseUrl, `run/${older.run}`);
  await expect(page.getByTestId("evidence")).toBeVisible();
  await checkpoint(page, "run-evidence-requests");
  await page.waitForTimeout(2000);
  const extra = requests.filter(
    (path) => path !== "/" && path !== "/events" && !path.startsWith("/assets/"),
  );
  expect(extra.length).toBeGreaterThan(0);
  for (const path of extra.filter((path) => !path.startsWith("/api/ticket/")))
    expect(path.startsWith("/api/run/"), path).toBe(true);
  // One read of the test evidence for each of the two run pages (these plans have no image).
  expect(extra.filter((path) => path.endsWith("/evidence"))).toHaveLength(2);
  expect(extra.filter((path) => path.endsWith("/image"))).toEqual([]);
});

// ---------------------------------------------------------------- ARK-291

type TicketOptions = Partial<Parameters<typeof writeBacklogTicket>[0]>;

/** A ticket of project `p` in milestone M4 whose Problem starts with `Why <id>.`. */
const roadmapTicket = (id: string, status: string, extra: TicketOptions = {}) =>
  writeBacklogTicket({
    project: "p",
    id,
    title: `Title of ${id}`,
    status,
    milestone: "M4",
    problem: `Why ${id}. More words follow.`,
    ...extra,
  });

const rowOf = (page: Page, id: string) =>
  page.locator(`[data-testid="ticket-row"][data-ticket="${id}"]`);
const ticketsOf = (page: Page) =>
  page
    .getByTestId("ticket-row")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-ticket")));

test("ARK-291-AC1 the nav shows Roadmap and not Backlog, and #/backlog and #/backlog/<ticket> redirect to #/roadmap and #/roadmap/<ticket>", async ({
  page,
}) => {
  isolate();
  roadmapTicket("ARK-701", "ready");
  writeRoadmap("p", { now: ["ARK-701"] });
  installFakeTools({});
  const baseUrl = await launch();

  await page.goto(`${baseUrl}/#/backlog`);
  await expect(page).toHaveURL(/#\/roadmap$/);
  await expect(page.getByTestId("roadmap-page")).toBeVisible();
  await page.goto(`${baseUrl}/#/backlog/ARK-701`);
  await expect(page).toHaveURL(/#\/roadmap\/ARK-701$/);
  await expect(page.getByTestId("ticket-page")).toContainText("ARK-701");
  await expect(page.getByTestId("roadmap-page")).toHaveCount(0);

  const links = page.getByRole("navigation", { name: "Views" }).getByRole("link");
  await expect(links).toHaveText(["Home", "Runs", "Roadmap"]);
  await expect(page.getByRole("navigation", { name: "Views" })).not.toContainText("Backlog");
  await expect(links.nth(2)).toHaveAttribute("href", "#/roadmap");
});

test("ARK-291-AC3 Now shows cards and Next, Later and Unranked rows in rank order with rank, ID, title, why, milestone, phase or status, Blocked by and Unblocks, and a finished ticket is in no list", async ({
  page,
}) => {
  isolate();
  roadmapTicket("ARK-101", "ready"); // Now, has an open run
  writeRun({
    project: "p",
    run: runId("ARK-101"),
    ticket: { id: "ARK-101", title: "Title of ARK-101" },
    phase: "building",
  });
  roadmapTicket("ARK-102", "ready", { dependsOn: ["ARK-199"] }); // Now, its only dependency is finished
  roadmapTicket("ARK-103", "proposed"); // Next
  roadmapTicket("ARK-104", "ready", { dependsOn: ["ARK-101", "ARK-199"] }); // Later, blocked by ARK-101
  roadmapTicket("ARK-105", "ready"); // in no list: Unranked
  roadmapTicket("ARK-199", "done", { milestone: "M3" }); // finished, still listed
  writeRoadmap("p", {
    vision: "Make the next step obvious.",
    milestones: [
      ["M3", "Third", "Done outcome.", "done"],
      ["M4", "Fourth", "Fourth outcome.", "active"],
    ],
    // ARK-102 ranks above ARK-101 although its ID is larger.
    now: ["ARK-102", "ARK-101"],
    next: ["ARK-103"],
    later: ["ARK-104", "ARK-199"],
  });
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "roadmap");
  await expect(page.getByTestId("roadmap-vision")).toHaveText("Make the next step obvious.");

  // Horizons in order; the rows within each in rank order; ARK-199 in none.
  expect(
    await page
      .getByTestId("roadmap-section")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-section"))),
  ).toEqual(["Now", "Next", "Later", "Unranked"]);
  expect(
    await page
      .getByTestId("ticket-row")
      .evaluateAll((nodes) =>
        nodes.map(
          (node) => `${node.getAttribute("data-horizon")}:${node.getAttribute("data-ticket")}`,
        ),
      ),
  ).toEqual(["now:ARK-102", "now:ARK-101", "next:ARK-103", "later:ARK-104", "unranked:ARK-105"]);
  await expect(rowOf(page, "ARK-199")).toHaveCount(0);
  await expect(page.getByTestId("rank")).toHaveText(["1", "2", "3", "4", "·"]);

  // Now is two cards; the other horizons are rows.
  const section = (name: string) => page.locator(`[data-section="${name}"]`);
  await expect(section("Now").locator("article")).toHaveCount(2);
  await expect(section("Now").locator("li")).toHaveCount(0);
  for (const name of ["Next", "Later", "Unranked"]) {
    await expect(section(name).locator("article")).toHaveCount(0);
    await expect(section(name).locator("li")).toHaveCount(1);
  }

  // Each card and row: ID, title, why, milestone.
  for (const id of ["ARK-101", "ARK-102", "ARK-103", "ARK-104", "ARK-105"]) {
    const row = rowOf(page, id);
    await expect(row).toContainText(id);
    await expect(row.getByTestId("ticket-link")).toHaveText(`Title of ${id}`);
    await expect(row).toContainText(`Why ${id}.`);
    await expect(row).not.toContainText("More words follow");
    await expect(row.getByTestId("milestone-chip")).toHaveText("M4");
  }
  // The run phase while a run is open, else the status; a proposed ticket has its badge.
  await expect(rowOf(page, "ARK-101").getByTestId("status-chip")).toHaveText(/build/i);
  await expect(rowOf(page, "ARK-102").getByTestId("status-chip")).toHaveText("ready");
  await expect(rowOf(page, "ARK-103").getByTestId("status-chip")).toHaveText("proposed");
  await expect(rowOf(page, "ARK-104").getByTestId("status-chip")).toHaveText("ready");

  // Blocked by lists the unfinished dependencies only; Unblocks the open tickets that wait.
  await expect(rowOf(page, "ARK-104").getByTestId("blocked-by")).toHaveText(["ARK-101"]);
  await expect(rowOf(page, "ARK-102").getByTestId("blocked-by")).toHaveCount(0);
  await expect(rowOf(page, "ARK-101").getByTestId("unblocks")).toHaveText(["ARK-104"]);
  await expect(rowOf(page, "ARK-104").getByTestId("unblocks")).toHaveCount(0);

  // A row links to its run and opens the ticket page.
  const run = rowOf(page, "ARK-101").getByTestId("ticket-run");
  await expect(run).toHaveAttribute("data-run", runId("ARK-101"));
  await expect(run).toHaveAttribute("href", new RegExp(`#/run/${runId("ARK-101")}$`));
  await expect(rowOf(page, "ARK-102").getByTestId("ticket-run")).toHaveCount(0);
  await rowOf(page, "ARK-104").getByTestId("ticket-link").click();
  await expect(page).toHaveURL(/#\/ticket\/ARK-104$/);
  await expect(page.getByTestId("ticket-page")).toBeVisible();
  await expect(page.locator("main h1")).toHaveText("Title of ARK-104");
});

test("ARK-291-AC3 the project is picked at the top of Roadmap or by a header chip, each project shows only its own tickets, vision and review, and the URL keeps it over a reload and Esc", async ({
  page,
}) => {
  isolate();
  roadmapTicket("ARK-111", "ready", { project: "alpha" });
  roadmapTicket("ARK-112", "proposed", { project: "alpha" });
  roadmapTicket("QC-211", "ready", { project: "beta" });
  roadmapTicket("QC-212", "proposed", { project: "beta" });
  writeRoadmap("alpha", { vision: "Alpha vision.", now: ["ARK-111"] });
  writeRoadmap("beta", { vision: "Beta vision.", now: ["QC-211"] });
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "roadmap");

  const pick = (name: string) =>
    page.getByRole("group", { name: "Project" }).getByRole("button", { name, exact: true });
  const expectOnly = async (vision: string, ranked: string, review: string) => {
    await expect(page.getByTestId("roadmap-vision")).toHaveText(vision);
    await expect.poll(() => ticketsOf(page)).toEqual([ranked]);
    await expect(page.getByTestId("review-item")).toHaveAttribute("data-ticket", review);
    await expect(page.getByTestId("review-item")).toHaveCount(1);
  };

  await expect(pick("All projects")).toHaveAttribute("aria-pressed", "true");
  await pick("alpha").click();
  await expect(pick("alpha")).toHaveAttribute("aria-pressed", "true");
  await expectOnly("Alpha vision.", "ARK-111", "ARK-112");

  await pick("beta").click();
  await expect(page).toHaveURL(/#\/roadmap\?project=beta$/);
  await expectOnly("Beta vision.", "QC-211", "QC-212");

  // Reload keeps the project; Esc from a ticket returns to it.
  await page.reload();
  await expectOnly("Beta vision.", "QC-211", "QC-212");
  await rowOf(page, "QC-211").getByTestId("ticket-link").click();
  await expect(page.getByTestId("ticket-page")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/roadmap\?project=beta$/);
  await expectOnly("Beta vision.", "QC-211", "QC-212");

  // The header control drives the same project.
  await pick("alpha").click();
  await expect(page).toHaveURL(/#\/roadmap\?project=alpha$/);
  await expect(pick("alpha")).toHaveAttribute("aria-pressed", "true");
  await expectOnly("Alpha vision.", "ARK-111", "ARK-112");
});

test("ARK-291-AC4 the rail shows each active and later milestone with its outcome and bar, folds the done milestones into one line that unfolds, and a milestone click filters the lists and the graph", async ({
  page,
}) => {
  isolate();
  roadmapTicket("ARK-301", "done", { milestone: "M1" });
  roadmapTicket("ARK-302", "done", { milestone: "M1" });
  roadmapTicket("ARK-303", "done", { milestone: "M2" });
  roadmapTicket("ARK-401", "ready", { milestone: "M3" });
  roadmapTicket("ARK-402", "ready", { milestone: "M3", dependsOn: ["ARK-401"] });
  roadmapTicket("ARK-403", "done", { milestone: "M3" });
  roadmapTicket("ARK-404", "ready", { milestone: "M4" });
  writeRoadmap("p", {
    milestones: [
      ["M1", "First", "Outcome one.", "done"],
      ["M2", "Second", "Outcome two.", "done"],
      ["M3", "Third", "Outcome three.", "active"],
      ["M4", "Fourth", "Outcome four.", "later"],
    ],
    now: ["ARK-401"],
    next: ["ARK-402"],
    later: ["ARK-404"],
  });
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "roadmap");
  const picks = page.getByTestId("milestone-pick");

  // Active and later milestones, each with its outcome and a done-against-open bar.
  await expect(picks).toHaveCount(2);
  expect(
    await picks.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-state"))),
  ).toEqual(["active", "later"]);
  await expect(picks.nth(0)).toContainText("Outcome three.");
  await expect(picks.nth(1)).toContainText("Outcome four.");
  await expect(picks.nth(0)).toContainText("1 done · 2 open");
  await expect(picks.nth(1)).toContainText("0 done · 1 open");
  const bars = page.getByTestId("milestone-bar");
  const barPercents = await bars.evaluateAll((elements) =>
    elements.map((element) => parseFloat((element as HTMLElement).style.width)),
  );
  expect(barPercents[0]).toBeCloseTo(100 / 3, 1);
  expect(barPercents[1]).toBe(0);

  // The done milestones are one line with their count and done sum; a click unfolds them.
  const fold = page.getByTestId("done-fold");
  await expect(fold).toContainText("M1–M2");
  await expect(fold).toContainText("2 milestones · 3 done");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(picks).toHaveCount(4);
  await expect(page.locator('[data-testid="milestone-pick"][data-state="done"]')).toHaveCount(2);

  // A click on a milestone filters the lists.
  await expect.poll(() => ticketsOf(page)).toEqual(["ARK-401", "ARK-402", "ARK-404"]);
  const m3 = page.locator('[data-testid="milestone-pick"][data-milestone="M3"]');
  await m3.click();
  await expect(m3).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("milestone-filter")).toContainText("M3");
  await expect.poll(() => ticketsOf(page)).toEqual(["ARK-401", "ARK-402"]);

  // And the graph: one lane, the tickets of the milestone only.
  await page.getByTestId("view-graph").click();
  await expect(page.getByTestId("graph-lane")).toHaveCount(1);
  await expect(page.getByTestId("graph-lane")).toHaveAttribute("data-milestone", "M3");
  expect(
    (
      await page
        .getByTestId("graph-node")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-ticket")))
    ).toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
  ).toEqual(["ARK-401", "ARK-402"]);

  // Clear shows every milestone again; a done milestone filters too.
  await page
    .getByTestId("milestone-filter")
    .getByRole("button", { name: "Show all milestones" })
    .click();
  await expect(page.getByTestId("graph-lane")).toHaveCount(2);
  await page.getByTestId("view-list").click();
  await expect.poll(() => ticketsOf(page)).toEqual(["ARK-401", "ARK-402", "ARK-404"]);
  await page.locator('[data-testid="milestone-pick"][data-milestone="M1"]').click();
  await expect(page.getByTestId("ticket-row")).toHaveCount(0);
  await expect(page.getByTestId("milestone-filter")).toContainText("M1");
  await page.getByTestId("milestone-all").click();
  await expect.poll(() => ticketsOf(page)).toEqual(["ARK-401", "ARK-402", "ARK-404"]);
});

test("ARK-291-AC5 Needs your review lists every proposed ticket in 2 lines, says Master Chief evaluates and the human approves, and copies Evaluate with the IDs in dependency order", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  isolate();
  // ARK-912 depends on ARK-919; ARK-915 is unranked, the others are ranked.
  roadmapTicket("ARK-912", "proposed", {
    milestone: "M5",
    dependsOn: ["ARK-919"],
    title: "A very long title that goes on and on ".repeat(8),
  });
  roadmapTicket("ARK-915", "proposed", { milestone: "M4" });
  roadmapTicket("ARK-919", "proposed", { milestone: "M4" });
  roadmapTicket("ARK-920", "ready"); // not proposed: not in the column
  writeRoadmap("p", { now: ["ARK-920"], next: ["ARK-912"], later: ["ARK-919"] });
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "roadmap");

  const review = page.getByTestId("review");
  await expect(review).toContainText("Needs your review");
  await expect(page.getByTestId("review-count")).toHaveText("3");
  await expect(review).toContainText("Master Chief evaluates these tickets and you approve them");
  const items = review.getByTestId("review-item");
  await expect(items).toHaveCount(3);
  expect(
    (
      await items.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-ticket")))
    ).toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
  ).toEqual(["ARK-912", "ARK-915", "ARK-919"]);

  // Line 1: ID and milestone. Line 2: the title, cut after 2 lines.
  const long = review.locator('[data-testid="review-item"][data-ticket="ARK-912"]');
  await expect(long.locator("b")).toHaveText("ARK-912");
  await expect(long.getByTestId("milestone-chip")).toHaveText("M5");
  const cut = await long.locator(".rm-rvt").evaluate((title) => {
    const style = getComputedStyle(title);
    const line = parseFloat(style.lineHeight);
    return {
      height: title.clientHeight,
      line,
      overflowing: title.scrollHeight > title.clientHeight,
    };
  });
  expect(cut.overflowing).toBe(true);
  expect(cut.height).toBeLessThanOrEqual(cut.line * 2 + 1);
  expect(cut.height).toBeGreaterThan(cut.line * 1.5);

  // The copy puts the dependency before its dependent; ID order would put ARK-912 first.
  await page.getByRole("button", { name: "Copy prompt for Master Chief" }).click();
  await expect(page.getByTestId("copy-status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Evaluate ARK-915, ARK-919, ARK-912.",
  );
});

test("ARK-291-AC6 the Shipped bar shows the done sum and the done count of each milestone, a click opens one fold for each milestone and the superseded tickets sit in a second fold inside it", async ({
  page,
}) => {
  isolate();
  roadmapTicket("ARK-601", "done", { milestone: "M1" });
  roadmapTicket("ARK-602", "done", { milestone: "M1" });
  roadmapTicket("ARK-603", "superseded", { milestone: "M1" });
  roadmapTicket("ARK-604", "done", { milestone: "M2" });
  roadmapTicket("ARK-605", "superseded", { milestone: "M2" });
  roadmapTicket("ARK-606", "superseded", { milestone: "M2" });
  roadmapTicket("ARK-607", "ready", { milestone: "M2" });
  roadmapTicket("ARK-608", "done"); // finished, milestone M4 is not declared
  roadmapTicket("ARK-609", "done", { milestone: undefined }); // finished, no milestone
  writeRoadmap("p", {
    milestones: [
      ["M1", "First", "Outcome one.", "done"],
      ["M2", "Second", "Outcome two.", "active"],
    ],
    now: ["ARK-607"],
  });
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "roadmap");

  // Shipped tickets are in no list; the bar is shut and shows the counts.
  await expect.poll(() => ticketsOf(page)).toEqual(["ARK-607"]);
  const bar = page.getByTestId("shipped-bar");
  await expect(bar.getByTestId("shipped-total")).toHaveText("5 done");
  await expect(bar.getByTestId("shipped-count")).toHaveText(["M1 2", "M2 1", "M4 1", "– 1"]);
  await expect(page.getByTestId("shipped-panel")).toHaveCount(0);
  await bar.getByTestId("shipped-toggle").click();
  const panel = page.getByTestId("shipped-panel");
  await expect(panel).toBeVisible();

  // One fold for each milestone, shut until clicked.
  const folds = panel.getByTestId("shipped-fold");
  await expect(folds).toHaveCount(4);
  await expect(panel.getByTestId("shipped-ticket")).toHaveCount(0);
  const first = panel.locator('[data-testid="shipped-fold"][data-milestone="M1"]');
  await first.getByRole("button").first().click();
  await expect(first.getByTestId("shipped-ticket")).toHaveText([
    "ARK-601Title of ARK-601",
    "ARK-602Title of ARK-602",
  ]);
  await expect(
    panel.locator(
      '[data-testid="shipped-fold"][data-milestone="M2"] [data-testid="shipped-ticket"]',
    ),
  ).toHaveCount(0);

  // The superseded tickets are in a second fold inside it, shut until clicked.
  const superseded = first.getByTestId("superseded-fold");
  await expect(superseded).toContainText("1 superseded");
  await expect(first.locator('[data-ticket="ARK-603"]')).toHaveCount(0);
  await superseded.click();
  await expect(
    first.locator('[data-testid="shipped-ticket"][data-ticket="ARK-603"]'),
  ).toBeVisible();

  // The second milestone has its own folds, with its own two superseded tickets.
  const second = panel.locator('[data-testid="shipped-fold"][data-milestone="M2"]');
  await second.getByRole("button").first().click();
  await expect(
    second.locator('[data-testid="shipped-ticket"][data-ticket="ARK-604"]'),
  ).toBeVisible();
  await expect(second.getByTestId("superseded-fold")).toContainText("2 superseded");
  await second.getByTestId("superseded-fold").click();
  await expect(second.getByTestId("shipped-ticket")).toHaveCount(3);
});

test("ARK-291-AC7 Graph draws every open ticket in a lane for its milestone in roadmap order, a finished dependency as a dot in the done strip, a dashed edge to an unfinished ticket, and no edge crosses a node it does not join", async ({
  page,
}) => {
  isolate();
  roadmapTicket("ARK-700", "done", { milestone: "M0" });
  roadmapTicket("ARK-701", "ready", { milestone: "M7", dependsOn: ["ARK-700"] }); // has a run
  writeRun({
    project: "p",
    run: runId("ARK-701"),
    ticket: { id: "ARK-701", title: "Title of ARK-701" },
    phase: "building",
  });
  roadmapTicket("ARK-702", "ready", { milestone: "M7", dependsOn: ["ARK-701"] });
  roadmapTicket("ARK-703", "ready", { milestone: "M5", dependsOn: ["ARK-701", "ARK-702"] });
  roadmapTicket("ARK-704", "proposed", { milestone: "M6", dependsOn: ["ARK-703"] });
  roadmapTicket("ARK-705", "ready", { milestone: "M6", dependsOn: ["ARK-701"] });
  roadmapTicket("ARK-706", "ready", { milestone: "M6", dependsOn: ["ARK-702", "ARK-705"] });
  writeRoadmap("p", {
    // Roadmap order is M7, M5, M6: not the order of the IDs.
    milestones: [
      ["M0", "Old", "Old outcome.", "done"],
      ["M7", "Seventh", "Outcome seven.", "active"],
      ["M5", "Fifth", "Outcome five.", "later"],
      ["M6", "Sixth", "Outcome six.", "later"],
    ],
    now: ["ARK-701", "ARK-702"],
    next: ["ARK-703"],
  });
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "roadmap");
  await page.getByTestId("view-graph").click();
  await expect(page.getByTestId("roadmap-graph")).toBeVisible();
  // No node clips its content: the id row, chip and title all fit the node box.
  expect(
    await page
      .getByTestId("graph-node")
      .evaluateAll((nodes) => nodes.filter((box) => box.scrollHeight > box.clientHeight).length),
  ).toBe(0);

  // Every open ticket is a node, with or without a run, in the lane of its milestone.
  expect(
    await page
      .getByTestId("graph-lane")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-milestone"))),
  ).toEqual(["M7", "M5", "M6"]);
  const placed = await page.evaluate(() => {
    const lanes = [...document.querySelectorAll('[data-testid="graph-lane"]')].map((lane) => ({
      id: lane.getAttribute("data-milestone"),
      box: lane.getBoundingClientRect(),
    }));
    return [...document.querySelectorAll('[data-testid="graph-node"]')].map((node) => {
      const box = node.getBoundingClientRect();
      const lane = lanes.find(
        (candidate) =>
          box.left >= candidate.box.left - 1 &&
          box.right <= candidate.box.right + 1 &&
          box.top >= candidate.box.top - 1 &&
          box.bottom <= candidate.box.bottom + 1,
      );
      return `${node.getAttribute("data-ticket")}:${lane?.id}`;
    });
  });
  expect(placed.toSorted()).toEqual([
    "ARK-701:M7",
    "ARK-702:M7",
    "ARK-703:M5",
    "ARK-704:M6",
    "ARK-705:M6",
    "ARK-706:M6",
  ]);
  await expect(page.locator('[data-testid="graph-node"][data-ticket="ARK-700"]')).toHaveCount(0);

  // The finished dependency is a dot in the narrow done strip, left of every lane.
  await expect(page.getByTestId("graph-strip")).toBeVisible();
  await expect(page.getByTestId("graph-dot")).toHaveCount(1);
  await expect(page.getByTestId("graph-dot")).toHaveAttribute("data-ticket", "ARK-700");
  const stripBox = (await page.getByTestId("graph-strip").boundingBox())!;
  const firstLane = (await page.getByTestId("graph-lane").first().boundingBox())!;
  expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(firstLane.x);
  expect(stripBox.width).toBeLessThan(firstLane.width / 2);

  // Edges: one for each dependency; dashed to an unfinished ticket, solid from the dot.
  const edges = page.getByTestId("graph-edge");
  await expect(edges).toHaveCount(8);
  const drawn = await edges.evaluateAll((paths) =>
    paths.map((path) => ({
      pair: `${path.getAttribute("data-from")}>${path.getAttribute("data-to")}`,
      blocking: path.getAttribute("data-blocking"),
      dash: getComputedStyle(path).strokeDasharray,
    })),
  );
  expect(drawn.map((edge) => edge.pair).toSorted()).toEqual([
    "ARK-700>ARK-701",
    "ARK-701>ARK-702",
    "ARK-701>ARK-703",
    "ARK-701>ARK-705",
    "ARK-702>ARK-703",
    "ARK-702>ARK-706",
    "ARK-703>ARK-704",
    "ARK-705>ARK-706",
  ]);
  for (const edge of drawn) {
    if (edge.pair === "ARK-700>ARK-701") {
      expect(edge.blocking).toBe("false");
      expect(edge.dash, edge.pair).toBe("none");
    } else {
      expect(edge.blocking, edge.pair).toBe("true");
      expect(edge.dash, edge.pair).not.toBe("none");
    }
  }

  // No edge enters the box of a node it does not join: sample each path every 2 px.
  const crossings = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>('[data-testid="graph-node"]')].map(
      (node) => ({ id: node.getAttribute("data-ticket"), box: node.getBoundingClientRect() }),
    );
    const found: string[] = [];
    let sampled = 0;
    for (const path of document.querySelectorAll<SVGPathElement>('[data-testid="graph-edge"]')) {
      const from = path.getAttribute("data-from");
      const to = path.getAttribute("data-to");
      const matrix = path.getScreenCTM()!;
      const length = path.getTotalLength();
      for (let at = 0; at <= length; at += 2) {
        const point = path.getPointAtLength(at).matrixTransform(matrix);
        sampled += 1;
        for (const { id, box } of nodes) {
          if (id === from || id === to) continue;
          if (
            point.x > box.left + 1 &&
            point.x < box.right - 1 &&
            point.y > box.top + 1 &&
            point.y < box.bottom - 1
          )
            found.push(`${from}>${to} crosses ${id}`);
        }
      }
    }
    return { found: [...new Set(found)], sampled };
  });
  expect(crossings.sampled).toBeGreaterThan(200);
  expect(crossings.found).toEqual([]);
});

test("ARK-291-AC8 a warning shows in a notice with its ticket IDs, an error replaces the lists and Review still shows, a project with no file shows one line, and the page has /ark brainstorm with a copy button, no edit control and no extra request", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  isolate();
  const home = process.env.ARK_HOME as string;
  const project = (name: string) => join(home, "projects", name);
  // `a-warn`: one warning of each kind. ARK-802 is ranked above its open dependency ARK-801.
  const warn = (id: string, status: string, extra: TicketOptions = {}) =>
    roadmapTicket(id, status, { project: "a-warn", ...extra });
  warn("ARK-801", "ready");
  warn("ARK-802", "ready", { dependsOn: ["ARK-801"] });
  warn("ARK-803", "ready"); // open, in no list: unranked
  warn("ARK-804", "done"); // finished, still listed
  warn("ARK-805", "proposed");
  writeRoadmap("a-warn", {
    now: ["ARK-802", "ARK-999"], // ARK-999 has no ticket file
    next: ["ARK-801"],
    later: ["ARK-804"],
  });
  // `b-bad`: line 11 has a state that is none of done, active and later.
  roadmapTicket("ARK-811", "proposed", { project: "b-bad" });
  writeFileSync(
    join(project("b-bad"), "ROADMAP.md"),
    "# Roadmap\n\n## Vision\n\nA vision.\n\n## Milestones\n\n| id | name | outcome | state |\n| --- | --- | --- | --- |\n| M1 | One | Out | sideways |\n",
  );
  // `c-none`: tickets and no ROADMAP.md; its ticket source is github.
  roadmapTicket("ARK-821", "ready", { project: "c-none" });
  writeFileSync(join(project("c-none"), "ark.yml"), "ticket_source: github\n");
  installFakeTools({});
  const baseUrl = await launch();
  const requests: { method: string; path: string }[] = [];
  page.on("request", (request) =>
    requests.push({ method: request.method(), path: new URL(request.url()).pathname }),
  );
  await open(page, baseUrl, "roadmap");
  const projectButton = (name: string) =>
    page.getByRole("group", { name: "Project" }).getByRole("button", { name });
  await projectButton("a-warn").click();
  await expect(page.getByTestId("roadmap-vision")).toBeVisible();

  // Four warnings, one of each kind, each with its ticket IDs, in a notice that is not an alert.
  const warnings = page.getByTestId("roadmap-warning");
  await expect(warnings).toHaveCount(4);
  const noteOf = (kind: string) =>
    page.locator(`[data-testid="roadmap-warning"][data-kind="${kind}"]`);
  await expect(noteOf("missing_ticket").getByTestId("warning-ids")).toHaveText("ARK-999");
  await expect(noteOf("unranked").getByTestId("warning-ids")).toHaveText("ARK-803");
  await expect(noteOf("rank_above_dependency").getByTestId("warning-ids")).toHaveText(
    "ARK-802, ARK-801",
  );
  await expect(noteOf("finished_listed").getByTestId("warning-ids")).toHaveText("ARK-804");
  await expect(page.getByTestId("roadmap-notes")).toBeVisible();
  await expect(page.getByTestId("roadmap-notes")).not.toHaveAttribute("role", "alert");
  await expect(page.getByTestId("notes-link")).toHaveText("4 notes on ROADMAP.md");
  await expect(page.getByTestId("roadmap-error")).toHaveCount(0);

  // /ark brainstorm with a copy button.
  await expect(page.getByTestId("copy-command")).toContainText("/ark brainstorm");
  await page.getByTestId("copy-command").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/ark brainstorm");

  // No control changes a ticket or a rank: no form, field or editable text but the search box, and
  // every button is a view, filter, fold, copy or navigation control.
  await expect(
    page.locator("main form, main textarea, main select, main [contenteditable]"),
  ).toHaveCount(0);
  await expect(page.locator("main input")).toHaveCount(1);
  await expect(page.locator("main input")).toHaveAttribute("type", "search");
  await expect(page.locator("main [draggable='true']")).toHaveCount(0);
  const buttons = await page
    .locator("main button")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.getAttribute("aria-label") ?? node.textContent ?? "").trim()),
    );
  expect(buttons.length).toBeGreaterThan(5);
  for (const name of buttons)
    expect(name, "button").not.toMatch(
      /\b(edit|save|rank|move|approve|queue|delete|remove|assign|set|add)\b/i,
    );

  // A bad file: the message and line replace the lists; Needs your review still shows.
  await projectButton("b-bad").click();
  const failure = page.getByTestId("roadmap-error");
  await expect(failure).toContainText("line 11");
  await expect(failure).toContainText("sideways");
  await expect(page.getByTestId("roadmap-section")).toHaveCount(0);
  await expect(page.getByTestId("ticket-row")).toHaveCount(0);
  await expect(page.getByTestId("review")).toBeVisible();
  await expect(page.getByTestId("review-item")).toHaveAttribute("data-ticket", "ARK-811");
  await expect(page.getByTestId("copy-command")).toBeVisible();

  // No file: one line with the ticket source, and nothing else of the roadmap.
  await projectButton("c-none").click();
  await expect(page.getByTestId("roadmap-none")).toHaveText(
    "This project's roadmap lives in github.",
  );
  await expect(page.getByTestId("roadmap-section")).toHaveCount(0);
  await expect(page.getByTestId("review")).toHaveCount(0);
  await expect(page.getByTestId("milestone-rail")).toHaveCount(0);
  await expect(page.getByTestId("shipped-bar")).toHaveCount(0);
  await expect(page.getByTestId("copy-command")).toBeVisible();
  // The control stays on every state: All projects and one button per project.
  await expect(projectButton("b-bad")).toBeVisible();
  await expect(page.getByRole("group", { name: "Project" }).getByRole("button")).toHaveCount(4);

  // Only GETs, and nothing after the first load but the event stream it opened.
  await page.waitForTimeout(1000);
  expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  for (const { path } of requests)
    expect(path === "/" || path === "/events" || path.startsWith("/assets/"), path).toBe(true);
  expect(requests.filter((request) => request.path === "/events")).toHaveLength(1);
});

test("ARK-291-AC9 j k / Enter and Esc work on Roadmap, Esc returns to the same scroll position, and text keeps 4.5:1 (3:1 large) in light and dark", async ({
  page,
}) => {
  test.setTimeout(120_000);
  isolate();
  roadmapTicket("ARK-501", "ready", { milestone: "M3" });
  roadmapTicket("ARK-502", "ready", { dependsOn: ["ARK-501"], title: "Second ticket" });
  roadmapTicket("ARK-503", "ready", { dependsOn: ["ARK-502"] });
  roadmapTicket("ARK-504", "done", { milestone: "M3" });
  roadmapTicket("ARK-505", "superseded", { milestone: "M3" });
  writeRun({
    project: "p",
    run: runId("ARK-501"),
    ticket: { id: "ARK-501", title: "Title of ARK-501" },
    phase: "building",
  });
  const proposed = Array.from(
    { length: 40 },
    (_, number) => `ARK-6${String(number).padStart(2, "0")}`,
  );
  for (const id of proposed) roadmapTicket(id, "proposed");
  roadmapTicket("ARK-700", "ready"); // unranked
  writeRoadmap("p", {
    milestones: [
      ["M3", "Third", "Outcome three.", "done"],
      ["M4", "Fourth", "Outcome four.", "active"],
    ],
    now: ["ARK-501", "ARK-999"],
    next: ["ARK-502", "ARK-504"],
    later: ["ARK-503", ...proposed],
  });
  installFakeTools({});
  const baseUrl = await launch();
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, baseUrl, "roadmap");
  const rows = page.getByTestId("ticket-row");
  await expect(rows).toHaveCount(44);
  await expect(page.getByTestId("stale-label")).toHaveCount(0); // the nav stops growing once every source has answered
  const selected = page.locator('[data-testid="ticket-row"][aria-current="true"]');

  // j and k move the selection, / goes to the search box, Esc leaves it.
  await expect(selected).toHaveAttribute("data-ticket", "ARK-501");
  await page.keyboard.press("j");
  await expect(selected).toHaveAttribute("data-ticket", "ARK-502");
  await page.keyboard.press("j");
  await expect(selected).toHaveAttribute("data-ticket", "ARK-503");
  await page.keyboard.press("k");
  await expect(selected).toHaveAttribute("data-ticket", "ARK-502");
  await page.keyboard.press("/");
  await expect(page.getByTestId("filter-text")).toBeFocused();
  await page.keyboard.type("second");
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("filter-text")).not.toBeFocused();
  await page.getByTestId("filter-text").fill("");
  await expect(rows).toHaveCount(44);
  await page.keyboard.press("Escape");

  // Far down the page, Enter opens the ticket and Esc comes back to the same row and scroll.
  for (let press = 0; press < 30; press++) await page.keyboard.press("j");
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(100);
  const target = (await selected.getAttribute("data-ticket"))!;
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/ticket/${target}$`));
  await expect(page.getByTestId("ticket-page")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/roadmap$/);
  await expect(selected).toHaveAttribute("data-ticket", target);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);

  // A link that is not a title (Review column, Shipped) keeps the way back too, folds included.
  await page.getByTestId("shipped-toggle").click();
  await page.locator('[data-testid="shipped-fold"] button').first().click();
  const reviewLink = page.locator('[data-testid="review-item"][data-ticket="ARK-639"]');
  await reviewLink.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const viaReview = await page.evaluate(() => window.scrollY);
  expect(viaReview).toBeGreaterThan(100);
  await reviewLink.click();
  await expect(page.getByTestId("ticket-page")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("roadmap-page")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(viaReview);
  await expect(page.getByTestId("shipped-panel")).toBeVisible();
  await expect(page.getByTestId("shipped-ticket").first()).toBeVisible();
  await page.getByTestId("shipped-ticket").first().click();
  await expect(page.getByTestId("ticket-page")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("roadmap-page")).toBeVisible();
  await expect(page.getByTestId("shipped-ticket").first()).toBeVisible();
  await page.getByTestId("shipped-toggle").click();

  // Contrast of the list, the graph, the folds and the notices, in both themes.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('[data-testid="milestone-pick"][data-milestone="M4"]').first().waitFor();
  await page.getByTestId("done-fold").click();
  await page.getByTestId("shipped-toggle").click();
  await page.locator('[data-testid="shipped-fold"] button').first().click();
  const theme = (name: string) =>
    page.getByRole("group", { name: "Theme" }).getByRole("button", { name });
  for (const choice of ["Light", "Dark"]) {
    await theme(choice).click();
    await expect(theme(choice)).toHaveAttribute("aria-pressed", "true");
    for (const view of ["list", "graph"] as const) {
      await page.getByTestId(`view-${view}`).click();
      if (view === "graph") await expect(page.getByTestId("roadmap-graph")).toBeVisible();
      await expect(page.getByTestId("roadmap-warning").first()).toBeVisible();
      // A color that still fades from the other theme is not the color the page rests on.
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((fade) => fade.finished.catch(() => undefined))),
      );
      const { checked, weak } = await weakContrast(page);
      expect(checked, `text checked on ${view} in ${choice}`).toBeGreaterThan(30);
      expect(weak, `${view} in ${choice}`).toEqual([]);
    }
  }
});

// ---------------------------------------------------------------- ARK-309

const costOf = (project: string) => (project === "alpha" ? 1.25 : 2.5);
const ids = (prefix: string) => [1, 2, 3, 4].map((number) => `${prefix}${number}`);
const worlds = [
  { project: "alpha", prefix: "ARK-11" },
  { project: "beta", prefix: "QC-21" },
].map((world) => ({ ...world, ids: ids(world.prefix), run: runId(`${world.prefix}1`) }));
const [alpha, beta] = worlds;

/**
 * Two projects with the same shape: X1 building (cost), X2 queued behind X1 in M5, X3 done with a
 * closed run, X4 proposed. Both ROADMAP.md files carry M4 and M5. `crowd` adds proposed tickets to alpha.
 * `withNotes` lists a ticket with no file in each Now list: one note on ROADMAP.md per project.
 */
function filterWorld(crowd = 0, withNotes = false) {
  isolate();
  for (const {
    project,
    ids: [x1, x2, x3, x4],
    run,
  } of worlds) {
    const ticket = (id: string, status: string, extra: TicketOptions = {}) =>
      roadmapTicket(id, status, { project, ...extra });
    ticket(x1, "ready");
    ticket(x2, "ready", { milestone: "M5", dependsOn: [x1] });
    ticket(x3, "done");
    ticket(x4, "proposed", { milestone: "M5" });
    writeRun({
      project,
      run,
      ticket: { id: x1, title: `Title of ${x1}` },
      phase: "building",
      steps: [
        {
          id: "build",
          role: "implementer",
          harness: "omp",
          model: "m",
          needs: [],
          startedAfter: 40,
        },
      ],
    });
    writeRun({
      project,
      run: runId(x3),
      ticket: { id: x3, title: `Title of ${x3}` },
      phase: "closed",
      startedAt: ago(7200),
    });
    writeRoadmap(project, {
      vision: `${project} vision.`,
      milestones: [
        ["M4", "Fourth", "Outcome four.", "active"],
        ["M5", "Fifth", "Outcome five.", "later"],
      ],
      now: withNotes ? [x1, `${x1}9`] : [x1],
      next: [x2],
      later: project === "alpha" ? Array.from({ length: crowd }, (_, n) => `ARK-9${n}`) : [],
    });
  }
  for (let number = 0; number < crowd; number++)
    roadmapTicket(`ARK-9${number}`, "proposed", { project: "alpha" });
  installFakeTools({});
}

const projectButton = (page: Page, name: string) =>
  page.getByRole("group", { name: "Project" }).getByRole("button", { name, exact: true });
const hrefsOf = (page: Page) =>
  page.locator("a[href^='#/']").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href")!));

test("ARK-309-AC1 the filter is the project query on Home, Runs, a run, Roadmap and a ticket: every link keeps it, a reload keeps it, a click sends no request, an unknown name shows an empty state", async ({
  page,
}) => {
  filterWorld();
  const baseUrl = await launch();
  const pages: [string, () => Promise<unknown>][] = [
    ["", () => expect(page.getByTestId("run").first()).toBeVisible()],
    ["runs", () => expect(page.getByTestId("run-card").first()).toBeVisible()],
    [`run/${alpha.run}`, () => expect(page.getByTestId("timeline")).toBeVisible()],
    ["roadmap", () => expect(page.getByTestId("ticket-row").first()).toBeVisible()],
    [`ticket/${alpha.ids[0]}`, () => expect(page.getByTestId("ticket-page")).toBeVisible()],
  ];
  for (const [hash, ready] of pages) {
    await open(page, baseUrl, `${hash}?project=alpha`);
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await ready();
      await expect(projectButton(page, "alpha")).toHaveAttribute("aria-pressed", "true");
      const links = await hrefsOf(page);
      expect(links.length, hash).toBeGreaterThan(3);
      for (const href of links) expect(href, `${hash} link`).toContain("project=alpha");
    }
  }

  // A click on another button changes the hash and sends no request.
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await projectButton(page, "beta").click();
  await expect(page).toHaveURL(new RegExp(`#/ticket/${alpha.ids[0]}\\?project=beta$`));
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);

  // A name that is no project is an empty state with a way out, never another project's data.
  await open(page, baseUrl, "runs?project=nope");
  await expect(page.getByTestId("unknown-project")).toContainText("No project named nope");
  await expect(page.getByTestId("run-card")).toHaveCount(0);
  await page.getByTestId("unknown-project").getByRole("link", { name: "All projects" }).click();
  await expect(page).toHaveURL(/#\/runs$/);
  await expect(page.getByTestId("run-card").first()).toBeVisible();
});

/** 2 projects, each with a gate, a waiting question, a stuck agent, an open MR and a cost. */
async function homeWorld() {
  isolate();
  const runs = [alpha, beta].map((world, at) => {
    const run = runId(`${world.prefix}1`);
    const directory = writeRun({
      project: world.project,
      run,
      ticket: { id: world.ids[0], title: `Building ${world.project}` },
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
    // Closed runs carry the cost (metrics.json), dated by the local day the page reads.
    const now = new Date();
    const localDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    writeRun({
      project: world.project,
      run: `${localDay}-${world.ids[3]}-1`,
      ticket: { id: world.ids[3], title: `Closed ${world.project}` },
      phase: "closed",
      metricsCostUsd: costOf(world.project),
    });
    writeRun({
      project: world.project,
      run: runId(world.ids[1]),
      ticket: { id: world.ids[1], title: `Gate ${world.project}` },
      phase: "awaiting_criteria",
    });
    const review = reviewRun({
      project: world.project,
      ticket: world.ids[2],
      title: `Review ${world.project}`,
      number: 70 + at,
      criteria: [[`${world.ids[2]}-AC1`, "passing"]],
      createdAgo: 600,
      conclusion: "SUCCESS",
      size: { additions: 1, deletions: 1, changedFiles: 1 },
      findings: "### P3: z\n",
    });
    return { world, run, directory, review };
  });
  const message = (run: string, dispatch: string) => ({
    type: "question",
    from_handle: `dispatch:${dispatch}`,
    to_handle: `run:orca-${run}`,
    subject: "which port?",
    read: 0,
    created_at: new Date().toISOString(),
  });
  installFakeTools({
    orca: {
      ...orcaAnswersFor(runs[0].run),
      runs: runs.map(({ run }) => ({
        id: `orca-${run}`,
        objective: `Ark run ${run}`,
        coordinator_handle: "term-lead",
      })),
      workers: runs.map(({ world }, at) => ({
        taskId: `task-${at}`,
        dispatchId: `ctx_${world.project}`,
        state: "running",
        agentTerminalHandle: "term-worker",
      })),
      tasks: runs.map((_, at) => ({ id: `task-${at}`, title: "hub-server (implementer, .)" })),
      messages: runs.map(({ run, world }) => message(run, `ctx_${world.project}`)),
      worktrees: runs.map(({ directory }) => ({
        path: join(directory, "workspace"),
        agents: [
          {
            taskTitle: "hub-server (implementer, .)",
            state: "working",
            toolName: "bash",
            updatedAt: Date.now(),
            agentWait: { reason: "approval", source: "hook" },
            lastAssistantMessage: "Allow bash?\n",
          },
        ],
      })),
    },
    mergeRequestViews: Object.fromEntries(runs.map(({ review }) => [review.url, review.view])),
    ompUsage: usageAt(0.82),
  });
  return launch();
}

test("ARK-309-AC2 Home counts only the chosen project in its tiles, lists, cost and the header, and the provider limit says all projects, for All, each project and after a reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const baseUrl = await homeWorld();
  const tile = (name: string) => page.locator(`[data-testid="tile"][data-tile="${name}"] .big`);
  const expected = [
    { hash: "", count: 2, cost: "$3.75", badge: "4 need you" },
    { hash: "?project=alpha", count: 1, cost: "$1.25", badge: "2 need you" },
    { hash: "?project=beta", count: 1, cost: "$2.50", badge: "2 need you" },
  ];
  for (const { hash, count, cost, badge } of expected)
    for (const reload of [false, true]) {
      await open(page, baseUrl, hash);
      if (reload) await page.reload();
      await expect(tile("usage")).toHaveText("82%", { timeout: 20_000 });
      await expect(page.getByTestId("stuck")).toHaveCount(count, { timeout: 20_000 });
      await expect(page.getByTestId("review")).toHaveCount(count, { timeout: 20_000 });
      await expect(page.getByTestId("gate")).toHaveCount(count);
      await expect(page.getByTestId("waiting")).toHaveCount(count);
      await expect(page.getByTestId("run")).toHaveCount(count * 3);
      await expect(tile("needs-me")).toHaveText(String(count * 2));
      await expect(tile("reviews")).toHaveText(String(count));
      await expect(tile("stuck")).toHaveText(String(count));
      await expect(tile("runs")).toHaveText(String(count * 3));
      await expect(tile("cost")).toHaveText(cost);
      await expect(page.getByTestId("nav-cost")).toHaveText(`${cost} today`);
      await expect(page.getByLabel(badge)).toBeVisible();
      await expect(page.getByTestId("cost-day").last()).toContainText(cost);
      // The limit is one per account: the same in every case, and named so.
      await expect(page.locator('[data-testid="tile"][data-tile="usage"]')).toContainText(
        "all projects",
      );
      await expect(page.getByTestId("usage-window")).toContainText("all projects");
      await expect(page.getByTestId("nav-usage")).toContainText("82%");
      await expect(page.getByTestId("nav-usage")).toContainText("all projects");
    }
});

test("ARK-309-AC3 Runs shows only the chosen project in its lanes, heading and filter counts, graph and unblocks list, and the heading names the filter", async ({
  page,
}) => {
  filterWorld();
  const baseUrl = await launch();
  const lane = (name: string) => page.locator(`[data-testid="lane"][data-lane="${name}"]`);
  const filter = (name: string) =>
    page.locator(`[data-testid="graph-filter"][data-filter="${name}"]`);
  const nodes = () =>
    page
      .getByTestId("graph-node")
      .evaluateAll((all) =>
        all.map((node) => node.getAttribute("data-ticket")!).toSorted((a, b) => a.localeCompare(b)),
      );
  const unblocked = () =>
    page
      .getByTestId("unblocks")
      .evaluateAll((all) =>
        all.map((node) => node.getAttribute("data-ticket")!).toSorted((a, b) => a.localeCompare(b)),
      );
  const cases = [
    { hash: "runs", shown: [alpha, beta], name: "All projects" },
    { hash: "runs?project=alpha", shown: [alpha], name: "alpha" },
    { hash: "runs?project=beta", shown: [beta], name: "beta" },
  ];
  for (const { hash, shown, name } of cases) {
    await open(page, baseUrl, hash);
    await expect(page.getByTestId("run-card").first()).toBeVisible();
    const count = shown.length;
    await expect(page.locator("main h1")).toContainText(`· ${name}`);
    await expect(page.locator("main h1")).toContainText(
      `${count} open · ${count} queued · ${count} closed`,
    );
    await expect(lane("Queued").getByTestId("run-card")).toHaveCount(count);
    await expect(lane("Building").getByTestId("run-card")).toHaveCount(count);
    await expect(lane("Closed").getByTestId("run-card")).toHaveCount(count);
    for (const button of ["Active", "Queued", "Old"])
      await expect(filter(button)).toHaveText(new RegExp(`${button}\\s*${count}`));
    // Active: the open tickets and the queued ones that wait on them.
    expect(await nodes()).toEqual(shown.flatMap((world) => world.ids.slice(0, 2)).toSorted());
    expect(await unblocked()).toEqual(shown.map((world) => world.ids[0]).toSorted());
    for (const world of shown)
      await expect(
        page.locator(`[data-testid="unblocks"][data-ticket="${world.ids[0]}"]`),
      ).toContainText(world.ids[1]);
  }
});

test("ARK-309-AC4 Roadmap shows every project in name order under its name with All projects, one project with a project, and a milestone, view or key acts in one section only", async ({
  page,
}) => {
  filterWorld();
  const baseUrl = await launch();
  const section = (project: string) => page.locator(`section[data-project="${project}"]`);
  const rows = (project: string) =>
    section(project)
      .getByTestId("ticket-row")
      .evaluateAll((all) => all.map((node) => node.getAttribute("data-ticket")));
  const selected = (project: string) =>
    section(project).locator('[data-testid="ticket-row"][aria-current="true"]');

  // All projects: both roadmaps in name order, each with its own vision, rail and rows.
  await open(page, baseUrl, "roadmap");
  await expect(page.getByTestId("ticket-row")).toHaveCount(4);
  expect(
    await page
      .locator("section[data-project]")
      .evaluateAll((all) => all.map((node) => node.getAttribute("data-project"))),
  ).toEqual(["alpha", "beta"]);
  expect(await page.locator("h2.rm-project").allTextContents()).toEqual(["alpha", "beta"]);
  for (const world of worlds) {
    await expect(section(world.project).getByTestId("roadmap-vision")).toHaveText(
      `${world.project} vision.`,
    );
    await expect(section(world.project).getByTestId("milestone-pick")).toHaveCount(2);
    expect(await rows(world.project)).toEqual(world.ids.slice(0, 2));
  }

  // Keys act on the section last touched: the first at the start, then the one clicked.
  await expect(selected("alpha")).toHaveAttribute("data-ticket", alpha.ids[0]);
  await page.keyboard.press("j");
  await expect(selected("alpha")).toHaveAttribute("data-ticket", alpha.ids[1]);
  await expect(selected("beta")).toHaveCount(0);
  await section("beta").getByTestId("roadmap-vision").click();
  await expect(selected("alpha")).toHaveCount(0);
  await expect(selected("beta")).toHaveAttribute("data-ticket", beta.ids[0]);
  await page.keyboard.press("j");
  await expect(selected("beta")).toHaveAttribute("data-ticket", beta.ids[1]);
  await section("alpha").getByTestId("roadmap-vision").click();
  await expect(selected("alpha")).toHaveAttribute("data-ticket", alpha.ids[1]);

  // The same milestone id in two sections: a click filters its own section.
  const pick = (project: string, id: string) =>
    section(project).locator(`[data-testid="milestone-pick"][data-milestone="${id}"]`);
  await pick("alpha", "M5").click();
  await expect(pick("alpha", "M5")).toHaveAttribute("aria-pressed", "true");
  await expect(pick("beta", "M5")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => rows("alpha")).toEqual([alpha.ids[1]]);
  expect(await rows("beta")).toEqual(beta.ids.slice(0, 2));
  // The List and Graph switch too.
  await section("beta").getByTestId("view-graph").click();
  await expect(section("beta").getByTestId("roadmap-graph")).toBeVisible();
  await expect(section("alpha").getByTestId("roadmap-graph")).toHaveCount(0);

  // One project: only its section, no project heading. The ARK-291 link still opens it.
  await page.reload(); // a section keeps its own state while the page stays open
  for (const world of worlds) {
    await open(page, baseUrl, `roadmap?project=${world.project}`);
    await expect(page.getByTestId("ticket-row")).toHaveCount(2);
    await expect(page.locator("section[data-project]")).toHaveCount(1);
    await expect(page.getByTestId("roadmap-vision")).toHaveText(`${world.project} vision.`);
    await expect(page.locator("h2.rm-project")).toHaveCount(0);
    expect(await rows(world.project)).toEqual(world.ids.slice(0, 2));
  }
});

test("ARK-309-AC4 a ticket opened from the second project's section returns to both sections with their milestone and the second one active, and / j k Enter keep acting there", async ({
  page,
}) => {
  filterWorld();
  const baseUrl = await launch();
  const section = (project: string) => page.locator(`section[data-project="${project}"]`);
  const pick = (project: string, id: string) =>
    section(project).locator(`[data-testid="milestone-pick"][data-milestone="${id}"]`);
  const rows = (project: string) =>
    section(project)
      .getByTestId("ticket-row")
      .evaluateAll((all) => all.map((node) => node.getAttribute("data-ticket")));
  const selected = (project: string) =>
    section(project).locator('[data-testid="ticket-row"][aria-current="true"]');

  // A milestone in each section; the last click makes beta the active one.
  await open(page, baseUrl, "roadmap");
  await pick("alpha", "M5").click();
  await pick("beta", "M4").click();
  await expect.poll(() => rows("alpha")).toEqual([alpha.ids[1]]);
  await expect.poll(() => rows("beta")).toEqual([beta.ids[0]]);
  await expect(selected("beta")).toHaveAttribute("data-ticket", beta.ids[0]);
  await section("beta").getByTestId("roadmap-vision").click(); // off the button: Enter on it is its own action
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/ticket/${beta.ids[0]}`));
  await expect(page.getByTestId("ticket-page")).toBeVisible();

  // Esc: both sections keep their milestone, the selected row is beta's, and the keys act in beta.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("roadmap-page").first()).toBeVisible();
  await expect(pick("alpha", "M5")).toHaveAttribute("aria-pressed", "true");
  await expect(pick("beta", "M4")).toHaveAttribute("aria-pressed", "true");
  expect(await rows("alpha")).toEqual([alpha.ids[1]]);
  expect(await rows("beta")).toEqual([beta.ids[0]]);
  await expect(selected("beta")).toHaveAttribute("data-ticket", beta.ids[0]);
  await expect(selected("alpha")).toHaveCount(0);
  await page.keyboard.press("/");
  await expect(section("beta").getByTestId("filter-text")).toBeFocused();
  await page.keyboard.press("Escape");
  await section("beta")
    .getByTestId("milestone-filter")
    .getByRole("button", { name: "Show all milestones" })
    .click();
  await expect.poll(() => rows("beta")).toEqual(beta.ids.slice(0, 2));
  await page.keyboard.press("j");
  await expect(selected("beta")).toHaveAttribute("data-ticket", beta.ids[1]);
  await page.keyboard.press("k");
  await expect(selected("beta")).toHaveAttribute("data-ticket", beta.ids[0]);
  await expect(selected("alpha")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/ticket/${beta.ids[0]}`));
});

test("ARK-309-AC4 the notes button of a later project's section scrolls to that section's notes", async ({
  page,
}) => {
  filterWorld(40, true);
  const baseUrl = await launch();
  await open(page, baseUrl, "roadmap");
  const notes = (project: string) =>
    page.locator(`section[data-project="${project}"]`).getByTestId("roadmap-notes");
  await expect(notes("beta")).toHaveCount(1);
  await expect(notes("beta")).not.toBeInViewport();
  await page.locator('section[data-project="beta"]').getByTestId("notes-link").click();
  await expect(notes("beta")).toBeInViewport();
  await expect(notes("alpha")).not.toBeInViewport();
});

test("ARK-309-AC5 a ticket and a run of another project open by direct link with their project, say Outside the filter with a link, keep the filter in the control, and Esc and the back links return with it", async ({
  page,
}) => {
  filterWorld(40);
  const baseUrl = await launch();
  const [ticket, run] = [`ticket/${beta.ids[0]}`, `run/${beta.run}`];
  const ready = (hash: string) =>
    hash.startsWith("ticket")
      ? expect(page.getByTestId("ticket-page")).toBeVisible()
      : expect(page.getByTestId("timeline")).toBeVisible();

  for (const hash of [ticket, run]) {
    // The filter is alpha, the page is beta's.
    await open(page, baseUrl, `${hash}?project=alpha`);
    await ready(hash);
    await expect(page.getByTestId("page-project")).toHaveText("Project beta");
    await expect(page.getByTestId("outside-filter")).toContainText("Outside the filter alpha");
    await expect(projectButton(page, "alpha")).toHaveAttribute("aria-pressed", "true");
    await expect(projectButton(page, "beta")).toHaveAttribute("aria-pressed", "false");
    // The note's link sets the filter to the page's project.
    await page.getByTestId("outside-filter").getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`#/${hash}\\?project=beta$`));
    await expect(page.getByTestId("outside-filter")).toHaveCount(0);
    await expect(projectButton(page, "beta")).toHaveAttribute("aria-pressed", "true");
    // No filter: the project shows, there is nothing to be outside of.
    await open(page, baseUrl, hash);
    await ready(hash);
    await expect(page.getByTestId("page-project")).toHaveText("Project beta");
    await expect(page.getByTestId("outside-filter")).toHaveCount(0);
    await expect(projectButton(page, "All projects")).toHaveAttribute("aria-pressed", "true");
  }

  // Back links and Esc keep the filter of the URL, never the page's project.
  await open(page, baseUrl, `${ticket}?project=alpha`);
  await ready(ticket);
  await page.getByRole("link", { name: "← Roadmap" }).click();
  await expect(page).toHaveURL(/#\/roadmap\?project=alpha$/);
  await open(page, baseUrl, `${ticket}?project=alpha`);
  await ready(ticket);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/roadmap\?project=alpha$/);
  await open(page, baseUrl, `${run}?project=alpha`);
  await ready(run);
  await page.getByRole("link", { name: "← Runs" }).click();
  await expect(page).toHaveURL(/#\/runs\?project=alpha$/);
  await expect(projectButton(page, "alpha")).toHaveAttribute("aria-pressed", "true");

  // From a ticket of the filter's project, Esc returns to the same scroll position.
  await open(page, baseUrl, "roadmap?project=alpha");
  await expect(page.getByTestId("stale-label")).toHaveCount(0); // the layout settles once every source has answered
  const item = page.locator('[data-testid="review-item"][data-ticket="ARK-939"]');
  await item.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(100);
  await item.click();
  await expect(page.getByTestId("ticket-page")).toBeVisible();
  await expect(page.getByTestId("outside-filter")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/roadmap\?project=alpha$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
});

test("ARK-309-AC6 #/backlog and #/map redirects keep their tail and their query, and #/backlog?project=<name> shows Roadmap, not Home", async ({
  page,
}) => {
  filterWorld();
  const baseUrl = await launch();
  const t1 = alpha.ids[0];
  const cases = [
    ["backlog?project=alpha", "roadmap?project=alpha"],
    ["backlog", "roadmap"],
    [`backlog/${t1}`, `roadmap/${t1}`],
    [`backlog/${t1}?project=alpha`, `roadmap/${t1}?project=alpha`],
    ["map?project=alpha", "runs?project=alpha"],
  ];
  for (const [from, to] of cases) {
    await open(page, baseUrl, from);
    await expect(page).toHaveURL(`${baseUrl}/#/${to}`);
  }
  await open(page, baseUrl, "backlog?project=alpha");
  await expect(page.getByTestId("roadmap-page")).toBeVisible();
  await expect(page.getByTestId("tile")).toHaveCount(0);
  await expect(projectButton(page, "alpha")).toHaveAttribute("aria-pressed", "true");
});

test("ARK-309-AC7 the Project group is named, has aria-pressed buttons set with Tab, Enter and Space with a visible focus ring, headings name the filter, the keys work and text keeps its contrast in light and dark", async ({
  page,
}) => {
  test.setTimeout(120_000);
  filterWorld();
  const baseUrl = await launch();
  await page.emulateMedia({ colorScheme: "light" });

  // Tab moves along the group, Enter and Space set the filter, and the focused button shows a ring.
  await open(page, baseUrl, "roadmap?project=alpha");
  await expect(page.getByTestId("ticket-row").first()).toBeVisible();
  await projectButton(page, "All projects").focus();
  await page.keyboard.press("Tab");
  await expect(projectButton(page, "alpha")).toBeFocused();
  const ring = await projectButton(page, "alpha").evaluate((node) => {
    const style = getComputedStyle(node);
    return (
      (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
      style.boxShadow !== "none"
    );
  });
  expect(ring, "focus ring on the focused button").toBe(true);
  await page.keyboard.press("Tab");
  await expect(projectButton(page, "beta")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/roadmap\?project=beta$/);
  await expect(projectButton(page, "beta")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/#\/roadmap\?project=alpha$/);
  await expect(projectButton(page, "alpha")).toHaveAttribute("aria-pressed", "true");
  await expect(projectButton(page, "beta")).toHaveAttribute("aria-pressed", "false");

  // Keys of ARK-285 and ARK-291 with the filter on: j k / Enter Esc.
  await page.locator("main").click({ position: { x: 2, y: 2 } });
  const selected = page.locator('[data-testid="ticket-row"][aria-current="true"]');
  await expect(selected).toHaveAttribute("data-ticket", alpha.ids[0]);
  await page.keyboard.press("j");
  await expect(selected).toHaveAttribute("data-ticket", alpha.ids[1]);
  await page.keyboard.press("k");
  await expect(selected).toHaveAttribute("data-ticket", alpha.ids[0]);
  await page.keyboard.press("/");
  await expect(page.getByTestId("filter-text")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("filter-text")).not.toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/ticket/${alpha.ids[0]}\\?project=alpha$`));
  await expect(page.getByTestId("ticket-page")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/roadmap\?project=alpha$/);

  // Each list view names the filter; text keeps 4.5:1 (3:1 large) with a filter on, in both themes.
  const theme = (name: string) =>
    page.getByRole("group", { name: "Theme" }).getByRole("button", { name });
  const views: [string, string, () => Promise<unknown>][] = [
    ["", "Home · alpha", () => expect(page.getByTestId("run")).toHaveCount(1)],
    ["runs", "Runs · alpha", () => expect(page.getByTestId("run-card").first()).toBeVisible()],
    [
      "roadmap",
      "Roadmap · alpha",
      () => expect(page.getByTestId("ticket-row").first()).toBeVisible(),
    ],
  ];
  for (const choice of ["Light", "Dark"]) {
    for (const [hash, heading, ready] of views) {
      await open(page, baseUrl, `${hash}?project=alpha`);
      await theme(choice).click();
      await expect(theme(choice)).toHaveAttribute("aria-pressed", "true");
      await ready();
      await expect(page.locator("main h1")).toContainText(heading);
      await expect(page.getByRole("group", { name: "Project" })).toBeVisible();
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((fade) => fade.finished.catch(() => undefined))),
      );
      const { checked, weak } = await weakContrast(page);
      expect(checked, `text checked on ${heading} in ${choice}`).toBeGreaterThan(15);
      expect(weak, `${heading} in ${choice}`).toEqual([]);
    }
  }
});

test("ARK-309-AC8 a filter change on Home, Runs and Roadmap sends no request, and / and /nope answer with a p95 under 200 ms", async ({
  page,
}) => {
  filterWorld();
  const baseUrl = await launch();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const views: [string, () => Promise<unknown>][] = [
    ["", () => expect(page.getByTestId("run")).toHaveCount(2)],
    ["runs", () => expect(page.getByTestId("run-card").first()).toBeVisible()],
    ["roadmap", () => expect(page.getByTestId("ticket-row").first()).toBeVisible()],
  ];
  for (const [hash, ready] of views) {
    await open(page, baseUrl, hash);
    await ready();
    await expect(page.getByTestId("stale-label")).toHaveCount(0); // the first load is complete
    requests.length = 0;
    for (const name of ["alpha", "beta", "All projects"]) {
      await projectButton(page, name).click();
      await expect(projectButton(page, name)).toHaveAttribute("aria-pressed", "true");
    }
    await page.waitForTimeout(1000);
    expect(requests, `requests after a filter change on /${hash}`).toEqual([]);
  }

  for (const route of ["/", "/nope"]) {
    const durations: number[] = [];
    for (let request = 0; request < 50; request++) {
      const startedAt = performance.now();
      await (await fetch(`${baseUrl}${route}`)).arrayBuffer();
      durations.push(performance.now() - startedAt);
    }
    expect(percentile95(durations), `p95 of ${route}`).toBeLessThan(200);
  }
});

// ---------------------------------------------------------------- ARK-293

/**
 * One open run of 4 step agents (a model from Orca, a model from a session, no model and no
 * session, and state `done`) and Master Chief, who Orca lists twice: as a terminal and in `ps`.
 */
function agentStateWorld() {
  const { sessions } = isolate();
  const started = ago(3600);
  const run = runId("ARK-293");
  const names = ["from-orca", "from-session", "no-model", "finished"];
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-293", title: "True agent state" },
    phase: "building",
    startedAt: started,
    steps: names.map((id, number) => ({
      id,
      role: "implementer",
      harness: "omp",
      model: `plan/${id}`,
      needs: [],
      startedAfter: 100 + number * 600,
      finishedAfter: 600 + number * 600,
    })),
  });
  writeOmpSession(
    sessions,
    "from-session",
    join(directory, "workspace"),
    [
      { time: ago(500), costUsd: 0.01, model: "session/model-first" },
      { time: ago(400), costUsd: 0.01, model: "session/model-last" },
    ],
    new Date(started.getTime() + (100 + 600 + 10) * 1000),
  );
  const answers = orcaAnswersFor(run);
  const worker = (name: string, model?: string) => ({
    taskId: `task-${name}`,
    state: "running",
    agentTerminalHandle: `term-${name}`,
    ...(model ? { projection: { provider: { model } } } : {}),
  });
  installFakeTools({
    orca: {
      terminals: [
        { handle: "term-lead", connected: true, agentIdentity: "omp", model: "lead/model" },
        { handle: "term-chief", connected: true, agentIdentity: "omp", model: "chief/model" },
        ...names
          .filter((name) => name !== "no-model")
          .map((name) => ({ handle: `term-${name}`, connected: true, agentIdentity: "omp" })),
        { handle: "term-no-model", connected: true },
      ],
      runs: [
        ...answers.runs!,
        {
          id: "orca-chief",
          objective: "Master Chief: p tickets",
          coordinator_handle: "term-chief",
        },
      ],
      workers: [
        worker("from-orca", "orca/model-reported"),
        worker("from-session"),
        worker("no-model"),
        worker("finished", "orca/model-finished"),
      ],
      tasks: names.map((name) => ({ id: `task-${name}`, title: `${name} (implementer, .)` })),
      worktrees: [
        {
          path: join(directory, "workspace"),
          agents: [
            ...names.map((name) => ({
              taskTitle: `${name} (implementer, .)`,
              state: name === "finished" ? "done" : "working",
              toolName: "bash",
              updatedAt: name === "finished" ? Date.now() - 3_600_000 : Date.now(),
            })),
            { taskTitle: "Master Chief: p tickets", state: "working", updatedAt: Date.now() },
          ],
        },
      ],
    },
  });
  return { run };
}

const agentRow = (page: Page, step: string) =>
  page.locator('[data-testid="agent"]', { has: page.locator(`.mono >> text="${step}"`) });

test("ARK-293-AC3 a run page row shows the model of Orca or of the session without a label, done for a done agent, the plan model (planned) for the rest, and Master Chief once", async ({
  page,
}) => {
  const { run } = agentStateWorld();
  const baseUrl = await launch();

  await open(page, baseUrl, "");
  await expect(page.getByTestId("run")).toHaveCount(1);
  await expect(page.getByText("Master Chief")).toHaveCount(1);

  await open(page, baseUrl, `run/${run}`);
  const activity = (step: string) => agentRow(page, step).getByTestId("agent-activity");
  const unlabelled = async (step: string, model: string, kind: string, text: string) => {
    const row = agentRow(page, step);
    await expect(row).toContainText(model);
    await expect(row).not.toContainText("(planned)");
    await expect(row).not.toContainText("(configured)");
    await expect(activity(step)).toHaveAttribute("data-kind", kind);
    await expect(activity(step)).toHaveText(`· ${text}`);
  };
  // The session model reads from the file the cost holds: it appears with the first parse.
  await unlabelled("from-session", "session/model-last", "working", "working");
  await unlabelled("from-orca", "orca/model-reported", "working", "working");
  await unlabelled("finished", "orca/model-finished", "done", "done");
  await expect(agentRow(page, "from-session")).not.toContainText("session/model-first");

  const bare = agentRow(page, "no-model");
  await expect(bare).toContainText("omp (planned)");
  await expect(bare).toContainText("plan/no-model (planned)");

  // The run lead and Master Chief have Orca models: no label anywhere but the one planned row.
  await expect(page.getByText("(configured)")).toHaveCount(0);
  await expect(page.getByText("(planned)")).toHaveCount(2);
  await expect(page.locator('[data-testid="agent"][data-role="Master Chief"]')).toHaveCount(1);
  await expect(page.getByTestId("agent")).toHaveCount(6);
});

test("ARK-293-AC5 with session models on the run page, / and /nope answer with a p95 under 200 ms and the page sends no request but the ones ARK-285 allows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { run } = agentStateWorld();
  const baseUrl = await launch();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));

  await open(page, baseUrl, "");
  await expect(page.getByTestId("run")).toHaveCount(1);
  await expect(page.getByTestId("stale-label")).toHaveCount(0);
  for (const path of requests.splice(0))
    expect(path === "/" || path === "/events" || path.startsWith("/assets/"), path).toBe(true);

  // The run page reads its own run (`/api/run`, ARK-284) and nothing for the session models.
  await open(page, baseUrl, `run/${run}`);
  await expect(agentRow(page, "from-session")).toContainText("session/model-last");
  await page.waitForTimeout(2000);
  const extra = requests.filter(
    (path) => path !== "/" && path !== "/events" && !path.startsWith("/assets/"),
  );
  for (const path of extra) expect(path.startsWith("/api/run/"), path).toBe(true);

  for (const route of ["/", "/nope"]) {
    const durations: number[] = [];
    for (let request = 0; request < 50; request++) {
      const startedAt = performance.now();
      await (await fetch(`${baseUrl}${route}`)).arrayBuffer();
      durations.push(performance.now() - startedAt);
    }
    expect(percentile95(durations), `p95 of ${route}`).toBeLessThan(200);
  }
});

// ---------------------------------------------------------------- ARK-310

/**
 * An open run in planning with an evaluator and a designer in Orca. The evaluator session ends at
 * `evaluation.recorded` plus its closing message to the run lead and a helper call (`purpose`
 * job-caption); the designer session runs after it, up to `strategy.recorded`. Both ran
 * another model than `roles.chief`. Orca reports no model for either terminal; Master Chief's
 * terminal reports one.
 */
function stageModelWorld(options: { designerSession: boolean }) {
  const { sessions } = isolate();
  writeProject("p", {
    workspace: tempDirectory("ark-workspace-"),
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "m" },
      validator: { harness: "omp", model: "m" },
      reviewer: { harness: "omp", model: "m" },
      chief: { harness: "claude", model: "claude-opus" },
      evaluator: { harness: "codex", model: "evaluator-configured" },
      designer: { harness: "codex", model: "designer-configured" },
    },
  });
  const startedAt = ago(3600);
  const run = runId("ARK-310");
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-310", title: "Stage models" },
    phase: "planning",
    startedAt,
  });
  appendRawEvent(directory, "strategy.recorded", { count: 1, recommended: "S1", cards: ["S1"] }, 4);
  const after = (seconds: number) => new Date(startedAt.getTime() + seconds * 1000);
  const workspacePath = join(directory, "workspace");
  writeOmpSession(
    sessions,
    "evaluator",
    workspacePath,
    [
      { time: after(2), costUsd: 0.01, model: "session/evaluator-first" },
      { time: after(6), costUsd: 0.01, model: "session/evaluator-last" },
      // The closing report lands after `evaluation.recorded` (at 10 s), then an omp helper call.
      { time: after(12), costUsd: 0.01, model: "session/evaluator-last" },
      { time: after(13), costUsd: 0.01, model: "session/helper-model", purpose: "job-caption" },
    ],
    after(1),
  );
  if (options.designerSession)
    writeOmpSession(
      sessions,
      "designer",
      workspacePath,
      [
        { time: after(20), costUsd: 0.01, model: "session/designer-first" },
        { time: after(25), costUsd: 0.01, model: "session/designer-last" },
        { time: after(26), costUsd: 0.01, model: "session/helper-model", purpose: "job-widget" },
      ],
      after(19),
    );
  // The designer started after evaluation.recorded (10 s) and ended inside the evaluator's grace
  // interval (to 70 s): a session that starts after the boundary is never the evaluator.
  const worker = (stage: string) => ({
    taskId: `task-${stage}`,
    state: "running",
    agentTerminalHandle: `term-${stage}`,
  });
  const answers = orcaAnswersFor(run);
  installFakeTools({
    orca: {
      terminals: [
        { handle: "term-lead", connected: true, agentIdentity: "omp", model: "lead/model" },
        { handle: "term-chief", connected: true, agentIdentity: "omp", model: "chief/model" },
        { handle: "term-evaluator", connected: true, agentIdentity: "omp" },
        { handle: "term-designer", connected: true, agentIdentity: "omp" },
      ],
      runs: [
        ...answers.runs!,
        {
          id: "orca-chief",
          objective: "Master Chief: p tickets",
          coordinator_handle: "term-chief",
        },
      ],
      workers: [worker("evaluator"), worker("designer")],
      tasks: ["evaluator", "designer"].map((stage) => ({
        id: `task-${stage}`,
        title: `${stage} (${run})`,
      })),
    },
  });
  return { run };
}

const roleRow = (page: Page, role: string) =>
  page.locator(`[data-testid="agent"][data-role="${role}"]`);

test("ARK-310-AC4 the evaluator and designer rows show the model their session ran, not the plan or configured model, and Master Chief keeps the Orca model", async ({
  page,
}) => {
  const { run } = stageModelWorld({ designerSession: true });
  const baseUrl = await launch();
  await open(page, baseUrl, `run/${run}`);

  await expect(roleRow(page, "evaluator")).toContainText("session/evaluator-last");
  await expect(roleRow(page, "designer")).toContainText("session/designer-last");
  await expect(roleRow(page, "Master Chief")).toContainText("chief/model");
  for (const role of ["evaluator", "designer"]) {
    await expect(roleRow(page, role)).not.toContainText("claude-opus");
    await expect(roleRow(page, role)).not.toContainText("(configured)");
    await expect(roleRow(page, role)).not.toContainText("(planned)");
  }
  await expect(roleRow(page, "evaluator")).not.toContainText("session/evaluator-first");
  for (const role of ["evaluator", "designer"])
    await expect(roleRow(page, role)).not.toContainText("session/helper-model");
});

test("ARK-310-AC4 a designer row with no session model keeps the configured model, labelled", async ({
  page,
}) => {
  const { run } = stageModelWorld({ designerSession: false });
  const baseUrl = await launch();
  await open(page, baseUrl, `run/${run}`);

  await expect(roleRow(page, "designer")).toContainText("designer-configured (configured)");
  await expect(roleRow(page, "designer")).not.toContainText("claude-opus");
  await expect(roleRow(page, "evaluator")).toContainText("session/evaluator-last");
});

// ---------------------------------------------------------------- ARK-314

/** A real PNG (solid grey) that the image route accepts and the browser decodes. */
function pngBytes(width = 64, height = 40): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rowLength = width * 3 + 1;
  const rows = Buffer.alloc(rowLength * height, 0x99);
  for (let row = 0; row < height; row++) rows[row * rowLength] = 0; // filter: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type CaseSide = {
  status: "pass" | "fail";
  sha: string;
  command?: string;
  output?: string;
  exit?: number;
};
type PlanCase = { id: string; action: string; level: string; base?: CaseSide; head?: CaseSide };

/** The plan's `test_cases`, the `ticket.md` criteria and `results/evidence/<case>/<side>/` of a run folder. */
function writeRunEvidence(
  directory: string,
  ticket: string,
  cases: PlanCase[],
  criteria: { id: string; method: string }[] = [],
  withResults = true,
): void {
  writeFileSync(
    join(directory, "plan.yml"),
    JSON.stringify({
      steps: [],
      test_cases: cases.map(({ id, action, level }) => ({ id, action, level })),
    }),
  );
  writeFileSync(
    join(directory, "ticket.md"),
    `---\n${JSON.stringify({
      id: ticket,
      title: "Evidence",
      acceptance_criteria: criteria.map((criterion) => ({
        ...criterion,
        text: `${criterion.id} text`,
        verified_by: [],
      })),
    })}\n---\n`,
  );
  if (!withResults) return;
  for (const { id, base, head } of cases)
    for (const [name, side] of [
      ["base", base],
      ["head", head],
    ] as const) {
      if (!side) continue;
      const folder = join(directory, "results", "evidence", id, name);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "result.json"),
        JSON.stringify({ id, name: `${id} case`, status: side.status, sha: side.sha }),
      );
      if (side.command)
        writeFileSync(
          join(folder, "command.log"),
          `${side.command}\n${side.output}\nexit ${side.exit}\n`,
        );
    }
}

/** Writes `results/evidence/<path>` of a run folder; a Buffer or text. */
function writeEvidenceFile(directory: string, path: string, content: string | Buffer): void {
  const file = join(directory, "results", "evidence", path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Screenshots of one UI case: `login` on both sides, `list` on head only, `detail` on base only. */
function writeShots(directory: string, id: string): void {
  for (const path of ["base/login", "head/login", "head/list", "base/detail"])
    writeEvidenceFile(
      directory,
      `${id}/${path.split("/")[0]}/screenshots/${path.split("/")[1]}.png`,
      pngBytes(),
    );
}

const planOfT29: PlanCase[] = [
  {
    id: "ARK-T1",
    action: "add",
    level: "integration",
    base: {
      status: "fail",
      sha: "9b85039",
      command: "bun test test/a.test.ts",
      output: "1 fail",
      exit: 1,
    },
    head: {
      status: "pass",
      sha: "1a2b3c4",
      command: "bun test test/a.test.ts",
      output: "1 pass",
      exit: 0,
    },
  },
  {
    id: "ARK-T2",
    action: "update",
    level: "e2e",
    base: { status: "pass", sha: "9b85039" },
    head: { status: "pass", sha: "1a2b3c4" },
  },
  {
    id: "ARK-T3",
    action: "reuse",
    level: "unit",
    base: {
      status: "pass",
      sha: "9b85039",
      command: "bun test test/a.test.ts",
      output: "1 fail",
      exit: 1,
    },
    head: {
      status: "pass",
      sha: "1a2b3c4",
      command: "bun test test/a.test.ts",
      output: "1 pass",
      exit: 0,
    },
  },
  { id: "ARK-T4", action: "retire", level: "integration" },
  { id: "ARK-T5", action: "add", level: "e2e", head: { status: "fail", sha: "1a2b3c4" } },
];

/** Project `p` with local cases ARK-T1 (integration), ARK-T2 (unit), ARK-T3 (e2e, retired) and tickets ARK-900 to ARK-902. */
function ticketWorld(): void {
  isolate();
  installFakeTools({});
  const repository = tempDirectory("ark-cases-");
  const fields = { technique: "boundary values", priority: "high", risk: "a defect" };
  commitCase(repository, "ARK-T1", {
    title: "ARK-T1 first",
    level: "integration",
    status: "active",
    changed_by: "2026-01-01-ARK-1-1",
    ...fields,
  });
  commitCase(repository, "ARK-T2", {
    title: "ARK-T2 second",
    level: "unit",
    status: "active",
    changed_by: "2026-01-01-ARK-1-1",
    ...fields,
  });
  commitCase(repository, "ARK-T3", {
    title: "ARK-T3 third",
    level: "e2e",
    status: "retired",
    retired_reason: "replaced by ARK-T1",
    changed_by: "2026-01-01-ARK-1-1",
    ...fields,
  });
  writeProject("p", { workspace: repository, ticket_source: "local", test_case_source: "local" });
  const ticket = (id: string, criteria: [string, string, string[]][]) =>
    writeBacklogTicket({
      project: "p",
      id,
      title: `Title of ${id}`,
      status: "ready",
      problem: "A problem in words.",
      change: "A change in words.",
      criteria: criteria.map(([ac, method, verifiedBy]) => ({
        id: ac,
        text: `${ac} text`,
        method,
        verifiedBy,
      })),
    });
  ticket("ARK-900", [
    ["AC1", "test", ["ARK-T1"]],
    ["AC2", "demonstration", []],
    ["AC3", "inspection", ["ARK-T1", "ARK-T3", "ARK-T99"]],
    ["AC4", "analysis", []],
  ]);
  ticket("ARK-901", [["AC1", "test", ["ARK-T1"]]]);
  ticket("ARK-902", [
    ["AC1", "test", ["ARK-T2"]],
    ["AC2", "test", []],
    ["AC3", "test", ["ARK-T1"]],
  ]);
}

const criterionOf = (page: Page, id: string) =>
  page.locator(`[data-testid="ticket-criterion"][data-id="${id}"]`);

test("ARK-T28 ticket page shows method, case links and the no-integration warning", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  ticketWorld();
  const baseUrl = await launch();

  await open(page, baseUrl, "ticket/ARK-900");
  await expect(criterionOf(page, "AC1").getByTestId("case-link")).toBeVisible();
  await checkpoint(page, "ticket-criteria");
  const criteria = page.getByTestId("ticket-criterion");
  await expect(criteria).toHaveCount(4);
  for (const [id, method] of [
    ["AC1", "test"],
    ["AC2", "demonstration"],
    ["AC3", "inspection"],
    ["AC4", "analysis"],
  ])
    await expect(criterionOf(page, id).getByTestId("criterion-method")).toHaveText(
      `method: ${method}`,
    );
  for (const id of ["AC1", "AC2", "AC3", "AC4"])
    await expect(criterionOf(page, id).locator(".crit-head .mono")).toHaveText(id);

  const first = criterionOf(page, "AC1").getByTestId("case-link");
  await expect(first).toHaveCount(1);
  for (const word of ["ARK-T1", "integration", "active"]) await expect(first).toContainText(word);

  const entries = criterionOf(page, "AC3").getByTestId("case-entry");
  await expect(entries).toHaveCount(3);
  expect(
    await entries.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id"))),
  ).toEqual(["ARK-T1", "ARK-T3", "ARK-T99"]);
  const links = criterionOf(page, "AC3").getByTestId("case-link");
  await expect(links).toHaveCount(2);
  for (const [index, words] of [
    ["ARK-T1", "integration", "active"],
    ["ARK-T3", "e2e", "retired"],
  ].entries()) {
    for (const word of words) await expect(links.nth(index)).toContainText(word);
    expect(await links.nth(index).getAttribute("href")).toMatch(/\S/);
  }
  const absent = entries.nth(2);
  await expect(absent.getByTestId("case-missing")).toContainText("ARK-T99");
  await expect(absent).toContainText("missing");
  await expect(absent.locator("a")).toHaveCount(0);

  for (const id of ["AC2", "AC4"]) {
    await expect(criterionOf(page, id).getByTestId("case-entry")).toHaveCount(0);
    await expect(criterionOf(page, id).locator("a")).toHaveCount(0);
  }
  await expect(page.getByTestId("criterion-warning")).toHaveCount(0);

  await open(page, baseUrl, "ticket/ARK-902");
  await expect(criterionOf(page, "AC1").getByTestId("case-link")).toBeVisible();
  const warning = (id: string) => criterionOf(page, id).getByTestId("criterion-warning");
  for (const id of ["AC1", "AC2"]) {
    await expect(warning(id)).toBeVisible();
    await expect(warning(id)).toBeInViewport();
    await expect(warning(id)).toContainText("No integration or E2E case");
    await expect(warning(id)).toContainText("method: test");
  }
  await expect(warning("AC3")).toHaveCount(0);
  await expect(page.getByTestId("criterion-warning")).toHaveCount(2);

  await open(page, baseUrl, "ticket/ARK-900");
  await criterionOf(page, "AC1").getByTestId("case-link").click();
  const listing = criterionOf(page, "AC1").getByTestId("case-listing");
  await expect(listing).toBeVisible();
  await checkpoint(page, "ticket-shared-case");
  const refs = listing.getByTestId("case-listing-ref");
  await expect(refs).toHaveCount(4);
  expect((await refs.allTextContents()).sort()).toEqual([
    "ARK-900 AC1",
    "ARK-900 AC3",
    "ARK-901 AC1",
    "ARK-902 AC3",
  ]);
  for (const ticket of ["ARK-900", "ARK-901", "ARK-902"])
    expect(await refs.getByRole("link", { name: ticket }).first().getAttribute("href")).toMatch(
      new RegExp(`#/ticket/${ticket}$`),
    );

  await refs.getByRole("link", { name: "ARK-901" }).click();
  await expect(page).toHaveURL(/#\/ticket\/ARK-901$/);
  await expect(page.getByTestId("ticket-criterion")).toHaveCount(1);
  await expect(criterionOf(page, "AC1")).toContainText("AC1 text");
  await expect(page.locator("main h1")).toContainText("Title of ARK-901");
});

/** A run of ARK-900 in project `p` with the T29 plan: `merge_requests_open`, evidence on disk unless told otherwise. */
function evidenceRun(number = 1, withResults = true): string {
  const run = runId("ARK-900", number);
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-900", title: "Evidence" },
    phase: "merge_requests_open",
  });
  writeRunEvidence(directory, "ARK-900", planOfT29, [], withResults);
  return run;
}

test("ARK-T29 run page shows a test evidence panel row for each plan case", async ({ page }) => {
  isolate();
  installFakeTools({});
  writeProject("p", { workspace: tempDirectory("ark-ws-"), ticket_source: "local" });
  writeBacklogTicket({
    project: "p",
    id: "ARK-900",
    title: "Evidence",
    status: "ready",
    criteria: [
      { id: "AC1", text: "one", method: "test", verifiedBy: ["ARK-T1"] },
      { id: "AC2", text: "two", method: "test", verifiedBy: ["ARK-T1", "ARK-T2"] },
    ],
  });
  const run = evidenceRun();
  const bare = evidenceRun(2, false);
  const baseUrl = await launch();

  await open(page, baseUrl, `run/${run}`);
  const rows = page.getByTestId("evidence-case");
  await expect(rows).toHaveCount(5);
  await checkpoint(page, "evidence-panel");
  expect(
    await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id"))),
  ).toEqual(["ARK-T1", "ARK-T2", "ARK-T3", "ARK-T4", "ARK-T5"]);
  const rowOf = (id: string) => page.locator(`[data-testid="evidence-case"][data-id="${id}"]`);
  const side = (id: string, name: "base" | "head") =>
    rowOf(id).locator(`[data-testid="evidence-side"][data-side="${name}"]`);

  const t1 = rowOf("ARK-T1");
  await expect(t1.locator("td").nth(1)).toHaveText("add");
  await expect(t1.locator("td").nth(2)).toHaveText("integration");
  await expect(side("ARK-T1", "base")).toContainText("fail");
  await expect(side("ARK-T1", "base")).toContainText("9b85039");
  await expect(side("ARK-T1", "head")).toContainText("pass");
  await expect(side("ARK-T1", "head")).toContainText("1a2b3c4");

  // The suite log is one closed, labelled disclosure; T3 ran in the same suite, so its row repeats nothing.
  const log = page.getByTestId("evidence-log");
  await expect(log).toHaveCount(1);
  await expect(log).not.toHaveAttribute("open", "");
  await expect(log.locator("summary")).toContainText("Suite output");
  await expect(t1.getByTestId("evidence-log")).toHaveCount(1);
  await expect(rowOf("ARK-T3").getByTestId("evidence-log")).toHaveCount(0);
  await expect(side("ARK-T3", "head")).toContainText("pass");
  await log.locator("summary").click();
  const logs = t1.locator(".ev-run");
  await expect(logs).toHaveCount(2);
  for (const [index, output, exit] of [
    [0, "1 fail", "exit 1"],
    [1, "1 pass", "exit 0"],
  ] as const) {
    await expect(logs.nth(index)).toContainText("bun test test/a.test.ts");
    await expect(logs.nth(index)).toContainText(output);
    await expect(logs.nth(index)).toContainText(exit);
  }
  await expect(logs.nth(0)).not.toContainText("1 pass");

  for (const [id, action, level] of [
    ["ARK-T2", "update", "e2e"],
    ["ARK-T3", "reuse", "unit"],
    ["ARK-T4", "retire", "integration"],
  ]) {
    await expect(rowOf(id).locator("td").nth(1)).toHaveText(action);
    await expect(rowOf(id).locator("td").nth(2)).toHaveText(level);
  }
  for (const name of ["base", "head"] as const)
    await expect(side("ARK-T4", name)).toHaveText(/^not run/);
  await expect(side("ARK-T5", "base")).toHaveText(/^not run/);
  await expect(side("ARK-T5", "head")).toHaveText(/^fail/);

  await expect(t1.getByRole("link", { name: "AC1", exact: true })).toHaveAttribute(
    "href",
    /#\/ticket\/ARK-900$/,
  );
  await expect(t1.getByRole("link", { name: "AC2", exact: true })).toHaveAttribute(
    "href",
    /#\/ticket\/ARK-900$/,
  );
  await expect(rowOf("ARK-T2").getByRole("link", { name: "AC2", exact: true })).toBeVisible();
  await expect(rowOf("ARK-T3").locator("a")).toHaveCount(0);

  await open(page, baseUrl, `run/${bare}`);
  await expect(rows).toHaveCount(5);
  await expect(page.locator('[data-testid="evidence-side"]')).toHaveCount(10);
  await expect(page.locator('[data-testid="evidence-side"][data-result="not run"]')).toHaveCount(
    10,
  );
  await expect(page.locator('[data-testid="evidence-side"]', { hasText: "pass" })).toHaveCount(0);
});

test("ARK-T20 screenshot pairs, missing sides and image route refusals", async ({ page }) => {
  isolate();
  installFakeTools({});
  writeProject("p", { workspace: tempDirectory("ark-ws-"), ticket_source: "local" });
  const run = runId("ARK-900");
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-900", title: "Shots" },
    phase: "merge_requests_open",
  });
  writeRunEvidence(directory, "ARK-900", [
    {
      id: "ARK-T7",
      action: "add",
      level: "e2e",
      base: { status: "fail", sha: "9b85039" },
      head: { status: "pass", sha: "1a2b3c4" },
    },
  ]);
  writeShots(directory, "ARK-T7");
  const screenshots = "results/evidence/ARK-T7/head/screenshots";
  const outside = join(tempDirectory("ark-outside-"), "outside.png");
  writeFileSync(outside, pngBytes());
  symlinkSync(outside, join(directory, screenshots, "escape.png"));
  writeFileSync(join(directory, screenshots, "notes.txt"), "NOTES-SECRET");
  writeFileSync(join(directory, "state.json"), '{"STATE-SECRET":true}');
  const baseUrl = await launch();

  const notFound: string[] = [];
  page.on("response", (response) => {
    if (response.status() === 404) notFound.push(response.url());
  });
  await open(page, baseUrl, `run/${run}`);
  await expect(page.getByTestId("shot-pair")).toHaveCount(3);
  await expect(page.getByTestId("shot-image").first()).toBeVisible();
  await checkpoint(page, "screenshot-pairs");
  const pairOf = (name: string) => page.locator(`[data-testid="shot-pair"][data-name="${name}"]`);
  expect((await page.locator('[data-testid="shot-pair"] h4').allTextContents()).sort()).toEqual([
    "detail",
    "list",
    "login",
  ]);

  const login = pairOf("login");
  const before = login.locator('[data-testid="shot-image"][data-side="before"]');
  const after = login.locator('[data-testid="shot-image"][data-side="after"]');
  await expect(login.getByTestId("shot-image")).toHaveCount(2);
  const [left, right] = [await before.boundingBox(), await after.boundingBox()];
  expect(left!.x).toBeLessThan(right!.x);
  expect(Math.abs(left!.y - right!.y)).toBeLessThan(4);
  await expect(before).toHaveAttribute("alt", "ARK-T7 login before");
  await expect(after).toHaveAttribute("alt", "ARK-T7 login after");

  await expect(pairOf("list").getByTestId("shot-missing")).toHaveText("no before screenshot");
  await expect(pairOf("list").locator('img[data-side="before"]')).toHaveCount(0);
  await expect(pairOf("list").locator('img[data-side="after"]')).toHaveAttribute(
    "alt",
    "ARK-T7 list after",
  );
  await expect(pairOf("detail").getByTestId("shot-missing")).toHaveText("no after screenshot");
  await expect(pairOf("detail").locator('img[data-side="after"]')).toHaveCount(0);

  await expect
    .poll(() =>
      page
        .locator("img")
        .evaluateAll(
          (images: HTMLImageElement[]) =>
            images.length === 4 &&
            images.every((image) => image.complete && image.naturalWidth > 0),
        ),
    )
    .toBe(true);
  expect(notFound).toEqual([]);

  const source = (await after.getAttribute("src"))!;
  const served = await page.request.get(`${baseUrl}${source}`);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/png");
  expect(served.headers()["x-content-type-options"]).toBe("nosniff");

  const imagePath = (path: string) => `/api/run/${run}/image?path=${path}`;
  for (const [path, secret] of [
    [`${screenshots}/../../../../state.json`, "STATE-SECRET"],
    [`${screenshots}/escape.png`, "PNG"],
    [`${screenshots}/notes.txt`, "NOTES-SECRET"],
  ]) {
    const refused = await rawGet(baseUrl, imagePath(path));
    expect(refused.status, path).toBe(404);
    expect(refused.body, path).not.toContain(secret);
  }
  expect((await page.request.post(`${baseUrl}${source}`)).status()).not.toBe(200);
});

const hostile = "<b>bold</b> <script>window.__pwned = 1</script>";

/** The five evidence files of T21: AC1 demonstration, AC2 inspection, AC3 analysis, AC4 none, AC5 wrong shape. */
function writeAcEvidence(directory: string, withImages: boolean): void {
  if (withImages) {
    writeEvidenceFile(directory, "AC1-before.png", pngBytes());
    writeEvidenceFile(directory, "AC1-after.png", pngBytes());
  }
  writeEvidenceFile(
    directory,
    "AC1.md",
    [
      "## What the human did",
      "",
      `opened the run page ${hostile}`,
      "",
      "## What the human saw",
      "",
      "five rows",
      "",
      "## Before",
      "",
      "AC1-before.png",
      "",
      "## After",
      "",
      "AC1-after.png",
      "",
      "human: ok",
      "",
    ].join("\n"),
  );
  writeEvidenceFile(
    directory,
    "AC2.md",
    [
      "## Files",
      "",
      "- hub/server.ts:120-150",
      "",
      "## Checked against",
      "",
      `ADR 0009 ${hostile}`,
      "",
      "## Verdict",
      "",
      "The route agrees.",
      "",
      "reviewer: pass",
      "",
    ].join("\n"),
  );
  const pair = (base: string, head: string) => `### Base\n\n${base}\n\n### Head\n\n${head}\n`;
  writeEvidenceFile(
    directory,
    "AC3.md",
    [
      `## Command\n\n${pair("bun test --base", "bun test --head")}`,
      `## Output\n\n${pair("40 pass 2 fail", `42 pass 0 fail ${hostile}`)}`,
      `## Threshold\n\n${pair("fail <= 0 (base)", "fail <= 0 (head)")}`,
      `## Result\n\n${pair("threshold missed", "threshold met")}`,
    ].join("\n"),
  );
  writeEvidenceFile(
    directory,
    "AC5.md",
    "## Files\n\n- hub/server.ts:1-2\n\n## Checked against\n\nPARTIAL-INSPECTION-TEXT\n",
  );
}

const nonTestCriteria = [
  { id: "AC1", method: "demonstration" },
  { id: "AC2", method: "inspection" },
  { id: "AC3", method: "analysis" },
  { id: "AC4", method: "demonstration" },
  { id: "AC5", method: "inspection" },
];

test("ARK-T21 run page shows non-test AC evidence in its shape or no evidence", async ({
  page,
}) => {
  isolate();
  installFakeTools({});
  writeProject("p", { workspace: tempDirectory("ark-ws-"), ticket_source: "local" });
  const run = runId("ARK-900");
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-900", title: "Files" },
    phase: "merge_requests_open",
  });
  writeRunEvidence(directory, "ARK-900", [], nonTestCriteria);
  writeAcEvidence(directory, true);
  const baseUrl = await launch();

  let dialog = false;
  page.on("dialog", (shown) => {
    dialog = true;
    void shown.dismiss();
  });
  await open(page, baseUrl, `run/${run}`);
  const block = (id: string) => page.locator(`[data-testid="ac-evidence"][data-id="${id}"]`);
  await expect(page.getByTestId("ac-evidence")).toHaveCount(5);
  await expect(block("AC1")).toContainText("opened the run page");
  await checkpoint(page, "evidence-files");

  const ac1 = block("AC1");
  await expect(ac1).toContainText("five rows");
  await expect(ac1.locator('img[alt="AC1 Before"]')).toBeVisible();
  await expect(ac1.locator('img[alt="AC1 After"]')).toBeVisible();
  await expect(ac1).toContainText("human: ok");

  await expect(block("AC2")).toContainText("hub/server.ts:120-150");
  await expect(block("AC2")).toContainText("ADR 0009");
  await expect(block("AC2")).toContainText("reviewer: pass");

  const part = (title: string, side: "Base" | "Head") =>
    block("AC3").locator(`[data-title="${title}"] [data-title="${side}"]`);
  for (const [title, base, head] of [
    ["Command", "bun test --base", "bun test --head"],
    ["Output", "40 pass 2 fail", "42 pass 0 fail"],
    ["Threshold", "fail <= 0 (base)", "fail <= 0 (head)"],
    ["Result", "threshold missed", "threshold met"],
  ]) {
    await expect(part(title, "Base")).toContainText(base);
    await expect(part(title, "Base")).not.toContainText(head);
    await expect(part(title, "Head")).toContainText(head);
    await expect(part(title, "Head")).not.toContainText(base);
  }

  for (const id of ["AC4", "AC5"]) {
    const none = block(id).getByTestId("no-evidence");
    await expect(none).toHaveText("no evidence");
    await expect(none).toHaveClass(/warn-box/);
  }
  await expect(block("AC5")).not.toContainText("PARTIAL-INSPECTION-TEXT");

  for (const id of ["AC1", "AC2", "AC3"]) await expect(block(id)).toContainText(hostile);
  await expect(page.getByTestId("ac-evidence").locator("b")).toHaveCount(0);
  await expect(page.getByTestId("ac-evidence").locator("script")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  expect(dialog).toBe(false);
  for (const text of await page.getByTestId("ac-evidence").allTextContents())
    expect(text.trim().length).toBeGreaterThan(0);
});

/**
 * Tabs from the page start. Returns the targets that have no focus target of their own (not a link,
 * button or tabindex >= 0, or the same one as another target) and the targets no Tab reached within
 * `targets + 20` presses.
 */
async function tabReach(
  page: Page,
  targets: Locator,
): Promise<{ count: number; unfocusable: number[]; missed: number[] }> {
  const unfocusable = await targets.evaluateAll((nodes) => {
    const seen = new Set<Element>();
    const bad: number[] = [];
    nodes.forEach((node, index) => {
      const own = node.closest('a[href], button, summary, [tabindex]:not([tabindex^="-"])');
      if (!own || seen.has(own)) bad.push(index);
      else {
        seen.add(own);
        own.setAttribute("data-tab-target", String(index));
      }
    });
    return bad;
  });
  const count = await targets.count();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const reached = new Set<string>();
  for (let press = 0; press < count + 20; press++) {
    await page.keyboard.press("Tab");
    const tag = await page.evaluate(() => document.activeElement?.getAttribute("data-tab-target"));
    if (tag) reached.add(tag);
  }
  const missed = Array.from({ length: count }, (_, index) => index).filter(
    (index) => !unfocusable.includes(index) && !reached.has(String(index)),
  );
  return { count, unfocusable, missed };
}

/** The ring of the element that has the keyboard focus: an outline or a shadow that is drawn. */
const focusRing = (page: Page) =>
  page.evaluate(() => {
    const style = getComputedStyle(document.activeElement as Element);
    return {
      outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2,
      shadow: style.boxShadow !== "none",
    };
  });

test("ARK-T22 new page parts keep accessibility, request limits and speed", async ({ page }) => {
  test.setTimeout(240_000);
  ticketWorld();
  // The run of the T29, T20 and T21 fixtures, on the tickets of T28: T2 holds the three screenshot checkpoints.
  const run = runId("ARK-900");
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-900", title: "Evidence" },
    phase: "merge_requests_open",
  });
  writeRunEvidence(directory, "ARK-900", planOfT29, nonTestCriteria);
  writeShots(directory, "ARK-T2");
  // The demonstration names its screenshots but holds no image file: the page reads 4 images, not 6.
  writeAcEvidence(directory, false);
  const baseUrl = await launch();

  let requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const visit = async (hash: string, ready: Locator): Promise<string[]> => {
    // A fresh document each time: a navigation of one page would reuse images it already loaded.
    await page.goto("about:blank");
    requests = [];
    await open(page, baseUrl, hash);
    await expect(ready).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    return requests.filter(
      // ARK-285/AC11 allows the first load and the event stream; ARK-284 allows the run page its detail read.
      (path) =>
        path !== "/" &&
        path !== "/events" &&
        !path.startsWith("/assets/") &&
        path !== `/api/run/${run}`,
    );
  };
  const settled = () =>
    page.evaluate(() =>
      Promise.all(document.getAnimations().map((fade) => fade.finished.catch(() => undefined))),
    );
  const headings = () =>
    page
      .locator("h1, h2, h3, h4, h5, h6")
      .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])));
  const expectOrderedHeadings = async (name: string) => {
    const levels = await headings();
    expect(levels[0], `${name} starts with h1`).toBe(1);
    levels.forEach((level, index) => {
      if (index > 0)
        expect(level, `${name} heading ${index}`).toBeLessThanOrEqual(levels[index - 1] + 1);
    });
  };
  const expectContrast = async (name: string) => {
    await settled();
    const { checked, weak } = await weakContrast(page);
    expect(checked, name).toBeGreaterThan(20);
    expect(weak, name).toEqual([]);
  };
  const expectFocus = async (targets: Locator, name: string, extraCheck?: () => Promise<void>) => {
    const { count, unfocusable, missed } = await tabReach(page, targets);
    expect(count, `${name} has targets`).toBeGreaterThan(0);
    expect(unfocusable, `${name}: targets with no focus target`).toEqual([]);
    expect(missed, `${name}: targets Tab never reached`).toEqual([]);
    await extraCheck?.();
  };

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const dark = scheme === "dark";

    // Ticket ARK-900: case links, then the shared-case listing.
    let extra = await visit("ticket/ARK-900", criterionOf(page, "AC1").getByTestId("case-link"));
    expect(extra, `ARK-900 in ${scheme}`).toEqual([
      "/api/ticket/p/ARK-900",
      "/api/ticket/p/ARK-900/cases",
    ]);
    await criterionOf(page, "AC1").getByTestId("case-link").click();
    await expect(criterionOf(page, "AC1").getByTestId("case-listing")).toBeVisible();
    for (const [selector, word] of [
      ['[data-testid="case-link"]', /active|retired/],
      ['[data-testid="case-missing"]', /missing/],
      ['[data-testid="criterion-method"]', /method: (test|demonstration|inspection|analysis)/],
    ] as const)
      for (const text of await page.locator(selector).allTextContents()) expect(text).toMatch(word);
    const ticketTargets = page.locator(
      '[data-testid="case-link"], [data-testid="case-listing-ref"] a',
    );
    await expectFocus(ticketTargets, `ARK-900 in ${scheme}`, async () => {
      if (!dark) return;
      await page.keyboard.press("Shift");
      await ticketTargets.first().focus();
      const ring = await focusRing(page);
      expect(ring.outline || ring.shadow).toBe(true);
      await checkpoint(page, "ticket-dark");
    });
    await expectOrderedHeadings(`ARK-900 in ${scheme}`);
    await expectContrast(`ARK-900 in ${scheme}`);

    // Ticket ARK-902: the warning.
    extra = await visit("ticket/ARK-902", criterionOf(page, "AC1").getByTestId("case-link"));
    expect(extra, `ARK-902 in ${scheme}`).toEqual([
      "/api/ticket/p/ARK-902",
      "/api/ticket/p/ARK-902/cases",
    ]);
    for (const text of await page.getByTestId("criterion-warning").allTextContents())
      expect(text).toContain("Warning");
    await expect(page.getByTestId("criterion-warning")).toHaveCount(2);
    const warned = page.locator(
      '[data-testid="ticket-criterion"][data-id="AC1"] a, [data-testid="ticket-criterion"][data-id="AC2"] a',
    );
    await expectFocus(warned, `ARK-902 in ${scheme}`, async () => {
      if (!dark) return;
      await page.keyboard.press("Shift");
      await warned.first().focus();
      const ring = await focusRing(page);
      expect(ring.outline || ring.shadow).toBe(true);
      await checkpoint(page, "ticket-warning-dark");
    });
    await expectOrderedHeadings(`ARK-902 in ${scheme}`);
    await expectContrast(`ARK-902 in ${scheme}`);

    // The run page.
    extra = await visit(`run/${run}`, page.getByTestId("evidence-panel"));
    const images = extra.filter((path) => path === `/api/run/${run}/image`);
    expect(
      extra.filter((path) => path === `/api/run/${run}/evidence`),
      `evidence in ${scheme}`,
    ).toHaveLength(1);
    expect(images, `images in ${scheme}`).toHaveLength(4);
    expect(extra.length, `run page requests in ${scheme}`).toBe(5);
    for (const side of await page.getByTestId("evidence-side").all())
      await expect(side).toContainText((await side.getAttribute("data-result")) as string);
    await expect(page.getByTestId("no-evidence")).toHaveCount(2);
    for (const text of await page.getByTestId("no-evidence").allTextContents())
      expect(text).toBe("no evidence");
    const runTargets = page.locator('[data-testid="evidence-case"] a, [data-testid="shot-image"]');
    await expectFocus(runTargets, `run page in ${scheme}`, async () => {
      if (!dark) return;
      await page.keyboard.press("Shift");
      await page.locator('[data-testid="evidence-case"] a').first().focus();
      const ring = await focusRing(page);
      expect(ring.outline || ring.shadow).toBe(true);
      await checkpoint(page, "run-dark");
    });
    await expectOrderedHeadings(`run page in ${scheme}`);
    await expectContrast(`run page in ${scheme}`);
  }

  for (const route of ["/", "/nope"]) {
    const durations: number[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      const startedAt = performance.now();
      await (await fetch(`${baseUrl}${route}`)).arrayBuffer();
      durations.push(performance.now() - startedAt);
    }
    expect(percentile95(durations), `p95 of ${route}`).toBeLessThan(200);
  }
});

test("ARK-T78 ARK-329/AC3 the ticket page shows the snapshot title at once, shows a loading state until its document arrives, and shows a change to the ticket file within 5 seconds", async ({
  page,
}) => {
  test.setTimeout(120_000);
  isolate();
  installFakeTools({});
  const ticketsFolder = dirname(
    writeBacklogTicket({
      project: "p",
      id: "ARK-521",
      title: "Ticket",
      status: "ready",
      problem: "First text",
      criteria: [{ id: "AC1", text: "It works" }],
    }),
  );
  const file = join(ticketsFolder, "ARK-521.md");
  const original = readFileSync(file, "utf8");
  // Rename into place, so the hub never reads a half-written file and each change is one signature.
  const replaceFile = (text: string) => {
    const staged = join(ticketsFolder, "..", "staged.md");
    writeFileSync(staged, text);
    renameSync(staged, file);
  };
  const baseUrl = await launch();

  const documentRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/ticket/p/ARK-521") documentRequests.push(path);
  });
  await page.route("**/api/ticket/p/ARK-521", async (route) => {
    await new Promise((done) => setTimeout(done, 1500));
    await route.continue();
  });
  const loading = page.getByRole("status").filter({ hasText: "Loading the ticket text" });
  const problem = page.getByTestId("ticket-problem");

  // The snapshot gives the title and header at once; the text waits for the delayed route.
  await open(page, baseUrl, "ticket/ARK-521");
  await expect(page.getByRole("heading", { level: 1, name: "Ticket" })).toBeVisible();
  await expect(loading).toBeVisible();
  await expect(problem).toHaveCount(0);
  await checkpoint(page, "ticket-loading");
  await expect(problem).toHaveText("First text", { timeout: 10_000 });
  await expect(loading).toHaveCount(0);
  await checkpoint(page, "ticket-loaded");

  // An edit of the file shows within 5 s, with no loading flash, after one more read.
  await page.unroute("**/api/ticket/p/ARK-521");
  await page.evaluate(() => {
    const flags = window as unknown as { sawLoading: boolean };
    flags.sawLoading = false;
    new MutationObserver(() => {
      if (document.querySelector(".doc-status")) flags.sawLoading = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  const readsBefore = documentRequests.length;
  replaceFile(original.replace("First text", "Second text"));
  await expect(problem).toHaveText("Second text", { timeout: 5000 });
  await checkpoint(page, "ticket-reloaded");
  expect(await page.evaluate(() => (window as unknown as { sawLoading: boolean }).sawLoading)).toBe(
    false,
  );
  expect(documentRequests.length - readsBefore).toBe(1);

  // Another ticket's file pushes a snapshot; this page reads nothing more.
  writeBacklogTicket({ project: "p", id: "ARK-522", title: "Other", status: "ready" });
  await page.waitForTimeout(2000);
  expect(documentRequests.length - readsBefore).toBe(1);

  // A file that does not parse shows the alert, and a repair shows the text again.
  replaceFile("this file has no front matter\n");
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 5000 });
  await expect(loading).toHaveCount(0);
  await checkpoint(page, "ticket-unreadable");
  replaceFile(original.replace("First text", "Third text"));
  await expect(problem).toHaveText("Third text", { timeout: 5000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

type Box = { x: number; y: number; width: number; height: number };

/** The boxes of the selectors in one frame, read once no animation runs and the geometry is equal across two frames. */
async function settledBoxes(page: Page, selectors: string[]): Promise<Box[]> {
  return page.evaluate(async (list) => {
    const read = () =>
      JSON.stringify(
        list.map((selector) => {
          const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    let last = "";
    for (;;) {
      await document.fonts.ready;
      await Promise.all(
        document.getAnimations().map((fade) => fade.finished.catch(() => undefined)),
      );
      await frame();
      const now = read();
      if (now === last && document.getAnimations().length === 0) return JSON.parse(now);
      last = now;
    }
  }, selectors);
}
