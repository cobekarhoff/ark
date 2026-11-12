import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stopStartedRuns, recordStartedRun } from "./orphan-runners.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";
import type { ResourcesFile } from "../cli/resources-file.ts";
import { after } from "./resources-fixtures.ts";

// ARK-343: every test runs real `ark test` child processes.
setDefaultTimeout(120_000);

// ARK-419: no test-runner of a run this file started outlives its test.
afterEach(stopStartedRuns);

const arkEntry = resolve(import.meta.dir, "..", "cli", "ark.ts");
const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};
const junit = (file: string) => `bun test --reporter=junit --reporter-outfile={report} ./${file}`;

const fixtureText = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", "resources", name), "utf8");
/** A suite that holds about 200 MB, with a child that holds 30 MB, for about 2.5 s. */
const heavyTest = fixtureText("heavy-suite.txt");
/** A suite that ends almost at once, after about 0.2 s of CPU. */
const shortTest = fixtureText("short-suite.txt");
/** The 200 MB of the heavy suite plus the runtime and its child: well under this, so the group is not double counted. */
const maximumMegabytes = 400;

/** An open run at the building phase whose `unit` suite holds memory and whose `e2e` suite is short. */
function buildingRun(): { runId: string; runDirectory: string } {
  const arkHome = tempArkHome();
  const workspace = tempGitRepo({ "unit.test.ts": heavyTest, "e2e.test.ts": shortTest });
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    test_min_free_memory_percent: 0,
    test_max_swap_gb: 1000,
    suites: [
      { name: "unit", level: "unit", repo: ".", command: junit("unit.test.ts"), parser: "bun" },
      { name: "e2e", level: "e2e", repo: ".", command: junit("e2e.test.ts"), parser: "bun" },
    ],
    roles,
  });
  const ticket = writeTicket(
    "demo",
    "FAKE-1",
    [{ id: "FAKE-1-AC1", text: "criterion" }],
    "Ticket FAKE-1",
  );
  const runId = ark("run", "start", ticket, "--project", "demo").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-1-\d+/,
  )![0];
  const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
  recordStartedRun({ runId, runDirectory });
  recordEvaluation(runDirectory);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
      summary: {
        why: "Test the run.",
        changes: [
          { criterion: "FAKE-1-AC1", where: "tests", now: "Suites run.", fix: "Suites prove it." },
        ],
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: ".",
          harness: "claude",
          model: "claude-sonnet",
          needs: [],
          criteria: ["FAKE-1-AC1"],
        },
      ],
      test_cases: [
        {
          id: "proves-FAKE-1-AC1",
          criterion: "FAKE-1-AC1",
          level: "e2e",
          given: [],
          when: ["run it"],
          // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
          then: ["it works"],
          expected: "it works",
        },
      ],
    }),
  );
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
    ["worktree", "create", runId, "."],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
  }
  return { runId, runDirectory };
}

const resourcesFile = (runDirectory: string): ResourcesFile =>
  JSON.parse(readFileSync(join(runDirectory, "results", "resources.json"), "utf8"));

/**
 * Runs `ark test` and reads `resources.json` at each change of the results folder meanwhile: it must always parse.
 * `onOutput` sees each piece of stdout as it arrives.
 */
async function arkTestWatching(
  runId: string,
  runDirectory: string,
  flags: string[] = [],
  onOutput: (text: string) => void = () => {},
) {
  const file = join(runDirectory, "results", "resources.json");
  mkdirSync(join(runDirectory, "results"), { recursive: true });
  let reads = 0;
  let broken: string | null = null;
  const watcher = watch(join(runDirectory, "results"), () => {
    if (!existsSync(file)) return;
    try {
      JSON.parse(readFileSync(file, "utf8"));
      reads++;
    } catch (err) {
      broken = String(err);
    }
  });
  try {
    const started = Date.now();
    const child = Bun.spawn(["bun", arkEntry, "test", runId, ...flags], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    let output = "";
    for await (const chunk of child.stdout) {
      const text = new TextDecoder().decode(chunk);
      output += text;
      onOutput(text);
    }
    await child.exited;
    return { output, wallMilliseconds: Date.now() - started, reads, broken };
  } finally {
    watcher.close();
  }
}

test("ARK-T291 ark test writes the peak memory, CPU seconds, wall time and wait of each suite at head and base, and keeps the hub's keys", async () => {
  const { runId, runDirectory } = buildingRun();
  // The hub wrote these while the run was open: the suite writer must leave them.
  mkdirSync(join(runDirectory, "results"), { recursive: true });
  const hubKeys = {
    agents: { H1: { peak_mb: 500, cpu_s: 20 } },
    gaps: [{ from: "2026-11-12T10:00:00.000Z", to: "2026-11-12T10:05:00.000Z" }],
  };
  writeFileSync(join(runDirectory, "results", "resources.json"), JSON.stringify(hubKeys));

  const first = await arkTestWatching(runId, runDirectory);
  const file = resourcesFile(runDirectory);
  const unit = file.suites!.unit!;
  for (const side of ["head", "base"] as const) {
    const use = unit[side];
    if (use === undefined || "cached" in use) throw new Error(`unit ${side} has no sampled use`);
    // The group is the runner's shell, bun and its child: 200 MB held by one process and 30 MB by another. Never the
    // whole host (that is many GB), and not double counted.
    expect(use.peak_mb, `unit ${side} peak`).toBeGreaterThanOrEqual(150);
    expect(use.peak_mb, `unit ${side} peak`).toBeLessThan(maximumMegabytes);
    expect(use.cpu_s, `unit ${side} cpu`).toBeGreaterThan(0);
    // The suite waits 2.5 s for its child: the wall time is at least that, and never the wait.
    expect(use.wall_s, `unit ${side} wall`).toBeGreaterThanOrEqual(2.5);
    expect(use.wall_s, `unit ${side} wall`).toBeLessThan(first.wallMilliseconds / 1000);
    expect(use.wait_s, `unit ${side} wait`).toBe(0);
  }
  // A suite that ends inside one sample interval has its CPU counted all the same.
  for (const side of ["head", "base"] as const) {
    const use = file.suites!.e2e![side]!;
    if ("cached" in use) throw new Error(`e2e ${side} is cached on the first run`);
    expect(use.cpu_s, `e2e ${side} cpu`).toBeGreaterThanOrEqual(0.1);
    expect(use.cpu_s, `e2e ${side} cpu`).toBeLessThan(use.wall_s * 16);
  }
  expect(file.agents).toEqual(hubKeys.agents);
  expect(file.gaps).toEqual(hubKeys.gaps);
  // Written by temp file and rename: every read during the run was a whole JSON file.
  expect(first.broken).toBeNull();
  expect(first.reads).toBeGreaterThan(0);

  // A second run replays both suites from the cache: no process starts, so no figure is claimed.
  await arkTestWatching(runId, runDirectory);
  const cached = resourcesFile(runDirectory);
  expect(cached.suites).toEqual({
    unit: { head: { cached: true }, base: { cached: true } },
    e2e: { head: { cached: true }, base: { cached: true } },
  });
  expect(cached.agents).toEqual(hubKeys.agents);
  expect(cached.gaps).toEqual(hubKeys.gaps);

  // A --quick run has no base side and does not delete the entries of the full run it does not touch.
  await arkTestWatching(runId, runDirectory, ["--quick"]);
  const quick = resourcesFile(runDirectory);
  expect(Object.keys(quick.suites!.unit!)).toContain("base");
  expect(quick.agents).toEqual(hubKeys.agents);
  expect(quick.gaps).toEqual(hubKeys.gaps);
});

test("ARK-T291 a suite that waited for admission records its wait, and the wait is not part of its wall time", async () => {
  const { runId, runDirectory } = buildingRun();
  // Another `ark test` holds the whole budget (cores far above any host) and is alive: a `sleep`.
  const other = Bun.spawn(["sleep", "60"]);
  const ticketFile = join(process.env.ARK_HOME as string, "test-budget", `${other.pid}-other.json`);
  try {
    mkdirSync(join(process.env.ARK_HOME as string, "test-budget"), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      ticketFile,
      JSON.stringify({ run: "OTHER-1", pid: other.pid, cores: 1000, arrival: now, started: now }),
    );
    // The wait that ark test measures is real time: hold the ticket for 2 s of it, counted from the line that says
    // the suite waits (`ark test` starts some time after this test does).
    let cancelRelease: (() => void) | null = null;
    const waited = await arkTestWatching(runId, runDirectory, [], (text) => {
      if (/waiting: place/.test(text) && cancelRelease === null)
        cancelRelease = after(2000, () => rmSync(ticketFile, { force: true }));
    });
    expect(cancelRelease).not.toBeNull();
    expect(waited.output).toContain("FAKE-1");
    const file = resourcesFile(runDirectory);
    // The suite that took its ticket first waited about 2 s; the later ones had no one ahead and wait 0.
    const waits = Object.values(file.suites!).flatMap((suite) =>
      [suite.head!, suite.base!].map((use) => {
        if ("cached" in use) throw new Error("a first run has no cached suite");
        return use.wait_s;
      }),
    );
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(1.5);
    expect(Math.max(...waits)).toBeLessThanOrEqual(4);
    expect(waits.filter((wait) => wait > 0)).toHaveLength(1);
  } finally {
    other.kill();
  }
});
