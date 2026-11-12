import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDirectoryOf, today, writeRun } from "../hub-fixtures.ts";
import {
  installProcessFakes,
  secretEnvironment,
  secrets,
  writeStartedTicket,
  writeWaitingTicket,
  type FakeProcess,
} from "../resources-fixtures.ts";
import {
  checkpoint,
  installFakeTools,
  startHub,
  stopHub,
  tempArkHome,
  tempDirectory,
  useCleanup,
  writeFakeCommand,
  type StartedHub,
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

// The host signals come from `sysctl` and `memory_pressure` on PATH, which the reader runs on macOS only;
// Linux reads /proc/meminfo, which no fake reaches.
test.skip(process.platform !== "darwin", "the swap and pressure fakes are macOS commands");

/** Fake `sysctl` and `memory_pressure`: what they print is one file each in `host`, and `pressure.fail` makes the pressure read fail. */
function installHostFakes(host: string) {
  writeFileSync(
    join(host, "swapusage"),
    "vm.swapusage: total = 8192.00M  used = 6656.00M  free = 1536.00M  (encrypted)\n",
  );
  writeFileSync(join(host, "pressure"), "kern.memorystatus_vm_pressure_level: 2\n");
  writeFileSync(join(host, "pressure.fail"), "");
  writeFileSync(join(host, "memory_pressure.out"), "System-wide memory free percentage: 40%\n");
  writeFakeCommand(
    "sysctl",
    `case "$1" in
  vm.swapusage) cat '${join(host, "swapusage")}' ;;
  kern.memorystatus_vm_pressure_level) [ -e '${join(host, "pressure.fail")}' ] && exit 1; cat '${join(host, "pressure")}' ;;
  *) exec /usr/sbin/sysctl "$@" ;;
esac`,
  );
  writeFakeCommand("memory_pressure", `cat '${join(host, "memory_pressure.out")}'`);
}

/** Answers `worker-list` and `task-list` for one run from `workers.<run>` and `tasks.<run>`, everything else from the fake `orca` already on PATH. */
function installPerRunOrca(state: string) {
  const original = spawnSync("which", ["orca"], { encoding: "utf8" }).stdout.trim();
  writeFakeCommand(
    "orca",
    `run=""
previous=""
for argument in "$@"; do
  [ "$previous" = "--run" ] && run="$argument"
  previous="$argument"
done
case "$1 $2" in
  "orchestration worker-list") [ -f '${state}/workers.'"$run" ] && { cat '${state}/workers.'"$run"; exit 0; } ;;
  "orchestration task-list") [ -f '${state}/tasks.'"$run" ] && { cat '${state}/tasks.'"$run"; exit 0; } ;;
esac
exec '${original}' "$@"`,
  );
}

const wrap = (key: string, value: unknown[]) => JSON.stringify({ result: { [key]: value } });

/** Every route of the hub that the page can show, including one it does not know. */
const routes = (runA: string) => ["", "runs", "roadmap", "resources", `run/${runA}`, "nonsense"];

async function waitForHistory(page: Page, baseUrl: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const history = await (await page.request.get(`${baseUrl}/api/resources/history`)).json();
        return Object.values(history as Record<string, unknown[]>).every(
          (points) => points.length >= 2,
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

test("ARK-T290 the header strip is on every hub page and the Resources page groups run, agent, process, leftover and other, with a red swap level and a copy-kill button", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  process.env.ARK_HUB_INTERVAL_MS = "300";
  tempArkHome();
  process.env.ARK_OMP_SESSIONS = tempDirectory("ark-omp-sessions-");
  process.env.ARK_CLAUDE_SESSIONS = tempDirectory("ark-claude-sessions-");
  process.env.ARK_CODEX_SESSIONS = tempDirectory("ark-codex-sessions-");
  const runA = `${today()}-ARK-901-1`;
  const runB = `${today()}-ARK-902-1`;
  const runC = `${today()}-ARK-903-1`;
  const directoryA = writeRun({
    project: "p",
    run: runA,
    ticket: { id: "ARK-901", title: "Run A" },
    phase: "building",
  });
  const directoryB = writeRun({
    project: "p",
    run: runB,
    ticket: { id: "ARK-902", title: "Run B" },
    phase: "building",
  });
  writeRun({ project: "p", run: runC, ticket: { id: "ARK-903", title: "Run C" }, phase: "closed" });

  // Two agents on RUN-A (different step and model), one on RUN-B.
  const handles = ["H1", "H2", "H3"];
  const state = installFakeTools({
    orca: {
      terminals: handles.map((handle) => ({ handle, connected: true, agentIdentity: "omp" })),
      runs: [
        { id: `orca-${runA}`, objective: `Ark run ${runA}` },
        { id: `orca-${runB}`, objective: `Ark run ${runB}` },
      ],
    },
  });
  const worker = (handle: string, model: string) => ({
    taskId: `task-${handle}`,
    state: "running",
    agentTerminalHandle: handle,
    projection: { provider: { model } },
  });
  const task = (handle: string, step: string, role: string) => ({
    id: `task-${handle}`,
    title: `${step} (${role}, .)`,
  });
  writeFileSync(
    join(state, `workers.orca-${runA}`),
    wrap("workers", [worker("H1", "openai/model-one"), worker("H2", "anthropic/model-two")]),
  );
  writeFileSync(
    join(state, `tasks.orca-${runA}`),
    wrap("tasks", [task("H1", "build", "implementer"), task("H2", "validate", "validator")]),
  );
  writeFileSync(
    join(state, `workers.orca-${runB}`),
    wrap("workers", [worker("H3", "openai/model-three")]),
  );
  writeFileSync(
    join(state, `tasks.orca-${runB}`),
    wrap("tasks", [task("H3", "docs", "implementer")]),
  );
  installPerRunOrca(state);

  const host = tempDirectory("ark-host-");
  installHostFakes(host);

  // Processes: each agent has two or more of the kinds, one leftover, twelve others, and `ark test` admission.
  const fakes = installProcessFakes(tempDirectory("ark-process-fakes-"));
  const agentProcess = (
    pid: number,
    handle: string,
    command: string,
    memoryMegabytes: number,
  ): FakeProcess => ({
    pid,
    command,
    memoryMegabytes,
    environment: [...secretEnvironment, `ORCA_TERMINAL_HANDLE=${handle}`],
    directory: "/Users/someone/repo",
  });
  const others: FakeProcess[] = Array.from({ length: 12 }, (_, index) => ({
    pid: 60_001 + index,
    // Unsorted on purpose: the page sorts by memory.
    memoryMegabytes: 11 + ((index * 5) % 12),
    command: `/usr/bin/some-tool-${index}`,
    environment: secretEnvironment,
    directory: "/tmp/unrelated",
  }));
  fakes.setProcesses([
    agentProcess(61_001, "H1", "/opt/bun/bin/bun test --parallel", 300),
    agentProcess(61_002, "H1", "omp --model one", 150),
    agentProcess(61_003, "H2", "node /repo/node_modules/playwright/cli.js test", 200),
    agentProcess(
      61_004,
      "H2",
      "/Applications/Chromium.app/Contents/MacOS/Chromium --headless",
      400,
    ),
    agentProcess(61_005, "H2", "git status --short", 20),
    agentProcess(61_006, "H3", "omp --model three", 120),
    agentProcess(61_007, "H3", "/opt/bun/bin/bun test", 90),
    {
      pid: 48_189,
      elapsed: "11-00:00:00",
      memoryMegabytes: 60,
      command: "node /srv/site/astro.js preview --note <b>x</b> & done",
      environment: secretEnvironment,
      directory: join(runDirectoryOf("p", runC), "workspace"),
    },
    ...others,
  ]);
  // RUN-A holds `ark test`, RUN-B waits 42 s. Both pids are alive.
  writeStartedTicket(runA, process.pid);
  writeWaitingTicket(runB, process.ppid, new Date(Date.now() - 42_000));
  void directoryA;
  void directoryB;

  const hub = await startHub();
  started.push(hub);
  const { baseUrl } = hub;
  const requests: { method: string; url: string }[] = [];
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));

  // The pressure read fails: the strip says unchecked, never normal, and swap is red from the first reading.
  await page.goto(`${baseUrl}/#/`);
  const strip = page.getByTestId("resources-strip");
  await expect(page.getByTestId("strip-swap")).toHaveAttribute("data-level", "red", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("strip-pressure")).toHaveAttribute("data-level", "unchecked");
  await expect(page.getByTestId("strip-pressure")).toContainText("unchecked");
  await expect(page.getByTestId("strip-pressure")).not.toContainText("normal");
  await checkpoint(page, "strip-home-unchecked");

  // Then the pressure reads 2: amber, and the word macOS uses.
  rmSync(join(host, "pressure.fail"));
  await expect(page.getByTestId("strip-pressure")).toHaveAttribute("data-level", "amber");
  await expect(page.getByTestId("strip-pressure")).toContainText("warn");
  await expect(page.getByTestId("strip-swap")).toContainText("6.5 GB");
  await expect(page.getByTestId("strip-admission")).toContainText(runA);
  await expect(page.getByTestId("strip-admission")).toContainText(new RegExp(`${runB} 4\\d s`));
  await checkpoint(page, "strip-home");

  // The strip is on every route and links to the Resources page.
  for (const hash of routes(runA)) {
    await page.goto(`${baseUrl}/#/${hash}`);
    await expect(page.locator("main h1").first()).toBeVisible();
    await expect(strip, hash).toBeVisible();
    for (const key of ["cpu", "pressure", "swap", "disk", "load"])
      await expect(page.getByTestId(`strip-${key}`), `${hash} ${key}`).toBeVisible();
    await expect(page.getByTestId("strip-admission"), hash).toBeVisible();
    await expect(strip.getByRole("link", { name: "Resources" }), hash).toHaveAttribute(
      "href",
      "#/resources",
    );
    // The strip never covers the page: the content starts below it.
    const stripBox = (await strip.boundingBox())!;
    const mainBox = (await page.locator("main").boundingBox())!;
    expect(mainBox.y, hash).toBeGreaterThanOrEqual(stripBox.y + stripBox.height - 1);
  }
  await page.goto(`${baseUrl}/#/runs/`);
  await checkpoint(page, "strip-runs");

  await waitForHistory(page, baseUrl);
  await page.goto(`${baseUrl}/#/`);
  await strip.getByRole("link", { name: "Resources" }).click();
  await expect(page).toHaveURL(/#\/resources$/);
  await expect(page.locator("main h1")).toContainText("Resources");
  await expect(page.getByTestId("sparkline")).toHaveCount(5);

  // Order: open runs, then each run's agents with step and model, then leftover, then other.
  const headings = await page.locator("main h2").allTextContents();
  const at = (text: string) => headings.findIndex((heading) => heading.includes(text));
  expect(at("Open runs")).toBe(0);
  expect(at(runA)).toBeGreaterThan(at("Open runs"));
  expect(at(runB)).toBeGreaterThan(at("Open runs"));
  expect(at("Leftover from closed runs")).toBeGreaterThan(Math.max(at(runA), at(runB)));
  expect(at("Other")).toBeGreaterThan(at("Leftover from closed runs"));

  const agentsOf = (run: string) =>
    page.locator(`[data-testid="resource-run"][data-run="${run}"] [data-testid="resource-agent"]`);
  await expect(agentsOf(runA)).toHaveCount(2);
  await expect(agentsOf(runB)).toHaveCount(1);
  const agent = (run: string, handle: string) =>
    agentsOf(run).and(page.locator(`[data-handle="${handle}"]`));
  await expect(agent(runA, "H1")).toContainText("build");
  await expect(agent(runA, "H1")).toContainText("openai/model-one");
  await expect(agent(runA, "H2")).toContainText("validate");
  await expect(agent(runA, "H2")).toContainText("anthropic/model-two");
  await expect(agent(runB, "H3")).toContainText("docs");
  const kindsOf = async (run: string, handle: string) =>
    agent(run, handle)
      .locator('[data-testid="process"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-kind")));
  expect(await kindsOf(runA, "H1")).toEqual(["bun test", "omp"]);
  expect(await kindsOf(runA, "H2")).toEqual(["playwright", "chromium", "git"]);
  expect(await kindsOf(runB, "H3")).toEqual(["omp", "bun test"]);
  // Memory and CPU of a process are shown.
  await expect(agent(runA, "H2").locator('[data-pid="61004"]')).toContainText("400 MB");
  await expect(agent(runA, "H1").locator('[data-pid="61001"]')).toContainText(/\d+%|—/);

  // Leftover: one row, with its run, age, command as text and the one copy button.
  const leftover = page.getByTestId("leftover-row");
  await expect(leftover).toHaveCount(1);
  await expect(leftover).toContainText(runC);
  await expect(leftover).toContainText(/11\s*d/);
  await expect(leftover).toContainText("<b>x</b> & done");
  await expect(page.getByTestId("leftover").locator("b")).toHaveCount(0);
  await expect(leftover.getByRole("button")).toHaveCount(1);
  await checkpoint(page, "resources-leftover");
  await leftover.getByTestId("copy-kill").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("kill 48189");

  // Other: the 10 largest by memory, largest first.
  const otherRows = page.getByTestId("other").getByTestId("process");
  await expect(otherRows).toHaveCount(10);
  const memories = (await otherRows.locator("td.num:last-child").allTextContents()).map((text) =>
    Number.parseInt(text, 10),
  );
  const expected = others
    .map((entry) => entry.memoryMegabytes!)
    .sort((a, b) => b - a)
    .slice(0, 10);
  expect(memories).toEqual(expected);
  await checkpoint(page, "resources-page");

  // No request but GET; none to a kill or process route; no secret on the page or in any response.
  expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  expect(requests.filter((request) => /kill|signal|process/i.test(request.url))).toEqual([]);
  const text = (await page.content()) + (await page.locator("body").innerText());
  for (const needle of [secrets.token, secrets.awsValue, ...secrets.names])
    expect(text.includes(needle), needle).toBe(false);
  const snapshotText = await (await page.request.get(`${baseUrl}/api/snapshot`)).text();
  for (const needle of [secrets.token, secrets.awsValue, ...secrets.names])
    expect(snapshotText.includes(needle), needle).toBe(false);

  // Light and dark keep the strip and its levels readable.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${baseUrl}/#/`);
    await expect(page.getByTestId("strip-swap")).toHaveAttribute("data-level", "red");
    // The Resources tab is styled like the other tabs that are not the current page.
    const tabColor = (name: string) =>
      page
        .getByRole("navigation", { name: "Views" })
        .getByRole("link", { name, exact: true })
        .evaluate((tab) => getComputedStyle(tab).color);
    // Both are read in the poll: a colour transition after the scheme change must not fix one side early.
    await expect
      .poll(async () => (await tabColor("Resources")) === (await tabColor("Roadmap")))
      .toBe(true);
    await checkpoint(page, `strip-home-${scheme}`);
    await page.goto(`${baseUrl}/#/resources`);
    await expect(page.getByTestId("sparkline")).toHaveCount(5);
    await checkpoint(page, `resources-${scheme}`);
  }
});
