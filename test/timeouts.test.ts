import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const repositoryRoot = resolve(import.meta.dir, "..");
const minimumTimeoutMilliseconds = 30_000;
// The ARK-T31 guard reads these files; ARK-T30 replaces this line in a copy of the file.
const timeoutGuardFiles = [
  "test/sync.test.ts",
  "test/merge-request.test.ts",
  "test/post-mr.test.ts",
];
const gitHeavyFiles = ["test/sync.test.ts", "test/merge-request.test.ts"];

// Calls that start a run or build a scenario. Case-sensitive, no word boundary: generatedScenario(
// and submoduleRun( count, a definition `function scenario(` is cut out of the chunk before this runs.
const gitHeavyCall = /(?:startRun|scenario|generatedScenario|submoduleRun|openRun)\(/;

// Splits a test file into the source of each `test(` call, including a test declared inside a `for`
// loop. A chunk ends at the next `test(` or at the next top-level function, const, let or for, so a
// helper definition or a loop between tests never leaks into the chunk before it. Tests that call no
// helper (the text-scan tests) are skipped. The timeout is the last `timeout:` of the chunk, a number
// or a `const NAME = <number>;` of the same file; any other value reads 0 and fails the guard.
function gitHeavyTests(file: string): { name: string; timeout: number }[] {
  const source = readFileSync(join(repositoryRoot, file), "utf8");
  const chunks = source.split(/(?<![\w.])test(?:\.each\([^)]*\))?\(/).slice(1);
  return chunks
    .map((chunk) => chunk.split(/^(?:(?:async\s+)?function\b|const\b|let\b|for\s*\()/m)[0])
    .filter((chunk) => gitHeavyCall.test(chunk))
    .map((chunk) => {
      const limit = [...chunk.matchAll(/timeout:\s*(\w+)/g)].at(-1)?.[1] ?? "";
      const constant = source.match(new RegExp(`^const ${limit} = ([\\d_]+);`, "m"))?.[1];
      const digits = /^\d[\d_]*$/.test(limit) ? limit : (constant ?? "0");
      return {
        name: chunk.match(/"([^"]+)"|`([^`]+)`/)?.[0] ?? chunk.slice(0, 60),
        timeout: Number(digits.replaceAll("_", "")),
      };
    });
}

// The ARK-T31 check: git-heavy tests of the given files (paths relative to the repository root)
// whose timeout is below 30 seconds.
function tooShortTests(files: string[]) {
  return files
    .flatMap(gitHeavyTests)
    .filter((testCase) => testCase.timeout < minimumTimeoutMilliseconds);
}

test("ARK-T31 every sync, merge-request and post-mr test that starts a run or builds a scenario through a helper has a timeout of at least 30 seconds", () => {
  for (const file of timeoutGuardFiles) {
    expect(gitHeavyTests(file).length, file).toBeGreaterThan(0);
  }
  expect(tooShortTests(timeoutGuardFiles)).toEqual([]);
});

// Skipped unless ARK_LOAD_PROOF=1: five parallel runs take 5+ minutes on a busy host (ARK-326).
test.skipIf(process.env.ARK_LOAD_PROOF !== "1")(
  "ARK-T32 five bun test processes of the sync and merge-request files at once all pass without a timeout",
  async () => {
    // The file list excludes test/timeouts.test.ts, so the child processes never recurse into this test.
    const processes = Array.from({ length: 5 }, () =>
      Bun.spawn(["bun", "test", ...gitHeavyFiles], {
        cwd: repositoryRoot,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      processes.map(async (child) => {
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { code, output: out + err };
      }),
    );
    for (const result of results) {
      expect(result.output).not.toMatch(/timed out/i);
      expect(result.code).toBe(0);
    }
  },
  { timeout: 300_000 },
);

test(
  "ARK-292-AC3 the preload default timeout lets a 6 second test with no timeout pass outside bunfig.toml",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "ark-292-ac3-"));
    try {
      writeFileSync(
        join(directory, "slow.test.ts"),
        `import { test } from "bun:test";\ntest("sleeps six seconds", async () => { await Bun.sleep(6000); });\n`,
      );
      const child = Bun.spawn(
        [
          "bun",
          "test",
          "--preload",
          join(repositoryRoot, "test/tmpdir-preload.ts"),
          "./slow.test.ts",
        ],
        { cwd: directory, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(out + err).not.toMatch(/timed out/i);
      expect(code).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

const loadProofFiles = [
  "test/worktree.test.ts",
  "test/run.test.ts",
  "test/sync.test.ts",
  "test/merge-request.test.ts",
  "test/tooling.test.ts",
];
const loadProofPattern = "ARK-276-AC4|ARK-278-AC3|ARK-165-AC3|ARK-165-AC4|ARK-155|ARK-175";
const loadProofRuns = 20;
const loadProofConcurrency = 4;

// Skipped unless ARK_LOAD_PROOF=1: it saturates the host CPU for minutes.
test.skipIf(process.env.ARK_LOAD_PROOF !== "1")(
  "ARK-292-AC2 heavy: the timeout-prone tests pass 20 times under 2x CPU busy-loop load",
  async () => {
    const loadProcesses = Array.from({ length: 2 * availableParallelism() }, () =>
      Bun.spawn(["sh", "-c", "while :; do :; done"], { stdout: "ignore", stderr: "ignore" }),
    );
    try {
      const results: { code: number; output: string }[] = [];
      for (let start = 0; start < loadProofRuns; start += loadProofConcurrency) {
        const batch = Array.from(
          { length: Math.min(loadProofConcurrency, loadProofRuns - start) },
          () =>
            Bun.spawn(["bun", "test", ...loadProofFiles, "-t", loadProofPattern], {
              cwd: repositoryRoot,
              stdout: "pipe",
              stderr: "pipe",
            }),
        );
        results.push(
          ...(await Promise.all(
            batch.map(async (child) => {
              const [out, err, code] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
              ]);
              return { code, output: out + err };
            }),
          )),
        );
      }
      expect(results).toHaveLength(loadProofRuns);
      for (const result of results) {
        expect(result.output).not.toMatch(/timed out/i);
        expect(result.code).toBe(0);
      }
    } finally {
      for (const loadProcess of loadProcesses) loadProcess.kill();
    }
  },
  { timeout: 3_600_000 },
);

test("ARK-292-AC3 every test file calls setDefaultTimeout with at least 30_000, because bun applies the preload default to the first file only", () => {
  const missing = [...new Bun.Glob("test/*.test.ts").scanSync({ cwd: repositoryRoot })].filter(
    (file) => {
      const source = readFileSync(join(repositoryRoot, file), "utf8");
      const milliseconds = Number(
        source.match(/^setDefaultTimeout\(([\d_]+)\);/m)?.[1]?.replaceAll("_", ""),
      );
      return !(milliseconds >= minimumTimeoutMilliseconds);
    },
  );
  expect(missing).toEqual([]);
});

test(
  "ARK-292-AC4 without ARK_LOAD_PROOF the heavy AC2 test is skipped",
  async () => {
    const env = { ...process.env };
    delete env.ARK_LOAD_PROOF;
    // -t filters out every other test in the file, so the child never re-runs this test.
    const child = Bun.spawn(["bun", "test", "test/timeouts.test.ts", "-t", "ARK-292-AC2 heavy"], {
      cwd: repositoryRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(out + err).toMatch(/\b1 skip\b/);
    expect(out + err).not.toMatch(/\b[1-9]\d* pass\b/);
  },
  { timeout: 60_000 },
);

// Runs this file in a child process, keeping only the ARK-T32 test.
async function runFiveProcessTest(env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, "test", "test/timeouts.test.ts", "-t", "ARK-T32"], {
    cwd: repositoryRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: out + err };
}

test(
  "ARK-T36 the five-process load test is skipped without ARK_LOAD_PROOF and runs with ARK_LOAD_PROOF=1",
  async () => {
    const withoutVariable = { ...process.env };
    delete withoutVariable.ARK_LOAD_PROOF;
    const skipped = await runFiveProcessTest(withoutVariable);
    expect(skipped.code).toBe(0);
    expect(skipped.output).toMatch(/\b1 skip\b/);
    expect(skipped.output).not.toMatch(/\b[1-9]\d* pass\b/);

    // A fake `bun` first on PATH logs each call and exits 0, so the five "processes" cost nothing.
    const directory = mkdtempSync(join(tmpdir(), "ark-t19-"));
    try {
      const logFile = join(directory, "calls.log");
      const fakeBun = join(directory, "bun");
      writeFileSync(fakeBun, `#!/bin/sh\necho "$@" >> "${logFile}"\n`, { mode: 0o755 });
      const ran = await runFiveProcessTest({
        ...process.env,
        ARK_LOAD_PROOF: "1",
        PATH: `${directory}:${process.env.PATH}`,
      });
      expect(ran.code).toBe(0);
      expect(ran.output).toMatch(/\b1 pass\b/);
      expect(ran.output).not.toMatch(/\b[1-9]\d* skip\b/);
      const calls = readFileSync(logFile, "utf8").trim().split("\n");
      expect(calls).toEqual(Array(5).fill("test test/sync.test.ts test/merge-request.test.ts"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

// Runs the given file in a child process, keeping only the ARK-T31 test (the owning check). The
// pattern is anchored because the title of ARK-T30 also contains "ARK-T31".
async function runOwningCheck(cwd: string, file: string) {
  const env = { ...process.env };
  delete env.ARK_LOAD_PROOF;
  const child = Bun.spawn([process.execPath, "test", file, "-t", "^ARK-T31 "], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: out + err };
}

// Runs the ARK-T31 check of a copy of this file in a temporary repository whose guard file list is
// test/fixture.test.ts, written from the given lines.
async function runCheckOnFixture(fixtureLines: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "ark-t30-"));
  try {
    mkdirSync(join(directory, "test"));
    writeFileSync(join(directory, "test", "fixture.test.ts"), [...fixtureLines, ""].join("\n"));
    const source = readFileSync(join(repositoryRoot, "test/timeouts.test.ts"), "utf8");
    const copy = source.replace(
      /^const timeoutGuardFiles = \[[^\]]*\];$/m,
      'const timeoutGuardFiles = ["test/fixture.test.ts"];',
    );
    expect(copy).not.toBe(source);
    writeFileSync(join(directory, "test", "timeouts.test.ts"), copy);
    return await runOwningCheck(directory, "test/timeouts.test.ts");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test(
  "ARK-T30 the every-file timeout check of ARK-T31 refuses a git-heavy test with a short, missing or unresolved timeout and passes one with a limit",
  async () => {
    // Without ARK_LOAD_PROOF the owning check runs and passes on the real files.
    const normal = await runOwningCheck(repositoryRoot, "test/timeouts.test.ts");
    expect(normal.code).toBe(0);
    expect(normal.output).toMatch(/\b1 pass\b/);
    expect(normal.output).not.toMatch(/\b[1-9]\d* skip\b/);

    // 1. A limit below the minimum is refused; the boundary of exactly 30 s is not.
    const shortLimit = await runCheckOnFixture([
      'test("opens a merge request", () => { startRun(); }, { timeout: 10_000 });',
      'test("syncs a scenario", () => { scenario(); }, { timeout: 30_000 });',
    ]);
    expect(shortLimit.code).not.toBe(0);
    expect(shortLimit.output).toContain("opens a merge request");
    expect(shortLimit.output).toContain('"timeout": 10000');
    expect(shortLimit.output).not.toContain("syncs a scenario");

    // 2. Each helper call without a limit is refused, including the last test of the file.
    const noLimit = await runCheckOnFixture([
      'test("generated scenario without a limit", () => { generatedScenario(); });',
      'test("submodule run without a limit", () => { submoduleRun(); });',
      'test("open run without a limit", () => { openRun(); });',
    ]);
    expect(noLimit.code).not.toBe(0);
    expect(noLimit.output).toContain("generated scenario without a limit");
    expect(noLimit.output).toContain("submodule run without a limit");
    expect(noLimit.output).toContain("open run without a limit");

    // 3. A named constant below the minimum is resolved and refused.
    const shortConstant = await runCheckOnFixture([
      "const SHORT = 10_000;",
      'test("generated scenario with a short constant", () => { generatedScenario(); }, { timeout: SHORT });',
    ]);
    expect(shortConstant.code).not.toBe(0);
    expect(shortConstant.output).toContain("generated scenario with a short constant");
    expect(shortConstant.output).toContain('"timeout": 10000');

    // 4. A name that the file does not define fails the guard; it never passes it.
    const unresolvedName = await runCheckOnFixture([
      'test("submodule run with an unresolved name", () => { submoduleRun(); }, { timeout: MISSING });',
    ]);
    expect(unresolvedName.code).not.toBe(0);
    expect(unresolvedName.output).toContain("submodule run with an unresolved name");

    // 5. Every limit present passes, and a helper definition between tests flags no test.
    const everyLimit = await runCheckOnFixture([
      "const LONG = 120_000;",
      'test("generated scenario with a long constant", () => { generatedScenario(); }, { timeout: LONG });',
      'test("submodule run at the boundary", () => { submoduleRun(); }, { timeout: 30_000 });',
      'test("open run with a long limit", () => { openRun(); }, { timeout: 120_000 });',
      'test("pure text scan", () => { expect(1).toBe(1); });',
      "function testedRun() { return scenario(); }",
    ]);
    expect(everyLimit.code).toBe(0);
    expect(everyLimit.output).toMatch(/\b1 pass\b/);

    // 6. A test without a limit never borrows the limit of a later loop-declared test, and a
    // loop-declared test without a limit is split out.
    const borrowedLimit = await runCheckOnFixture([
      'test("alpha borrows a later limit", () => { generatedScenario(); });',
      'for (const n of [1]) { test("gamma loop with a limit", () => { scenario(); }, { timeout: 30_000 }); }',
      'for (const n of [1]) { test("beta loop without a limit", () => { openRun(); }); }',
    ]);
    expect(borrowedLimit.code).not.toBe(0);
    expect(borrowedLimit.output).toContain("alpha borrows a later limit");
    expect(borrowedLimit.output).toContain("beta loop without a limit");
    expect(borrowedLimit.output).not.toContain("gamma loop with a limit");
  },
  { timeout: 180_000 },
);
