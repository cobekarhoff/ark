import type { Subprocess } from "bun";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { FSWatcher } from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-343: every test runs real `ark test` child processes with suites that sleep about a second.
setDefaultTimeout(90_000);

const arkEntry = resolve(import.meta.dir, "..", "cli", "ark.ts");
const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

type Suite = {
  name: string;
  level: string;
  repo: string;
  command: string;
  parser: string;
  cores?: number;
};

// Every test shares one temp ARK_HOME (never the real one) holding two projects, so a per-project budget would not
// serialize the two runs. The budget is 6 cores; a suite with no `cores` takes all of it.
let arkHome: string;
let fixtures: string;
let runA: string;
let runB: string;
let projectA: string;

const logFile = () => join(fixtures, "suite.log");
const budgetDirectory = () => join(arkHome, "test-budget");
const tickets = () =>
  existsSync(budgetDirectory())
    ? readdirSync(budgetDirectory()).filter((name) => name.endsWith(".json"))
    : [];
const readLog = () => (existsSync(logFile()) ? readFileSync(logFile(), "utf8") : "");

/**
 * The suite script: logs `start <run>`, then sleeps ~1 s (or, when `hold` exists, until `release` exists), then logs
 * `end <run>`. It writes the junit report of a real bun test file, which fails when `fail-<run>` exists.
 */
function writeSuiteScript(directory: string): string {
  const file = join(directory, "suite.sh");
  writeFileSync(
    join(directory, "passing.test.ts"),
    'import { test } from "bun:test";\ntest("passes", () => {});\n',
  );
  writeFileSync(
    join(directory, "failing.test.ts"),
    'import { expect, test } from "bun:test";\ntest("fails", () => { expect(1).toBe(2); });\n',
  );
  writeFileSync(
    file,
    `#!/bin/sh
# usage: suite.sh <run> <fixture directory> <report>
echo "start $1" >> "$2/suite.log"
if [ -e "$2/slowterm" ]; then trap 'sleep 2; echo "end $1" >> "$2/suite.log"; exit 143' TERM; fi
if [ -e "$2/hold" ]; then
  i=0
  while [ ! -e "$2/release" ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i + 1)); done
else
  sleep 1
fi
if [ -e "$2/fail-$1" ]; then test=failing; else test=passing; fi
bun test "$2/$test.test.ts" --reporter=junit --reporter-outfile="$3"
status=$?
echo "end $1" >> "$2/suite.log"
exit $status
`,
  );
  return file;
}

/**
 * The recorder script: appends `<suite> <TMPDIR> <cores> <files in TMPDIR>` to `record` after it wrote a marker file
 * into its own TMPDIR, exits 1 when `fail-<suite>` exists, and writes the junit report of a passing bun test file.
 */
function writeRecorderScript(directory: string): string {
  const file = join(directory, "recorder.sh");
  writeFileSync(
    file,
    `#!/bin/sh
# usage: recorder.sh <fixture directory> <report> <suite> <cores>
touch "$TMPDIR/marker-$3"
echo "$3 $TMPDIR $4 $(ls "$TMPDIR" | tr '\\n' ',')" >> "$1/record"
bun test "$1/passing.test.ts" --reporter=junit --reporter-outfile="$2"
if [ -e "$1/fail-$3" ]; then exit 1; fi
`,
  );
  return file;
}

/**
 * Starts a run of `ticketId` at the building phase in its own project of the shared ARK_HOME. `suitesOf` names the
 * suites of the run; the default is one `sleeper` suite that asks for the whole budget.
 */
function startRun(
  project: string,
  ticketId: string,
  script: string,
  suitesOf?: (runId: string) => Suite[],
): string {
  const workspace = tempGitRepo();
  const config = (suites: Suite[]) => ({
    workspace,
    ticket_source: "local",
    test_budget_cores: 6,
    suites,
    roles,
  });
  writeProject(
    project,
    config([{ name: "sleeper", level: "integration", repo: ".", command: "true", parser: "bun" }]),
  );
  const ticket = writeTicket(project, ticketId, [
    { id: `${ticketId}-AC1`, text: "A person checks it", manual: true },
  ]);
  const runId = ark("run", "start", ticket, "--project", project).out.match(
    new RegExp(`\\d{4}-\\d{2}-\\d{2}-${ticketId}-\\d+`),
  )![0];
  writeProject(
    project,
    config(
      suitesOf?.(runId) ?? [
        {
          name: "sleeper",
          level: "integration",
          repo: ".",
          command: `sh ${script} ${runId} ${fixtures} {report}`,
          parser: "bun",
        },
      ],
    ),
  );
  const runDirectory = join(arkHome, "projects", project, "runs", runId);
  recordEvaluation(runDirectory);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
      summary: {
        why: "Test the budget.",
        changes: [
          {
            criterion: `${ticketId}-AC1`,
            where: "tests",
            now: "None.",
            fix: "A person checks.",
          },
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
          criteria: [`${ticketId}-AC1`],
        },
      ],
      test_cases: [],
    }),
  );
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
    ["worktree", "create", runId, "."],
    ["gate", "record", runId, "manual", `${ticketId}-AC1`, "ok"],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
  }
  return runId;
}

beforeAll(() => {
  arkHome = tempArkHome();
  fixtures = mkdtempSync(join(tmpdir(), "ark-test-lock-"));
  const script = writeSuiteScript(fixtures);
  writeRecorderScript(fixtures);
  mkdirSync(budgetDirectory(), { recursive: true }); // waitFor watches it
  projectA = "lock-one";
  runA = startRun(projectA, "LOCKA-1", script);
  runB = startRun("lock-two", "LOCKB-1", script);
});

afterAll(() => {
  killStarted();
  rmSync(fixtures, { recursive: true, force: true });
});

afterEach(() => {
  killStarted();
  for (const path of [
    budgetDirectory(),
    logFile(),
    join(fixtures, "record"),
    join(fixtures, "hold"),
    join(fixtures, "release"),
    join(fixtures, `fail-${runA}`),
    join(fixtures, "fail-cli"),
    join(fixtures, "slowterm"),
  ])
    rmSync(path, { recursive: true, force: true });
  mkdirSync(budgetDirectory(), { recursive: true }); // waitFor watches it
});

type Started = {
  process: Subprocess<"ignore", "pipe", "pipe">;
  stdout: Promise<string>;
  /** The stdout read so far. */
  seen: () => string;
  /** Resolves when the stdout holds `text`. */
  until: (text: string) => Promise<void>;
};

const startedTests: Subprocess[] = [];

/**
 * Kills every `ark test` this file started, and the suites under them. Runs after each test, so a failed assertion or
 * a timeout leaves nothing behind. ark runs each suite in its own process group, so the suites are found by the
 * fixture folder in their command lines.
 */
function killStarted(): void {
  for (const child of startedTests.splice(0)) child.kill("SIGKILL");
  Bun.spawnSync(["pkill", "-9", "-f", fixtures]);
}

/** Starts `ark test <run>` as a child process of the temp ARK_HOME with its stdout collected. */
function startTest(run: string, extraEnvironment: Record<string, string> = {}): Started {
  const child = Bun.spawn(["bun", arkEntry, "test", run], {
    env: { ...process.env, ARK_HOME: arkHome, ...extraEnvironment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let seen = "";
  const listeners = new Set<() => void>();
  const stdout = (async () => {
    for await (const chunk of child.stdout) {
      seen += new TextDecoder().decode(chunk);
      for (const listener of listeners) listener();
    }
    return seen;
  })();
  const until = (text: string) =>
    new Promise<void>((done) => {
      const check = () => {
        if (!seen.includes(text)) return;
        listeners.delete(check);
        done();
      };
      listeners.add(check);
      check();
    });
  startedTests.push(child);
  return { process: child, stdout, seen: () => seen, until };
}

/** Resolves when `condition` holds, checked at every change in the fixture folder and the ticket folder. */
function waitFor(condition: () => boolean): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const watchers: FSWatcher[] = [];
  const check = () => {
    if (!condition()) return;
    for (const watcher of watchers) watcher.close();
    resolve();
  };
  for (const directory of [fixtures, budgetDirectory()]) watchers.push(watch(directory, check));
  check();
  return promise;
}

const logLines = () => readLog().split("\n").filter(Boolean);
const countOf = (text: string, needle: string) => text.split(needle).length - 1;
const started = (run: string) => () => logLines().includes(`start ${run}`);

/** After B starts its suites with no ticket to wait for: no `waiting:` line and no stale takeover line. */
async function expectCleanRunOfB(): Promise<void> {
  expect(tickets()).toEqual([]);
  const second = startTest(runB);
  const out = await second.stdout;
  await second.process.exited;
  expect(logLines()).toContain(`start ${runB}`);
  expect(out).not.toContain("waiting:");
  expect(out).not.toContain("took over a stale");
}

/** A ticket file as `ark test` writes it. */
function writeTicketFile(
  name: string,
  ticket: { run: string; pid: number; cores: number; arrival: string; started?: string },
): string {
  mkdirSync(budgetDirectory(), { recursive: true });
  const file = join(budgetDirectory(), `${name}.json`);
  writeFileSync(file, JSON.stringify(ticket));
  return file;
}

describe("ark test budget", () => {
  test("ARK-T59 two ark test processes of two runs never run their suites at the same time", async () => {
    const first = startTest(runA);
    await waitFor(started(runA));
    const second = startTest(runB);
    const secondOut = await second.stdout;
    await Promise.all([first.process.exited, second.process.exited]);

    // A and B each run a base and a head suite. Whole-budget suites never overlap: each `start` is followed at once
    // by the `end` of the same run, and both runs ran.
    const lines = logLines();
    expect(new Set(lines)).toEqual(
      new Set([`start ${runA}`, `end ${runA}`, `start ${runB}`, `end ${runB}`]),
    );
    for (let i = 0; i < lines.length; i += 2)
      expect(lines[i + 1]).toBe(lines[i]!.replace("start", "end"));
    expect(secondOut).toContain(`waiting: place 1 of 1; running: ${runA} 6 cores`);
    expect(tickets()).toEqual([]);
  });

  test("ARK-T59 the tickets are gone right after a failing suite", async () => {
    writeFileSync(join(fixtures, `fail-${runA}`), "");
    const first = startTest(runA);
    await first.stdout;
    expect(await first.process.exited).not.toBe(0);
    await expectCleanRunOfB();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    test(`ARK-T59 the tickets are gone right after ${signal} ends ark test`, async () => {
      const first = startTest(runA);
      await waitFor(started(runA));
      first.process.kill(signal);
      await first.process.exited;
      await first.stdout;
      await expectCleanRunOfB();
    });

  // The suite of A needs two seconds to end after the signal, as a suite with its own cleanup does.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    test(`ARK-T59 ${signal} keeps the cores until the suite of the signalled ark test has ended`, async () => {
      writeFileSync(join(fixtures, "hold"), "");
      writeFileSync(join(fixtures, "slowterm"), "");
      const first = startTest(runA);
      await waitFor(started(runA));
      const second = startTest(runB);
      await second.until("waiting:");
      first.process.kill(signal);
      await first.process.exited;
      writeFileSync(join(fixtures, "release"), "");
      await second.process.exited;

      const lines = logLines();
      expect(lines).toContain(`end ${runA}`);
      expect(lines.indexOf(`end ${runA}`)).toBeLessThan(lines.indexOf(`start ${runB}`));
    });

  test("ARK-T60 a ticket of an ended pid frees its cores at once with one message, and no ticket gives no message", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const arrival = new Date().toISOString();
    writeTicketFile(`${dead.pid}-dead`, {
      run: runB,
      pid: dead.pid,
      cores: 6,
      arrival,
      started: arrival,
    });

    const taken = startTest(runA);
    const out = await taken.stdout;
    expect(await taken.process.exited).toBe(0);
    expect(logLines()).toContain(`start ${runA}`);
    expect(countOf(out, `took over a stale ark test lock of pid ${dead.pid}`)).toBe(1);
    expect(out).not.toContain("waiting:"); // it started on its first look, with no wait

    const again = startTest(runA);
    const againOut = await again.stdout;
    expect(await again.process.exited).toBe(0);
    expect(againOut).not.toContain("took over");
  });

  test("ARK-T61 ark chief state lists the running and the waiting run with cores and time, and no ended pid", async () => {
    const state = () => ark("chief", "state", "--project", projectA).out;
    const heading = "## ark test budget";
    expect(state()).not.toContain(heading);
    expect(state()).toContain("## Open runs");

    writeFileSync(join(fixtures, "hold"), "");
    const first = startTest(runA);
    await waitFor(started(runA));
    const second = startTest(runB);
    await second.until("waiting:");

    const section = state()
      .split(/^## /m)
      .find((part) => part.startsWith("ark test budget"));
    expect(section).toBeDefined();
    expect(section).toMatch(
      new RegExp(`running: ${runA} \\(pid ${first.process.pid}\\), 6 cores, running \\d+(s|m)`),
    );
    expect(section).toMatch(
      new RegExp(`waiting: ${runB} \\(pid ${second.process.pid}\\), 6 cores, waited \\d+(s|m)`),
    );

    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const arrival = new Date().toISOString();
    writeTicketFile(`${dead.pid}-ghost-running`, {
      run: "2026-01-01-GHOST-1",
      pid: dead.pid,
      cores: 3,
      arrival,
      started: arrival,
    });
    writeTicketFile(`${dead.pid}-ghost-waiting`, {
      run: "2026-01-01-GHOST-2",
      pid: dead.pid,
      cores: 3,
      arrival,
    });
    expect(state()).not.toContain("GHOST");

    writeFileSync(join(fixtures, "release"), "");
    await Promise.all([first.process.exited, second.process.exited, second.stdout]);
    expect(state()).not.toContain(heading);
  });

  // ARK-396: the tickets are the queue. The older waiter is a live `sleep`, never the test process.
  test("ARK-T113 a newer ark test does not take a free budget while an older live waiter of the same size exists", async () => {
    const older = Bun.spawn(["sleep", "300"]);
    startedTests.push(older);
    writeTicketFile(`${older.pid}-older`, {
      run: runA,
      pid: older.pid,
      cores: 6,
      arrival: "2020-01-01T00:00:00.000Z",
    });

    // The newer ark test prints its place and waits. At the base commit it takes the free lock and never prints.
    const newer = startTest(runB);
    await Promise.race([newer.until("waiting: place 2 of 2; running: none"), newer.process.exited]);
    expect(newer.seen()).toContain("waiting: place 2 of 2; running: none");
    expect(newer.process.exitCode).toBeNull();
    expect(logLines()).not.toContain(`start ${runB}`);

    older.kill("SIGKILL");
    await older.exited;
    expect(await newer.process.exited).toBe(0);
    expect(logLines()).toContain(`start ${runB}`);
    expect(tickets()).toEqual([]);
  });

  test("ARK-T114 a waiting ticket of an ended pid blocks nobody", async () => {
    // The ended ticket has the earliest arrival. A live older waiter sits between it and the newer test.
    const ended = Bun.spawn(["true"]);
    await ended.exited;
    const live = Bun.spawn(["sleep", "300"]);
    startedTests.push(live);
    const endedFile = writeTicketFile(`${ended.pid}-ended`, {
      run: "2019-01-01-GHOST-1",
      pid: ended.pid,
      cores: 6,
      arrival: "2019-01-01T00:00:00.000Z",
    });
    writeTicketFile(`${live.pid}-live`, {
      run: runA,
      pid: live.pid,
      cores: 6,
      arrival: "2020-01-01T00:00:00.000Z",
    });

    const newer = startTest(runB);
    // Place 2 of 2: the ended ticket does not count.
    await Promise.race([newer.until("waiting: place 2 of 2; running: none"), newer.process.exited]);
    expect(newer.seen()).toContain("waiting: place 2 of 2; running: none");
    expect(newer.process.exitCode).toBeNull();
    expect(existsSync(endedFile)).toBe(false);
    expect(logLines()).not.toContain(`start ${runB}`);

    live.kill("SIGKILL");
    await live.exited;
    expect(await newer.process.exited).toBe(0);
    expect(logLines()).toContain(`start ${runB}`);
    expect(tickets()).toEqual([]);
  });
});

describe("ark test suite TMPDIR and cores", () => {
  const recordFile = () => join(fixtures, "record");
  const recorded = () =>
    readFileSync(recordFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [suite, directory, cores, files] = line.split(" ");
        return { suite, directory: directory!, cores, files };
      });
  const recorderCommand = (suite: string, cores?: number) =>
    `sh ${join(fixtures, "recorder.sh")} ${fixtures} {report} ${suite} ${cores === undefined ? "none" : "<cores>"}`;

  /** `ark test` with a caller TMPDIR of its own, to read what the suites saw. */
  async function runWithCallerTmpdir(run: string): Promise<{ exitCode: number; caller: string }> {
    const caller = mkdtempSync(join(tmpdir(), "caller-tmpdir-"));
    const child = startTest(run, { TMPDIR: caller });
    await child.stdout;
    return { exitCode: await child.process.exited, caller };
  }

  test("ARK-T153 each suite of one ark test runs with its own TMPDIR that is gone when the suite ends", async () => {
    // The base side runs the same two suites, so one ark test has four suite runs.
    const run = startRun("tmpdir-project", "TMPDIR-1", "", () => [
      {
        name: "cli",
        level: "integration",
        repo: ".",
        command: recorderCommand("cli"),
        parser: "bun",
      },
      {
        name: "playwright",
        level: "e2e",
        repo: ".",
        command: recorderCommand("playwright"),
        parser: "bun",
      },
    ]);
    const { exitCode, caller } = await runWithCallerTmpdir(run);
    expect(exitCode).toBe(0);
    const suiteRuns = recorded();
    expect(suiteRuns).toHaveLength(4);
    const directories = suiteRuns.map((suiteRun) => suiteRun.directory);
    expect(new Set([...directories, caller]).size).toBe(5);
    for (const suiteRun of suiteRuns) {
      expect(suiteRun.files).toContain(`marker-${suiteRun.suite}`);
      expect(existsSync(suiteRun.directory)).toBe(false);
    }
    expect(readdirSync(caller)).toEqual([]);

    // A suite that fails still has its folder deleted.
    rmSync(recordFile());
    writeFileSync(join(fixtures, "fail-cli"), "");
    const failed = await runWithCallerTmpdir(run);
    expect(failed.exitCode).not.toBe(0);
    const failedRuns = recorded();
    expect(failedRuns.length).toBeGreaterThanOrEqual(2);
    for (const suiteRun of failedRuns) expect(existsSync(suiteRun.directory)).toBe(false);
    expect(readdirSync(failed.caller)).toEqual([]);
  });

  test("ARK-T155 the cores of a suite replace <cores> in its command: its own, the whole budget with none, the budget when above it", async () => {
    const run = startRun("cores-project", "CORES-1", "", () => [
      {
        name: "three",
        level: "integration",
        repo: ".",
        command: recorderCommand("three", 3),
        parser: "bun",
        cores: 3,
      },
      {
        name: "eight",
        level: "integration",
        repo: ".",
        command: recorderCommand("eight", 8),
        parser: "bun",
        cores: 8,
      },
      {
        name: "whole",
        level: "integration",
        repo: ".",
        command: recorderCommand("whole", 6),
        parser: "bun",
      },
    ]);
    const child = startTest(run);
    await child.stdout;
    expect(await child.process.exited).toBe(0);
    const head = new Map(recorded().map((suiteRun) => [suiteRun.suite, suiteRun.cores]));
    expect(Object.fromEntries(head)).toEqual({ three: "3", eight: "6", whole: "6" });
    expect(tickets()).toEqual([]);
  });
});
