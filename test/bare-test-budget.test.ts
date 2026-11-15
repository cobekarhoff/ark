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

  until(needle: string): Promise<void> {
    const { promise, resolve: done } = Promise.withResolvers<void>();
    if (this.text.includes(needle)) done();
    else this.#watchers.push({ needle, done });
    return promise;
  }

  count(needle: string): number {
    return this.text.split(needle).length - 1;
  }
}

/** Resolves when `ready()` holds, re-checked on every change of `directory`. */
function waitFor(directory: string, ready: () => boolean): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  const check = () => {
    if (!ready()) return;
    watcher.close();
    done();
  };
  const watcher = watch(directory, check);
  check();
  return promise;
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
  await new Output(holder.stdout).until("held");
  return {
    release: async () => {
      void holder.stdin.write("x");
      void holder.stdin.flush();
      await holder.exited;
    },
  };
}

const header = (markers: string) =>
  `import { test } from "bun:test";
import { appendFileSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const markers = ${JSON.stringify(markers)};
`;

/** The fake suite: `a`, `b`, `c` and `gate`. Each opens the write end of `alive-<name>` (a pipe, when the case made it) and keeps it until its worker ends. */
function suiteFiles(markers: string, failing = false): Record<string, string> {
  const files: Record<string, string> = {
    "bunfig.toml": `[test]\npreload = [${JSON.stringify(preload)}]\n`,
  };
  for (const name of ["a", "b", "c"])
    files[`test/${name}.test.ts`] = `${header(markers)}test("FAKE-1-AC1 ${name}", () => {
  openSync(join(markers, "alive-${name}"), "w");
  appendFileSync(join(markers, "ran-${name}"), process.pid + "\\n");
  appendFileSync(join(markers, "runs.log"), process.cwd() + " ${name}\\n");
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
});
`;
  if (failing)
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
  for (const [name, content] of Object.entries(suiteFiles(markers, options.failing))) {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), content);
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
    for (const name of ["a", "b", "c", "gate"]) {
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
  const markerLines = (name: string): string[] =>
    existsSync(join(markers, name))
      ? readFileSync(join(markers, name), "utf8").trim().split("\n")
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

/** Resolves when a bare run has written its ticket, which is the point where the run waits or holds. */
const bareTicketWritten = (fixture: Fixture) =>
  waitFor(fixture.storeDirectory(), () =>
    readdirSync(fixture.storeDirectory()).some((name) => name.endsWith("-owner.json")),
  );

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
    else await run.output.until(waitingLine);

    expect(fixture.ran()).toEqual([]);
    expect(run.child.exitCode).toBeNull();
    expect(readTestLock().waiting).toMatchObject([
      { run: "bun test", pid: run.child.pid, cores: asks },
    ]);
    expect(chiefState()).toContain(`- waiting: bun test (pid ${run.child.pid}), ${asks} cores`);

    await holder.release();
    await waitFor(fixture.markers, () => fixture.markerLines("started-gate").length > 0);
    if (parallel) {
      for (const name of ["a", "b", "c"])
        await waitFor(fixture.markers, () => fixture.markerLines(`ran-${name}`).length > 0);
      // A worker that ran another file than `gate` has ended while `gate` still runs: the ticket stays.
      for (const name of ["a", "b", "c"])
        if (fixture.pidOf(`ran-${name}`) !== fixture.pidOf("started-gate"))
          await fixture.ended[name];
    }
    expect(readTestLock().running).toMatchObject([
      { run: "bun test", pid: run.child.pid, cores: asks },
    ]);
    expect(alive(run.child.pid)).toBe(true);
    expect(chiefState()).toContain(`- running: bun test (pid ${run.child.pid}), ${asks} cores`);

    fixture.openGate();
    expect(await run.child.exited).toBe(0);
    await run.output.done;
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
  await waitFor(fixture.markers, () => fixture.markerLines("started-gate").length > 0);
  fixture.openGate();
  expect(await run.child.exited).toBe(0);
  await run.output.done;
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
    await output.until(waitingLine);
    expect(fixture.ran()).toEqual([]);

    await holder.release();
    await waitFor(fixture.markers, () => fixture.markerLines("started-gate").length > 0);
    fixture.openGate();
    expect(await run.exited).toBe(0);
    expect(output.count(waitingLine)).toBe(1);
  },
);

test.each([
  { title: "one file argument", args: ["test/a.test.ts"], ran: ["a"] },
  { title: "two file arguments", args: ["test/a.test.ts", "test/b.test.ts"], ran: ["a", "b"] },
])(
  "ARK-T684 bun test with $title starts at once while the budget is full",
  async ({ args, ran }) => {
    const fixture = makeFixture();
    const holder = await startHolder(fixture.home, 3);
    const run = bunTest(fixture.directory, args, environment(fixture.home));
    expect(await run.child.exited).toBe(0);
    await run.output.done;
    expect(run.output.text).not.toContain(waitingLine);
    for (const name of ran) expect(fixture.markerLines(`ran-${name}`)).toHaveLength(1);
    expect(readTestLock().waiting).toEqual([]);
    await holder.release();
  },
);

test("ARK-T684 a whole-suite bun test with the ark test marker starts at once, and the same command without it waits", async () => {
  const fixture = makeFixture();
  const holder = await startHolder(fixture.home, 3);
  const marked = bunTest(
    fixture.directory,
    ["test", "--parallel=3"],
    environment(fixture.home, { [budgetHeldVariable]: "held" }),
  );
  expect(await marked.child.exited).toBe(0);
  await marked.output.done;
  expect(marked.output.text).not.toContain(waitingLine);
  expect(readTestLock().waiting).toEqual([]);

  // Control: the same command line with no marker waits behind the holder.
  const linesBefore = fixture.markerLines("runs.log").length;
  const control = bunTest(fixture.directory, ["test", "--parallel=3"], environment(fixture.home));
  await bareTicketWritten(fixture);
  expect(fixture.markerLines("runs.log")).toHaveLength(linesBefore);
  expect(readTestLock().waiting).toMatchObject([{ run: "bun test", pid: control.child.pid }]);
  await holder.release();
  expect(await control.child.exited).toBe(0);
  await control.output.done;
  expect(control.output.count(waitingLine)).toBe(1);
});

test("ARK-T684 ark test runs its whole-suite head suite, base run and census run with no second wait on its own cores", async () => {
  const home = tempArkHome();
  const markers = realpathSync(mkdtempSync(join(tmpdir(), "bare-markers-")));
  const workspace = tempGitRepo(suiteFiles(markers));
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    test_budget_cores: 3,
    test_min_free_memory_percent: 0,
    test_max_swap_gb: 1000,
    suites: [
      {
        name: "cli",
        level: "e2e",
        repo: ".",
        cores: 3,
        command: "bun test test --parallel=<cores> --reporter=junit --reporter-outfile={report}",
        parser: "bun",
      },
    ],
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
  await waitFor(markers, startedInWorktree);

  // The head suite runs: the store holds its ticket only, and no bare-run ticket.
  expect(readTestLock().running).toMatchObject([{ run: runId, cores: 3 }]);
  expect(readTestLock().waiting).toEqual([]);

  closeSync(gateDescriptor);
  const code = await caller.exited;
  await output.done;
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
  expect(await run.child.exited, run.output.text).toBe(0);
  await run.output.done;
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
    expect(readTestLock().waiting).toEqual([]);
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
