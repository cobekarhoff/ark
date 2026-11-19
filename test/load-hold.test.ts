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

// ARK-515: `ark test` and `openTestBudget` hold a suite while the 1-minute load is above test_max_load, and
// `test.completed` records the load of each suite. The load is faked through ARK_FAKE_LOAD_ONE, the seam that the
// default load reader of cli/host.ts reads on every reading; the real `ark test` runner reads it as well.
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
/** Over one cache lifetime of the host reading (1,000 ms) and three polls (100 ms each), so a fresh reading has happened. */
const heldMilliseconds = 1_500;

afterEach(() => {
  stopStartedRuns();
  setFakeHost(healthyHost);
  delete process.env.ARK_FAKE_CPU_PERCENT;
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

/** The fixture of ARK-T692: one project check and one passing suite, each writing a marker file. */
const markedRun = () =>
  makeRun(
    { "e2e.test.ts": passingFile },
    (markers) => [
      {
        name: "e2e",
        level: "e2e",
        command: `touch ${markers}/suite && ${junit("e2e.test.ts")}`,
      },
    ],
    (markers) => [{ name: "mark", repo: ".", command: `touch ${markers}/check` }],
  );

type StartedTest = {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  output: Output;
};

/** Starts `ark test` as a child process with the 1-minute load of the fake host as given. */
function startTest(runId: string, load: string, ...flags: string[]): StartedTest {
  const child = Bun.spawn(
    [process.execPath, arkEntry, "test", runId, "--project", "demo", ...flags],
    {
      env: { ...process.env, ARK_FAKE_LOAD_ONE: load },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return { child, output: new Output(child.stdout, child.stderr) };
}

async function runToEnd(fixture: Fixture, load: string) {
  fixture.reset();
  const run = startTest(fixture.runId, load);
  const code = await run.child.exited;
  await run.output.done;
  return {
    code,
    out: run.output.text,
    lines: run.output.lines("waiting for load"),
  };
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

/** Starts `ark test`, waits for its load line and a fresh reading, and hands the held run to `inspect`; then stops it. */
async function whileHeld(
  fixture: Fixture,
  load: string,
  inspect: (run: StartedTest) => void | Promise<void>,
): Promise<void> {
  fixture.reset();
  const run = startTest(fixture.runId, load);
  try {
    await run.output.until("waiting for load");
    await Bun.sleep(heldMilliseconds); // nothing happens while held: only a deadline can show that
    await inspect(run);
  } finally {
    ark("test", fixture.runId, "--stop", "--project", "demo");
    await run.child.exited;
    await run.output.done;
  }
}

const loadLine = (load: string, limit: number) =>
  `ark test: waiting for load: 1-minute load ${load} is above the limit ${limit}`;

describe("ARK-T692", () => {
  test("ARK-T692 holds the check and the suite while the load is above the limit, prints one line naming both numbers, and keeps the ticket unstarted", async () => {
    const fixture = markedRun();
    fixture.configure({ test_max_load: 10 });
    await whileHeld(fixture, "12.5", (run) => {
      expect(markersOf(fixture), "a check or suite started into a load above the limit").toEqual(
        [],
      );
      expect(run.output.lines("waiting for load")).toEqual([loadLine("12.5", 10)]);
      expect(run.output.text).not.toContain("waiting for memory");
      const [ticket] = ticketsOf();
      expect(ticketsOf()).toHaveLength(1);
      expect(ticket).toMatchObject({ run: fixture.runId });
      expect(ticket).not.toHaveProperty("started");
      expect(ark("chief", "state", "--project", "demo").out).toContain(
        `- waiting: ${fixture.runId} (pid`,
      );
    });
  });

  test.each([
    { name: "a load at the limit", load: "10", limit: 10 },
    { name: "a load under the limit", load: "3", limit: 10 },
    { name: "a load at a fractional limit", load: "7.5", limit: 7.5 },
  ])("ARK-T692 starts the check and the suite at once on $name", async ({ load, limit }) => {
    const fixture = markedRun();
    fixture.configure({ test_max_load: limit });
    const { code, out, lines } = await runToEnd(fixture, load);
    expect(code, out).toBe(0);
    expect(lines).toEqual([]);
    expect(markersOf(fixture)).toContain("check");
    expect(markersOf(fixture)).toContain("suite");
  });

  test("ARK-T692 keeps the fraction of the limit when the load is just above it", async () => {
    const fixture = markedRun();
    fixture.configure({ test_max_load: 7.5 });
    await whileHeld(fixture, "7.6", (run) => {
      expect(run.output.lines("waiting for load")).toEqual([loadLine("7.6", 7.5)]);
      expect(markersOf(fixture)).toEqual([]);
    });
  });

  test("ARK-T692 takes the core count as the default limit: a load equal to it starts, a load 0.1 above it holds", async () => {
    const cores = availableParallelism();
    const fixture = markedRun();
    fixture.configure({ test_max_load: undefined });
    const { code, out } = await runToEnd(fixture, String(cores));
    expect(code, out).toBe(0);
    expect(out).not.toContain("waiting for load");
    const above = (cores + 0.1).toFixed(1);
    await whileHeld(fixture, above, (run) => {
      expect(run.output.lines("waiting for load")).toEqual([loadLine(above, cores)]);
      expect(markersOf(fixture)).toEqual([]);
    });
  });

  test("ARK-T692 starts when the load reading is missing, and does not stall", async () => {
    const fixture = markedRun();
    fixture.configure({ test_max_load: 10 });
    const { code, out, lines } = await runToEnd(fixture, "unreadable");
    expect(code, out).toBe(0);
    expect(lines).toEqual([]);
    expect(markersOf(fixture)).toContain("suite");
  });

  test.each(['"fast"', "-1", "0"])(
    "ARK-T692 refuses test_max_load %s, names the key, and runs nothing",
    (value) => {
      const fixture = markedRun();
      fixture.configure({ test_max_load: JSON.parse(value) });
      const result = ark("test", fixture.runId, "--project", "demo");
      expect(result.code).toBe(1);
      expect(result.out + result.err).toContain("test_max_load");
      expect(markersOf(fixture)).toEqual([]);
      const completed = readEvents(fixture.runDirectory).filter(
        (event) => event.type === "test.completed",
      );
      expect(completed).toEqual([]);
    },
  );

  // The chief reads the host through the same default reader, so the 1-minute slot of the seam reaches it.
  macOnly("ARK-T692 ark chief state does not hold new runs for a 1-minute load of 500", () => {
    const fixture = markedRun();
    fixture.configure({ test_max_load: 10 });
    setFakeHost(healthyHost);
    process.env.ARK_FAKE_CPU_PERCENT = "10";
    const previous = {
      load: process.env.ARK_FAKE_LOAD,
      one: process.env.ARK_FAKE_LOAD_ONE,
    };
    delete process.env.ARK_FAKE_LOAD; // the chief's own override would replace the reading the seam feeds
    process.env.ARK_FAKE_LOAD_ONE = "500";
    try {
      const state = ark("chief", "state", "--project", "demo").out;
      expect(state).toContain("hold new runs: no");
      expect(state).not.toContain("waiting for load");
    } finally {
      if (previous.load !== undefined) process.env.ARK_FAKE_LOAD = previous.load;
      process.env.ARK_FAKE_LOAD_ONE = previous.one;
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
    fixture.configure({ test_max_load: 100 });
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
    const run = startTest(fixture.runId, `file:${loadFile}`, ...flags);
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
    fixture.configure({ test_max_load: 100 });
    const stopped = await runWithLoad(fixture, loadFile);
    expect(stopped.code).toBe(1);
    expect(stopped.out).toContain("check broken failed");
    expect(suitesOf(fixture.runDirectory)).toEqual([[]]);

    fixture.configure({ test_max_load: 100, checks: [] });
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
    fixture.configure({ test_max_load: 100 });
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
  /** Writes to the budget of a temp ARK_HOME and prints into `lines`; the memory limits are off unless the case says so. */
  function openBudget(options: { memory: boolean } = { memory: false }) {
    tempArkHome();
    const lines: string[] = [];
    const waiters: (() => void)[] = [];
    const budget = openTestBudget("run-load", 6, {
      maximumLoad: 10,
      ...(options.memory ? {} : { minimumFreeMemoryPercent: 0, maximumSwapGigabytes: 1000 }),
      print: (line) => {
        lines.push(line);
        for (const waiter of waiters.splice(0)) waiter();
      },
    });
    return {
      budget,
      lines,
      /** Resolves once `lines` holds a line with `text`. */
      line: (text: string) => {
        const { promise, resolve: done } = Promise.withResolvers<void>();
        const check = () =>
          lines.some((line) => line.includes(text)) ? done() : waiters.push(check);
        check();
        return promise;
      },
    };
  }
  const withLoad = (load: string | undefined) => {
    if (load === undefined) delete process.env.ARK_FAKE_LOAD_ONE;
    else process.env.ARK_FAKE_LOAD_ONE = load;
  };
  const loadsBefore = process.env.ARK_FAKE_LOAD_ONE;
  afterEach(() => withLoad(loadsBefore));

  test("ARK-T694 holds on a load above the limit with one line and an unstarted ticket, then starts on the next fresh reading at the limit", async () => {
    withLoad("12.5");
    const { budget, lines, line } = openBudget();
    try {
      let resolved = false;
      const taking = budget.take(1).then((taken) => ((resolved = true), taken));
      await line("waiting for load");
      await Bun.sleep(heldMilliseconds);
      expect(resolved).toBe(false);
      expect(lines.filter((entry) => entry.includes("waiting for load"))).toEqual([
        loadLine("12.5", 10),
      ]);
      expect(ticketsOf()).toHaveLength(1);
      expect(ticketsOf()[0]).not.toHaveProperty("started");

      withLoad("10"); // at the limit
      const taken = await taking;
      expect(taken.cores).toBe(1);
      expect(ticketsOf()[0]).toMatchObject({
        cores: 1,
        started: expect.any(String),
      });
      expect(lines.filter((entry) => entry.includes("waiting for load"))).toHaveLength(1);
      taken.release();
    } finally {
      budget.close();
    }
  });

  macOnly(
    "ARK-T694 prints a load line and a memory line once each, and a recovered load does not release a memory hold",
    async () => {
      setFakeHost({ freePercent: 15, swapGigabytes: 2 }); // under the 20 percent floor
      withLoad("12.5");
      const { budget, lines, line } = openBudget({ memory: true });
      try {
        let resolved = false;
        const taking = budget.take(1).then((taken) => ((resolved = true), taken));
        await line("waiting for load");
        await line("waiting for memory");
        expect(lines.filter((entry) => entry.includes("waiting for load"))).toHaveLength(1);
        expect(lines.filter((entry) => entry.includes("waiting for memory"))).toHaveLength(1);

        withLoad("3"); // only memory holds now
        await Bun.sleep(heldMilliseconds);
        expect(resolved, "a recovered load released a memory hold").toBe(false);
        expect(lines.filter((entry) => entry.includes("waiting for load"))).toHaveLength(1);
        expect(lines.filter((entry) => entry.includes("waiting for memory"))).toHaveLength(1);

        setFakeHost(healthyHost);
        (await taking).release();
        expect(lines.filter((entry) => entry.startsWith("ark test: waiting"))).toHaveLength(2);
      } finally {
        budget.close();
      }
    },
  );

  test("ARK-T694 starts a held ticket when the load reading becomes unreadable, with no further hold line", async () => {
    withLoad("12.5");
    const { budget, lines, line } = openBudget();
    try {
      const taking = budget.take(1);
      await line("waiting for load");
      withLoad("unreadable");
      (await taking).release();
      expect(lines.filter((entry) => entry.startsWith("ark test: waiting"))).toEqual([
        loadLine("12.5", 10),
      ]);
    } finally {
      budget.close();
    }
  });
});
