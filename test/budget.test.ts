import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openTestBudget, readTestLock, type TestBudget } from "../cli/test-lock.ts";
import { tempArkHome, tempGitRepo } from "./helpers.ts";

setDefaultTimeout(30_000);

// The real ticket store under a temp ARK_HOME. Every client is one `ark test` of one run; all of them live in this
// process, so their pids are alive. The wait loops run for real: the tests wait on the lines they print and on
// their own clock reads, never on a timer.
const configModule = resolve(import.meta.dir, "..", "cli", "config.ts");

const budgets: TestBudget[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

afterEach(() => {
  for (const budget of budgets.splice(0)) budget.close();
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

/** Same millisecond, same pid: arrival order would fall to a random file name. Wait for the next millisecond. */
function nextMillisecond(): void {
  const before = Date.now();
  while (Date.now() === before);
}

/** The lines a client printed, and a promise for the point where it has printed `count` of them. */
function lineSink() {
  const lines: string[] = [];
  const watchers: { count: number; done: () => void }[] = [];
  return {
    lines,
    print: (line: string) => {
      lines.push(line);
      for (const watcher of watchers.filter((entry) => entry.count <= lines.length)) watcher.done();
    },
    reached(count: number): Promise<void> {
      const { promise, resolve: done } = Promise.withResolvers<void>();
      watchers.push({ count, done });
      if (lines.length >= count) done();
      return promise;
    },
  };
}

describe("ark test budget admission", () => {
  test("ARK-T155 ark test admits a suite in arrival order when its cores fit the budget, and clamps a request above it", async () => {
    tempArkHome();
    // Each clock read is 31 s later, so the 30 s line window never hides a change: every change prints.
    let time = Date.now();
    const client = (run: string) => {
      const sink = lineSink();
      const budget = openTestBudget(run, 6, {
        now: () => (time += 31_000),
        print: sink.print,
      });
      budgets.push(budget);
      return { budget, sink };
    };
    const settled = (promise: Promise<unknown>) => {
      const state = { done: false };
      void promise.then(() => (state.done = true));
      return state;
    };
    const cores = () => readTestLock().running.map((ticket) => ticket.cores);

    // Two 3-core suites fit the 6-core budget together.
    const a = client("A");
    const b = client("B");
    const ticketA = await a.budget.take(3);
    nextMillisecond();
    const ticketB = await b.budget.take(3);
    expect([ticketA.cores, ticketB.cores]).toEqual([3, 3]);
    expect(cores()).toEqual([3, 3]);

    // An older 6-core request and a newer 1-core request wait.
    const w1 = client("W1");
    const w2 = client("W2");
    const grantW1 = w1.budget.take(6);
    nextMillisecond();
    const grantW2 = w2.budget.take(1);
    const w1Settled = settled(grantW1);
    const w2Settled = settled(grantW2);
    await Promise.all([w1.sink.reached(1), w2.sink.reached(1)]);
    expect(w1.sink.lines[0]).toContain("place 1 of 1; running: A 3 cores");
    expect(w2.sink.lines[0]).toContain("place 2 of 2; running: A 3 cores");

    // A's suite ends while A's ark test lives on: 3 cores are free and W2 fits, but it never overtakes W1.
    ticketA.release();
    await Promise.all([w1.sink.reached(2), w2.sink.reached(2)]);
    expect(w2.sink.lines[1]).toContain("place 2 of 2; running: B 3 cores");
    expect(w1Settled.done || w2Settled.done).toBe(false);
    expect(cores()).toEqual([3]);

    // B ends: W1 runs alone with the whole budget, then W2 with its one core.
    ticketB.release();
    const grantedW1 = await grantW1;
    expect(grantedW1.cores).toBe(6);
    expect(cores()).toEqual([6]);
    expect(w2Settled.done).toBe(false);
    grantedW1.release();
    expect((await grantW2).cores).toBe(1);
    expect(cores()).toEqual([1]);

    // A request with no cores takes the whole budget; one above the budget clamps to it and waits for idle.
    const whole = client("WHOLE");
    const above = client("ABOVE");
    (await grantW2).release();
    const grantedWhole = await whole.budget.take(undefined);
    expect(grantedWhole.cores).toBe(6);
    nextMillisecond();
    const grantAbove = above.budget.take(8);
    const aboveSettled = settled(grantAbove);
    await above.sink.reached(1);
    expect(aboveSettled.done).toBe(false);
    grantedWhole.release();
    expect((await grantAbove).cores).toBe(6);
  });

  test.each([
    [10, 6],
    [1, 1],
  ])(
    "ARK-T155 with no test_budget_cores on a %i-core host the budget is %i",
    async (hostCores, expected) => {
      const script = `import { mock } from "bun:test";
import * as os from "node:os";
mock.module("node:os", () => ({ ...os, cpus: () => Array(${hostCores}).fill({}) }));
const { validateConfig } = await import(${JSON.stringify(configModule)});
const roles = { implementer: { harness: "claude", model: "m" }, validator: { harness: "codex", model: "m" }, reviewer: { harness: "codex", model: "m" } };
const suite = { name: "s", level: "unit", repo: ".", command: "true", parser: "bun" };
console.log(validateConfig({ workspace: ${JSON.stringify(tempGitRepo())}, ticket_source: "local", suites: [suite], roles }, "ark.yml").test_budget_cores);`;
      const result = Bun.spawnSync(["bun", "-e", script]);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString().trim()).toBe(String(expected));
    },
  );

  test("ARK-T156 a waiting ark test prints its place and holders when they change, at most one line in 30 s by the injected clock", async () => {
    const home = tempArkHome();
    const ticketFile = (name: string) => join(home, "test-budget", `${name}.json`);
    const minute = 60_000;
    const start = Date.parse("2026-11-09T12:00:00.000Z");
    const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
    const sleeper = () => {
      const child = Bun.spawn(["sleep", "300"]);
      children.push(child);
      return child;
    };
    const holder = (name: string, pid: number, arrival: string, startedAt: number) =>
      writeFileSync(
        ticketFile(name),
        JSON.stringify({ run: name, pid, cores: 3, arrival, started: iso(startedAt) }),
      );
    const waiter = (name: string, pid: number, arrival: string) =>
      writeFileSync(ticketFile(name), JSON.stringify({ run: name, pid, cores: 3, arrival }));

    // A and B hold, W1 and W2 wait ahead of R (this run). The fake clock reads `seconds` after `start`.
    mkdirSync(join(home, "test-budget"), { recursive: true });
    const w1Process = sleeper();
    const w2Process = sleeper();
    holder("A", process.pid, "2020-01-01T00:00:01.000Z", start - 12 * minute);
    holder("B", process.pid, "2020-01-01T00:00:02.000Z", start - 4 * minute - 20_000);
    waiter("W1", w1Process.pid, "2020-01-01T00:00:03.000Z");
    waiter("W2", w2Process.pid, "2020-01-01T00:00:04.000Z");

    let seconds = 0;
    let reads = 0;
    const readWatchers: { count: number; done: () => void }[] = [];
    const sink = lineSink();
    const printedAt: number[] = [];
    const budget = openTestBudget("R", 6, {
      now: () => {
        reads += 1;
        for (const watcher of readWatchers.filter((entry) => entry.count <= reads)) watcher.done();
        return start + seconds * 1000;
      },
      print: (line) => {
        printedAt.push(seconds);
        sink.print(line);
      },
    });
    budgets.push(budget);
    /** One more full look of the wait loop at the store: the loop reads the clock once per look. */
    const nextLook = () => {
      const { promise, resolve: done } = Promise.withResolvers<void>();
      readWatchers.push({ count: reads + 1, done });
      return promise;
    };
    const advance = async (to: number) => {
      seconds = to;
      await nextLook();
    };

    const grant = budget.take(3);
    const granted = { done: false };
    void grant.then(() => (granted.done = true));

    await sink.reached(1);
    expect(sink.lines).toEqual([
      "waiting: place 3 of 3; running: A 3 cores 12 min, B 3 cores 4 min",
    ]);

    // 10 s: W1 is cancelled and R moves up, but the window is 30 s. 20 s: nothing changed.
    w1Process.kill("SIGKILL");
    await w1Process.exited;
    await advance(10);
    await advance(20);
    expect(sink.lines).toHaveLength(1);

    // 30 s: the window is open, and the line has the latest place.
    await advance(30);
    expect(sink.lines).toHaveLength(2);
    expect(sink.lines[1]).toBe("waiting: place 2 of 2; running: A 3 cores 12 min, B 3 cores 4 min");

    // 45 s: B's minutes tick from 4 to 5, which is no change.
    await advance(45);
    expect(sink.lines).toHaveLength(2);

    // 50 s: A ends and W2 is admitted; the change waits for the window. 60 s: the line shows it.
    rmSync(ticketFile("A"));
    holder("W2", w2Process.pid, "2020-01-01T00:00:04.000Z", start + 50_000);
    await advance(50);
    expect(sink.lines).toHaveLength(2);
    await advance(60);
    expect(sink.lines).toHaveLength(3);
    expect(sink.lines[2]).toBe(
      "waiting: place 1 of 1; running: B 3 cores 5 min, W2 3 cores <1 min",
    );

    // 90 s: B ends and R is admitted next to W2 with no further line.
    rmSync(ticketFile("B"));
    seconds = 90;
    expect((await grant).cores).toBe(3);
    expect(sink.lines).toHaveLength(3);
    expect(printedAt).toEqual([0, 30, 60]);
  });
});
