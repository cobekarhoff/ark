import type { Subprocess } from "bun";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
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
import { dirname, join, resolve } from "node:path";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  writeEvidenceFile,
  workspaceWithRepos,
  writeProject,
  writeTicket,
} from "./helpers.ts";
import { macOnly, recordStartedRun, stopStartedRuns } from "./orphan-runners.ts";
import { installFakeOrca, removeFakeOrca } from "./fake-orca.ts";

// ARK-366: real `ark test` callers, detached runners and suite processes. Waits are events (a file appears, a
// stream prints, a process exits), never sleeps: see test/wallclock.test.ts and test/timeouts.test.ts.
setDefaultTimeout(120_000);

const arkEntry = resolve(import.meta.dir, "..", "cli", "ark.ts");
const hostFixtures = resolve(import.meta.dir, "fixtures/merge-request");
const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

type Suite = {
  name: string;
  level: "integration";
  repo: string;
  command: string;
  parser: "bun";
  base_files?: string;
  base_command?: string;
};

type Fixture = {
  home: string;
  directory: string;
  workspace: string;
  repos: string[];
  environment: Record<string, string>;
  suites: Suite[];
  checks: { name: string; repo: string; command: string }[];
  runId: string;
  runDirectory: string;
  startRun: (ticketId: string) => { runId: string; runDirectory: string };
  mirrorOf: (repo: string, runDirectory?: string) => string;
  rewriteProject: () => void;
};

const fixtures: Fixture[] = [];

afterEach(() => {
  stopStartedRuns();
  for (const fixture of fixtures.splice(0)) {
    // A SIGKILLed runner cannot stop its suites: find them by the pid files and the fixture folder.
    for (const name of ["suite-pid", "child", "grandchild"]) {
      const file = join(fixture.directory, name);
      if (!existsSync(file)) continue;
      const pid = Number(readFileSync(file, "utf8").trim());
      for (const target of [-pid, pid])
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // already gone
        }
    }
    // By the pid of its runner.json, never by run id: a fake run id repeats across the files of `bun test --parallel`.
    try {
      const { pid } = JSON.parse(
        readFileSync(join(fixture.runDirectory, "results", "runner.json"), "utf8"),
      );
      process.kill(pid, "SIGKILL");
    } catch {
      // no runner.json, or the runner is already gone
    }
    Bun.spawnSync(["pkill", "-9", "-f", fixture.directory]);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

/** Resolves when `path` exists: a directory watcher is the event, there is no polling. */
function appears(path: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), () => {
    if (!existsSync(path)) return;
    watcher.close();
    resolve();
  });
  if (existsSync(path)) {
    watcher.close();
    resolve();
  }
  return promise;
}

type Spawned = {
  child: Subprocess<"ignore", "pipe", "pipe">;
  seen: { out: string; err: string };
  finished: () => Promise<{ code: number; out: string; err: string }>;
  /** Resolves when stderr holds `text`. */
  errorHas: (text: string) => Promise<void>;
};

function spawnArk(fixture: Fixture, args: string[]): Spawned {
  const child = Bun.spawn(["bun", arkEntry, ...args], {
    env: fixture.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const seen = { out: "", err: "" };
  const listeners: { text: string; done: () => void }[] = [];
  const read = async (stream: ReadableStream<Uint8Array>, key: "out" | "err") => {
    for await (const chunk of stream) {
      seen[key] += new TextDecoder().decode(chunk);
      for (const listener of listeners) if (seen.err.includes(listener.text)) listener.done();
    }
  };
  const reading = Promise.all([read(child.stdout, "out"), read(child.stderr, "err")]);
  return {
    child,
    seen,
    finished: async () => {
      await reading;
      return { code: await child.exited, out: seen.out, err: seen.err };
    },
    errorHas: (text) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      if (seen.err.includes(text)) resolve();
      else listeners.push({ text, done: resolve });
      return promise;
    },
  };
}

async function arkDone(fixture: Fixture, ...args: string[]) {
  return spawnArk(fixture, args).finished();
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const lines = (path: string, wanted?: string): string[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "" && (wanted === undefined || line === wanted))
    : [];
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commitFiles(directory: string, files: Record<string, string>, message = "change"): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", message);
}

/** Scripts for the gated and the stoppable suite; both write a real junit report with `bun test`. */
function writeScripts(directory: string): void {
  writeFileSync(
    join(directory, "passing.test.ts"),
    'import { test } from "bun:test";\ntest("passes", () => {});\n',
  );
  writeFileSync(
    join(directory, "failing.test.ts"),
    'import { expect, test } from "bun:test";\ntest("fails", () => { expect(1).toBe(2); });\n',
  );
  // usage: gate.sh <directory> <report>. Blocks on the gate pipe until the test writes to it.
  writeFileSync(
    join(directory, "gate.sh"),
    `#!/bin/sh
case "$PWD$2" in *ark-base-*|*/census/*) bun test "$1/passing.test.ts" --reporter=junit --reporter-outfile="$2"; exit;; esac
echo start >> "$1/starts"
exec 3<> "$1/gate"
: > "$1/started"
read opened <&3
if [ -e "$1/fail" ]; then test=failing; else test=passing; fi
bun test "$1/$test.test.ts" --reporter=junit --reporter-outfile="$2"
`,
  );
  // usage: stop.sh <directory> <report>. Holds a child and a grandchild until a signal ends the group, unless `pass` exists.
  writeFileSync(
    join(directory, "stop.sh"),
    `#!/bin/sh
echo $$ > "$1/suite-pid"
if [ ! -e "$1/pass" ]; then
  sh -c 'echo $$ > "$1/child"; sleep 300 & echo $! > "$1/grandchild"; : > "$1/ready"; wait' sh "$1" &
  wait
fi
bun test "$1/passing.test.ts" --reporter=junit --reporter-outfile="$2"
`,
  );
  // usage: count.sh <directory> <report> <test file>. Counts each start by the side it runs on.
  writeFileSync(
    join(directory, "count.sh"),
    `#!/bin/sh
side=head
case "$PWD" in *ark-base-*) side=base;; esac
case "$2" in */census/*) side=census;; esac
echo $side >> "$1/count"
bun test "$3" --reporter=junit --reporter-outfile="$2"
`,
  );
  Bun.spawnSync(["mkfifo", join(directory, "gate")]);
}

function makeFixture(options: {
  repos?: string[];
  suites: (directory: string) => Suite[];
  checks?: (directory: string) => Fixture["checks"];
  forge?: boolean;
}): Fixture {
  const home = tempArkHome();
  const directory = mkdtempSync(join(tmpdir(), "ark-detached-"));
  writeScripts(directory);
  const repos = options.repos ?? ["."];
  const workspace = workspaceWithRepos(repos);
  const environment: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ARK_HOME: home,
  };
  if (options.forge) {
    const bare = join(mkdtempSync(join(tmpdir(), "ark-origin-")), "github.com", "org", "core.git");
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare", "-q");
    git(workspace, "remote", "add", "origin", bare);
    git(workspace, "push", "origin", "HEAD:refs/heads/main");
    git(workspace, "remote", "set-head", "origin", "main");
    environment.FAKE_LOG = join(directory, "host-calls.ndjson");
    environment.PATH = `${hostFixtures}:${process.env.PATH}`;
  }
  const fixture = {
    home,
    directory,
    workspace,
    repos,
    environment,
    suites: options.suites(directory),
    checks: options.checks?.(directory) ?? [],
  } as Fixture;
  fixture.rewriteProject = () =>
    writeProject("demo", {
      workspace,
      ticket_source: "local",
      suites: fixture.suites,
      checks: fixture.checks,
      roles,
    });
  fixture.mirrorOf = (repo, runDirectory = fixture.runDirectory) =>
    join(runDirectory, "workspace", repo);
  fixture.startRun = (ticketId) => {
    process.env.ARK_HOME = home;
    fixture.rewriteProject();
    const ticket = writeTicket("demo", ticketId, [
      { id: `${ticketId}-AC1`, text: "A person checks it", manual: true },
    ]);
    const runId = ark("run", "start", ticket, "--project", "demo").out.match(
      new RegExp(`\\d{4}-\\d{2}-\\d{2}-${ticketId}-\\d+`),
    )![0];
    const runDirectory = join(home, "projects", "demo", "runs", runId);
    recordEvaluation(runDirectory);
    writeFileSync(
      join(runDirectory, "plan.yml"),
      JSON.stringify({
        design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
        summary: {
          why: "Test the detached runner.",
          changes: [
            {
              criterion: `${ticketId}-AC1`,
              where: "tests",
              now: "None.",
              fix: "A person checks.",
            },
          ],
        },
        steps: repos.map((repo, index) => ({
          id: `build-${index}`,
          role: "implementer",
          repo,
          harness: "claude",
          model: "claude-sonnet",
          needs: [],
          criteria: [`${ticketId}-AC1`],
        })),
        // ARK-431: the ids that the fixture's head commits touch.
        test_cases: ["DET-T1", "DET-T3"].map((id) => ({
          id,
          criterion: `${ticketId}-AC1`,
          level: "e2e",
          given: [],
          when: ["run it"],
          // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
          then: ["it works"],
          expected: "it works",
        })),
      }),
    );
    for (const args of [
      ["plan", "check", runId],
      ["gate", "record", runId, "plan", "approve"],
      ["worktree", "create", runId],
      ["gate", "record", runId, "manual", `${ticketId}-AC1`, "ok"],
    ]) {
      const result = ark(...args);
      if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
    }
    recordStartedRun({ runId, runDirectory });
    return { runId, runDirectory };
  };
  Object.assign(fixture, fixture.startRun("DET-1"));
  fixtures.push(fixture);
  return fixture;
}

const gateSuite = (directory: string): Suite[] => [
  {
    name: "gated",
    level: "integration",
    repo: ".",
    command: `sh ${directory}/gate.sh ${directory} {report}`,
    parser: "bun",
  },
];

const budgetFolder = (fixture: Fixture) => join(fixture.home, "test-budget");
/** The pid in the budget ticket of the running suite: the runner holds the ticket for its life. */
const lockHolder = (fixture: Fixture): number => {
  const folder = budgetFolder(fixture);
  const name = readdirSync(folder).find((entry) => entry.endsWith(".json"))!;
  return readJson(join(folder, name)).pid;
};
const noTickets = (fixture: Fixture) =>
  !existsSync(budgetFolder(fixture)) ||
  readdirSync(budgetFolder(fixture)).filter((entry) => entry.endsWith(".json")).length === 0;
const runnerRecord = (fixture: Fixture, runDirectory = fixture.runDirectory) =>
  readJson(join(runDirectory, "results", "runner.json"));
const openGate = (fixture: Fixture) => Bun.write(join(fixture.directory, "gate"), "go\n");

/** Every process below `rootPid` by parent pid, taken while the caller lives: a reparented runner is not in it. */
function descendantsOf(rootPid: number): number[] {
  const listing = Bun.spawnSync(["ps", "-axo", "pid,ppid"]).stdout.toString();
  const children = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match)
      children.set(Number(match[2]), [...(children.get(Number(match[2])) ?? []), Number(match[1])]);
  }
  const found: number[] = [];
  for (const queue = [rootPid]; queue.length > 0;) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** SIGKILL of the helper, its process group and every process below it, then waits until they are all gone. */
async function killTree(helper: Subprocess): Promise<void> {
  const tree = [helper.pid, ...descendantsOf(helper.pid)];
  for (const target of [-helper.pid, ...tree])
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone
    }
  await helper.exited;
}

/**
 * A helper shell with a second child (`sleep`). It runs `ark test <run>` as a child; with `withWait` it then also
 * runs `ark test <run> --wait` once the suite started, and its output is the helper's stdout. It is its own
 * process group leader, so a group kill reaches the callers but not a runner that made its own group.
 */
function spawnHelper(fixture: Fixture, withWait = false): Subprocess {
  const started = join(fixture.directory, "started");
  const waitCaller = withWait
    ? `until [ -e "${started}" ]; do sleep 0.05; done; bun "$0" test "$1" --wait 2>&1 &`
    : "";
  return Bun.spawn(
    [
      "sh",
      "-c",
      `sleep 300 & bun "$0" test "$1" >/dev/null 2>&1 & ${waitCaller} wait`,
      arkEntry,
      fixture.runId,
    ],
    {
      env: fixture.environment,
      stdin: "ignore",
      stdout: withWait ? "pipe" : "ignore",
      stderr: "ignore",
      detached: true,
    },
  );
}

/** The suite process of the gated suite: the shell that `gate.sh` runs in. */
const suiteAlive = (fixture: Fixture): boolean =>
  Bun.spawnSync(["pgrep", "-f", `gate.sh ${fixture.directory}`]).exitCode === 0;

describe("detached ark test runner", () => {
  test("ARK-T161 a caller killed during a suite leaves the runner and the lock, a second call attaches, and --wait prints the lines and exit code of the first call", async () => {
    const fixture = makeFixture({ suites: gateSuite });
    const startsFile = join(fixture.directory, "starts");
    const caller = spawnArk(fixture, ["test", fixture.runId]);
    await appears(join(fixture.directory, "started"));

    const record = runnerRecord(fixture);
    expect(record.state).toBe("running");
    expect(lockHolder(fixture)).toBe(record.pid);
    expect(record.pid).not.toBe(caller.child.pid);

    caller.child.kill("SIGKILL");
    await caller.child.exited;
    expect(alive(record.pid)).toBe(true);
    expect(lockHolder(fixture)).toBe(record.pid);

    const second = spawnArk(fixture, ["test", fixture.runId]);
    await second.errorHas(`attaching to the full ark test of ${fixture.runId} (pid ${record.pid})`);
    const waiting = spawnArk(fixture, ["test", fixture.runId, "--wait"]);
    await openGate(fixture);
    const [secondDone, waitDone] = await Promise.all([second.finished(), waiting.finished()]);

    expect(lines(startsFile)).toEqual(["start"]);
    const detail = {
      second: secondDone,
      waiting: waitDone,
      runnerOut: existsSync(join(fixture.runDirectory, "results", "runner.out"))
        ? readFileSync(join(fixture.runDirectory, "results", "runner.out"), "utf8")
        : "",
      runnerErr: existsSync(join(fixture.runDirectory, "results", "runner.err"))
        ? readFileSync(join(fixture.runDirectory, "results", "runner.err"), "utf8")
        : "",
    };
    expect([secondDone.code, waitDone.code], JSON.stringify(detail, null, 2)).toEqual([0, 0]);
    expect(waitDone.out).toBe(secondDone.out);
    expect(waitDone.out).toBe(
      readFileSync(join(fixture.runDirectory, "results", "runner.out"), "utf8"),
    );
    expect(waitDone.out).toContain("suite      gated (integration)  passed");
    expect(noTickets(fixture)).toBe(true);
    expect(runnerRecord(fixture)).toMatchObject({ state: "done", exit_code: 0 });
  });

  test("ARK-T161 a failing suite gives the live caller and --wait the same lines and exit 1", async () => {
    const fixture = makeFixture({ suites: gateSuite });
    writeFileSync(join(fixture.directory, "fail"), "");
    const caller = spawnArk(fixture, ["test", fixture.runId]);
    await appears(join(fixture.directory, "started"));
    const waiting = spawnArk(fixture, ["test", fixture.runId, "--wait"]);
    await openGate(fixture);
    const [callerDone, waitDone] = await Promise.all([caller.finished(), waiting.finished()]);

    expect([callerDone.code, waitDone.code]).toEqual([1, 1]);
    expect(waitDone.out).toBe(callerDone.out);
    expect(waitDone.err).toBe(callerDone.err);
    expect(callerDone.err).toContain("suite gated failed");
    expect(lines(join(fixture.directory, "starts"))).toEqual(["start"]);
    expect(runnerRecord(fixture)).toMatchObject({ state: "done", exit_code: 1 });
  });

  test("ARK-T161 --wait on a runner.json of a dead pid returns at once with a stale-runner error, and with no runner.json says no test runs", async () => {
    const fixture = makeFixture({ suites: gateSuite });
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const results = join(fixture.runDirectory, "results");
    mkdirSync(results, { recursive: true });
    writeFileSync(
      join(results, "runner.json"),
      JSON.stringify({
        pid: dead.pid,
        start: "",
        mode: "full",
        state: "running",
        started: new Date().toISOString(),
      }),
    );
    const stale = await arkDone(fixture, "test", fixture.runId, "--wait");
    expect(stale.code).toBe(1);
    expect(stale.err).toContain(
      `the runner of ${fixture.runId} (pid ${dead.pid}) ended without a result`,
    );

    rmSync(join(results, "runner.json"));
    const none = await arkDone(fixture, "test", fixture.runId, "--wait");
    expect(none.code).toBe(1);
    expect(none.err).toContain(`no ark test runner for ${fixture.runId}`);
  });

  test("ARK-T161 two callers that find the same dead runner claim start one runner and one suite", async () => {
    const fixture = makeFixture({ suites: gateSuite });
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const stale = join(fixture.runDirectory, "results", "runner.lock");
    mkdirSync(stale, { recursive: true });
    writeFileSync(
      join(stale, `owner-${dead.pid}-stale.json`),
      JSON.stringify({ pid: dead.pid, start: "" }),
    );
    const callers = [
      spawnArk(fixture, ["test", fixture.runId]),
      spawnArk(fixture, ["test", fixture.runId]),
    ];
    // One caller won the claim and spawned the runner; the other prints this line once it attached to that
    // runner. Opening the gate earlier lets the runner end first, and the late caller then claims a new runner.
    await Promise.race(
      callers.map((caller) => caller.errorHas("attaching to the full ark test of")),
    );
    // The suite opens the pipe read-write before it writes `started`; opening it earlier fails with ENXIO on macOS.
    await appears(join(fixture.directory, "started"));
    await openGate(fixture);
    const done = await Promise.all(callers.map((caller) => caller.finished()));

    expect(done.map((result) => result.code)).toEqual([0, 0]);
    expect(lines(join(fixture.directory, "starts"))).toEqual(["start"]);
    expect(done[1].out).toBe(done[0].out);
    expect(runnerRecord(fixture)).toMatchObject({ state: "done", exit_code: 0 });
  });

  const stopSuite = (directory: string): Suite[] => [
    {
      name: "stoppable",
      level: "integration",
      repo: ".",
      command: `sh ${directory}/stop.sh ${directory} {report}`,
      parser: "bun",
    },
  ];
  const pidOf = (fixture: Fixture, name: string) =>
    Number(readFileSync(join(fixture.directory, name), "utf8").trim());

  test("ARK-T162 --stop ends the runner, the suite child and its grandchild, and releases the lock; a runner killed by SIGKILL leaves a stale record the next ark test takes over", async () => {
    const fixture = makeFixture({ suites: stopSuite });
    const caller = spawnArk(fixture, ["test", fixture.runId]);
    await appears(join(fixture.directory, "ready"));
    const runnerPid = runnerRecord(fixture).pid;
    const suitePids = ["suite-pid", "child", "grandchild"].map((name) => pidOf(fixture, name));
    expect([runnerPid, ...suitePids].every(alive)).toBe(true);

    const stopped = await arkDone(fixture, "test", fixture.runId, "--stop");
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain(`stopped the ark test of ${fixture.runId} (pid ${runnerPid})`);
    expect([runnerPid, ...suitePids].map(alive)).toEqual([false, false, false, false]);
    expect(noTickets(fixture)).toBe(true);
    expect(runnerRecord(fixture).state).toBe("stopped");
    expect((await caller.finished()).code).toBe(128 + 15);

    // The runner is killed in a second run: it cannot stop its suites, and its record stays `running`.
    rmSync(join(fixture.directory, "ready"));
    const second = spawnArk(fixture, ["test", fixture.runId]);
    await appears(join(fixture.directory, "ready"));
    const crashed = runnerRecord(fixture).pid;
    process.kill(crashed, "SIGKILL");
    expect((await second.finished()).code).toBe(1);
    expect(runnerRecord(fixture).state).toBe("running");
    for (const pid of [-pidOf(fixture, "suite-pid")])
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }

    writeFileSync(join(fixture.directory, "pass"), "");
    const next = await arkDone(fixture, "test", fixture.runId);
    expect(next.code).toBe(0);
    expect(next.out).toContain("took over a stale ark test lock");
    expect(next.err).not.toContain("attaching");
    expect(runnerRecord(fixture)).toMatchObject({ state: "done", exit_code: 0 });
  });

  test("ARK-T162 --stop with no runner exits non-zero and says no test runs", async () => {
    const fixture = makeFixture({ suites: stopSuite });
    const idle = await arkDone(fixture, "test", fixture.runId, "--stop");
    expect(idle.code).not.toBe(0);
    expect(idle.out + idle.err).toContain(`no ark test is running for ${fixture.runId}`);
  });

  // ARK-427: the caller dies with its whole tree. A runner that is still a child of the caller dies with it.
  macOnly.each([
    { outcome: "passing", code: 0, line: "suite      gated (integration)  passed" },
    { outcome: "failing", code: 1, line: "suite      gated (integration)  failed" },
  ])(
    "ARK-T325 the whole process tree of a dead ark test caller leaves the runner and its suite alive, and a new --wait returns the result of a $outcome suite",
    async ({ code, line, outcome }) => {
      const fixture = makeFixture({ suites: gateSuite });
      if (outcome === "failing") writeFileSync(join(fixture.directory, "fail"), "");
      const helper = spawnHelper(fixture);
      await appears(join(fixture.directory, "started"));
      const record = runnerRecord(fixture);
      expect(record.state).toBe("running");
      expect(record.pid).not.toBe(helper.pid);

      await killTree(helper);
      expect(alive(record.pid), "the runner died with the tree of its caller").toBe(true);
      expect(suiteAlive(fixture), "the suite died with the tree of its caller").toBe(true);
      expect(runnerRecord(fixture)).toMatchObject({ state: "running", pid: record.pid });

      const waiting = spawnArk(fixture, ["test", fixture.runId, "--wait"]);
      await openGate(fixture);
      const done = await waiting.finished();
      expect(done.code, done.err).toBe(code);
      expect(done.out).toContain(line);
      expect(done.out).toBe(
        readFileSync(join(fixture.runDirectory, "results", "runner.out"), "utf8"),
      );
      expect(runnerRecord(fixture)).toMatchObject({ state: "done", exit_code: code });
    },
  );

  macOnly.each([
    { outcome: "passing", code: 0 },
    { outcome: "failing", code: 1 },
  ])(
    "ARK-T326 the whole process tree of a helper that ran ark test and ark test --wait leaves the runner running, and a new --wait returns the exit code of a $outcome suite",
    async ({ code, outcome }) => {
      const fixture = makeFixture({ suites: gateSuite });
      if (outcome === "failing") writeFileSync(join(fixture.directory, "fail"), "");
      const helper = spawnHelper(fixture, true);
      // `--wait` attached once it prints the runner's first line: the runner prints its checks before the suite.
      const first = await (helper.stdout as ReadableStream<Uint8Array>).getReader().read();
      expect(first.done, "the --wait caller ended before it printed").toBe(false);
      const record = runnerRecord(fixture);
      expect(record.state).toBe("running");
      expect(record.pid).not.toBe(helper.pid);

      await killTree(helper);
      expect(alive(record.pid), "the runner died with the tree of its helper").toBe(true);
      expect(suiteAlive(fixture), "the suite died with the tree of its helper").toBe(true);
      expect(runnerRecord(fixture)).toMatchObject({ state: "running", pid: record.pid });

      const waiting = spawnArk(fixture, ["test", fixture.runId, "--wait"]);
      await openGate(fixture);
      const done = await waiting.finished();
      expect(done.code, done.err).toBe(code);
      expect(runnerRecord(fixture)).toMatchObject({ state: "done", exit_code: code });
    },
  );
});

// ARK-T163: the cache. The suite runs `count.sh`, which appends `head` or `base` to one counter file.
const proofTest = (directory: string, extra = "") => `import { existsSync } from "node:fs";
import { expect, test } from "bun:test";
const base = process.cwd().includes("/ark-base-");
test("proof", () => {
  expect(existsSync(${JSON.stringify(`${directory}/fail-head`)}) && !base).toBe(false);
  expect(existsSync(${JSON.stringify(`${directory}/fail-base`)}) && base).toBe(false);
});
${extra}`;

const countSuite = (directory: string, label = ""): Suite[] => [
  {
    name: "counted",
    level: "integration",
    repo: "repoA",
    command: `sh ${directory}/count.sh ${directory} {report} test/proof.test.ts${label}`,
    parser: "bun",
    base_files: "test/*.test.ts",
    base_command: `sh ${directory}/count.sh ${directory} {report} {files}${label}`,
  },
];

const treeOf = (directory: string): Record<string, string> =>
  existsSync(directory)
    ? Object.fromEntries(
        readdirSync(directory, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => {
            const path = join(entry.parentPath, entry.name);
            return [path.slice(directory.length), readFileSync(path, "utf8")];
          }),
      )
    : {};

// ARK-422: the evidence of the last full run is what `ark merge-request open` ships; only a finished full run replaces it.
describe("ark test evidence of the last full run", () => {
  const fastTest = (label: string) =>
    `import { test } from "bun:test";\ntest("DET-T1 fast", () => { console.log("${label}"); });\n`;

  /** A run whose first suite finishes at once with case DET-T1; the optional second suite blocks until `pass` exists or a signal ends it. */
  function evidenceFixture(withBlockingSuite: boolean): Fixture {
    const fixture = makeFixture({
      suites: (directory) => [
        {
          name: "fast",
          level: "integration",
          repo: ".",
          command: "bun test test/fast.test.ts --reporter=junit --reporter-outfile={report}",
          parser: "bun",
        },
        ...(withBlockingSuite
          ? ([
              {
                name: "blocking",
                level: "integration",
                repo: ".",
                command: `sh ${directory}/stop.sh ${directory} {report}`,
                parser: "bun",
              },
            ] as Suite[])
          : []),
      ],
    });
    commitFiles(fixture.workspace, { "test/fast.test.ts": fastTest("full") });
    Object.assign(fixture, fixture.startRun("DET-2"));
    return fixture;
  }

  const evidenceDirectoryOf = (fixture: Fixture) =>
    join(fixture.runDirectory, "results", "evidence");
  /** Anything next to `results/evidence` whose name starts with `evidence` is a staging folder a run left behind. */
  const evidenceEntriesOf = (fixture: Fixture) =>
    readdirSync(join(fixture.runDirectory, "results")).filter((entry) =>
      entry.startsWith("evidence"),
    );

  test("ARK-T263 a quick ark test leaves every evidence file of the last full run unchanged", async () => {
    const fixture = evidenceFixture(false);
    const full = await arkDone(fixture, "test", fixture.runId);
    expect(full.code, full.err + full.out).toBe(0);
    const before = treeOf(evidenceDirectoryOf(fixture));
    expect(Object.keys(before)).toContain("/DET-T1/head/command.log");

    commitFiles(fixture.mirrorOf("."), { "test/fast.test.ts": fastTest("quick") });
    const quick = await arkDone(fixture, "test", fixture.runId, "--quick");
    expect(quick.code, quick.err + quick.out).toBe(0);
    expect(quick.out).toContain("mode: quick");

    expect(treeOf(evidenceDirectoryOf(fixture))).toEqual(before);
    expect(evidenceEntriesOf(fixture)).toEqual(["evidence"]);
  });

  test("ARK-T264 a stopped full ark test leaves the evidence of the previous full run in place", async () => {
    const fixture = evidenceFixture(true);
    writeFileSync(join(fixture.directory, "pass"), "");
    const first = await arkDone(fixture, "test", fixture.runId);
    expect(first.code, first.err + first.out).toBe(0);
    const before = treeOf(evidenceDirectoryOf(fixture));
    expect(Object.keys(before)).toContain("/DET-T1/head/command.log");

    // A new head commit keeps the cache from reusing the first run: both suites run, and the fast one writes new evidence.
    // The second suite then blocks.
    commitFiles(fixture.mirrorOf("."), { "src/second.txt": "second\n" });
    rmSync(join(fixture.directory, "pass"));
    const second = spawnArk(fixture, ["test", fixture.runId]);
    await appears(join(fixture.directory, "ready"));
    const stopped = await arkDone(fixture, "test", fixture.runId, "--stop");
    expect(stopped.code).toBe(0);
    await second.finished();

    expect(treeOf(evidenceDirectoryOf(fixture))).toEqual(before);

    // A staging folder the stopped run left does not block the next full run.
    writeFileSync(join(fixture.directory, "pass"), "");
    const next = await arkDone(fixture, "test", fixture.runId);
    expect(next.code, next.err + next.out).toBe(0);
    expect(Object.keys(treeOf(evidenceDirectoryOf(fixture))).sort()).toEqual(
      Object.keys(before).sort(),
    );
    expect(evidenceEntriesOf(fixture)).toEqual(["evidence"]);
  });

  test("ARK-T269 after a stopped full ark test the next full run removes the evidence folders of renamed cases and writes the new ones", async () => {
    const fixture = evidenceFixture(true);
    writeFileSync(join(fixture.directory, "pass"), "");
    const first = await arkDone(fixture, "test", fixture.runId);
    expect(first.code, first.err + first.out).toBe(0);
    const before = treeOf(evidenceDirectoryOf(fixture));
    expect(Object.keys(before)).toContain("/DET-T1/head/command.log");

    // The stopped run finishes the fast suite, then blocks in the second one.
    commitFiles(fixture.mirrorOf("."), { "src/second.txt": "second\n" });
    rmSync(join(fixture.directory, "pass"));
    const second = spawnArk(fixture, ["test", fixture.runId]);
    await appears(join(fixture.directory, "ready"));
    const stopped = await arkDone(fixture, "test", fixture.runId, "--stop");
    expect(stopped.code).toBe(0);
    await second.finished();
    expect(treeOf(evidenceDirectoryOf(fixture))).toEqual(before);

    // Case DET-T1 is renamed to DET-T3; the next full run keeps only the folder of the case it has.
    commitFiles(fixture.mirrorOf("."), {
      "test/fast.test.ts": fastTest("renamed").replace("DET-T1", "DET-T3"),
    });
    writeFileSync(join(fixture.directory, "pass"), "");
    const next = await arkDone(fixture, "test", fixture.runId);
    expect(next.code, next.err + next.out).toBe(0);
    const folders = readdirSync(evidenceDirectoryOf(fixture)).sort();
    expect(folders).toContain("DET-T3");
    expect(folders).not.toContain("DET-T1");
    expect(Object.keys(treeOf(evidenceDirectoryOf(fixture)))).toContain("/DET-T3/head/command.log");
    expect(evidenceEntriesOf(fixture)).toEqual(["evidence"]);
  });
});

describe("ark test result cache", () => {
  test("ARK-T163 a passed head and base result is reused with a message and the same evidence, and each key change runs the suite again", async () => {
    const fixture = makeFixture({
      repos: ["repoA", "repoB"],
      suites: (directory) => countSuite(directory),
      checks: (directory) => [
        { name: "ticks", repo: "repoA", command: `echo tick >> ${directory}/checks` },
      ],
    });
    const countFile = join(fixture.directory, "count");
    const sides = () => ({
      head: lines(countFile, "head").length,
      base: lines(countFile, "base").length,
    });
    const mirrorA = fixture.mirrorOf("repoA");
    commitFiles(mirrorA, { "test/proof.test.ts": proofTest(fixture.directory) });
    const test = () => arkDone(fixture, "test", fixture.runId);

    const first = await test();
    expect(first.code, first.err).toBe(0);
    expect(sides()).toEqual({ head: 1, base: 1 });
    expect(first.out).not.toContain("reused");
    const evidenceBefore = treeOf(join(fixture.runDirectory, "results", "evidence"));
    const criteriaBefore = first.out.split("\n").filter((line) => line.startsWith("criterion"));

    const second = await test();
    expect(second.code, second.err).toBe(0);
    expect(sides()).toEqual({ head: 1, base: 1 });
    expect(second.out).toMatch(
      /suite {6}counted \(integration\) {2}passed {2}reused {2}head key \w{6}/,
    );
    expect(second.out).toMatch(/suite {6}counted base {2}reused {2}base key \w{6}/);
    expect(treeOf(join(fixture.runDirectory, "results", "evidence"))).toEqual(evidenceBefore);
    expect(second.out.split("\n").filter((line) => line.startsWith("criterion"))).toEqual(
      criteriaBefore,
    );
    // checks run on a reused result too
    expect(lines(join(fixture.directory, "checks")).length).toBe(2);

    // (a) a commit in the first repo, (b) a commit in the second repo: head again, base reused
    for (const repo of ["repoA", "repoB"]) {
      const before = sides();
      commitFiles(
        fixture.mirrorOf(repo),
        { "src/feature.txt": repo },
        `production change in ${repo}`,
      );
      const result = await test();
      expect(result.code, result.err).toBe(0);
      expect(sides()).toEqual({ head: before.head + 1, base: before.base });
      expect(result.out).toMatch(/suite {6}counted base {2}reused/);
    }

    // (c) a changed copied test file with the base commit unchanged: base again
    let before = sides();
    commitFiles(mirrorA, { "test/proof.test.ts": proofTest(fixture.directory, "// second\n") });
    let result = await test();
    expect(result.code, result.err).toBe(0);
    expect(sides()).toEqual({ head: before.head + 1, base: before.base + 1 });
    expect(result.out).not.toMatch(/base {2}reused/);

    // (e) a changed suite command: both again
    before = sides();
    fixture.suites = countSuite(fixture.directory, " # v2");
    fixture.rewriteProject();
    result = await test();
    expect(result.code, result.err).toBe(0);
    expect(sides()).toEqual({ head: before.head + 1, base: before.base + 1 });
    expect(result.out).not.toContain("reused");

    // (d) another base commit with byte-identical copied test files: the base runs again
    before = sides();
    commitFiles(
      fixture.workspace + "/repoA",
      { "src/moved-base.txt": "x" },
      "production change on main",
    );
    const other = fixture.startRun("DET-2");
    commitFiles(fixture.mirrorOf("repoA", other.runDirectory), {
      "test/proof.test.ts": proofTest(fixture.directory, "// second\n"),
    });
    result = await arkDone(fixture, "test", other.runId);
    expect(result.code, result.err).toBe(0);
    expect(sides()).toEqual({ head: before.head + 1, base: before.base + 1 });
    expect(result.out).not.toMatch(/base {2}reused/);
  });

  test.each([
    ["full then quick", ["", "--quick"]],
    ["quick then full", ["--quick", ""]],
  ])(
    "ARK-T163 a result stored in one mode is not reused in the other: %s",
    async (_name, modes) => {
      const fixture = makeFixture({
        repos: ["repoA"],
        suites: (directory) => countSuite(directory),
      });
      commitFiles(fixture.mirrorOf("repoA"), {
        "test/proof.test.ts": proofTest(fixture.directory),
      });
      let headStarts = 0;
      for (const mode of modes) {
        const result = await arkDone(
          fixture,
          "test",
          fixture.runId,
          ...(mode === "" ? [] : [mode]),
        );
        expect(result.code, result.err).toBe(0);
        headStarts += 1;
        expect(lines(join(fixture.directory, "count"), "head").length).toBe(headStarts);
        expect(result.out).not.toMatch(/passed {2}reused/);
      }
    },
  );

  test("ARK-T163 a failed head result is never stored: the same key runs again, passes, and only then is reused; a failed base result also runs again", async () => {
    const fixture = makeFixture({ repos: ["repoA"], suites: (directory) => countSuite(directory) });
    commitFiles(fixture.mirrorOf("repoA"), { "test/proof.test.ts": proofTest(fixture.directory) });
    const countFile = join(fixture.directory, "count");
    const heads = () => lines(countFile, "head").length;
    const bases = () => lines(countFile, "base").length;
    const run = () => arkDone(fixture, "test", fixture.runId);

    writeFileSync(join(fixture.directory, "fail-head"), "");
    const failed = await run();
    expect(failed.code).toBe(1);
    // the first start and its one retry
    expect(heads()).toBe(2);

    rmSync(join(fixture.directory, "fail-head"));
    const passed = await run();
    expect(passed.code, passed.err).toBe(0);
    expect(heads()).toBe(3);
    expect(passed.out).not.toMatch(/passed {2}reused/);

    const reused = await run();
    expect(reused.out).toMatch(/passed {2}reused/);
    expect(heads()).toBe(3);

    // a failing base is data for a feature run, and it is never stored
    commitFiles(fixture.mirrorOf("repoA"), {
      "test/proof.test.ts": proofTest(fixture.directory, "// base fails\n"),
    });
    writeFileSync(join(fixture.directory, "fail-base"), "");
    const baseBefore = bases();
    for (const attempt of [1, 2]) {
      const result = await run();
      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain("base      failed");
      expect(bases()).toBe(baseBefore + attempt);
    }
  });
});

// ARK-T164: the flaky retry. Every test file counts its own starts per side and per suite label.
const countedFile = (
  directory: string,
  name: string,
  body: string,
) => `import { appendFileSync, readFileSync } from "node:fs";
import { test } from "bun:test";
const side = process.cwd().includes("/ark-base-") ? "base" : "head";
const label = process.env.SUITE ?? "";
const counter = ${JSON.stringify(`${directory}/count-${name}`)} + label;
appendFileSync(counter, side + "\\n");
const starts = readFileSync(counter, "utf8").split("\\n").filter((line) => line === side).length;
test(${JSON.stringify(name)}, () => { ${body} });
`;
const flakyBody = 'if (side === "head" && starts === 1) throw new Error("flake");';
const brokenBody = 'if (side === "head") throw new Error("broken");';

const bunSuite = (name: string, files: string[], environment = ""): Suite => ({
  name,
  level: "integration",
  repo: ".",
  command: `${environment}bun test --reporter=junit --reporter-outfile={report} ${files.map((file) => `./test/${file}.test.ts`).join(" ")}`,
  parser: "bun",
  base_files: "test/*.test.ts",
  base_command: `${environment}bun test --reporter=junit --reporter-outfile={report} {files}`,
});

const headStarts = (fixture: Fixture, name: string) =>
  lines(join(fixture.directory, `count-${name}`), "head").length;
const completedEvents = (fixture: Fixture) =>
  readFileSync(join(fixture.runDirectory, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "test.completed")
    .map((event) => event.data);

function commitCounted(fixture: Fixture, files: Record<string, string>): void {
  commitFiles(
    fixture.mirrorOf("."),
    Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        `test/${name}.test.ts`,
        countedFile(fixture.directory, name, body),
      ]),
    ),
  );
}

describe("ark test flaky retry", () => {
  test("ARK-T164 a file that fails once and passes on retry runs twice, passes the suite, and is listed as flaky in the output, the event, the retro, the MR body and a cached reuse", async () => {
    const fixture = makeFixture({
      forge: true,
      suites: () => [bunSuite("flaky", ["flaky", "stable"])],
    });
    commitCounted(fixture, { flaky: flakyBody, stable: "" });
    const first = await arkDone(fixture, "test", fixture.runId);

    expect(first.code, first.err).toBe(0);
    expect(headStarts(fixture, "flaky")).toBe(2);
    expect(headStarts(fixture, "stable")).toBe(1);
    expect(first.out).toContain(
      "suite      flaky (integration)  passed  flaky: test/flaky.test.ts (failed once, passed on retry)",
    );
    expect(first.out).not.toContain("stable.test.ts (failed once");
    expect(completedEvents(fixture).at(-1).flaky).toEqual([
      { suite: "flaky", file: "test/flaky.test.ts" },
    ]);

    const retro = await arkDone(fixture, "retro", fixture.runId);
    expect(retro.code, retro.err).toBe(0);
    expect(readJson(join(fixture.runDirectory, "metrics.json")).tests.flaky_files).toEqual([
      "flaky: test/flaky.test.ts",
    ]);

    writeEvidenceFile(fixture.runDirectory, "DET-1-AC1");
    const opened = await arkDone(fixture, "merge-request", "open", fixture.runId);
    expect(opened.code, opened.err).toBe(0);
    const body = lines(fixture.environment.FAKE_LOG)
      .map((line) => JSON.parse(line))
      .find((call) => call.argv.includes("create")).body as string;
    expect(body).toContain(
      "Flaky: `test/flaky.test.ts` in suite `flaky` failed once and passed on retry.",
    );

    const again = await arkDone(fixture, "test", fixture.runId);
    expect(again.code, again.err).toBe(0);
    expect(headStarts(fixture, "flaky")).toBe(2);
    expect(again.out).toMatch(/passed {2}reused {2}head key \w{6} {2}flaky: test\/flaky.test.ts/);
  });

  test("ARK-T164 a file that fails twice fails the suite after exactly one retry, its passing sibling runs once, and nothing is flaky", async () => {
    const fixture = makeFixture({ suites: () => [bunSuite("broken", ["broken", "ok"])] });
    commitCounted(fixture, { broken: brokenBody, ok: "" });
    const result = await arkDone(fixture, "test", fixture.runId);

    expect(result.code).toBe(1);
    expect(headStarts(fixture, "broken")).toBe(2);
    expect(headStarts(fixture, "ok")).toBe(1);
    expect(result.err).toContain("suite broken failed");
    expect(result.out).not.toContain("flaky:");
    expect(completedEvents(fixture).at(-1).flaky).toBeUndefined();
  });

  test.each([
    [
      "skipped",
      'const run = starts === 1 ? test : test.skip;\nrun("retried", () => { throw new Error("flake"); });',
    ],
    [
      "missing",
      'test(starts === 1 ? "retried" : "renamed", () => { if (starts === 1) throw new Error("flake"); });',
    ],
  ])(
    "ARK-T164 a failed test that is %s in the retry keeps the failure: one retry, the suite fails and nothing is flaky",
    async (_kind, tests) => {
      const fixture = makeFixture({ suites: () => [bunSuite("retried", ["retried"])] });
      const header = countedFile(fixture.directory, "retried", "").split("\ntest(")[0];
      commitFiles(fixture.mirrorOf("."), { "test/retried.test.ts": `${header}\n${tests}\n` });
      const result = await arkDone(fixture, "test", fixture.runId);

      expect(result.code, result.err).toBe(1);
      expect(headStarts(fixture, "retried")).toBe(2);
      expect(result.err).toContain("suite retried failed");
      expect(result.out).not.toContain("flaky:");
      expect(completedEvents(fixture).at(-1).flaky).toBeUndefined();
    },
  );

  test("ARK-T164 with a flaky and a broken suite the run fails, the flaky suite stays listed and the broken suite is failed", async () => {
    const fixture = makeFixture({
      suites: () => [bunSuite("flaky", ["flaky"]), bunSuite("broken", ["broken"])],
    });
    commitCounted(fixture, { flaky: flakyBody, broken: brokenBody });
    const result = await arkDone(fixture, "test", fixture.runId);

    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "suite      flaky (integration)  passed  flaky: test/flaky.test.ts",
    );
    expect(result.out).toContain("suite      broken (integration)  failed");
    expect(completedEvents(fixture).at(-1).flaky).toEqual([
      { suite: "flaky", file: "test/flaky.test.ts" },
    ]);
  });

  test("ARK-T164 a failed test whose report names no file is not retried and the suite stays failed", async () => {
    const fixture = makeFixture({ suites: () => [bunSuite("placeholder", ["none"])] });
    writeFileSync(
      join(fixture.directory, "nofile.sh"),
      `#!/bin/sh
case "$2" in */census/*) ;; *) echo start >> "$1/starts";; esac
cat > "$2" <<'XML'
<testsuites><testsuite name="s"><testcase name="t" classname="c"><failure message="x"/></testcase></testsuite></testsuites>
XML
exit 1
`,
    );
    fixture.suites = [
      {
        name: "nofile",
        level: "integration",
        repo: ".",
        command: `sh ${fixture.directory}/nofile.sh ${fixture.directory} {report}`,
        parser: "bun",
        base_files: "test/*.test.ts",
        base_command: `sh ${fixture.directory}/nofile.sh ${fixture.directory} {report} # {files}`,
      },
    ];
    fixture.rewriteProject();
    const result = await arkDone(fixture, "test", fixture.runId);

    expect(result.code).toBe(1);
    expect(lines(join(fixture.directory, "starts"))).toEqual(["start"]);
    expect(result.err).toContain("suite nofile failed");
    expect(result.out).toContain("not retried  (a failed test names no file)");
  });

  test("ARK-T164 the same file name in two suites: a pass on retry in one never hides the second failure in the other", async () => {
    const fixture = makeFixture({
      suites: () => [
        bunSuite("first", ["same"], "SUITE=a "),
        bunSuite("second", ["same"], "SUITE=b "),
      ],
    });
    commitCounted(fixture, {
      same: 'if (side === "head" && (label === "b" || starts === 1)) throw new Error("fails");',
    });
    const result = await arkDone(fixture, "test", fixture.runId);

    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "suite      first (integration)  passed  flaky: test/same.test.ts",
    );
    expect(result.out).toContain("suite      second (integration)  failed");
    expect(headStarts(fixture, "samea")).toBe(2);
    expect(headStarts(fixture, "sameb")).toBe(2);
  });
});

// ARK-428: red on main. Every start of a test file appends the side it ran on to the file's counter: `head` (the run's
// worktree, on an `ark/` branch), `base` (the ark-base- checkout) or `main` (any other checkout, the tip of the target branch).
const sidedFile = (directory: string, name: string, body: string, header = "") =>
  `import { appendFileSync, realpathSync } from "node:fs";
import { test } from "bun:test";
${header}
const cwd = realpathSync(process.cwd());
const branch = Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"]).stdout.toString();
const side = cwd.includes("/ark-base-") ? "base" : branch.startsWith("refs/heads/ark/") ? "head" : "main";
appendFileSync(${JSON.stringify(`${directory}/count-${name}`)}, side + "\\n");
test(${JSON.stringify(name)}, () => { ${body} });
`;
const redBody = 'if (side !== "base") throw new Error("red");';
const helperHeader = 'import { helper } from "../src/helper.ts";';
const usesHelperBody = 'if (helper() !== 1) throw new Error("helper changed");';

function commitSided(
  fixture: Fixture,
  target: string,
  files: Record<string, string | [string, string]>,
): void {
  commitFiles(
    target,
    Object.fromEntries(
      Object.entries(files).map(([name, body]) => [
        `test/${name}.test.ts`,
        Array.isArray(body)
          ? sidedFile(fixture.directory, name, body[0], body[1])
          : sidedFile(fixture.directory, name, body),
      ]),
    ),
  );
}

const sideStarts = (fixture: Fixture, name: string, side: "head" | "main" | "base") =>
  lines(join(fixture.directory, `count-${name}`), side).length;

/** Every test file of the checkout, so a file added later is run without a new suite. */
const wholeSuite = (name = "cli"): Suite => ({
  name,
  level: "integration",
  repo: ".",
  command: "bun test --reporter=junit --reporter-outfile={report}",
  parser: "bun",
  base_files: "test/*.test.ts",
  base_command: "bun test --reporter=junit --reporter-outfile={report} {files}",
});

/** Puts `files` on the target branch of the fixture's origin, then starts a fresh run from it. */
function runFromTip(
  fixture: Fixture,
  files: Record<string, string | [string, string]>,
  ticket: string,
) {
  commitSided(fixture, fixture.workspace, files);
  git(fixture.workspace, "push", "origin", "HEAD:refs/heads/main");
  Object.assign(fixture, fixture.startRun(ticket));
}

const redOnMainLine = (output: string, file: string) =>
  new RegExp(`^red on main.*${file.replaceAll(".", "\\.")}`, "m").test(output);

describe("ark test red on main", () => {
  test("ARK-T327 an untouched file that fails at head and at the tip of the target branch is printed as red on main, recorded in test.completed, not counted, and survives a cached reuse; a quick run records none", async () => {
    const fixture = makeFixture({ forge: true, suites: () => [wholeSuite()] });
    runFromTip(fixture, { red: redBody, ok: "" }, "DET-2");
    commitSided(fixture, fixture.mirrorOf("."), { other: "" });

    const first = await arkDone(fixture, "test", fixture.runId);
    expect(first.code, first.err + first.out).toBe(0);
    // the flaky retry runs first: two starts at head, then one at the tip checkout
    expect(sideStarts(fixture, "red", "head")).toBe(2);
    expect(sideStarts(fixture, "red", "main")).toBe(1);
    expect(sideStarts(fixture, "ok", "head")).toBe(1);
    expect(sideStarts(fixture, "ok", "main")).toBe(0);
    expect(sideStarts(fixture, "other", "main")).toBe(0);
    expect(redOnMainLine(first.out, "test/red.test.ts")).toBe(true);
    expect(first.out).not.toMatch(/^red on main.*(ok|other)\.test/m);
    const event = completedEvents(fixture).at(-1);
    expect(event.passed).toBe(true);
    expect(event.red_on_main).toEqual(["test/red.test.ts"]);
    expect(event.flaky).toBeUndefined();
    expect(event.suites.every((suite: { passed: boolean }) => suite.passed)).toBe(true);

    const again = await arkDone(fixture, "test", fixture.runId);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toMatch(/passed {2}reused/);
    expect(sideStarts(fixture, "red", "head")).toBe(2);
    expect(redOnMainLine(again.out, "test/red.test.ts")).toBe(true);
    expect(completedEvents(fixture).at(-1).red_on_main).toEqual(["test/red.test.ts"]);

    const quick = await arkDone(fixture, "test", fixture.runId, "--quick");
    expect(quick.code, quick.err).toBe(0);
    expect(quick.out).not.toMatch(/^red on main/m);
    const quickEvent = completedEvents(fixture).at(-1);
    expect(quickEvent.mode).toBe("quick");
    expect(quickEvent.red_on_main).toBeUndefined();
  });

  test("ARK-T327 the file is checked at the fetched tip of the target branch, not at the run's base: a tip that fixes it makes the failure count", async () => {
    const fixture = makeFixture({ forge: true, suites: () => [wholeSuite()] });
    runFromTip(fixture, { red: redBody, ok: "" }, "DET-2");
    commitSided(fixture, fixture.workspace, { red: "" });
    git(fixture.workspace, "push", "origin", "HEAD:refs/heads/main");
    commitSided(fixture, fixture.mirrorOf("."), { other: "" });

    const result = await arkDone(fixture, "test", fixture.runId);
    expect(result.code).toBe(1);
    expect(sideStarts(fixture, "red", "main")).toBe(1);
    expect(redOnMainLine(result.out, "test/red.test.ts")).toBe(false);
    const event = completedEvents(fixture).at(-1);
    expect(event.passed).toBe(false);
    expect(event.red_on_main).toBeUndefined();
  });

  test("ARK-T328 an untouched file that the tip of the target branch no longer has is not red on main: the failure keeps counting", async () => {
    const fixture = makeFixture({ forge: true, suites: () => [wholeSuite()] });
    runFromTip(fixture, { red: redBody, ok: "" }, "DET-2");
    git(fixture.workspace, "rm", "-q", "test/red.test.ts");
    git(fixture.workspace, "commit", "-q", "-m", "remove red on main");
    git(fixture.workspace, "push", "origin", "HEAD:refs/heads/main");
    commitSided(fixture, fixture.mirrorOf("."), { other: "" });

    const result = await arkDone(fixture, "test", fixture.runId);
    expect(result.code).toBe(1);
    expect(redOnMainLine(result.out, "test/red.test.ts")).toBe(false);
    expect(result.out).toContain("not red on main");
    const event = completedEvents(fixture).at(-1);
    expect(event.passed).toBe(false);
    expect(event.red_on_main).toBeUndefined();
  });

  test("ARK-T339 a file where a test that failed at head passes at the tip still counts, although another test of it is red on main", async () => {
    const fixture = makeFixture({ forge: true, suites: () => [wholeSuite()] });
    // test "a" fails at head and main passes it; test "mixed" fails at head and at the tip
    commitFiles(fixture.workspace, {
      "test/mixed.test.ts": `${sidedFile(fixture.directory, "mixed", redBody)}test("a", () => { if (side === "head") throw new Error("broken by the run"); });\n`,
    });
    git(fixture.workspace, "push", "origin", "HEAD:refs/heads/main");
    Object.assign(fixture, fixture.startRun("DET-2"));
    commitSided(fixture, fixture.mirrorOf("."), { other: "" });

    const result = await arkDone(fixture, "test", fixture.runId);
    expect(result.code).toBe(1);
    expect(sideStarts(fixture, "mixed", "main")).toBe(1);
    expect(redOnMainLine(result.out, "test/mixed.test.ts")).toBe(false);
    expect(result.out).toContain("not red on main");
    const event = completedEvents(fixture).at(-1);
    expect(event.passed).toBe(false);
    expect(event.red_on_main).toBeUndefined();
  });

  test.each([
    ["the suite has no base_command", "base_command"],
    ["the repo has no origin remote", "origin"],
    ["git fetch origin fails", "fetch"],
  ])(
    "ARK-T327 when %s the failure keeps counting, no red on main line is printed and the output says why the file was not checked on main",
    async (_why, cause) => {
      const fixture = makeFixture({
        forge: cause !== "origin",
        suites: () => [
          cause === "base_command"
            ? { ...wholeSuite(), base_files: undefined, base_command: undefined }
            : wholeSuite(),
        ],
      });
      if (cause === "origin") {
        commitSided(fixture, fixture.workspace, { red: redBody, ok: "" });
        Object.assign(fixture, fixture.startRun("DET-2"));
      } else runFromTip(fixture, { red: redBody, ok: "" }, "DET-2");
      commitSided(fixture, fixture.mirrorOf("."), { other: "" });
      if (cause === "fetch")
        for (const directory of [fixture.workspace, fixture.mirrorOf(".")])
          git(directory, "remote", "set-url", "origin", join(fixture.directory, "missing.git"));

      const result = await arkDone(fixture, "test", fixture.runId);
      expect(result.code).toBe(1);
      expect(sideStarts(fixture, "red", "main")).toBe(0);
      expect(result.out).not.toMatch(/^red on main/m);
      expect(result.out + result.err).toContain("not checked on main");
      const event = completedEvents(fixture).at(-1);
      expect(event.passed).toBe(false);
      expect(event.red_on_main).toBeUndefined();
    },
  );

  test("ARK-T327 a failed test that names no file is not checked on main and the suite stays failed", async () => {
    const fixture = makeFixture({ forge: true, suites: () => [wholeSuite()] });
    runFromTip(fixture, { ok: "" }, "DET-2");
    writeFileSync(
      join(fixture.directory, "nofile.sh"),
      `#!/bin/sh
case "$2" in */census/*) ;; *) echo start >> "$1/starts";; esac
cat > "$2" <<'XML'
<testsuites><testsuite name="s"><testcase name="t" classname="c"><failure message="x"/></testcase></testsuite></testsuites>
XML
exit 1
`,
    );
    const command = `sh ${fixture.directory}/nofile.sh ${fixture.directory} {report}`;
    fixture.suites = [{ ...wholeSuite("nofile"), command, base_command: `${command} # {files}` }];
    fixture.rewriteProject();

    const result = await arkDone(fixture, "test", fixture.runId);
    expect(result.code).toBe(1);
    expect(lines(join(fixture.directory, "starts"))).toEqual(["start"]);
    expect(result.out).not.toMatch(/^red on main/m);
    expect(result.out + result.err).toContain("not checked on main");
  });

  test.each([false, true])(
    "ARK-T328 an untouched file that the run broke through a changed helper fails at head, passes at the tip, and still fails the run (another file red on main: %s)",
    async (withRed) => {
      const fixture = makeFixture({ forge: true, suites: () => [wholeSuite()] });
      commitFiles(fixture.workspace, { "src/helper.ts": "export const helper = () => 1;\n" });
      runFromTip(
        fixture,
        {
          "uses-helper": [usesHelperBody, helperHeader],
          ...(withRed ? { red: redBody } : {}),
        },
        "DET-2",
      );
      commitFiles(fixture.mirrorOf("."), { "src/helper.ts": "export const helper = () => 2;\n" });

      const result = await arkDone(fixture, "test", fixture.runId);
      expect(result.code).toBe(1);
      expect(sideStarts(fixture, "uses-helper", "head")).toBe(2);
      expect(sideStarts(fixture, "uses-helper", "main")).toBe(1);
      expect(redOnMainLine(result.out, "test/uses-helper.test.ts")).toBe(false);
      expect(redOnMainLine(result.out, "test/red.test.ts")).toBe(withRed);
      const event = completedEvents(fixture).at(-1);
      expect(event.passed).toBe(false);
      expect(event.red_on_main).toEqual(withRed ? ["test/red.test.ts"] : undefined);
    },
  );

  test("ARK-T329 a touched file that fails fails the run and is never run at the tip, even when the tip fails it too", async () => {
    const fixture = makeFixture({ forge: true, suites: () => [wholeSuite()] });
    runFromTip(fixture, { red: redBody, ok: "" }, "DET-2");
    commitSided(fixture, fixture.mirrorOf("."), { red: `/* edited by the run */ ${redBody}` });

    const result = await arkDone(fixture, "test", fixture.runId);
    expect(result.code).toBe(1);
    expect(sideStarts(fixture, "red", "head")).toBe(2);
    expect(sideStarts(fixture, "red", "main")).toBe(0);
    expect(redOnMainLine(result.out, "test/red.test.ts")).toBe(false);
    const event = completedEvents(fixture).at(-1);
    expect(event.passed).toBe(false);
    expect(event.red_on_main).toBeUndefined();
  });

  test("ARK-T329 a file that reached the run only through ark worktree sync is untouched: red on main, not counted", async () => {
    const fixture = makeFixture({ forge: true, suites: () => [wholeSuite()] });
    Object.assign(fixture, fixture.startRun("DET-2"));
    commitSided(fixture, fixture.mirrorOf("."), { other: "" });
    commitSided(fixture, fixture.workspace, { red: redBody });
    git(fixture.workspace, "push", "origin", "HEAD:refs/heads/main");
    const synced = await arkDone(fixture, "worktree", "sync", fixture.runId);
    expect(synced.code, synced.err + synced.out).toBe(0);
    expect(existsSync(join(fixture.mirrorOf("."), "test/red.test.ts"))).toBe(true);

    const result = await arkDone(fixture, "test", fixture.runId);
    expect(result.code, result.err + result.out).toBe(0);
    expect(sideStarts(fixture, "red", "head")).toBe(2);
    expect(sideStarts(fixture, "red", "main")).toBe(1);
    expect(redOnMainLine(result.out, "test/red.test.ts")).toBe(true);
    const event = completedEvents(fixture).at(-1);
    expect(event.passed).toBe(true);
    expect(event.red_on_main).toEqual(["test/red.test.ts"]);
  });

  test("ARK-T330 a run whose only failure is red on main spends no round, opens no escalation gate and opens its merge request; a run that breaks another file does not", async () => {
    installFakeOrca();
    try {
      const fixture = makeFixture({ forge: true, suites: () => [wholeSuite()] });
      commitFiles(fixture.workspace, { "src/helper.ts": "export const helper = () => 1;\n" });
      runFromTip(fixture, { red: redBody, "uses-helper": [usesHelperBody, helperHeader] }, "DET-2");
      const control = fixture.startRun("DET-3");
      commitFiles(fixture.mirrorOf(".", control.runDirectory), {
        "src/helper.ts": "export const helper = () => 2;\n",
      });

      // two rounds, each: start the implementer, finish it, commit, run the tests
      const rounds = async (runId: string, runDirectory: string, worktree: string) => {
        const tested: { code: number; out: string; err: string }[] = [];
        for (const round of [1, 2]) {
          const started = await arkDone(fixture, "run", "step", runId, "build-0", "start");
          expect(started.code, started.err).toBe(0);
          commitSided(fixture, worktree, { [`round${round}`]: "" });
          const finished = await arkDone(fixture, "run", "step", runId, "build-0", "finish");
          expect(finished.code, finished.err).toBe(0);
          tested.push(await arkDone(fixture, "test", runId));
        }
        const events = readFileSync(join(runDirectory, "events.ndjson"), "utf8");
        return { tested, escalations: (events.match(/"escalation\.requested"/g) ?? []).length };
      };

      const counted = await rounds(
        control.runId,
        control.runDirectory,
        fixture.mirrorOf(".", control.runDirectory),
      );
      expect(counted.tested.map((result) => result.code)).toEqual([1, 1]);
      const controlStatus = await arkDone(fixture, "status", control.runId);
      expect(controlStatus.out).toContain("phase: escalation");
      writeEvidenceFile(control.runDirectory, "DET-3-AC1");
      const refused = await arkDone(fixture, "merge-request", "open", control.runId);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("the last test run did not pass");

      const main = await rounds(fixture.runId, fixture.runDirectory, fixture.mirrorOf("."));
      expect(main.tested.map((result) => result.code)).toEqual([0, 0]);
      expect(main.escalations).toBe(0);
      const status = await arkDone(fixture, "status", fixture.runId);
      expect(status.out).not.toContain("phase: escalation");
      expect(status.out).toContain("last test: passed");
      writeEvidenceFile(fixture.runDirectory, "DET-2-AC1");
      const opened = await arkDone(fixture, "merge-request", "open", fixture.runId);
      expect(opened.err).not.toContain("the last test run did not pass");
      expect(opened.code, opened.err).toBe(0);
    } finally {
      removeFakeOrca();
    }
  });
});

test("ARK-T354 a runner that exits before it writes runner.json fails ark test with the runner-exited error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-early-"));
  try {
    const script = `import { callTest } from ${JSON.stringify(join(import.meta.dir, "../cli/test-runner.ts"))};
try { await callTest("NOPE-1", "nope", ${JSON.stringify(directory)}, { quick: false, wait: false, stop: false }); } catch (err) { console.log((err as Error).message); }`;
    const child = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, ARK_HOME: join(directory, "home") },
      stdout: "pipe",
      stderr: "ignore",
    });
    expect((await new Response(child.stdout).text()).trim()).toBe(
      "the runner of NOPE-1 exited before it started",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
