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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Every test shares one temp ARK_HOME (never the real one) holding two projects, so a per-project lock would not
// serialize the two runs.
let arkHome: string;
let fixtures: string;
let runA: string;
let runB: string;
let projectA: string;

const logFile = () => join(fixtures, "suite.log");
const lockDirectory = () => join(arkHome, "test.lock");
const waiterDirectory = () => join(arkHome, "test-waiters");
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
if [ -e "$2/hold" ]; then
  while [ ! -e "$2/release" ]; do sleep 0.1; done
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

/** Starts a run of `ticketId` at the building phase in its own project of the shared ARK_HOME. */
function startRun(project: string, ticketId: string, script: string): string {
  const workspace = tempGitRepo();
  writeProject(project, {
    workspace,
    ticket_source: "local",
    // replaced below once the run id is known
    suites: [
      {
        name: "sleeper",
        level: "integration",
        repo: ".",
        command: "true",
        parser: "bun",
      },
    ],
    roles,
  });
  const ticket = writeTicket(project, ticketId, [
    { id: `${ticketId}-AC1`, text: "A person checks it", manual: true },
  ]);
  const runId = ark("run", "start", ticket, "--project", project).out.match(
    new RegExp(`\\d{4}-\\d{2}-\\d{2}-${ticketId}-\\d+`),
  )![0];
  writeProject(project, {
    workspace,
    ticket_source: "local",
    suites: [
      {
        name: "sleeper",
        level: "integration",
        repo: ".",
        command: `sh ${script} ${runId} ${fixtures} {report}`,
        parser: "bun",
      },
    ],
    roles,
  });
  const runDirectory = join(arkHome, "projects", project, "runs", runId);
  recordEvaluation(runDirectory);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
      summary: {
        why: "Test the lock.",
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
  projectA = "lock-one";
  runA = startRun(projectA, "LOCKA-1", script);
  runB = startRun("lock-two", "LOCKB-1", script);
});

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

afterEach(() => {
  for (const path of [
    lockDirectory(),
    waiterDirectory(),
    logFile(),
    join(fixtures, "hold"),
    join(fixtures, "release"),
    join(fixtures, `fail-${runA}`),
  ])
    rmSync(path, { recursive: true, force: true });
});

type Started = {
  process: Subprocess<"ignore", "pipe", "pipe">;
  stdout: Promise<string>;
  /** The stdout read so far. */
  seen: () => string;
};

/** Starts `ark test <run>` as a child process of the temp ARK_HOME with its stdout collected. */
function startTest(run: string): Started {
  const child = Bun.spawn(["bun", arkEntry, "test", run], {
    env: { ...process.env, ARK_HOME: arkHome },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let seen = "";
  const stdout = (async () => {
    for await (const chunk of child.stdout) seen += new TextDecoder().decode(chunk);
    return seen;
  })();
  return { process: child, stdout, seen: () => seen };
}

/** Polls real child processes, so the wall clock is the only signal there is. */
async function waitFor(condition: () => boolean, what: string, limitMs = 30_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

const logLines = () => readLog().split("\n").filter(Boolean);
const countOf = (text: string, needle: string) => text.split(needle).length - 1;

/** After B starts its suites with no lock to wait for: no `waiting for` and no stale takeover line. */
async function expectCleanRunOfB(): Promise<void> {
  expect(existsSync(lockDirectory())).toBe(false);
  const second = startTest(runB);
  const out = await second.stdout;
  await second.process.exited;
  expect(logLines()).toContain(`start ${runB}`);
  expect(out).not.toContain("waiting for");
  expect(out).not.toContain("took over a stale");
}

describe("ark test lock", () => {
  test("ARK-T37 ARK-343/AC1 a second ark test of another project waits for the first and starts its suites only after it ends", async () => {
    const first = startTest(runA);
    await waitFor(() => logLines().includes(`start ${runA}`), `start ${runA}`);
    const second = startTest(runB);
    const secondOut = await second.stdout;
    await Promise.all([first.process.exited, second.process.exited]);

    const lines = logLines();
    expect(lines.indexOf(`end ${runA}`)).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(`end ${runA}`)).toBeLessThan(lines.indexOf(`start ${runB}`));
    expect(secondOut).toContain(`waiting for ark test of ${runA} (pid ${first.process.pid})`);
    expect(countOf(secondOut, "waiting for ark test of")).toBe(1);
    expect(existsSync(lockDirectory())).toBe(false);
  });

  test("ARK-T37 ARK-343/AC1 the lock is gone right after a failing suite", async () => {
    writeFileSync(join(fixtures, `fail-${runA}`), "");
    const first = startTest(runA);
    await first.stdout;
    expect(await first.process.exited).not.toBe(0);
    await expectCleanRunOfB();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    test(`ARK-T37 ARK-343/AC1 the lock is gone right after ${signal} ends ark test`, async () => {
      const first = startTest(runA);
      await waitFor(() => logLines().includes(`start ${runA}`), `start ${runA}`);
      first.process.kill(signal);
      await first.process.exited;
      await first.stdout;
      await expectCleanRunOfB();
    });

  test("ARK-T38 ARK-343/AC2 a lock of a dead holder is taken over at once with one message, and no lock gives no message", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    mkdirSync(lockDirectory(), { recursive: true });
    writeFileSync(
      join(lockDirectory(), "holder.json"),
      JSON.stringify({
        run: runB,
        pid: dead.pid,
        since: new Date().toISOString(),
      }),
    );

    const begun = Date.now();
    const taken = startTest(runA);
    await waitFor(() => logLines().includes(`start ${runA}`), `start ${runA}`);
    expect(Date.now() - begun).toBeLessThan(2000);
    const out = await taken.stdout;
    expect(await taken.process.exited).toBe(0);
    expect(countOf(out, `took over a stale ark test lock of pid ${dead.pid}`)).toBe(1);
    expect(out).not.toContain("waiting for");

    const again = startTest(runA);
    const againOut = await again.stdout;
    expect(await again.process.exited).toBe(0);
    expect(againOut).not.toContain("took over");
  });

  test("ARK-T39 ARK-343/AC3 ark chief state lists the holder and each live waiter with waited time, and no dead waiter", async () => {
    const state = () => ark("chief", "state", "--project", projectA).out;
    const heading = "## ark test lock";
    expect(state()).not.toContain(heading);
    expect(state()).toContain("## Open runs");

    writeFileSync(join(fixtures, "hold"), "");
    const first = startTest(runA);
    await waitFor(() => logLines().includes(`start ${runA}`), `start ${runA}`);
    const second = startTest(runB);
    await waitFor(
      () => second.seen().includes(`waiting for ark test of ${runA}`),
      "B to print its waiting line",
    );

    const listed = state();
    const lockSection = listed.split(/^## /m).find((part) => part.startsWith("ark test lock"));
    expect(lockSection).toBeDefined();
    expect(lockSection).toMatch(
      new RegExp(`holder: ${runA} \\(pid ${first.process.pid}\\), running \\d+\\s?(s|m|min)`),
    );
    expect(lockSection).toMatch(
      new RegExp(`waiting: ${runB} \\(pid ${second.process.pid}\\), waited \\d+\\s?(s|m|min)`),
    );

    const dead = Bun.spawn(["true"]);
    await dead.exited;
    mkdirSync(waiterDirectory(), { recursive: true });
    writeFileSync(
      join(waiterDirectory(), `${dead.pid}.json`),
      JSON.stringify({
        run: "2026-01-01-GHOST-1",
        pid: dead.pid,
        since: new Date().toISOString(),
      }),
    );
    expect(state()).not.toContain("GHOST-1");

    writeFileSync(join(fixtures, "release"), "");
    const [, , secondOut] = await Promise.all([
      first.process.exited,
      second.process.exited,
      second.stdout,
    ]);
    expect(secondOut).toContain(`waiting for ark test of ${runA}`);
    expect(state()).not.toContain(heading);
  });
});
