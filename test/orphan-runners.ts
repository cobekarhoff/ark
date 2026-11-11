import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ark,
  healthyHost,
  recordEvaluation,
  setFakeHost,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-419: what ARK-T235 and ARK-T236 share across test-run, evidence-test-run and test-selection.
// The fake host (memory_pressure, sysctl vm.swapusage on PATH) exists on macOS only.

/** A test that runs on macOS and skips elsewhere. */
export const macOnly = process.platform === "darwin" ? test : test.skip;

/** A run the suite helper starts: the fixture under test writes the project, the worktree and the plan. */
export type StartedRun = { runId: string; runDirectory: string };
/** `start` writes the suite's own demo fixture and returns its run; `body` is the statements of the one test its suite runs. */
export type SuiteFixture = { start: (body: string) => StartedRun };

const arkEntry = join(import.meta.dir, "..", "cli", "ark.ts");
const configFile = () => join(process.env.ARK_HOME as string, "projects", "demo", "ark.yml");

type ProcessEntry = { pid: number; parentPid: number; command: string };

function processTable(): ProcessEntry[] {
  const listing = Bun.spawnSync(["ps", "-axo", "pid,ppid,command"]).stdout.toString();
  return listing.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match
      ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3]! }]
      : [];
  });
}

/**
 * The `test-runner` process of a run: the pid of its runner.json, when `ps` shows it as the runner of that run id.
 * A fake run id repeats (`<date>-FAKE-1-1`) across test processes and other runs of the host, so `ps` alone would
 * reach a runner of another ARK_HOME.
 */
function runnersOf(run: StartedRun): ProcessEntry[] {
  let pid: number;
  try {
    pid = JSON.parse(readFileSync(join(run.runDirectory, "results", "runner.json"), "utf8")).pid;
  } catch {
    return [];
  }
  return processTable().filter(
    (entry) => entry.pid === pid && entry.command.includes(`test-runner ${run.runId} `),
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, milliseconds: number): Promise<boolean> {
  for (const deadline = Date.now() + milliseconds; Date.now() < deadline; await Bun.sleep(50))
    if (condition()) return true;
  return condition();
}

/** SIGKILL of a runner, of the process groups of its suites and of its other children. */
function forceKill(runnerPid: number): void {
  for (const child of processTable().filter((entry) => entry.parentPid === runnerPid))
    for (const target of [-child.pid, child.pid])
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // already gone
      }
  try {
    process.kill(runnerPid, "SIGKILL");
  } catch {
    // already gone
  }
}

const markerBody = (directory: string) =>
  `require("node:fs").writeFileSync(${JSON.stringify(directory)} + "/" + process.pid, "");`;

/**
 * ARK-T235. With the host at 15 percent free and 9 GB of swap, the demo project of the suite's fixture writer runs a
 * fake `ark test` to its end, and the same project without the two keys waits for memory (the control).
 */
export async function proveFixtureSkipsMemoryWait(fixture: SuiteFixture): Promise<void> {
  setFakeHost({ freePercent: 15, swapGigabytes: 9 });
  const markers = mkdtempSync(join(tmpdir(), "ark-marker-"));
  let started: StartedRun | undefined;
  try {
    const run = fixture.start(markerBody(markers));
    started = run;
    const { runId } = run;
    const fixtureConfig = readFileSync(configFile(), "utf8");

    // Control: the same project with the default limits waits and starts nothing.
    const withDefaults = JSON.parse(fixtureConfig);
    delete withDefaults.test_min_free_memory_percent;
    delete withDefaults.test_max_swap_gb;
    writeFileSync(configFile(), JSON.stringify(withDefaults));
    Bun.spawn([process.execPath, arkEntry, "test", runId], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
    const runnerOutput = join(run.runDirectory, "results", "runner.out");
    const waited = await waitUntil(() => {
      try {
        return readFileSync(runnerOutput, "utf8").includes("waiting for memory");
      } catch {
        return false;
      }
    }, 30_000);
    expect(waited, "the control run never printed a memory wait").toBe(true);
    await Bun.sleep(1_000); // over three poll intervals of the memory wait
    expect(readdirSync(markers), "the control run started its suite").toEqual([]);
    ark("test", runId, "--stop");
    expect(await waitUntil(() => runnersOf(run).length === 0, 10_000)).toBe(true);

    // The fixture as written: the run starts at once and finishes.
    writeFileSync(configFile(), fixtureConfig);
    const caller = Bun.spawn([process.execPath, arkEntry, "test", runId], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const finished = await Promise.race([caller.exited, Bun.sleep(60_000).then(() => "timeout")]);
    if (finished === "timeout") {
      ark("test", runId, "--stop");
      throw new Error(
        `ark test of ${runId} did not finish in 60 s:\n${readFileSync(runnerOutput, "utf8")}`,
      );
    }
    const output = `${await new Response(caller.stdout).text()}${await new Response(caller.stderr).text()}`;
    expect(finished, output).toBe(0);
    expect(output).not.toContain("waiting for memory");
    expect(readdirSync(markers).length, "the suite wrote no marker").toBeGreaterThan(0);
    const config = JSON.parse(fixtureConfig);
    expect(config.test_min_free_memory_percent).toBe(0);
    expect(config.test_max_swap_gb).toBeGreaterThan(9);
  } finally {
    setFakeHost(healthyHost);
    for (const runner of started === undefined ? [] : runnersOf(started)) forceKill(runner.pid);
  }
}

type Held = { run: StartedRun; control: StartedRun | undefined; controlPid: number };
let held: Held | undefined;

/** The control FAKE-2: its own project and run, started at the runner entry point, outside the suite helper. */
async function startControlRunner(markers: string): Promise<{ run: StartedRun; pid: number }> {
  writeProject("control", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    // The target takes the whole budget of the demo project: the control needs room beside it.
    test_budget_cores: 1000,
    suites: [
      {
        name: "hold",
        level: "unit",
        repo: ".",
        cores: 1,
        command: `touch ${markers}/control && sleep 300`,
        parser: "bun",
      },
    ],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
    },
  });
  const ticket = writeTicket("control", "FAKE-2", [
    { id: "FAKE-2-AC1", text: "A person checks it", manual: true },
  ]);
  const runId = ark("run", "start", ticket, "--project", "control").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-2-\d+/,
  )![0];
  const runDirectory = join(process.env.ARK_HOME as string, "projects", "control", "runs", runId);
  recordEvaluation(runDirectory);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "control plan", callers: ["ark test"] }] },
      summary: {
        why: "A live runner.",
        changes: [{ criterion: "FAKE-2-AC1", where: "none", now: "None.", fix: "None." }],
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: ".",
          harness: "claude",
          model: "claude-sonnet",
          needs: [],
          criteria: ["FAKE-2-AC1"],
        },
      ],
      test_cases: [],
    }),
  );
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
    ["worktree", "create", runId],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
  }
  Bun.spawn([process.execPath, arkEntry, "test-runner", runId, "--project", "control"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  }).unref();
  const started = await waitUntil(() => runnersOf({ runId, runDirectory }).length === 1, 30_000);
  const resultsDirectory = join(runDirectory, "results");
  expect(
    started,
    ["runner.out", "runner.err"]
      .map((name) => {
        try {
          return readFileSync(join(resultsDirectory, name), "utf8");
        } catch {
          return `${name}: missing`;
        }
      })
      .join("\n"),
  ).toBe(true);
  return { run: { runId, runDirectory }, pid: runnersOf({ runId, runDirectory })[0]!.pid };
}

/**
 * ARK-T236, first half. The suite helper starts FAKE-1 whose suite ignores SIGTERM, and the test starts FAKE-2.
 * A SIGTERM to the FAKE-1 runner does not end it. The `afterEach` hook of the suite runs after this test.
 */
export async function holdRunners(fixture: SuiteFixture): Promise<void> {
  setFakeHost(healthyHost);
  const markers = mkdtempSync(join(tmpdir(), "ark-hold-"));
  const run = fixture.start(
    `process.on("SIGTERM", () => {}); ${markerBody(markers)} await Bun.sleep(300_000);`,
  );
  Bun.spawn([process.execPath, arkEntry, "test", run.runId], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
  expect(
    await waitUntil(() => readdirSync(markers).length === 1, 60_000),
    "FAKE-1 never started",
  ).toBe(true);
  const [runner] = runnersOf(run);
  expect(runner, "no test-runner process for FAKE-1").toBeDefined();
  held = { run, control: undefined, controlPid: 0 };

  const control = await startControlRunner(markers);
  held.control = control.run;
  held.controlPid = control.pid;
  expect(await waitUntil(() => readdirSync(markers).includes("control"), 30_000)).toBe(true);

  process.kill(runner!.pid, "SIGTERM");
  await Bun.sleep(500);
  expect(alive(runner!.pid), "the FAKE-1 runner ended on SIGTERM: no resistance to test").toBe(
    true,
  );
}

/** ARK-T236, second half: after the hook, no runner of FAKE-1 remains and the FAKE-2 runner lives. Cleans up both. */
export async function expectHookEndedOnlyItsRuns(): Promise<void> {
  if (held === undefined) throw new Error("the holding test did not leave runners to check");
  const { run, controlPid } = held;
  try {
    const gone = await waitUntil(() => runnersOf(run).length === 0, 5_000);
    expect(
      runnersOf(run).map((entry) => `${entry.pid} parent ${entry.parentPid}`),
      "test-runner processes of the run the suite started remain",
    ).toEqual([]);
    expect(gone).toBe(true);
    expect(alive(controlPid), "the hook killed a runner of a run it did not start").toBe(true);
  } finally {
    stopHeld();
  }
}

/** The test's own final cleanup: SIGKILL of both runners and their suites, whatever an assertion did. */
export function stopHeld(): void {
  if (held === undefined) return;
  for (const run of [held.run, held.control])
    for (const runner of run === undefined ? [] : runnersOf(run)) forceKill(runner.pid);
  held = undefined;
}

const startedRuns: StartedRun[] = [];

/** Records a run the fixture just created, for `stopStartedRuns`. */
export function recordStartedRun(run: StartedRun): void {
  startedRuns.push(run);
}

/**
 * The file-level `afterEach` of a suite: `ark test --stop` for each recorded run, then SIGKILL of the runner pid of its
 * results/runner.json, whatever `--stop` did. Never by run id alone and never every `test-runner`.
 */
export function stopStartedRuns(): void {
  for (const run of startedRuns.splice(0)) {
    const runners = runnersOf(run);
    ark("test", run.runId, "--stop", "--project", "demo");
    for (const runner of runners) forceKill(runner.pid);
  }
}
