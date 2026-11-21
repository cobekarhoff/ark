import { expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

// Each case runs a scratch `bun test` in the repo, with TMPDIR set to its own scratch directory,
// then lists that directory. The repo's bunfig.toml (and so the preload) applies because the cwd is the repo.
const repositoryRoot = resolve(import.meta.dir, "..");
const helpersPath = join(import.meta.dir, "helpers.ts");
const fixtureRoot = mkdtempSync(join(tmpdir(), "preload-fixtures-")); // inside this process's own preload root

function scratchDirectory(): string {
  return mkdtempSync(join(fixtureRoot, "scratch-"));
}

function writeFixture(name: string, source: string): string {
  const path = join(fixtureRoot, `${name}.test.ts`);
  writeFileSync(path, source);
  return path;
}

function spawnBunTest(
  fixturePath: string,
  scratch: string,
  extraArguments: string[] = [],
  extraEnvironment = {},
) {
  return Bun.spawn(["bun", "test", ...extraArguments, fixturePath], {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnvironment, TMPDIR: scratch },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runBunTest(fixturePath: string, scratch: string, extraArguments: string[] = []) {
  const child = spawnBunTest(fixturePath, scratch, extraArguments);
  const output = await new Response(child.stdout).text();
  const errorOutput = await new Response(child.stderr).text();
  return { exitCode: await child.exited, output: output + errorOutput };
}

const makesTempDirectory = (outcome: "pass" | "fail") => `
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("fixture", () => {
  for (const prefix of ["ark-", "ark179-", "ark199-", "plannotator-data-"]) {
    writeFileSync(join(mkdtempSync(join(tmpdir(), prefix)), "file"), "x");
  }
  expect(1).toBe(${outcome === "pass" ? 1 : 2});
});
`;

test.each(["pass", "fail"] as const)(
  "ARK-235-AC1 a bun test process that ends with a %s leaves nothing in the temporary directory",
  async (outcome) => {
    const scratch = scratchDirectory();
    const { exitCode, output } = await runBunTest(
      writeFixture(`suite-${outcome}`, makesTempDirectory(outcome)),
      scratch,
    );
    expect(exitCode === 0).toBe(outcome === "pass");
    expect(output).toContain(outcome === "pass" ? " 1 pass" : " 1 fail");
    expect(readdirSync(scratch)).toEqual([]);
  },
  { timeout: 60_000 },
);

// Prints its tmpdir() to <signal>/<name>.dir, writes a file there, and waits for <signal>/<name>.go.
// After the signal, the file must still exist or the fixture fails.
const concurrentFixture = (signalDirectory: string, name: string) => `
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("fixture ${name}", async () => {
  const ownDirectory = join(tmpdir(), "ark-concurrent-${name}");
  mkdirSync(ownDirectory);
  writeFileSync(join(ownDirectory, "file"), "x");
  writeFileSync(${JSON.stringify(join(signalDirectory, `${name}.dir`))}, tmpdir());
  while (!existsSync(${JSON.stringify(join(signalDirectory, `${name}.go`))})) await Bun.sleep(20);
  expect(existsSync(join(ownDirectory, "file"))).toBe(true);
});
`;

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1500 && !existsSync(path); attempt++) await Bun.sleep(20);
  expect(existsSync(path), `${path} never appeared`).toBe(true);
}

test(
  "ARK-235-AC2 two bun test processes at once use different roots, and one ending leaves the other's files",
  async () => {
    // Cross-process signal files: no in-process event to await.
    const signalDirectory = mkdtempSync(join(fixtureRoot, "signal-"));
    const scratch = scratchDirectory();
    const first = spawnBunTest(
      writeFixture("concurrent-a", concurrentFixture(signalDirectory, "a")),
      scratch,
    );
    const second = spawnBunTest(
      writeFixture("concurrent-b", concurrentFixture(signalDirectory, "b")),
      scratch,
    );

    await waitFor(join(signalDirectory, "a.dir"));
    await waitFor(join(signalDirectory, "b.dir"));
    const firstRoot = await Bun.file(join(signalDirectory, "a.dir")).text();
    const secondRoot = await Bun.file(join(signalDirectory, "b.dir")).text();
    expect(firstRoot).not.toBe(secondRoot);
    expect(readdirSync(scratch).length).toBe(2);

    writeFileSync(join(signalDirectory, "a.go"), "");
    expect(await first.exited).toBe(0);
    // The first process removed its root; the second still has its own, and its fixture re-checks its file.
    expect(readdirSync(scratch).length).toBe(1);
    writeFileSync(join(signalDirectory, "b.go"), "");
    expect(await second.exited).toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  },
  { timeout: 60_000 },
);

test(
  "ARK-235-AC3 a single test file that calls tempArkHome leaves nothing in the temporary directory",
  async () => {
    const scratch = scratchDirectory();
    const fixturePath = writeFixture(
      "single",
      `
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { tempArkHome } from ${JSON.stringify(helpersPath)};
test("fixture", () => {
  expect(existsSync(tempArkHome())).toBe(true);
});
`,
    );
    const { exitCode, output } = await runBunTest(fixturePath, scratch);
    expect(exitCode, output).toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  },
  { timeout: 60_000 },
);

const refusedTools = ["orca", "gh", "glab", "omp", "plannotator", "launchctl", "portless"];

test(
  "ARK-T154 bun test refuses a real orca, gh, glab, omp, plannotator, launchctl or portless and a test's own fake still wins",
  async () => {
    // Sentinels stand in for the real tools, behind the preload shims on the PATH the child inherits. Each logs its
    // name and exits 0, so a refusal cannot come from a real tool's own failure. The PATH holds nothing else named
    // like a tool: the sentinels, then the system folders and the folder of bun.
    const sentinels = mkdtempSync(join(fixtureRoot, "sentinels-"));
    const sentinelLog = join(sentinels, "calls.log");
    for (const tool of refusedTools) {
      const file = join(sentinels, tool);
      writeFileSync(file, `#!/bin/sh\necho ${tool} >> ${sentinelLog}\n`);
      chmodSync(file, 0o755);
    }
    const environment = { PATH: `${sentinels}:/usr/bin:/bin:${dirname(process.execPath)}` };
    const fixturePath = writeFixture(
      "refused-tools",
      `
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

// Product code spawns with Bun's default environment (cli/exec.ts); a test may also pass env: process.env.
const environments = [{}, { env: process.env }];

test.each(${JSON.stringify(refusedTools)})("refuses %s by name", (tool) => {
  for (const options of environments) {
    const result = Bun.spawnSync([tool, "--version"], { stdout: "pipe", stderr: "pipe", ...options });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString() + result.stderr.toString()).toContain(tool);
  }
});

test("a test's own fake orca gets the call", () => {
  const directory = mkdtempSync(join(tmpdir(), "fake-orca-"));
  writeFileSync(join(directory, "orca"), "#!/bin/sh\\necho fake-orca-output\\n");
  chmodSync(join(directory, "orca"), 0o755);
  process.env.PATH = directory + ":" + process.env.PATH;
  for (const options of environments) {
    const result = Bun.spawnSync(["orca"], { stdout: "pipe", ...options });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("fake-orca-output");
  }
});

test("a tool outside the seven still runs", () => {
  expect(Bun.spawnSync(["git", "--version"]).exitCode).toBe(0);
});
`,
    );
    const child = Bun.spawn(["bun", "test", fixturePath], {
      cwd: repositoryRoot,
      env: { ...environment, TMPDIR: scratchDirectory(), HOME: process.env.HOME! },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
    expect(await child.exited, output).toBe(0);
    expect(output).toContain(" 9 pass");
    expect(existsSync(sentinelLog)).toBe(false);
  },
  { timeout: 60_000 },
);

// --- ARK-404: the roots of the preload and of the Playwright helpers hold an owner file ---

test(
  "ARK-T189 the bun-test root of the preload holds ark-owner.pid with the pid of the bun test process",
  async () => {
    const fixturePath = writeFixture(
      "owner",
      `
import { test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
test("fixture", () => {
  const root = process.env.TMPDIR!;
  const file = join(root, "ark-owner.pid");
  console.log("OWNER " + JSON.stringify({ pid: process.pid, root, content: existsSync(file) ? readFileSync(file, "utf8") : null }));
});
`,
    );
    const { exitCode, output } = await runBunTest(fixturePath, scratchDirectory());
    expect(exitCode, output).toBe(0);
    const owner = JSON.parse(output.match(/OWNER (.*)/)![1]!);
    expect(owner.root).toMatch(/bun-test-/);
    expect(owner.content).toBe(`${owner.pid}\n`);
  },
  { timeout: 60_000 },
);

test(
  "ARK-T189 each fixture root of tempDirectory() in the Playwright helpers holds ark-owner.pid with the pid of the Node process",
  () => {
    const scratch = scratchDirectory();
    const script = join(fixtureRoot, "playwright-roots.mjs");
    writeFileSync(
      script,
      `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirectory } from ${JSON.stringify(join(helpersPath, "..", "pw", "helpers.ts"))};
const roots = ["ark-home-", "ark-repo-", "ark-fake-tools-", "ark-gate-"].map((prefix) => tempDirectory(prefix));
const content = roots.map((root) => {
  const file = join(root, "ark-owner.pid");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
});
console.log("OWNER " + JSON.stringify({ pid: process.pid, roots, content }));
`,
    );
    const result = Bun.spawnSync(["node", script], {
      cwd: repositoryRoot,
      env: { ...process.env, TMPDIR: scratch },
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, output).toBe(0);
    const owner = JSON.parse(output.match(/OWNER (.*)/)![1]!);
    expect(owner.roots).toHaveLength(4);
    expect(owner.content).toEqual(owner.roots.map(() => `${owner.pid}\n`));
  },
  { timeout: 60_000 },
);

// --- ARK-578: `bun test --rerun-each=N <file>` repeats one file in one process ---

// Reads state the preload makes once per process. Every repeat of the fixture must still find all of it.
const usesRootsAndShims = `
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
test("fixture", () => {
  const root = process.env.TMPDIR!;
  const host = process.env.ARK_FAKE_HOST!;
  expect(existsSync(join(root, "ark-owner.pid"))).toBe(true);
  expect(existsSync(join(host, "bin", "memory_pressure"))).toBe(true);
  expect(existsSync(join(host, "bin", "sysctl"))).toBe(true);
  expect(existsSync(join(root, "refusing-shims", "gh"))).toBe(true);
  expect(process.env.PATH!.startsWith(join(host, "bin") + ":" + join(root, "refusing-shims"))).toBe(true);
  const result = Bun.spawnSync(["gh", "--version"], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString() + result.stderr.toString()).toContain("gh");
});
`;

test.each([
  { label: "--rerun-each=5", flags: ["--rerun-each=5"] },
  { label: "--rerun-each 5", flags: ["--rerun-each", "5"] },
])(
  "ARK-T712 bun test --rerun-each=5 on one file that uses the temp root and the shims passes 5 of 5 repeats in one process ($label)",
  async ({ flags }) => {
    const fixturePath = writeFixture("rerun-roots-and-shims", usesRootsAndShims);
    const repeated = await runBunTest(fixturePath, scratchDirectory(), [...flags]);
    expect(repeated.exitCode, repeated.output).toBe(0);
    expect(repeated.output).toContain(" 5 pass");
    expect(repeated.output).toContain(" 0 fail");
    // Control: the fix must not break the single run.
    const single = await runBunTest(fixturePath, scratchDirectory());
    expect(single.exitCode, single.output).toBe(0);
    expect(single.output).toContain(" 1 pass");
  },
  { timeout: 60_000 },
);

// One line per repeat in the record file the case owns (outside both roots): the two root paths and whether both
// existed while the repeat ran. With FAIL_EVERY_SECOND set, the repeat that finds an even number of earlier lines fails.
const recordsRoots = `
import { expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
test("fixture", () => {
  const root = process.env.TMPDIR!;
  const host = process.env.ARK_FAKE_HOST!;
  const record = process.env.ROOT_RECORD!;
  const earlier = existsSync(record) ? readFileSync(record, "utf8").split("\\n").filter(Boolean).length : 0;
  appendFileSync(record, [root, host, existsSync(root) && existsSync(host)].join("|") + "\\n");
  if (process.env.FAIL_EVERY_SECOND && earlier % 2 === 0) expect(1).toBe(2);
});
`;

test.each([
  { label: "no flag", flags: [], repeats: 1, failEverySecond: false, exitCode: 0 },
  {
    label: "--rerun-each=5",
    flags: ["--rerun-each=5"],
    repeats: 5,
    failEverySecond: false,
    exitCode: 0,
  },
  {
    label: "--rerun-each=4 with failing repeats",
    flags: ["--rerun-each=4"],
    repeats: 4,
    failEverySecond: true,
    exitCode: 1,
  },
])(
  "ARK-T713 after a bun test process ends normally, with or without --rerun-each, and after repeats that fail, its bun-test-* root and its host root no longer exist ($label)",
  async ({ flags, repeats, failEverySecond, exitCode }) => {
    const fixturePath = writeFixture("rerun-records-roots", recordsRoots);
    const scratch = scratchDirectory();
    const record = join(scratchDirectory(), "roots.txt");
    const child = spawnBunTest(fixturePath, scratch, [...flags], {
      ROOT_RECORD: record,
      FAIL_EVERY_SECOND: failEverySecond ? "1" : "",
    });
    const output =
      (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
    expect(await child.exited, output).toBe(exitCode);
    if (failEverySecond) {
      expect(output).toContain(" 2 pass");
      expect(output).toContain(" 2 fail");
    }
    const lines = readFileSync(record, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(repeats);
    // Every repeat reports the process's one pair of roots, and found both while it ran.
    expect(new Set(lines).size).toBe(1);
    const [root, host, presentWhileRunning] = lines[0]!.split("|");
    expect(presentWhileRunning).toBe("true");
    expect(dirname(root!)).toBe(realpathSync(scratch));
    expect(root!).toMatch(/\/bun-test-[^/]+$/);
    expect(host!).toMatch(/^\/tmp\/ark-fake-host-/);
    expect(existsSync(root!)).toBe(false);
    expect(existsSync(host!)).toBe(false);
  },
  { timeout: 60_000 },
);

// A file that throws at load: bun runs no repeat and fires each preload afterAll once, so "remove after repeat N" alone
// would leak both roots. The fixture records the roots before it throws.
const throwsAtLoad = `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ROOT_RECORD!, [process.env.TMPDIR, process.env.ARK_FAKE_HOST].join("|"));
throw new Error("fixture fails at load");
`;

test.each([
  { label: "--rerun-each=3", flags: ["--rerun-each=3"] },
  { label: "--rerun-each 3", flags: ["--rerun-each", "3"] },
])(
  "ARK-T713 after a bun test process ends normally, with or without --rerun-each, and after repeats that fail, its bun-test-* root and its host root no longer exist (file fails at load, $label)",
  async ({ flags }) => {
    const fixturePath = writeFixture("rerun-throws-at-load", throwsAtLoad);
    const scratch = scratchDirectory();
    const record = join(scratchDirectory(), "roots.txt");
    const child = spawnBunTest(fixturePath, scratch, [...flags], { ROOT_RECORD: record });
    const output =
      (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
    expect(await child.exited, output).toBe(1);
    const [root, host] = readFileSync(record, "utf8").split("|");
    expect(dirname(root!)).toBe(realpathSync(scratch));
    expect(root!).toMatch(/\/bun-test-[^/]+$/);
    expect(host!).toMatch(/^\/tmp\/ark-fake-host-/);
    expect(existsSync(root!)).toBe(false);
    expect(existsSync(host!)).toBe(false);
  },
  { timeout: 60_000 },
);

// --- ARK-610: a failed removal of a preload root never fails the bun test process ---

// The fixture records the two roots it runs under, so the case finds them after the process ends.
const recordsRootsAndPasses = (outcome: "pass" | "fail") => `
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
test("fixture", () => {
  writeFileSync(process.env.ROOT_RECORD!, [process.env.TMPDIR, process.env.ARK_FAKE_HOST].join("|"));
  expect(1).toBe(${outcome === "pass" ? 1 : 2});
});
`;

// A preload the case owns, passed to the inner run as `--preload`, so it also reaches a base that has no opt-in fault.
// It replaces `rmSync` of node:fs: a call on the live root named by FAULT_ROOT_VARIABLE is logged to FAULT_LOG and, for
// the first FAULT_COUNT calls ("all" = every call), throws an error with code FAULT_CODE; every other call is the real one.
const faultingRemovalPreload = `
import { mock } from "bun:test";
import * as fs from "node:fs";
const real = { ...fs };
const limit = process.env.FAULT_COUNT === "all" ? Infinity : Number(process.env.FAULT_COUNT);
let faulted = 0;
mock.module("node:fs", () => ({
  ...real,
  rmSync(path: string, options: unknown) {
    if (path === process.env[process.env.FAULT_ROOT_VARIABLE!]) {
      real.appendFileSync(process.env.FAULT_LOG!, path + "\\n");
      if (faulted < limit) {
        faulted += 1;
        throw Object.assign(new Error(process.env.FAULT_MESSAGE + ", rm '" + path + "'"), {
          code: process.env.FAULT_CODE,
          syscall: "rm",
          path,
        });
      }
    }
    return real.rmSync(path, options as never);
  },
}));
`;

const errorMessages = {
  EFAULT: "EFAULT: bad address in system call argument",
  EBUSY: "EBUSY: resource busy or locked",
  EACCES: "EACCES: permission denied",
  ENOENT: "ENOENT: no such file or directory",
};

type RemovalFault =
  // the preload's own opt-in fault (ARK_PRELOAD_RM_FAULTS), on the bun-test-* root
  | { route: "preload"; count: number | "all" }
  // the test-side `--preload` above, on the root that `rootVariable` names
  | {
      route: "test-side";
      code: keyof typeof errorMessages;
      rootVariable: "TMPDIR" | "ARK_FAKE_HOST";
      count: number | "all";
    };

// Runs one inner `bun test` and reads its exit, both streams, the two roots and the calls made on each root.
// The fault variables go only into the inner environment, never into this process.
async function runWithFailingRemoval(outcome: "pass" | "fail", fault: RemovalFault) {
  const folder = scratchDirectory();
  const record = join(folder, "roots.txt");
  const callLog = join(folder, "calls.log");
  const extraArguments: string[] = [];
  const extraEnvironment: Record<string, string> = { ROOT_RECORD: record };
  if (fault.route === "preload") {
    extraEnvironment.ARK_PRELOAD_RM_FAULTS = String(fault.count);
    extraEnvironment.ARK_PRELOAD_RM_LOG = callLog;
  } else {
    const hook = join(folder, "efault.ts");
    writeFileSync(hook, faultingRemovalPreload);
    extraArguments.push("--preload", hook);
    Object.assign(extraEnvironment, {
      FAULT_ROOT_VARIABLE: fault.rootVariable,
      FAULT_CODE: fault.code,
      FAULT_MESSAGE: errorMessages[fault.code],
      FAULT_COUNT: String(fault.count),
      FAULT_LOG: callLog,
    });
  }
  const fixturePath = writeFixture(`removal-${outcome}`, recordsRootsAndPasses(outcome));
  const child = spawnBunTest(fixturePath, scratchDirectory(), extraArguments, extraEnvironment);
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  const [root, host] = readFileSync(record, "utf8").split("|") as [string, string];
  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").split("\n").filter(Boolean)
    : [];
  const linesNaming = (text: string, path: string) =>
    text.split("\n").filter((line) => line.includes(path));
  return {
    exitCode,
    stdout,
    stderr,
    output: stdout + stderr,
    root,
    host,
    callsOn: (path: string) => calls.filter((line) => line === path).length,
    stderrLinesNaming: (path: string) => linesNaming(stderr, path),
    stdoutLinesNaming: (path: string) => linesNaming(stdout, path),
    // A row can leave a root behind: /tmp/ark-fake-host-* lies outside the scratch TMPDIR.
    removeRoots: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(host, { recursive: true, force: true });
    },
  };
}

test.each([
  { label: "the preload's own fault", fault: { route: "preload", count: 2 } as RemovalFault },
  {
    label: "a test-side fault",
    fault: { route: "test-side", code: "EFAULT", rootVariable: "TMPDIR", count: 2 } as RemovalFault,
  },
])(
  "ARK-T744 a nested bun test whose first 2 rmSync calls of its bun-test-* root throw EFAULT still exits 0, prints no error and leaves no root ($label)",
  async ({ fault }) => {
    const run = await runWithFailingRemoval("pass", fault);
    try {
      expect(run.exitCode, run.output).toBe(0);
      expect(run.output).toContain(" 1 pass");
      expect(run.output).toContain(" 0 fail");
      expect(run.output).not.toContain("EFAULT");
      expect(run.output).not.toContain("error:");
      expect(run.stderrLinesNaming(run.root)).toEqual([]);
      expect(existsSync(run.root)).toBe(false);
      expect(existsSync(run.host)).toBe(false);
      // Two faulted calls, then the call that removed the root.
      expect(run.callsOn(run.root)).toBe(3);
    } finally {
      run.removeRoots();
    }
  },
  { timeout: 60_000 },
);

const everyCall = (code: keyof typeof errorMessages, rootVariable: "TMPDIR" | "ARK_FAKE_HOST") =>
  ({ route: "test-side", code, rootVariable, count: "all" }) as RemovalFault;

test.each([
  {
    label: "every call faults, passing test",
    outcome: "pass" as const,
    fault: { route: "preload", count: "all" } as RemovalFault,
    exitCode: 0,
    summary: " 1 pass",
    faultedRoot: "root" as const,
    code: "EFAULT",
    calls: 4,
  },
  {
    label: "every call faults, failing test",
    outcome: "fail" as const,
    fault: { route: "preload", count: "all" } as RemovalFault,
    exitCode: 1,
    summary: " 1 fail",
    faultedRoot: "root" as const,
    code: "EFAULT",
    calls: 4,
  },
  {
    label: "EBUSY is retried",
    outcome: "pass" as const,
    fault: everyCall("EBUSY", "TMPDIR"),
    exitCode: 0,
    summary: " 1 pass",
    faultedRoot: "root" as const,
    code: "EBUSY",
    calls: 4,
  },
  {
    label: "EACCES is not retried",
    outcome: "pass" as const,
    fault: everyCall("EACCES", "TMPDIR"),
    exitCode: 0,
    summary: " 1 pass",
    faultedRoot: "root" as const,
    code: "EACCES",
    calls: 1,
  },
  {
    label: "ENOENT counts as removed",
    outcome: "pass" as const,
    fault: everyCall("ENOENT", "TMPDIR"),
    exitCode: 0,
    summary: " 1 pass",
    faultedRoot: "root" as const,
    code: null,
    calls: 1,
  },
  {
    label: "the fake host root takes the same path",
    outcome: "pass" as const,
    fault: everyCall("EFAULT", "ARK_FAKE_HOST"),
    exitCode: 0,
    summary: " 1 pass",
    faultedRoot: "host" as const,
    code: "EFAULT",
    calls: 4,
  },
])(
  "ARK-T745 when the removal of a preload root always fails, bun test keeps the exit status of its tests, prints one line with the root and the code, leaves the root and calls rmSync at most 4 times ($label)",
  async ({ outcome, fault, exitCode, summary, faultedRoot, code, calls }) => {
    const run = await runWithFailingRemoval(outcome, fault);
    try {
      expect(run.exitCode, run.output).toBe(exitCode);
      expect(run.output).toContain(summary);
      const faulted = run[faultedRoot];
      const other = faultedRoot === "root" ? run.host : run.root;
      expect(run.callsOn(faulted)).toBe(calls);
      const lines = run.stderrLinesNaming(faulted);
      if (code === null) {
        expect(lines).toEqual([]);
      } else {
        expect(lines, run.stderr).toHaveLength(1);
        expect(lines[0]).toContain(code);
        expect(existsSync(faulted)).toBe(true);
      }
      expect(run.stdoutLinesNaming(faulted)).toEqual([]);
      // The other root has no fault: it is removed and no line names it.
      expect(existsSync(other)).toBe(false);
      expect(run.stderrLinesNaming(other)).toEqual([]);
    } finally {
      run.removeRoots();
    }
  },
  { timeout: 60_000 },
);
