import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
test.use({ viewport: { width: 1440, height: 1000 } });

let demoDirectory: string;
let oldDirectory: string;
let openRun: string;
let answeredRun: string;
let unansweredRun: string;

const projectConfig = (workspace: string) => ({
  workspace,
  ticket_source: "local",
  suites: [{ name: "cli", level: "integration", repo: ".", command: "bun test", parser: "bun" }],
  roles: {
    implementer: { harness: "omp", model: "pi/task" },
    validator: { harness: "omp", model: "pi/validate" },
    reviewer: { harness: "omp", model: "pi/validate" },
  },
});

/** `writeTicket` writes no status line, so the status-bearing tickets are written here. */
function writeStatusTicket(project: string, id: string, status: string): void {
  const directory = join(process.env.ARK_HOME as string, "projects", project, "tickets");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${id}.md`),
    `---\nid: ${id}\ntitle: "Title of ${id}"\nstatus: ${status}\nacceptance_criteria: []\n---\n## Why\n\nTest.\n`,
  );
}

function terminal(handle: string, connected: boolean, folder: string): object {
  return { handle, connected, agentIdentity: "omp", model: "pi/task", worktreePath: folder };
}

function setTerminals(terminals: object[]): void {
  process.env.TEST_ORCA_TERMINALS = JSON.stringify(terminals);
}

/** A run with one step and one merge request. `retro` is the Close check text, or null for none. */
function startRun(ticketId: string, close: boolean, retro: string | null): string {
  const ticketFile = writeTicket("demo", ticketId, [{ id: `${ticketId}-AC1`, text: "It works" }]);
  const started = ark("run", "start", ticketFile, "--project", "demo");
  if (started.code !== 0) throw new Error(`ark run start failed: ${started.out}\n${started.err}`);
  const run = started.out.trim();
  const directory = join(demoDirectory, "runs", run);
  recordEvaluation(directory);
  writeFileSync(join(directory, "plan.yml"), "steps: []\n");
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps: [{ id: "build", role: "implementer", repo: "." }],
  });
  appendEvent(directory, "gate.answered", { gate: "plan", answer: "approve" });
  if (close) {
    appendEvent(directory, "step.started", {
      step: "build",
      role: "implementer",
      repo: ".",
      round: 1,
    });
    appendEvent(directory, "step.finished", { step: "build", outcome: "succeeded" });
    appendEvent(directory, "merge_request.opened", {
      repo: ".",
      url: `https://example.test/${run}/pull/1`,
      number: 1,
    });
    appendEvent(directory, "run.closed", { outcome: "merged" });
  }
  if (retro !== null) writeFileSync(join(directory, "retro.md"), `## Close check\n\n${retro}\n`);
  return run;
}

test.beforeEach(() => {
  for (const name of ["ORCA_FAIL", "GH_CHECKS", "PLANNOTATOR_DATA_DIR"]) delete process.env[name];
  tempArkHome();
  demoDirectory = writeProject("demo", projectConfig(tempGitRepo()));
  oldDirectory = writeProject("old", projectConfig(tempGitRepo()));
  process.env.ARK_OMP_SESSIONS = tempDirectory("ark-finished-omp-");
  process.env.ARK_CLAUDE_SESSIONS = tempDirectory("ark-finished-claude-");
  process.env.ARK_CODEX_SESSIONS = tempDirectory("ark-finished-codex-");

  // demo: 3 open, 3 finished, 1 unreadable. old: only finished.
  writeStatusTicket("demo", "OPEN-PROPOSED", "proposed");
  writeStatusTicket("demo", "OPEN-READY", "ready");
  writeStatusTicket("demo", "OPEN-WORKING", "in_progress");
  writeStatusTicket("demo", "DONE-ONE", "done");
  writeStatusTicket("demo", "DONE-TWO", "done");
  writeStatusTicket("demo", "SUPERSEDED-ONE", "superseded");
  writeFileSync(join(demoDirectory, "tickets", "BROKEN.md"), "no frontmatter here\n");
  writeStatusTicket("old", "OLD-DONE", "done");
  writeStatusTicket("old", "OLD-SUPERSEDED", "superseded");

  // Closed runs: one answered retro, one unanswered. One open run.
  openRun = startRun("RUN-OPEN", false, null);
  answeredRun = startRun(
    "RUN-ANSWERED",
    true,
    "- Biggest pain: slow\n- Change now: split it\n- Surprise: none",
  );
  unansweredRun = startRun("RUN-UNANSWERED", true, "- Biggest pain:\n- Change now:\n- Surprise:");

  setTerminals([
    terminal("term_live_one", true, demoDirectory),
    terminal("term_live_two", true, demoDirectory),
    terminal("term_exited_one", false, demoDirectory),
    terminal("term_exited_two", false, demoDirectory),
  ]);
  writeFakeOrca(`if [ "$1" = "terminal" ]; then
  case "$2" in
    list) printf '{"result":{"terminals":%s}}' "$TEST_ORCA_TERMINALS" ;;
    show) printf '{"result":{"terminal":{"connected":true,"agentIdentity":"omp"}}}' ;;
    *) exit 2 ;;
  esac
  exit 0
fi
case "$2" in
  run-list) printf '{"result":{"runs":[]}}' ;;
  task-list) printf '{"result":{"tasks":[]}}' ;;
  worker-list) printf '{"result":{"workers":[]}}' ;;
  *) exit 2 ;;
esac`);
  const gh = join(tempDirectory("ark-finished-gh-"), "gh");
  writeFileSync(gh, "#!/bin/sh\nprintf '[]'\n");
  chmodSync(gh, 0o755);
  process.env.PATH = `${join(gh, "..")}:${process.env.PATH}`;
});

/** Opens the hub at `hash` and waits for the app shell, the earliest point at which views respond. */
async function open(page: Page, baseUrl: string, hash = ""): Promise<void> {
  await page.goto(`${baseUrl}/${hash}`);
  await expect(page.locator('.vbar button[aria-current="page"]').first()).toBeVisible();
}

async function goTo(page: Page, view: string): Promise<void> {
  await page.locator(`.vbtn[data-view="${view}"]:visible`).click();
  await expect(
    page.locator(`.vbtn[data-view="${view}"][aria-current="page"]:visible`),
  ).toBeVisible();
}

/** Runs `callback` against a fresh `ark ui` hub that is stopped afterwards. */
async function withHub(callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const hub = await startHub();
  try {
    await callback(hub.baseUrl);
  } finally {
    await stopHub(hub.process);
  }
}

const ticketRow = (page: Page, project: string, id: string) =>
  page.locator(`[data-ticket="${project}:${id}"]`);
const showFinished = (page: Page, count: number) =>
  page.getByRole("button", { name: `Show finished (${count} hidden)` });

test("ARK-275-AC1 Backlog hides done and superseded tickets, counts them per project scope, and keeps the unreadable one", async ({
  page,
}) => {
  await withHub(async (baseUrl) => {
    await open(page, baseUrl);
    await goTo(page, "backlog");

    // Scope all: 3 + 2 finished tickets hidden.
    await expect(showFinished(page, 5)).toBeVisible();
    for (const id of ["OPEN-PROPOSED", "OPEN-READY", "OPEN-WORKING", "BROKEN"])
      await expect(ticketRow(page, "demo", id)).toBeVisible();
    for (const id of ["DONE-ONE", "DONE-TWO", "SUPERSEDED-ONE"])
      await expect(ticketRow(page, "demo", id)).toHaveCount(0);
    await expect(ticketRow(page, "old", "OLD-DONE")).toHaveCount(0);

    // Scope demo: 3 hidden. Scope old: 2 hidden.
    const chips = page.getByRole("group", { name: "Project filter" });
    await chips.getByRole("button", { name: /^demo/ }).click();
    await expect(showFinished(page, 3)).toBeVisible();
    await chips.getByRole("button", { name: /^old/ }).click();
    await expect(showFinished(page, 2)).toBeVisible();
    await chips.getByRole("button", { name: /^demo/ }).click();

    await showFinished(page, 3).click();
    await expect(page.getByRole("button", { name: "Hide finished" })).toBeVisible();
    for (const id of ["DONE-ONE", "DONE-TWO", "SUPERSEDED-ONE", "OPEN-READY", "BROKEN"])
      await expect(ticketRow(page, "demo", id)).toBeVisible();
    await expect(ticketRow(page, "old", "OLD-DONE")).toHaveCount(0);
  });
});

test("ARK-275-AC2 Agents hides exited agents, counts them, and lists every agent when shown", async ({
  page,
}) => {
  await withHub(async (baseUrl) => {
    await open(page, baseUrl);
    await goTo(page, "agents");

    await expect(showFinished(page, 2)).toBeVisible();
    await expect(page.locator("[data-agent]")).toHaveCount(2);
    await expect(page.locator('[data-agent="term_live_one"]')).toBeVisible();
    await expect(page.locator('[data-agent="term_live_two"]')).toBeVisible();

    await showFinished(page, 2).click();
    await expect(page.getByRole("button", { name: "Hide finished" })).toBeVisible();
    await expect(page.locator("[data-agent]")).toHaveCount(4);
    await expect(page.locator('[data-agent="term_exited_one"]')).toBeVisible();
  });
});

type Graph = { nodes: string[]; edges: number; danglingEdges: number };

/** Node ids and path counts of the drawn Map; an edge is dangling when an end touches no node. */
async function readMap(page: Page): Promise<Graph> {
  return page.evaluate(() => {
    const spots = [...document.querySelectorAll<SVGGElement>("svg.graph g[data-node]")].map(
      (node) => {
        const [x, y] = (node.getAttribute("transform") ?? "").match(/-?\d+(\.\d+)?/g)!.map(Number);
        return { id: node.dataset.node!, x, y };
      },
    );
    const paths = [...document.querySelectorAll("svg.graph path.edge")].map((path) =>
      path
        .getAttribute("d")!
        .match(/-?\d+(\.\d+)?/g)!
        .map(Number),
    );
    const dangling = paths.filter(([startX, startY, , , , , endX, endY]) => {
      const fromNode = spots.some((spot) => spot.x + 170 === startX && spot.y + 25 === startY);
      const toNode = spots.some((spot) => spot.x === endX && spot.y + 25 === endY);
      return !fromNode || !toNode;
    });
    return {
      nodes: spots.map((spot) => spot.id),
      edges: paths.length,
      danglingEdges: dangling.length,
    };
  });
}

test("ARK-275-AC3 Map hides closed runs that need nothing, with their nodes, and keeps the run with an unanswered retro", async ({
  page,
}) => {
  await withHub(async (baseUrl) => {
    await open(page, baseUrl);
    await goTo(page, "map");

    const answeredNodes = [
      `run:${answeredRun}`,
      `step:${answeredRun}:build`,
      `mr:https://example.test/${answeredRun}/pull/1`,
    ];
    const keptNodes = [
      `run:${openRun}`,
      `run:${unansweredRun}`,
      `step:${unansweredRun}:build`,
      `mr:https://example.test/${unansweredRun}/pull/1`,
    ];
    await expect(page.locator(`svg.graph [data-node="run:${unansweredRun}"]`)).toBeVisible();
    await expect(page.getByText("3 finished hidden")).toBeVisible();
    const hiding = await readMap(page);
    for (const id of answeredNodes) expect(hiding.nodes).not.toContain(id);
    for (const id of keptNodes) expect(hiding.nodes).toContain(id);
    expect(hiding.danglingEdges).toBe(0);

    await page.getByRole("button", { name: "Show finished", exact: true }).click();
    await expect(page.getByRole("button", { name: "Hide finished" })).toBeVisible();
    await expect(page.locator(`svg.graph [data-node="run:${answeredRun}"]`)).toBeVisible();
    await expect(page.getByText("finished hidden")).toHaveCount(0);
    const showing = await readMap(page);
    for (const id of [...answeredNodes, ...keptNodes]) expect(showing.nodes).toContain(id);
    expect(showing.nodes.length).toBe(hiding.nodes.length + 3);
    // Each hidden node hangs from the closed run by one edge, and the run hangs from its chief.
    expect(showing.edges).toBe(hiding.edges + 3);
    expect(showing.danglingEdges).toBe(0);
  });
});

test("ARK-275-AC4 the finished=1 hash survives a reload and holds in Backlog, Agents and the Map", async ({
  page,
}) => {
  await withHub(async (baseUrl) => {
    await open(page, baseUrl, "#finished=1");
    await goTo(page, "backlog");
    await expect(page.getByRole("button", { name: "Hide finished" })).toBeVisible();
    await expect(ticketRow(page, "demo", "DONE-ONE")).toBeVisible();

    await page.reload();
    await expect(page.locator('.vbar button[aria-current="page"]').first()).toBeVisible();
    expect(new URL(page.url()).hash).toBe("#finished=1");
    await goTo(page, "backlog");
    await expect(page.getByRole("button", { name: "Hide finished" })).toBeVisible();
    await expect(ticketRow(page, "demo", "DONE-ONE")).toBeVisible();

    await goTo(page, "agents");
    await expect(page.getByRole("button", { name: "Hide finished" })).toBeVisible();
    await expect(page.locator("[data-agent]")).toHaveCount(4);

    await goTo(page, "map");
    await expect(page.getByRole("button", { name: "Hide finished" })).toBeVisible();
    await expect(page.locator(`svg.graph [data-node="run:${answeredRun}"]`)).toBeVisible();

    // Turning it off in the Map clears the key, and Backlog follows.
    await page.getByRole("button", { name: "Hide finished" }).click();
    expect(new URL(page.url()).hash).toBe("");
    await expect(page.locator(`svg.graph [data-node="run:${answeredRun}"]`)).toHaveCount(0);
    await goTo(page, "backlog");
    await expect(ticketRow(page, "demo", "DONE-ONE")).toHaveCount(0);
  });
});

test("ARK-275-AC4 a #run= link opens the run page of a closed run and #item= selects the item of a closed run", async ({
  page,
}) => {
  await withHub(async (baseUrl) => {
    await page.goto(`${baseUrl}/#run=${answeredRun}`);
    await expect(
      page.locator(`[data-run-detail="${answeredRun}"][data-phase="closed"]`),
    ).toBeVisible();

    await page.goto("about:blank");
    await open(page, baseUrl, `#item=${encodeURIComponent(`retro:${unansweredRun}`)}`);
    await expect(page.locator(`[data-need="retro:${unansweredRun}"]`)).toHaveClass(/cursor/);
    await goTo(page, "map");
    await expect(page.locator(`svg.graph [data-node="run:${unansweredRun}"]`)).toBeVisible();
    await expect(page.locator(`svg.graph [data-node="run:${answeredRun}"]`)).toHaveCount(0);
  });
});

test("ARK-275-AC4 a finished ticket, agent and run that the selection names stays visible after the toggle goes off", async ({
  page,
}) => {
  await withHub(async (baseUrl) => {
    await open(page, baseUrl, "#finished=1");

    await goTo(page, "backlog");
    await ticketRow(page, "demo", "DONE-ONE").getByRole("button").click();
    await page.getByRole("button", { name: "Hide finished" }).click();
    await expect(ticketRow(page, "demo", "DONE-ONE")).toBeVisible();
    await expect(ticketRow(page, "demo", "DONE-TWO")).toHaveCount(0);

    await page.reload();
    await expect(page.locator('.vbar button[aria-current="page"]').first()).toBeVisible();
    await page.evaluate(() => (location.hash = "#finished=1"));
    await goTo(page, "agents");
    await page.locator('[data-agent="term_exited_one"] button').click();
    await page.getByRole("button", { name: "Hide finished" }).click();
    await expect(page.locator('[data-agent="term_exited_one"]')).toBeVisible();
    await expect(page.locator('[data-agent="term_exited_two"]')).toHaveCount(0);

    await page.evaluate(() => (location.hash = "#finished=1"));
    await goTo(page, "map");
    // The Replay panel overlaps the tall graph, so the click goes to the node directly.
    await page.locator(`svg.graph [data-node="run:${answeredRun}"]`).dispatchEvent("click");
    await page.getByRole("button", { name: "Hide finished" }).click();
    await expect(page.locator(`svg.graph [data-node="run:${answeredRun}"]`)).toBeVisible();
    await expect(page.locator(`svg.graph [data-node="step:${answeredRun}:build"]`)).toBeVisible();
  });
});

test("ARK-275-AC5 empty states name the hidden count and offer Show finished", async ({ page }) => {
  // The fake orca lists only exited agents for this hub start.
  setTerminals([
    terminal("term_gone_one", false, demoDirectory),
    terminal("term_gone_two", false, demoDirectory),
    terminal("term_gone_three", false, oldDirectory),
  ]);
  await withHub(async (baseUrl) => {
    await open(page, baseUrl);
    await goTo(page, "backlog");
    const chips = page.getByRole("group", { name: "Project filter" });
    await chips.getByRole("button", { name: /^old/ }).click();
    await expect(
      page.getByText("No open tickets. 2 finished hidden. Show finished", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show finished", exact: true }).click();
    await expect(ticketRow(page, "old", "OLD-DONE")).toBeVisible();
    await expect(page.getByText("No open tickets.")).toHaveCount(0);
    await page.getByRole("button", { name: "Hide finished" }).click();

    await goTo(page, "agents");
    await chips.getByRole("button", { name: "All" }).click();
    await expect(
      page.getByText("No running agents. 3 finished hidden. Show finished", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show finished", exact: true }).click();
    await expect(page.locator("[data-agent]")).toHaveCount(3);
  });
});

test("ARK-275-AC6 the hub runs against a temporary ARK_HOME and a fake orca, never the real ones", async ({
  page,
}) => {
  const home = process.env.ARK_HOME as string;
  expect(home.startsWith(tmpdir())).toBe(true);
  expect(home).not.toBe(join(homedir(), ".ark"));
  const orca = spawnSync("sh", ["-c", "command -v orca"], { encoding: "utf8" }).stdout.trim();
  expect(orca.startsWith(tmpdir())).toBe(true);
  setTerminals([terminal("term_gone", false, demoDirectory)]);
  await withHub(async (baseUrl) => {
    await open(page, baseUrl);
    await goTo(page, "agents");
    // Only the fake orca's terminal and the temporary home's projects can show up here.
    await expect(
      page.getByText("No running agents. 1 finished hidden. Show finished", { exact: true }),
    ).toBeVisible();
  });
});
