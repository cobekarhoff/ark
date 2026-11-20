import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  watch,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { budgetHeldVariable, readTestLock } from "../cli/test-lock.ts";
import { macOnly, recordStartedRun, stopStartedRuns } from "./orphan-runners.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-513: a whole-suite `bun test` outside `ark test` waits for the shared test budget. Every case starts a real
// `bun test` in a scratch repo that loads the repo's own preload, against a real holder process and the real ticket
// store of a temp ARK_HOME. No sleeps: each wait is a line of output, a marker file, a pipe closing or an exit.
setDefaultTimeout(90_000);
afterEach(stopStartedRuns);

const repositoryRoot = resolve(import.meta.dir, "..");
const preload = join(repositoryRoot, "test", "tmpdir-preload.ts");
const lockModule = join(repositoryRoot, "cli", "test-lock.ts");
const arkEntry = join(repositoryRoot, "cli", "ark.ts");
const waitingLine = "waiting for the test budget";
const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

const started: { pid: number; group: boolean }[] = [];
afterEach(() => {
  // Only processes this file started, by pid; a detached `bun test` leads its own group with its workers.
  for (const { pid, group } of started.splice(0))
    try {
      process.kill(group ? -pid : pid, "SIGKILL");
    } catch {
      // already gone
    }
});

// Descriptors that a case holds open on a named pipe so that a file blocks reading it; closed when the case ends.
const heldDescriptors: number[] = [];
afterEach(() => {
  for (const descriptor of heldDescriptors.splice(0))
    try {
      closeSync(descriptor);
    } catch {
      // already closed
    }
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
    for await (const chunk of stream) this.feed(decoder.decode(chunk, { stream: true }));
  }

  feed(text: string): void {
    this.text += text;
    for (const watcher of this.#watchers.filter((entry) => this.text.includes(entry.needle)))
      watcher.done();
  }

  until(needle: string, limit: WaitLimit): Promise<void> {
    const { promise, resolve: done } = Promise.withResolvers<void>();
    if (this.text.includes(needle)) done();
    else this.#watchers.push({ needle, done });
    return bounded(promise, limit);
  }

  count(needle: string): number {
    return this.text.split(needle).length - 1;
  }
}

/** A time limit for one wait, and the name that its error carries when the limit passes (ARK-527). */
interface WaitLimit {
  within: number;
  name: string;
}

/** Resolves when `ready()` holds, re-checked on every change of `directory`; rejects with the name of `limit` after its time. */
function waitFor(directory: string, ready: () => boolean, limit: WaitLimit): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  const check = () => {
    if (ready()) done();
  };
  const watcher = watch(directory, check);
  check();
  return bounded(promise, limit).finally(() => watcher.close());
}

/**
 * Every wait carries a time limit and a name: a wait that never ends rejects with `no <name> within <ms> ms`. The
 * timer is the real deadline of a wait on a real process, not a pause.
 */
function bounded<T>(promise: Promise<T>, { within, name }: WaitLimit): Promise<T> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const deadline = AbortSignal.timeout(within);
  deadline.addEventListener("abort", () => reject(new Error(`no ${name} within ${within} ms`)));
  return Promise.race([promise, expired]);
}

/** The exit of a child and then the end of its output, each with the roomy limit. Resolves to the exit code. */
async function finish(run: {
  child: { exited: Promise<number> };
  output: Output;
}): Promise<number> {
  const code = await bounded(run.child.exited, { within: passLimit, name: "exit of the child" });
  await bounded(run.output.done, { within: passLimit, name: "end of the output" });
  return code;
}

// ARK-527 rows: a wait that must pass gets a roomy limit (a failure guard on a loaded 4-core runner, not a speed
// assertion); the wait that a row proves fails gets a short one. A row asserts that the failing wait rejects with its
// name, and that it did so far below the 90 s test timeout.
const passLimit = 20_000;
const failLimit = 500;
const rowTimeout = 60_000;
const rejectionCeiling = 5_000;
const waitingLineLimit: WaitLimit = { within: passLimit, name: "waiting line" };

async function expectNamedRejection(wait: () => Promise<unknown>, name: RegExp): Promise<void> {
  const startedAt = performance.now();
  const error = await wait().then(
    () => new Error("the wait resolved"),
    (caught: unknown) => caught,
  );
  expect(String((error as Error)?.message)).toMatch(name);
  expect(performance.now() - startedAt).toBeLessThan(rejectionCeiling);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The environment of a child `bun test`: this process's, minus what would change its behavior (the marker of
 * `ark test`, which makes it never wait; the worker variables, which make a serial child read the command line of its
 * parent; ARK_PROJECT and ARK_HOME), then only what the case names. A key set to undefined stays unset.
 */
function environment(
  home: string | null,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...process.env };
  for (const name of [budgetHeldVariable, "BUN_TEST_WORKER_ID", "JEST_WORKER_ID", "ARK_PROJECT"])
    delete merged[name];
  delete merged.ARK_HOME;
  if (home !== null) merged.ARK_HOME = home;
  // ARK-586: a CPU of 0, so the one waiting line of a case is the budget line on a busy host; a case that tests the CPU sets its own.
  merged.ARK_FAKE_CPU_PERCENT = "0";
  Object.assign(merged, extra);
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
}

/** A real process that holds `cores` of the 3-core budget of `home` until it is released. */
async function startHolder(home: string, cores: number) {
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { openTestBudget } from ${JSON.stringify(lockModule)};
const budget = openTestBudget("holder", 3, { print: () => {} });
await budget.take(${cores});
console.log("held");
await new Promise((done) => process.stdin.once("data", done));
budget.close();
process.exit(0);`,
    ],
    { env: environment(home), stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  started.push({ pid: holder.pid, group: false });
  await new Output(holder.stdout).until("held", {
    within: passLimit,
    name: "ticket of the holder",
  });
  return {
    pid: holder.pid,
    release: async () => {
      void holder.stdin.write("x");
      void holder.stdin.flush();
      await bounded(holder.exited, { within: passLimit, name: "exit of the holder" });
    },
  };
}

const header = (markers: string) =>
  `import { test } from "bun:test";
import { appendFileSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const markers = ${JSON.stringify(markers)};
`;

type Variant = "stuck-before-marker" | "stuck-after-marker" | "leak";

/** The files of the fake suite that open an `alive-<name>` pipe, `gate` last: `stuck` replaces `a`, `leak` has none. */
const aliveNames = (variant?: Variant): string[] =>
  variant === "leak"
    ? ["a", "b", "gate"]
    : variant
      ? ["stuck", "b", "c", "gate"]
      : ["a", "b", "c", "gate"];

/**
 * The fake suite: `a`, `b`, `c` and `gate`. Each opens the write end of `alive-<name>` (a pipe, when the case made
 * it) and keeps it until its worker ends. A `variant` replaces one file: `stuck` replaces `a` and blocks reading a
 * named pipe that the case holds open (it writes `ran-stuck` before or after it blocks), `leak` replaces `c` and
 * leaves a detached `sleep` that holds the output of the run. `gate` also blocks on the pipe `hang`, when the case
 * made one. `preload: false` leaves out the `bunfig.toml` preload.
 */
function suiteFiles(
  markers: string,
  options: { failing?: boolean; variant?: Variant; preload?: boolean; probe?: boolean } = {},
): Record<string, string> {
  const files: Record<string, string> = {};
  if (options.preload !== false)
    files["bunfig.toml"] = `[test]\npreload = [${JSON.stringify(preload)}]\n`;
  for (const name of aliveNames(options.variant).filter((entry) => entry !== "gate"))
    files[`test/${name}.test.ts`] =
      name === "stuck"
        ? `${header(markers)}test("FAKE-1-AC1 stuck", () => {
  openSync(join(markers, "alive-stuck"), "w");
  ${options.variant === "stuck-after-marker" ? 'appendFileSync(join(markers, "ran-stuck"), process.pid + "\\n");' : ""}
  readFileSync(openSync(join(import.meta.dir, "..", "stuck"), "r"));
});
`
        : `${header(markers)}test("FAKE-1-AC1 ${name}", () => {
  openSync(join(markers, "alive-${name}"), "w");
  appendFileSync(join(markers, "ran-${name}"), process.pid + "\\n");
  appendFileSync(join(markers, "runs.log"), process.cwd() + " ${name}\\n");
});
`;
  if (options.variant === "leak")
    files["test/leak.test.ts"] = `${header(markers)}test("FAKE-1-AC1 leak", () => {
  const child = Bun.spawn(["sleep", "600"], { stdout: "inherit", stderr: "inherit", stdin: "ignore", detached: true });
  child.unref();
  appendFileSync(join(markers, "leak-pid"), String(child.pid));
});
`;
  files["test/gate.test.ts"] = `${header(markers)}test("FAKE-1-AC1 gate", () => {
  openSync(join(markers, "alive-gate"), "w");
  const gate = join(import.meta.dir, "..", "gate");
  const pipe = existsSync(gate) && statSync(gate).isFIFO() ? openSync(gate, "r") : null;
  appendFileSync(join(markers, "started-gate"), process.pid + " " + process.cwd() + "\\n");
  appendFileSync(join(markers, "runs.log"), process.cwd() + " gate\\n");
  if (pipe !== null) readFileSync(pipe);
  appendFileSync(join(markers, "ran-gate"), process.pid + "\\n");
  const hang = join(import.meta.dir, "..", "hang");
  if (existsSync(hang) && statSync(hang).isFIFO()) readFileSync(openSync(hang, "r"));
});
`;
  if (options.probe)
    files["test/probe.test.ts"] = `${header(markers)}test("FAKE-1-AC1 probe", () => {
  appendFileSync(join(markers, "marker-value"), (process.env.${budgetHeldVariable} ?? "unset") + "\\n");
});
`;
  if (options.failing)
    files["test/failing.test.ts"] = `import { expect, test } from "bun:test";
test("FAKE-1-AC1 failing", () => { expect(1).toBe(2); });
`;
  return files;
}

interface Fixture {
  home: string;
  directory: string;
  markers: string;
  ended: Record<string, Promise<number>>;
  markerLines: (name: string) => string[];
  pidOf: (name: string) => number;
  ran: () => string[];
  storeDirectory: () => string;
  openGate: () => void;
}

/**
 * A temp ARK_HOME with project `demo` (budget 3 cores) and a scratch folder with the fake suite: the project
 * `workspace` itself, or (`worktree`) a run worktree under `runs/`, where the project is not found by `workspace`.
 * `pipes` makes the `alive-*` pipes, each read by a `cat` that ends when the worker that holds it ends.
 */
function makeFixture(
  options: {
    where?: "workspace" | "worktree" | "elsewhere";
    pipes?: boolean;
    budget?: number | null;
    failing?: boolean;
    variant?: Variant;
    preload?: boolean;
    /** Adds a file `probe` that records the marker value its worker sees. */
    probe?: boolean;
    /** Named pipes in the scratch folder (`stuck`, `hang`) that the case holds open and never writes. */
    blockers?: string[];
  } = {},
): Fixture {
  const home = tempArkHome();
  const workspace = realpathSync(tempGitRepo());
  const markers = realpathSync(mkdtempSync(join(tmpdir(), "bare-markers-")));
  const directory =
    options.where === "worktree"
      ? join(home, "projects", "demo", "runs", "2026-11-15-FAKE-1-1", "workspace")
      : options.where === "elsewhere"
        ? realpathSync(mkdtempSync(join(tmpdir(), "bare-elsewhere-")))
        : workspace;
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(suiteFiles(markers, options))) {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), content);
  }
  for (const name of options.blockers ?? []) {
    Bun.spawnSync(["mkfifo", join(directory, name)]);
    heldDescriptors.push(openSync(join(directory, name), constants.O_RDWR));
  }
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    ...(options.budget === null ? {} : { test_budget_cores: options.budget ?? 3 }),
    suites: [{ name: "cli", level: "e2e", repo: ".", command: "true {report}", parser: "bun" }],
    roles,
  });
  const gate = join(directory, "gate");
  let gateDescriptor = -1;
  const ended: Record<string, Promise<number>> = {};
  if (options.pipes) {
    for (const name of aliveNames(options.variant)) {
      const pipe = join(markers, `alive-${name}`);
      Bun.spawnSync(["mkfifo", pipe]);
      const reader = Bun.spawn(["cat", pipe], { stdout: "ignore" });
      started.push({ pid: reader.pid, group: false });
      ended[name] = reader.exited;
    }
    Bun.spawnSync(["mkfifo", gate]);
    // A reader that opens a pipe before any writer stays blocked if a writer opens and closes first (macOS). The case
    // holds a read-write descriptor, so the reader never blocks on open and sees the end of file on close.
    gateDescriptor = openSync(gate, constants.O_RDWR);
  }
  // A marker line counts only when complete: `appendFileSync` creates the file, then writes, so a file can exist empty.
  const markerLines = (name: string): string[] =>
    existsSync(join(markers, name))
      ? readFileSync(join(markers, name), "utf8")
          .split("\n")
          .filter((line) => line !== "")
      : [];
  return {
    home,
    directory,
    markers,
    ended,
    markerLines,
    /** The pid in the marker of a file. */
    pidOf: (name: string) => Number(markerLines(name)[0]!.split(" ")[0]),
    /** Markers of test files that ran or started. */
    ran: () => readdirSync(markers).filter((name) => /^(ran-|started-)/.test(name)),
    storeDirectory: () => join(home, "test-budget"),
    /** Ends the `gate` file: the case holds the write end of its pipe open from the start and closes it here. */
    openGate: () => closeSync(gateDescriptor),
  };
}

function bunTest(directory: string, args: readonly string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "test", ...args], {
    cwd: directory,
    env,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  started.push({ pid: child.pid, group: true });
  return { child, output: new Output(child.stdout, child.stderr) };
}

/** The `ark chief state` text of the temp ARK_HOME, the reader that the run lead greps. */
const chiefState = (): string => ark("chief", "state", "--project", "demo").out;

/** The ticket files that a bare run wrote: the owner files of the store (a holder's ticket is not one). */
const ownerTicketFiles = (fixture: Fixture): string[] =>
  existsSync(fixture.storeDirectory())
    ? readdirSync(fixture.storeDirectory()).filter((name) => name.endsWith("-owner.json"))
    : [];

/** Resolves when a bare run has written its ticket, which is the point where the run waits or holds. */
const bareTicketWritten = (
  fixture: Fixture,
  limit: WaitLimit = { within: passLimit, name: "ticket of the bare run" },
) => waitFor(fixture.storeDirectory(), () => ownerTicketFiles(fixture).length > 0, limit);

const cpuCores = Math.min(availableParallelism(), 3);

test.each([
  { title: "bun test --parallel=3", args: ["--parallel=3"], asks: 3, parallel: true },
  { title: "bun test (serial, asks 1 core)", args: [], asks: 1, parallel: false },
  { title: "bun test test --parallel=3", args: ["test", "--parallel=3"], asks: 3, parallel: true },
  { title: "bun test --parallel", args: ["--parallel"], asks: cpuCores, parallel: true },
  {
    title: "bun test --parallel=3 in a run worktree found by its path",
    args: ["--parallel=3"],
    asks: 3,
    parallel: true,
    where: "worktree" as const,
  },
  {
    title: "bun test --parallel=3 in a run worktree found by ARK_PROJECT",
    args: ["--parallel=3"],
    asks: 3,
    parallel: true,
    where: "worktree" as const,
    project: "demo",
  },
])(
  "ARK-T683 $title waits while the budget is full, holds one ticket labeled bun test until its last file ends, and starts only after the release",
  async ({ args, asks, parallel, where, project }) => {
    const fixture = makeFixture({ where, pipes: true });
    const holder = await startHolder(fixture.home, 3);
    const run = bunTest(
      fixture.directory,
      args,
      environment(fixture.home, { ARK_PROJECT: project }),
    );
    // A serial run prints live. A --parallel worker's output reaches the pipe when its file ends, so there the
    // wait is read from the ticket store.
    if (parallel) await bareTicketWritten(fixture);
    else await run.output.until(waitingLine, waitingLineLimit);

    expect(fixture.ran()).toEqual([]);
    expect(run.child.exitCode).toBeNull();
    expect(readTestLock().waiting).toMatchObject([
      { run: "bun test", pid: run.child.pid, cores: asks },
    ]);
    expect(chiefState()).toContain(`- waiting: bun test (pid ${run.child.pid}), ${asks} cores`);

    await holder.release();
    await waitForMarkers(fixture, ["started-gate"]);
    if (parallel) {
      await waitForMarkers(fixture, ["ran-a", "ran-b", "ran-c"]);
      // A worker that ran another file than `gate` has ended while `gate` still runs: the ticket stays.
      for (const name of ["a", "b", "c"])
        if (fixture.pidOf(`ran-${name}`) !== fixture.pidOf("started-gate"))
          await bounded(fixture.ended[name]!, { within: passLimit, name: `end of alive-${name}` });
    }
    expect(readTestLock().running).toMatchObject([
      { run: "bun test", pid: run.child.pid, cores: asks },
    ]);
    expect(alive(run.child.pid)).toBe(true);
    expect(chiefState()).toContain(`- running: bun test (pid ${run.child.pid}), ${asks} cores`);

    fixture.openGate();
    expect(await finish(run)).toBe(0);
    // One claimant prints, once: a test of the bare run spends time between the ticket and the release.
    expect(run.output.count(waitingLine)).toBe(1);
    for (const name of ["a", "b", "c", "gate"])
      expect(fixture.markerLines(`ran-${name}`)).toHaveLength(1);
    expect(readTestLock()).toEqual({ running: [], waiting: [] });
    expect(chiefState()).not.toContain("bun test (pid");
  },
);

test("ARK-T683 a bun test whose cores fit the budget starts at once and prints no waiting line", async () => {
  const fixture = makeFixture({ pipes: true });
  const holder = await startHolder(fixture.home, 1);
  const run = bunTest(fixture.directory, ["--parallel=2"], environment(fixture.home));
  await waitForMarkers(fixture, ["started-gate"]);
  fixture.openGate();
  expect(await finish(run)).toBe(0);
  expect(run.output.text).not.toContain(waitingLine);
  for (const name of ["a", "b", "c", "gate"])
    expect(fixture.markerLines(`ran-${name}`)).toHaveLength(1);
  await holder.release();
});

// A person at a terminal sees the line of a --parallel run live: the creator worker writes it to /dev/tty.
macOnly(
  "ARK-T683 under a terminal a --parallel run shows its waiting line while it waits",
  async () => {
    const fixture = makeFixture({ pipes: true });
    const holder = await startHolder(fixture.home, 3);
    const output = new Output();
    // A terminal of its own: a --parallel worker opens /dev/tty, so the line shows while the run waits.
    const run = Bun.spawn([process.execPath, "test", "--parallel=3"], {
      cwd: fixture.directory,
      env: environment(fixture.home),
      terminal: {
        cols: 120,
        rows: 24,
        data: (_terminal: unknown, data: Uint8Array) => output.feed(new TextDecoder().decode(data)),
      },
    });
    started.push({ pid: run.pid, group: false });
    await output.until(waitingLine, waitingLineLimit);
    expect(fixture.ran()).toEqual([]);

    await holder.release();
    await waitForMarkers(fixture, ["started-gate"]);
    fixture.openGate();
    expect(await bounded(run.exited, { within: passLimit, name: "exit of the child" })).toBe(0);
    expect(output.count(waitingLine)).toBe(1);
  },
);

const waitForMarkers = async (fixture: Fixture, names: string[], within = passLimit) => {
  for (const name of names)
    await waitFor(fixture.markers, () => fixture.markerLines(name).length > 0, { within, name });
};

// ARK-527: each row reaches one wait that its held inner run never satisfies, and asserts that this wait rejects with
// its name inside its own short limit. Every wait the row passes first carries a roomy limit.
test(
  "ARK-T683 11a a stuck file that never writes its marker fails the wait for the marker inside its limit",
  async () => {
    const fixture = makeFixture({ variant: "stuck-before-marker", blockers: ["stuck"] });
    const holder = await startHolder(fixture.home, 3);
    bunTest(fixture.directory, ["--parallel=3"], environment(fixture.home));
    await bareTicketWritten(fixture, { within: passLimit, name: "ticket of the bare run" });
    await holder.release();
    await waitForMarkers(fixture, ["started-gate", "ran-b", "ran-c"]);
    await expectNamedRejection(
      () => waitForMarkers(fixture, ["ran-stuck"], failLimit),
      /ran-stuck/,
    );
  },
  rowTimeout,
);

test(
  "ARK-T683 11b a worker blocked in its file fails the wait for the end of its pipe inside its limit",
  async () => {
    const fixture = makeFixture({
      variant: "stuck-after-marker",
      pipes: true,
      blockers: ["stuck"],
    });
    const holder = await startHolder(fixture.home, 3);
    bunTest(fixture.directory, ["--parallel=3"], environment(fixture.home));
    await bareTicketWritten(fixture, { within: passLimit, name: "ticket of the bare run" });
    await holder.release();
    await waitForMarkers(fixture, ["started-gate", "ran-b", "ran-c", "ran-stuck"]);
    await expectNamedRejection(
      () => bounded(fixture.ended.stuck!, { within: failLimit, name: "end of alive-stuck" }),
      /alive-stuck/,
    );
  },
  rowTimeout,
);

test(
  "ARK-T683 11c a run with no preload fails the wait for the waiting line inside its limit",
  async () => {
    const fixture = makeFixture({ preload: false });
    await startHolder(fixture.home, 3);
    const run = bunTest(fixture.directory, [], environment(fixture.home));
    await expectNamedRejection(
      () => run.output.until(waitingLine, { within: failLimit, name: "waiting line" }),
      /waiting line/,
    );
  },
  rowTimeout,
);

test(
  "ARK-T683 11d a file that blocks after the release fails the wait for the exit of the child inside its limit",
  async () => {
    const fixture = makeFixture({ pipes: true, blockers: ["hang"] });
    const holder = await startHolder(fixture.home, 3);
    const run = bunTest(fixture.directory, [], environment(fixture.home));
    await run.output.until(waitingLine, { within: passLimit, name: "waiting line" });
    await holder.release();
    await waitForMarkers(fixture, ["started-gate"]);
    fixture.openGate();
    await expectNamedRejection(
      () => bounded(run.child.exited, { within: failLimit, name: "exit of the child" }),
      /exit of the child/,
    );
  },
  rowTimeout,
);

test(
  "ARK-T683 11e a process that holds the output fails the wait for the end of the output inside its limit",
  async () => {
    const fixture = makeFixture({ variant: "leak", pipes: true });
    const holder = await startHolder(fixture.home, 3);
    const run = bunTest(fixture.directory, [], environment(fixture.home));
    await run.output.until(waitingLine, { within: passLimit, name: "waiting line" });
    await holder.release();
    await waitForMarkers(fixture, ["started-gate"]);
    fixture.openGate();
    expect(await bounded(run.child.exited, { within: passLimit, name: "exit of the child" })).toBe(
      0,
    );
    started.push({ pid: Number(fixture.markerLines("leak-pid")[0]), group: false });
    await expectNamedRejection(
      () => bounded(run.output.done, { within: failLimit, name: "end of the output" }),
      /end of the output/,
    );
  },
  rowTimeout,
);

// ARK-T695. A bare run takes the CPU rule of `ark test`: it waits on CPU use over 90 percent only while a suite runs,
// and the 1-minute load never holds it.
const cpuWaiting = "waiting for CPU";
const cpuLineLimit: WaitLimit = { within: passLimit, name: "CPU line" };

test("ARK-T695 a --parallel bun test waits on CPU use over 90 percent while a suite runs, runs no file, starts when that suite ends, and prints one CPU line", async () => {
  const fixture = makeFixture();
  const holder = await startHolder(fixture.home, 1);
  // A --parallel worker opens /dev/tty, so its CPU line shows on a terminal of its own while the run waits. The line
  // is printed only after a sample found the CPU above the limit: it is the event that the hold was read, so the
  // release below never comes before the hold.
  const output = new Output();
  const run = Bun.spawn([process.execPath, "test", "--parallel=2"], {
    cwd: fixture.directory,
    env: environment(fixture.home, { ARK_FAKE_CPU_PERCENT: "95", ARK_FAKE_LOAD_ONE: "0" }),
    terminal: {
      cols: 120,
      rows: 24,
      data: (_terminal: unknown, data: Uint8Array) => output.feed(new TextDecoder().decode(data)),
    },
  });
  started.push({ pid: run.pid, group: true });
  await output.until(cpuWaiting, cpuLineLimit);
  expect(fixture.ran()).toEqual([]);
  expect(run.exitCode).toBeNull();
  expect(readTestLock().waiting).toMatchObject([{ run: "bun test", pid: run.pid, cores: 2 }]);
  expect(chiefState()).toContain(`- waiting: bun test (pid ${run.pid}), 2 cores`);

  // The suite that ran ends: nothing runs, so the same reading no longer holds.
  await holder.release();
  expect(await bounded(run.exited, { within: passLimit, name: "exit of the child" })).toBe(0);
  for (const name of ["a", "b", "c", "gate"])
    expect(fixture.markerLines(`ran-${name}`)).toHaveLength(1);
  expect(output.count(cpuWaiting)).toBe(1); // one for the run, not one for each worker or file
  expect(output.count("waiting for memory")).toBe(0);
});

test("ARK-T695 a serial bun test waits on CPU use over 90 percent while a suite runs, runs no file, prints one CPU line, and wears the bun test prefix", async () => {
  const fixture = makeFixture();
  await startHolder(fixture.home, 1);
  const run = bunTest(
    fixture.directory,
    [],
    environment(fixture.home, { ARK_FAKE_CPU_PERCENT: "95", ARK_FAKE_LOAD_ONE: "0" }),
  );
  await run.output.until(cpuWaiting, cpuLineLimit);
  expect(fixture.ran()).toEqual([]);
  process.kill(-run.child.pid, "SIGKILL"); // the detached run and its workers, by the pid this case started
  await finish(run);
  const lines = run.output.text.split("\n").filter((line) => line.includes(cpuWaiting));
  expect(lines).toHaveLength(1);
  expect(lines[0]!.startsWith("bun test: ")).toBe(true);
  expect(lines[0]).toMatch(/\b95(\.0)?\b.*\b90\b/);
  expect(run.output.text).not.toContain("1-minute load");
  expect(run.output.text).not.toContain("waiting for memory");
});

test.each([
  { title: "CPU 5 percent and a load of 30 while a suite runs", cpu: "5", holder: true },
  { title: "CPU 99 percent and a load of 30 with no suite running", cpu: "99", holder: false },
])(
  "ARK-T695 a --parallel bun test runs every file and prints no waiting line at $title",
  async ({ cpu, holder }) => {
    const fixture = makeFixture();
    if (holder) await startHolder(fixture.home, 1);
    const run = bunTest(
      fixture.directory,
      ["--parallel=2"],
      environment(fixture.home, { ARK_FAKE_CPU_PERCENT: cpu, ARK_FAKE_LOAD_ONE: "30" }),
    );
    expect(await finish(run), run.output.text).toBe(0);
    expect(run.output.text).not.toContain("waiting for");
    for (const name of ["a", "b", "c", "gate"])
      expect(fixture.markerLines(`ran-${name}`)).toHaveLength(1);
  },
);

test("ARK-T695 a file run and an ark test child start at once on CPU use over 90 percent while a suite runs", async () => {
  const fixture = makeFixture();
  await startHolder(fixture.home, 1);
  const hot = { ARK_FAKE_CPU_PERCENT: "95", ARK_FAKE_LOAD_ONE: "0" };
  const fileRun = bunTest(fixture.directory, ["test/a.test.ts"], environment(fixture.home, hot));
  expect(await finish(fileRun), fileRun.output.text).toBe(0);
  expect(fileRun.output.text).not.toContain(cpuWaiting);
  expect(fixture.markerLines("ran-a")).toHaveLength(1);

  // The marker an `ark test` child carries: the pid of a live run that holds a started ticket (here a 1-core holder).
  const holder = await startHolder(fixture.home, 1);
  const child = bunTest(
    fixture.directory,
    ["test", "--parallel=3"],
    environment(fixture.home, { ...hot, [budgetHeldVariable]: String(holder.pid) }),
  );
  expect(await finish(child), child.output.text).toBe(0);
  expect(child.output.text).not.toContain(cpuWaiting);
  expect(ownerTicketFiles(fixture)).toEqual([]);
  await holder.release();
});

test.each([
  { title: "one file argument", args: ["test/a.test.ts"], ran: ["a"] },
  { title: "two file arguments", args: ["test/a.test.ts", "test/b.test.ts"], ran: ["a", "b"] },
])(
  "ARK-T684 bun test with $title starts at once while the budget is full",
  async ({ args, ran }) => {
    const fixture = makeFixture();
    const holder = await startHolder(fixture.home, 3);
    const run = bunTest(fixture.directory, args, environment(fixture.home));
    expect(await finish(run)).toBe(0);
    expect(run.output.text).not.toContain(waitingLine);
    for (const name of ran) expect(fixture.markerLines(`ran-${name}`)).toHaveLength(1);
    // The file of an ended pid stays until a reader prunes it, and no reader ran: a run that took a ticket shows here.
    expect(ownerTicketFiles(fixture)).toEqual([]);
    await holder.release();
  },
);

test("ARK-T684 a whole-suite bun test with no ark test marker waits behind the holder, the control of the runs that start at once", async () => {
  const fixture = makeFixture();
  const holder = await startHolder(fixture.home, 3);

  // The same command line as the runs of this case that start at once, with no marker, waits behind the holder.
  const linesBefore = fixture.markerLines("runs.log").length;
  const control = bunTest(fixture.directory, ["test", "--parallel=3"], environment(fixture.home));
  await bareTicketWritten(fixture);
  expect(fixture.markerLines("runs.log")).toHaveLength(linesBefore);
  expect(readTestLock().waiting).toMatchObject([{ run: "bun test", pid: control.child.pid }]);
  await holder.release();
  expect(await finish(control)).toBe(0);
  // The release may pass before the worker's first look at the tickets: then the cores are free, and no line is right.
  expect(control.output.count(waitingLine)).toBeLessThanOrEqual(1);
});

test(
  "ARK-T684 6 a bare run that never takes a ticket fails the wait for its ticket inside its limit",
  async () => {
    const fixture = makeFixture({ preload: false });
    await startHolder(fixture.home, 3);
    const control = bunTest(fixture.directory, ["test", "--parallel=3"], environment(fixture.home));
    expect(
      await bounded(control.child.exited, { within: passLimit, name: "exit of the child" }),
    ).toBe(0);
    await expectNamedRejection(
      () => bareTicketWritten(fixture, { within: failLimit, name: "ticket of the bare run" }),
      /ticket of the bare run/,
    );
    expect(ownerTicketFiles(fixture)).toEqual([]);
  },
  rowTimeout,
);

const wholeSuiteCommand =
  "bun test test --parallel=<cores> --reporter=junit --reporter-outfile={report}";

/** A started run of project `demo` whose cli suite runs `command` in a scratch repo, with `ark test` of it running. */
function startArkTest(command: string) {
  const home = tempArkHome();
  const markers = realpathSync(mkdtempSync(join(tmpdir(), "bare-markers-")));
  const workspace = tempGitRepo(suiteFiles(markers));
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    test_budget_cores: 3,
    test_min_free_memory_percent: 0,
    test_max_swap_gb: 1000,
    suites: [{ name: "cli", level: "e2e", repo: ".", cores: 3, command, parser: "bun" }],
    roles,
  });
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
        why: "Run a whole-suite command under ark test.",
        changes: [
          { criterion: "FAKE-1-AC1", where: "tests", now: "now", fix: "the suite proves it" },
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
          id: "proves-AC1",
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
  // The head suite is the only run with this pipe: base and census checkouts do not hold it.
  const worktree = realpathSync(join(runDirectory, "workspace"));
  Bun.spawnSync(["mkfifo", join(worktree, "gate")]);
  const gateDescriptor = openSync(join(worktree, "gate"), constants.O_RDWR);

  const caller = Bun.spawn([process.execPath, arkEntry, "test", runId, "--project", "demo"], {
    env: environment(home, { ARK_PROJECT: "demo" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  started.push({ pid: caller.pid, group: false });
  const output = new Output(caller.stdout, caller.stderr);
  const startedInWorktree = () =>
    existsSync(join(markers, "started-gate")) &&
    readFileSync(join(markers, "started-gate"), "utf8").includes(` ${worktree}\n`);
  return {
    runId,
    runDirectory,
    worktree,
    markers,
    gateDescriptor,
    caller,
    output,
    startedInWorktree,
  };
}

test("ARK-T684 ark test runs its whole-suite head suite, base run and census run with no second wait on its own cores", async () => {
  const {
    runId,
    runDirectory,
    worktree,
    markers,
    gateDescriptor,
    caller,
    output,
    startedInWorktree,
  } = startArkTest(wholeSuiteCommand);
  await waitFor(markers, startedInWorktree, {
    within: 30_000,
    name: "started-gate of the head worktree",
  });

  // The head suite runs: the store holds its ticket only, and no bare-run ticket.
  expect(readTestLock().running).toMatchObject([{ run: runId, cores: 3 }]);
  expect(readTestLock().waiting).toEqual([]);

  closeSync(gateDescriptor);
  const code = await bounded(caller.exited, { within: 50_000, name: "exit of ark test" });
  await bounded(output.done, { within: passLimit, name: "end of the output" });
  expect(code, output.text).toBe(0);
  expect(output.text).not.toContain(waitingLine);
  expect(readFileSync(join(runDirectory, "results", "cli.log"), "utf8")).not.toContain(waitingLine);
  expect(readTestLock()).toEqual({ running: [], waiting: [] });

  // The head ran its four files once. The base checkout ran the whole suite twice: the census and the base run.
  const runs = readFileSync(join(markers, "runs.log"), "utf8").trim().split("\n");
  expect(runs.filter((line) => line.startsWith(`${worktree} `))).toHaveLength(4);
  const baseRuns = runs.filter((line) => !line.startsWith(`${worktree} `));
  expect(baseRuns).toHaveLength(8);
  expect(new Set(baseRuns.map((line) => line.split(" ")[0])).size).toBe(1);
});

test("ARK-T684 7 an ark test head suite that never starts its gate file fails the wait for the start inside its limit", async () => {
  const { markers, startedInWorktree } = startArkTest(
    "bun test test/a.test.ts test/b.test.ts --parallel=<cores> --reporter=junit --reporter-outfile={report}",
  );
  // The head suite ran its files, so the missing `started-gate` is the file that `command` leaves out.
  await waitFor(markers, () => existsSync(join(markers, "ran-b")), {
    within: 20_000,
    name: "ran-b of the head suite",
  });
  await expectNamedRejection(
    () =>
      waitFor(markers, startedInWorktree, {
        within: failLimit,
        name: "started-gate of the head worktree",
      }),
    /started-gate/,
  );
}, 30_000);

test("ARK-T684 a whole-suite bun test that a test of a held bare run starts does not wait on the cores its parent holds", async () => {
  const home = tempArkHome();
  const markers = realpathSync(mkdtempSync(join(tmpdir(), "bare-markers-")));
  const workspace = realpathSync(tempGitRepo());
  const nested = realpathSync(mkdtempSync(join(tmpdir(), "bare-nested-")));
  writeFileSync(join(nested, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(preload)}]\n`);
  mkdirSync(join(nested, "test"));
  writeFileSync(
    join(nested, "test", "nested.test.ts"),
    `${header(markers)}test("FAKE-1-AC1 nested", () => { appendFileSync(join(markers, "nested-ran"), "x"); });\n`,
  );
  writeFileSync(join(workspace, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(preload)}]\n`);
  mkdirSync(join(workspace, "test"));
  writeFileSync(
    join(workspace, "test", "spawn.test.ts"),
    `${header(markers)}import { cpSync } from "node:fs";
test("FAKE-1-AC1 spawn", async () => {
  const child = Bun.spawn([process.execPath, "test", "--parallel=2"], { cwd: ${JSON.stringify(nested)}, stdout: "pipe", stderr: "pipe" });
  const text = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
  appendFileSync(join(markers, "nested-output"), text);
  appendFileSync(join(markers, "nested-code"), String(await child.exited));
  cpSync(join(process.env.ARK_HOME!, "test-budget"), join(markers, "store-after-nested"), { recursive: true });
});
`,
  );
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    test_budget_cores: 3,
    suites: [{ name: "cli", level: "e2e", repo: ".", command: "true {report}", parser: "bun" }],
    roles,
  });
  const run = bunTest(workspace, ["--parallel=3"], environment(home, { ARK_PROJECT: "demo" }));
  expect(await finish(run), run.output.text).toBe(0);
  expect(run.output.text).not.toContain(waitingLine);
  expect(readFileSync(join(markers, "nested-code"), "utf8")).toBe("0");
  expect(readFileSync(join(markers, "nested-output"), "utf8")).not.toContain(waitingLine);
  expect(readFileSync(join(markers, "nested-ran"), "utf8")).toBe("x");
  const tickets = readdirSync(join(markers, "store-after-nested")).filter((name) =>
    name.endsWith(".json"),
  );
  expect(tickets).toHaveLength(1);
  expect(
    JSON.parse(readFileSync(join(markers, "store-after-nested", tickets[0]!), "utf8")),
  ).toMatchObject({ run: "bun test", cores: 3 });
});

// The hook never refuses a run: a host it cannot read runs the suite at once, as the suite itself exits.
type FailOpenRow = {
  title: string;
  setup: (fixture: Fixture, home: string) => Record<string, string | undefined>;
  fixtureOptions?: Parameters<typeof makeFixture>[0];
  args?: string[];
};
const writeConfig = (text: string) =>
  writeFileSync(join(process.env.ARK_HOME!, "projects", "demo", "ark.yml"), text);
const psShim = (exitCode: number) => {
  const directory = mkdtempSync(join(tmpdir(), "bare-ps-"));
  writeFileSync(join(directory, "ps"), `#!/bin/sh\nexit ${exitCode}\n`);
  Bun.spawnSync(["chmod", "755", join(directory, "ps")]);
  return { PATH: `${directory}:${process.env.PATH}` };
};

test.each([
  {
    title: "no ARK_HOME and an empty HOME",
    setup: () => {
      const emptyHome = realpathSync(mkdtempSync(join(tmpdir(), "bare-home-")));
      return { ARK_HOME: undefined, HOME: emptyHome };
    },
  },
  {
    title: "no project that holds the folder",
    setup: () => ({}),
    fixtureOptions: { where: "elsewhere" as const },
  },
  { title: "an empty ark.yml", setup: () => (writeConfig(""), {}) },
  {
    title: "an ark.yml of invalid YAML",
    setup: () => (writeConfig("workspace: [unclosed\n  :"), {}),
  },
  {
    title: "test_budget_cores 0",
    setup: (fixture: Fixture) => (
      writeConfig(
        JSON.stringify({
          workspace: realpathSync(fixture.directory),
          ticket_source: "local",
          test_budget_cores: 0,
          suites: [
            { name: "cli", level: "e2e", repo: ".", command: "true {report}", parser: "bun" },
          ],
          roles,
        }),
      ),
      {}
    ),
  },
  {
    title: "an ARK_PROJECT that names no project",
    setup: () => ({ ARK_PROJECT: "no-such-project" }),
  },
  { title: "a ps that prints nothing and fails", setup: () => psShim(1) },
  { title: "a ps that prints nothing and succeeds", setup: () => psShim(0) },
] as FailOpenRow[])(
  "ARK-T685 a whole-suite bun test with $title runs at once and exits 0",
  async ({ setup, fixtureOptions }) => {
    const fixture = makeFixture(fixtureOptions);
    const holder = await startHolder(fixture.home, 3);
    const extra = setup(fixture, fixture.home);
    const noHome = "ARK_HOME" in extra && extra.ARK_HOME === undefined;
    const run = bunTest(
      fixture.directory,
      ["--parallel=3"],
      environment(noHome ? null : fixture.home, extra),
    );
    expect(await run.child.exited, run.output.text).toBe(0);
    await run.output.done;
    expect(run.output.text).not.toContain(waitingLine);
    for (const name of ["a", "b", "c", "gate"])
      expect(fixture.markerLines(`ran-${name}`)).toHaveLength(1);
    expect(ownerTicketFiles(fixture)).toEqual([]);
    if (noHome) expect(existsSync(join(extra.HOME!, ".ark"))).toBe(false);
    await holder.release();
  },
);

test("ARK-T685 a serial bun test of a project with no test_budget_cores runs at once on the default budget", async () => {
  const fixture = makeFixture({ budget: null });
  const run = bunTest(fixture.directory, [], environment(fixture.home));
  expect(await run.child.exited, run.output.text).toBe(0);
  await run.output.done;
  expect(run.output.text).not.toContain(waitingLine);
  for (const name of ["a", "b", "c", "gate"])
    expect(fixture.markerLines(`ran-${name}`)).toHaveLength(1);
});

test("ARK-T685 a failing test file fails the run with exit 1 and the failure text, and adds no failure of the hook", async () => {
  const fixture = makeFixture({ where: "elsewhere", failing: true });
  const run = bunTest(
    fixture.directory,
    ["--parallel=3"],
    environment(null, { HOME: fixture.markers }),
  );
  expect(await run.child.exited).toBe(1);
  await run.output.done;
  expect(run.output.text).toContain("FAKE-1-AC1 failing");
  expect(run.output.text).not.toContain(waitingLine);
  for (const name of ["a", "b", "c", "gate"])
    expect(fixture.markerLines(`ran-${name}`)).toHaveLength(1);
});

// ARK-T707. The marker an `ark test` run or a held bare run writes names that run; a whole-suite `bun test` skips the
// wait only while the named run is alive and holds a started ticket. The value is learned from a real held run, never
// copied from the source.

/** A scratch repo with the repo preload and one file `x` that records its pid in `ran-x` and, when `hold` is set, blocks on a pipe the case holds open. */
function makeProbeRepo(options: { hold?: boolean } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bare-probe-")));
  const markers = realpathSync(mkdtempSync(join(tmpdir(), "bare-probe-markers-")));
  writeFileSync(join(directory, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(preload)}]\n`);
  mkdirSync(join(directory, "test"));
  writeFileSync(
    join(directory, "test", "x.test.ts"),
    `${header(markers)}test("FAKE-1-AC1 x", () => {
  appendFileSync(join(markers, "ran-x"), process.pid + "\\n");
  const hold = join(import.meta.dir, "..", "hold");
  if (existsSync(hold) && statSync(hold).isFIFO()) readFileSync(openSync(hold, "r"));
});
`,
  );
  let holdDescriptor = -1;
  if (options.hold) {
    Bun.spawnSync(["mkfifo", join(directory, "hold")]);
    holdDescriptor = openSync(join(directory, "hold"), constants.O_RDWR);
    heldDescriptors.push(holdDescriptor);
  }
  return {
    directory,
    ranX: () => existsSync(join(markers, "ran-x")),
    started: (limit: WaitLimit) =>
      waitFor(markers, () => existsSync(join(markers, "ran-x")), limit),
    release: () => closeSync(holdDescriptor),
  };
}

/**
 * Resolves when a waiting ticket that `matches` is in the store; rejects when the run exits first, which means it
 * started at once instead of waiting.
 */
function waitsForBudget(
  fixture: Fixture,
  child: { exited: Promise<number> },
  matches: (ticket: { run: string; pid: number }) => boolean,
): Promise<void> {
  return Promise.race([
    waitFor(fixture.storeDirectory(), () => readTestLock().waiting.some(matches), {
      within: passLimit,
      name: "waiting ticket of the run",
    }),
    child.exited.then((code) => {
      throw new Error(`the run exited with ${code} instead of waiting for the budget`);
    }),
  ]);
}

test("ARK-T707 a whole-suite bun test starts at once under the marker of a live holder with a started ticket, and waits under any other marker value", async () => {
  const fixture = makeFixture({ pipes: true, probe: true });
  const holder = bunTest(fixture.directory, ["--parallel=3"], environment(fixture.home));
  await waitForMarkers(fixture, ["started-gate", "marker-value"]);
  const marker = fixture.markerLines("marker-value")[0]!;
  expect(readTestLock().running).toMatchObject([
    { run: "bun test", pid: holder.child.pid, cores: 3 },
  ]);
  expect(marker).toContain(String(holder.child.pid));

  const projectEnvironment = (value: string | undefined) =>
    environment(fixture.home, { ARK_PROJECT: "demo", [budgetHeldVariable]: value });

  // The marker of the live holder: the run starts at once, takes no ticket and prints no waiting line.
  const named = makeProbeRepo();
  const atOnce = bunTest(named.directory, ["test", "--parallel=3"], projectEnvironment(marker));
  expect(await finish(atOnce), atOnce.output.text).toBe(0);
  expect(atOnce.output.text).not.toContain(waitingLine);
  expect(named.ranX()).toBe(true);
  expect(ownerTicketFiles(fixture)).toHaveLength(1);

  // Every other value waits like a bare run: a waiting ticket, no file run.
  const reaped = Bun.spawn(["true"]);
  await reaped.exited;
  const noTicket = Bun.spawn(["sleep", "300"]);
  started.push({ pid: noTicket.pid, group: false });
  const holderPid = String(holder.child.pid);
  const rows: [string, string | undefined][] = [
    ["hand-set `held`", "held"],
    ["hand-set `1`", "1"],
    ["no marker", undefined],
    ["a dead pid", marker.replace(holderPid, String(reaped.pid))],
    ["a live pid with no ticket", marker.replace(holderPid, String(noTicket.pid))],
  ];
  for (const [name, value] of rows) {
    const repo = makeProbeRepo();
    const waiting = bunTest(repo.directory, ["test", "--parallel=3"], projectEnvironment(value));
    await waitsForBudget(
      fixture,
      waiting.child,
      (ticket) => ticket.pid === waiting.child.pid,
    ).catch((error: Error) => {
      throw new Error(`${name}: ${error.message}`);
    });
    expect(repo.ranX(), name).toBe(false);
    expect(waiting.output.count(waitingLine), name).toBeLessThanOrEqual(1);
    stopRun(waiting.child);
    await bounded(waiting.child.exited, { within: passLimit, name: "exit of the child" });
  }

  fixture.openGate();
  expect(await finish(holder), holder.output.text).toBe(0);
});

test("ARK-T707 a whole-suite bun test takes its own ticket under the marker of a run that has ended, and waits under it while a new holder holds the cores", async () => {
  const fixture = makeFixture({ pipes: true, probe: true });
  const first = bunTest(fixture.directory, ["--parallel=3"], environment(fixture.home));
  await waitForMarkers(fixture, ["started-gate", "marker-value"]);
  const marker = fixture.markerLines("marker-value")[0]!;
  fixture.openGate();
  expect(await finish(first), first.output.text).toBe(0);

  const projectEnvironment = environment(fixture.home, {
    ARK_PROJECT: "demo",
    [budgetHeldVariable]: marker,
  });
  // No holder now: the run takes the free cores through a ticket of its own, so the marker of the ended run is not what lets it start.
  const free = makeProbeRepo({ hold: true });
  const taking = bunTest(free.directory, ["test", "--parallel=3"], projectEnvironment);
  await free.started({
    within: passLimit,
    name: "start of the run under the marker of an ended run",
  });
  expect(readTestLock().running).toMatchObject([
    { run: "bun test", pid: taking.child.pid, cores: 3 },
  ]);
  free.release();
  expect(await finish(taking), taking.output.text).toBe(0);

  // A new holder holds all 3 cores; the marker still names the run that ended.
  const holder = await startHolder(fixture.home, 3);
  const blocked = makeProbeRepo();
  const waiting = bunTest(blocked.directory, ["test", "--parallel=3"], projectEnvironment);
  await waitsForBudget(fixture, waiting.child, (ticket) => ticket.pid === waiting.child.pid);
  expect(blocked.ranX()).toBe(false);
  stopRun(waiting.child);
  await bounded(waiting.child.exited, { within: passLimit, name: "exit of the child" });
  await holder.release();
});

test("ARK-T707 a whole-suite bun test that a test of a single-file run starts waits for the budget and starts once the holder releases", async () => {
  const fixture = makeFixture();
  const markers = realpathSync(mkdtempSync(join(tmpdir(), "bare-nested-markers-")));
  const nested = realpathSync(mkdtempSync(join(tmpdir(), "bare-nested-")));
  writeFileSync(join(nested, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(preload)}]\n`);
  mkdirSync(join(nested, "test"));
  writeFileSync(
    join(nested, "test", "nested.test.ts"),
    `${header(markers)}test("FAKE-1-AC1 nested", () => { appendFileSync(join(markers, "nested-ran"), "x"); });\n`,
  );
  writeFileSync(
    join(fixture.directory, "test", "spawn.test.ts"),
    `${header(markers)}test("FAKE-1-AC1 spawn", async () => {
  const child = Bun.spawn([process.execPath, "test", "--parallel=2"], { cwd: ${JSON.stringify(nested)}, stdout: "pipe", stderr: "pipe" });
  await new Response(child.stdout).text();
  appendFileSync(join(markers, "nested-code"), String(await child.exited));
});
`,
  );
  const holder = await startHolder(fixture.home, 3);
  const outer = bunTest(
    fixture.directory,
    ["test/spawn.test.ts"],
    environment(fixture.home, { ARK_PROJECT: "demo" }),
  );

  // The file run holds no cores, so the whole suite its test starts has to wait like a bare run.
  await waitsForBudget(
    fixture,
    outer.child,
    (ticket) => ticket.run === "bun test" && ticket.pid !== outer.child.pid,
  );
  expect(existsSync(join(markers, "nested-ran"))).toBe(false);
  expect(outer.child.exitCode).toBeNull();

  await holder.release();
  expect(await finish(outer), outer.output.text).toBe(0);
  expect(readFileSync(join(markers, "nested-ran"), "utf8")).toBe("x");
  expect(readFileSync(join(markers, "nested-code"), "utf8")).toBe("0");
});
