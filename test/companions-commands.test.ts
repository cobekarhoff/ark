// ARK-521: `ark run start` and `ark evaluation record` wake the live companions of their own event
// (ARK-T731), never fail on a wake they cannot send (ARK-T732), and make no Orca call without a
// companion (ARK-T733). Every test runs the real `ark` process on a temporary ARK_HOME against the
// fake orca and gh of test/fake-companion-tools.ts, with the test clock (ARK_NOW).
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLive, writeTicket } from "./helpers.ts";
import { runDirectoryOf } from "./hub-fixtures.ts";
import type { FakeCompanionTools } from "./fake-companion-tools.ts";
import {
  appendRaw,
  arkP,
  dispatchOf,
  entry,
  openMergeRequestRun,
  project,
  readCursor,
  runId,
  scenario,
  useCompanionTestEnvironment,
} from "./companions-fixtures.ts";

// A sync or a command starts the fake orca (a bun process) several times, and a hung call lasts seconds.
setDefaultTimeout(90_000);
useCompanionTestEnvironment();

const arkScript = join(import.meta.dir, "..", "cli", "ark.ts");

type Finished = { code: number; out: string; err: string };
type Started = Finished & { run: string };

// ------------------------------------------------------------------ helpers

/** `ark run start` for the ticket `ARK-<number>`; `run` is its stdout, the id Master Chief reads. */
function startRun(ticketNumber: number, title = `Ticket ${ticketNumber}`, kind?: string): Started {
  const file = writeTicket(
    project,
    `ARK-${ticketNumber}`,
    [{ id: "AC1", text: "It works.", method: kind === undefined ? "test" : "inspection" }],
    title,
    kind,
  );
  const result = arkP("run", "start", file);
  return { ...result, run: result.out.trim() };
}

/** Writes evaluation.md with these blockers into the run folder and runs `ark evaluation record`. */
function recordEvaluation(run: string, blockers: string[], argument = run): Finished {
  const list = blockers.map((blocker) => `- ${blocker}`).join("\n");
  writeFileSync(
    join(runDirectoryOf(project, run), "evaluation.md"),
    `## Blockers\n${list}\n\n## Risks\n\n## Surfaces\n- none\n`,
  );
  return arkP("evaluation", "record", argument);
}

const blockerLine = (count: number): string =>
  `recorded evaluation: ${count} blocker${count === 1 ? "" : "s"}, 0 risks, surfaces none\n`;

/** The subjects of the wake messages delivered to the live worker of `name`, in delivery order. */
const subjectsTo = (fake: FakeCompanionTools, folder: string, name: string): string[] =>
  fake
    .sent()
    .filter((message) => message.to === `dispatch:${dispatchOf(folder, name)}`)
    .map((message) => message.subject);

const wakeSubject = (trigger: string, run: string): string => `Companion wake: ${trigger} ${run}`;

/** The `wake.log` of `name` as `<trigger> <run>` lines. */
function wakeLogOf(folder: string, name: string): string[] {
  const file = join(folder, "companions", name, "wake.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const entry = JSON.parse(line) as { trigger: string; run: string };
      return `${entry.trigger} ${entry.run}`;
    });
}

/** The number of events in the log of a run: the seq of its last event. */
const lastSeqOf = (run: string): number =>
  readFileSync(join(runDirectoryOf(project, run), "events.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean).length;

const linesOf = (result: Finished): string[] => result.err.split("\n").filter(Boolean);

/** The one stderr line of a wake that was not sent: `companion <name>: wake <trigger> for <run> not sent: <reason>`. */
const notSent = (name: string, trigger: string, run: string, reason = ".+"): RegExp =>
  new RegExp(
    `^companion ${name}: wake ${trigger.replace(".", "\\.")} for ${run} not sent: ${reason}$`,
  );

/** A sync that works, with nothing on stderr. */
function sync(): Finished {
  const result = arkP("companions", "sync");
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  return result;
}

/** The commands changed no worker: Master Chief's Run kept every worker it had. */
function expectNoWorkerChange(fake: FakeCompanionTools): void {
  for (const verb of ["worker-start", "worker-stop", "worker-release"])
    expect(fake.verbs(), verb).not.toContain(verb);
}

const countOf = (fake: FakeCompanionTools, verb: string): number =>
  fake.verbs().filter((name) => name === verb).length;

/** `ark run start` and then `ark evaluation record` keep their event and their output, whatever the wake did. */
function expectKept(start: Started, record: Finished, ticketNumber: number): void {
  expect(start.code).toBe(0);
  expect(start.out).toBe(`${start.run}\n`);
  expect(record.code).toBe(0);
  expect(record.out).toBe(blockerLine(1));
  const events = readFileSync(
    join(runDirectoryOf(project, start.run), "events.ndjson"),
    "utf8",
  ).split("\n");
  expect(events.some((line) => line.includes('"run.started"'))).toBe(true);
  expect(events.some((line) => line.includes('"evaluation.recorded"'))).toBe(true);
  const ticket = readFileSync(
    join(process.env.ARK_HOME as string, "projects", project, "tickets", `ARK-${ticketNumber}.md`),
    "utf8",
  );
  expect(ticket).toContain("status: in_progress");
  for (const result of [start, record]) expect(result.err).not.toContain("ark: ");
}

const bothTriggers = ["run.started", "criteria.opened"];

/** Companions `alpha` and `beta`, both listing both triggers, each with a live worker and a cursor from one sync. */
function pairOfCompanions() {
  const setup = scenario([entry("alpha", bothTriggers), entry("beta", bothTriggers)]);
  sync();
  setup.fake.clearCalls();
  return setup;
}

/** Removes every cause of a failed wake from the fake. */
const heal = (fake: FakeCompanionTools): void =>
  fake.configure({ failAll: false, failVerbs: [], failSendTo: [], hangVerbs: [] });

/**
 * Runs `body` with the limits of production: an empty ARK_ORCA_TIMEOUT_MS, which `orcaTimeout` reads
 * as unset (the wake bounds each Orca call at 3 s) and which the helper's 60 s default does not
 * replace, and the 2 s reader limit that `ark` has when ARK_READER_TIMEOUT_MS is unset (the test
 * helper sets 30 s).
 */
function withProductionLimits(body: () => void): void {
  const saved = [process.env.ARK_ORCA_TIMEOUT_MS, process.env.ARK_READER_TIMEOUT_MS];
  process.env.ARK_ORCA_TIMEOUT_MS = "";
  process.env.ARK_READER_TIMEOUT_MS = "2000";
  try {
    body();
  } finally {
    for (const [name, value] of [
      ["ARK_ORCA_TIMEOUT_MS", saved[0]],
      ["ARK_READER_TIMEOUT_MS", saved[1]],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// ------------------------------------------------------------------ ARK-T731

const oldRun = runId(700);

/**
 * `starter` (run.started, criteria.opened, ci.failed), `merger` (run.merged, escalation) and `late`
 * (run.started), after one sync, with an old open run `oldRun` whose failed check is in the cursor of
 * `starter`. `late` has a live worker and, as if its first sync had died, no cursor.json.
 */
function startersAndMerger() {
  const setup = scenario([
    entry("starter", ["run.started", "criteria.opened", "ci.failed"]),
    entry("merger", ["run.merged", "escalation"]),
    entry("late", ["run.started"]),
  ]);
  openMergeRequestRun(oldRun, setup.workspace);
  setup.fake.setCi("fail", ["unit"]);
  sync();
  rmSync(join(setup.folder, "companions", "late", "cursor.json"));
  expect(readCursor(setup.folder, "starter").ci).toEqual([`${oldRun}#7#unit`]);
  setup.fake.clearCalls();
  return setup;
}

const wakeBody = (trigger: string, run: string, ticket: string): string =>
  [`trigger: ${trigger}`, `run: ${run}`, `ticket: ${ticket}`].join("\n");

test("ARK-T731 ark run start and ark evaluation record with blockers wake each live subscribed companion with the message, wake.log line and cursor of a sync, and the next sync sends nothing twice", () => {
  const { folder, fake } = startersAndMerger();
  const starterTarget = `dispatch:${dispatchOf(folder, "starter")}`;
  const ciKeys = readCursor(folder, "starter").ci;

  // Step 1: ark run start. stdout is the run id alone; one message, to the one subscribed live companion.
  const first = startRun(701, "Start one");
  expect(first.run).toBe(runId(701));
  expect(first.out).toBe(`${runId(701)}\n`);
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  const k1 = first.run;
  expect(fake.sent().map((message) => message.to)).toEqual([starterTarget]);
  expect(fake.sent()[0].subject).toBe(wakeSubject("run.started", k1));
  expect(fake.sent()[0].body).toBe(wakeBody("run.started", k1, "ARK-701 Start one"));
  expect(wakeLogOf(folder, "starter")).toEqual([`run.started ${k1}`]);
  expect(wakeLogOf(folder, "merger")).toEqual([]);
  expect(readCursor(folder, "starter").runs[k1].seq).toBe(lastSeqOf(k1));
  // The first-sync rule: `late` has no cursor, so it hears nothing and gets no cursor from the command.
  expect(existsSync(join(folder, "companions", "late", "cursor.json"))).toBe(false);
  // The run-only wake reads no CI, starts and stops nothing, and leaves the CI part of the cursor.
  expect(fake.ghCalls()).toEqual([]);
  expectNoWorkerChange(fake);
  expect(readCursor(folder, "starter").ci).toEqual(ciKeys);
  // The sync that follows sends nothing new: one message and one wake.log line in all. Its first
  // sync of `late` starts it at the present, with no wake.
  sync();
  expect(fake.sent()).toHaveLength(1);
  expect(wakeLogOf(folder, "starter")).toEqual([`run.started ${k1}`]);
  expect(existsSync(join(folder, "companions", "late", "cursor.json"))).toBe(true);
  expect(readCursor(folder, "starter").ci).toEqual(ciKeys);

  // Step 2: ark evaluation record with two blockers.
  const evaluated = recordEvaluation(k1, ["blocker one", "blocker two"]);
  expect(evaluated.out).toBe(blockerLine(2));
  expect(evaluated.err).toBe("");
  expect(evaluated.code).toBe(0);
  expect(subjectsTo(fake, folder, "starter")).toEqual([
    wakeSubject("run.started", k1),
    wakeSubject("criteria.opened", k1),
  ]);
  expect(fake.sent()[1].body).toBe(wakeBody("criteria.opened", k1, "ARK-701 Start one"));
  expect(subjectsTo(fake, folder, "merger")).toEqual([]);
  expect(subjectsTo(fake, folder, "late")).toEqual([]);
  expect(wakeLogOf(folder, "starter")).toEqual([`run.started ${k1}`, `criteria.opened ${k1}`]);
  expect(readCursor(folder, "starter").runs[k1].seq).toBe(lastSeqOf(k1));
  sync();
  expect(fake.sent()).toHaveLength(2);
  expect(wakeLogOf(folder, "starter")).toHaveLength(2);

  // Step 3: a new run, then an evaluation with no blocker: no criteria.opened message for it.
  const second = startRun(702, "Start two");
  expect(second.err).toBe("");
  const k2 = second.run;
  const clear = recordEvaluation(k2, []);
  expect(clear.out).toBe(blockerLine(0));
  expect(clear.err).toBe("");
  expect(clear.code).toBe(0);
  expect(subjectsTo(fake, folder, "starter")).toEqual([
    wakeSubject("run.started", k1),
    wakeSubject("criteria.opened", k1),
    wakeSubject("run.started", k2),
  ]);
  // `late` has a cursor since the sync above, so it hears of the start.
  expect(subjectsTo(fake, folder, "late")).toEqual([wakeSubject("run.started", k2)]);
  // The event without a wake moved the cursor, so a sync sends nothing for it either.
  expect(readCursor(folder, "starter").runs[k2].seq).toBe(lastSeqOf(k2));
  sync();
  expect(fake.sent()).toHaveLength(4);

  // Step 4: a second evaluation with blockers wakes once more, as a sync would.
  const again = recordEvaluation(k1, ["blocker three"]);
  expect(again.code).toBe(0);
  expect(subjectsTo(fake, folder, "starter").slice(3)).toEqual([
    wakeSubject("criteria.opened", k1),
  ]);
  sync();
  expect(fake.sent()).toHaveLength(5);
  expect(wakeLogOf(folder, "starter")).toHaveLength(4);
  // No wake of the older run: its failed check was already in the cursor.
  expect(subjectsTo(fake, folder, "starter").join("\n")).not.toContain(oldRun);
});

test("ARK-T731 ark evaluation record with the run id and a trailing slash wakes under the bare run name: no second run.started, one criteria.opened, nothing twice at the next sync", () => {
  const { folder, fake } = startersAndMerger();
  const k1 = startRun(701, "Start one").run;
  expect(subjectsTo(fake, folder, "starter")).toEqual([wakeSubject("run.started", k1)]);

  const evaluated = recordEvaluation(k1, ["blocker one"], `${k1}/`);
  expect(evaluated.code).toBe(0);
  expect(evaluated.err).toBe("");
  expect(subjectsTo(fake, folder, "starter")).toEqual([
    wakeSubject("run.started", k1),
    wakeSubject("criteria.opened", k1),
  ]);
  sync();
  expect(subjectsTo(fake, folder, "starter")).toHaveLength(2);
  expect(
    Object.keys(readCursor(folder, "starter").runs).filter((name) => name.includes(k1)),
  ).toEqual([k1]);
});

/** Starts a process by `bun cli/ark.ts`, the way a second terminal would, and waits for it. */
async function finishArk(args: string[]): Promise<Finished> {
  const child = Bun.spawn(["bun", arkScript, ...args, "--project", project], {
    env: { ARK_READER_TIMEOUT_MS: "30000", ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out, err };
}

test("ARK-T731 race: ark run start beside a loop of ark companions sync wakes each new run exactly once", async () => {
  const { folder, fake } = scenario([entry("starter", ["run.started"])]);
  sync();
  const anotherSync =
    /^companion starter: wake run\.started for \S+ not sent: another sync is running$/;
  let starting = true;
  const syncs: Finished[] = [];
  const syncLoop = (async () => {
    while (starting) syncs.push(await finishArk(["companions", "sync"]));
  })();
  const runs: string[] = [];
  try {
    for (const ticketNumber of [711, 712, 713, 714, 715]) {
      const file = writeTicket(project, `ARK-${ticketNumber}`, [
        { id: "AC1", text: "It works.", method: "test" },
      ]);
      const result = await finishArk(["run", "start", file]);
      expect(result.code).toBe(0);
      expect(result.out).toBe(`${runId(ticketNumber)}\n`);
      // A lock held by the sync is the one line the command may print.
      for (const line of result.err.split("\n").filter(Boolean)) expect(line).toMatch(anotherSync);
      runs.push(result.out.trim());
    }
  } finally {
    // The loop must end before the next test changes ARK_HOME under it.
    starting = false;
    await syncLoop;
  }
  // A sync that met the lock of a command refuses with one `ark: ` line; any other failure is a defect.
  for (const result of syncs) {
    if (result.code === 0) continue;
    expect(result.err.trim().split("\n")).toHaveLength(1);
    expect(result.err).toMatch(/^ark: .*another sync is running/);
  }
  sync();
  for (const run of runs)
    expect(
      subjectsTo(fake, folder, "starter").filter((subject) => subject.endsWith(` ${run}`)),
    ).toEqual([wakeSubject("run.started", run)]);
  expect(wakeLogOf(folder, "starter").toSorted()).toEqual(
    runs.map((run) => `run.started ${run}`).toSorted(),
  );
});

// ------------------------------------------------------------------ ARK-T732

test("ARK-T732 a send that fails for one companion prints one not-sent line for it on stderr, keeps the command and its event, and the next sync sends it in order", () => {
  const { folder, fake } = pairOfCompanions();
  fake.configure({ failSendTo: [`dispatch:${dispatchOf(folder, "alpha")}`] });
  const start = startRun(801);
  const record = recordEvaluation(start.run, ["blocker"]);
  const run = start.run;
  expectKept(start, record, 801);
  // One line for alpha only. The evaluation names the older run.started: the run's unseen events go in order.
  expect(linesOf(start)).toHaveLength(1);
  expect(linesOf(start)[0]).toMatch(notSent("alpha", "run.started", run, ".*send refused.*"));
  expect(linesOf(record)).toHaveLength(1);
  expect(linesOf(record)[0]).toMatch(notSent("alpha", "run.started", run, ".*send refused.*"));
  expect(subjectsTo(fake, folder, "beta")).toEqual([
    wakeSubject("run.started", run),
    wakeSubject("criteria.opened", run),
  ]);
  expect(subjectsTo(fake, folder, "alpha")).toEqual([]);
  expect(readCursor(folder, "alpha").runs[run]).toBeUndefined();
  expectNoWorkerChange(fake);
  heal(fake);
  sync();
  expect(subjectsTo(fake, folder, "alpha")).toEqual([
    wakeSubject("run.started", run),
    wakeSubject("criteria.opened", run),
  ]);
  expect(subjectsTo(fake, folder, "beta")).toHaveLength(2);
});

test("ARK-T732 a send that fails for both companions prints one line for each, from each command, and the next sync sends each of them both wakes once", () => {
  const { folder, fake } = pairOfCompanions();
  fake.configure({
    failSendTo: ["alpha", "beta"].map((name) => `dispatch:${dispatchOf(folder, name)}`),
  });
  const start = startRun(802);
  const record = recordEvaluation(start.run, ["blocker"]);
  const run = start.run;
  expectKept(start, record, 802);
  for (const result of [start, record]) {
    expect(linesOf(result)).toHaveLength(2);
    expect(linesOf(result)[0]).toMatch(notSent("alpha", "run.started", run));
    expect(linesOf(result)[1]).toMatch(notSent("beta", "run.started", run));
  }
  expect(fake.sent()).toEqual([]);
  expectNoWorkerChange(fake);
  heal(fake);
  sync();
  for (const name of ["alpha", "beta"])
    expect(subjectsTo(fake, folder, name)).toEqual([
      wakeSubject("run.started", run),
      wakeSubject("criteria.opened", run),
    ]);
});

test("ARK-T732 an Orca read that fails prints one line for each companion naming the call, sends nothing and moves no cursor, and the next sync sends both wakes", () => {
  for (const verb of ["run-list", "worker-list"]) {
    const { folder, fake } = pairOfCompanions();
    fake.configure({ failVerbs: [verb] });
    const start = startRun(803);
    const record = recordEvaluation(start.run, ["blocker"]);
    const run = start.run;
    expectKept(start, record, 803);
    for (const result of [start, record]) {
      expect(linesOf(result), verb).toHaveLength(2);
      expect(linesOf(result)[0]).toMatch(
        notSent("alpha", "run.started", run, `orca orchestration ${verb} failed: .+`),
      );
      expect(linesOf(result)[1]).toMatch(
        notSent("beta", "run.started", run, `orca orchestration ${verb} failed: .+`),
      );
    }
    expect(fake.verbs(), verb).not.toContain("send");
    expectNoWorkerChange(fake);
    for (const name of ["alpha", "beta"])
      expect(readCursor(folder, name).runs[run]).toBeUndefined();
    heal(fake);
    sync();
    for (const name of ["alpha", "beta"])
      expect(subjectsTo(fake, folder, name), verb).toEqual([
        wakeSubject("run.started", run),
        wakeSubject("criteria.opened", run),
      ]);
  }
});

test("ARK-T732 a hung send returns after the bound of the command, without waiting for the call or repeating it, and the next sync sends the wakes", () => {
  withProductionLimits(() => {
    const { folder, fake } = pairOfCompanions();
    fake.configure({ hangVerbs: ["send"] });
    const start = startRun(804);
    expect(fake.hungDone()).toEqual([]);
    const record = recordEvaluation(start.run, ["blocker"]);
    expect(fake.hungDone()).toEqual([]);
    const run = start.run;
    expectKept(start, record, 804);
    for (const result of [start, record]) {
      expect(linesOf(result)).toHaveLength(2);
      expect(linesOf(result)[0]).toMatch(
        notSent("alpha", "run.started", run, "timed out after .+"),
      );
      expect(linesOf(result)[1]).toMatch(notSent("beta", "run.started", run, "timed out after .+"));
    }
    // One send for each companion for each command, and one worker-list for each command.
    expect(countOf(fake, "send")).toBe(4);
    expect(countOf(fake, "worker-list")).toBe(2);
    expect(fake.sent()).toEqual([]);
    expectNoWorkerChange(fake);
    heal(fake);
    sync();
    for (const name of ["alpha", "beta"])
      expect(subjectsTo(fake, folder, name)).toEqual([
        wakeSubject("run.started", run),
        wakeSubject("criteria.opened", run),
      ]);
  });
});

test("ARK-T732 a hung worker-list returns after the bound of the command, with a line for each companion and no send, and the next sync sends the wakes", () => {
  withProductionLimits(() => {
    const { folder, fake } = pairOfCompanions();
    fake.configure({ hangVerbs: ["worker-list"] });
    const start = startRun(805);
    expect(fake.hungDone()).toEqual([]);
    const record = recordEvaluation(start.run, ["blocker"]);
    expect(fake.hungDone()).toEqual([]);
    const run = start.run;
    expectKept(start, record, 805);
    for (const result of [start, record]) {
      expect(linesOf(result)).toHaveLength(2);
      const reason = "orca orchestration worker-list failed: timed out after .+";
      expect(linesOf(result)[0]).toMatch(notSent("alpha", "run.started", run, reason));
      expect(linesOf(result)[1]).toMatch(notSent("beta", "run.started", run, reason));
    }
    expect(countOf(fake, "worker-list")).toBe(2);
    expect(fake.verbs()).not.toContain("send");
    expectNoWorkerChange(fake);
    heal(fake);
    sync();
    for (const name of ["alpha", "beta"])
      expect(subjectsTo(fake, folder, name)).toEqual([
        wakeSubject("run.started", run),
        wakeSubject("criteria.opened", run),
      ]);
  });
});

test("ARK-T732 a hung terminal list is swallowed as in a sync: the wake is sent with no sender, nothing is printed and the command does not wait for the call", () => {
  withProductionLimits(() => {
    const { folder, fake } = pairOfCompanions();
    fake.configure({ hangVerbs: ["terminal list"] });
    const start = startRun(806);
    expect(fake.hungDone()).toEqual([]);
    const record = recordEvaluation(start.run, ["blocker"]);
    expect(fake.hungDone()).toEqual([]);
    const run = start.run;
    expectKept(start, record, 806);
    expect(start.err).toBe("");
    expect(record.err).toBe("");
    expect(fake.sent().map((message) => message.from)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    for (const name of ["alpha", "beta"])
      expect(subjectsTo(fake, folder, name)).toEqual([
        wakeSubject("run.started", run),
        wakeSubject("criteria.opened", run),
      ]);
    heal(fake);
    sync();
    expect(fake.sent()).toHaveLength(4);
  });
});

test("ARK-T732 a failed terminal list alone is no error of the wake: it is sent as a sync sends it, with no sender and nothing printed", () => {
  const { folder, fake } = pairOfCompanions();
  fake.configure({ failVerbs: ["terminal list"] });
  const start = startRun(807);
  const record = recordEvaluation(start.run, ["blocker"]);
  expectKept(start, record, 807);
  expect(start.err).toBe("");
  expect(record.err).toBe("");
  expect(fake.sent().every((message) => message.from === undefined)).toBe(true);
  expect(subjectsTo(fake, folder, "alpha")).toEqual([
    wakeSubject("run.started", start.run),
    wakeSubject("criteria.opened", start.run),
  ]);
});

test("ARK-T732 a companion whose worker is gone gets a no-live-worker line and no worker, a companion never synced gets nothing, and only the sync starts workers", () => {
  const { folder, fake, save } = pairOfCompanions();
  save([
    entry("alpha", bothTriggers),
    entry("beta", bothTriggers),
    entry("gamma", ["run.started"]),
  ]);
  const betaWorker = readFileSync(join(folder, "companions", "beta", "worker.json"), "utf8");
  rmSync(
    join(process.env.FAKE_COMPANION_DIR as string, "workers", `${dispatchOf(folder, "beta")}.json`),
  );
  const start = startRun(808);
  const record = recordEvaluation(start.run, ["blocker"]);
  const run = start.run;
  expectKept(start, record, 808);
  for (const result of [start, record]) {
    expect(linesOf(result)).toHaveLength(1);
    expect(linesOf(result)[0]).toMatch(notSent("beta", "run.started", run, "no live worker"));
  }
  expect(subjectsTo(fake, folder, "alpha")).toEqual([
    wakeSubject("run.started", run),
    wakeSubject("criteria.opened", run),
  ]);
  expect(fake.sent()).toHaveLength(2);
  // gamma was never synced: no line, no message, and the command writes no file for it.
  expect(existsSync(join(folder, "companions", "gamma", "worker.json"))).toBe(false);
  expect(existsSync(join(folder, "companions", "gamma", "cursor.json"))).toBe(false);
  expectNoWorkerChange(fake);
  expect(readFileSync(join(folder, "companions", "beta", "worker.json"), "utf8")).toBe(betaWorker);
  // The sync starts the workers of beta and gamma, and wakes beta of both events.
  sync();
  expect(fake.started().map((worker) => worker.title)).toEqual([
    "Companion: beta",
    "Companion: gamma",
  ]);
  expect(subjectsTo(fake, folder, "beta")).toEqual([
    wakeSubject("run.started", run),
    wakeSubject("criteria.opened", run),
  ]);
  expect(subjectsTo(fake, folder, "gamma")).toEqual([]);
  expect(subjectsTo(fake, folder, "alpha")).toHaveLength(2);
});

test("ARK-T732 a companion lock that a live process holds prints one line without waiting, leaves the lock and cursor, and the next sync sends the wakes", async () => {
  const { folder, fake } = pairOfCompanions();
  const lock = join(folder, "companions", "alpha", "sync.lock");
  const holder = Bun.spawn(["sleep", "600"]);
  let run = "";
  try {
    writeFileSync(lock, String(holder.pid));
    const start = startRun(809);
    const record = recordEvaluation(start.run, ["blocker"]);
    run = start.run;
    expectKept(start, record, 809);
    for (const result of [start, record]) {
      expect(linesOf(result)).toHaveLength(1);
      expect(linesOf(result)[0]).toMatch(
        notSent("alpha", "run.started", run, "another sync is running"),
      );
    }
    // The commands came back while the holder lives, and touched neither its lock nor the cursor.
    expect(isLive(holder.pid)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(String(holder.pid));
    expect(readCursor(folder, "alpha").runs[run]).toBeUndefined();
    expect(subjectsTo(fake, folder, "alpha")).toEqual([]);
    expect(subjectsTo(fake, folder, "beta")).toEqual([
      wakeSubject("run.started", run),
      wakeSubject("criteria.opened", run),
    ]);
  } finally {
    holder.kill();
    await holder.exited;
  }
  sync();
  expect(subjectsTo(fake, folder, "alpha")).toEqual([
    wakeSubject("run.started", run),
    wakeSubject("criteria.opened", run),
  ]);
});

test("ARK-T732 a wake that failed earlier is not lost behind the command's own: the line names the older escalation and the sync sends both in event order", () => {
  const { folder, fake } = scenario([entry("both", ["escalation", "criteria.opened"])]);
  sync();
  const start = startRun(810);
  const run = start.run;
  expect(start.err).toBe("");
  const startedSeq = lastSeqOf(run);
  expect(readCursor(folder, "both").runs[run].seq).toBe(startedSeq);
  appendRaw(run, "escalation.requested", { reason: "stuck" });
  fake.configure({ failSendOnce: true });
  const record = recordEvaluation(run, ["blocker"]);
  expect(record.code).toBe(0);
  expect(record.out).toBe(blockerLine(1));
  expect(linesOf(record)).toHaveLength(1);
  expect(linesOf(record)[0]).toMatch(notSent("both", "escalation", run, ".*send failed once.*"));
  expect(readCursor(folder, "both").runs[run].seq).toBe(startedSeq);
  expect(fake.sent()).toEqual([]);
  sync();
  expect(subjectsTo(fake, folder, "both")).toEqual([
    wakeSubject("escalation", run),
    wakeSubject("criteria.opened", run),
  ]);
});

test("ARK-T732 the kind warning of ark run start stays before the not-sent line, the exit is 0 and stdout is still the run id", () => {
  const { folder, fake } = pairOfCompanions();
  fake.configure({ failSendTo: [`dispatch:${dispatchOf(folder, "alpha")}`] });
  const start = startRun(811, "Bug ticket", "bug");
  expect(start.code).toBe(0);
  expect(start.out).toBe(`${runId(811)}\n`);
  const lines = linesOf(start);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe(
    "warning: kind bug has no method: test AC, so its red-test or base-pass rule does not apply",
  );
  expect(lines[1]).toMatch(notSent("alpha", "run.started", start.run, ".*send refused.*"));
});

// ------------------------------------------------------------------ ARK-T733

test("ARK-T733 ark run start and ark evaluation record in a project with no companions make no Orca call and print what they printed before, also when only a worker.json of a removed companion is left", () => {
  // State 1: no `companions` key, no folder.
  const first = scenario(undefined);
  first.fake.clearCalls();
  const start = startRun(901);
  expect(start.out).toBe(`${runId(901)}\n`);
  expect(start.err).toBe("");
  expect(start.code).toBe(0);
  const withBlockers = recordEvaluation(start.run, ["blocker"]);
  const withoutBlockers = recordEvaluation(start.run, []);
  expect(withBlockers.out).toBe(blockerLine(1));
  expect(withoutBlockers.out).toBe(blockerLine(0));
  for (const result of [withBlockers, withoutBlockers]) {
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
  }
  expect(first.fake.calls()).toEqual([]);

  // State 2: the companion `gone` was synced, then removed from ark.yml; its worker.json and live row stay.
  const second = scenario([entry("gone", ["run.started", "criteria.opened"])]);
  sync();
  const dispatch = dispatchOf(second.folder, "gone");
  const record = readFileSync(join(second.folder, "companions", "gone", "worker.json"), "utf8");
  second.save(undefined);
  second.fake.clearCalls();
  const again = startRun(902);
  expect(again.out).toBe(`${runId(902)}\n`);
  expect(again.err).toBe("");
  expect(again.code).toBe(0);
  const evaluated = recordEvaluation(again.run, ["blocker"]);
  expect(evaluated.out).toBe(blockerLine(1));
  expect(evaluated.err).toBe("");
  expect(evaluated.code).toBe(0);
  expect(second.fake.calls()).toEqual([]);
  expect(second.fake.live()).toEqual([dispatch]);
  expect(readFileSync(join(second.folder, "companions", "gone", "worker.json"), "utf8")).toBe(
    record,
  );
});
