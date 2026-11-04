import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("ARK-237-AC1 every sync and merge-request test that starts a run or builds a scenario has a timeout of at least 30 seconds", () => {
  const tests = gitHeavyFiles.flatMap(gitHeavyTests);
  expect(tests.length).toBeGreaterThan(0);
  const tooShort = tests.filter((testCase) => testCase.timeout < minimumTimeoutMilliseconds);
  expect(tooShort).toEqual([]);
});

test(
  "ARK-237-AC2 five bun test processes of the sync and merge-request files at once all pass without a timeout",
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
