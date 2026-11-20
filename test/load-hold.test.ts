import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { timelineOf } from "../hub/run-detail.ts";
import { readEvents } from "../cli/events.ts";
import { openTestBudget } from "../cli/test-lock.ts";
import {
  afterHostReads,
  ark,
  healthyHost,
  recordEvaluation,
  setFakeHost,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";
import { macOnly, recordStartedRun, stopStartedRuns } from "./orphan-runners.ts";

// ARK-586: `ark test` and `openTestBudget` hold a suite on CPU use over 90 percent from a fresh sample, only while
// another suite runs, and `test.completed` records the 1-minute load of each suite for display. The CPU is faked
// through ARK_FAKE_CPU_PERCENT and the load through ARK_FAKE_LOAD_ONE: seams that the default readers of cli/host.ts
// read on every reading, so the real `ark test` runner reads them as well.
setDefaultTimeout(90_000);

const arkEntry = resolve(import.meta.dir, "..", "cli", "ark.ts");
const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};
const junit = (file: string) => `bun test --reporter=junit --reporter-outfile={report} ./${file}`;
const passingFile = `import { test } from "bun:test";\ntest("FAKE-1-AC1 works", () => {});\n`;
const failingFile = `import { expect, test } from "bun:test";\ntest("a failing test", () => { expect(1).toBe(2); });\n`;

afterEach(() => {
  stopStartedRuns();
  setFakeHost(healthyHost);
});

/** The text a child printed, with a promise for the point where a line shows. */
class Output {
  text = "";
  readonly done: Promise<unknown>;
  #watchers: { needle: string; done: () => void }[] = [];

  constructor(...streams: ReadableStream<Uint8Array>[]) {
    this.done = Promise.all(streams.map((stream) => this.#pump(stream)));
  }

  async #pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      this.text += decoder.decode(chunk, { stream: true });
      for (const watcher of this.#watchers.filter((entry) => this.text.includes(entry.needle)))
        watcher.done();
    }
  }

  until(needle: string): Promise<void> {
    const { promise, resolve: done } = Promise.withResolvers<void>();
    if (this.text.includes(needle)) done();
    else this.#watchers.push({ needle, done });
    return promise;
  }

  lines(needle: string): string[] {
    return this.text.split("\n").filter((line) => line.includes(needle));
  }
}

type Suite = { name: string; level: string; command: string };
type Fixture = {
  runId: string;
  runDirectory: string;
  /** A folder that the check and the suite commands write their marker files into. */
  markers: string;
  /** Rewrites ark.yml: the base config plus `extra`; a key set to undefined is left out. */
  configure: (extra: Record<string, unknown>) => void;
  /** Removes the markers and the test cache, so the next `ark test` runs everything again. */
  reset: () => void;
};

/** A run at the building phase whose suites and checks are real shell commands. Every test builds its own temp ARK_HOME. */
function makeRun(
  files: Record<string, string>,
  suitesOf: (markers: string) => Suite[],
  checksOf: (markers: string) => { name: string; repo: string; command: string }[] = () => [],
): Fixture {
  const home = tempArkHome();
  const markers = mkdtempSync(join(tmpdir(), "ark-load-markers-"));
  const workspace = tempGitRepo(files);
  const base = {
    workspace,
    ticket_source: "local",
    test_min_free_memory_percent: 0,
    test_max_swap_gb: 1000,
    test_budget_cores: 4,
    checks: checksOf(markers),
    suites: suitesOf(markers).map((suite) => ({
      ...suite,
      repo: ".",
      parser: "bun",
    })),
    roles,
  };
  writeProject("demo", base);
  const ticket = writeTicket("demo", "FAKE-1", [
    { id: "FAKE-1-AC1", text: "criterion FAKE-1-AC1" },
  ]);
  const runId = ark("run", "start", ticket, "--project", "demo").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-1-\d+/,
  )![0];
  const runDirectory = join(home, "projects", "demo", "runs", runId);
  recordStartedRun({ runId, runDirectory });
  recordEvaluation(runDirectory);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
      summary: {
        why: "Test the load hold.",
        changes: [
          {
            criterion: "FAKE-1-AC1",
            where: "tests",
            now: "none",
            fix: "a suite proves it",
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
  return {
    runId,
    runDirectory,
    markers,
    configure: (extra) => writeProject("demo", { ...base, ...extra }),
    reset: () => {
      for (const name of readdirSync(markers)) rmSync(join(markers, name), { force: true });
      rmSync(join(home, "projects", "demo", "test-cache"), {
        recursive: true,
        force: true,
      });
    },
  };
}

/** The fixture of ARK-T709 and ARK-T710: one project check and one passing suite, each asking for 1 of 4 cores and writing a marker file. */
const markedRun = () =>
  makeRun(
    { "e2e.test.ts": passingFile },
    (markers) => [
      {
        name: "e2e",
        level: "e2e",
        cores: 1,
        command: `touch ${markers}/suite && ${junit("e2e.test.ts")}`,
      },
    ],
    (markers) => [{ name: "mark", repo: ".", cores: 1, command: `touch ${markers}/check` }],
  );

type StartedTest = {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  output: Output;
};

/** The host that the runner reads: `cpu` is ARK_FAKE_CPU_PERCENT (null leaves the real sampler), `load` ARK_FAKE_LOAD_ONE. */
type Readings = { cpu: string | null; load: string };

/** Starts `ark test` as a child process on the host readings as given. */
function startTest(runId: string, readings: Readings, ...flags: string[]): StartedTest {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    ARK_FAKE_LOAD_ONE: readings.load,
  };
  if (readings.cpu === null) delete environment.ARK_FAKE_CPU_PERCENT; // the real sampler
  else environment.ARK_FAKE_CPU_PERCENT = readings.cpu;
  const child = Bun.spawn(
    [process.execPath, arkEntry, "test", runId, "--project", "demo", ...flags],
    { env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  return { child, output: new Output(child.stdout, child.stderr) };
}

/** Rejects with the name of the wait when `promise` does not settle in `milliseconds`: a guard on a real process, not a pause. */
function within<Value>(
  promise: Promise<Value>,
  name: string,
  milliseconds = 30_000,
): Promise<Value> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const deadline = AbortSignal.timeout(milliseconds); // a deadline that never keeps the process alive
  deadline.addEventListener("abort", () =>
    reject(new Error(`no ${name} within ${milliseconds} ms`)),
  );
  return Promise.race([promise, expired]);
}

/** Resolves when the run prints `line`; rejects when the run ends first, which is a run that was never held. */
function waitForLine(run: StartedTest, line: string): Promise<void> {
  const ended = run.child.exited.then(() => {
    throw new Error(`the run ended before "${line}":\n${run.output.text}`);
  });
  return within(Promise.race([run.output.until(line), ended]), `"${line}" line`);
}

/** Stops a run that still waits through `ark test --stop` and waits for its exit and its output. */
async function stopRun(fixture: Fixture, run: StartedTest): Promise<void> {
  if (run.child.exitCode === null) ark("test", fixture.runId, "--stop", "--project", "demo");
  await run.child.exited;
  await run.output.done;
}

/** Runs `ark test` to its end. A waiting line first means the run is held: the rows that use this expect a start. */
async function runToEnd(fixture: Fixture, readings: Readings) {
  fixture.reset();
  const run = startTest(fixture.runId, readings);
  const first = await Promise.race([
    run.child.exited.then(() => "ended" as const),
    run.output.until("waiting for").then(() => "held" as const),
  ]);
  if (first === "held") await stopRun(fixture, run);
  expect(first, run.output.text).toBe("ended");
  await run.output.done;
  return { code: run.child.exitCode, out: run.output.text };
}

const markersOf = (fixture: Fixture) => readdirSync(fixture.markers).sort();
const ticketsOf = (): Record<string, unknown>[] => {
  const directory = join(process.env.ARK_HOME as string, "test-budget");
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")))
    : [];
};

/** The tickets of one run label: `holder` for the suite that runs, a run id for the `ark test` under test. */
const ticketsOfRun = (run: string) => ticketsOf().filter((ticket) => ticket.run === run);

const lockModule = resolve(import.meta.dir, "..", "cli", "test-lock.ts");

// Processes this file starts, stopped by their own pids when a case ends.
const spawned: { kill: (signal: "SIGKILL") => void }[] = [];
afterEach(() => {
  for (const child of spawned.splice(0)) child.kill("SIGKILL");
});

/**
 * A suite that runs: a real child process that takes 1 core of the 4-core budget of the temp ARK_HOME from the real
 * `openTestBudget`, so its ticket is `started` with a live pid, and keeps it until it is released.
 */
async function startHolder() {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { openTestBudget } from ${JSON.stringify(lockModule)};
const budget = openTestBudget("holder", 4, { minimumFreeMemoryPercent: 0, maximumSwapGigabytes: 1000, print: () => {} });
await budget.take(1);
console.log("held");
await new Promise((done) => process.stdin.once("data", done));
budget.close();
process.exit(0);`,
    ],
    {
      env: { ...process.env, ARK_FAKE_CPU_PERCENT: "0", ARK_FAKE_LOAD_ONE: "0" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  spawned.push(child);
  await within(new Output(child.stdout).until("held"), "ticket of the holder");
  return {
    child,
    release: async () => {
      void child.stdin.write("x");
      void child.stdin.flush();
      await within(child.exited, "exit of the holder");
    },
  };
}

const cpuLine = (figure: string) =>
  new RegExp(String.raw`^ark test: waiting for CPU: .*\b${figure}\b.* 90\b(?!\.)`);

describe("ARK-T709", () => {
  const hot: Readings = { cpu: "99", load: "500" };

  test("ARK-T709 starts the check and the suite at once when no suite runs, at CPU 99 percent and a load of 500", async () => {
    const fixture = markedRun();
    const { code, out } = await runToEnd(fixture, hot);
    expect(code, out).toBe(0);
    expect(out).not.toContain("waiting for");
    expect(markersOf(fixture)).toEqual(["check", "suite"]);
  });

  test("ARK-T709 holds on CPU while another suite runs, and starts when that suite ends with the readings unchanged", async () => {
    const fixture = markedRun();
    const holder = await startHolder();
    const run = startTest(fixture.runId, hot);
    try {
      await waitForLine(run, "waiting for CPU");
      await afterHostReads(2); // two fresh readings while held: a start or a second line would show by now
      expect(markersOf(fixture), "a check or suite started while another suite ran").toEqual([]);
      expect(run.output.lines("waiting for")).toHaveLength(1);
      expect(run.output.lines("waiting for CPU")[0]).toMatch(cpuLine(String.raw`99(\.0)?`));
      expect(ticketsOfRun(fixture.runId)).toHaveLength(1);
      expect(ticketsOfRun(fixture.runId)[0]).not.toHaveProperty("started");
      expect(ticketsOfRun("holder")).toMatchObject([{ started: expect.any(String) }]);

      // The suite that ran ends: nothing runs, so the unchanged CPU 99 and load 500 no longer hold.
      await holder.release();
      expect(await within(run.child.exited, "exit of ark test", 60_000)).toBe(0);
      await run.output.done;
      expect(markersOf(fixture)).toEqual(["check", "suite"]);
      expect(run.output.lines("waiting for")).toHaveLength(1);
    } finally {
      await stopRun(fixture, run);
    }
  });

  test("ARK-T709 does not count the stale ticket of an ended process as a suite that runs", async () => {
    const fixture = markedRun();
    const holder = await startHolder();
    holder.child.kill("SIGKILL"); // by its own pid, without letting it release its ticket
    await holder.child.exited;
    expect(ticketsOfRun("holder"), "the stale ticket is the scenario").toHaveLength(1);
    const { code, out } = await runToEnd(fixture, hot);
    expect(code, out).toBe(0);
    expect(out).not.toContain("waiting for");
    expect(markersOf(fixture)).toEqual(["check", "suite"]);
  });

  macOnly("ARK-T709 still holds on memory when no suite runs, at CPU 99 percent", async () => {
    const fixture = markedRun();
    fixture.configure({ test_min_free_memory_percent: 20, test_max_swap_gb: 8 });
    setFakeHost({ freePercent: 15, swapGigabytes: 2 }); // under the 20 percent floor
    const run = startTest(fixture.runId, hot);
    try {
      await waitForLine(run, "waiting for memory");
      await afterHostReads(2);
      expect(markersOf(fixture), "a suite started into a host short of memory").toEqual([]);
      expect(run.output.lines("waiting for memory")).toHaveLength(1);
      expect(run.output.text).not.toContain("waiting for CPU");
      expect(run.output.text).not.toContain("1-minute load");

      setFakeHost(healthyHost);
      expect(await within(run.child.exited, "exit of ark test", 60_000)).toBe(0);
      await run.output.done;
      expect(markersOf(fixture)).toEqual(["check", "suite"]);
    } finally {
      await stopRun(fixture, run);
    }
  });
});

describe("ARK-T710", () => {
  test.each([
    { title: "CPU 5 percent and a load of 30", cpu: "5", load: "30" },
    { title: "CPU exactly at the limit of 90 percent", cpu: "90", load: "0" },
    { title: "a CPU reading that cannot be read and a load of 30", cpu: "unreadable", load: "30" },
  ])(
    "ARK-T710 starts the check and the suite at once on $title while another suite runs",
    async ({ cpu, load }) => {
      const fixture = markedRun();
      await startHolder();
      const { code, out } = await runToEnd(fixture, { cpu, load });
      expect(code, out).toBe(0);
      expect(out).not.toContain("waiting for");
      expect(markersOf(fixture)).toEqual(["check", "suite"]);
    },
  );

  /** Starts `ark test` with a suite running, waits for its CPU line and fresh readings, and checks the run is held on it. */
  async function expectHeldOnCpu(readings: Readings, figure: string): Promise<void> {
    const fixture = markedRun();
    await startHolder();
    const run = startTest(fixture.runId, readings);
    try {
      await waitForLine(run, "waiting for CPU");
      await afterHostReads(2); // two fresh readings while held: a start or a second line would show by now
      expect(markersOf(fixture), "a check or suite started while the line says it waits").toEqual(
        [],
      );
      expect(run.output.lines("waiting for")).toHaveLength(1);
      expect(run.output.lines("waiting for CPU")[0]).toMatch(cpuLine(figure));
      expect(run.output.text).not.toContain("1-minute load");
      expect(run.output.text).not.toContain("waiting for memory");
      expect(ticketsOfRun(fixture.runId)).toHaveLength(1);
      expect(ticketsOfRun(fixture.runId)[0]).not.toHaveProperty("started");
    } finally {
      await stopRun(fixture, run);
    }
  }

  test.each([
    { cpu: "99", figure: String.raw`99(\.0)?` },
    { cpu: "90.1", figure: String.raw`90\.1` },
  ])(
    "ARK-T710 holds the check and the suite on CPU $cpu percent while another suite runs, and prints one CPU line",
    async ({ cpu, figure }) => {
      await expectHeldOnCpu({ cpu, load: "0" }, figure);
    },
  );

  test("ARK-T710 holds on the CPU that a fresh runner process samples itself when no CPU seam is set", async () => {
    const loops = Array.from({ length: availableParallelism() }, () =>
      Bun.spawn([process.execPath, "-e", "for (;;);"], { stdout: "ignore", stderr: "ignore" }),
    );
    spawned.push(...loops);
    try {
      await expectHeldOnCpu({ cpu: null, load: "0" }, String.raw`\d+(\.\d)?`);
    } finally {
      for (const loop of loops) loop.kill("SIGKILL"); // by their own pids
    }
  });
});

describe("ARK-T693", () => {
  /** Rewrites the load file while the failing suite runs: 9 for 2.5 s, 3 for 2.5 s, then exit 1 through a failing test. */
  const movingSuites = (loadFile: string) => (markers: string) => [
    { name: "pass", level: "e2e", command: junit("pass.test.ts") },
    {
      name: "fail",
      level: "unit",
      command: `printf 9 > ${loadFile}; sleep 2.5; printf 3 > ${loadFile}; sleep 2.5; ${junit("fail.test.ts")} # ${markers}`,
    },
  ];
  const files = { "pass.test.ts": passingFile, "fail.test.ts": failingFile };

  function movingRun() {
    const loadFile = join(mkdtempSync(join(tmpdir(), "ark-load-file-")), "load");
    const fixture = makeRun(files, movingSuites(loadFile), () => []);
    return { fixture, loadFile };
  }

  const suitesOf = (runDirectory: string) => {
    const completed = readEvents(runDirectory).filter((event) => event.type === "test.completed");
    return completed.map((event) => event.data.suites as Record<string, unknown>[]);
  };
  const entryOf = (suites: Record<string, unknown>[], name: string) =>
    suites.find((suite) => suite.name === name)!;

  async function runWithLoad(fixture: Fixture, loadFile: string, ...flags: string[]) {
    writeFileSync(loadFile, "2");
    const run = startTest(fixture.runId, { cpu: "0", load: `file:${loadFile}` }, ...flags);
    const code = await run.child.exited;
    await run.output.done;
    return { code, out: run.output.text };
  }

  test("ARK-T693 records the load at the start of each suite and the highest sampled, with a reused suite null in both", async () => {
    const { fixture, loadFile } = movingRun();

    const first = await runWithLoad(fixture, loadFile);
    expect(first.code, first.out).toBe(1);
    const [firstRun] = suitesOf(fixture.runDirectory);
    // 2 at the start, 9 and 3 each held over two sampler ticks: a first, last or constant value fails.
    expect(entryOf(firstRun!, "fail")).toMatchObject({
      passed: false,
      loadAtStart: 2,
      loadPeak: 9,
    });
    const passed = entryOf(firstRun!, "pass");
    expect([2, 9, 3]).toContain(passed.loadAtStart as number);
    expect(passed.loadPeak as number).toBeGreaterThanOrEqual(passed.loadAtStart as number);

    const second = await runWithLoad(fixture, loadFile);
    expect(second.code, second.out).toBe(1);
    const secondRun = suitesOf(fixture.runDirectory)[1]!;
    expect(entryOf(secondRun, "pass")).toMatchObject({
      reused: true,
      loadAtStart: null,
      loadPeak: null,
    });
    // The suite that ran again records its own load: the peak of the earlier run does not carry over.
    expect(entryOf(secondRun, "fail")).toMatchObject({
      loadAtStart: 2,
      loadPeak: 9,
    });
  });

  test("ARK-T693 a run stopped by a failed check records no suite and so no load, and a quick run records the load of the suites it ran", async () => {
    const loadFile = join(mkdtempSync(join(tmpdir(), "ark-load-file-")), "load");
    const fixture = makeRun(files, movingSuites(loadFile), () => [
      { name: "broken", repo: ".", command: "exit 1" },
    ]);
    const stopped = await runWithLoad(fixture, loadFile);
    expect(stopped.code).toBe(1);
    expect(stopped.out).toContain("check broken failed");
    expect(suitesOf(fixture.runDirectory)).toEqual([[]]);

    fixture.configure({ checks: [] });
    fixture.reset();
    const quick = await runWithLoad(fixture, loadFile, "--quick");
    expect(quick.code, quick.out).toBe(1);
    const quickRun = suitesOf(fixture.runDirectory)[1]!;
    expect(entryOf(quickRun, "fail")).toMatchObject({
      loadAtStart: 2,
      loadPeak: 9,
    });
  });

  test("ARK-T693 ark retro and the hub timeline read a suite entry without the load fields, and print no undefined, NaN or null for it", async () => {
    const fixture = markedRun();
    const heads = { ".": "0000000" };
    const oldEvent = {
      type: "test.completed",
      data: {
        passed: true,
        heads,
        suites: [{ name: "e2e", level: "e2e", passed: true }],
        criteria: { "FAKE-1/AC1": "passing" },
      },
    };
    const line = (seq: number, shape: typeof oldEvent) =>
      `${JSON.stringify({ seq, time: "2026-11-18T10:00:00.000Z", ...shape })}\n`;
    const events = readEvents(fixture.runDirectory);
    appendFileSync(join(fixture.runDirectory, "events.ndjson"), line(events.length + 1, oldEvent));
    const after = ark("retro", fixture.runId, "--project", "demo");
    expect(after.code, after.err).toBe(0);
    expect(after.out + after.err).not.toMatch(/undefined|NaN/);
    const timeline = timelineOf(readEvents(fixture.runDirectory)).filter(
      (entry) => entry.type === "test.completed",
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.why).toBe("passed");
    expect(JSON.stringify(timeline)).not.toMatch(/undefined|NaN|loadAtStart|loadPeak/);
  });
});

describe("ARK-T694", () => {
  /**
   * Opens the budget under test in a temp ARK_HOME, and a second budget of this process under another label whose
   * `started` ticket is the suite that runs (the CPU hold applies only while one does, ARK-T709). `lines` holds what
   * the budget prints; the memory limits are off unless the case says so.
   */
  async function startScenario(options: { memory: boolean } = { memory: false }) {
    tempArkHome();
    const limits = { minimumFreeMemoryPercent: 0, maximumSwapGigabytes: 1000 };
    const running = openTestBudget("running", 6, { ...limits, print: () => {} });
    const suite = await within(running.take(1), "ticket of the running suite");
    const lines: string[] = [];
    const waiters: (() => void)[] = [];
    const budget = openTestBudget("run-cpu", 6, {
      ...(options.memory ? {} : limits),
      print: (line) => {
        lines.push(line);
        for (const waiter of waiters.splice(0)) waiter();
      },
    });
    return {
      budget,
      lines,
      close: () => {
        budget.close();
        suite.release();
        running.close();
      },
      /** Resolves once `lines` holds a line with `text`. */
      line: (text: string) => {
        const { promise, resolve: done } = Promise.withResolvers<void>();
        const check = () =>
          lines.some((line) => line.includes(text)) ? done() : waiters.push(check);
        check();
        return within(promise, `"${text}" line`);
      },
    };
  }
  const withCpu = (cpu: string) => {
    process.env.ARK_FAKE_CPU_PERCENT = cpu;
  };
  // The preload pins a CPU of 0 for every test of the worker: put it back, never leave a value of a case.
  const cpuBefore = process.env.ARK_FAKE_CPU_PERCENT;
  afterEach(() => {
    if (cpuBefore === undefined) delete process.env.ARK_FAKE_CPU_PERCENT;
    else process.env.ARK_FAKE_CPU_PERCENT = cpuBefore;
  });
  const ticketOfBudget = () => ticketsOfRun("run-cpu");
  const linesWith = (lines: string[], text: string) =>
    lines.filter((entry) => entry.includes(text));

  test("ARK-T694 holds on CPU above the limit while a suite runs with one line and an unstarted ticket, then starts once the CPU is at the limit", async () => {
    withCpu("95");
    const { budget, lines, line, close } = await startScenario();
    try {
      let resolved = false;
      const taking = budget.take(1).then((taken) => ((resolved = true), taken));
      void taking.catch(() => {}); // a failed wait below closes the budget, which rejects this call
      await line("waiting for CPU");
      await afterHostReads(2); // two fresh samples while the CPU is above the limit
      expect(resolved).toBe(false);
      expect(linesWith(lines, "waiting for CPU")).toHaveLength(1);
      expect(lines.find((entry) => entry.includes("waiting for CPU"))).toMatch(
        /^ark test: waiting for CPU: .*\b95(\.0)?\b.* 90\b(?!\.)/,
      );
      expect(ticketOfBudget()).toHaveLength(1);
      expect(ticketOfBudget()[0]).not.toHaveProperty("started");

      withCpu("90"); // at the limit
      const taken = await within(taking, "start of the held ticket");
      expect(taken.cores).toBe(1);
      expect(ticketOfBudget()[0]).toMatchObject({ cores: 1, started: expect.any(String) });
      expect(linesWith(lines, "waiting for CPU")).toHaveLength(1);
      taken.release();
    } finally {
      close();
    }
  });

  macOnly(
    "ARK-T694 prints a CPU line and a memory line once each, and a recovered CPU does not release a memory hold",
    async () => {
      setFakeHost({ freePercent: 15, swapGigabytes: 2 }); // under the 20 percent floor
      withCpu("95");
      const { budget, lines, line, close } = await startScenario({ memory: true });
      try {
        let resolved = false;
        const taking = budget.take(1).then((taken) => ((resolved = true), taken));
        void taking.catch(() => {});
        await line("waiting for CPU");
        await line("waiting for memory");
        expect(linesWith(lines, "waiting for CPU")).toHaveLength(1);
        expect(linesWith(lines, "waiting for memory")).toHaveLength(1);

        withCpu("5"); // only memory holds now
        await afterHostReads(2); // two fresh readings with the CPU recovered and memory short
        expect(resolved, "a recovered CPU released a memory hold").toBe(false);
        expect(linesWith(lines, "waiting for CPU")).toHaveLength(1);
        expect(linesWith(lines, "waiting for memory")).toHaveLength(1);

        setFakeHost(healthyHost);
        (await within(taking, "start of the held ticket")).release();
        expect(lines.filter((entry) => entry.startsWith("ark test: waiting"))).toHaveLength(2);
      } finally {
        close();
      }
    },
  );

  test("ARK-T694 starts a held ticket when the CPU reading becomes unreadable, with no further hold line", async () => {
    withCpu("95");
    const { budget, lines, line, close } = await startScenario();
    try {
      const taking = budget.take(1);
      void taking.catch(() => {});
      await line("waiting for CPU");
      withCpu("unreadable");
      (await within(taking, "start of the held ticket")).release();
      expect(lines.filter((entry) => entry.startsWith("ark test: waiting"))).toHaveLength(1);
      expect(linesWith(lines, "waiting for CPU")).toHaveLength(1);
    } finally {
      close();
    }
  });
});
