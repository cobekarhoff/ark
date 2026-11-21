import type { Subprocess } from "bun";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
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
import { openTestBudget } from "../cli/test-lock.ts";
import { type FakeProcess, fakeProcesses } from "./fake-ps.ts";
import {
  afterHostReads,
  ark,
  healthyHost,
  recordEvaluation,
  setFakeHost,
  tempArkHome,
  tempGitRepo,
  writeHost,
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
/** The projects of the quick-overtake runs; `runnerPids` stops their detached runners too. */
const quickProjects = ["lock-quick-two", "lock-later-two", "lock-quick-three"];

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
    suites,
    roles,
  });
  writeHost({ test_budget_cores: 6 });
  writeProject(
    project,
    config([
      { name: "sleeper", level: "integration", repo: ".", command: "true {report}", parser: "bun" },
    ]),
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
  setFakeHost(healthyHost);
  for (const path of [
    budgetDirectory(),
    logFile(),
    join(fixtures, "record"),
    join(fixtures, "hold"),
    join(fixtures, "release"),
    join(fixtures, `fail-${runA}`),
    join(fixtures, "fail-cli"),
    join(fixtures, "slowterm"),
    // the suites read files of the fixture folder, so a stored result of an earlier test would answer for them
    join(arkHome, "projects", projectA, "test-cache"),
    join(arkHome, "projects", "lock-two", "test-cache"),
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
  // The detached runners outlive their callers: kill those recorded under this file's own ARK_HOME. Run ids repeat
  // across concurrent copies of this file, so no pattern on the run id may match. A caller killed while it spawns
  // its runner leaves a runner whose record appears after the first pass, so the second pass comes after a pause.
  for (let pass = 0; pass < 2; pass++) {
    for (const pid of runnerPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {} // already gone
    }
    Bun.spawnSync(["pkill", "-9", "-f", fixtures]);
    if (pass === 0) Bun.sleepSync(300);
  }
}

/** The pids of the live runners recorded under this file's ARK_HOME. */
function runnerPids(): number[] {
  const pids: number[] = [];
  for (const project of [projectA, "lock-two", ...quickProjects]) {
    const runsDirectory = join(arkHome, "projects", project, "runs");
    if (!existsSync(runsDirectory)) continue;
    for (const run of readdirSync(runsDirectory)) {
      try {
        const record = JSON.parse(
          readFileSync(join(runsDirectory, run, "results", "runner.json"), "utf8"),
        );
        if (record.state === "running") pids.push(record.pid);
      } catch {} // no runner record yet
    }
  }
  return pids;
}

/** The pid in the ticket of a run: the detached runner that holds the budget, not the caller. */
function runnerPid(run: string): number {
  for (const name of tickets()) {
    const ticket = JSON.parse(readFileSync(join(budgetDirectory(), name), "utf8"));
    if (ticket.run === run) return ticket.pid;
  }
  throw new Error(`no ticket of ${run}`);
}

/** Starts `ark test <run>` as a child process of the temp ARK_HOME with its stdout collected. */
function startTest(
  run: string,
  extraEnvironment: Record<string, string> = {},
  flags: string[] = [],
): Started {
  const child = Bun.spawn(["bun", arkEntry, "test", run, ...flags], {
    env: { ...process.env, ARK_HOME: arkHome, ARK_FAKE_CPU_PERCENT: "0", ...extraEnvironment },
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
  ticket: {
    run: string;
    pid: number;
    cores: number;
    arrival: string;
    started?: string;
    mode?: "quick" | "full";
  },
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
      process.kill(runnerPid(runA), signal);
      expect(await first.process.exited).toBe(128 + (signal === "SIGINT" ? 2 : 15));
      await first.stdout;
      await expectCleanRunOfB();
    });

  // Another copy of this file, or another agent's ark test, runs a runner of the same run id under its own ARK_HOME.
  // It is stood in for by a process with a runner's command line that has no record under this ARK_HOME.
  test("ARK-T568 the cleanup of one copy of this file leaves the runner of another copy with the same run id alone", async () => {
    const other = Bun.spawn(
      [
        process.execPath,
        "-e",
        "await new Promise(() => {})",
        "test-runner",
        runA,
        "--project",
        "other",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    try {
      const first = startTest(runA);
      await waitFor(started(runA));
      const runner = runnerPid(runA);
      killStarted();
      await first.process.exited;
      expect(() => process.kill(runner, 0)).toThrow(); // the runner of this copy is gone
      expect(other.exitCode).toBeNull(); // the other copy's runner lives
    } finally {
      other.kill("SIGKILL");
    }
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
      process.kill(runnerPid(runA), signal);
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
      new RegExp(`running: ${runA} \\(pid ${runnerPid(runA)}\\), 6 cores, running \\d+(s|m)`),
    );
    expect(section).toMatch(
      new RegExp(`waiting: ${runB} \\(pid ${runnerPid(runB)}\\), 6 cores, waited \\d+(s|m)`),
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

describe("ark test budget admission", () => {
  // Real processes run the real scheduler against one ARK_HOME. Hooks only pause a process at a fixed point
  // (`publish`: inside its first ticket write, `start`: just before it writes `started`, `unlink`: before it removes a
  // stale ticket) until the test marks `<name>-go-<point>`; they supply no data. A process marks `<name>-running` when
  // `take` returns. The invariant: no two running processes ever hold more cores than the budget (6).
  const child = (
    home: string,
    name: string,
    pauses: string[],
    options: { cores?: number; settings?: object } = {},
  ) => `
import { mock } from "bun:test";
import * as real from "node:fs";
const fs = { ...real };
const home = ${JSON.stringify(home)};
const name = ${JSON.stringify(name)};
const pauses = ${JSON.stringify(pauses)};
const mark = (file) => fs.writeFileSync(home + "/" + file, "");
const pause = (point) => {
  if (!pauses.includes(point)) return;
  mark(name + "-at-" + point);
  while (!fs.existsSync(home + "/" + name + "-go-" + point)) Bun.sleepSync(5);
};
let renames = 0;
let polls = 0;
mock.module("node:fs", () => ({
  ...fs,
  writeFileSync: (file, ...args) => {
    if (String(file).endsWith(".json.tmp") && renames === 0) pause("publish");
    return fs.writeFileSync(file, ...args);
  },
  renameSync: (from, to) => {
    const ticket = String(to).endsWith(".json");
    if (ticket && renames === 1) pause("start");
    fs.renameSync(from, to);
    if (ticket) {
      renames++;
      polls = 0;
      mark(name + "-after-" + renames);
    }
  },
  readdirSync: (...args) => {
    if (renames > 0 && polls < 3) mark(name + "-r" + renames + "-poll-" + ++polls);
    return fs.readdirSync(...args);
  },
  unlinkSync: (file) => {
    pause("unlink");
    return fs.unlinkSync(file);
  },
}));
const { openTestBudget } = await import(${JSON.stringify(resolve(import.meta.dir, "..", "cli", "test-lock.ts"))});
const options = ${JSON.stringify(options)};
const budget = openTestBudget(name, 6, {
  print: (line) => fs.appendFileSync(home + "/" + name + "-lines", line + "\\n"),
  ...options.settings,
});
await budget.take(options.cores ?? 6);
mark(name + "-running");
await new Promise((done) => process.stdin.once("data", done));
budget.close();`;

  /** Runs `steps` against fresh processes of one temp ARK_HOME, and kills them all after. */
  async function scenario(
    steps: (api: {
      home: string;
      spawn: (name: string, ...pauses: string[]) => void;
      spawnWith: (
        name: string,
        options: { cores: number; mode: "quick" | "full" },
        ...pauses: string[]
      ) => void;
      waitFor: (...names: string[]) => Promise<void>;
      has: (name: string) => boolean;
      go: (name: string, point: string) => void;
      stop: (name: string) => void;
    }) => Promise<void>,
  ): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "ark-admission-"));
    const children = new Map<string, Subprocess<"pipe", "ignore", "inherit">>();
    const has = (name: string) => existsSync(join(home, name));
    const start = (
      name: string,
      options: { cores?: number; settings?: object },
      pauses: string[],
    ) => {
      children.set(
        name,
        Bun.spawn(["bun", "-e", child(home, name, pauses, options)], {
          env: { ...Bun.env, ARK_HOME: home },
          stdin: "pipe",
          stdout: "ignore",
          stderr: "inherit",
        }),
      );
    };
    try {
      await steps({
        home,
        spawn: (name, ...pauses) => start(name, {}, pauses),
        spawnWith: (name, { cores, mode }, ...pauses) =>
          start(
            name,
            { cores, settings: { mode, minimumFreeMemoryPercent: 0, maximumSwapGigabytes: 1000 } },
            pauses,
          ),
        waitFor: (...names) => {
          const { promise, resolve } = Promise.withResolvers<void>();
          const check = () => {
            if (!names.every(has)) return;
            watcher.close();
            resolve();
          };
          const watcher = watch(home, check);
          check();
          return promise;
        },
        has,
        go: (name, point) => writeFileSync(join(home, `${name}-go-${point}`), ""),
        stop: (name) => {
          void children.get(name)!.stdin.write("x");
          void children.get(name)!.stdin.flush();
        },
      });
    } finally {
      for (const process of children.values()) {
        process.kill("SIGKILL");
        await process.exited;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("ARK-T155 an older ticket published after a newer one already runs waits for it instead of running with it", async () => {
    await scenario(async ({ spawn, waitFor, has, go, stop }) => {
      spawn("older", "publish");
      await waitFor("older-at-publish");
      spawn("newer");
      await waitFor("newer-running");
      go("older", "publish");
      await waitFor("older-r1-poll-3");
      expect(has("older-running")).toBe(false);
      stop("newer");
      await waitFor("older-running");
    });
  });

  test("ARK-T155 two tickets that both passed the admission check never run together: the later one revokes", async () => {
    await scenario(async ({ spawn, waitFor, has, go, stop }) => {
      spawn("older", "publish");
      await waitFor("older-at-publish");
      spawn("newer", "start"); // the newer ticket checked while the older one was not published yet
      await waitFor("newer-at-start");
      go("older", "publish");
      await waitFor("older-running");
      go("newer", "start");
      await waitFor("newer-after-3"); // its third ticket write is the revocation
      expect(has("newer-running")).toBe(false);
      stop("older");
      await waitFor("newer-running");
    });
  });

  test("ARK-T155 an older started ticket waits while a newer one that missed it runs", async () => {
    await scenario(async ({ home, spawn, waitFor, has, go, stop }) => {
      spawn("older", "publish", "start");
      await waitFor("older-at-publish");
      spawn("newer", "start");
      await waitFor("newer-at-start");
      go("older", "publish");
      await waitFor("older-at-start");
      go("newer", "start");
      await waitFor("newer-running"); // it read the older ticket as not started
      go("older", "start");
      await waitFor("older-r2-poll-3");
      expect(has("older-running")).toBe(false);
      // The older ticket holds a reservation but still waits: it prints its place and the running suite.
      expect(readFileSync(join(home, "older-lines"), "utf8")).toContain(
        "waiting: place 1 of 1; running: newer 6 cores",
      );
      stop("newer");
      await waitFor("older-running");
    });
  });

  test("ARK-T155 two contenders that see the same stale ticket remove only that file and run one suite", async () => {
    await scenario(async ({ home, spawn, waitFor, has, go }) => {
      const dead = Bun.spawn(["true"]);
      await dead.exited;
      const arrival = "2026-01-01T00:00:00.000Z";
      mkdirSync(join(home, "test-budget"));
      const stale = join(home, "test-budget", `${dead.pid}-dead.json`);
      writeFileSync(
        stale,
        JSON.stringify({ run: "dead", pid: dead.pid, cores: 6, arrival, started: arrival }),
      );
      spawn("first", "unlink");
      await waitFor("first-at-unlink");
      spawn("second");
      await waitFor("second-r1-poll-3"); // the second removed the stale file and waits behind the first
      expect(existsSync(stale)).toBe(false);
      go("first", "unlink"); // its unlink finds the file gone
      await waitFor("first-running");
      expect(has("second-running")).toBe(false);
      expect(
        readdirSync(join(home, "test-budget"))
          .filter((name) => name.endsWith(".json"))
          .map((name) => JSON.parse(readFileSync(join(home, "test-budget", name), "utf8")).run)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(["first", "second"]);
    });
  });

  // The exit handler goes with close(), so a ticket written after close() would outlive the process: the SIGTERM
  // race where a suite's take() was still waiting for a memory reading while the runner closed its budget.
  test("ARK-T59 a take after close() writes no ticket", async () => {
    const home = mkdtempSync(join(tmpdir(), "ark-admission-"));
    try {
      const script = `
import { openTestBudget } from ${JSON.stringify(resolve(import.meta.dir, "..", "cli", "test-lock.ts"))};
const budget = openTestBudget("late", 6, { print: () => {} });
budget.close();
await budget.take(6).catch(() => {});`;
      const child = Bun.spawn(["bun", "-e", script], {
        env: { ...Bun.env, ARK_HOME: home },
        stdout: "ignore",
        stderr: "inherit",
      });
      await child.exited;
      const left = existsSync(join(home, "test-budget"))
        ? readdirSync(join(home, "test-budget")).filter((name) => name.endsWith(".json"))
        : [];
      expect(left).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // ARK-551: the overtake meets the verification of the first ticket. A quick ticket of 2 cores read the tickets while
  // the holder of 4 cores and a waiting full ticket of 5 cores (4 + 5 > 6) were there, passed the full ticket and
  // paused before its `started` write. The holder ends, the full ticket starts (5 <= 6), and only then the quick
  // ticket writes `started` (5 + 2 > 6): the earlier full ticket keeps its cores and the quick one revokes. The gate is
  // the existing `start` pause of this describe, held only by the quick process.
  test("ARK-T721 a quick ticket that overtook a full ticket and writes started after the full ticket started revokes, and the started cores never pass the budget", async () => {
    await scenario(async ({ home, spawnWith, waitFor, has, go, stop }) => {
      const holder = Bun.spawn(["sleep", "300"]);
      try {
        const budgetFolder = join(home, "test-budget");
        mkdirSync(budgetFolder);
        const earlier = new Date(Date.now() - 60_000).toISOString();
        writeFileSync(
          join(budgetFolder, `${holder.pid}-holder.json`),
          JSON.stringify({
            run: "holder",
            pid: holder.pid,
            cores: 4,
            arrival: earlier,
            started: earlier,
          }),
        );
        spawnWith("full", { cores: 5, mode: "full" });
        await waitFor("full-r1-poll-3"); // published, and waits: 4 + 5 > 6
        spawnWith("quick", { cores: 2, mode: "quick" }, "start");
        await waitFor("quick-at-start"); // it passed the full ticket (4 + 2 <= 6) and holds its started write
        expect(has("full-running")).toBe(false);

        holder.kill("SIGKILL");
        await holder.exited;
        await waitFor("full-running"); // the quick ticket is not started yet, so the full ticket runs

        go("quick", "start");
        await waitFor("quick-after-3"); // its third ticket write is the revocation
        expect(has("quick-running")).toBe(false);
        const startedCores = readdirSync(budgetFolder)
          .filter((name) => name.endsWith(".json"))
          .map((name) => JSON.parse(readFileSync(join(budgetFolder, name), "utf8")))
          .filter((ticket) => ticket.started !== undefined)
          .reduce((sum, ticket) => sum + ticket.cores, 0);
        expect(startedCores).toBe(5);

        stop("full");
        await waitFor("quick-running"); // it runs only after the full ticket ended
      } finally {
        holder.kill("SIGKILL");
      }
    });
  });
});

const onMac = process.platform === "darwin"; // the fake host reading of test/tmpdir-preload.ts reaches macOS only

describe("ark test memory admission", () => {
  /** Runs `ark test` with the fake host as given and returns its exit code and output. */
  async function runToEnd(): Promise<{ code: number; out: string }> {
    const child = startTest(runA);
    const out = await child.stdout;
    return { code: await child.process.exited, out };
  }
  const waitLines = (out: string) =>
    out.split("\n").filter((line) => line.includes("waiting for memory"));

  /** Holds the suite under a short fake host: one line while it waits, no start, then a start after recovery. */
  async function holdsThenStarts(
    reading: Parameters<typeof setFakeHost>[0],
    reason: RegExp,
  ): Promise<void> {
    setFakeHost(reading);
    const child = startTest(runA);
    await child.until("waiting for memory");
    await afterHostReads(2); // two further readings while held: a line for each poll would show by now
    expect(waitLines(child.seen())).toHaveLength(1);
    expect(waitLines(child.seen())[0]).toMatch(reason);
    expect(logLines()).not.toContain(`start ${runA}`);
    expect(
      JSON.stringify(
        tickets().map((name) => JSON.parse(readFileSync(join(budgetDirectory(), name), "utf8"))),
      ),
    ).not.toContain("started");
    setFakeHost(healthyHost);
    await child.stdout;
    expect(await child.process.exited).toBe(0);
    expect(logLines()).toContain(`start ${runA}`);
    // setFakeHost rewrites two files in turn, so a poll can land on a half-recovered host and print a shrunken reason: only the held reason must not repeat.
    expect(waitLines(child.seen()).filter((line) => reason.test(line))).toHaveLength(1);
  }

  for (const [name, reading] of [
    ["a healthy host", healthyHost],
    ["free memory and swap exactly at the limits", { freePercent: 20, swapGigabytes: 8 }],
  ] as const)
    test.skipIf(!onMac)(`ARK-T187 starts at once on ${name}`, async () => {
      setFakeHost(reading);
      const { code, out } = await runToEnd();
      expect(code).toBe(0);
      expect(logLines()).toContain(`start ${runA}`);
      expect(out).not.toContain("memory");
    });

  test.skipIf(!onMac)(
    "ARK-T187 holds on swap just above the ceiling that prints as the ceiling",
    () =>
      holdsThenStarts(
        { freePercent: 50, swapGigabytes: 8.04 }, // 8232.96M: prints 8.0 GB
        /swap 8\.0 GB is above the 8 GB ceiling/,
      ),
  );

  test.skipIf(!onMac)("ARK-T187 names the free memory reason before the swap reason", () =>
    holdsThenStarts(
      { freePercent: 19, swapGigabytes: 8.1 },
      /free 19% is below the 20% floor; swap 8\.1 GB is above the 8 GB ceiling/,
    ),
  );

  test.skipIf(!onMac)(
    "ARK-T187 starts when the reading fails and says memory: unchecked once",
    async () => {
      setFakeHost({ freePercent: null, swapGigabytes: null });
      const { code, out } = await runToEnd();
      expect(code).toBe(0);
      expect(logLines()).toContain(`start ${runA}`);
      expect(countOf(out, "memory: unchecked")).toBe(1);
    },
  );

  test.skipIf(!onMac)("ARK-T187 uses the host.yml limits in place of the defaults", async () => {
    try {
      writeHost({ test_budget_cores: 6, test_min_free_memory_percent: 10, test_max_swap_gb: 12 });
      setFakeHost({ freePercent: 15, swapGigabytes: 10 });
      const { code, out } = await runToEnd();
      expect(code).toBe(0);
      expect(logLines()).toContain(`start ${runA}`);
      expect(out).not.toContain("memory");
    } finally {
      writeHost({ test_budget_cores: 6 });
    }
  });
});

describe("ark chief state host", () => {
  const state = () => ark("chief", "state", "--project", projectA).out;
  const host = () => {
    const part = state()
      .split(/^## /m)
      .find((section) => section.startsWith("Host"));
    expect(part).toBeDefined();
    return part!;
  };
  const holdLines = (text: string) =>
    text.split("\n").filter((line) => line.startsWith("hold new runs:"));
  // The real CPU and load are never read by these tests: a busy CI host would add a CPU reason.
  const seam = (cpuPercent: number | null, load: number) => {
    if (cpuPercent === null) delete process.env.ARK_FAKE_CPU_PERCENT;
    else process.env.ARK_FAKE_CPU_PERCENT = String(cpuPercent);
    process.env.ARK_FAKE_LOAD = String(load);
  };
  beforeEach(() => seam(10, 2));
  const cpuBefore = process.env.ARK_FAKE_CPU_PERCENT;
  afterEach(() => {
    // The preload pins a CPU of 0 for every test of the worker: put it back, never leave the real CPU.
    if (cpuBefore === undefined) delete process.env.ARK_FAKE_CPU_PERCENT;
    else process.env.ARK_FAKE_CPU_PERCENT = cpuBefore;
    delete process.env.ARK_FAKE_LOAD;
  });

  test.skipIf(!onMac)(
    "ARK-T365 does not hold on a high load with CPU use below the busy limit, even at the limit",
    () => {
      setFakeHost(healthyHost);
      seam(5, 500);
      const idle = host();
      expect(idle).toMatch(/load \(5 min\): 500/);
      expect(holdLines(idle)).toHaveLength(1);
      expect(idle.trimEnd().split("\n").at(-1)).toBe("hold new runs: no");
      seam(90, 500);
      expect(holdLines(host())).toEqual(["hold new runs: no"]);
    },
  );

  test.skipIf(!onMac)(
    "ARK-T366 holds on CPU use above the busy limit and names the measured value",
    () => {
      setFakeHost(healthyHost);
      seam(95, 2);
      const busy = host();
      expect(holdLines(busy)).toEqual(["hold new runs: CPU 95.0% is above the 90% busy limit"]);
      expect(busy.trimEnd().split("\n").at(-1)).toBe(holdLines(busy)[0]!);
      seam(90.1, 2);
      expect(holdLines(host())).toEqual(["hold new runs: CPU 90.1% is above the 90% busy limit"]);
      seam(95, 500);
      const loaded = host();
      expect(holdLines(loaded)).toEqual(["hold new runs: CPU 95.0% is above the 90% busy limit"]);
      expect(loaded).toMatch(/load \(5 min\): 500/);
    },
  );

  test.skipIf(!onMac)("ARK-T366 reads a real CPU value on the one-shot chief state path", () => {
    setFakeHost(healthyHost);
    seam(null, 2);
    const text = host();
    expect(text).toMatch(/^cpu: \d+(\.\d)?%$/m);
    expect(holdLines(text)).toHaveLength(1);
  });

  test.skipIf(!onMac)("ARK-T188 joins free memory, swap and CPU reasons in the fixed order", () => {
    setFakeHost({ freePercent: 19, swapGigabytes: 8.1 });
    seam(95, 2);
    const lines = holdLines(host());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "free 19% is below the 20% floor; swap 8.1 GB is above the 8 GB ceiling; CPU 95.0% is above the 90% busy limit",
    );
  });

  test.skipIf(!onMac)(
    "ARK-T188 prints the readings and no memory or swap hold on a healthy host",
    () => {
      setFakeHost(healthyHost);
      const text = host();
      expect(text).toContain("free memory: 50%");
      expect(text).toContain("swap used: 2.0 GB of 16.0 GB");
      expect(text).toMatch(/load \(5 min\): \d/);
      expect(text).toMatch(/^cpu: \d/m);
      expect(text).toMatch(/free disk: \d+ GB/);
      expect(text).toContain("tests: running 0, waiting 0");
      // The count is the real host's here (ARK-T706 owns its value): `0` when none, else count and memory, or `unavailable`.
      const lines = text.trimEnd().split("\n");
      expect(lines.at(-2)).toMatch(/^orphaned bun test workers: (0|\d+ \(\d+ MB\)|unavailable)$/);
      expect(lines.at(-1)).toMatch(/^hold new runs: /);
      expect(holdLines(text)).toHaveLength(1);
      // Load and disk are the real host's: the line is `no` only when they are clear.
      expect(holdLines(text)[0]).not.toMatch(/free \d+%|swap/);
    },
  );

  /** The Host section with a fake `ps`: the real host has live orphaned bun test workers, so no case reads its `ps`. */
  const hostWithPs = (rows: FakeProcess[] | "fails") => {
    const fake = fakeProcesses();
    const outerPath = process.env.PATH;
    process.env.PATH = `${fake.bin}:${outerPath}`;
    Object.assign(process.env, fake.environment);
    try {
      if (rows === "fails") fake.psFails();
      else fake.set(rows);
      return host();
    } finally {
      process.env.PATH = outerPath;
      delete process.env.ARK_FAKE_PS_DIR;
    }
  };
  const workerRow = (pid: number, rssKilobytes: number, parentPid = 1): FakeProcess => ({
    pid,
    parentPid,
    rssKilobytes,
    command:
      "/Users/dev/.bun/bin/bun test --test-worker --isolate --timeout=5000 --preload /repo/test/tmpdir-preload.ts",
  });
  const orphanLines = (text: string) =>
    text.split("\n").filter((line) => line.startsWith("orphaned bun test workers:"));

  test("ARK-T706 prints the number and the memory of the orphaned bun test workers before the hold line and counts no other process", () => {
    const text = hostWithPs([
      workerRow(5001, 102_400),
      workerRow(5002, 51_200),
      workerRow(5003, 153_600),
      // A worker whose parent is alive, a bun run that is not a worker and a process that is not bun: not counted.
      workerRow(5004, 999_999, 4242),
      {
        pid: 5005,
        parentPid: 1,
        rssKilobytes: 999_999,
        command: "/usr/bin/bun test test/a.test.ts",
      },
      { pid: 5006, parentPid: 1, rssKilobytes: 999_999, command: "/usr/bin/node server.js" },
    ]);
    expect(orphanLines(text)).toEqual(["orphaned bun test workers: 3 (300 MB)"]);
    const lines = text.trimEnd().split("\n");
    expect(lines.findIndex((line) => line.startsWith("tests:"))).toBe(lines.length - 3);
    expect(lines.at(-2)).toBe("orphaned bun test workers: 3 (300 MB)");
    expect(lines.at(-1)).toMatch(/^hold new runs: /);
  });

  test("ARK-T706 prints a single small orphaned worker as 1 (2 MB), not 0 and not unavailable", () => {
    expect(orphanLines(hostWithPs([workerRow(5001, 2048)]))).toEqual([
      "orphaned bun test workers: 1 (2 MB)",
    ]);
  });

  test("ARK-T706 prints 0 when ps lists no orphaned worker and unavailable when ps fails", () => {
    const none = hostWithPs([workerRow(5004, 999_999, 4242)]);
    expect(orphanLines(none)).toEqual(["orphaned bun test workers: 0"]);

    const failing = hostWithPs("fails");
    expect(orphanLines(failing)).toEqual(["orphaned bun test workers: unavailable"]);
    // Every other Host line still prints.
    expect(failing).toMatch(/^free memory: /m);
    expect(failing).toMatch(/^tests: running /m);
    expect(failing.trimEnd().split("\n").at(-1)).toMatch(/^hold new runs: /);
  });

  test.skipIf(!onMac)(
    "ARK-T188 counts a running and a waiting test beside the budget section",
    () => {
      setFakeHost(healthyHost);
      const arrival = new Date().toISOString();
      writeTicketFile(`${process.pid}-a-running`, {
        run: runA,
        pid: process.pid,
        cores: 3,
        arrival,
        started: arrival,
      });
      writeTicketFile(`${process.pid}-b-waiting`, {
        run: runB,
        pid: process.pid,
        cores: 3,
        arrival,
      });
      expect(host()).toContain("tests: running 1, waiting 1");
      expect(state()).toContain("## ark test budget");
    },
  );

  test.skipIf(!onMac)(
    "ARK-T188 prints an unreadable reading as unavailable and never holds on it",
    () => {
      setFakeHost({ freePercent: 50, swapGigabytes: null });
      const text = host();
      expect(text).toContain("free memory: 50%");
      expect(text).toContain("swap used: unavailable");
      expect(holdLines(text)[0]).not.toMatch(/free \d+%|swap/);
    },
  );
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
    // The census and the base side run the same two suites, so one ark test has six suite runs.
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
    expect(suiteRuns).toHaveLength(6);
    const directories = suiteRuns.map((suiteRun) => suiteRun.directory);
    expect(new Set([...directories, caller]).size).toBe(7);
    for (const suiteRun of suiteRuns) {
      expect(suiteRun.files).toContain(`marker-${suiteRun.suite}`);
      expect(existsSync(suiteRun.directory)).toBe(false);
    }
    expect(readdirSync(caller)).toEqual([]);

    // A suite that fails still has its folder deleted.
    rmSync(recordFile());
    // the passed suites of the first run are stored: the failing variant must run
    rmSync(join(arkHome, "projects", "tmpdir-project", "test-cache"), {
      recursive: true,
      force: true,
    });
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

// ARK-551: a quick `ark test` ticket that fits the free cores starts ahead of a blocked full ticket. The budget is 6
// cores. A holder of 4 started cores and the first waiting full ticket of 3 cores are tickets owned by live `sleep`
// processes (the full one never starts: its owner is not an `ark test`); the quick and the later full tickets are
// taken by real `ark test` processes. Every wait is an event with the limit of the test timeout.
describe("ark test quick overtake", () => {
  const holderRun = "2026-01-01-HOLD-1";
  const fullRun = "2026-01-01-FULL-1";
  // the runs of `quickProjects`
  let quickTwo: string;
  let laterTwo: string;
  let quickThree: string;

  beforeAll(() => {
    const script = join(fixtures, "suite.sh");
    const withCores = (cores: number) => (runId: string) => [
      {
        name: "sleeper",
        level: "integration",
        repo: ".",
        command: `sh ${script} ${runId} ${fixtures} {report}`,
        parser: "bun",
        cores,
      },
    ];
    quickTwo = startRun(quickProjects[0]!, "LOCKQ-2", script, withCores(2));
    laterTwo = startRun(quickProjects[1]!, "LOCKF-2", script, withCores(2));
    quickThree = startRun(quickProjects[2]!, "LOCKQ-3", script, withCores(3));
  });

  afterEach(() => {
    // the suites read files of the fixture folder, so a stored result of an earlier test would answer for them
    for (const project of quickProjects)
      rmSync(join(arkHome, "projects", project, "test-cache"), { recursive: true, force: true });
  });

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const ticketData = (): { run: string; cores: number; started?: string; mode?: string }[] =>
    tickets().flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(budgetDirectory(), name), "utf8"))];
      } catch {
        return []; // removed between the listing and the read
      }
    });
  const startedCores = () =>
    ticketData()
      .filter((ticket) => ticket.started !== undefined)
      .reduce((sum, ticket) => sum + ticket.cores, 0);
  const ticketOf = (run: string) => ticketData().find((ticket) => ticket.run === run);
  const live = () => {
    const sleeper = Bun.spawn(["sleep", "300"]);
    startedTests.push(sleeper);
    return sleeper;
  };

  /** A holder of 4 started cores and a first waiting full ticket of 3 cores that arrived `waited` minutes ago. */
  function blockedFull(waited = 1, mode?: "full") {
    const holder = live();
    const full = live();
    writeTicketFile(`${holder.pid}-holder`, {
      run: holderRun,
      pid: holder.pid,
      cores: 4,
      arrival: minutesAgo(waited + 1),
      started: minutesAgo(waited + 1),
    });
    const fullFile = writeTicketFile(`${full.pid}-full`, {
      run: fullRun,
      pid: full.pid,
      cores: 3,
      arrival: minutesAgo(waited),
      ...(mode === undefined ? {} : { mode }),
    });
    return { holder, full, fullFile };
  }

  /** Resolves once the quick or later run printed its waiting line (or ended). */
  const waits = async (run: Started) => {
    await Promise.race([run.until("waiting:"), run.process.exited]);
    expect(run.seen()).toContain("waiting:");
  };

  test.each([
    { title: "a full ticket", mode: "full" as const },
    { title: "a ticket with no mode, as an older runner wrote it", mode: undefined },
  ])(
    "ARK-T721 a quick ark test of 2 cores starts at once ahead of $title that waits for 3 cores while 4 are held, and the started cores stay at 6 or less",
    async ({ mode }) => {
      writeFileSync(join(fixtures, "hold"), "");
      const { full, fullFile } = blockedFull(1, mode);
      const before = readFileSync(fullFile, "utf8");

      const quick = startTest(quickTwo, {}, ["--quick"]);
      let peak = 0;
      await waitFor(() => {
        peak = Math.max(peak, startedCores());
        return started(quickTwo)();
      });
      expect(peak).toBeLessThanOrEqual(6);
      expect(startedCores()).toBe(6);
      // the full ticket still waits, is not pruned and is not written by the quick process
      expect(readFileSync(fullFile, "utf8")).toBe(before);
      // `executeTest` passed its mode to the budget
      expect(ticketOf(quickTwo)).toMatchObject({ cores: 2, mode: "quick" });
      expect(quick.seen()).not.toContain("waiting:");

      const state = ark("chief", "state", "--project", quickProjects[0]!).out;
      const section = state.split(/^## /m).find((part) => part.startsWith("ark test budget"));
      expect(section).toMatch(
        new RegExp(`running: ${quickTwo} \\(pid ${runnerPid(quickTwo)}\\), 2 cores`),
      );
      expect(section).toMatch(new RegExp(`waiting: ${fullRun} \\(pid ${full.pid}\\), 3 cores`));
      expect(section).not.toContain("quick");

      writeFileSync(join(fixtures, "release"), "");
      await quick.process.exited;
    },
  );

  test("ARK-T721 a quick ark test of 3 cores does not start while 4 are held, and starts once they are free", async () => {
    writeFileSync(join(fixtures, "hold"), "");
    const { holder, full } = blockedFull();

    const quick = startTest(quickThree, {}, ["--quick"]);
    await waits(quick);
    expect(quick.seen()).toContain(`waiting: place 2 of 2; running: ${holderRun} 4 cores`);
    expect(logLines()).not.toContain(`start ${quickThree}`);
    expect(ticketOf(quickThree)?.started).toBeUndefined();
    expect(startedCores()).toBe(4);

    for (const sleeper of [holder, full]) {
      sleeper.kill("SIGKILL");
      await sleeper.exited;
    }
    await waitFor(started(quickThree));
    writeFileSync(join(fixtures, "release"), "");
    await quick.process.exited;
  });

  test("ARK-T721 an overtaking quick ark test waits for the CPU hold like the first ticket and starts once the suite that holds the cores has ended", async () => {
    writeFileSync(join(fixtures, "hold"), "");
    const { holder, full } = blockedFull();

    const quick = startTest(quickTwo, { ARK_FAKE_CPU_PERCENT: "95" }, ["--quick"]);
    await Promise.race([quick.until("waiting for CPU"), quick.process.exited]);
    expect(quick.seen()).toMatch(/ark test: waiting for CPU: .*95/);
    expect(logLines()).not.toContain(`start ${quickTwo}`);
    expect(ticketOf(quickTwo)?.started).toBeUndefined();
    expect(startedCores()).toBe(4);

    // the hold applies only while a suite holds cores: with the holder gone the quick ticket is the first
    for (const sleeper of [holder, full]) {
      sleeper.kill("SIGKILL");
      await sleeper.exited;
    }
    await waitFor(started(quickTwo));
    writeFileSync(join(fixtures, "release"), "");
    await quick.process.exited;
  });

  test.each([
    { minutes: 11, passes: false, title: "waits behind" },
    { minutes: 10, passes: false, title: "waits behind" },
    { minutes: 9, passes: true, title: "starts ahead of" },
  ])(
    "ARK-T722 a quick ark test of 2 cores $title a full ticket that waited $minutes minutes, and a later full ark test never passes it",
    async ({ minutes, passes }) => {
      writeFileSync(join(fixtures, "hold"), "");
      const { fullFile } = blockedFull(minutes);
      const before = readFileSync(fullFile, "utf8");

      // a later full ark test of 2 cores fits the free cores, but is neither first nor quick
      const later = startTest(laterTwo);
      await waits(later);
      const quick = startTest(quickTwo, {}, ["--quick"]);
      if (passes) {
        await waitFor(started(quickTwo));
        expect(startedCores()).toBe(6);
      } else {
        await waits(quick);
        expect(quick.seen()).toContain(`waiting: place 3 of 3; running: ${holderRun} 4 cores`);
        expect(logLines()).not.toContain(`start ${quickTwo}`);
        expect(ticketOf(quickTwo)?.started).toBeUndefined();
        expect(startedCores()).toBe(4);
      }
      expect(logLines()).not.toContain(`start ${laterTwo}`);
      expect(ticketOf(laterTwo)?.started).toBeUndefined();
      // a process writes only its own ticket
      expect(readFileSync(fullFile, "utf8")).toBe(before);
    },
  );

  // The edge of the bound and the clock it reads. A frozen clock gives one Date.now(): a ticket that arrived exactly
  // 10 minutes before is never passed, one millisecond less is. The `now` option is a test clock for the waiting line
  // (ARK-T155 moves it by 31 s on every read); here it starts 2 minutes ahead, so a bound that read it would block
  // the 9-minute ticket.
  test.each([
    { waited: 600_000, passes: false, title: "waits behind" },
    { waited: 599_999, passes: true, title: "starts ahead of" },
  ])(
    "ARK-T722 a quick ticket $title a full ticket that waited $waited ms by the real clock, whatever the injected clock says",
    async ({ waited, passes }) => {
      const cpuBefore = process.env.ARK_FAKE_CPU_PERCENT;
      process.env.ARK_FAKE_CPU_PERCENT = "0";
      const frozen = Date.now();
      setSystemTime(frozen);
      let clock = frozen + 120_000;
      const lines: string[] = [];
      const budget = openTestBudget("2026-01-01-QUICK-1", 6, {
        mode: "quick",
        minimumFreeMemoryPercent: 0,
        maximumSwapGigabytes: 1000,
        now: () => (clock += 31_000),
        print: (line) => lines.push(line),
      });
      try {
        const { fullFile } = blockedFull(waited / 60_000);
        const before = readFileSync(fullFile, "utf8");
        const taking = budget.take(2);
        if (passes) {
          const taken = await taking;
          expect(taken.cores).toBe(2);
          expect(startedCores()).toBe(6);
          taken.release();
        } else {
          const closed = taking.catch((err: Error) => err.message);
          await waitFor(() => lines.some((line) => line.startsWith("waiting:")));
          expect(ticketOf("2026-01-01-QUICK-1")?.started).toBeUndefined();
          expect(startedCores()).toBe(4);
          budget.close();
          expect(await closed).toContain("closed");
        }
        expect(readFileSync(fullFile, "utf8")).toBe(before);
      } finally {
        budget.close();
        setSystemTime();
        if (cpuBefore === undefined) delete process.env.ARK_FAKE_CPU_PERCENT;
        else process.env.ARK_FAKE_CPU_PERCENT = cpuBefore;
      }
    },
  );
});
