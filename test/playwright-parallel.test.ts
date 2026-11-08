import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(900_000);

const root = resolve(import.meta.dir, "..");
// Playwright-spawning files only; never this file, so the child runs cannot start this test again.
const files = ["test/playwright-migration.test.ts", "test/evidence-test-run.test.ts"];

function bunTest(extraArgs: string[]) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.JEST_WORKER_ID;
  const result = Bun.spawnSync(["bun", "test", ...extraArgs, ...files], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  const count = (label: string) =>
    Number(output.match(new RegExp(`^\\s*(\\d+) ${label}$`, "m"))?.[1]);
  return { code: result.exitCode, output, pass: count("pass"), fail: count("fail") };
}

test("ARK-T100 ARK-330/AC3 a test that spawns Playwright passes inside a bun test parallel worker", () => {
  const serial = bunTest([]);
  expect(serial.code, serial.output).toBe(0);
  const parallel = bunTest(["--parallel"]);
  expect(parallel.code, parallel.output).toBe(0);
  expect(parallel.fail).toBe(0);
  expect(parallel.pass).toBe(serial.pass);
  expect(parallel.pass).toBeGreaterThan(0);
  expect(parallel.output).not.toContain("excluded from Jest test runs");
});
