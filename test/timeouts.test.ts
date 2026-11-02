import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
