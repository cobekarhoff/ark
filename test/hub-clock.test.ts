import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const hubTestFiles = [
  "test/map-timeline.test.ts",
  "test/hub-views.test.ts",
  "test/run-detail.test.ts",
  "test/ui.test.ts",
];

/**
 * The parent `bun test` process runs every test file in one process, and earlier files leave fake
 * `orca`/`glab` PATH entries and ORCA_*, TEST_*, FAKE_*, ARK_* variables behind. The child must not
 * inherit that residue, so it gets the environment minus those, plus the frozen clock.
 */
function childEnvironment(arkNow: string): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(ORCA_|TEST_|FAKE_|GH_CHECKS_|ARK_)/.test(name)) environment[name] = value;
  }
  environment.PATH = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => !entry.startsWith(tmpdir()))
    .join(delimiter);
  environment.ARK_NOW = arkNow;
  return environment;
}

/** Runs the hub test files in a child bun test with the clock frozen at `arkNow`. */
async function runHubTests(arkNow: string): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(["bun", "test", ...hubTestFiles], {
    cwd: repositoryRoot,
    env: childEnvironment(arkNow),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

/** The `(fail)` lines of a bun test report, so a failure names the tests instead of dumping the report. */
function failedTests(output: string): string[] {
  return output.split("\n").filter((line) => line.startsWith("(fail)"));
}

// The children run with ARK_NOW set, so skipping then stops this file from running itself again.
describe.skipIf((process.env.ARK_NOW ?? "") !== "")("hub tests at a frozen clock", () => {
  test(
    "ARK-230-AC1 hub tests pass with the clock frozen at Monday 00:00 UTC",
    { timeout: 600_000 },
    async () => {
      const { exitCode, output } = await runHubTests("2026-11-02T00:00:00Z");
      expect(failedTests(output)).toEqual([]);
      expect(output).toMatch(/\b[1-9]\d* pass\b/);
      expect(output).toMatch(/\b0 fail\b/);
      expect(exitCode).toBe(0);
    },
  );

  test(
    "ARK-230-AC2 hub tests pass with the clock frozen at Sunday 23:59 UTC",
    { timeout: 600_000 },
    async () => {
      const { exitCode, output } = await runHubTests("2026-11-01T23:59:00Z");
      expect(failedTests(output)).toEqual([]);
      expect(output).toMatch(/\b[1-9]\d* pass\b/);
      expect(output).toMatch(/\b0 fail\b/);
      expect(exitCode).toBe(0);
    },
  );
});
