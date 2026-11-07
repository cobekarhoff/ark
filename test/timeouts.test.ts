import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const repositoryRoot = resolve(import.meta.dir, "..");
const minimumTimeoutMilliseconds = 30_000;
const gitHeavyFiles = ["test/sync.test.ts", "test/merge-request.test.ts"];

// Splits a test file into the source of each top-level `test(` call. Tests that call neither
// startRun( nor scenario( (the text-scan tests) are skipped.
function gitHeavyTests(file: string): { name: string; timeout: number }[] {
  const source = readFileSync(join(repositoryRoot, file), "utf8");
  const chunks = source.split(/^test(?:\.each\([^)]*\))?\(/m).slice(1);
  return chunks
    .filter((chunk) => /\b(startRun|scenario)\(/.test(chunk))
    .map((chunk) => ({
      name: chunk.match(/"([^"]+)"|`([^`]+)`/)?.[0] ?? chunk.slice(0, 60),
      timeout: Number((chunk.match(/timeout:\s*([\d_]+)/)?.[1] ?? "0").replaceAll("_", "")),
    }));
}

// The ARK-T31 check: git-heavy tests of the given files (paths relative to the repository root)
// whose timeout is below 30 seconds.
function tooShortTests(files: string[]) {
  return files
    .flatMap(gitHeavyTests)
    .filter((testCase) => testCase.timeout < minimumTimeoutMilliseconds);
}

test("ARK-T31 every sync and merge-request test that starts a run or builds a scenario has a timeout of at least 30 seconds", () => {
  expect(gitHeavyFiles.flatMap(gitHeavyTests).length).toBeGreaterThan(0);
  expect(tooShortTests(gitHeavyFiles)).toEqual([]);
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

test("ARK-292-AC2 the recorded load proof passed", () => {
  const evidence = readFileSync(join(repositoryRoot, "docs/evidence/ARK-292-ac2.md"), "utf8");
  expect(evidence).toMatch(/^proof: passed$/m);
});

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

// Runs the given file in a child process, keeping only the ARK-T31 test (the owning check).
async function runOwningCheck(cwd: string, file: string) {
  const env = { ...process.env };
  delete env.ARK_LOAD_PROOF;
  const child = Bun.spawn([process.execPath, "test", file, "-t", "ARK-T31"], {
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

test(
  "ARK-T30 the every-file timeout check refuses a sync-style test with a 10 second timeout",
  async () => {
    // Without ARK_LOAD_PROOF the owning check runs and passes on the real sync and merge-request files.
    const normal = await runOwningCheck(repositoryRoot, "test/timeouts.test.ts");
    expect(normal.code).toBe(0);
    expect(normal.output).toMatch(/\b1 pass\b/);
    expect(normal.output).not.toMatch(/\b[1-9]\d* skip\b/);

    // A copy of this file in a temp repository checks a fixture instead of the real files.
    const directory = mkdtempSync(join(tmpdir(), "ark-t20-"));
    try {
      mkdirSync(join(directory, "test"));
      writeFileSync(
        join(directory, "test", "fixture.test.ts"),
        [
          'test("opens a merge request", () => { startRun(); }, { timeout: 10_000 });',
          'test("syncs a scenario", () => { scenario(); }, { timeout: 30_000 });',
          "",
        ].join("\n"),
      );
      const source = readFileSync(join(repositoryRoot, "test/timeouts.test.ts"), "utf8");
      const copy = source.replace(
        /^const gitHeavyFiles = \[[^\]]*\];$/m,
        'const gitHeavyFiles = ["test/fixture.test.ts"];',
      );
      expect(copy).not.toBe(source);
      writeFileSync(join(directory, "test", "timeouts.test.ts"), copy);
      const refused = await runOwningCheck(directory, "test/timeouts.test.ts");
      expect(refused.code).not.toBe(0);
      expect(refused.output).toContain("opens a merge request");
      expect(refused.output).toContain('"timeout": 10000');
      expect(refused.output).not.toContain("syncs a scenario");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);
