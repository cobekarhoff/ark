import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
import { readdir } from "node:fs/promises";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Gate, ProjectQueue, RunView, Snapshot, TicketView } from "../../hub/types.ts";
import type { ArkEvent } from "../../cli/events.ts";
import type {
  ConversationAgent,
  ConversationMessage,
  ConversationQuestion,
  ConversationSpan,
  RoleGroup,
} from "../../hub/conversation.ts";
import { crc32, deflateSync } from "node:zlib";
import {
  appendRawEvent,
  fakeGateEnvironment,
  fakeToolGateEnvironment,
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
  type ExtraEntry,
  writeRun,
  writeSessionFile,
  type FixtureRun,
  type SessionHarness,
} from "../hub-fixtures.ts";
import {
  ark,
  checkpoint,
  finiteAnimationsEnded,
  installFakeTools,
  serve,
  startHub,
  stopHub,
  type StartedHub,
  tempArkHome,
  tempDirectory,
  useCleanup,
  dateOf,
  testNow,
  writeFakeOrca,
  writeProject,
} from "./helpers.ts";

type QueuedProject = Extract<ProjectQueue, { tasks: unknown }>;

useCleanup();

const started: StartedHub[] = [];
const gates: string[] = [];
test.afterEach(async () => {
  // Release held fake tools, so a failing case leaves no waiting process behind.
  for (const gate of gates.splice(0)) writeFileSync(gate, "");
  delete process.env[fakeGateEnvironment];
  for (const tool of fakeTools) delete process.env[fakeToolGateEnvironment(tool)];
  await Promise.all(started.splice(0).map((hub) => stopHub(hub.process)));
});

/** Holds every fake tool until the returned function runs. Call it before `launch`, so the hub inherits the gate. */
function holdFakeTools(): () => void {
  const gate = join(tempDirectory("ark-gate-"), "release");
  process.env[fakeGateEnvironment] = gate;
  gates.push(gate);
  return () => writeFileSync(gate, "");
}

const fakeTools = ["orca", "gh", "omp", "plannotator"] as const;
/** Holds each fake tool on a gate of its own: the returned functions release them one at a time. Call it before `launch`. */
function holdFakeToolsOneByOne(): Record<(typeof fakeTools)[number], () => void> {
  const directory = tempDirectory("ark-gate-");
  const releases = {} as Record<(typeof fakeTools)[number], () => void>;
  for (const tool of fakeTools) {
    const gate = join(directory, tool);
    process.env[fakeToolGateEnvironment(tool)] = gate;
    gates.push(gate);
    releases[tool] = () => writeFileSync(gate, "");
  }
  return releases;
}

/** The row of one source in the stale chip's list; opens the list when it is closed (ARK-335: one chip for every stale source). */
async function staleRow(page: Page, source: string): Promise<Locator> {
  const chip = page.getByTestId("stale-chip");
  await expect(chip).toBeVisible();
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
  return page.locator(`[data-testid="stale-list"] [data-source="${source}"]`);
}

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
const ago = (seconds: number) => dateOf(testNow() - seconds * 1000);

/** Opens a view and waits for the app to mount (the main heading) before any input. */
async function open(page: Page, baseUrl: string, hash: string): Promise<void> {
  await page.goto(`${baseUrl}/#/${hash}`);
  await expect(page.locator("main h1").first()).toBeVisible();
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

test("ARK-T133 ARK-277-AC4 the page sends no request but its first load and one event stream, and an appended event shows on Home within 5 s", async ({
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
  await expect(page.getByTestId("stale-chip")).toHaveCount(0); // every source answered: the first load is complete
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
      const appendedAt = performance.now();
      appendRawEvent(
        directory,
        "merge_request.opened",
        { repo: ".", url: "https://github.com/example/repo/pull/77", number: 77 },
        99,
      );
      await expect(page.getByTestId("mr")).toContainText("!77", { timeout: 5000 });
      expect(performance.now() - appendedAt).toBeLessThan(5000);
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

test("ARK-T367 the run page draws one node for each plan step and one edge for each dependency", async ({
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
  const start = testNow() - 3_600_000;
  const inside = (seconds: number) => dateOf(start + seconds * 1000);
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

test("ARK-T260 Runs draws one node for each ticket and one edge for each depends_on, colored by the newest run's phase, and a ready ticket is queued because the Orca queue holds its Task", async ({
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
  // The queue holds the Task of ARK-905 only: queued comes from the queue, not from the read's timing.
  installFakeTools({});
  installChiefOrca({ ready: ["ARK-905 Ticket ARK-905"] });
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

test("ARK-T315 ARK-277-AC11 a source that stops answering keeps its last good value and shows its age on the stale chip; before a first read the page says unknown", async ({
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
  await page.clock.install(); // before the load: the chip's minute timer must be the clock's
  await open(page, baseUrl, "");

  // The agents are on the run page: a second page in the same browser shows them.
  const runPage = await page.context().newPage();
  await open(runPage, baseUrl, `run/${run}`);
  const agents = runPage.getByTestId("agents");
  const age = async (source: string) => (await staleRow(page, source)).locator("span").first();

  // Before the first good read: unknown, not an empty list.
  await expect(await age("orca")).toHaveText("unknown");
  await expect(await age("plannotator")).toHaveText("unknown");
  await expect(agents).toHaveText("unknown");
  await expect(agents).not.toContainText("no live agent");

  // Every source reads once (the chip vanishes), then each fails: the stale sources have a last
  // read and so an age, never "unknown", however slow the runner is.
  writeFileSync(join(state, "orca.mode"), "up");
  writeFileSync(join(state, "plannotator.mode"), "up");
  await expect(agents).toContainText("openai/gpt-worker-model", { timeout: 20_000 });
  await expect(page.getByTestId("stale-chip")).toHaveCount(0, { timeout: 30_000 });
  writeFileSync(join(state, "orca.mode"), "down");
  writeFileSync(join(state, "plannotator.mode"), "down");
  await expect(agents).toContainText("openai/gpt-worker-model", { timeout: 20_000 });
  await expect(page.getByTestId("gate-link")).toHaveAttribute(
    "href",
    "http://localhost:20000/review/xyz",
    { timeout: 20_000 },
  );

  // The third read of each fails: the last good value stays, with its age.
  await expect(await age("orca")).toHaveText(/^\d+ min$/, { timeout: 30_000 });
  await expect(await age("plannotator")).toHaveText(/^\d+ min$/, { timeout: 30_000 });
  await expect(agents).toContainText("openai/gpt-worker-model");
  await expect(agents).toContainText("anthropic/claude-lead-model");
  await expect(page.getByTestId("gate-link")).toHaveCount(1);

  // The age moves by whole minutes: 3 minutes on the page clock show as 2 or more.
  await page.clock.fastForward(180_000);
  await expect(await age("orca")).toHaveText(/^([2-9]|\d\d+) min$/);
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

test("ARK-T368 an unread question and an escalation of live workers wait on Home, a finished worker's do not", async ({
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
    created_at: dateOf().toISOString(),
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
  // Each agent of the snapshot has its handle and presence.
  await expect
    .poll(async () => {
      const snapshot = await (await fetch(`${baseUrl}/api/snapshot`)).json();
      const agents = Array.isArray(snapshot.runs) ? snapshot.runs[0]?.agents : null;
      return Array.isArray(agents)
        ? agents.map((agent: { terminal: string; presence: string }) => [
            agent.terminal,
            agent.presence,
          ])
        : [];
    })
    .toEqual(
      expect.arrayContaining([
        ["term-chief", "live"],
        ["term-lead", "live"],
        ["term-worker", "live"],
        ["term-gone", "ended"],
        ["structworker_unlisted", "running"],
      ]),
    );

  // The run page: a button for the live agents, Master Chief too; the released one says why it has none.
  for (const handle of ["term-chief", "term-lead", "term-worker"])
    await expect(home.locator(`[data-terminal="${handle}"]`)).toHaveText("Open in Orca");
  await expect(home.locator('[data-testid="agent"][data-role="Master Chief"]')).toHaveCount(1);
  const ended = home.locator('[data-testid="agent"][data-presence="ended"]', {
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

test("ARK-T369 the run page lists each decision of events.ndjson oldest first with its time, and skips a damaged line", async ({
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
  ).toEqual(expected.map(([after]) => dateOf(started.getTime() + after * 1000).toISOString()));
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

/** What a transcript of `transcriptText(harness)` shows: one-line rows for messages, 2 tool calls and thinking, and the inspector of a call and of the folded thinking. */
async function expectTranscript(page: Page, harness: SessionHarness): Promise<void> {
  const text = transcriptTexts(harness);
  const rows = page.getByTestId("transcript-entry");
  await expect(rows).toHaveCount(5);
  expect(
    await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-kind"))),
  ).toEqual(["message", "thinking", "message", "tool", "tool"]);

  // Rows: time, kind and the first words.
  await expect(rows.nth(0).locator(".k")).toHaveText("user");
  await expect(rows.nth(0).locator(".s")).toHaveText(text.user);
  await expect(rows.nth(2).locator(".k")).toHaveText("assistant");
  await expect(rows.nth(2).locator(".s")).toHaveText(text.assistant);
  for (let index = 0; index < 5; index++)
    await expect(rows.nth(index).locator("time")).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT/);
  await expect(rows.nth(3)).toHaveAttribute("data-status", "ok");
  await expect(rows.nth(3).locator(".k")).toHaveText(toolNames[harness]);
  await expect(rows.nth(3).locator(".s")).toContainText(text.command);
  await expect(rows.nth(4)).toHaveAttribute("data-status", "error");
  await expect(rows.nth(4).locator(".e")).toHaveText(text.failFirstLine);

  // A call in the inspector: the first line of its result, never the rest.
  const inspector = page.getByTestId("inspector");
  await rows.nth(3).click();
  await expect(inspector.getByTestId("tool-result")).toHaveText(text.okFirstLine);
  // The shell command of every harness reads as a bash block, never as argv or a JSON string.
  await expect(inspector.getByTestId("code-block").locator(".lang")).toHaveText("bash");
  await expect(inspector.getByTestId("code-block").locator("pre")).toHaveText(text.command);
  await expect(inspector.getByTestId("show-result")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(text.tail);
  await expect(page.locator("body")).not.toContainText("second line");

  // Thinking is folded until a click.
  await rows.nth(1).click();
  const thinking = inspector.getByTestId("thinking");
  await expect(thinking).toHaveJSProperty("open", false);
  await thinking.locator("summary").click();
  await expect(thinking).toHaveJSProperty("open", true);
  await expect(inspector.getByTestId("entry-text")).toHaveText(text.thinking);
  await expect(page.getByTestId("load-more")).toHaveText("Check for new entries");
}

test("ARK-T273 a DAG node, the run lead and an unassigned file open their transcript as a list and an inspector for an omp, a Claude and a Codex session file", async ({
  page,
}) => {
  const { sessions } = isolate();
  const run = runId("ARK-871");
  const started = ago(7_200);
  const at = (seconds: number) => dateOf(started.getTime() + seconds * 1000);
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

/** A closed run whose one omp session file is the run lead's transcript. `files` are written under the run folder. */
function leadTranscriptRun(
  ticket: string,
  extra: ExtraEntry[],
  files: Record<string, string> = {},
): { run: string; directory: string; started: Date; sessions: string } {
  const { sessions } = isolate();
  const run = runId(ticket);
  const started = ago(7_200);
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: ticket, title: "Transcript" },
    phase: "closed",
    startedAt: started,
    steps: [
      {
        id: "work",
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 60,
        finishedAfter: 6000,
      },
    ],
  });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  // The session files start inside the step's window, so the step owns them all.
  const fileStart = dateOf(started.getTime() + 100_000);
  writeSessionFile(
    sessions,
    "lead.jsonl",
    transcriptText("omp", {
      cwd: join(directory, "workspace"),
      start: fileStart,
      tag: "omp",
      extra,
    }),
  );
  installFakeTools({});
  return { run, directory, started: fileStart, sessions };
}

async function openLeadTranscript(page: Page, baseUrl: string, run: string): Promise<void> {
  await open(page, baseUrl, `run/${run}`);
  await page.locator('[data-testid="step-node"][data-step="work"] a').click();
  await expect(page.getByTestId("transcript-entry").first()).toBeVisible();
}

const rowWith = (page: Page, text: string) =>
  page.getByTestId("transcript-entry").filter({ hasText: text });

/** A text of exactly `length` characters that starts with `prefix`. */
const sizedText = (prefix: string, length: number) => prefix + "€".repeat(length - prefix.length);

test("ARK-T273 the transcript opens as a list and an inspector: one-line rows of time, kind and summary, a failed call's row red with its error line, and the inspector showing a message, context, thinking, a bash command, an edit input and other arguments through Markdown, Code and Json", async ({
  page,
}) => {
  const { run } = leadTranscriptRun("ARK-931", [
    {
      kind: "user",
      text: "**bold user**\n\n- user one\n- user two\n\n[x](javascript:alert(1))",
    },
    { kind: "context", text: "# Context head\n\n**bold context**\n\n- context one\n- context two" },
    { kind: "thinking", text: "**bold thinking**\n\n- thinking one\n- thinking two" },
    { kind: "assistant", text: "**bold assistant**\n\n- assistant one\n- assistant two" },
    {
      kind: "call",
      id: "edit",
      name: "edit",
      args: { path: "src/a.ts", old_text: "const a = 1;", new_text: "const a = 2;" },
      result: "edited",
    },
    {
      kind: "call",
      id: "write",
      name: "write",
      args: { path: "src/b.ts", content: "export const b = 1;\n" },
      result: "written",
    },
    {
      kind: "call",
      id: "read",
      name: "read",
      args: { path: "src/c.ts", offset: 1, limit: 20 },
      result: "c",
    },
    { kind: "call", id: "long", args: { command: sizedText("L30:", 30_000) }, result: "done" },
    {
      kind: "call",
      id: "multi",
      args: { command: "multi-fail" },
      result: "first error line\nsecond error line",
      failed: true,
    },
  ]);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const baseUrl = await launch();
  await page.emulateMedia({ colorScheme: "dark" });
  await openLeadTranscript(page, baseUrl, run);
  const rows = page.getByTestId("transcript-entry");
  const inspector = page.getByTestId("inspector");
  await expect(rows).toHaveCount(14);
  await checkpoint(page, "transcript-list-dark");

  // Every row is one line (a failed row adds its error line) with a time, a kind and a summary.
  const heights = await rows.evaluateAll((nodes) =>
    nodes.map((node) => ({
      error: node.classList.contains("err"),
      height: node.getBoundingClientRect().height,
    })),
  );
  for (const row of heights) expect(row.height).toBeLessThan(row.error ? 64 : 34);
  for (let index = 0; index < 14; index++)
    await expect(rows.nth(index).locator("time")).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT/);
  const cell = async (text: string, part: string) => rowWith(page, text).first().locator(part);
  await expect(await cell("ls -la /tmp/omp", ".k")).toHaveText("bash");
  await expect(await cell("ls -la /tmp/omp", ".s")).toHaveText("ls -la /tmp/omp");
  await expect(await cell("src/a.ts", ".k")).toHaveText("edit");
  await expect(await cell("src/a.ts", ".s")).toHaveText("src/a.ts");
  await expect(await cell("src/b.ts", ".s")).toHaveText("src/b.ts");
  await expect(await cell("src/c.ts", ".k")).toHaveText("read");
  await expect(await cell("**bold user**", ".k")).toHaveText("user");
  await expect(await cell("# Context head", ".k")).toHaveText("context");
  // The 30 KB command: the row shows the start of the command, never the JSON around it.
  const longSummary = (await rowWith(page, "L30:").first().locator(".s").textContent()) ?? "";
  expect(longSummary.startsWith("L30:")).toBe(true);

  // A failed call: its row is red and shows the first line of its error, not the second.
  const failed = page.locator('[data-testid="transcript-entry"][data-status="error"]');
  await expect(failed).toHaveCount(2);
  await expect(failed.nth(0).locator(".e")).toHaveText("boom omp");
  await expect(failed.nth(1).locator(".e")).toHaveText("first error line");
  await expect(failed.nth(1)).not.toContainText("second error line");
  const background = (locator: Locator) =>
    locator.evaluate((node) => getComputedStyle(node).backgroundColor);
  const [red, green] = ((await background(failed.nth(1))).match(/[\d.]+/g) ?? []).map(Number);
  expect(red).toBeGreaterThan(green);
  expect(await background(failed.nth(1))).not.toBe(await background(rows.first()));
  await failed.nth(1).click();
  await checkpoint(page, "transcript-failed-row");

  // The inspector shows each kind through its renderer.
  const renders = async (label: string) => {
    await expect(inspector.locator(".md strong")).toHaveText(`bold ${label}`);
    await expect(inspector.locator(".md li")).toHaveText([`${label} one`, `${label} two`]);
    expect(await inspector.getByTestId("entry-text").innerText()).not.toContain("**");
  };
  await rowWith(page, "**bold user**").click();
  await renders("user");
  await checkpoint(page, "transcript-inspector-markdown");
  // A javascript: link in injected text is never live.
  await expect(inspector.locator('a[href^="javascript:" i]')).toHaveCount(0);
  for (const link of await inspector.locator(".md a").all()) await link.click();
  await rowWith(page, "# Context head").click();
  await expect(inspector.locator(".md h1")).toHaveText("Context head");
  await renders("context");
  await rowWith(page, "**bold thinking**").click();
  await inspector.getByTestId("thinking").locator("summary").click();
  await renders("thinking");
  await rowWith(page, "**bold assistant**").click();
  await renders("assistant");

  const code = inspector.getByTestId("code-block");
  await rowWith(page, "ls -la /tmp/omp").click();
  await expect(code.locator(".lang")).toHaveText("bash");
  expect(await code.locator("pre").textContent()).toBe("ls -la /tmp/omp");
  await checkpoint(page, "transcript-inspector-bash");
  await rowWith(page, "src/a.ts").click();
  await expect(code).toBeVisible();
  await expect(inspector.getByTestId("json-block")).toHaveCount(0);
  expect(await code.locator("pre").textContent()).toContain("const a = 2;");
  await rowWith(page, "src/b.ts").click();
  await expect(code.locator(".lang")).toHaveText("ts");
  expect(await code.locator("pre").textContent()).toBe("export const b = 1;\n");
  await rowWith(page, "src/c.ts").click();
  await expect(inspector.getByTestId("code-block")).toHaveCount(0);
  await expect(inspector.getByTestId("json-block").locator(".tk-key")).toHaveText([
    '"path"',
    '"offset"',
    '"limit"',
  ]);
  expect(
    (await inspector.getByTestId("json-block").locator("pre").textContent())!.split("\n"),
  ).toEqual(["{", '  "path": "src/c.ts",', '  "offset": 1,', '  "limit": 20', "}"]);
  await checkpoint(page, "transcript-inspector-json");
  // The 30 KB command shows its cut with the note.
  await rowWith(page, "L30:").click();
  const command = (await code.locator("pre").textContent()) ?? "";
  expect(command.startsWith("L30:")).toBe(true);
  expect(command).toContain("(+10000 characters cut)");
  expect(dialogs).toEqual([]);

  // Both themes: the text of the list and the inspector keeps its contrast, measured once a fade has ended.
  const settled = () => finiteAnimationsEnded(page);
  await failed.nth(1).click();
  await settled();
  const dark = await weakContrast(page);
  expect(dark.checked).toBeGreaterThan(20);
  expect(dark.weak).toEqual([]);
  const pageBackground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const darkBackground = await pageBackground();
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(pageBackground).not.toBe(darkBackground);
  await settled();
  await checkpoint(page, "transcript-list-light");
  const light = await weakContrast(page);
  expect(light.checked).toBeGreaterThan(20);
  expect(light.weak).toEqual([]);
  expect(await background(failed.nth(1))).not.toBe(await background(rows.first()));
});

test("ARK-T274 a tool call in the inspector shows the first line of its result and a Show result control with the size, which loads the full result only on click and shows a JSON result through Json and a text result through Code", async ({
  page,
}) => {
  const jsonResult = JSON.stringify(
    Object.fromEntries(Array.from({ length: 40 }, (_, key) => [`key${key}`, "v".repeat(60)])),
  );
  const textResult = "# not a heading\nline two\nline three";
  const bigResult = `# big\n${"b".repeat(100_000)}`;
  const { run } = leadTranscriptRun("ARK-932", [
    { kind: "call", id: "j", args: { command: "call-json" }, result: jsonResult },
    { kind: "call", id: "t", args: { command: "call-text" }, result: textResult },
    { kind: "call", id: "b", args: { command: "call-big" }, result: bigResult },
    { kind: "call", id: "x", args: { command: "call-bad" }, result: "{not json at all\nsecond" },
    { kind: "call", id: "live", args: { command: "call-live" } },
    { kind: "call", args: { command: "call-noid" } },
  ]);
  const baseUrl = await launch();
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    requests.push(url.pathname + url.search);
  });
  await openLeadTranscript(page, baseUrl, run);
  const inspector = page.getByTestId("inspector");
  const full = inspector.getByTestId("full-result");
  const resultRequests = () => requests.filter((path) => path.includes("/transcript/result"));
  // Nothing is fetched on load: the page sent one transcript read and no result read.
  await expect(page.getByTestId("transcript-entry")).toHaveCount(11);
  expect(requests.filter((path) => path.includes("/transcript?"))).toHaveLength(1);
  expect(resultRequests()).toEqual([]);

  // The first line and the control with its size, before any click.
  await rowWith(page, "call-json").click();
  await expect(inspector.getByTestId("tool-result")).toContainText('{"key0"');
  await expect(inspector.getByTestId("show-result")).toHaveText(/Show result.*\b3(\.\d)? ?KB/i);
  await checkpoint(page, "tool-result-collapsed");
  expect(resultRequests()).toEqual([]);

  // One click, one request with the file and the call id; JSON shows indented through Json.
  const sent = page.waitForRequest((request) => request.url().includes("/transcript/result"));
  await inspector.getByTestId("show-result").click();
  const url = new URL((await sent).url());
  expect(url.searchParams.get("call")).toBe("j");
  expect(url.searchParams.get("file")).toMatch(/lead\.jsonl$/);
  await expect(full.getByTestId("json-block").locator(".tk-key").first()).toHaveText('"key0"');
  expect((await full.getByTestId("json-block").locator("pre").textContent())!.split("\n")[1]).toBe(
    `  "key0": "${"v".repeat(60)}",`,
  );
  await checkpoint(page, "tool-result-json");
  expect(resultRequests()).toHaveLength(1);

  // Text shows in Code as written: `# not a heading` makes no heading.
  await rowWith(page, "call-text").click();
  await inspector.getByTestId("show-result").click();
  await expect(full.getByTestId("code-block").locator("pre")).toHaveText(textResult);
  await expect(full.locator("h1, h2, h3")).toHaveCount(0);
  await checkpoint(page, "tool-result-text");

  // 100,006 characters: the size of the whole, the cut at 64,000 and the note.
  await rowWith(page, "call-big").click();
  await inspector.getByTestId("show-result").click();
  await expect(full).toContainText(/100[,.\s]?006 characters/);
  await expect(full).toContainText("cut at 64,000 characters");
  expect((await full.getByTestId("code-block").locator("pre").textContent())!.length).toBe(64_000);

  // A result that begins with `{` and does not parse shows in Code, with no error.
  await rowWith(page, "call-bad").click();
  await inspector.getByTestId("show-result").click();
  await expect(full.getByTestId("code-block").locator("pre")).toContainText("{not json at all");
  await expect(page.getByRole("alert")).toHaveCount(0);

  // A call with no result record: a visible message, and the list stays usable.
  await rowWith(page, "call-live").click();
  await inspector.getByTestId("show-result").click();
  await expect(inspector.getByTestId("result-missing")).toBeVisible();
  await rowWith(page, "call-noid").click();
  await expect(inspector.getByTestId("show-result")).toHaveCount(0);

  // Back at a loaded result: shown again with no second request.
  const before = resultRequests().length;
  await rowWith(page, "call-json").click();
  await expect(full.getByTestId("json-block")).toBeVisible();
  expect(resultRequests()).toHaveLength(before);
});

test("ARK-T275 the chips filter the list into messages, tools, thinking and errors with counts of the loaded entries, the errors chip shows only failed calls, j and k move through the visible entries only, and r switches Rendered and Raw and the choice stays when the selection moves", async ({
  page,
}) => {
  const { run, directory, started } = leadTranscriptRun("ARK-933", [
    { kind: "user", text: "**bold** message\n\nsecond paragraph" },
    { kind: "assistant", text: "extra answer" },
    { kind: "thinking", text: "extra thinking one" },
    { kind: "thinking", text: "extra thinking two" },
    { kind: "call", id: "e1", args: { command: "extra-one" }, result: "ok one" },
    { kind: "call", id: "e2", args: { command: "extra-two" }, result: "ok two" },
    { kind: "call", id: "e3", args: { command: "extra-fail" }, result: "bad\nmore", failed: true },
    { kind: "call", id: "e4", name: "read", args: { path: "a.json", offset: 1 }, result: "{}" },
  ]);
  // A second file of 250 entries: 200 messages on page 1; 47 messages and 3 failed calls on page 2.
  const second = (number: number) => dateOf(started.getTime() + (10 + number) * 1000).toISOString();
  const big = [
    JSON.stringify({
      type: "session",
      version: 3,
      timestamp: second(0),
      cwd: join(directory, "workspace"),
    }),
  ];
  let seconds = 0;
  const record = (message: unknown) =>
    JSON.stringify({ type: "message", timestamp: second(++seconds), message });
  for (let number = 0; number < 247; number++) {
    big.push(record({ role: "user", content: [{ type: "text", text: `m${number}` }] }));
    if ([203, 223, 243].includes(number)) {
      big.push(
        record({
          role: "assistant",
          content: [
            { type: "toolCall", id: `f${number}`, name: "bash", arguments: { command: "f" } },
          ],
        }),
        record({
          role: "toolResult",
          toolCallId: `f${number}`,
          isError: true,
          content: [{ type: "text", text: "failed\nmore" }],
        }),
      );
    }
  }
  writeSessionFile(process.env.ARK_OMP_SESSIONS as string, "big.jsonl", `${big.join("\n")}\n`);
  // Count the keydown listeners the page holds, to see that the transcript removes its own.
  await page.addInitScript(`
    window.activeKeydown = new Set();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = (type, listener, ...rest) => {
      if (type === "keydown") window.activeKeydown.add(listener);
      return add(type, listener, ...rest);
    };
    window.removeEventListener = (type, listener, ...rest) => {
      if (type === "keydown") window.activeKeydown.delete(listener);
      return remove(type, listener, ...rest);
    };
  `);
  const baseUrl = await launch();
  const keydownListeners = () => page.evaluate<number>("window.activeKeydown.size");
  await open(page, baseUrl, "");
  const withoutTranscript = await keydownListeners();

  await open(page, baseUrl, `run/${run}`);
  await page.locator('[data-testid="step-node"][data-step="work"] a').click();
  await page.locator('[data-testid="transcript-file"][data-file$="lead.jsonl"]').click();
  const rows = page.getByTestId("transcript-entry");
  const inspector = page.getByTestId("inspector");
  const counter = page.getByTestId("transcript-count");
  await expect(rows).toHaveCount(13);
  expect(await keydownListeners()).toBeGreaterThan(withoutTranscript);
  const chip = (name: string) => page.getByTestId(`chip-${name}`);
  const kinds = () =>
    rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-kind")));
  const selected = () =>
    rows.evaluateAll((nodes) =>
      nodes.findIndex((node) => node.getAttribute("aria-current") === "true"),
    );

  // Counts of the loaded entries, and the counter says so.
  await expect(chip("message")).toHaveText(/Messages\s*4/);
  await expect(chip("tool")).toHaveText(/Tools\s*6/);
  await expect(chip("thinking")).toHaveText(/Thinking\s*3/);
  await expect(chip("errors")).toHaveText(/Errors\s*2/);
  await expect(counter).toHaveText(/Showing 13 of 13 loaded entries/);
  await checkpoint(page, "chips-all");

  // Each chip alone shows only its kind.
  for (const [name, kind, count] of [
    ["message", "message", 4],
    ["tool", "tool", 6],
    ["thinking", "thinking", 3],
  ] as const) {
    await chip(name).click();
    await expect(rows).toHaveCount(count);
    expect(new Set(await kinds())).toEqual(new Set([kind]));
    await expect(counter).toHaveText(new RegExp(`Showing ${count} of 13`));
    await chip(name).click();
    await expect(rows).toHaveCount(13);
  }
  // Kind chips combine.
  await chip("tool").click();
  await chip("thinking").click();
  await expect(rows).toHaveCount(9);
  await chip("tool").click();
  await chip("thinking").click();

  // Errors alone, and with any other chip, show exactly the failed calls.
  const statuses = () =>
    rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-status")));
  await chip("errors").click();
  await expect(rows).toHaveCount(2);
  expect(await statuses()).toEqual(["error", "error"]);
  await expect(counter).toHaveText(/Showing 2 of 13/);
  await checkpoint(page, "chips-errors");
  for (const other of ["tool", "message", "thinking"]) {
    await chip(other).click();
    await expect(rows).toHaveCount(2);
    expect(await statuses()).toEqual(["error", "error"]);
    await chip(other).click();
  }
  for (const other of ["tool", "message", "thinking"]) await chip(other).click();
  await expect(rows).toHaveCount(2);
  for (const other of ["tool", "message", "thinking"]) await chip(other).click();
  await chip("errors").click();
  await expect(rows).toHaveCount(13);

  // j and k visit only the visible rows; the first and last stay; no hidden entry is selected.
  await chip("tool").click();
  await expect(rows).toHaveCount(6);
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press("j");
    await expect.poll(selected).toBe(step);
  }
  await page.keyboard.press("j");
  await expect.poll(selected).toBe(5);
  for (let step = 4; step >= 0; step--) {
    await page.keyboard.press("k");
    await expect.poll(selected).toBe(step);
  }
  await page.keyboard.press("k");
  await expect.poll(selected).toBe(0);
  await expect(
    page.locator('[data-testid="transcript-entry"][aria-current="true"]'),
  ).toHaveAttribute("data-kind", "tool");
  await expect(counter).toHaveText(/Showing 6 of 13/);
  await chip("tool").click();
  await expect(rows).toHaveCount(13);

  // r switches Rendered and Raw, and the choice stays while the selection moves.
  const mode = page.locator('.filterbar .seg [aria-pressed="true"]');
  await rowWith(page, "**bold** message").click();
  await expect(inspector.locator(".md strong")).toHaveText("bold");
  await page.keyboard.press("r");
  await expect(mode).toHaveText("Raw");
  await expect(inspector.getByTestId("entry-text")).toContainText("**bold** message");
  await checkpoint(page, "inspector-raw");
  for (let step = 0; step < 4; step++) await page.keyboard.press("j");
  await expect(rowWith(page, "extra-one")).toHaveAttribute("aria-current", "true");
  await expect(inspector.locator("pre.raw")).toContainText('"command":"extra-one"');
  await expect(mode).toHaveText("Raw");
  for (let step = 0; step < 4; step++) await page.keyboard.press("k");
  await expect(inspector.getByTestId("entry-text")).toContainText("**bold** message");
  await expect(mode).toHaveText("Raw");

  // A key typed into an input, or with ctrl or meta, changes nothing.
  const current = await selected();
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "probe";
    document.body.append(input);
  });
  await page.locator("#probe").focus();
  for (const key of ["j", "k", "r"]) await page.keyboard.press(key);
  await page.evaluate(() => document.getElementById("probe")?.remove());
  await page.keyboard.press("Control+r");
  await page.keyboard.press("Meta+j");
  expect(await selected()).toBe(current);
  await expect(mode).toHaveText("Raw");
  await rowWith(page, "**bold** message").click();
  await page.keyboard.press("r");
  await expect(mode).toHaveText("Rendered");
  await expect(inspector.locator(".md strong")).toHaveText("bold");

  // The 250-entry file: counts cover the loaded entries, and say so; Load more adds the rest.
  await page.locator('[data-testid="transcript-file"][data-file$="big.jsonl"]').click();
  await expect(rows).toHaveCount(200);
  await expect(chip("message")).toHaveText(/Messages\s*200/);
  await expect(chip("errors")).toHaveText(/Errors\s*0/);
  await expect(page.locator(".more")).toContainText("Chip counts cover the loaded entries only");
  await page.getByTestId("load-more").click();
  await expect(rows).toHaveCount(250);
  await expect(chip("message")).toHaveText(/Messages\s*247/);
  await expect(chip("errors")).toHaveText(/Errors\s*3/);
  await chip("errors").click();
  await expect(rows).toHaveCount(3);
  await expect(counter).toHaveText(/Showing 3 of 250/);

  // A live file grows: at its end the button re-asks from the end and adds only the new entries.
  const more = page.getByTestId("load-more");
  await expect(more).toHaveText("Check for new entries");
  appendFileSync(
    join(process.env.ARK_OMP_SESSIONS as string, "big.jsonl"),
    `${record({ role: "user", content: [{ type: "text", text: "live arrival" }] })}\n`,
  );
  await more.click();
  await expect(counter).toHaveText(/Showing 3 of 251/);
  await expect(chip("message")).toHaveText(/Messages\s*248/);

  // Leaving the page removes the key handler.
  await open(page, baseUrl, "");
  // The route change runs in a view transition: the old page unmounts a frame later.
  await expect.poll(keydownListeners).toBe(withoutTranscript);
});

test("ARK-T276 a context entry of 114 lines and a user message of more than 40 lines are one list row and show in full in the inspector, thinking is folded until a click, and the run files are pinned below the list and open in the same inspector", async ({
  page,
}) => {
  const lines = (count: number) =>
    Array.from({ length: count }, (_, number) => `line ${number + 1} of ${count}`).join("\n");
  const context = [
    "# Injected context",
    "",
    ...Array.from({ length: 108 }, (_, number) => `- item ${number + 1}`),
    "",
    "```ts",
    "const last = 114;",
    "```",
  ].join("\n");
  expect(context.split("\n")).toHaveLength(114);
  const { run, directory, started } = leadTranscriptRun(
    "ARK-934",
    [
      { kind: "context", text: context },
      { kind: "user", text: "after context" },
      { kind: "thinking", text: "folded thought" },
      { kind: "assistant", text: "after answer" },
      { kind: "call", id: "done", args: { command: "echo done" }, result: "done" },
    ],
    {
      "plan.md": "# Plan title\n\n**bold plan**\n",
      "results/state.json": JSON.stringify({ phase: "closed", count: 2 }),
      "results/notes.txt": "**not bold**\n- not a list",
    },
  );
  const longMessages: ExtraEntry[] = [114, 41, 40].map((count) => ({
    kind: "user",
    text: lines(count),
  }));
  // Claude names its tools Edit and Write and puts the path in file_path.
  const claudeCalls: ExtraEntry[] = [
    {
      kind: "call",
      id: "ce",
      name: "Edit",
      args: { file_path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      result: "ok",
    },
    {
      kind: "call",
      id: "cw",
      name: "Write",
      args: { file_path: "src/b.ts", content: "export const b = 3;" },
      result: "ok",
    },
  ];
  const cwd = join(directory, "workspace");
  writeSessionFile(
    process.env.ARK_CLAUDE_SESSIONS as string,
    "claude.jsonl",
    transcriptText("claude", {
      cwd,
      start: dateOf(started.getTime() + 10_000),
      tag: "claude",
      extra: [...longMessages, ...claudeCalls],
    }),
  );
  writeSessionFile(
    process.env.ARK_CODEX_SESSIONS as string,
    "codex.jsonl",
    transcriptText("codex", {
      cwd,
      start: dateOf(started.getTime() + 20_000),
      tag: "codex",
      extra: longMessages,
    }),
  );
  const baseUrl = await launch();
  await openLeadTranscript(page, baseUrl, run);
  const rows = page.getByTestId("transcript-entry");
  const inspector = page.getByTestId("inspector");
  const mode = page.locator('.filterbar .seg [aria-pressed="true"]');
  const openFile = async (name: string, count: number) => {
    await page.locator(`[data-testid="transcript-file"][data-file$="${name}"]`).click();
    await expect(rows).toHaveCount(count);
  };
  // The raw text of the inspector holds every line; the rendered text holds the last one.
  const holdsAllLines = async (count: number) => {
    await expect(inspector.getByTestId("entry-text")).toContainText(`line ${count} of ${count}`);
    await page.keyboard.press("r");
    await expect(mode).toHaveText("Raw");
    expect((await inspector.getByTestId("entry-text").textContent())!.split("\n")).toHaveLength(
      count,
    );
    await page.keyboard.press("r");
    await expect(mode).toHaveText("Rendered");
  };

  // omp: a context of 114 lines is one row, and the turn below it is in view.
  await openFile("lead.jsonl", 10);
  const contextRow = rowWith(page, "# Injected context");
  await expect(contextRow).toHaveCount(1);
  const contextBox = (await contextRow.boundingBox())!;
  expect(contextBox.height).toBeLessThan(34);
  const next = (await rowWith(page, "after context").boundingBox())!;
  expect(next.y - contextBox.y).toBeLessThan(40);
  await checkpoint(page, "context-row-dark");
  await contextRow.click();
  await expect(inspector.locator(".md h1")).toHaveText("Injected context");
  await expect(inspector.locator(".md li")).toHaveCount(108);
  await expect(inspector.locator(".md li").last()).toHaveText("item 108");
  await expect(inspector.getByTestId("code-block")).toContainText("const last = 114;");
  await checkpoint(page, "context-inspector-full");
  await page.keyboard.press("r");
  await expect(mode).toHaveText("Raw");
  expect((await inspector.getByTestId("entry-text").textContent())!.split("\n")).toHaveLength(114);
  await page.keyboard.press("r");

  // Thinking is folded until a click.
  await rowWith(page, "folded thought").click();
  const thinking = inspector.getByTestId("thinking");
  await expect(thinking).toHaveJSProperty("open", false);
  await expect(inspector.getByTestId("entry-text")).toBeHidden();
  await checkpoint(page, "thinking-folded");
  await thinking.locator("summary").click();
  await expect(inspector.getByTestId("entry-text")).toHaveText("folded thought");

  // Claude and Codex show injected text as a user message: each of 114, 41 and 40 lines is one row.
  for (const name of ["claude.jsonl", "codex.jsonl"]) {
    await openFile(name, name === "claude.jsonl" ? 10 : 8);
    if (name === "claude.jsonl") {
      await rowWith(page, "src/a.ts").click();
      await expect(inspector.getByTestId("code-block").locator(".lang")).toHaveText("diff");
      await expect(inspector.getByTestId("code-block").locator("pre")).toHaveText(
        "- const a = 1;\n+ const a = 2;",
      );
      await expect(inspector).toContainText("src/a.ts");
      await rowWith(page, "src/b.ts").click();
      await expect(inspector.getByTestId("code-block").locator(".lang")).toHaveText("ts");
      await expect(inspector.getByTestId("code-block").locator("pre")).toHaveText(
        "export const b = 3;",
      );
    }
    for (const count of [114, 41, 40]) {
      const row = rowWith(page, `line 1 of ${count}`);
      await expect(row).toHaveCount(1);
      expect((await row.boundingBox())!.height).toBeLessThan(34);
      await row.click();
      await holdsAllLines(count);
    }
  }

  // The run files are pinned below the list and open in the same inspector.
  await openFile("lead.jsonl", 10);
  const files = page.getByTestId("transcript-run-file");
  const paths = await files.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-path")),
  );
  expect(paths).toEqual(
    expect.arrayContaining(["plan.md", "results/state.json", "results/notes.txt"]),
  );
  expect(paths).not.toContain("strategies.md");
  expect(paths).not.toContain("retro.md");
  const listBox = (await page.getByTestId("transcript").boundingBox())!;
  expect((await files.first().boundingBox())!.y).toBeGreaterThan(listBox.y + listBox.height - 1);
  const url = page.url();
  await files.filter({ hasText: /^plan\.md$/ }).click();
  await expect(inspector.locator("h1")).toHaveText("Plan title");
  await expect(inspector.locator("strong")).toHaveText("bold plan");
  await checkpoint(page, "run-file-in-inspector");
  await files.filter({ hasText: "state.json" }).click();
  await expect(inspector.getByTestId("json-block").locator(".tk-key")).toHaveText([
    '"phase"',
    '"count"',
  ]);
  await files.filter({ hasText: "notes.txt" }).click();
  await expect(inspector.getByTestId("code-block").locator(".lang")).toHaveText("text");
  await expect(inspector.getByTestId("code-block").locator("pre")).toHaveText(
    "**not bold**\n- not a list",
  );
  expect(page.url()).toBe(url);
  await expect(rows).toHaveCount(10);
  await rowWith(page, "after answer").click();
  await expect(inspector.getByTestId("entry-text")).toHaveText("after answer");

  // Raw is the inspector's: a file selected while Raw is on shows its source, and r switches it.
  await page.keyboard.press("r");
  await expect(mode).toHaveText("Raw");
  await files.filter({ hasText: /^plan\.md$/ }).click();
  await expect(inspector.locator("pre.raw")).toHaveText("# Plan title\n\n**bold plan**\n");
  await expect(inspector.getByTestId("run-file-text")).toBeVisible();
  await page.keyboard.press("r");
  await expect(mode).toHaveText("Rendered");
  await expect(inspector.locator("h1")).toHaveText("Plan title");
  await expect(inspector.locator("pre.raw")).toHaveCount(0);

  // Selecting a file brings the inspector into view even when the list is long.
  await expect(inspector).toBeInViewport();

  // The full-page file route still works.
  await open(page, baseUrl, `run/${run}/file/plan.md`);
  await expect(page.getByTestId("run-file-text").locator("h1")).toHaveText("Plan title");
});

test("ARK-T300 a transcript shows 200 entries a page and Load more adds the next page, and at the end of a live file it checks for new entries", async ({
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
  await expect(more).toHaveText("Check for new entries");
  await expect(page.getByText("End of file · 450 entries")).toBeVisible();
  await expect(entries.last()).toContainText("m449");

  // The live file grows after the page loaded: the same control adds the new entry.
  appendFileSync(
    join(sessions, "long.jsonl"),
    `${JSON.stringify({
      type: "message",
      id: "live",
      timestamp: dateOf().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "live arrival" }] },
    })}\n`,
  );
  await more.click();
  await expect(entries).toHaveCount(451);
  await expect(entries.last()).toContainText("live arrival");
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

test("ARK-T182 the run page links the run files that exist, shows them rendered, a missing file has no link, and a path outside the run folder answers 404", async ({
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
  // Rendered through Markdown: the heading is an element, the raw tag is text and makes no element.
  await expect(page.getByTestId("run-file-text").locator("h1")).toHaveText("Plan");
  await expect(page.getByTestId("run-file-text")).toContainText("<b>not markup</b>");
  await expect(page.getByTestId("run-file-text").locator("b")).toHaveCount(0);
  await open(page, baseUrl, `run/${run}`);
  await links.filter({ hasText: "note.md" }).click();
  await expect(page.getByTestId("run-file-text")).toContainText("FINDING-BODY");
  // A nested path with plain slashes opens too, as a hand-written or pasted link does.
  await page.goto(`${baseUrl}/#/run/${run}/file/findings/note.md`);
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

const usageAt = (fraction: number, baseInstant = testNow()) => ({
  reports: [
    {
      provider: "anthropic",
      fetchedAt: testNow(),
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
async function homeWithBlockers(
  baseInstant = testNow(),
  holdOrca = false,
  /** Runs once the fixture is written and before the hub starts. */
  beforeLaunch?: (stuckDirectory: string) => void,
) {
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
            updatedAt: testNow(),
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
    ompUsage: usageAt(0.82, baseInstant),
    plannotatorSessions: [
      { index: 1, target: join(gate, "ticket.md"), url: "http://localhost:20000/review/gate" },
    ],
  });
  // Held fake tools make the first snapshot late until `release` runs.
  const release = holdOrca ? holdFakeTools() : () => {};
  beforeLaunch?.(stuckDirectory);
  return { baseUrl: await launch(), older, newer, stuckRun, release };
}

/** The fixture and the page clock share one instant in UTC, so the reset form (HH:MM or date and time) never depends on when the suite runs. */
test.describe("the usage reset on a frozen clock", () => {
  test.use({ timezoneId: "UTC" });
  const day = dateOf().toISOString().slice(0, 10);
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

test("ARK-T152 Runs shows every run on one board and graph with filters, rings of steps done, dashed edges to open tickets and what each run unblocks", async ({
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
  // Master Chief's queue holds the Task of ARK-603 (the Queued lane).
  installFakeTools({});
  installChiefOrca({ ready: ["ARK-603 Title of ARK-603"] });
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
  // Closed: all 6 show (the lane pages by 20), with no older-runs control.
  await expect(lane("Closed").getByTestId("run-card")).toHaveCount(6);
  await expect(lane("Closed").getByTestId("older-runs")).toHaveCount(0);

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
  // The Old count is of tickets, labelled apart from the Closed run count (ARK-T226).
  await expect(filter("Old")).toHaveText(/Old\s*6\s*tickets/);
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

  // A click on a run opens its run page.
  await lane("Building").locator('[data-ticket="ARK-601"]').click();
  await expect(page).toHaveURL(new RegExp(`#/run/${runId("ARK-601")}$`));
  await expect(page.locator("main h1")).toContainText("ARK-601");
});

/** The Roadmap of ARK-T26: 44 open tickets, so the page scrolls. */
function roadmapOf44(): void {
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
}

test("ARK-T117 Esc from a ticket page returns the Roadmap to the scroll position read while the stale chip showed, after the chip vanishes", async ({
  page,
}) => {
  isolate();
  roadmapOf44();
  // A run at a gate: Plannotator is read (and held) only while a gate is open.
  writeRun({
    project: "p",
    run: runId("ARK-707"),
    ticket: { id: "ARK-707", title: "Gate" },
    phase: "awaiting_criteria",
  });
  const release = holdFakeTools();
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "roadmap");
  const chip = page.getByTestId("stale-chip");
  // 4 or more sources behind the one chip: its label counts the others as `+3` or more.
  await expect(chip).toHaveText(/ \+([3-9]|\d\d+)$/);
  const selected = page.locator('[data-testid="ticket-row"][aria-current="true"]');
  await expect(selected).toHaveAttribute("data-ticket", "ARK-701");
  for (let press = 0; press < 30; press++) await page.keyboard.press("j");
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(100);
  // The read above had the chip; it vanishes now, before Enter and Esc.
  await expect(chip).toBeVisible();
  const target = (await selected.getAttribute("data-ticket"))!;
  release();
  await expect(chip).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/ticket/${target}$`));
  await expect(page.getByTestId("ticket-page")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/roadmap$/);
  await expect(selected).toHaveAttribute("data-ticket", target);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
});

test("ARK-T118 The hub header has the same height with 0, 1 and 4 or more stale sources", async ({
  page,
}) => {
  isolate();
  roadmapOf44();
  // A run at a gate: Plannotator is read (and held) only while a gate is open.
  writeRun({
    project: "p",
    run: runId("ARK-707"),
    ticket: { id: "ARK-707", title: "Gate" },
    phase: "awaiting_criteria",
  });
  const release = holdFakeToolsOneByOne();
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "roadmap");
  const chip = page.getByTestId("stale-chip");
  await expect(chip).toHaveText(/ \+([3-9]|\d\d+)$/); // 4 or more stale sources
  const header = page.locator("header.top");
  const heightOf = async () => (await header.boundingBox())!.height;
  await checkpoint(page, "header-with-chip");
  const heightAtFour = await heightOf();
  // The chip and every chip of the nav lie inside the header box.
  const box = (await header.boundingBox())!;
  for (const part of await page.locator(".nav-right > *, [data-testid=stale-chip]").all()) {
    const inner = await part.boundingBox();
    if (!inner) continue; // an empty wrapper has no box
    expect(inner.y).toBeGreaterThanOrEqual(box.y);
    expect(inner.y + inner.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
  }
  // Orca (orca, agent wait and queue) and omp (usage and provider limits) answer: Plannotator alone is stale.
  release.orca();
  release.omp();
  await expect(chip).toHaveText(/^plannotator /);
  await expect(chip).not.toContainText("+");
  expect(await heightOf()).toBe(heightAtFour);
  release.gh();
  release.plannotator();
  await expect(chip).toHaveCount(0);
  await checkpoint(page, "header-without-chip");
  expect(await heightOf()).toBe(heightAtFour);
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
  await expect(page.getByTestId("ticket-problem").locator("b")).toHaveCount(0);
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

/** WCAG contrast of the element's own text colour on its own background colour, as the browser computed them now. */
function contrastRatioOf(element: Locator): Promise<number> {
  return element.evaluate((node) => {
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
    const style = getComputedStyle(node);
    const [one, two] = [light(style.color), light(style.backgroundColor)].sort((a, b) => b - a);
    return (one + 0.05) / (two + 0.05);
  });
}

test("ARK-T96 the theme follows the system, the nav switch sets Auto, Light or Dark and keeps it after a reload, and text keeps its contrast on Home, Runs and a ticket page in both themes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The fake Orca is held: the first snapshot is late until the test releases it.
  const { baseUrl, release } = await homeWithBlockers(testNow(), true);
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
  // The gate link is not an agent action: the held gate's own snapshot already draws it.
  const actions = page.locator(
    '.btn.primary:not(:disabled):not([data-testid="gate-link"]), .btn-orca:not(:disabled)',
  );
  await expect(page.getByTestId("stuck")).toHaveCount(1, { timeout: 20_000 });
  await expect(actions).toHaveCount(0);
  release();
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
      await finiteAnimationsEnded(page);
      // A live-change highlight is not a finite animation: poll until the colours rest, same threshold.
      let checkedCount = 0;
      await expect
        .poll(
          async () => {
            const result = await weakContrast(page);
            checkedCount = result.checked;
            return result.weak;
          },
          { message: `${name} in ${choice}`, timeout: 15_000 },
        )
        .toEqual([]);
      expect(checkedCount, `text checked on ${name} in ${choice}`).toBeGreaterThan(20);
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
    const ratio = await contrastRatioOf(action);
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
  installFakeTools({});
  const firstHub = await launch();
  // One hub per ARK_HOME: the second hub gets its own.
  const secondHome = tempArkHome();
  expect(firstHome).not.toBe(secondHome);
  installFakeTools({});
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
  const { baseUrl, release } = await homeWithBlockers(testNow(), true);
  // The gate link is not an agent action: the held gate's own snapshot already draws it.
  const actions = page.locator(
    '.btn.primary:not(:disabled):not([data-testid="gate-link"]), .btn-orca:not(:disabled)',
  );
  await open(page, baseUrl, "");
  await expect(actions).toHaveCount(0);
  release();
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
  // The transition has ended: the resting colours of the hovered button keep 4.5:1.
  expect(await contrastRatioOf(action), "hovered first action of Home").toBeGreaterThanOrEqual(4.5);
});

test("ARK-T301 #/map redirects to #/runs and the nav lists Home, Runs, Roadmap and Resources", async ({
  page,
}) => {
  isolate();
  installFakeTools({});
  const baseUrl = await launch();
  await page.goto(`${baseUrl}/#/map`);
  await expect(page.getByTestId("lane")).toHaveCount(5);
  await expect(page).toHaveURL(/#\/runs$/);
  const links = page.getByRole("navigation", { name: "Views" }).getByRole("link");
  await expect(links).toHaveText(["Home", "Runs", "Roadmap", "Resources"]);
});

test("ARK-T27 Home, Runs and Roadmap send no request after the first load, and a ticket page and a run page read only their own text", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { baseUrl, older, stuckRun } = await homeWithBlockers(testNow(), false, (stuckDirectory) =>
    writeSessionFile(
      process.env.ARK_OMP_SESSIONS as string,
      "t27.jsonl",
      transcriptText("omp", {
        cwd: join(stuckDirectory, "workspace"),
        start: dateOf(testNow() - 3_600_000 + 300_000),
        extra: Array.from({ length: 195 }, (_, number): ExtraEntry => ({
          kind: "call",
          id: `c${number}`,
          args: { command: `command ${number}` },
          result: `result ${number}`,
        })),
      }),
    ),
  );
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
  await expect(page.getByTestId("stale-chip")).toHaveCount(0);
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

  // A transcript of 200 rows sends one read of its page: no read per row, no result read, no run file read before a click.
  await open(page, baseUrl, `run/${stuckRun}`);
  const stepLink = page.locator('[data-testid="step-node"][data-step="hub-server"] a');
  await expect(stepLink).toBeVisible();
  requests.splice(0);
  await stepLink.click();
  await expect(page.getByTestId("transcript-entry")).toHaveCount(200);
  await expect(page.getByTestId("transcript-run-file").first()).toBeVisible();
  // Two frames later every effect of the 200 rows has run and its request is logged.
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    return promise;
  });
  expect(requests.filter((path) => path.startsWith("/api/"))).toEqual([
    `/api/run/${stuckRun}/transcript`,
  ]);
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

test("ARK-T301 the nav lists Home, Runs, Roadmap and Resources, and #/backlog and #/backlog/<ticket> redirect to #/roadmap and #/roadmap/<ticket>", async ({
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
  await expect(links).toHaveText(["Home", "Runs", "Roadmap", "Resources"]);
  await expect(page.getByRole("navigation", { name: "Views" })).not.toContainText("Backlog");
  await expect(links.nth(2)).toHaveAttribute("href", "#/roadmap");
});

test("ARK-T259 Roadmap Now shows cards and Next, Later and Unranked rows in rank order with the derived ticket state", async ({
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
  // The run phase while a run is open, else the derived queue state of a ready ticket (the fixture queue holds no Task); a proposed ticket has its badge.
  await expect(rowOf(page, "ARK-101").getByTestId("status-chip")).toHaveText(/build/i);
  await expect(rowOf(page, "ARK-102").getByTestId("status-chip")).toHaveText(
    "approved, not queued",
  );
  await expect(rowOf(page, "ARK-103").getByTestId("status-chip")).toHaveText("proposed");
  await expect(rowOf(page, "ARK-104").getByTestId("status-chip")).toHaveText("blocked");

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

test("ARK-T316 ARK-291-AC9 j k / Enter and Esc work on Roadmap, Esc returns to the same scroll position, and text keeps 4.5:1 (3:1 large) in light and dark", async ({
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
  await expect(page.getByTestId("stale-chip")).toHaveCount(0); // the nav stops growing once every source has answered
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
      await finiteAnimationsEnded(page);
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
    const now = dateOf();
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
    created_at: dateOf().toISOString(),
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
            updatedAt: testNow(),
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

test("ARK-T370 Home counts only the chosen project in its tiles, lists, cost and the header, and the provider limit says all projects, for All, each project and after a reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const baseUrl = await homeWorld();
  // The page dates today's cost by its own clock: put it on the frozen instant of the fixtures.
  await page.clock.setFixedTime(testNow());
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

test("ARK-T136 ARK-309-AC5 a ticket and a run of another project open by direct link with their project, say Outside the filter with a link, keep the filter in the control, and Esc and the back links return with it", async ({
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
  await expect(page.getByTestId("stale-chip")).toHaveCount(0); // the layout settles once every source has answered
  const item = page.locator('[data-testid="review-item"][data-ticket="ARK-939"]');
  await item.evaluate((node) => node.scrollIntoView({ block: "center" }));
  // Click only on the final geometry: no animation runs and the box is equal across two frames.
  await settledBoxes(page, ['[data-testid="review-item"][data-ticket="ARK-939"]']);
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

test("ARK-T317 ARK-309-AC8 a filter change on Home, Runs and Roadmap sends no request, and / and /nope answer with a p95 under 200 ms", async ({
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
    await expect(page.getByTestId("stale-chip")).toHaveCount(0); // the first load is complete
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
    dateOf(started.getTime() + (100 + 600 + 10) * 1000),
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
              updatedAt: name === "finished" ? testNow() - 3_600_000 : testNow(),
            })),
            { taskTitle: "Master Chief: p tickets", state: "working", updatedAt: testNow() },
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

test("ARK-T318 ARK-293-AC5 with session models on the run page, / and /nope answer with a p95 under 200 ms and the page sends no request but the ones ARK-285 allows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { run } = agentStateWorld();
  const baseUrl = await launch();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));

  await open(page, baseUrl, "");
  await expect(page.getByTestId("run")).toHaveCount(1);
  await expect(page.getByTestId("stale-chip")).toHaveCount(0);
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
  const after = (seconds: number) => dateOf(startedAt.getTime() + seconds * 1000);
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
    // The criteria sit in the right column under the graph band: scroll to them first.
    await warning(id).scrollIntoViewIfNeeded();
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
 * `targets + 40` presses (the ticket page holds the nav, the graph controls and the outline bar first).
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
  for (let press = 0; press < count + 40; press++) {
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
  const settled = () => finiteAnimationsEnded(page);
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

// ---------------------------------------------------------------- ARK-353 closed runs

const closedRunId = (ticket: string) => runId(ticket);
const closedTicket = (id: string) => ({ id, title: `Title of ${id}` });
const bandOf = (page: Page) => page.getByTestId("closed-band");

test("ARK-T144 the page of a merged closed run opens with a summary band of outcome, wall time, ACs and metrics", async ({
  page,
}) => {
  isolate();
  const run = closedRunId("ARK-801");
  writeRun({
    project: "p",
    run,
    ticket: closedTicket("ARK-801"),
    phase: "closed",
    outcome: "merged",
    closedAfter: 4320,
    criteria: ["A1", "A2", "A3", "A4"],
    statuses: { A1: "passing", A2: "passing", A3: "passing", A4: "failing" },
    metricsText: JSON.stringify({
      cost: { total_usd: 4.2 },
      rework: { rounds: 2 },
      time: { wall_seconds: 60 },
    }),
  });
  installFakeTools({});
  await open(page, await launch(), `run/${run}`);

  const band = bandOf(page);
  await expect(band).toBeVisible();
  await expect(band.getByTestId("band-outcome")).toHaveText("merged");
  await expect(band.getByTestId("band-wall")).toHaveText("1h 12m");
  await expect(band.getByTestId("band-acs")).toHaveText("3 of 4");
  await expect(band.getByTestId("band-cost")).toHaveText("$4.20");
  await expect(band.getByTestId("band-rounds")).toHaveText("2");
  // Above the plan, and the outcome shows once.
  const bandTop = (await band.boundingBox())!;
  const planTop = (await page.locator(".plan-panel").boundingBox())!;
  expect(bandTop.y + bandTop.height).toBeLessThanOrEqual(planTop.y);
  await expect(page.getByTestId("band-outcome")).toHaveCount(1);
  await expect(page.getByTestId("closed-banner")).not.toContainText("merged");
  await checkpoint(page, "closed-band-merged");
});

test("ARK-T145 a closed run with no or damaged metrics.json shows not recorded for cost and rounds and keeps the other values", async ({
  page,
}) => {
  isolate();
  const make = (ticket: string, extra: Partial<FixtureRun>) => {
    writeRun({
      project: "p",
      run: closedRunId(ticket),
      ticket: closedTicket(ticket),
      phase: "closed",
      outcome: "merged",
      closedAfter: 2700,
      criteria: ["A1", "A2", "A3"],
      statuses: { A1: "passing", A2: "passing", A3: "failing" },
      ...extra,
    });
    return closedRunId(ticket);
  };
  const runA = make("ARK-811", {});
  const runB = make("ARK-812", { metricsText: "{ not json" });
  const runC = make("ARK-813", {
    outcome: "aborted",
    criteria: [],
    statuses: undefined,
    closedAfter: 600,
  });
  installFakeTools({});
  const baseUrl = await launch();

  for (const run of [runA, runB]) {
    await open(page, baseUrl, `run/${run}`);
    const band = bandOf(page);
    await expect(band.getByTestId("band-cost")).toHaveText("not recorded");
    await expect(band.getByTestId("band-rounds")).toHaveText("not recorded");
    await expect(band.getByTestId("band-outcome")).toHaveText("merged");
    await expect(band.getByTestId("band-wall")).toHaveText("45m");
    await expect(band.getByTestId("band-acs")).toHaveText("2 of 3");
    if (run === runA) await checkpoint(page, "closed-band-not-recorded");
  }
  await open(page, baseUrl, `run/${runC}`);
  const band = bandOf(page);
  await expect(band.getByTestId("band-outcome")).toHaveText("aborted");
  await expect(band.getByTestId("band-wall")).toHaveText("10m");
  await expect(band.getByTestId("band-acs")).toHaveText(/^(0 of 0|–)$/);
  await expect(band.getByTestId("band-cost")).toHaveText("not recorded");
  await expect(band).not.toContainText("NaN");
  await expect(band).not.toContainText("$0");
});

test("ARK-T146 the MR card of a closed run takes its state from the run outcome and gh is never asked about a closed run", async ({
  page,
}) => {
  isolate();
  const url = (number: number) => `https://github.com/example/repo/pull/${number}`;
  const outcomes = ["merged", "aborted", "abandoned", "handed_off"] as const;
  const runs = outcomes.map((outcome, index) => {
    const ticket = `ARK-82${index}`;
    writeRun({
      project: "p",
      run: closedRunId(ticket),
      ticket: closedTicket(ticket),
      phase: "closed",
      outcome,
      mergeRequests: [{ repo: ".", url: url(index + 1), number: index + 1 }],
    });
    return closedRunId(ticket);
  });
  const openRun = closedRunId("ARK-829");
  writeRun({
    project: "p",
    run: openRun,
    ticket: closedTicket("ARK-829"),
    phase: "merge_requests_open",
    mergeRequests: [{ repo: ".", url: url(9), number: 9 }],
  });
  const state = installFakeTools({});
  const baseUrl = await launch();

  // The hub reads only for a connected page: open one, then one refresh has finished once gh was asked about the open run.
  await open(page, baseUrl, "");
  const log = () =>
    existsSync(join(state, "gh.log")) ? readFileSync(join(state, "gh.log"), "utf8") : "";
  await expect.poll(log).toContain(url(9));
  await expect(page.getByTestId("mr")).toHaveAttribute("data-state", "open");

  const expected = ["merged", "closed", "closed", null];
  for (const [index, run] of runs.entries()) {
    await open(page, baseUrl, `run/${run}`);
    await expect(bandOf(page)).toBeVisible();
    if (expected[index] === null) await expect(page.getByTestId("mr")).toHaveCount(0);
    else await expect(page.getByTestId("mr-state")).toHaveText(expected[index]);
    await checkpoint(page, `closed-mr-${outcomes[index]}`);
  }
  // Let another refresh run, then read the log.
  await expect.poll(() => log().split(url(9)).length - 1).toBeGreaterThan(1);
  const asked = log();
  expect(asked).toContain(url(9));
  for (const number of [1, 2, 3, 4]) expect(asked).not.toContain(url(number));
});

test("ARK-T147 the band links retro.md and each findings file that exists and no link for an absent file", async ({
  page,
}) => {
  isolate();
  const runA = closedRunId("ARK-831");
  const runB = closedRunId("ARK-832");
  const directoryA = writeRun({
    project: "p",
    run: runA,
    ticket: closedTicket("ARK-831"),
    phase: "closed",
    outcome: "merged",
  });
  writeRun({
    project: "p",
    run: runB,
    ticket: closedTicket("ARK-832"),
    phase: "closed",
    outcome: "merged",
  });
  mkdirSync(join(directoryA, "findings"), { recursive: true });
  writeFileSync(join(directoryA, "retro.md"), "# Retro text\n");
  writeFileSync(join(directoryA, "findings", "review round 1.md"), "round one text\n");
  writeFileSync(join(directoryA, "findings", "qe.md"), "qe text\n");
  installFakeTools({});
  const baseUrl = await launch();

  await open(page, baseUrl, `run/${runA}`);
  const links = bandOf(page).getByTestId("band-link");
  await expect(links).toHaveCount(3);
  expect(
    await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-path"))),
  ).toEqual(["retro.md", "findings/qe.md", "findings/review round 1.md"]);
  const texts: Record<string, string> = {
    "retro.md": "# Retro text",
    "findings/qe.md": "qe text",
    "findings/review round 1.md": "round one text",
  };
  for (const [path, text] of Object.entries(texts)) {
    const response = await page.request.get(
      `${baseUrl}/api/run/${runA}/file?path=${encodeURIComponent(path)}`,
    );
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(text);
  }
  // A click opens the file in the page, also for the name with a space.
  await links.filter({ hasText: "review round 1.md" }).click();
  await expect(page.getByText("round one text")).toBeVisible();
  await checkpoint(page, "closed-band-links");

  // Without the files: no link, no placeholder.
  await open(page, baseUrl, `run/${runB}`);
  await expect(bandOf(page)).toBeVisible();
  await expect(page.getByTestId("band-link")).toHaveCount(0);
  await checkpoint(page, "closed-band-no-links");

  // Delete retro.md and reload: its link goes.
  rmSync(join(directoryA, "retro.md"));
  await open(page, baseUrl, `run/${runA}`);
  await expect(page.getByTestId("band-link")).toHaveCount(2);
  await expect(page.locator('[data-testid="band-link"][data-path="retro.md"]')).toHaveCount(0);
});

test("ARK-T148 the band lists the escaped defects of this run from escaped-defects.yml and nothing for a run with none", async ({
  page,
}) => {
  isolate();
  const make = (ticket: string) => {
    writeRun({
      project: "p",
      run: closedRunId(ticket),
      ticket: closedTicket(ticket),
      phase: "closed",
      outcome: "merged",
      metricsText: JSON.stringify({
        cost: { total_usd: 1 },
        rework: { rounds: 0 },
        escaped_defects: 0,
      }),
    });
    return closedRunId(ticket);
  };
  const runA = make("ARK-841");
  const runB = make("ARK-842");
  const runC = make("ARK-843");
  const file = join(process.env.ARK_HOME as string, "projects", "p", "escaped-defects.yml");
  writeFileSync(
    file,
    [
      { ticket: "ARK-901", run: runA, note: "first <b>x</b> note", fix: "fix one", reviewer: "r" },
      { ticket: "ARK-902", run: runA, note: "second note", fix: "fix two", reviewer: "r" },
      { ticket: "ARK-903", run: runB, note: "other run note", fix: "other fix", reviewer: "r" },
    ]
      .map(
        (entry) =>
          `- ticket: ${entry.ticket}\n  run: ${entry.run}\n  note: ${JSON.stringify(entry.note)}\n  fix: ${JSON.stringify(entry.fix)}\n  reviewer: ${entry.reviewer}\n`,
      )
      .join(""),
  );
  installFakeTools({});
  const baseUrl = await launch();

  await open(page, baseUrl, `run/${runA}`);
  const defects = page.getByTestId("band-defect");
  await expect(defects).toHaveCount(2);
  await expect(defects.nth(0)).toContainText("ARK-901");
  await expect(defects.nth(0)).toContainText("first <b>x</b> note");
  await expect(defects.nth(0)).toContainText("fix one");
  await expect(defects.nth(1)).toContainText("ARK-902");
  await expect(defects.nth(1)).toContainText("fix two");
  await expect(bandOf(page)).not.toContainText("other run note");
  await expect(bandOf(page).locator("b")).toHaveCount(2); // the two ticket ids, no <b> from the note
  await checkpoint(page, "closed-band-defects");

  await open(page, baseUrl, `run/${runC}`);
  await expect(bandOf(page)).toBeVisible();
  await expect(page.getByTestId("band-defect")).toHaveCount(0);
  await expect(bandOf(page).getByRole("heading")).toHaveCount(0);
  await checkpoint(page, "closed-band-no-defects");

  writeFileSync(file, "- ticket: [unclosed\n  run: {\n");
  await open(page, baseUrl, `run/${runA}`);
  await expect(bandOf(page)).toBeVisible();
  await expect(page.getByTestId("band-defect")).toHaveCount(0);
  rmSync(file);
  await open(page, baseUrl, `run/${runA}`);
  await expect(bandOf(page)).toBeVisible();
  await expect(page.getByTestId("band-defect")).toHaveCount(0);
});

test("ARK-T149 the Closed lane shows 20 closed runs with outcome and cost and Show more adds 20 until all 45 show", async ({
  page,
}) => {
  isolate();
  const ids = Array.from({ length: 45 }, (_, index) => `ARK-${900 + index}`);
  const withoutMetrics = new Set(["ARK-901", "ARK-920", "ARK-944"]);
  for (const [index, id] of ids.entries()) {
    writeBacklogTicket({ project: "p", id, title: `Title of ${id}`, status: "done" });
    writeRun({
      project: "p",
      run: closedRunId(id),
      ticket: closedTicket(id),
      phase: "closed",
      outcome: index % 9 === 4 ? "aborted" : "merged",
      startedAt: ago(200_000 - index * 3000),
      ...(withoutMetrics.has(id) ? {} : { metricsCostUsd: 1 + index }),
    });
  }
  for (const id of ["ARK-950", "ARK-951"]) {
    writeBacklogTicket({ project: "p", id, title: `Title of ${id}`, status: "ready" });
    writeRun({
      project: "p",
      run: closedRunId(id),
      ticket: closedTicket(id),
      phase: "building",
      steps: [{ id: "only", role: "implementer", harness: "omp", model: "m", needs: [] }],
    });
  }
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "runs");
  const closed = page.locator('[data-testid="lane"][data-lane="Closed"]');
  const cards = closed.getByTestId("run-card");
  const runsOf = () =>
    cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-run")));
  const newestFirst = ids.map(closedRunId).toSorted().reverse();

  await expect(cards).toHaveCount(20);
  expect(await runsOf()).toEqual(newestFirst.slice(0, 20));
  const card = (id: string) => closed.locator(`[data-run="${closedRunId(id)}"]`);
  await expect(card("ARK-944").getByTestId("card-outcome")).toHaveText("merged");
  await expect(card("ARK-944").getByTestId("card-cost")).toHaveText("not recorded");
  await expect(card("ARK-943").getByTestId("card-cost")).toHaveText("$44.00");
  await expect(cards.first().getByTestId("card-outcome")).toBeVisible();
  await checkpoint(page, "closed-lane-20");

  await closed.getByTestId("show-more").click();
  await expect(cards).toHaveCount(40);
  expect(await runsOf()).toEqual(newestFirst.slice(0, 40));
  await closed.getByTestId("show-more").click();
  await expect(cards).toHaveCount(45);
  expect(await runsOf()).toEqual(newestFirst);
  await expect(closed.getByTestId("show-more")).toHaveCount(0);
  await expect(closed.getByTestId("older-runs")).toHaveCount(0);
  await expect(card("ARK-901").getByTestId("card-cost")).toHaveText("not recorded");
  await expect(card("ARK-920").getByTestId("card-cost")).toHaveText("not recorded");
  await expect(card("ARK-904").getByTestId("card-outcome")).toHaveText("aborted");
  await expect(page.getByText("last 5")).toHaveCount(0);
  await expect(
    page.locator('[data-testid="lane"][data-lane="Building"]').getByTestId("run-card"),
  ).toHaveCount(2);
  await checkpoint(page, "closed-lane-45");
});

// ---------------------------------------------------------------- ARK-375

/** The outcome icon inside a card or graph node. */
const outcomeIcon = (scope: Locator) => scope.getByTestId("outcome-icon");

test("ARK-T225 every closed run card and graph node shows its outcome as its own icon and text for merged, aborted and handed_off", async ({
  page,
}) => {
  isolate();
  const outcomes = ["merged", "aborted", "handed_off"] as const;
  const closed = { merged: "ARK-701", aborted: "ARK-702", handed_off: "ARK-703" } as const;
  for (const [index, outcome] of outcomes.entries()) {
    const id = closed[outcome];
    writeBacklogTicket({
      project: "p",
      id,
      title: `Title of ${id}`,
      status: "done",
      ...(index > 0 ? { dependsOn: ["ARK-701"] } : {}),
    });
    writeRun({
      project: "p",
      run: runId(id),
      ticket: { id, title: `Title of ${id}` },
      phase: "closed",
      outcome,
      startedAt: ago(86_400 - index * 600),
    });
  }
  // The open ticket: ARK-704 is queued and waits on ARK-705, which builds, so Active shows both.
  writeBacklogTicket({
    project: "p",
    id: "ARK-704",
    title: "Title of ARK-704",
    status: "ready",
    dependsOn: ["ARK-705"],
  });
  writeBacklogTicket({ project: "p", id: "ARK-705", title: "Title of ARK-705", status: "ready" });
  writeRun({
    project: "p",
    run: runId("ARK-705"),
    ticket: { id: "ARK-705", title: "Title of ARK-705" },
    phase: "building",
    steps: [{ id: "only", role: "implementer", harness: "omp", model: "m", needs: [] }],
  });
  installFakeTools({});
  const baseUrl = await launch();
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, baseUrl, "runs");

  // The Closed lane: text and icon on each card, three different icons, no green check but on merged.
  const lane = page.locator('[data-testid="lane"][data-lane="Closed"]');
  const card = (outcome: keyof typeof closed) =>
    lane.locator(`[data-run="${runId(closed[outcome])}"]`);
  await expect(lane.getByTestId("run-card")).toHaveCount(3);
  await checkpoint(page, "outcomes-lane");
  const cardIcons: string[] = [];
  for (const outcome of outcomes) {
    await expect(card(outcome).getByTestId("card-outcome")).toContainText(outcome);
    await expect(outcomeIcon(card(outcome))).toHaveCount(1);
    cardIcons.push(await outcomeIcon(card(outcome)).evaluate((node) => node.outerHTML));
  }
  expect(cardIcons.every((icon) => icon.length > 0)).toBe(true);
  expect(new Set(cardIcons).size).toBe(3);
  for (const outcome of ["aborted", "handed_off"] as const) {
    await expect(card(outcome).getByTestId("ring")).not.toHaveText("✓");
    await expect(card(outcome)).not.toContainText("✓");
  }

  // The graph, Old filter: the three closed nodes with text and icon; Active is pressed on load.
  await page.locator('[data-testid="graph-filter"][data-filter="Old"]').click();
  const nodes = page.getByTestId("graph-node");
  await expect(nodes).toHaveCount(3);
  await checkpoint(page, "outcomes-graph");
  const node = (outcome: keyof typeof closed) =>
    page.locator(`[data-testid="graph-node"][data-ticket="${closed[outcome]}"]`);
  const nodeIcons: string[] = [];
  for (const outcome of outcomes) {
    await expect(node(outcome).getByTestId("graph-outcome")).toContainText(outcome);
    await expect(outcomeIcon(node(outcome))).toHaveCount(1);
    nodeIcons.push(await outcomeIcon(node(outcome)).evaluate((element) => element.outerHTML));
  }
  expect(nodeIcons.every((icon) => icon.length > 0)).toBe(true);
  expect(new Set(nodeIcons).size).toBe(3);
  for (const outcome of ["aborted", "handed_off"] as const) {
    await expect(node(outcome).getByTestId("ring")).not.toHaveText("✓");
    await expect(node(outcome)).not.toContainText("✓");
  }

  // Every glyph and outcome pill sits inside its node, and no node's content overflows it, at both widths.
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const outcome of outcomes) {
      const nodeBox = await node(outcome).boundingBox();
      expect(nodeBox).not.toBeNull();
      for (const inner of [
        outcomeIcon(node(outcome)),
        node(outcome).getByTestId("ring").locator(".oglyph"),
        node(outcome).getByTestId("graph-outcome"),
      ]) {
        const innerBox = await inner.boundingBox();
        expect(innerBox).not.toBeNull();
        expect(innerBox!.x).toBeGreaterThanOrEqual(nodeBox!.x);
        expect(innerBox!.y).toBeGreaterThanOrEqual(nodeBox!.y);
        expect(innerBox!.x + innerBox!.width).toBeLessThanOrEqual(nodeBox!.x + nodeBox!.width);
        expect(innerBox!.y + innerBox!.height).toBeLessThanOrEqual(nodeBox!.y + nodeBox!.height);
      }
      const overflow = await node(outcome).evaluate((element) => ({
        vertical: element.scrollHeight - element.clientHeight,
        horizontal: element.scrollWidth - element.clientWidth,
      }));
      expect(overflow.vertical).toBeLessThanOrEqual(0);
      expect(overflow.horizontal).toBeLessThanOrEqual(0);
    }
  }

  // The open tickets show no outcome.
  await page.locator('[data-testid="graph-filter"][data-filter="Active"]').click();
  await expect(nodes).toHaveCount(2);
  for (const id of ["ARK-704", "ARK-705"]) {
    const open = page.locator(`[data-testid="graph-node"][data-ticket="${id}"]`);
    await expect(open).toHaveCount(1);
    await expect(open.getByTestId("graph-outcome")).toHaveCount(0);
    await expect(outcomeIcon(open)).toHaveCount(0);
  }
});

test("ARK-T226 the closed-run count in the page header equals the Closed lane count with 45 closed runs", async ({
  page,
}) => {
  isolate();
  const project = "p";
  const closedRun = (ticket: string, number: number, secondsAgo: number) =>
    writeRun({
      project,
      run: runId(ticket, number),
      ticket: { id: ticket, title: `Title of ${ticket}` },
      phase: "closed",
      outcome: "merged",
      startedAt: ago(secondsAgo),
    });
  const backlog = (id: string, status: string) =>
    writeBacklogTicket({ project, id, title: `Title of ${id}`, status });
  // 40 single-run tickets.
  for (let number = 1; number <= 40; number++) {
    const id = `ARK-${1000 + number}`;
    backlog(id, "done");
    closedRun(id, 1, 200_000 - number * 100);
  }
  // 2 closed runs of one done ticket.
  backlog("ARK-1041", "done");
  closedRun("ARK-1041", 1, 100_000);
  closedRun("ARK-1041", 2, 90_000);
  // 1 closed run of a ticket whose newer run builds: the ticket is open.
  backlog("ARK-1042", "ready");
  closedRun("ARK-1042", 1, 80_000);
  writeRun({
    project,
    run: runId("ARK-1042", 2),
    ticket: { id: "ARK-1042", title: "Title of ARK-1042" },
    phase: "building",
    steps: [{ id: "only", role: "implementer", harness: "omp", model: "m", needs: [] }],
  });
  // 2 closed runs of tickets that are not in the backlog.
  closedRun("ARK-1050", 1, 70_000);
  closedRun("ARK-1051", 1, 60_000);
  installFakeTools({});
  const baseUrl = await launch();
  await open(page, baseUrl, "runs");

  const lane = page.locator('[data-testid="lane"][data-lane="Closed"]');
  await expect(lane.getByTestId("run-card")).toHaveCount(20);
  await lane.getByTestId("show-more").click();
  await lane.getByTestId("show-more").click();
  await expect(lane.getByTestId("run-card")).toHaveCount(45);
  await checkpoint(page, "closed-count-45");
  await expect(lane.locator("header .count")).toHaveText("45");
  await expect(page.locator("main h1")).toContainText(/\b45 closed\b/);
  // The graph filter counts tickets, not runs: 41 closed tickets, labelled apart from the 45 runs.
  await expect(page.locator('[data-testid="graph-filter"][data-filter="Old"]')).toHaveText(
    /Old\s*41\s*tickets/,
  );
});

/** The one-word-per-line, clipping and wrapping problems of Home, read from real text boxes. */
async function homeFitProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    type Word = { text: string; rects: DOMRect[] };
    const wordsOf = (element: Element): Word[] => {
      const found: Word[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        for (const match of (text as Text).data.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(text, match.index);
          range.setEnd(text, match.index + match[0].length);
          found.push({ text: match[0], rects: [...range.getClientRects()] });
        }
      }
      return found;
    };
    const linesOf = (words: Word[]) => {
      const tops = new Map<number, number>();
      for (const word of words)
        for (const rect of word.rects)
          tops.set(Math.round(rect.top), (tops.get(Math.round(rect.top)) ?? 0) + 1);
      return [...tops.values()];
    };
    const label = (element: Element) =>
      `${element.getAttribute("data-testid") ?? element.className} "${element.textContent?.trim().slice(0, 40)}"`;

    // Tile text: no tile lets its text fall one word per line, and no word leaves its tile.
    for (const tile of document.querySelectorAll('[data-testid="tile"]')) {
      const box = tile.getBoundingClientRect();
      if (tile.scrollWidth > tile.clientWidth + 1) problems.push(`tile overflows: ${label(tile)}`);
      for (const text of tile.querySelectorAll(".tile-label, .tile-note")) {
        const words = wordsOf(text);
        const lines = linesOf(words);
        if (words.length >= 3 && lines.every((count) => count === 1))
          problems.push(`one word per line: ${label(text)}`);
        if (lines.length > 3) problems.push(`${lines.length} lines: ${label(text)}`);
        if (words.some((word) => word.rects.length > 1))
          problems.push(`word broken: ${label(text)}`);
        if (words.some((word) => word.rects.some((rect) => rect.right > box.right + 0.5)))
          problems.push(`text leaves its tile: ${label(text)}`);
      }
    }
    // Dates: a tile note that holds a time, and the age, idle and waited times of the rows.
    const dates = [
      ...document.querySelectorAll(
        '[data-testid="run-age"], [data-testid="run-idle"], [data-testid="waited"]',
      ),
      ...[...document.querySelectorAll(".tile-note")].filter((note) =>
        /yesterday|ago|resets/.test(note.textContent ?? ""),
      ),
    ];
    if (dates.length < 4) problems.push(`only ${dates.length} dates on the page`);
    for (const date of dates) {
      const parent = date.closest(".tile, .panel")!.getBoundingClientRect();
      if (date.scrollWidth > date.clientWidth + 1) problems.push(`date clipped: ${label(date)}`);
      if (wordsOf(date).some((word) => word.rects.some((rect) => rect.right > parent.right + 0.5)))
        problems.push(`date outside its box: ${label(date)}`);
    }
    // Ticket ids: one line, in one piece.
    const ids = [
      ...document.querySelectorAll(
        '[data-testid="gate"] .item-head a.mono, [data-testid="run"] .item-head a.mono, [data-testid="review"] .item-head a.mono',
      ),
      document.querySelector('[data-tile="needs-me"] .tile-note')!,
    ];
    if (ids.length < 4) problems.push(`only ${ids.length} ticket ids on the page`);
    for (const id of ids) {
      const words = wordsOf(id);
      if (words.length !== 1 || words[0].rects.length !== 1)
        problems.push(`id wraps: ${label(id)}`);
    }
    return problems;
  });
}

/** The page clock is fixed at `instant` in UTC. The fixture dates (usage reset, run names, yesterday) must come from that same instant: the page reads "today" and "yesterday" from its own clock. */
async function checkHomeFits(page: Page, instant: number, reset: RegExp) {
  await page.clock.setFixedTime(instant);
  isolate();
  const day = dateOf(instant).toISOString().slice(0, 10);
  const yesterday = dateOf(instant - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const gate = "ARK-12345-LONG";
  writeRun({
    project: "p",
    run: `${day}-${gate}-1`,
    ticket: { id: gate, title: "Run at a gate with a title that is rather long" },
    phase: "awaiting_criteria",
  });
  const building = "ARK-12346-LONG";
  writeRun({
    project: "p",
    run: `${day}-${building}-1`,
    ticket: { id: building, title: "Run that builds with a title that is rather long" },
    phase: "building",
    steps: [
      { id: "only", role: "implementer", harness: "omp", model: "m", needs: [], startedAfter: 120 },
    ],
  });
  const review = reviewRun({
    ticket: "ARK-12347-LONG",
    title: "Ready to merge with a title that is rather long",
    number: 91,
    criteria: [["ARK-12347-LONG-AC1", "passing"]],
    createdAgo: 10_800,
    conclusion: "SUCCESS",
    size: { additions: 312, deletions: 41, changedFiles: 6 },
    findings: "### P1: a\n",
  });
  // Multi-digit KPI values: $34.52 today against $12.34 yesterday, and a limit at 82%.
  for (const [runDay, ticket, cost] of [
    [day, "ARK-12348-LONG", 34.52],
    [yesterday, "ARK-12349-LONG", 12.34],
  ] as const) {
    writeBacklogTicket({ project: "p", id: ticket, title: `Title of ${ticket}`, status: "done" });
    writeRun({
      project: "p",
      run: `${runDay}-${ticket}-1`,
      ticket: { id: ticket, title: `Title of ${ticket}` },
      phase: "closed",
      outcome: "merged",
      metricsCostUsd: cost,
    });
  }
  installFakeTools({
    mergeRequestViews: { [review.url]: review.view },
    ompUsage: usageAt(0.82, instant),
  });
  const baseUrl = await launch();
  const tile = (name: string) => page.locator(`[data-testid="tile"][data-tile="${name}"]`);
  const ready = async () => {
    await open(page, baseUrl, "");
    await expect(page.getByTestId("tile")).toHaveCount(6);
    await expect(tile("usage").locator(".big")).toHaveText("82%", { timeout: 20_000 });
    await expect(tile("usage").locator(".tile-note")).toContainText(reset);
    await expect(tile("cost").locator(".big")).toHaveText("$34.52");
    await expect(tile("cost").locator(".tile-note")).toContainText("yesterday");
    await expect(tile("needs-me").locator(".tile-note")).toHaveText(gate);
    await expect(page.getByTestId("run")).toHaveCount(3);
    await expect(page.getByTestId("review")).toHaveCount(1);
    await expect(page.getByTestId("run-age")).toHaveCount(3);
    await expect(page.getByTestId("waited")).toHaveCount(1);
  };

  await page.setViewportSize({ width: 1024, height: 800 });
  await ready();
  await checkpoint(page, "home-1024");
  await tile("cost").scrollIntoViewIfNeeded();
  expect(await homeFitProblems(page)).toEqual([]);

  // The same checks at 1280 px: the fix does not move the break.
  await page.setViewportSize({ width: 1280, height: 800 });
  await ready();
  expect(await homeFitProblems(page)).toEqual([]);
}

test.describe("Home at 1024 px on a fixed clock", () => {
  test.use({ timezoneId: "UTC" });
  const at = (time: string) => Date.parse(`${dateOf().toISOString().slice(0, 10)}T${time}:00Z`);

  test("ARK-T227 at 1024 px the Home tiles do not break one word per line, clip a date or wrap a ticket id", async ({
    page,
  }) => {
    await checkHomeFits(page, at("12:00"), /resets 13:\d\d/);
  });

  test("ARK-T262 at 1024 px and 23:30 UTC the usage reset shows its date and the Home tiles still fit", async ({
    page,
  }) => {
    await checkHomeFits(page, at("23:30"), /resets \d\d \w{3} 00:\d\d/);
  });
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
    // An animation that never ends (a spinner) is skipped: the loop would not end.
    const finite = () =>
      document
        .getAnimations()
        .filter((fade) => fade.effect?.getComputedTiming().iterations !== Infinity);
    for (;;) {
      await document.fonts.ready;
      await Promise.all(finite().map((fade) => fade.finished.catch(() => undefined)));
      await frame();
      const now = read();
      if (now === last && finite().length === 0) return JSON.parse(now);
      last = now;
    }
  }, selectors);
}

// ---------------------------------------------------------------- ARK-323

const longCodeLine = `const longLine = "${"x".repeat(300)}";`;
/** Every markdown token class once. No line starts with `## `, which ends a ticket section: the h2 is in the plan.md of the test. */
const markdownFixture = [
  "# Heading one",
  "",
  "### Heading three",
  "",
  "A paragraph with **bold words**, *italic words*, `inline code` and a [safe link](https://example.com/page).",
  "",
  'Fish &amp; chips and [entity link](https://example.com/?a=1&amp;b=2 "t &amp; u").',
  "",
  "Literal &copycat; &notit; and [bare link](https://example.com/?a=1&notit;) keep &amp; and &#65; and &#x41; decoded.",
  "",
  "1. first step",
  "2. second step",
  "",
  "- outer item",
  "  - nested item",
  "",
  "| name | wide column |",
  "| --- | --- |",
  `| cell | ${"wide".repeat(60)} |`,
  "",
  "> quoted words",
  "",
  "---",
  "",
  "```ts",
  longCodeLine,
  "```",
].join("\n");

/** A closed run with a `plan.md`, and the files of its `results/` folder. */
function runWithFiles(
  ticket: string,
  files: Record<string, string>,
): { run: string; directory: string } {
  const run = runId(ticket);
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: ticket, title: `Files of ${ticket}` },
    phase: "closed",
  });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return { run, directory };
}

const scriptRequests = (requests: string[]) =>
  requests.filter((path) => /^\/assets\/.+\.js$/.test(path));

test("ARK-T172 Markdown renders headings, paragraphs, bold, italic, inline code, links, nested lists, GFM tables, blockquotes, rules and fenced code as elements", async ({
  page,
}) => {
  isolate();
  writeBacklogTicket({
    project: "p",
    id: "ARK-901",
    title: "Markdown fixture",
    status: "ready",
    problem: markdownFixture,
  });
  const { run } = runWithFiles("ARK-902", { "plan.md": "## Heading two\n\nBody of the plan.\n" });
  installFakeTools({});
  const baseUrl = await launch();

  await open(page, baseUrl, "ticket/ARK-901");
  const problem = page.getByTestId("ticket-problem");
  await expect(problem.locator("h1")).toBeVisible();
  await checkpoint(page, "markdown-fixture");
  await expect(problem.locator("h1")).toHaveText("Heading one");
  await expect(problem.locator("h3")).toHaveText("Heading three");
  await expect(problem.locator("p strong")).toHaveText("bold words");
  await expect(problem.locator("p em")).toHaveText("italic words");
  await expect(problem.locator("p code.ic")).toHaveText("inline code");
  const link = problem.getByRole("link", { name: "safe link" });
  await expect(link).toHaveText("safe link");
  await expect(link).toHaveAttribute("href", "https://example.com/page");
  // Character references show as their characters, in text and in a link target and title.
  await expect(problem.locator("p").nth(1)).toHaveText("Fish & chips and entity link.");
  await expect(problem.locator("p").nth(2)).toHaveText(
    "Literal &copycat; &notit; and bare link keep & and A and A decoded.",
  );
  await expect(problem.getByRole("link", { name: "bare link" })).toHaveAttribute(
    "href",
    "https://example.com/?a=1&notit;",
  );
  const entityLink = problem.getByRole("link", { name: "entity link" });
  await expect(entityLink).toHaveAttribute("href", "https://example.com/?a=1&b=2");
  await expect(entityLink).toHaveAttribute("title", "t & u");
  await expect(problem.locator("ol > li")).toHaveText(["first step", "second step"]);
  await expect(problem.locator("ul > li > ul > li")).toHaveText("nested item");
  await expect(problem.locator("thead th")).toHaveText(["name", "wide column"]);
  await expect(problem.locator("tbody td")).toHaveText(["cell", "wide".repeat(60)]);
  await expect(problem.locator("blockquote")).toHaveText("quoted words");
  await expect(problem.locator("hr")).toHaveCount(1);
  await expect(problem.getByTestId("code-block").locator(".lang")).toHaveText("ts");
  await expect(problem.getByTestId("code-block").locator("pre")).toHaveText(longCodeLine);
  // No marker of the source leaks into the text.
  expect(await problem.innerText()).not.toMatch(/[*`|]|##/);

  // A wide table and a long code line scroll in their own box, never the page.
  await checkpoint(page, "no-overflow");
  const overflow = (selector: string) =>
    problem.locator(selector).evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(await overflow(".tablewrap")).toBe(true);
  expect(await overflow("pre")).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  // The h2 of a run file.
  await open(page, baseUrl, `run/${run}/file/${encodeURIComponent("plan.md")}`);
  await expect(page.getByTestId("run-file-text").locator("h2")).toHaveText("Heading two");
});

/** Raw HTML in every position, and every link scheme of the case. */
const hostileFixture = [
  "<script>window.__xss = 1</script>",
  "",
  '<img src=x onerror="window.__xss = 2">',
  "",
  "- in a list <script>window.__xss = 3</script>",
  "",
  "| cell |",
  "| --- |",
  '| <img src=x onerror="window.__xss = 4"> |',
  "",
  '> in a quote <img src=x onerror="window.__xss = 5">',
  "",
  '[<img src=x onerror="window.__xss = 6">](https://example.com/with-tag)',
  "",
  "[a](javascript:alert(1))",
  "",
  "[b](JaVaScRiPt:alert(1))",
  "",
  "[c](  javascript:alert(1))",
  "",
  "[d](//evil.example)",
  "",
  "[e](data:text/html,x)",
  "",
  "[f](http://example.com/f) [g](https://example.com/g) [h](/local) [i](#anchor)",
].join("\n");

test("ARK-T173 Markdown makes no HTML from text: script and img onerror show as text, only http, https, / and # links are links, and no hub file uses dangerouslySetInnerHTML", async ({
  page,
}) => {
  isolate();
  writeBacklogTicket({
    project: "p",
    id: "ARK-903",
    title: "Hostile fixture",
    status: "ready",
    problem: hostileFixture,
  });
  const { run } = runWithFiles("ARK-904", { "plan.md": hostileFixture });
  installFakeTools({});
  const baseUrl = await launch();

  const surfaces: [string, string, string][] = [
    ["ticket", "ticket/ARK-903", "ticket-problem"],
    ["run file", `run/${run}/file/plan.md`, "run-file-text"],
  ];
  for (const [name, hash, testId] of surfaces) {
    await open(page, baseUrl, hash);
    const area = page.getByTestId(testId);
    await expect(area).toContainText("[e](data:text/html,x)");
    // Settled: two frames after the text shows, any element or script the page made has run.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await checkpoint(page, `raw-html-as-text-${name.replace(" ", "-")}`);
    // The tags show as text, in every position, and make no element.
    await expect(area).toContainText("<script>window.__xss = 1</script>");
    await expect(area).toContainText('<img src=x onerror="window.__xss = 2">');
    await expect(area.locator("li")).toContainText("<script>window.__xss = 3</script>");
    await expect(area.locator("td")).toContainText('<img src=x onerror="window.__xss = 4">');
    await expect(area.locator("blockquote")).toContainText(
      '<img src=x onerror="window.__xss = 5">',
    );
    await expect(area.locator("a").first()).toContainText('<img src=x onerror="window.__xss = 6">');
    await expect(area.locator("script, img")).toHaveCount(0);
    expect(await page.evaluate(() => "__xss" in window)).toBe(false);

    // Only http://, https://, / and # targets are links. `//evil.example` starts with `/`, so it is one.
    await checkpoint(page, `links-${name.replace(" ", "-")}`);
    for (const source of [
      "[a](javascript:alert(1))",
      "[b](JaVaScRiPt:alert(1))",
      "[c](  javascript:alert(1))",
      "[e](data:text/html,x)",
    ])
      await expect(area).toContainText(source);
    expect(
      await area
        .locator("a")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))),
    ).toEqual([
      "https://example.com/with-tag",
      "//evil.example",
      "http://example.com/f",
      "https://example.com/g",
      "/local",
      "#anchor",
    ]);
  }

  // No file of hub/ makes HTML from a string.
  const hubDirectory = join(import.meta.dirname, "..", "..", "hub");
  const files = (await readdir(hubDirectory, { recursive: true })).filter((path) =>
    /\.(tsx?|css|html)$/.test(path),
  );
  expect(files.length).toBeGreaterThan(20);
  const users = files.filter((path) =>
    readFileSync(join(hubDirectory, path), "utf8").includes("dangerouslySetInnerHTML"),
  );
  expect(users).toEqual([]);
});

const jsonValue = {
  name: "ark",
  count: 42,
  ok: true,
  off: false,
  none: null,
  items: Array.from({ length: 31 }, (_, index) => index + 1),
};
/** On one line, as a tool writes it: the page formats it. */
const jsonSource = JSON.stringify(jsonValue);
const copiedSource = 'const copied: string = "source";\nconsole.log(copied);';

test("ARK-T175 Json shows a 40-line value indented by 2 with token colours, folds to 12 lines behind Show all; Code shows its language label and a Copy button that copies the source", async ({
  page,
}) => {
  isolate();
  const { run } = runWithFiles("ARK-905", {
    "results/data.json": jsonSource,
    "plan.md": `\`\`\`ts\n${copiedSource}\n\`\`\`\n`,
  });
  installFakeTools({});
  const baseUrl = await launch();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });

  await open(page, baseUrl, `run/${run}/file/${encodeURIComponent("results/data.json")}`);
  const block = page.getByTestId("json-block");
  const pre = block.locator("pre");
  await expect(block.locator(".tk-key").first()).toBeVisible();
  await checkpoint(page, "json-folded");
  // Indent 2: 40 lines, the keys 2 spaces in, the items 4.
  const lines = (await pre.textContent())!.split("\n");
  expect(lines).toHaveLength(40);
  expect(lines[1]).toBe('  "name": "ark",');
  expect(lines[7]).toBe("    1,");
  // Folded: 12 of the 40 lines show, with a Show all control.
  const shown = () =>
    pre.evaluate((element) => {
      const style = getComputedStyle(element);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const lineHeight = parseFloat(style.lineHeight);
      return {
        visible: Math.round((element.clientHeight - padding) / lineHeight),
        total: Math.round((element.scrollHeight - padding) / lineHeight),
      };
    });
  expect(await shown()).toEqual({ visible: 12, total: 40 });
  // Colours: key, string, number and the literals each have their own, apart from plain text.
  const colour = (selector: string) =>
    block
      .locator(selector)
      .first()
      .evaluate((element) => getComputedStyle(element).color);
  const colours = [
    await colour(".tk-key"),
    await colour(".tk-str"),
    await colour(".tk-num"),
    await colour(".tk-lit"),
  ];
  expect(new Set(colours).size).toBe(4);
  expect(colours).not.toContain(await pre.evaluate((element) => getComputedStyle(element).color));
  await expect(block.locator(".tk-lit")).toHaveText(["true", "false", "null"]);

  await block.getByRole("button", { name: "Show all" }).click();
  await checkpoint(page, "json-expanded");
  expect(await shown()).toEqual({ visible: 40, total: 40 });
  await expect(block.getByRole("button", { name: "Show all" })).toHaveCount(0);

  // Code: its language label and a Copy button that copies the source.
  await open(page, baseUrl, `run/${run}/file/plan.md`);
  const code = page.getByTestId("code-block");
  await expect(code.locator(".lang")).toHaveText("ts");
  await checkpoint(page, "code-label-copy");
  await code.getByRole("button", { name: "Copy" }).click();
  await expect(code.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copiedSource);
  await expect(code.getByTestId("code-copy-status")).toHaveText("Copied");

  // A refused write says so in the live status; the code stays as it was.
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
  });
  await code.getByRole("button", { name: "Copy" }).click();
  await expect(code.getByTestId("code-copy-status")).toHaveText(/copy it by hand/);
  await expect(code.getByTestId("code-copy-status")).toHaveAttribute("aria-live", "polite");
  await expect(code.getByRole("button", { name: "Copy" })).toBeVisible();
});

/** One block for each language of AC4, each with at least two token classes. */
const languageSamples: [string, string][] = [
  ["ts", 'const answer: number = 42; // note\nfunction f(x: string) { return "s" + x; }'],
  ["js", 'const a = 1;\nconsole.log("hi", a); // note'],
  ["json", '{"a": 1, "b": "two", "c": true}'],
  ["yaml", "key: value\nlist:\n  - one\n  - 2\n# note"],
  ["bash", 'echo "hi" | grep h # note\nif [ -f x ]; then ls; fi'],
  ["diff", "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new"],
  ["python", 'def f(x):\n    return "s" + str(x)  # note'],
  ["markdown", "# Title\n- item\n[link](target)"],
  ["gherkin", "Feature: F\n  Scenario: S\n    Given a thing\n    When it runs\n    Then ok"],
];

test("ARK-T177 Code loads shiki in its own chunk on the first code block: Home's first load requests none, the block is plain monospace until the chunk loads, then it has coloured spans for 9 languages", async ({
  page,
}) => {
  isolate();
  writeRun({
    project: "p",
    run: runId("ARK-906"),
    ticket: { id: "ARK-906", title: "Gate with **markdown**" },
    phase: "awaiting_criteria",
  });
  const { run } = runWithFiles("ARK-907", {
    "plan.md": languageSamples
      .map(([language, source]) => `\`\`\`${language}\n${source}\n\`\`\``)
      .join("\n\n"),
  });
  installFakeTools({});
  const baseUrl = await launch();

  const requests: string[] = [];
  const responses: { path: string; status: number; type: string }[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  page.on("response", (response) =>
    responses.push({
      path: new URL(response.url()).pathname,
      status: response.status(),
      type: response.headers()["content-type"] ?? "",
    }),
  );

  // The first load of Home: markdown shows, and the entry bundle is the only script.
  await open(page, baseUrl, "");
  await expect(page.getByTestId("gate").locator("strong")).toHaveText("markdown");
  await page.waitForLoadState("networkidle");
  // Home's scripts: the entry and the chunks it shares with the page. None holds shiki.
  const homeScripts = scriptRequests(requests);
  for (const path of homeScripts)
    expect(await (await page.request.get(baseUrl + path)).text(), path).not.toContain(
      "codeToTokens",
    );

  // Hold every other script until the test releases it.
  const held: Route[] = [];
  let released = false;
  await page.route(/\/assets\/.+\.js$/, (route) => {
    if (released) void route.continue();
    else held.push(route);
  });
  await page.evaluate((hash) => (location.hash = hash), `#/run/${run}/file/plan.md`);
  await expect.poll(() => held.length).toBeGreaterThan(0);

  // While the response waits, each block is plain monospace text: no colour span.
  const blocks = page.locator("main pre.code-plain, main figure.code");
  await expect(blocks).toHaveCount(languageSamples.length);
  await checkpoint(page, "code-plain-before-chunk");
  await expect(page.locator(".shiki-token")).toHaveCount(0);
  const family = await blocks
    .first()
    .evaluate((element) => getComputedStyle(element.querySelector("pre") ?? element).fontFamily);
  expect(family).toMatch(/monospace/);
  await expect(blocks.first()).toContainText("const answer");

  released = true;
  for (const route of held.splice(0)) await route.continue();
  const figures = page.locator("main figure.code");
  await expect(figures).toHaveCount(languageSamples.length);
  await expect(figures.locator(".lang")).toHaveText(languageSamples.map(([language]) => language));
  for (let index = 0; index < languageSamples.length; index++)
    await expect(figures.nth(index).locator(".shiki-token").first()).toBeVisible();
  await checkpoint(page, "code-coloured");

  // The chunks are scripts of /assets/, served as JavaScript: the build split them from the entry.
  const chunks = scriptRequests(requests).filter((path) => !homeScripts.includes(path));
  expect(chunks.length).toBeGreaterThan(0);
  const bodies = await Promise.all(
    chunks.map(async (path) => (await page.request.get(baseUrl + path)).text()),
  );
  expect(bodies.some((body) => body.includes("codeToTokens"))).toBe(true);
  for (const path of chunks) {
    const answer = responses.find((candidate) => candidate.path === path);
    expect(answer, path).toMatchObject({ status: 200 });
    expect(answer!.type, path).toMatch(/javascript/);
  }

  // Two token colours or more in each language, and another theme in dark.
  const coloursOf = () =>
    figures.evaluateAll((nodes) =>
      nodes.map((node) =>
        [...node.querySelectorAll(".shiki-token")].map((span) => getComputedStyle(span).color),
      ),
    );
  await page.emulateMedia({ colorScheme: "light" });
  const light = await coloursOf();
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await coloursOf();
  languageSamples.forEach(([language], index) => {
    expect(new Set(light[index]).size, `${language} light`).toBeGreaterThanOrEqual(2);
    expect(new Set(dark[index]).size, `${language} dark`).toBeGreaterThanOrEqual(2);
    expect([...new Set(dark[index])].sort(), `${language} theme`).not.toEqual(
      [...new Set(light[index])].sort(),
    );
  });
});

const surfaceText = (label: string) =>
  `**bold ${label}**\n\n- list item one ${label}\n- list item two ${label}\n\nand \`code ${label}\``;

/** The surfaces of ARK-T179 and ARK-T181 on one hub; ids are those of the ARK-323 fixtures. */
function surfacesWorld() {
  isolate();
  writeBacklogTicket({
    project: "p",
    id: "ARK-910",
    title: "Rendered surfaces",
    status: "ready",
    problem: surfaceText("problem"),
    change: surfaceText("change"),
    criteria: [
      { id: "AC1", method: "inspection", text: "**bold criterion** and `code criterion`" },
    ],
  });
  const stateJson = JSON.stringify({ phase: "closed", count: 2 });
  const notes = "**not bold**\n- not a list";
  const { run, directory } = runWithFiles("ARK-911", {
    "plan.md": `# Plan\n\n${surfaceText("plan")}\n`,
    "results/state.json": stateJson,
    "results/notes.txt": notes,
  });
  // A decision whose text holds markdown.
  const events = readFileSync(join(directory, "events.ndjson"), "utf8").trim().split("\n").length;
  appendRawEvent(
    directory,
    "escalation.requested",
    { reason: surfaceText("decision") },
    events + 1,
  );
  // An open run at a gate whose question holds markdown, a list among it: the question quotes the ticket title.
  writeRun({
    project: "p",
    run: runId("ARK-912"),
    ticket: {
      id: "ARK-912",
      title: "Gate **bold** and `code`\n\n- gate item one\n- gate item two\n\nend",
    },
    phase: "awaiting_criteria",
  });
  // A ROADMAP.md note: the id of a missing ticket is `**ARK-950**`.
  writeBacklogTicket({ project: "p", id: "ARK-913", title: "Ranked", status: "ready" });
  writeRoadmap("p", { now: ["ARK-913", "**ARK-950**"] });
  installFakeTools({});
  return { run, stateJson, notes };
}

test("ARK-T179 each surface renders through Markdown, a .json run file through Json and any other run file through Code as plain text", async ({
  page,
}) => {
  const { run } = surfacesWorld();
  const baseUrl = await launch();
  const renders = async (area: Locator, label: string) => {
    await expect(area.locator("strong")).toHaveText(`bold ${label}`);
    await expect(area.locator("li")).toHaveText([
      `list item one ${label}`,
      `list item two ${label}`,
    ]);
    await expect(area.locator("code.ic")).toHaveText(`code ${label}`);
    expect(await area.innerText()).not.toMatch(/[*`]/);
  };

  await open(page, baseUrl, "ticket/ARK-910");
  await expect(page.getByTestId("ticket-problem")).toBeVisible();
  await checkpoint(page, "ticket");
  await renders(page.getByTestId("ticket-problem"), "problem");
  await renders(page.getByTestId("ticket-change"), "change");
  const criterion = page.getByTestId("ticket-criterion");
  await expect(criterion.locator("strong")).toHaveText("bold criterion");
  await expect(criterion.locator("code.ic")).toHaveText("code criterion");
  expect(await criterion.innerText()).not.toMatch(/[*`]/);

  await open(page, baseUrl, `run/${run}/file/plan.md`);
  await expect(page.getByTestId("run-file-text")).toBeVisible();
  await checkpoint(page, "run-file-md");
  await renders(page.getByTestId("run-file-text"), "plan");

  await open(page, baseUrl, `run/${run}/file/${encodeURIComponent("results/state.json")}`);
  await expect(page.getByTestId("json-block").locator(".tk-key")).toHaveText([
    '"phase"',
    '"count"',
  ]);
  await checkpoint(page, "run-file-json");
  expect((await page.getByTestId("json-block").locator("pre").textContent())!.split("\n")).toEqual([
    "{",
    '  "phase": "closed",',
    '  "count": 2',
    "}",
  ]);

  await open(page, baseUrl, `run/${run}/file/${encodeURIComponent("results/notes.txt")}`);
  const text = page.getByTestId("code-block");
  await expect(text.locator(".lang")).toHaveText("text");
  await checkpoint(page, "run-file-text");
  await expect(text.locator("pre")).toHaveText("**not bold**\n- not a list");
  await expect(text.locator("strong, li")).toHaveCount(0);

  await open(page, baseUrl, "");
  await expect(page.getByTestId("gate")).toBeVisible();
  await checkpoint(page, "gate-question");
  const gate = page.getByTestId("gate");
  await expect(gate.locator("strong")).toHaveText("bold");
  await expect(gate.locator("code.ic")).toHaveText("code");
  await expect(gate.locator("li")).toHaveText(["gate item one", "gate item two"]);

  await open(page, baseUrl, `run/${run}`);
  const decision = page.locator('[data-testid="timeline-entry"][data-type="escalation.requested"]');
  await expect(decision).toBeVisible();
  await checkpoint(page, "decision-timeline");
  await renders(decision, "decision");

  await open(page, baseUrl, "roadmap");
  const note = page.locator('[data-testid="roadmap-warning"][data-kind="missing_ticket"]');
  await expect(note).toBeVisible();
  await checkpoint(page, "roadmap-note");
  await expect(note.locator("strong")).toHaveText("ARK-950");
});

test("ARK-T181 the run file viewer and the ticket page each have a Rendered and Raw switch and Raw shows the source text as written", async ({
  page,
}) => {
  const { run } = surfacesWorld();
  const baseUrl = await launch();
  const switchOf = (name: "Rendered" | "Raw") =>
    page.getByRole("group", { name: "View" }).getByRole("button", { name });

  // A .md file: the source with its marks, then the elements again.
  const plan = `# Plan\n\n${surfaceText("plan")}\n`;
  await open(page, baseUrl, `run/${run}/file/plan.md`);
  const file = page.getByTestId("run-file-text");
  await expect(file.locator("strong")).toHaveText("bold plan");
  await switchOf("Raw").click();
  await checkpoint(page, "run-file-raw");
  expect(await file.textContent()).toBe(plan);
  await expect(file.locator("strong, li, h1")).toHaveCount(0);
  await switchOf("Rendered").click();
  await expect(file.locator("strong")).toHaveText("bold plan");

  // A .json file stored on one line: Raw is the file as written, not the formatted value.
  await open(page, baseUrl, `run/${run}/file/${encodeURIComponent("results/state.json")}`);
  await expect(page.getByTestId("json-block")).toBeVisible();
  await switchOf("Raw").click();
  expect(await page.getByTestId("run-file-text").textContent()).toBe(
    JSON.stringify({ phase: "closed", count: 2 }),
  );
  await expect(page.getByTestId("json-block")).toHaveCount(0);
  await switchOf("Rendered").click();
  await expect(page.getByTestId("json-block")).toBeVisible();

  // The ticket page: the source of Problem, Change and the criterion, then the elements again.
  await open(page, baseUrl, "ticket/ARK-910");
  await expect(page.getByTestId("ticket-problem").locator("strong")).toHaveText("bold problem");
  await switchOf("Raw").click();
  await checkpoint(page, "ticket-raw");
  expect(await page.getByTestId("ticket-problem").textContent()).toBe(surfaceText("problem"));
  expect(await page.getByTestId("ticket-change").textContent()).toBe(surfaceText("change"));
  expect(await page.getByTestId("ticket-criterion").locator("pre.raw").textContent()).toBe(
    "**bold criterion** and `code criterion`",
  );
  await expect(page.locator("main .md strong")).toHaveCount(0);
  await switchOf("Rendered").click();
  await expect(page.getByTestId("ticket-problem").locator("strong")).toHaveText("bold problem");
  await expect(page.getByTestId("ticket-criterion").locator("strong")).toHaveText("bold criterion");
});

// ---------------------------------------------------------------- ARK-355 time split

const runStart = dateOf("2026-11-02T10:00:00Z");
const minutesAfterStart = (minutes: number) => minutes * 60;
const partMinutes = (page: Page, ids: string[]) =>
  Promise.all(ids.map((id) => page.getByTestId(`time-${id}`).locator(".mins").textContent()));

test("ARK-T180 the run page shows the four time parts as one bar, in the closed band without metrics.json and at the top of an open run", async ({
  page,
}) => {
  isolate();
  const seconds = minutesAfterStart;
  const closedId = closedRunId("ARK-821");
  const closedDirectory = writeRun({
    project: "p",
    run: closedId,
    ticket: closedTicket("ARK-821"),
    phase: "closed",
    outcome: "merged",
    startedAt: runStart,
    criteria: ["A1"],
  });
  // Step a 6 to 30 min overlaps the plan gate 20 to 40 min; step b 50 to 56; MRs at 60 and 70; close at 90.
  const planStart = { step: "a", role: "implementer", repo: ".", round: 1 };
  writeEventLog(closedDirectory, runStart, [
    {
      after: 0,
      type: "run.started",
      data: {
        run: closedId,
        project: "p",
        ticket: closedTicket("ARK-821"),
        criteria: ["A1"],
        round_budget: 3,
      },
    },
    { after: seconds(6), type: "step.started", data: planStart },
    {
      after: seconds(20),
      type: "plan.checked",
      data: { valid: true, problems: [], plan_hash: "a", steps: [] },
    },
    { after: seconds(30), type: "step.finished", data: { step: "a", outcome: "succeeded" } },
    { after: seconds(40), type: "gate.answered", data: { gate: "plan", answer: "approve" } },
    { after: seconds(50), type: "step.started", data: { ...planStart, step: "b" } },
    { after: seconds(56), type: "step.finished", data: { step: "b", outcome: "succeeded" } },
    {
      after: seconds(60),
      type: "merge_request.opened",
      data: { repo: ".", url: "https://x/1", number: 1 },
    },
    {
      after: seconds(70),
      type: "merge_request.opened",
      data: { repo: ".", url: "https://x/2", number: 2 },
    },
    { after: seconds(90), type: "run.closed", data: { outcome: "merged" } },
  ]);
  expect(existsSync(join(closedDirectory, "metrics.json"))).toBe(false);

  // Open run: plan gate 5 to 15 min, step running from 15 min, no MR; the hub clock reads 45 min.
  const openId = runId("ARK-822");
  const openDirectory = writeRun({
    project: "p",
    run: openId,
    ticket: { id: "ARK-822", title: "Title of ARK-822" },
    phase: "building",
    startedAt: runStart,
  });
  writeEventLog(openDirectory, runStart, [
    {
      after: 0,
      type: "run.started",
      data: {
        run: openId,
        project: "p",
        ticket: { id: "ARK-822", title: "t" },
        criteria: ["A1"],
        round_budget: 3,
      },
    },
    {
      after: seconds(5),
      type: "plan.checked",
      data: { valid: true, problems: [], plan_hash: "a", steps: [] },
    },
    { after: seconds(15), type: "gate.answered", data: { gate: "plan", answer: "approve" } },
    { after: seconds(15), type: "step.started", data: planStart },
  ]);
  installFakeTools({});
  const previousNow = process.env.ARK_NOW;
  process.env.ARK_NOW = dateOf(runStart.getTime() + seconds(45) * 1000).toISOString();
  let baseUrl: string;
  try {
    baseUrl = await launch();
  } finally {
    process.env.ARK_NOW = previousNow;
  }
  const ids = ["you", "work", "merge", "idle"];

  await open(page, baseUrl, `run/${closedId}`);
  const bar = bandOf(page).getByTestId("time-bar");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("time-bar")).toHaveCount(1);
  expect(await partMinutes(page, ids)).toEqual(["20m", "20m", "30m", "20m"]);
  await expect(bar.locator(".parts li .name")).toHaveText([
    "Waiting on you",
    "Working",
    "Waiting to merge",
    "Idle",
  ]);
  const widths = await bar
    .locator(".bar span")
    .evaluateAll((all) => all.map((segment) => segment.getBoundingClientRect().width));
  expect(widths).toHaveLength(4);
  expect(widths[2] / widths[0]).toBeCloseTo(1.5, 1);
  expect(widths[1] / widths[0]).toBeCloseTo(1, 1);
  await checkpoint(page, "closed-no-metrics-bar");

  await open(page, baseUrl, `run/${openId}`);
  await expect(page.getByTestId("closed-band")).toHaveCount(0);
  await expect(page.getByTestId("time-bar")).toHaveCount(1);
  expect(await partMinutes(page, ids)).toEqual(["10m", "30m", "0m", "5m"]);
  const openWidths = await page
    .getByTestId("time-bar")
    .locator(".bar span")
    .evaluateAll((all) => all.map((segment) => segment.getBoundingClientRect().width));
  expect(openWidths).toHaveLength(3); // no merge segment for 0 minutes
  expect(openWidths[1] / openWidths[0]).toBeCloseTo(3, 1);
  const barBox = (await page.getByTestId("time-bar").boundingBox())!;
  const planBox = (await page.locator(".plan-panel").boundingBox())!;
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(planBox.y);
  await checkpoint(page, "open-run-top-bar");
});

// ---------------------------------------------------------------- ARK-354: Starts next

type ChiefQueue = {
  /** Titles of the ready and pending Tasks of the Run `Master Chief: p tickets`. */
  ready?: string[];
  pending?: string[];
  /** No Run `Master Chief: p tickets` on any page. */
  noRun?: boolean;
  /** `task-list --ready` exits 1. */
  readyFails?: boolean;
  /** `task-list --status pending` sleeps this many seconds before it answers. */
  pendingSleep?: number;
};

/**
 * A fake `orca` first on PATH. `run-list` answers in 16 pages of 10 with a `nextCursor` and the Run
 * of Master Chief sits last on the last page; `task-list` answers by `--ready` or `--status pending`.
 * Every call is one line of `orca.log` in the returned folder. Call after `installFakeTools`.
 */
function installChiefOrca(queue: ChiefQueue = {}): string {
  const state = tempDirectory("ark-chief-orca-");
  const put = (name: string, text: string) => writeFileSync(join(state, name), text);
  const pages = 16;
  for (let page = 0; page < pages; page++) {
    const runs = Array.from({ length: 10 }, (_, index) => ({
      id: `orca-filler-${page}-${index}`,
      objective: `Filler ${page}-${index}`,
    }));
    if (page === pages - 1 && !queue.noRun)
      runs[9] = { id: "orca-chief", objective: "Master Chief: p tickets" };
    put(
      `runs.${page}`,
      JSON.stringify({
        result: {
          runs,
          nextCursor: page < pages - 1 ? String(page + 1) : null,
        },
      }),
    );
  }
  const tasks = (titles: string[] = [], status: string) =>
    JSON.stringify({
      result: {
        tasks: titles.map((title, index) => ({
          id: `task-${status}-${index}`,
          title,
          status,
        })),
      },
    });
  put("ready", tasks(queue.ready, "ready"));
  put("pending", tasks(queue.pending, "pending"));
  put("pending.sleep", String(queue.pendingSleep ?? 0));
  if (queue.readyFails) put("ready.fails", "");
  writeFakeOrca(`echo "$*" >> '${state}/orca.log'
cursor=0
previous=
for argument in "$@"; do
  [ "$previous" = --cursor ] && cursor=$argument
  previous=$argument
done
case "$1 $2" in
  "terminal list") echo '{"result":{"terminals":[]}}' ;;
  "worktree ps") echo '{"result":{"worktrees":[]}}' ;;
  "orchestration run-list") cat '${state}/runs.'$cursor ;;
  "orchestration worker-list") echo '{"result":{"workers":[]}}' ;;
  "orchestration inbox") echo '{"result":{"messages":[]}}' ;;
  "orchestration task-list")
    case "$*" in
      *--ready*) [ -e '${state}/ready.fails' ] && { echo "task-list broke" >&2; exit 1; }; cat '${state}/ready' ;;
      *) sleep "$(cat '${state}/pending.sleep')"; cat '${state}/pending' ;;
    esac ;;
  *) exit 1 ;;
esac`);
  return state;
}

const orcaLines = (state: string) =>
  readFileSync(join(state, "orca.log"), "utf8").trim().split("\n");

/** Project `p` with `concurrency: 2` and these tickets (all status ready unless given). */
function queueProject(
  tickets: { id: string; status?: string; dependsOn?: string[] }[],
  ranked: string[] = [],
): void {
  writeProject("p", {
    workspace: tempDirectory("ark-workspace-"),
    ticket_source: "github",
    suites: [
      {
        name: "unit",
        level: "unit",
        repo: ".",
        command: "true",
        parser: "bun",
      },
    ],
    roles: {
      implementer: { harness: "omp", model: "m" },
      validator: { harness: "omp", model: "m" },
      reviewer: { harness: "omp", model: "m" },
    },
    concurrency: 2,
  });
  for (const ticket of tickets)
    writeBacklogTicket({
      project: "p",
      id: ticket.id,
      title: `Title of ${ticket.id}`,
      status: ticket.status ?? "ready",
      dependsOn: ticket.dependsOn,
    });
  writeRoadmap("p", { now: ranked });
}

const openRunFor = (ticket: string) =>
  writeRun({
    project: "p",
    run: runId(ticket),
    ticket: { id: ticket, title: `Title of ${ticket}` },
    phase: "building",
  });

const startRows = (page: Page) => page.getByTestId("starts-next-row");
const rowTickets = (page: Page) =>
  startRows(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-ticket")));

test("ARK-T253 Home 'Starts next' lists the ready and pending Tasks of Master Chief's Run and leaves out a Task whose ticket has an open run", async ({
  page,
}) => {
  isolate();
  queueProject(["ARK-801", "ARK-802", "ARK-803", "ARK-804"].map((id) => ({ id })));
  openRunFor("ARK-804");
  installFakeTools({});
  const state = installChiefOrca({
    ready: ["ARK-801 First", "ARK-802 Second", "ARK-804 Fourth", "no id here"],
    pending: ["ARK-803 Third"],
  });
  const baseUrl = await launch();
  await open(page, baseUrl, "");

  await expect(startRows(page)).toHaveCount(3);
  expect(await rowTickets(page)).toEqual(["ARK-801", "ARK-802", "ARK-803"]);
  await expect(page.getByTestId("starts-next")).not.toContainText("ARK-804");
  await expect(page.getByTestId("starts-next")).not.toContainText("no id here");
  await checkpoint(page, "starts-next-listed");

  // The Run was found by paging run-list with --cursor to the last page, and nothing changed a Task.
  const lines = orcaLines(state);
  const cursors = new Set(
    lines.flatMap((line) => line.match(/^orchestration run-list .*--cursor (\d+)/)?.[1] ?? []),
  );
  expect([...cursors].sort((a, b) => Number(a) - Number(b))).toEqual(
    Array.from({ length: 15 }, (_, index) => String(index + 1)),
  );
  for (const line of lines)
    expect(line).toMatch(
      /^(terminal list|worktree ps|orchestration (run-list|task-list|worker-list|inbox))\b/,
    );
});

test("ARK-T254 Each ticket in 'Starts next' shows one reason, and ready Tasks come before pending Tasks in roadmap rank, then ticket id", async ({
  page,
}) => {
  isolate();
  queueProject(
    [
      ...[
        "ARK-809",
        "ARK-811",
        "ARK-812",
        "ARK-813",
        "ARK-820",
        "ARK-821",
        "ARK-870",
        "ARK-871",
      ].map((id) => ({ id })),
      { id: "ARK-822", status: "done" },
      { id: "ARK-814", dependsOn: ["ARK-820"] },
      { id: "ARK-815", dependsOn: ["ARK-820", "ARK-821", "ARK-822"] },
      { id: "ARK-816", dependsOn: ["ARK-820"] },
    ],
    ["ARK-813", "ARK-812", "ARK-816", "ARK-815"],
  );
  openRunFor("ARK-870");
  installFakeTools({});
  // The supplied order: ready 812, 811, 813, 809 and pending 815, 814, 816.
  installChiefOrca({
    ready: ["ARK-812 b", "ARK-811 c", "ARK-813 a", "ARK-809 d"],
    pending: ["ARK-815 e", "ARK-814 f", "ARK-816 g"],
  });
  const baseUrl = await launch();
  await open(page, baseUrl, "");

  const order = ["ARK-813", "ARK-812", "ARK-809", "ARK-811", "ARK-816", "ARK-815", "ARK-814"];
  const reasons = (ready: string) => [
    ready,
    ready,
    ready,
    ready,
    "waits on ARK-820",
    "waits on ARK-820, ARK-821",
    "waits on ARK-820",
  ];
  const reasonTexts = () => page.getByTestId("starts-next-reason");
  await expect(startRows(page)).toHaveCount(7);
  expect(await rowTickets(page)).toEqual(order);
  await expect(reasonTexts()).toHaveText(reasons("starts next"));
  await checkpoint(page, "starts-next-reasons-below-limit");

  // A second open run reaches concurrency 2; `ark chief state` counts the same two.
  openRunFor("ARK-871");
  await expect(reasonTexts().first()).toHaveText("starts when a run closes (2/2 open)");
  await expect(reasonTexts()).toHaveText(reasons("starts when a run closes (2/2 open)"));
  expect(await rowTickets(page)).toEqual(order);
  await expect(page.getByTestId("starts-next")).not.toContainText("Master Chief's order");
  await checkpoint(page, "starts-next-reasons-at-limit");
  const chief = ark("chief", "state", "--project", "p");
  expect(chief.out).toContain("- concurrency: 2 (2 open)");
});

test("ARK-T255 'Approved, not queued' lists ready tickets that have no Task and no open run", async ({
  page,
}) => {
  isolate();
  queueProject([
    { id: "ARK-831" },
    { id: "ARK-832" },
    { id: "ARK-833" },
    { id: "ARK-834" },
    { id: "ARK-835" },
    { id: "ARK-836", status: "proposed" },
  ]);
  openRunFor("ARK-834");
  installFakeTools({});
  installChiefOrca({
    ready: ["ARK-832 Has a ready Task"],
    pending: ["ARK-833 Has a pending Task"],
  });
  const baseUrl = await launch();
  await open(page, baseUrl, "");

  const rows = page.getByTestId("not-queued-row");
  await expect(rows).toHaveCount(2);
  expect(
    await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-ticket"))),
  ).toEqual(["ARK-831", "ARK-835"]);
  await expect(rows.getByText("ask Master Chief to queue it")).toHaveCount(2);
  await checkpoint(page, "approved-not-queued");
});

/** Opens Home on two ready tickets and one open run, with a queue that cannot be read. */
async function unreadableQueue(page: Page, queue: ChiefQueue, reason: RegExp): Promise<void> {
  isolate();
  queueProject([{ id: "ARK-841" }, { id: "ARK-842" }, { id: "ARK-843" }], ["ARK-841", "ARK-842"]);
  openRunFor("ARK-843");
  installFakeTools({});
  installChiefOrca(queue);
  const baseUrl = await launch();
  await open(page, baseUrl, "");
  // The other Home blocks answer first: a queue that is still being read does not hold them back.
  await expect(page.locator('[data-testid="tile"][data-tile="runs"] .big')).toHaveText("1");
  const block = page.getByTestId("starts-next");
  await expect(block).toContainText("Queue unavailable: ");
  await expect(block).toContainText(reason);
  await expect(startRows(page)).toHaveCount(0);
  await expect(page.getByTestId("not-queued-row")).toHaveCount(0);
  await expect(page.getByTestId("not-queued")).toHaveCount(0);
  // A failed or slow call is a failed read, so its source shows a stale chip.
  if (!queue.noRun) await expect(await staleRow(page, "queue")).toBeVisible();
}

test("ARK-T256 An unreadable queue shows 'Queue unavailable: <reason>' with no ticket when Master Chief has no Run", async ({
  page,
}) => {
  await unreadableQueue(page, { noRun: true }, /no Orca Run "Master Chief: p tickets"/);
  await checkpoint(page, "queue-unavailable-missing-run");
});

test("ARK-T256 An unreadable queue shows 'Queue unavailable: <reason>' with no ticket when an orca call fails", async ({
  page,
}) => {
  await unreadableQueue(page, { readyFails: true }, /task-list failed/);
  await checkpoint(page, "queue-unavailable-failed-call");
});

test("ARK-T256 An unreadable queue shows 'Queue unavailable: <reason>' with no ticket when an orca call times out", async ({
  page,
}) => {
  process.env.ARK_ORCA_TIMEOUT_MS = "1500";
  try {
    await unreadableQueue(page, { pendingSleep: 8 }, /task-list failed: .*time/i);
  } finally {
    delete process.env.ARK_ORCA_TIMEOUT_MS;
  }
  await checkpoint(page, "queue-unavailable-timeout");
});

const rowState = (page: Page, ticket: string) => rowOf(page, ticket).getByTestId("status-chip");
const pageState = (page: Page) => page.locator('[data-testid="ticket-page"] .meta .pill').first();

test("ARK-T257 A ticket shows as queued only when the Orca queue has its Task; a ready ticket with no Task shows as approved, not queued on the Roadmap and the ticket page", async ({
  page,
}) => {
  isolate();
  queueProject(
    [
      { id: "ARK-851" },
      { id: "ARK-852" },
      { id: "ARK-853", dependsOn: ["ARK-859"] },
      { id: "ARK-859" },
    ],
    ["ARK-851", "ARK-852", "ARK-853"],
  );
  installFakeTools({});
  installChiefOrca({ ready: ["ARK-851 Queued"], pending: ["ARK-853 Waits"] });
  const baseUrl = await launch();

  await open(page, baseUrl, "roadmap");
  await expect(rowOf(page, "ARK-851")).toBeVisible();
  await expect(rowState(page, "ARK-851")).toHaveText("queued");
  await expect(rowState(page, "ARK-852")).toHaveText("approved, not queued");
  await expect(rowState(page, "ARK-853")).toHaveText("blocked");
  await checkpoint(page, "roadmap-queued-labels");

  for (const [ticket, label] of [
    ["ARK-851", "queued"],
    ["ARK-852", "approved, not queued"],
    ["ARK-853", "blocked"],
  ] as const) {
    await open(page, baseUrl, `roadmap/${ticket}`);
    await expect(pageState(page)).toHaveText(label);
    if (ticket === "ARK-852") await checkpoint(page, "ticket-page-approved-not-queued");
  }
});

test("ARK-T257 An unreadable queue marks no ready ticket as approved, not queued", async ({
  page,
}) => {
  isolate();
  queueProject([{ id: "ARK-852" }], ["ARK-852"]);
  installFakeTools({});
  installChiefOrca({ noRun: true });
  const baseUrl = await launch();

  await open(page, baseUrl, "roadmap");
  await expect(rowOf(page, "ARK-852")).toBeVisible();
  await expect(await staleRow(page, "queue")).toBeVisible();
  await expect(rowState(page, "ARK-852")).not.toHaveText("approved, not queued");
  await open(page, baseUrl, "roadmap/ARK-852");
  await expect(pageState(page)).not.toHaveText("approved, not queued");
});

// ---------- ARK-325: ticket page band and chips, graphs that fit, Full screen, skip edges ----------

/** Ticket of project `p` with the title `Title of <id>`. */
const graphTicket = (
  id: string,
  dependsOn: string[] = [],
  extra: Partial<Parameters<typeof writeBacklogTicket>[0]> = {},
) =>
  writeBacklogTicket({
    project: "p",
    id,
    title: `Title of ${id}`,
    status: "ready",
    dependsOn,
    ...extra,
  });

/** Adds an `## Evidence` section to a ticket file. */
const addEvidence = (file: string, text: string) =>
  writeFileSync(file, `${readFileSync(file, "utf8")}\n## Evidence\n\n${text}\n`);

const longText = (word: string, paragraphs: number) =>
  Array.from({ length: paragraphs }, (_, index) => `${word} ${index} `.repeat(70).trim()).join(
    "\n\n",
  );

/** One chain of `length` tickets, each depending on the one before: the ids are `<prefix>1` ... `<prefix><length>`. */
const chainOf = (prefix: string, length: number): string[] => {
  const ids = Array.from({ length }, (_, index) => `${prefix}${index + 1}`);
  ids.forEach((id, index) => graphTicket(id, index === 0 ? [] : [ids[index - 1]!]));
  return ids;
};

/**
 * ARK-901 has 10 tickets in its graph and 8 columns: a chain of 6 that it depends on, and 3 tickets
 * that depend on it. ARK-902 has no relation. ARK-903 holds long text, ARK-904 has no Evidence.
 */
function bandWorld(): void {
  isolate();
  const chain = chainOf("ARK-81", 6);
  const file = graphTicket("ARK-901", chain, {
    problem: longText("problem", 3),
    change: longText("change", 3),
    criteria: [1, 2, 3].map((number) => ({
      id: `AC${number}`,
      text: `Criterion ${number}.`,
    })),
  });
  addEvidence(file, longText("evidence", 3));
  for (const id of ["ARK-821", "ARK-822", "ARK-823"]) graphTicket(id, ["ARK-901"]);
  graphTicket("ARK-902");
  installFakeTools({});
}

test("ARK-T278 the ticket page puts a 10-ticket graph in a full-width band with no horizontal scroll at 1440 px, prose and relations in two columns under it, and an empty relation as one line", async ({
  page,
}) => {
  bandWorld();
  const baseUrl = await launch();
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, baseUrl, "ticket/ARK-901");
  await expect(page.getByTestId("ticket-problem")).toBeVisible();
  await checkpoint(page, "ticket-band-1440");
  const graph = page.getByTestId("ticket-graph");
  await expect(graph.getByTestId("graph-node")).toHaveCount(10);

  // The graph is 8 columns, wider than the box at full size: it fits by scale, not by scrolling.
  const view = await geometryOf(page);
  expect(view.natural).toBeGreaterThan(view.inner);
  expect(view.scrollWidth).toBeLessThanOrEqual(view.clientWidth);

  const boxes = await page.evaluate(() => {
    const rect = (element: Element | null) => {
      const box = element!.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      };
    };
    const main = document.querySelector("main")!;
    const style = getComputedStyle(main);
    const content = rect(main);
    content.left += parseFloat(style.paddingLeft);
    content.right -= parseFloat(style.paddingRight);
    const band = rect(document.querySelector('[data-testid="ticket-graph"]')!.closest("section"));
    const title = rect(document.querySelector("h1.ticket-title"));
    const left = rect(document.querySelector(".ticket-prose"));
    const right = rect(document.querySelector("aside.side"));
    const paragraph = document.querySelector('[data-testid="ticket-problem"] p') as HTMLElement;
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    probe.textContent = "0".repeat(100);
    paragraph.append(probe);
    const zero = probe.getBoundingClientRect().width / 100;
    probe.remove();
    return {
      content,
      band,
      title,
      left,
      right,
      measure: paragraph.getBoundingClientRect().width / zero,
    };
  });
  // The band is as wide as the page content, under the title and above both columns.
  expect(Math.abs(boxes.band.left - boxes.content.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(boxes.band.right - boxes.content.right)).toBeLessThanOrEqual(2);
  expect(boxes.band.top).toBeGreaterThanOrEqual(boxes.title.bottom);
  expect(boxes.left.top).toBeGreaterThanOrEqual(boxes.band.bottom);
  expect(boxes.right.top).toBeGreaterThanOrEqual(boxes.band.bottom);
  // No empty right side: the right column reaches the band's right edge, and sits right of the prose.
  expect(Math.abs(boxes.right.right - boxes.band.right)).toBeLessThanOrEqual(2);
  expect(boxes.left.right).toBeLessThanOrEqual(boxes.right.left);
  // The prose keeps a reading measure of about 72 characters.
  expect(boxes.measure).toBeGreaterThan(60);
  expect(boxes.measure).toBeLessThan(85);
  // The sections are left, the relations and the criteria right.
  const prose = page.locator(".ticket-prose");
  const side = page.locator("aside.side");
  for (const id of ["sec-problem", "sec-change", "sec-evidence"])
    await expect(prose.locator(`#${id}`)).toHaveCount(1);
  await expect(side.getByTestId("depends-on")).toHaveCount(1);
  await expect(side.getByTestId("unblocks-list")).toHaveCount(1);
  await expect(side.getByTestId("ticket-criterion")).toHaveCount(3);
  await expect(prose.getByTestId("ticket-criterion")).toHaveCount(0);

  // An empty relation is one short line.
  await open(page, baseUrl, "ticket/ARK-902");
  for (const [testId, text] of [
    ["depends-on", "Depends on · none"],
    ["unblocks-list", "Unblocks · none"],
  ] as const) {
    const relation = page.getByTestId(testId);
    await expect(relation).toHaveText(text);
    expect((await relation.boundingBox())!.height).toBeLessThan(40);
  }

  await page.setViewportSize({ width: 1000, height: 900 });
  await open(page, baseUrl, "ticket/ARK-901");
  await expect(page.getByTestId("ticket-problem")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "no horizontal scroll of the page at 1000 px",
  ).toBe(true);
});

test("ARK-T279 the sticky bar holds the part chips and the Rendered and Raw switch, a click scrolls its part under the bar without a route change, and the chip of the part in view is marked", async ({
  page,
}) => {
  isolate();
  const text = {
    problem: longText("problem", 8),
    change: longText("change", 8),
    criteria: [1, 2, 3].map((number) => ({
      id: `AC${number}`,
      text: `Criterion ${number}.`,
    })),
  };
  addEvidence(graphTicket("ARK-903", [], text), longText("evidence", 8));
  graphTicket("ARK-904", [], text);
  installFakeTools({});
  const baseUrl = await launch();
  await page.setViewportSize({ width: 1440, height: 900 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/ticket/p/ARK-903", async (route) => {
    await held;
    await route.continue();
  });

  await open(page, baseUrl, "ticket/ARK-903");
  const bar = page.getByTestId("outline-bar");
  await expect(page.getByText("Loading the ticket text…")).toBeVisible();
  await expect(bar).toHaveCount(0);
  release();
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button")).toHaveText([
    /^Problem$/,
    /^Change$/,
    /^Evidence$/,
    /^Acceptance criteria\s*3$/,
    /^AC1$/,
    /^AC2$/,
    /^AC3$/,
    /^Rendered$/,
    /^Raw$/,
  ]);

  const chip = (name: string) => bar.getByRole("button", { name, exact: true });
  const hash = await page.evaluate(() => location.hash);
  await chip("AC2").click();
  await expect(chip("AC2")).toHaveAttribute("aria-current", "location");
  const { gap, barHeight } = await page.evaluate(() => {
    const rect = document.querySelector('[data-testid="outline-bar"]')!.getBoundingClientRect();
    const top = document.querySelector("#crit-AC2")!.getBoundingClientRect().top;
    return { gap: top - rect.bottom, barHeight: rect.height };
  });
  expect(gap, "AC2 starts under the bar, not behind it").toBeGreaterThanOrEqual(0);
  expect(gap, "AC2 is not scrolled far below the bar").toBeLessThanOrEqual(barHeight * 2);
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  await checkpoint(page, "ticket-chip-ac2");

  const marked = () =>
    Promise.all(
      ["Problem", "Change", "Evidence"].map(async (name) =>
        (await chip(name).getAttribute("aria-current")) === "location" ? name : "",
      ),
    ).then((names) => names.filter(Boolean));
  const scrollTo = (script: string) => page.evaluate(`window.scrollTo(0, ${script})`);
  const top = (id: string) =>
    `document.getElementById("${id}").getBoundingClientRect().top + scrollY`;
  await scrollTo(`${top("sec-change")} - 70`);
  await expect.poll(marked).toEqual(["Change"]);
  await scrollTo("0");
  await expect.poll(marked).toEqual(["Problem"]);
  await scrollTo("document.documentElement.scrollHeight");
  await expect.poll(marked).toEqual(["Evidence"]);
  // At every scroll the bar keeps its place at the top of the window.
  const sticky = await bar.evaluate((node) => ({
    position: getComputedStyle(node).position,
    offset: parseFloat(getComputedStyle(node).top),
    top: node.getBoundingClientRect().top,
  }));
  expect(sticky.position).toBe("sticky");
  expect(Math.abs(sticky.top - sticky.offset)).toBeLessThanOrEqual(1);
  // One criterion chip at most is marked.
  expect(await bar.locator(".outline-chip.mono[aria-current]").count()).toBeLessThanOrEqual(1);

  // The Raw choice survives a chip click.
  await bar.getByRole("button", { name: "Raw", exact: true }).click();
  await chip("Problem").click();
  await expect(bar.getByRole("button", { name: "Raw", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await page.evaluate(() => location.hash)).toBe(hash);

  // A part with no text keeps its chip, and the chip scrolls to the line that says so.
  await open(page, baseUrl, "ticket/ARK-904");
  await expect(bar).toBeVisible();
  await expect(chip("Evidence")).toBeVisible();
  await chip("Evidence").click();
  const evidence = page.locator("#sec-evidence");
  await expect(evidence).toContainText("Not written in the ticket.");
  await expect(evidence).toBeInViewport();
});

type Geometry = {
  /** The width the graph may use: the scroll box without its padding. */
  inner: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  /** Layout size of the graph, before any scale. */
  natural: number;
  naturalHeight: number;
  renderedWidth: number;
  boxHeight: number;
  dataScale: number;
};

const minimumScale = 0.6;
const padding = 8;

/** The geometry of the one graph viewport (or overlay) of the page, as the browser laid it out. */
const geometryOf = (page: Page): Promise<Geometry> =>
  page.getByTestId("graph-viewport").evaluate((view) => {
    const scroller = view.querySelector(".gv-scroll") as HTMLElement;
    const graph = view.querySelector(".gv-graph") as HTMLElement;
    const style = getComputedStyle(scroller);
    return {
      inner: scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      clientWidth: scroller.clientWidth,
      clientHeight: scroller.clientHeight,
      scrollWidth: scroller.scrollWidth,
      scrollHeight: scroller.scrollHeight,
      natural: graph.offsetWidth,
      naturalHeight: graph.offsetHeight,
      renderedWidth: graph.getBoundingClientRect().width,
      boxHeight: (view.querySelector(".gv-box") as HTMLElement).getBoundingClientRect().height,
      dataScale: Number(view.getAttribute("data-scale")),
    };
  });

/** The fit scale of the AC: the width of the box over the width of the graph, from 60% to 100%. */
const fitScaleOf = (view: Geometry) =>
  Math.min(1, Math.max(minimumScale, view.inner / view.natural));

/** The graph is at its fit scale as drawn, and its box scrolls sideways only below the 60% floor. */
async function expectFit(page: Page, label: string): Promise<Geometry> {
  await expect
    .poll(
      async () => {
        // Measure after the fonts and two frames: the ResizeObserver has then fed the scale back.
        await page.evaluate(async () => {
          await document.fonts.ready;
          const { promise, resolve } = Promise.withResolvers<void>();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          await promise;
        });
        const view = await geometryOf(page);
        const want = fitScaleOf(view);
        return {
          data: Math.abs(view.dataScale - want) < 0.01,
          rendered: Math.abs(view.renderedWidth / view.natural - want) < 0.01,
          height: Math.abs(view.boxHeight - view.naturalHeight * want) < 1.5,
        };
      },
      { message: label },
    )
    .toEqual({ data: true, rendered: true, height: true });
  const view = await geometryOf(page);
  const drawn = fitScaleOf(view) * view.natural;
  if (drawn > view.inner + 1) expect(view.scrollWidth, label).toBeGreaterThan(view.clientWidth);
  else if (drawn <= view.inner)
    expect(view.scrollWidth, label).toBeLessThanOrEqual(view.clientWidth);
  return view;
}

/**
 * Sets the viewport width so that the graph box has `target` pixels inside its padding. The box does
 * not grow one for one with the window on every page (a side column takes a share), so the width
 * moves by the slope measured between two tries. False when the page cannot reach it.
 */
async function widenTo(page: Page, target: number): Promise<boolean> {
  let slope = 1;
  let previous: { width: number; inner: number } | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const { inner } = await geometryOf(page);
    const size = page.viewportSize()!;
    if (Math.abs(inner - target) <= 1) return true;
    if (previous && size.width !== previous.width)
      slope = Math.max(0.2, (inner - previous.inner) / (size.width - previous.width));
    previous = { width: size.width, inner };
    const width = Math.max(320, Math.round(size.width + (target - inner) / slope));
    if (width === size.width) return false;
    await page.setViewportSize({ width, height: size.height });
  }
  return Math.abs((await geometryOf(page)).inner - target) <= 1;
}

const viewOf = (page: Page) => page.getByTestId("graph-viewport");
const controlsOf = (page: Page) => ({
  fit: viewOf(page).getByRole("button", { name: "Fit", exact: true }),
  actual: viewOf(page).getByRole("button", { name: "100%", exact: true }),
  full: viewOf(page).getByRole("button", { name: "Full screen", exact: true }),
});

/** A chain of 7 milestones with one ticket each, each depending on the one before. */
function roadmapChain(): void {
  isolate();
  const ids = Array.from({ length: 7 }, (_, index) => `ARK-83${index + 1}`);
  ids.forEach((id, index) =>
    graphTicket(id, index === 0 ? [] : [ids[index - 1]!], {
      milestone: `M${index + 1}`,
    }),
  );
  writeRoadmap("p", {
    milestones: ids.map((_, index) => [
      `M${index + 1}`,
      `Milestone ${index + 1}`,
      `Outcome ${index + 1}.`,
      index === 0 ? "active" : "later",
    ]),
    now: ids,
  });
  installFakeTools({});
}

/** 12 tickets in 4 columns of 3, every ticket depending on the 3 of the column before, each with an open run. */
function runsColumns(): void {
  isolate();
  const column = (number: number) => [1, 2, 3].map((row) => `ARK-84${number}${row}`);
  for (let number = 1; number <= 4; number++)
    for (const id of column(number)) {
      graphTicket(id, number === 1 ? [] : column(number - 1));
      writeRun({
        project: "p",
        run: runId(id),
        ticket: { id, title: `Title of ${id}` },
        phase: "building",
      });
    }
  installFakeTools({});
}

/** The plan run: 4 steps side by side, then 10 steps one below the other, the last of them running. */
function widePlan(): string {
  isolate();
  const side = ["a", "b", "c", "d"].map((name) => `build-${name}`);
  const down = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((number) => `check-${number}`);
  const done = {
    startedAfter: 40,
    finishedAfter: 60,
    outcome: "succeeded" as const,
  };
  const run = runId("ARK-850");
  writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-850", title: "A wide and tall plan" },
    phase: "building",
    steps: [
      ...side.map((id) => ({
        id,
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        ...done,
      })),
      ...down.map((id, index) => ({
        id,
        role: "validator",
        harness: "omp",
        model: "m",
        needs: index === 0 ? side : [down[index - 1]!],
        ...(index === down.length - 1 ? { startedAfter: 100 } : done),
      })),
    ],
  });
  installFakeTools({});
  return run;
}

type GraphPage = {
  key: "ticket" | "roadmap" | "runs" | "plan";
  name: string;
  /** Writes the fixture and returns the route that shows the graph. */
  build: () => string;
  /** What to do on the page to bring the graph up. */
  prepare?: (page: Page) => Promise<void>;
  nodes: string;
  nodeCount: number;
  /** A node that is a link, as a selector. */
  link: string;
};

/** The four graphs of ARK-T280 and ARK-T281, each with its own fixture. */
const graphPages: GraphPage[] = [
  {
    key: "ticket",
    name: "ticket",
    build: () => {
      bandWorld();
      return "ticket/ARK-901";
    },
    nodes: "graph-node",
    nodeCount: 10,
    link: 'a[data-testid="graph-node"][data-ticket="ARK-813"]',
  },
  {
    key: "roadmap",
    name: "Roadmap",
    build: () => {
      roadmapChain();
      return "roadmap";
    },
    prepare: async (target) => {
      await target.getByTestId("view-graph").click();
      await expect(target.getByTestId("roadmap-graph")).toBeVisible();
    },
    nodes: "graph-node",
    nodeCount: 7,
    link: 'a[data-testid="graph-node"][data-ticket="ARK-833"]',
  },
  {
    key: "runs",
    name: "Runs",
    build: () => {
      runsColumns();
      return "runs";
    },
    nodes: "graph-node",
    nodeCount: 12,
    link: 'a[data-testid="graph-node"][data-ticket="ARK-8421"]',
  },
  {
    key: "plan",
    name: "plan",
    build: () => `run/${widePlan()}`,
    nodes: "step-node",
    nodeCount: 14,
    link: '[data-testid="step-node"][data-step="build-b"] a',
  },
];

test("ARK-T280 the ticket, Roadmap, Runs and plan graphs fit the width of their box down to 60% and then scroll, with Fit, 100% and Full screen controls, at 1024 px and at 1440 px", async ({
  page,
}) => {
  test.slow();
  for (const kind of graphPages) {
    const hash = kind.build();
    const baseUrl = await launch();
    const key = kind.key;
    const at = async (width: number) => {
      await page.setViewportSize({ width, height: width === 1024 ? 800 : 900 });
      await open(page, baseUrl, hash);
      await kind.prepare?.(page);
      await expect(page.getByTestId(kind.nodes)).toHaveCount(kind.nodeCount);
      await expect(viewOf(page)).toHaveCount(1);
    };

    // 1: each graph at 1024 and at 1440 px has its three controls and its fit scale.
    for (const width of [1024, 1440]) {
      await at(width);
      const { fit, actual, full } = controlsOf(page);
      for (const control of [fit, actual, full]) await expect(control).toBeVisible();
      const view = await expectFit(page, `${kind.name} at ${width}`);
      if (width === 1024 && key === "roadmap") await checkpoint(page, "graph-fit-1024");
      // The Roadmap is wider than the box at both widths, and the ticket graph at 1024 too.
      if (key === "roadmap" || (key === "ticket" && width === 1024))
        expect(view.natural, `${kind.name} natural width at ${width}`).toBeGreaterThan(view.inner);
    }

    // 2 and 3: the ratio classes below, at and above the floor, reached by the viewport width.
    await at(1440);
    const natural = (await geometryOf(page)).natural;
    const classes: [string, number, (ratio: number) => boolean][] = [
      ["below the floor", Math.round(0.55 * natural), (ratio) => ratio < minimumScale],
      ["exactly at the floor", Math.ceil(minimumScale * natural), (ratio) => ratio >= minimumScale],
      ["above the floor", Math.round(0.8 * natural), (ratio) => ratio > minimumScale && ratio < 1],
      ["close to a full fit", Math.round(0.85 * natural), (ratio) => ratio > 0.8 && ratio < 1],
    ];
    for (const [name, inner, inClass] of classes) {
      const reached = await widenTo(page, inner);
      const reachedWith = await geometryOf(page);
      expect(
        reached,
        `${kind.name}: the page reaches ${name} (wanted ${inner}, graph ${natural}, got ${reachedWith.inner})`,
      ).toBe(true);
      const view = await geometryOf(page);
      expect(inClass(view.inner / view.natural), `${kind.name} is ${name}`).toBe(true);
      const settled = await expectFit(page, `${kind.name} ${name}`);
      const scale = fitScaleOf(settled);
      if (name === "below the floor") {
        expect(scale).toBeCloseTo(minimumScale, 2);
        expect(settled.scrollWidth).toBeGreaterThan(settled.clientWidth);
      } else {
        expect(scale).toBeGreaterThanOrEqual(minimumScale);
        expect(settled.scrollWidth).toBeLessThanOrEqual(settled.clientWidth);
      }

      // 4: no empty band under a graph that is not tall enough to scroll.
      if (key !== "plan")
        expect(settled.clientHeight).toBeLessThanOrEqual(settled.boxHeight + 2 * padding + 1);

      // 7 and 8: the plan fits its width only, scrolls down, and keeps the running step in view.
      if (key === "plan") {
        expect(settled.scrollHeight).toBeGreaterThan(settled.clientHeight);
        expect(settled.clientHeight).toBeLessThanOrEqual(560);
        const inside = () =>
          page.locator('[data-testid="step-node"][data-step="check-10"]').evaluate((step) => {
            const box = step.getBoundingClientRect();
            const frame = document.querySelector(".gv-scroll")!.getBoundingClientRect();
            return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1;
          });
        await expect.poll(inside, { message: `running step in view, ${name}` }).toBe(true);
      }
    }

    // 5: 100% draws the graph at its size, Fit brings the fit scale back.
    await at(1440);
    const fitted = await expectFit(page, `${kind.name} fit before 100%`);
    const { fit, actual } = controlsOf(page);
    await actual.click();
    await expect.poll(async () => (await geometryOf(page)).dataScale).toBe(1);
    const sized = await geometryOf(page);
    expect(sized.renderedWidth).toBeCloseTo(sized.natural, 0);
    if (fitted.natural > fitted.inner) expect(sized.scrollWidth).toBeGreaterThan(sized.clientWidth);
    if (key === "plan")
      await expect
        .poll(() =>
          page.locator('[data-testid="step-node"][data-step="check-10"]').evaluate((step) => {
            const box = step.getBoundingClientRect();
            const frame = document.querySelector(".gv-scroll")!.getBoundingClientRect();
            return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1;
          }),
        )
        .toBe(true);
    await fit.click();
    await expect
      .poll(async () => (await geometryOf(page)).dataScale)
      .toBeCloseTo(fitScaleOf(fitted), 2);
  }

  // 6: a graph that fits at full size is not enlarged.
  isolate();
  graphTicket("ARK-860", ["ARK-861"]);
  graphTicket("ARK-861");
  installFakeTools({});
  const baseUrl = await launch();
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, baseUrl, "ticket/ARK-860");
  await expect(page.getByTestId("graph-node")).toHaveCount(2);
  const narrow = await expectFit(page, "narrow ticket graph");
  expect(narrow.natural).toBeLessThan(narrow.inner);
  expect(narrow.dataScale).toBe(1);
});

test("ARK-T281 Full screen shows the one graph in a dialog over the window at fit scale, Esc and Close close it and return the focus, and a node click goes where it goes outside", async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  const dialog = page.getByRole("dialog");
  for (const kind of graphPages) {
    const hash = kind.build();
    const baseUrl = await launch();
    const show = async () => {
      await open(page, baseUrl, hash);
      await kind.prepare?.(page);
      await expect(page.getByTestId(kind.nodes)).toHaveCount(kind.nodeCount);
    };
    const route = `#/${hash}`;
    const { full } = controlsOf(page);
    const openOverlay = async () => {
      await full.focus();
      await full.click();
      await expect(dialog).toBeVisible();
    };

    await show();
    await expect(dialog).toHaveCount(0);
    const pageScale = (await geometryOf(page)).dataScale;
    await openOverlay();
    // One graph, not a copy, in a modal dialog that covers the window, with the focus inside.
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(page.getByTestId(kind.nodes)).toHaveCount(kind.nodeCount);
    expect(
      await dialog.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return [box.left, box.top, box.width, box.height].map(Math.round);
      }),
      `${kind.name}: the dialog is the window`,
    ).toEqual([0, 0, 1440, 900]);
    await expect
      .poll(() => dialog.evaluate((node) => node.contains(document.activeElement)))
      .toBe(true);
    if (kind.key === "ticket") await checkpoint(page, "graph-overlay");
    // The overlay is at its own fit scale: never below the page's, because its box is wider.
    const overlay = await expectFit(page, `${kind.name} in the overlay`);
    expect(overlay.dataScale).toBeGreaterThanOrEqual(pageScale - 0.001);

    // Esc closes it, keeps the page, and the focus is back on Full screen.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => location.hash), `${kind.name}: Esc stays on the page`).toBe(
      route,
    );
    await expect(full).toBeFocused();
    // Close closes it the same way.
    await openOverlay();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => location.hash)).toBe(route);
    await expect(full).toBeFocused();

    // A node click goes where it goes outside the overlay, and the overlay is gone.
    const href = await page.locator(kind.link).getAttribute("href");
    await page.locator(kind.link).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(href);
    const outside = await page.evaluate(() => location.hash);
    await show();
    await openOverlay();
    await dialog.locator(kind.link).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(outside);
    await expect(dialog).toHaveCount(0);

    if (kind.key === "ticket") {
      // The page behind does not scroll under the wheel.
      // The route change of show() runs in a view transition that resets the scroll ~100 ms in, and
      // getAnimations() does not see it start: no view transition, so nothing takes the position.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await show();
      await page.evaluate(() => window.scrollTo(0, 120));
      await openOverlay();
      await page.mouse.move(720, 450);
      await page.mouse.wheel(0, 600);
      expect(await page.evaluate(() => scrollY)).toBe(120);
      await page.keyboard.press("Escape");
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
    if (kind.key === "roadmap") {
      // Esc with the search box focused behind the overlay closes the overlay, not the field's focus.
      await show();
      await openOverlay();
      await page.getByTestId("filter-text").evaluate((field) => (field as HTMLElement).focus());
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(await page.evaluate(() => location.hash)).toBe(route);
    }
  }
});

/** The skip edges of ARK-T282: ARK-907 depends on 4 tickets that depend on each other, and 2 tickets depend on it. */
function skipEdgeWorld(): void {
  isolate();
  graphTicket("ARK-961");
  graphTicket("ARK-962", ["ARK-961"]);
  graphTicket("ARK-963", ["ARK-962"]);
  graphTicket("ARK-907", ["ARK-961", "ARK-962", "ARK-963"]);
  graphTicket("ARK-964", ["ARK-907"]);
  graphTicket("ARK-965", ["ARK-907", "ARK-961"]);
  installFakeTools({});
}

test("ARK-T282 a ticket-graph edge that skips a column runs in a lane above the cards and crosses no node box it does not join", async ({
  page,
}) => {
  skipEdgeWorld();
  const baseUrl = await launch();
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, baseUrl, "ticket/ARK-907");
  const graph = page.getByTestId("ticket-graph");
  await expect(graph.getByTestId("graph-node")).toHaveCount(6);
  // The depends_on pairs among the 6 tickets: 961>962, 962>963, 961>907, 962>907, 963>907, 907>964, 907>965, 961>965.
  await expect(graph.getByTestId("graph-edge")).toHaveCount(8);
  await checkpoint(page, "ticket-skip-edges");

  const drawn = await page.evaluate(() => {
    const rectOf = (box: DOMRect) => ({
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
    });
    const boxes = new Map(
      [...document.querySelectorAll('[data-testid="ticket-graph"] [data-testid="graph-node"]')].map(
        (node) => [node.getAttribute("data-ticket")!, rectOf(node.getBoundingClientRect())],
      ),
    );
    const svg = document.querySelector('[data-testid="ticket-graph"] svg')!;
    return {
      svg: rectOf(svg.getBoundingClientRect()),
      topOfCards: Math.min(...[...boxes.values()].map((box) => box.top)),
      edges: [...document.querySelectorAll('[data-testid="ticket-graph"] path[data-from]')].map(
        (path) => {
          const edge = path as unknown as SVGPathElement;
          const from = edge.getAttribute("data-from")!;
          const to = edge.getAttribute("data-to")!;
          const matrix = edge.getScreenCTM()!;
          const points: { x: number; y: number }[] = [];
          const length = edge.getTotalLength();
          for (let at = 0; at <= length; at += 4) {
            const point = edge.getPointAtLength(at).matrixTransform(matrix);
            points.push({ x: point.x, y: point.y });
          }
          const end = edge.getPointAtLength(length).matrixTransform(matrix);
          points.push({ x: end.x, y: end.y });
          // Between two neighbouring columns the gap is one card gap; a skip edge spans more.
          const gap = boxes.get(to)!.left - boxes.get(from)!.right;
          return { from, to, skips: gap > 60, points };
        },
      ),
      boxes: [...boxes].map(([ticket, box]) => ({ ticket, ...box })),
    };
  });

  const skips = drawn.edges.filter((edge) => edge.skips);
  expect(
    skips.map((edge) => `${edge.from}>${edge.to}`).toSorted(),
    "the three edges that skip a column",
  ).toEqual(["ARK-961>ARK-907", "ARK-961>ARK-965", "ARK-962>ARK-907"].toSorted());
  for (const edge of drawn.edges)
    for (const point of edge.points) {
      // Inside the graph's SVG: no part of the detour is cut off.
      expect(point.x, `${edge.from}>${edge.to} stays in the SVG`).toBeGreaterThanOrEqual(
        drawn.svg.left - 0.5,
      );
      expect(point.x).toBeLessThanOrEqual(drawn.svg.right + 0.5);
      expect(point.y).toBeGreaterThanOrEqual(drawn.svg.top - 0.5);
      expect(point.y).toBeLessThanOrEqual(drawn.svg.bottom + 0.5);
      for (const box of drawn.boxes) {
        if (box.ticket === edge.from || box.ticket === edge.to) continue;
        const inside =
          point.x > box.left && point.x < box.right && point.y > box.top && point.y < box.bottom;
        expect(inside, `${edge.from}>${edge.to} passes through ${box.ticket}`).toBe(false);
      }
    }
  // A skip edge runs above every card, and each runs in its own lane.
  const lanes = skips.map((edge) => Math.min(...edge.points.map((point) => point.y)));
  for (const lane of lanes) {
    expect(lane).toBeLessThan(drawn.topOfCards);
    expect(lane).toBeGreaterThanOrEqual(drawn.svg.top - 0.5);
  }
  for (const [index, lane] of lanes.entries())
    for (const other of lanes.slice(index + 1))
      expect(Math.abs(lane - other), "two skip edges share a lane").toBeGreaterThanOrEqual(4);
});

// ---------------------------------------------------------------- ARK-335 live changes

type LiveWindow = Window & {
  __stream?: { onmessage?: (message: { data: string }) => void; onerror?: () => void };
  __push: (snapshot: unknown) => void;
  /** Calls of `document.startViewTransition`, and the durations of its pseudo-element animations once it is ready. */
  __viewTransitionCalls: number;
  __viewTransitions: number[][];
  /** Times the banner went missing after it showed, and when the last snapshot arrived (T310). */
  __gaps: number;
  __lastSnapshotAt: number;
};

/**
 * Swaps the page's EventSource for one the test feeds (`push`), and records every view transition.
 * The page, the store and the hub that serves them are real. Call before `goto`.
 */
async function fakeStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const live = window as unknown as LiveWindow;
    class FakeStream {
      onmessage?: (message: { data: string }) => void;
      onerror?: () => void;
      constructor() {
        live.__stream = this;
      }
      close() {}
    }
    window.EventSource = FakeStream as unknown as typeof EventSource;
    live.__push = (snapshot) => live.__stream?.onmessage?.({ data: JSON.stringify(snapshot) });
    live.__viewTransitionCalls = 0;
    live.__viewTransitions = [];
    const start = document.startViewTransition?.bind(document);
    if (start)
      document.startViewTransition = (update) => {
        live.__viewTransitionCalls++;
        const transition = start(update);
        void transition.ready.then(() =>
          live.__viewTransitions.push(
            document
              .getAnimations()
              .filter((animation) =>
                (animation.effect as KeyframeEffect).pseudoElement?.startsWith("::view-transition"),
              )
              .map((animation) => Number(animation.effect!.getTiming().duration)),
          ),
        );
        return transition;
      };
  });
}

const push = (page: Page, snapshot: Snapshot) =>
  page.evaluate((next) => (window as unknown as LiveWindow).__push(next), snapshot);

/** Opens the page on the fed stream and waits until the first snapshot is on screen. */
async function openFed(page: Page, baseUrl: string, hash: string, first: Snapshot): Promise<void> {
  await fakeStream(page);
  await page.goto(`${baseUrl}/#/${hash}`);
  await page.waitForFunction(() => "__stream" in window);
  await push(page, first);
  await expect(page.locator("main h1").first()).toBeVisible();
}

const frames = (page: Page, count: number) =>
  page.evaluate(async (total) => {
    for (let frame = 0; frame < total; frame++)
      await new Promise((done) => requestAnimationFrame(done));
  }, count);

/** Waits 600 ms of page time: clear of the page's keyboard window (a route change soon after a key is a keyboard action). */
const pastKeyWindow = (page: Page) =>
  page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 600)
      await new Promise((done) => requestAnimationFrame(done));
  });

/** Every animation and transition of the page, named for a failure message: `<name or property> on <tag.class>`. */
const animationsOf = (page: Page) =>
  page.evaluate(() =>
    document.getAnimations().map((animation) => {
      const target = (animation.effect as KeyframeEffect).target;
      const name =
        animation instanceof CSSTransition
          ? animation.transitionProperty
          : (animation as CSSAnimation).animationName;
      return `${name} on ${target?.tagName.toLowerCase()}.${target?.className}`;
    }),
  );

/** The animations of the page that are not CSS transitions: keyframes, FLIP and view transitions. */
const motionOf = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => !(animation instanceof CSSTransition))
      .map((animation) => (animation as CSSAnimation).animationName ?? "script animation"),
  );

/**
 * Runs for the six Home lists and the Runs board: two runs for each, so each list can swap its pair.
 * 901, 902 wait at the criteria gate (older first); 903, 904 are stuck agents; 905, 906 hold a
 * question; 907, 908 wait in the review queue. 903 has a running step behind a finished one.
 */
function liveWorld(): void {
  const steps = [
    {
      id: "a",
      role: "implementer",
      harness: "omp",
      model: "m",
      needs: [],
      startedAfter: 40,
      finishedAfter: 100,
    },
    { id: "b", role: "validator", harness: "omp", model: "m", needs: ["a"], startedAfter: 200 },
  ];
  const world: [number, FixtureRun["phase"], number][] = [
    [901, "awaiting_criteria", 4 * 3600],
    [902, "awaiting_criteria", 3 * 3600],
    [903, "building", 600], // a recent event: its running step is not idle, so it pulses
    [904, "building", 2 * 3600 - 60],
    [905, "building", 2 * 3600 - 120],
    [906, "building", 2 * 3600 - 180],
    [907, "merge_requests_open", 2 * 3600 - 240],
    [908, "merge_requests_open", 2 * 3600 - 300],
  ];
  for (const [number, phase, secondsAgo] of world) {
    const ticket = `ARK-${number}`;
    writeRun({
      project: "p",
      run: runId(ticket),
      ticket: { id: ticket, title: `Ticket ${number}` },
      phase,
      startedAt: ago(secondsAgo),
      steps: phase === "awaiting_criteria" ? undefined : steps,
      mergeRequests:
        phase === "merge_requests_open"
          ? [{ repo: ".", url: `https://github.com/example/repo/pull/${number}`, number }]
          : undefined,
    });
    writeBacklogTicket({ project: "p", id: ticket, title: `Ticket ${number}`, status: "ready" });
  }
}

/**
 * The snapshot of the hub that serves `liveWorld`, with what the fixtures cannot make added (stuck
 * agents, questions, MR creation times, a queue, a provider limit), and the same snapshot with the
 * order of every list reversed. The hub reads only while a stream is open, so one is held while
 * the snapshot is taken.
 */
async function liveSnapshots(baseUrl: string): Promise<{ first: Snapshot; swapped: Snapshot }> {
  const read = async () => (await (await fetch(`${baseUrl}/api/snapshot`)).json()) as Snapshot;
  const reading = new AbortController();
  const stream = await fetch(`${baseUrl}/events`, { signal: reading.signal });
  let base = await read();
  try {
    await expect
      .poll(async () => {
        base = await read();
        return base.runs === "unknown" ? 0 : base.runs.length;
      })
      .toBeGreaterThanOrEqual(8);
  } finally {
    reading.abort();
    await stream.body?.cancel().catch(() => undefined);
  }
  const first = structuredClone(base);
  const runs = first.runs as RunView[];
  const runOf = (number: number) => runs.find((run) => run.ticket.id === `ARK-${number}`)!;
  for (const number of [903, 904])
    runOf(number).agents = [
      {
        role: "implementer",
        harness: "omp",
        model: "m",
        title: "b (implementer, .)",
        step: "b",
        planned: null,
        terminal: `term-${number}`,
        presence: "live",
        activity: { kind: "waiting", text: "waiting on a prompt", last_line: "Proceed?" },
      },
    ];
  first.sources.agentWait = { ok: true, read_at: first.generated_at };
  for (const number of [905, 906])
    runOf(number).waiting = [
      { step: "b", reason: `Question of ${number}`, since: first.generated_at },
    ];
  runOf(907).merge_requests[0].created_at = ago(7200).toISOString();
  runOf(908).merge_requests[0].created_at = ago(3600).toISOString();
  first.queues = [
    {
      project: "p",
      open: 6,
      concurrency: 8,
      tasks: [
        { id: "task-1", title: "ARK-911", status: "ready", ticket: "ARK-911" },
        { id: "task-2", title: "ARK-912", status: "ready", ticket: "ARK-912" },
      ],
    },
  ];
  first.provider_limits = [
    { provider: "openai", window: "5h", used_fraction: 0.2, resets_at: null, fetched_at: null },
  ];
  const swapped = structuredClone(first);
  (swapped.gates as Gate[]).reverse();
  (swapped.runs as RunView[]).reverse();
  (swapped.tickets as TicketView[]).reverse();
  const swappedRuns = swapped.runs as RunView[];
  const swappedRun = (number: number) =>
    swappedRuns.find((run) => run.ticket.id === `ARK-${number}`)!;
  swappedRun(907).merge_requests[0].created_at = ago(3600).toISOString();
  swappedRun(908).merge_requests[0].created_at = ago(7200).toISOString();
  (swapped.queues as QueuedProject[])[0].tasks[0].status = "pending"; // ready rows first: 912, then 911
  return { first, swapped };
}

/** `first` with one more gate (the Needs me count changes from 4 to 5). */
function withExtraGate(first: Snapshot): Snapshot {
  const next = structuredClone(first);
  const gates = next.gates as Gate[];
  gates.push({ ...gates[0], id: "gate:extra:criteria", run: "extra", ticket: "ARK-909" });
  return next;
}

test("ARK-T312 A pushed new gate or changed count shows a fading amber highlight and a polite live count, and no animation loops forever", async ({
  page,
}) => {
  test.slow();
  isolate();
  liveWorld();
  installFakeTools({});
  const baseUrl = await launch();
  const { first } = await liveSnapshots(baseUrl);
  await openFed(page, baseUrl, "", first);

  const gates = page.getByTestId("gate");
  const tile = page.locator('[data-testid="tile"][data-tile="needs-me"]');
  const count = page.getByTestId("live-count");
  const highlighted = /(^|\s)hl(\s|$)/;
  // The first snapshot highlights nothing; the count sits in a polite live region.
  await expect(gates).toHaveCount(2);
  await expect(count).toHaveAttribute("aria-live", "polite");
  await expect(count).toHaveText("4");
  await expect(page.locator(".hl")).toHaveCount(0);

  // A push that changes nothing highlights nothing and leaves the live text alone.
  await push(page, first);
  await frames(page, 3);
  await expect(page.locator(".hl")).toHaveCount(0);
  await expect(count).toHaveText("4");

  // A new gate: the item and the tile count flash amber; the live count reads the new total.
  const extra = withExtraGate(first);
  await push(page, extra);
  const added = page.locator('[data-testid="gate"][data-gate="gate:extra:criteria"]');
  await expect(added).toHaveClass(highlighted);
  await expect(tile).toHaveClass(highlighted);
  await expect(count).toHaveText("5");
  await checkpoint(page, "needs-me-highlight");
  const fade = await added.evaluate((element) =>
    element.getAnimations().map((animation) => ({
      name: (animation as CSSAnimation).animationName,
      duration: animation.effect!.getTiming().duration,
      easing: (animation.effect as KeyframeEffect).getKeyframes()[0].easing,
      from: (animation.effect as KeyframeEffect).getKeyframes()[0].backgroundColor,
      to: getComputedStyle(element.previousElementSibling!).backgroundColor, // an item at rest
    })),
  );
  expect(fade).toHaveLength(1);
  expect(fade[0]).toMatchObject({ name: "highlight-fade", duration: 600, easing: "ease-out" });
  expect(fade[0].from).toMatch(/^(rgb|color)/); // an amber start colour: neither unset nor transparent
  expect(fade[0].from).not.toBe(fade[0].to);
  await expect(page.locator(".hl")).toHaveCount(0, { timeout: 3000 });
  await checkpoint(page, "needs-me-settled");

  // A changed existing gate (same id, same count): the item flashes, the tile and the live text do not.
  const edited = structuredClone(extra);
  (edited.gates as Gate[])[0].question = "A new question for the first gate";
  await push(page, edited);
  await expect(gates.first()).toHaveClass(highlighted);
  await expect(tile).not.toHaveClass(highlighted);
  await expect(count).toHaveText("5");
  await checkpoint(page, "needs-me-changed-item");
  await expect(page.locator(".hl")).toHaveCount(0, { timeout: 3000 });

  // A step done and a meter value: the segment changes colour and the meter width over 200 ms.
  const moved = structuredClone(edited);
  const run903 = (moved.runs as RunView[]).find((run) => run.ticket.id === "ARK-903")!;
  run903.progress!.steps_done = 2;
  moved.provider_limits = [
    { provider: "openai", window: "5h", used_fraction: 0.6, resets_at: null, fetched_at: null },
  ];
  const transitions = await page.evaluate(async (next) => {
    (window as unknown as LiveWindow).__push(next);
    const read = () =>
      [
        ...document.querySelectorAll(
          '[data-testid="run"][data-run$="ARK-903-1"] .steps i, .meter i',
        ),
      ].flatMap((element) =>
        element
          .getAnimations()
          .filter((animation) => animation instanceof CSSTransition)
          .map((animation) => [
            (animation as CSSTransition).transitionProperty,
            animation.effect!.getTiming().duration,
          ]),
      );
    for (let frame = 0; frame < 20; frame++) {
      await new Promise((done) => requestAnimationFrame(done));
      if (read().length >= 2) break;
    }
    return read();
  }, moved);
  expect(transitions).toContainEqual(["background-color", 200]);
  expect(transitions).toContainEqual(["width", 200]);

  // The run page: the running step pulses and its incoming edge flows, both for a few cycles, and
  // a hidden tab pauses them. Nothing loops for ever.
  await page.evaluate((hash) => (location.hash = hash), `#/run/${runId("ARK-903")}`);
  const node = page.locator('[data-testid="step-node"][data-status="running"] .box');
  const edge = page.locator('[data-testid="step-edge"].into-running');
  await expect(node).toHaveCount(1);
  await expect(edge).toHaveCount(1);
  const loops = (locator: Locator) =>
    locator.evaluate((element) =>
      element.getAnimations().map((animation) => ({
        name: (animation as CSSAnimation).animationName,
        iterations: animation.effect!.getTiming().iterations,
        state: animation.playState,
      })),
    );
  expect(await loops(node)).toEqual([{ name: "step-pulse", iterations: 4, state: "running" }]);
  expect(await loops(edge)).toEqual([{ name: "edge-flow", iterations: 5, state: "running" }]);
  const endless = () =>
    page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations === Infinity)
          .length,
    );
  expect(await endless()).toBe(0);
  const hide = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await hide(true);
  await expect(page.locator("html")).toHaveAttribute("data-hidden", "");
  expect((await loops(node))[0].state).toBe("paused");
  expect((await loops(edge))[0].state).toBe("paused");
  await hide(false);
  await expect(page.locator("html")).not.toHaveAttribute("data-hidden", "");
  expect((await loops(node))[0].state).toBe("running");
  // Every animation ends: this wait is bounded (4 pulses of 1.6 s, 5 flows of 1.2 s).
  await expect
    .poll(() => animationsOf(page).then((names) => names.length), { timeout: 20_000 })
    .toBe(0);
});

/** The items of each list, in page order, with their top edge and what animates them. */
const listsOf = (page: Page, selectors: Record<string, string>) =>
  page.evaluate((lists) => {
    const key = (element: Element) =>
      element.getAttribute("data-gate") ??
      element.getAttribute("data-ticket") ??
      element.getAttribute("data-run")!;
    return Object.fromEntries(
      Object.entries(lists).map(([name, selector]) => [
        name,
        [...document.querySelectorAll<HTMLElement>(selector)].map((element) => ({
          key: key(element),
          top: element.getBoundingClientRect().top,
          transform: getComputedStyle(element).transform,
          moving: element
            .getAnimations()
            .filter(
              (animation) => (animation.effect as KeyframeEffect).getKeyframes()[0]?.transform,
            )
            .map((animation) => Number(animation.effect!.getTiming().duration)),
        })),
      ]),
    );
  }, selectors);

type Lists = Awaited<ReturnType<typeof listsOf>>;

/**
 * Pushes `snapshot`, waits (up to 20 frames) until some list changed its order, and reads the
 * lists at that moment: the FLIP animations of the moved items are running now.
 */
async function pushAndRead(
  page: Page,
  snapshot: Snapshot,
  selectors: Record<string, string>,
  settle: boolean,
): Promise<{ before: Lists; during: Lists }> {
  const before = await listsOf(page, selectors);
  await push(page, snapshot);
  let during = await listsOf(page, selectors);
  const order = (lists: Lists) =>
    JSON.stringify(Object.values(lists).map((l) => l.map((i) => i.key)));
  for (let frame = 0; frame < 20 && settle && order(during) === order(before); frame++) {
    await frames(page, 1);
    during = await listsOf(page, selectors);
  }
  if (!settle) {
    await frames(page, 5);
    during = await listsOf(page, selectors);
  }
  return { before, during };
}

const homeLists = {
  gates: '[data-testid="gate"]',
  waiting: '[data-testid="waiting"]',
  stuck: '[data-testid="stuck"]',
  review: '[data-testid="review"]',
  starts: '[data-testid="starts-next-row"]',
  progress: '[data-testid="run"]',
};

test("ARK-T313 Reordered Home lists and Runs board items move by FLIP in at most 250 ms and end in the new place, and a view change transitions in at most 200 ms", async ({
  page,
}) => {
  test.slow();
  isolate();
  roadmapOf44();
  liveWorld();
  installFakeTools({});
  const baseUrl = await launch();
  const { first, swapped } = await liveSnapshots(baseUrl);
  await openFed(page, baseUrl, "runs", first);
  const board = { cards: '[data-testid="run-card"][data-lane="Needs me"]' };
  await expect(page.locator(board.cards)).toHaveCount(4);
  await checkpoint(page, "runs-before-reorder");

  // The Runs board: the cards of the lane swap, each by a transform animation of 250 ms or less.
  const reorder = async (selectors: Record<string, string>, snapshot: Snapshot) => {
    const { before, during } = await pushAndRead(page, snapshot, selectors, true);
    await finiteAnimationsEnded(page);
    const after = await listsOf(page, selectors);
    for (const [name, items] of Object.entries(after)) {
      const keys = items.map((item) => item.key);
      expect(keys, name).toEqual(before[name].map((item) => item.key).reverse());
      expect(keys, `${name} did not change again`).toEqual(during[name].map((item) => item.key));
      const moved = items.filter(
        (item) => Math.abs(item.top - before[name].find((old) => old.key === item.key)!.top) > 0.5,
      );
      expect(moved.length, `${name} moved items`).toBeGreaterThanOrEqual(2);
      for (const item of items) {
        const running = during[name].find((started) => started.key === item.key)!.moving;
        if (moved.includes(item)) {
          expect(running.length, `${name} ${item.key} animates`).toBeGreaterThan(0);
          for (const duration of running) expect(duration).toBeLessThanOrEqual(250);
        } else expect(running, `${name} ${item.key} stays`).toEqual([]);
        expect(item.transform, `${name} ${item.key} ends in place`).toBe("none");
        expect(item.moving, `${name} ${item.key} stopped`).toEqual([]);
      }
      const tops = items.map((item) => item.top);
      expect(tops, `${name} tops`).toEqual([...tops].sort((left, right) => left - right));
    }
  };
  await reorder(board, swapped);
  await checkpoint(page, "runs-after-reorder");

  // Every Home list: the same reorder, one snapshot.
  await page.evaluate(() => (location.hash = "#/"));
  await expect(page.getByTestId("gate")).toHaveCount(2);
  await finiteAnimationsEnded(page);
  await reorder(homeLists, first);
  await checkpoint(page, "home-after-reorder");

  // The same order again: nothing animates.
  const { during: still } = await pushAndRead(page, first, homeLists, false);
  for (const [name, items] of Object.entries(still))
    for (const item of items) expect(item.moving, `${name} ${item.key}`).toEqual([]);

  // A list above grows and pushes the lists below down the page: they did not reorder, so nothing
  // in them slides (a place is measured in its own container).
  const { before: shifted, during: grown } = await pushAndRead(
    page,
    withExtraGate(first),
    homeLists,
    false,
  );
  expect(grown.gates.length).toBe(shifted.gates.length + 1);
  const pushed = Object.keys(shifted).filter(
    (name) =>
      !["gates", "waiting"].includes(name) &&
      shifted[name].length > 0 &&
      grown[name][0].top > shifted[name][0].top + 0.5,
  );
  expect(pushed.length, "lists pushed down by the new gate").toBeGreaterThan(0);
  for (const [name, items] of Object.entries(grown))
    if (!["gates", "waiting"].includes(name))
      // waiting shares the Needs me container with the gates
      for (const item of items)
        expect(item.moving, `${name} ${item.key} did not reorder`).toEqual([]);

  // A view change is a view transition of 200 ms or less, and the new view is in the DOM.
  const views: [string, Locator][] = [
    ["#/runs", page.getByTestId("lane").first()],
    [`#/run/${runId("ARK-903")}`, page.getByTestId("step-node").first()],
    ["#/roadmap", page.getByTestId("ticket-row").first()],
    ["#/ticket/ARK-701", page.getByTestId("ticket-page")],
  ];
  const recorded = () =>
    page.evaluate(() => (window as unknown as LiveWindow).__viewTransitions.length);
  await finiteAnimationsEnded(page); // the change to Home above has recorded its transition
  const already = await recorded();
  for (const [index, [hash, marker]] of views.entries()) {
    await pastKeyWindow(page);
    await page.evaluate((next) => (location.hash = next), hash);
    await expect(marker).toBeVisible();
    await expect.poll(recorded).toBe(already + index + 1);
    const durations = await page.evaluate(
      (at) => (window as unknown as LiveWindow).__viewTransitions[at],
      already + index,
    );
    expect(durations.length, hash).toBeGreaterThan(0);
    for (const duration of durations) expect(duration, hash).toBeLessThanOrEqual(200);
  }

  // The keys act while a view change is still running, and Esc restores the scroll position (ARK-T26).
  await page.evaluate(() => (location.hash = "#/roadmap"));
  const selected = page.locator('[data-testid="ticket-row"][aria-current="true"]');
  await expect(selected).toHaveAttribute("data-ticket", "ARK-701");
  await page.keyboard.press("j");
  await expect(selected).not.toHaveAttribute("data-ticket", "ARK-701");
  for (let press = 0; press < 29; press++) await page.keyboard.press("j");
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
});

test("ARK-T314 With prefers-reduced-motion, or for a keyboard action's result, no element animates or transitions", async ({
  page,
}) => {
  test.slow();
  isolate();
  roadmapOf44();
  liveWorld();
  installFakeTools({});
  const baseUrl = await launch();
  const { first, swapped } = await liveSnapshots(baseUrl);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFed(page, baseUrl, "", first);
  const gates = page.getByTestId("gate");
  await expect(gates).toHaveCount(2);

  // Reduced motion: a running step on screen, a new gate, a reorder and a view change animate nothing.
  const settledAnimations = async () => {
    await frames(page, 4);
    return animationsOf(page);
  };
  expect(await settledAnimations()).toEqual([]);
  await push(page, withExtraGate(first));
  await expect(gates).toHaveCount(3); // the new item shows, with no highlight animation
  expect(await settledAnimations()).toEqual([]);
  const before = await listsOf(page, homeLists);
  await push(page, swapped);
  await expect(gates.first()).toHaveAttribute("data-gate", /ARK-902/);
  expect(await settledAnimations()).toEqual([]);
  const after = await listsOf(page, homeLists);
  expect(after.progress.map((item) => item.key)).toEqual(
    before.progress.map((item) => item.key).reverse(),
  );
  for (const [name, items] of Object.entries(after))
    for (const item of items) expect(item.moving, `${name} ${item.key}`).toEqual([]);
  await page.evaluate(() => (location.hash = "#/runs"));
  await expect(page.getByTestId("lane").first()).toBeVisible();
  await page.evaluate((hash) => (location.hash = hash), `#/run/${runId("ARK-903")}`);
  await expect(page.locator('[data-testid="step-node"][data-status="running"]')).toHaveCount(1);
  expect(await settledAnimations()).toEqual([]); // the pulse and the dash are off
  expect(await page.evaluate(() => (window as unknown as LiveWindow).__viewTransitionCalls)).toBe(
    0,
  );

  // Control: with motion allowed the same page animates, so the empty lists above are the rule.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => (location.hash = "#/"));
  await expect(gates).toHaveCount(2);
  await push(page, withExtraGate(swapped));
  await expect.poll(() => animationsOf(page).then((names) => names.length)).toBeGreaterThan(0);

  // A key just pressed: the reorder and the new gate that follow are its result, so no FLIP slide
  // and no highlight.
  await finiteAnimationsEnded(page);
  await page.keyboard.press("Shift");
  await push(page, withExtraGate(first));
  await expect(gates).toHaveCount(3);
  await frames(page, 4);
  expect(await motionOf(page)).toEqual([]);
  await expect(page.locator(".hl")).toHaveCount(0);

  // A key starts the change: no view transition. A click on the same link starts one.
  await finiteAnimationsEnded(page);
  await page.evaluate(() => (location.hash = "#/roadmap"));
  const selected = page.locator('[data-testid="ticket-row"][aria-current="true"]');
  await expect(selected).toBeVisible();
  const calls = () => page.evaluate(() => (window as unknown as LiveWindow).__viewTransitionCalls);
  await finiteAnimationsEnded(page); // the change above was not a key: its transition must end first
  const callsBefore = await calls();
  await page.keyboard.press("j");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("ticket-page")).toBeVisible();
  await frames(page, 4);
  // No view transition, keyframe or script motion on the result. A control's own colour transition
  // (hover, pressed) is not the result of the route change.
  expect(await motionOf(page)).toEqual([]);
  expect(await calls()).toBe(callsBefore);
  await pastKeyWindow(page);
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("link", { name: "Roadmap" })
    .click();
  await expect(page.getByTestId("ticket-row").first()).toBeVisible();
  expect(await calls()).toBe(callsBefore + 1);
});

/** A proxy in front of the hub that the test can cut: the open event stream is destroyed and new ones are refused, so the page sees a real connection loss. */
async function proxyHub(hubUrl: string) {
  const hub = new URL(hubUrl);
  const streams = new Set<Socket>();
  let down = false;
  let refused = 0;
  const { url } = await serve((request, response) => {
    if (down && request.url === "/events") {
      refused++;
      request.socket.destroy();
      return;
    }
    const headers = { ...request.headers, host: hub.host };
    delete headers.origin;
    const upstream = httpRequest(
      { host: hub.hostname, port: hub.port, path: request.url, method: request.method, headers },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    if (request.url === "/events") streams.add(request.socket);
    upstream.on("error", () => response.destroy());
    response.on("close", () => upstream.destroy()); // the request's own `close` fires when it is read, not when the client leaves
    request.pipe(upstream);
  });
  return {
    url,
    refused: () => refused,
    cut() {
      down = true;
      for (const socket of streams) socket.destroy();
      streams.clear();
    },
    restore() {
      down = false;
    },
  };
}

test("ARK-T310 A dropped event stream shows the frozen-data banner, dims the page, and keeps the stale chip list working without moving the header", async ({
  page,
}) => {
  test.slow();
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
  const hubUrl = await launch();
  const proxy = await proxyHub(hubUrl);
  // The page clock starts at 14:02:05 and runs. The page notes when each snapshot arrived: the
  // banner shows the time of the last one.
  await page.clock.install({ time: dateOf("2026-11-04T14:02:05") });
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL) {
        super(url);
        this.addEventListener("message", () => {
          (window as unknown as LiveWindow).__lastSnapshotAt =
            performance.timeOrigin + performance.now();
        });
      }
    };
  });
  await open(page, proxy.url, "");
  // The chip is absent until the first snapshot: wait for it, or the count-0 wait below passes at once.
  await expect(page.getByTestId("stale-chip")).toBeVisible({ timeout: 60_000 });
  // Every source reads once (the chip vanishes), then each fails: the stale sources have a last
  // read and so an age, never "unknown", however slow the runner is.
  writeFileSync(join(state, "orca.mode"), "up");
  writeFileSync(join(state, "plannotator.mode"), "up");
  await expect(page.getByTestId("stale-chip")).toHaveCount(0, { timeout: 60_000 });
  writeFileSync(join(state, "orca.mode"), "down");
  writeFileSync(join(state, "plannotator.mode"), "down");

  const chip = page.getByTestId("stale-chip");
  const list = page.getByTestId("stale-list");
  const banner = page.locator(".banner");
  const main = page.locator("main");
  const header = page.locator("header.top");
  const heightOf = async () => (await header.boundingBox())!.height;
  const mainTop = async () => (await main.boundingBox())!.y;
  await expect(chip).toHaveText(/ \+([3-9]|\d\d+)$/, { timeout: 60_000 });
  await expect(chip).toHaveText(/^\w+ (unknown|stale \d+ min)/);
  await expect(page.getByTestId("stale-label")).toHaveCount(0);
  await expect(banner).toHaveCount(0);
  await expect(main).toHaveCSS("opacity", "1");
  await checkpoint(page, "stale-chip");
  const height = await heightOf();
  const top = await mainTop();

  // The age moves by whole minutes: 3 minutes on the page clock show as 2 or more.
  await expect(chip).toContainText("stale", { timeout: 60_000 });
  await chip.click();
  const orcaAge = list.locator('[data-source="orca"] span').first();
  await expect(orcaAge).toHaveText(/^\d+ min$/, { timeout: 60_000 });
  await page.clock.fastForward(180_000);
  await expect(orcaAge).toHaveText(/^([2-9]|\d\d+) min$/);

  // The list names what each stale source affects, opens and closes from the keyboard, and does not move the header.
  await expect(list.locator('[data-source="orca"]')).toContainText("Agents");
  await expect(list.locator('[data-source="plannotator"]')).toContainText("Plannotator");
  expect(await heightOf()).toBe(height);
  await checkpoint(page, "chip-list-open");
  // The list is visible, not clipped by an ancestor: the point at its centre hits the list.
  await expect
    .poll(() =>
      list.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !!hit && element.contains(hit);
      }),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(chip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(list).toBeVisible();
  expect(await heightOf()).toBe(height);

  // The stream drops: a banner with the frozen time, dimmed content, the list still open, nothing moved.
  await page.evaluate(() => {
    const live = window as unknown as LiveWindow;
    let seen = false;
    live.__gaps = 0;
    new MutationObserver(() => {
      if (document.querySelector(".banner")) seen = true;
      else if (seen) live.__gaps++;
    }).observe(document.body, { childList: true, subtree: true });
  });
  proxy.cut();
  await expect(banner).toBeVisible();
  const frozenAt = await page.evaluate(() =>
    new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(
      (window as unknown as LiveWindow).__lastSnapshotAt,
    ),
  );
  await expect(banner).toHaveText(`Disconnected: data frozen at ${frozenAt}`);
  await expect(main).toHaveCSS("opacity", "0.55");
  await expect(list).toBeVisible();
  expect(await heightOf()).toBe(height);
  expect(await mainTop()).toBe(top);
  // The banner sits in the reserved header row: it covers no content.
  const bannerBox = (await banner.boundingBox())!;
  expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual((await mainTop()) + 0.5);
  await checkpoint(page, "disconnected-banner");
  // EventSource retries about every 3 s: the banner stays through 3 attempts.
  await expect.poll(() => proxy.refused(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => (window as unknown as LiveWindow).__gaps)).toBe(0);
  await expect(banner).toHaveCount(1);

  // The stream returns: the banner and the dimming go.
  proxy.restore();
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
  await expect(main).toHaveCSS("opacity", "1");
  await checkpoint(page, "reconnected");
  expect(await heightOf()).toBe(height);

  // No stale source: dropping the stream shows the banner with no chip.
  writeFileSync(join(state, "orca.mode"), "up");
  writeFileSync(join(state, "plannotator.mode"), "up");
  await expect(chip).toHaveCount(0, { timeout: 60_000 });
  proxy.cut();
  await expect(banner).toHaveText(/^Disconnected: data frozen at /);
  expect(await heightOf()).toBe(height);
});

// ---------------------------------------------------------------- ARK-345 Conversation tab
//
// The hub's own conversation read is proven by ARK-T319 to ARK-T321. These cases prove what the page
// draws from that read, so the run page is real and the read's reply is a fixture the page fetches.

const conversationStart = Date.parse("2026-11-12T08:00:00.000Z");
const conversationMinute = (minutes: number) => conversationStart + minutes * 60_000;
const isoOf = (time: number) => dateOf(time).toISOString();
/** The clock text of a time in UTC, the way the page prints it: HH:MM:SS. */
const clockOf = (time: number) => isoOf(time).slice(11, 19);

const noAgent = { handle: null, step: null, role: null, group: null, title: null };
const chiefAgent: ConversationAgent = { id: "chief", kind: "chief", ...noAgent };
const leadAgent: ConversationAgent = { id: "lead", kind: "run_lead", ...noAgent };
const workerAgent = (step: string, role: string, group: RoleGroup): ConversationAgent => ({
  id: `worker:${step}`,
  kind: "worker",
  handle: null,
  step,
  role,
  group,
  title: step,
});
const spanOf = (
  step: string,
  role: string,
  group: RoleGroup,
  startMinute: number,
  endMinute: number,
): ConversationSpan => ({
  step,
  role,
  group,
  agent: `worker:${step}`,
  start: isoOf(conversationMinute(startMinute)),
  end: isoOf(conversationMinute(endMinute)),
});

/** A message sent at `time` (epoch milliseconds) and delivered 5 s later unless the fields say otherwise. */
function messageOf(
  id: string,
  from: string,
  to: string,
  time: number,
  fields: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id,
    type: "status",
    from_handle: from,
    to_handle: to,
    subject: id,
    body: null,
    thread_id: null,
    run_id: null,
    created_at: isoOf(time),
    delivered_at: isoOf(time + 5_000),
    from,
    to,
    ...fields,
  };
}

type ConversationParts = {
  agents: ConversationAgent[];
  spans?: ConversationSpan[];
  events?: ArkEvent[];
  answers?: { time: string; gate: string | null; answer: string | null }[];
  questions?: ConversationQuestion[];
  messages: ConversationMessage[];
};

/** What `GET /api/run/<run>/conversation` answers: the read's states and the run's conversation. */
const conversationReply = (
  run: string,
  parts: ConversationParts,
  state: { truncated?: boolean; stale?: boolean; directory?: "loading" | "ready" } = {},
) => ({
  truncated: false,
  stale: false,
  directory: "ready",
  read_at: isoOf(conversationStart),
  run,
  project: "p",
  spans: [],
  events: [],
  answers: [],
  questions: [],
  ...parts,
  ...state,
});

/** Serves the conversation read of the page from `reply`; a number answers with that status. Counts the reads. */
async function serveConversation(
  page: Page,
  reply: () => object | number,
): Promise<{ reads: () => number }> {
  let reads = 0;
  await page.route("**/api/run/*/conversation", (route) => {
    reads += 1;
    const answer = reply();
    return typeof answer === "number"
      ? route.fulfill({ status: answer, body: "" })
      : route.fulfill({ json: answer });
  });
  return { reads: () => reads };
}

const conversationContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(conversationContexts.splice(0).map((context) => context.close()));
});

/** A page of 1440x900 in UTC, so the clock text of a fixture time never depends on the machine. */
async function conversationPage(
  browser: Browser,
  options: { reducedMotion?: "reduce" } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    timezoneId: "UTC",
    colorScheme: "dark",
    ...options,
  });
  conversationContexts.push(context);
  return context.newPage();
}

/** A closed run on a fresh ARK_HOME with no session files, served by a new hub. */
async function conversationRun(ticket: string): Promise<{ run: string; baseUrl: string }> {
  isolate();
  const run = runId(ticket);
  writeRun({
    project: "p",
    run,
    ticket: { id: ticket, title: "Conversation" },
    phase: "closed",
    startedAt: ago(7_200),
  });
  installFakeTools({});
  return { run, baseUrl: await launch() };
}

async function openConversation(page: Page, baseUrl: string, run: string): Promise<void> {
  await open(page, baseUrl, `run/${run}/conversation`);
  await expect(page.getByTestId("trace")).toBeVisible();
}

/** Text of the tab at 4.5:1 or better, in dark and in light. */
async function expectReadableInBothThemes(page: Page): Promise<void> {
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // The page starts dark: light first, then dark again, so each theme is reached by a change.
  for (const colorScheme of ["light", "dark"] as const) {
    const before = await background();
    await page.emulateMedia({ colorScheme });
    await expect.poll(background).not.toBe(before);
    // A color that still fades from the other theme is not the color the page rests on.
    await finiteAnimationsEnded(page);
    const { checked, weak } = await weakContrast(page);
    expect(checked, colorScheme).toBeGreaterThan(20);
    expect(weak, colorScheme).toEqual([]);
  }
}

test("ARK-T340 the Conversation tab opens from the run page, keeps the sub routes, and shows the design reference files", async ({
  browser,
}) => {
  for (const file of ["hybrid-2.html", "data.js"])
    expect(
      statSync(join(process.cwd(), "docs/design/agent-comms", file)).size,
      file,
    ).toBeGreaterThan(0);

  const { sessions } = isolate();
  const run = runId("ARK-9401");
  const started = ago(7_200);
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-9401", title: "Tab" },
    phase: "building",
    startedAt: started,
    steps: [
      {
        id: "work",
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 60,
        finishedAfter: 600,
      },
    ],
  });
  writeSessionFile(
    sessions,
    "work.jsonl",
    transcriptText("omp", {
      cwd: join(directory, "workspace"),
      start: dateOf(started.getTime() + 100_000),
    }),
  );
  installFakeTools({});
  const baseUrl = await launch();

  const page = await conversationPage(browser);
  let reply: object | number = conversationReply(run, {
    agents: [chiefAgent, leadAgent, workerAgent("work", "implementer", "Implementers")],
    spans: [spanOf("work", "implementer", "Implementers", 1, 9)],
    messages: [
      messageOf("first", "lead", "chief", conversationMinute(2), { subject: "First message" }),
      messageOf("second", "chief", "lead", conversationMinute(4), { subject: "Second message" }),
    ],
  });
  const served = await serveConversation(page, () => reply);

  // The run page opens on its overview; the tab is one click away and lives in the hash.
  await open(page, baseUrl, `run/${run}`);
  await expect(page.getByTestId("step-node")).toHaveCount(1);
  await expect(page.getByTestId("conversation")).toHaveCount(0);
  await page.getByTestId("run-tab-conversation").click();
  await expect(page).toHaveURL(new RegExp(`#/run/${run}/conversation$`));
  await expect(page.getByTestId("trace")).toBeVisible();
  await expect(page.getByTestId("feed-message")).toHaveCount(2);
  await checkpoint(page, "conversation-tab-dark");

  // A reload on the tab hash keeps the tab.
  await page.reload();
  await expect(page.getByTestId("trace")).toBeVisible();
  await expect(page.getByTestId("run-tab-conversation")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("step-node")).toHaveCount(0);

  // Back to the overview, into a transcript and back: each route opens as before.
  await page.getByTestId("run-tab-overview").click();
  await expect(page.getByTestId("run-tab-overview")).toHaveAttribute("aria-current", "page");
  await page.locator('[data-testid="step-node"][data-step="work"] a').click();
  await expect(page).toHaveURL(new RegExp(`#/run/${run}/step/work$`));
  await expect(page.getByTestId("transcript-entry").first()).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("step-node")).toHaveCount(1);
  await expect(page.getByTestId("run-tab-overview")).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page.getByTestId("trace")).toBeVisible();
  await expect(page.getByTestId("run-tab-conversation")).toHaveAttribute("aria-current", "page");

  // Each state of the read is a notice, and the trace still draws what it has.
  const parts: ConversationParts = {
    agents: [chiefAgent, leadAgent],
    messages: [messageOf("only", "lead", "chief", conversationMinute(2))],
  };
  const notices: [string, object, string][] = [
    ["loading", conversationReply(run, parts, { directory: "loading" }), "conversation-loading"],
    ["truncated", conversationReply(run, parts, { truncated: true }), "conversation-truncated"],
    ["stale", conversationReply(run, parts, { stale: true }), "conversation-stale"],
  ];
  for (const [name, variant, testId] of notices) {
    reply = variant;
    await page.reload();
    await expect(page.getByTestId(testId), name).toBeVisible();
    await expect(page.getByTestId("trace-row"), name).toHaveCount(6);
    await expect(page.getByTestId("feed-message"), name).toHaveCount(1);
    if (name === "truncated") await checkpoint(page, "truncated-notice");
  }
  reply = conversationReply(run, parts);
  await page.reload();
  for (const testId of ["conversation-loading", "conversation-truncated", "conversation-stale"])
    await expect(page.getByTestId(testId)).toHaveCount(0);

  // A loading directory logs no event: the tab reads again on its own and the notice clears, no reload.
  reply = conversationReply(run, parts, { directory: "loading" });
  await page.reload();
  await expect(page.getByTestId("conversation-loading")).toBeVisible();
  await expect(page.getByTestId("feed-message")).toHaveCount(1);
  reply = conversationReply(run, {
    ...parts,
    messages: [
      messageOf("only", "lead", "chief", conversationMinute(2)),
      messageOf("later", "chief", "lead", conversationMinute(3)),
    ],
  });
  await expect(page.getByTestId("conversation-loading")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("feed-message")).toHaveCount(2);
  reply = conversationReply(run, parts);
  await page.reload();
  await expect(page.getByTestId("feed-message")).toHaveCount(1);

  // A failed refetch keeps the last read: the notice shows, the feed and the selection stay.
  await page.locator('[data-testid="feed-message"][data-id="only"] .cv-subject').click();
  await expect(page.getByTestId("inspector-type")).toBeVisible();
  const reads = served.reads();
  reply = 502;
  appendRawEvent(
    directory,
    "worker.started",
    { step: "work", dispatch: "ctx_w", terminal: "t" },
    readFileSync(join(directory, "events.ndjson"), "utf8").trim().split("\n").length + 1,
  );
  await expect.poll(served.reads).toBeGreaterThan(reads);
  await expect(page.getByTestId("conversation-refetch-failed")).toBeVisible();
  await expect(page.getByTestId("feed-message")).toHaveCount(1);
  await expect(page.getByTestId("inspector-type")).toBeVisible();
  reply = conversationReply(run, parts);
  await page.reload();

  // A read the hub cannot answer yet is an alert, not an empty trace.
  reply = 503;
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("has not read the inbox yet");
  await expect(page.getByTestId("trace")).toHaveCount(0);
});

test("ARK-T341 the trace shows the Master Chief, run lead and role-group rows, expands a group, and fits 19 workers at 1440x900 collapsed", async ({
  browser,
}) => {
  const { run, baseUrl } = await conversationRun("ARK-9402");
  // 3 planning, 8 implementer, 4 validator and 4 reviewer workers; the workers of a group overlap.
  const groups: [RoleGroup, string, string, number, number, number][] = [
    ["Planning", "plan", "designer", 3, 0, 3],
    ["Implementers", "impl", "implementer", 8, 10, 3],
    ["Validators", "valid", "validator", 4, 40, 5],
    ["Reviewers", "review", "reviewer", 4, 70, 8],
  ];
  const agents = [chiefAgent, leadAgent];
  const spans: ConversationSpan[] = [];
  for (const [group, prefix, role, count, firstStart, stagger] of groups)
    for (let index = 1; index <= count; index++) {
      const step = `${prefix}-${index}`;
      agents.push(workerAgent(step, role, group));
      const start = firstStart + (index - 1) * stagger;
      // Spans last 20 minutes (validators 5, so the run lead idles from 60 to 70); the last reviewer ends the run at 100.
      const length = group === "Validators" ? 5 : 20;
      const end = group === "Reviewers" && index === 4 ? 100 : start + length;
      spans.push(spanOf(step, role, group, start, end));
    }
  expect(agents.length - 2).toBe(19);
  const page = await conversationPage(browser);
  await serveConversation(page, () =>
    conversationReply(run, {
      agents,
      spans,
      // The run lead waits on the human twice: 12-15 and 40-45.
      messages: [
        messageOf("ask-1", "lead", "chief", conversationMinute(12), { type: "question" }),
        messageOf("ask-2", "lead", "chief", conversationMinute(40), { type: "question" }),
      ],
      questions: [
        {
          id: "ask-1",
          sent: isoOf(conversationMinute(12)),
          delivered: isoOf(conversationMinute(12)),
          answered: isoOf(conversationMinute(15)),
          pickup_seconds: 0,
        },
        {
          id: "ask-2",
          sent: isoOf(conversationMinute(40)),
          delivered: isoOf(conversationMinute(40)),
          answered: isoOf(conversationMinute(45)),
          pickup_seconds: 0,
        },
      ],
      answers: [
        { time: isoOf(conversationMinute(15)), gate: "criteria", answer: "accept" },
        { time: isoOf(conversationMinute(45)), gate: "plan", answer: "approve" },
      ],
    }),
  );
  await openConversation(page, baseUrl, run);
  const trace = page.getByTestId("trace");
  const rowOf = (key: string) => page.locator(`[data-testid="trace-row"][data-row="${key}"]`);

  // The time axis, with the minimap brush over the whole run.
  await expect(trace.locator(".cv-axis-label")).toHaveCount(5);
  await expect(page.getByTestId("trace-minimap")).toBeVisible();
  await expect(page.getByTestId("trace-brush")).toBeVisible();

  // Master Chief: one person marker for each human answer. Run lead: waiting and idle bars.
  await expect(rowOf("chief").getByTestId("answer-marker")).toHaveCount(2);
  await expect(rowOf("chief").getByTestId("answer-marker").first()).toHaveAttribute(
    "aria-label",
    "You answered criteria: accept at 08:15:00",
  );
  await expect(rowOf("lead").getByTestId("trace-waiting")).toHaveCount(2);
  await expect(rowOf("lead").getByTestId("trace-idle").first()).toBeVisible();

  // Four collapsed group rows with their workers counted, each in its own role colour.
  await expect(page.getByTestId("trace-row")).toHaveCount(6);
  const labels = await page
    .getByTestId("trace-group")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  expect(labels).toEqual([
    "Planning, 3 workers",
    "Implementers, 8 workers",
    "Validators, 4 workers",
    "Reviewers, 4 workers",
  ]);
  const colours = await Promise.all(
    groups.map(([group]) =>
      rowOf(`group:${group}`)
        .getByTestId("trace-bar")
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor),
    ),
  );
  expect(new Set(colours).size).toBe(4);

  // 19 workers fit: no scroll in the trace and the whole trace inside 1440x900.
  const fit = async () => {
    const box = (await trace.boundingBox())!;
    const scroll = await trace.evaluate((node) => ({
      client: node.clientHeight,
      scroll: node.scrollHeight,
    }));
    expect(scroll.scroll).toBeLessThanOrEqual(scroll.client);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
  };
  await fit();
  await checkpoint(page, "collapsed-19-workers-dark");

  // Hover on the Implementers row at minute 20 names the four overlapping workers, no others.
  const lane = (await rowOf("group:Implementers").locator(".cv-lane").boundingBox())!;
  await page.mouse.move(lane.x + lane.width * 0.2, lane.y + lane.height / 2);
  const tip = page.getByTestId("trace-tip");
  await expect(tip).toBeVisible();
  for (const step of ["impl-1", "impl-2", "impl-3", "impl-4"])
    await expect(tip).toContainText(step);
  await expect(tip).not.toContainText("impl-5");
  await checkpoint(page, "overlap-hover");

  // A click on the group row expands it to one row per worker; a second click collapses it.
  await page.getByRole("button", { name: "Implementers, 8 workers" }).click();
  await expect(page.locator('[data-testid="trace-row"][data-row^="worker:"]')).toHaveCount(8);
  await expect(page.getByTestId("trace-row")).toHaveCount(14);
  await checkpoint(page, "group-expanded");
  await expectReadableInBothThemes(page);
  await page.getByRole("button", { name: "Implementers, 8 workers" }).click();
  await expect(page.getByTestId("trace-row")).toHaveCount(6);
  await fit();
});

test("ARK-T342 the feed lists messages with avatar, role, time, Markdown body and Show more, threads, question cards, folded events, chips and search", async ({
  browser,
}) => {
  const { run, baseUrl } = await conversationRun("ARK-9403");
  const at = conversationMinute;
  const event = (seq: number, minutes: number, type: string): ArkEvent => ({
    seq,
    time: isoOf(at(minutes)),
    type,
    data: { step: "impl" },
  });
  const reportLines = Array.from({ length: 12 }, (_, line) => `Line ${line + 1} of the report`);
  // Messages in a shuffled order: the feed sorts them oldest first.
  const messages = [
    messageOf("after", "chief", "lead", at(25), { subject: "After the events" }),
    messageOf("qw", "lead", "chief", at(12), { type: "question", subject: "Merge?" }),
    messageOf("t1b", "chief", "lead", at(5), { thread_id: "t1", subject: "Reply two" }),
    messageOf("plain", "lead", "chief", at(1), {
      subject: "Plan ready",
      body: "**bold** text\n\n- first item\n- second item\n\n<script>window.__pwned = 1</script><b>raw</b> html",
    }),
    messageOf("long", "lead", "chief", at(2), {
      subject: "Long report",
      body: reportLines.join("\n"),
    }),
    messageOf("edge600", "lead", "chief", at(2) + 20_000, {
      subject: "At the cut",
      body: "y".repeat(600),
    }),
    messageOf("edge601", "lead", "chief", at(2) + 40_000, {
      subject: "Past the cut",
      body: "x".repeat(601),
    }),
    messageOf("t1", "lead", "chief", at(3), { subject: "Thread root" }),
    messageOf("t1a", "chief", "lead", at(4), { thread_id: "t1", subject: "Reply one" }),
    messageOf("t1c", "chief", "lead", at(6), { thread_id: "t1", subject: "Reply three" }),
    messageOf("qa", "lead", "chief", at(8), { type: "question", subject: "Criteria?" }),
  ];
  const page = await conversationPage(browser);
  await serveConversation(page, () =>
    conversationReply(run, {
      agents: [chiefAgent, leadAgent],
      messages,
      answers: [{ time: isoOf(at(10)), gate: "criteria", answer: "accept" }],
      questions: [
        {
          id: "qa",
          sent: isoOf(at(8)),
          delivered: isoOf(at(9)),
          answered: isoOf(at(10)),
          pickup_seconds: 60,
        },
        {
          id: "qw",
          sent: isoOf(at(12)),
          delivered: isoOf(at(13)),
          answered: null,
          pickup_seconds: 60,
        },
      ],
      // 2 events in a row, a message, then 3 in a row.
      events: [
        event(1, 20, "step.started"),
        event(2, 21, "step.finished"),
        event(3, 30, "step.started"),
        event(4, 31, "step.finished"),
        event(5, 32, "test.completed"),
      ],
    }),
  );
  await openConversation(page, baseUrl, run);
  const feed = page.getByTestId("feed");
  const message = (id: string) => feed.locator(`[data-testid="feed-message"][data-id="${id}"]`);

  // Oldest first, thread replies collapsed.
  expect(
    await feed
      .getByTestId("feed-message")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id"))),
  ).toEqual(["plain", "long", "edge600", "edge601", "t1", "qa", "qw", "after"]);
  await checkpoint(page, "feed-top-dark");

  // One message in full: avatar, role badge, time and subject, and a Markdown body whose HTML is text.
  const plain = message("plain");
  await expect(plain.locator(".cv-avatar")).toHaveText("RL");
  await expect(plain.locator(".cv-badge")).toHaveText("run lead");
  await expect(plain.locator(".cv-head .mono")).toHaveText(clockOf(at(1)));
  await expect(plain.locator(".cv-subject")).toHaveText("Plan ready");
  await expect(plain.locator(".cv-body strong")).toHaveText("bold");
  await expect(plain.locator(".cv-body li")).toHaveCount(2);
  await expect(plain.locator(".cv-body")).toContainText("<b>raw</b> html");
  await expect(plain.locator(".cv-body b, .cv-body script")).toHaveCount(0);
  expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
  await expect(plain.getByRole("button", { name: "Show more" })).toHaveCount(0);

  // A body is cut past 600 characters or 8 lines; Show more opens it.
  await expect(message("edge600").getByRole("button", { name: "Show more" })).toHaveCount(0);
  await expect(message("edge601").getByRole("button", { name: "Show more" })).toHaveCount(1);
  const long = message("long");
  await expect(long.locator(".cv-body")).toHaveAttribute("data-clamped", "true");
  await long.getByRole("button", { name: "Show more" }).click();
  await expect(long.locator(".cv-body")).toHaveAttribute("data-clamped", "false");
  await expect(long.getByRole("button", { name: "Show less" })).toBeVisible();

  // A thread is its root and "3 replies".
  const replies = feed.getByTestId("feed-replies");
  await expect(replies).toHaveText("3 replies");
  await replies.click();
  await expect(message("t1a")).toBeVisible();
  await expect(message("t1c")).toBeVisible();
  await expect(feed.getByTestId("feed-message")).toHaveCount(11);
  await replies.click();
  await expect(feed.getByTestId("feed-message")).toHaveCount(8);

  // A question card: the answer with its gate, or the waiting text.
  await expect(message("qa").getByTestId("feed-answer")).toContainText(
    "You answered criteria: accept",
  );
  await expect(message("qa").getByTestId("feed-waiting")).toHaveCount(0);
  await expect(message("qw").getByTestId("feed-waiting")).toHaveText(
    "Waiting for an answer from you",
  );
  await expect(message("qw").getByTestId("feed-answer")).toHaveCount(0);
  await message("qw").scrollIntoViewIfNeeded();
  await checkpoint(page, "question-cards");

  // Ark events: 2 in a row stay 2 quiet lines; 3 in a row fold into one line that opens.
  await expect(feed.getByTestId("feed-events")).toHaveCount(1);
  await expect(feed.getByTestId("feed-events").getByTestId("feed-event")).toHaveCount(2);
  const folded = feed.getByTestId("feed-events-folded");
  await expect(folded).toHaveCount(1);
  await expect(folded).toContainText(`3 Ark events, ${clockOf(at(30))}–${clockOf(at(32))}`);
  await folded.scrollIntoViewIfNeeded();
  await checkpoint(page, "folded-events");
  await folded.getByRole("button").click();
  await expect(feed.getByTestId("feed-events").getByTestId("feed-event")).toHaveCount(5);

  // A chip keeps one type; clicking it again restores the feed.
  const chip = feed.locator('[data-testid="feed-chip"][data-chip="question"]');
  await chip.click();
  await expect(feed.getByTestId("feed-message")).toHaveCount(2);
  expect(
    await feed
      .getByTestId("feed-message")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-type"))),
  ).toEqual(["question", "question"]);
  await chip.click();
  await expect(feed.getByTestId("feed-message")).toHaveCount(8);

  // Search reads the subject and the body.
  const search = feed.getByTestId("feed-search");
  await search.fill("Criteria");
  await expect(feed.getByTestId("feed-message")).toHaveCount(1);
  await expect(message("qa")).toBeVisible();
  await search.fill("second item");
  await expect(feed.getByTestId("feed-message")).toHaveCount(1);
  await expect(message("plain")).toBeVisible();
  await search.fill("");
  await expect(feed.getByTestId("feed-message")).toHaveCount(8);

  await expectReadableInBothThemes(page);
});

test("ARK-T343 a click on a tick, a cluster or a feed message links the trace and the feed both ways, and the trace cursor follows the feed scroll", async ({
  browser,
}) => {
  const { run, baseUrl } = await conversationRun("ARK-9404");
  // 9 hours: a message every 15 minutes, Master Chief and the run lead taking turns, and a burst of
  // three from the run lead inside one minute at 4 h that is one cluster at full view.
  const messages: ConversationMessage[] = [];
  for (let index = 0; index <= 35; index++) {
    if (index === 16) continue;
    const [from, to] = index % 2 === 0 ? ["lead", "chief"] : ["chief", "lead"];
    messages.push(
      messageOf(`m${index}`, from!, to!, conversationMinute(index * 15), {
        subject: `Message ${index}`,
      }),
    );
  }
  for (const [id, seconds] of [
    ["burst-1", 0],
    ["burst-2", 20],
    ["burst-3", 40],
  ] as const)
    messages.push(
      messageOf(id, "lead", "chief", conversationMinute(240) + seconds * 1000, { subject: id }),
    );
  const page = await conversationPage(browser);
  await serveConversation(page, () =>
    conversationReply(run, { agents: [chiefAgent, leadAgent], messages }),
  );
  await openConversation(page, baseUrl, run);
  const feed = page.getByTestId("feed");
  const scroller = feed.locator(".cv-scroller");
  const message = (id: string) => feed.locator(`[data-testid="feed-message"][data-id="${id}"]`);
  const brushWidth = async () => (await page.getByTestId("trace-brush").boundingBox())!.width;
  const reset = page.getByTestId("trace-reset");
  const inView = async (id: string) => {
    const box = await message(id).boundingBox();
    const area = (await scroller.boundingBox())!;
    return box !== null && box.y >= area.y - 1 && box.y + box.height <= area.y + area.height + 1;
  };
  // Puts the message at the top of the feed, as a wheel scroll would.
  const scrollToTop = (id: string) =>
    scroller.evaluate((node, target) => {
      const row = node.querySelector<HTMLElement>(`[data-id="${target}"]`)!;
      node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top + 3;
    }, id);
  const full = await brushWidth();
  await expect(reset).toBeDisabled();
  await expect(page.getByTestId("trace-cluster")).toHaveCount(1);
  await expect(page.getByTestId("trace-cluster")).toHaveAttribute(
    "data-ids",
    "burst-1 burst-2 burst-3",
  );

  // A tick: the axis zooms, the message is selected and the feed scrolls it into view.
  await page.locator('[data-testid="trace-tick"][data-id="m8"]').click();
  await expect(reset).toBeEnabled();
  expect(await brushWidth()).toBeLessThan(full);
  await expect(message("m8")).toHaveAttribute("aria-current", "true");
  await expect.poll(() => inView("m8")).toBe(true);
  await expect(page.getByTestId("inspector")).toContainText("Message 8");
  await checkpoint(page, "after-tick-click");

  // A cluster: the axis zooms until its ticks separate, and its first message is selected.
  await reset.click();
  await expect(reset).toBeDisabled();
  const beforeCluster = await brushWidth();
  await page.getByTestId("trace-cluster").click();
  await expect(page.getByTestId("trace-cluster")).toHaveCount(0);
  expect(await brushWidth()).toBeLessThan(beforeCluster);
  for (const id of ["burst-1", "burst-2", "burst-3"])
    await expect(page.locator(`[data-testid="trace-tick"][data-id="${id}"]`)).toBeVisible();
  await expect(message("burst-1")).toHaveAttribute("aria-current", "true");
  await checkpoint(page, "after-cluster-zoom");

  // A feed message: its tick is marked and an arrow runs from the sender's row to the receiver's.
  await expect.poll(() => inView("m17")).toBe(true);
  await message("m17").locator(".cv-subject").click();
  await expect(page.locator('[data-testid="trace-tick"][data-id="m17"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const arrow = page.getByTestId("trace-arrow");
  await expect(arrow).toHaveAttribute("data-from", "chief");
  await expect(arrow).toHaveAttribute("data-to", "lead");
  await checkpoint(page, "arrow-after-feed-click");

  // The cursor follows the time of the top message of the feed.
  await reset.click();
  await scrollToTop("m25");
  await expect(page.getByTestId("trace-cursor")).toHaveAttribute(
    "data-time",
    String(conversationMinute(25 * 15)),
  );
  await scrollToTop("m5");
  await expect(page.getByTestId("trace-cursor")).toHaveAttribute(
    "data-time",
    String(conversationMinute(5 * 15)),
  );
});

test("ARK-T344 the inspector shows a selected question with sent, delivered, waits, answer, thread and body, and its transcript buttons open the entries nearest the sent time", async ({
  browser,
}) => {
  const { sessions } = isolate();
  const run = runId("ARK-9405");
  // A fixed start 30 minutes before UTC midnight: the run crosses a day, so every clock label carries its
  // date, and the expected text never depends on the hour the suite runs at.
  const started = dateOf("2026-11-12T23:30:00.000Z");
  const dated = (time: number) =>
    `${String(dateOf(time).getUTCDate()).padStart(2, "0")} Nov ${clockOf(time)}`;
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-9405", title: "Inspector" },
    phase: "closed",
    startedAt: started,
    steps: [
      {
        id: "work",
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 60,
        finishedAfter: 600,
      },
    ],
    metricsText: JSON.stringify({ cost: { total_usd: 1.5, by_step: { work: { usd: 1.5 } } } }),
  });
  // The run lead's file starts before the first step; the step's file starts inside its window.
  // Each holds the standard entries at 1 to 4 seconds and three more at 20, 22 and 24 seconds.
  const extra: ExtraEntry[] = ["a", "b", "c"].map((letter) => ({
    kind: "assistant",
    text: `extra ${letter}`,
  }));
  const cwd = join(directory, "workspace");
  const leadStart = started.getTime() + 10_000;
  const stepStart = started.getTime() + 100_000;
  writeSessionFile(
    sessions,
    "lead.jsonl",
    transcriptText("omp", { cwd, start: dateOf(leadStart), extra }),
  );
  writeSessionFile(
    sessions,
    "step.jsonl",
    transcriptText("omp", { cwd, start: dateOf(stepStart), extra }),
  );
  // A second file of the same step, written after the first one ended (a rework round).
  const lateStart = started.getTime() + 400_000;
  writeSessionFile(
    sessions,
    "step-late.jsonl",
    transcriptText("omp", { cwd, start: dateOf(lateStart), extra }),
  );
  // A file's window ends at its last write: close the first step file before the second begins.
  const stepEnd = dateOf(stepStart + 30_000);
  utimesSync(join(sessions, "step.jsonl"), stepEnd, stepEnd);
  installFakeTools({});
  const baseUrl = await launch();

  // Sent 22.2 s into each file: nearest the entry at 22 s, the seventh row, neither the first nor the last.
  const leadSent = leadStart + 22_200;
  const stepSent = stepStart + 22_200;
  const delivered = leadSent + 12 * 60_000;
  const answered = delivered + 5 * 60_000;
  const ghost: ConversationAgent = {
    id: "session:ghost",
    kind: "session",
    handle: "ghost",
    step: null,
    role: null,
    group: null,
    title: null,
  };
  const worker = workerAgent("work", "implementer", "Implementers");
  const messages = [
    messageOf("q1", "lead", "chief", leadSent, {
      type: "question",
      subject: "Which criteria?",
      body: "Pick **one** of the two.",
      delivered_at: isoOf(delivered),
    }),
    messageOf("q1-reply", "chief", "lead", answered + 1_000, {
      thread_id: "q1",
      subject: "Re: Which criteria?",
    }),
    messageOf("q2", "lead", "chief", leadSent + 30 * 60_000, {
      type: "question",
      subject: "Merge now?",
      delivered_at: null,
    }),
    messageOf("from-worker", worker.id, "lead", stepSent, { subject: "Step done" }),
    messageOf("from-worker-late", worker.id, "lead", lateStart + 22_200, {
      subject: "Round two done",
    }),
    messageOf("from-ghost", ghost.id, "lead", leadSent + 40 * 60_000, { subject: "Who am I" }),
  ];
  const page = await conversationPage(browser);
  await serveConversation(page, () =>
    conversationReply(run, {
      agents: [chiefAgent, leadAgent, worker, ghost],
      spans: [
        {
          step: "work",
          role: "implementer",
          group: "Implementers",
          agent: worker.id,
          start: isoOf(started.getTime() + 60_000),
          end: isoOf(started.getTime() + 600_000),
        },
      ],
      messages,
      answers: [{ time: isoOf(answered), gate: "criteria", answer: "accept" }],
      questions: [
        {
          id: "q1",
          sent: isoOf(leadSent),
          delivered: isoOf(delivered),
          answered: isoOf(answered),
          pickup_seconds: 720,
        },
        {
          id: "q2",
          sent: isoOf(leadSent + 30 * 60_000),
          delivered: null,
          answered: null,
          pickup_seconds: "not recorded",
        },
      ],
    }),
  );
  await openConversation(page, baseUrl, run);
  const inspector = page.getByTestId("inspector");
  const select = (id: string) =>
    page.locator(`[data-testid="feed-message"][data-id="${id}"] .cv-subject`).click();
  const nearestRow = page.locator('[data-testid="transcript-entry"][aria-current="true"]');

  // The answered question: every field of the message, the answer and the wait after it.
  await select("q1");
  await expect(inspector.getByTestId("inspector-type")).toHaveText("question");
  await expect(inspector).toContainText("Run lead");
  await expect(inspector).toContainText("Master Chief");
  await expect(inspector.getByTestId("inspector-sent")).toHaveText(dated(leadSent));
  await expect(inspector.getByTestId("inspector-delivered")).toHaveText(dated(delivered));
  await expect(inspector.getByTestId("inspector-wait")).toHaveText("12.0 min");
  await expect(inspector.getByTestId("inspector-answer")).toContainText(
    "You answered criteria: accept",
  );
  await expect(inspector.getByTestId("inspector-answer")).toContainText(
    "5.0 min after it was picked up",
  );
  await expect(inspector.getByTestId("inspector-thread").getByRole("button")).toHaveCount(2);
  await expect(inspector.getByTestId("inspector-body").locator("strong")).toHaveText("one");
  await checkpoint(page, "inspector-question-dark");

  // The sender's button opens the run lead's transcript at the entry nearest the sent time.
  // Master Chief has no transcript in a run: the receiver's button is disabled and says why.
  await expect(inspector.getByTestId("inspector-transcript-to")).toBeDisabled();
  await expect(inspector.getByTestId("inspector-transcript-to")).toHaveAttribute(
    "title",
    /Master Chief has no transcript/,
  );
  await inspector.getByTestId("inspector-transcript-from").click();
  await expect(page).toHaveURL(new RegExp(`#/run/${run}/lead\\?at=`));
  await expect(page.getByTestId("transcript-entry")).toHaveCount(8);
  await expect(nearestRow).toHaveCount(1);
  await expect(nearestRow).toContainText("extra b");
  await expect(nearestRow).toBeInViewport();
  await checkpoint(page, "transcript-at-sent-time");
  await page.goBack();

  // A question with no delivery time: "not recorded", never the sent time, and no wait.
  await select("q2");
  await expect(inspector.getByTestId("inspector-sent")).toHaveText(dated(leadSent + 30 * 60_000));
  await expect(inspector.getByTestId("inspector-delivered")).toHaveText("not recorded");
  await expect(inspector.getByTestId("inspector-wait")).toHaveText("not recorded");
  await expect(inspector.getByTestId("inspector-answer")).toHaveText(
    "Waiting for an answer from you",
  );

  // A worker's message: its sender button opens the step's transcript, its receiver's the run lead's.
  await select("from-worker");
  await inspector.getByTestId("inspector-transcript-from").click();
  await expect(page).toHaveURL(new RegExp(`#/run/${run}/step/work\\?at=`));
  await expect(page.getByTestId("transcript-entry")).toHaveCount(8);
  await expect(nearestRow).toContainText("extra b");
  await page.goBack();
  await select("from-worker");
  await inspector.getByTestId("inspector-transcript-to").click();
  await expect(page).toHaveURL(new RegExp(`#/run/${run}/lead\\?at=`));
  // The message was sent 90 s after the run lead's file began: the last entry of that file is nearest.
  await expect(nearestRow).toContainText("extra c");
  await page.goBack();

  // A step with a second session file (a rework round): the button opens the file that holds the sent time.
  await select("from-worker-late");
  await inspector.getByTestId("inspector-transcript-from").click();
  await expect(page).toHaveURL(new RegExp(`#/run/${run}/step/work\\?at=`));
  await expect(page.getByTestId("transcript-file")).toHaveCount(2);
  await expect(page.getByTestId("transcript-file").nth(1)).toHaveAttribute("aria-pressed", "true");
  // The first file's last entry is "extra c": only the second file's entry at 22 s is "extra b".
  await expect(nearestRow).toContainText("extra b");
  await page.goBack();

  // A sender with no session file: its button is disabled; the receiver's still works.
  await select("from-ghost");
  await expect(inspector.getByTestId("inspector-transcript-from")).toBeDisabled();
  await expect(inspector.getByTestId("inspector-transcript-to")).toBeEnabled();

  // An agent: role, steps with times, messages sent and received, and the cost.
  await page
    .locator('[data-testid="feed-message"][data-id="from-worker"] [data-testid="feed-agent"]')
    .click();
  await expect(inspector.getByTestId("inspector-role")).toHaveText("implementer");
  await expect(inspector.getByTestId("inspector-steps")).toContainText(
    `work ${dated(started.getTime() + 60_000)}–${dated(started.getTime() + 600_000)}`,
  );
  await expect(inspector.getByTestId("inspector-counts")).toHaveText("2 sent, 0 received");
  await expect(inspector.getByTestId("inspector-cost")).toHaveText("$1.50");
  await expectReadableInBothThemes(page);
});

test("ARK-T345 the replay plays at 600x, moves the playhead, animates arrows, dims the future, and the feed shows only the messages up to the playhead", async ({
  browser,
}) => {
  isolate();
  const run = runId("ARK-9406");
  const directory = writeRun({
    project: "p",
    run,
    ticket: { id: "ARK-9406", title: "Replay" },
    phase: "building",
    startedAt: ago(7_200),
    steps: [
      {
        id: "work",
        role: "implementer",
        harness: "omp",
        model: "m",
        needs: [],
        startedAfter: 60,
      },
    ],
  });
  installFakeTools({});
  const baseUrl = await launch();

  // 3 messages in the first hour and 5 in the second; the run lasts 2 hours (minutes 0 to 120).
  const sentAt = [10, 20, 30, 70, 80, 90, 100, 110];
  const messages = sentAt.map((minute, index) =>
    // The message at minute 30 goes from Master Chief to the run lead: the arrow of the first hour's last message.
    minute === 30
      ? messageOf(`r${index}`, "chief", "lead", conversationMinute(minute))
      : messageOf(`r${index}`, "lead", "chief", conversationMinute(minute)),
  );
  const worker = workerAgent("work", "implementer", "Implementers");
  const reply = () =>
    conversationReply(run, {
      agents: [chiefAgent, leadAgent, worker],
      spans: [spanOf("work", "implementer", "Implementers", 0, 120)],
      messages,
    });
  const firstHour = conversationMinute(45);
  const secondHour = conversationMinute(115);

  const page = await conversationPage(browser);
  // The replay runs on the page clock: 600x is 600 run seconds for each second of it. The clock stands still
  // until a step advances it, so no assertion waits on wall time.
  await page.clock.install({ time: dateOf("2026-11-13T00:00:00Z") });
  const served = await serveConversation(page, reply);
  await openConversation(page, baseUrl, run);
  await page.clock.pauseAt(dateOf("2026-11-13T01:00:00Z"));
  const feedCount = () => page.getByTestId("feed-message");
  const playhead = async () =>
    Number(await page.getByTestId("trace-playhead").getAttribute("data-time"));
  const speed = (rate: number) =>
    page.locator(`[data-testid="replay-speed"][data-speed="${rate}"]`);
  const play = page.getByTestId("replay-play");
  await expect(feedCount()).toHaveCount(8);
  await expect(page.getByTestId("replay-scrubber")).toBeVisible();
  await expect(play).toHaveText("Play");
  await expect(page.getByTestId("replay-speed")).toHaveText(["10x", "60x", "600x"]);

  // 600x for 4.5 s of the page clock is 45 run minutes: 3 messages, the rest dimmed, the last arrow animating.
  await speed(600).click();
  await expect(speed(600)).toHaveAttribute("aria-pressed", "true");
  await play.click();
  await expect(play).toHaveText("Pause");
  await page.clock.runFor(4_500);
  await expect(feedCount()).toHaveCount(3);
  expect(await playhead()).toBeGreaterThan(conversationMinute(44));
  expect(await playhead()).toBeLessThanOrEqual(firstHour);
  await expect(page.getByTestId("trace-future")).toBeVisible();
  await expect(page.locator('[data-testid="trace-tick"].future')).toHaveCount(5);
  await expect(page.locator('[data-testid="trace-tick"]:not(.future)')).toHaveCount(3);
  const pulse = page.getByTestId("trace-pulse");
  await expect(pulse).toHaveAttribute("data-from", "chief");
  await expect(pulse).toHaveAttribute("data-to", "lead");
  expect(
    await pulse.evaluate((line) =>
      line.getAnimations().map((animation) => (animation as CSSAnimation).animationName),
    ),
  ).toContain("cv-pulse");
  await checkpoint(page, "replay-600x-dark");

  // 70 more run minutes: all 8 messages. Pause stops the playhead.
  await page.clock.runFor(7_000);
  await expect(feedCount()).toHaveCount(8);
  await play.click();
  await expect(play).toHaveText("Play");
  const paused = await playhead();
  expect(paused).toBeGreaterThan(conversationMinute(114));
  await page.clock.runFor(3_000);
  expect(await playhead()).toBe(paused);

  // 10x and 60x: the playhead advances 10 or 60 run seconds for each second of the page clock.
  for (const [rate, seconds] of [
    [10, 10],
    [60, 60],
  ] as const) {
    await speed(rate).click();
    await expect(speed(rate)).toHaveAttribute("aria-pressed", "true");
    // Playing again from the end restarts at the beginning; scrub back to minute 50 first.
    await page.getByTestId("replay-scrubber").fill(String(conversationMinute(50)));
    const from = await playhead();
    await play.click();
    await page.clock.runFor(1_000);
    await play.click();
    const moved = (await playhead()) - from;
    // A frame of 16 ms is the clock's resolution.
    expect(moved, `${rate}x`).toBeGreaterThan((seconds - 0.2 * rate) * 1_000);
    expect(moved, `${rate}x`).toBeLessThanOrEqual(seconds * 1_000);
  }

  // The scrubber sets the playhead: back at minute 45 there are 3 messages again, at 115 there are 8.
  await page.getByTestId("replay-scrubber").fill(String(firstHour));
  expect(await playhead()).toBe(firstHour);
  await expect(feedCount()).toHaveCount(3);
  await page.getByTestId("replay-scrubber").fill(String(secondHour));
  await expect(feedCount()).toHaveCount(8);
  await page.getByTestId("replay-scrubber").fill(String(firstHour));

  // A live change of the run during replay re-reads the conversation and leaves the playhead and the speed.
  await speed(600).click();
  const readsBefore = served.reads();
  appendRawEvent(
    directory,
    "worker.started",
    { step: "work", dispatch: "ctx_w", terminal: "t" },
    6,
  );
  await expect.poll(served.reads).toBeGreaterThan(readsBefore);
  expect(await playhead()).toBe(firstHour);
  await expect(speed(600)).toHaveAttribute("aria-pressed", "true");
  await expect(feedCount()).toHaveCount(3);

  // Reduced motion: Play is off and nothing animates, but the scrubber still sets the playhead and the feed.
  const still = await conversationPage(browser, { reducedMotion: "reduce" });
  await serveConversation(still, reply);
  await openConversation(still, baseUrl, run);
  await expect(still.getByTestId("replay-play")).toBeDisabled();
  await expect(still.getByTestId("feed-message")).toHaveCount(8);
  await still.getByTestId("replay-scrubber").fill(String(firstHour));
  await expect(still.getByTestId("feed-message")).toHaveCount(3);
  expect(Number(await still.getByTestId("trace-playhead").getAttribute("data-time"))).toBe(
    firstHour,
  );
  await still.getByTestId("replay-scrubber").fill(String(secondHour));
  await expect(still.getByTestId("feed-message")).toHaveCount(8);
  await expect(still.getByTestId("trace-pulse")).toHaveCount(0);
  expect(
    await still
      .getByTestId("trace")
      .evaluate((node) => node.getAnimations({ subtree: true }).length),
  ).toBe(0);
  await checkpoint(still, "reduced-motion-player");
});
