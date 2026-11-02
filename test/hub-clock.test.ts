import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const hubTestFiles = [
  "test/map-timeline.test.ts",
  "test/hub-views.test.ts",
  "test/run-detail.test.ts",
  "test/ui.test.ts",
];

/** Runs the hub test files in a child bun test with the clock frozen at `arkNow`. */
async function runHubTests(arkNow: string): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(["bun", "test", ...hubTestFiles], {
    cwd: repositoryRoot,
    env: { ...process.env, ARK_NOW: arkNow },
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

// The children run with ARK_NOW set, so skipping then stops this file from running itself again.
describe.skipIf((process.env.ARK_NOW ?? "") !== "")("hub tests at a frozen clock", () => {
  test(
    "ARK-230-AC1 hub tests pass with the clock frozen at Monday 00:00 UTC",
    { timeout: 600_000 },
    async () => {
      const { exitCode, output } = await runHubTests("2026-11-02T00:00:00Z");
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
      expect(output).toMatch(/\b[1-9]\d* pass\b/);
      expect(output).toMatch(/\b0 fail\b/);
      expect(exitCode).toBe(0);
    },
  );
});
