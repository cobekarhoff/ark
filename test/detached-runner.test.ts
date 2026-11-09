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
    Bun.spawnSync(["pkill", "-9", "-f", `test-runner ${fixture.runId} `]);
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
case "$PWD" in *ark-base-*) bun test "$1/passing.test.ts" --reporter=junit --reporter-outfile="$2"; exit;; esac
echo start >> "$1/starts"
: > "$1/started"
read opened < "$1/gate"
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
    const bare = mkdtempSync(join(tmpdir(), "ark-bare-"));
    git(bare, "init", "--bare", "-q");
    git(workspace, "remote", "add", "origin", "https://github.com/org/core.git");
    git(workspace, "config", "remote.origin.pushurl", bare);
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
        test_cases: [],
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

const lockHolder = (fixture: Fixture): number => {
  const lock = join(fixture.home, "test.lock");
  const name = readdirSync(lock).find((entry) => entry.startsWith("holder-"))!;
  return readJson(join(lock, name)).pid;
};
const runnerRecord = (fixture: Fixture, runDirectory = fixture.runDirectory) =>
  readJson(join(runDirectory, "results", "runner.json"));
const openGate = (fixture: Fixture) => Bun.write(join(fixture.directory, "gate"), "go\n");

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
    expect([secondDone.code, waitDone.code]).toEqual([0, 0]);
    expect(waitDone.out).toBe(secondDone.out);
    expect(waitDone.out).toBe(
      readFileSync(join(fixture.runDirectory, "results", "runner.out"), "utf8"),
    );
    expect(waitDone.out).toContain("suite      gated (integration)  passed");
    expect(existsSync(join(fixture.home, "test.lock"))).toBe(false);
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
    expect(existsSync(join(fixture.home, "test.lock"))).toBe(false);
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
echo start >> "$1/starts"
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
