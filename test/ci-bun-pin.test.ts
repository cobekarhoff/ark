import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
const repositoryRoot = join(import.meta.dir, "..");

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

// ARK-479: Bun 1.4.0 loses the exit of a `spawnSync` child on the Linux runner; 1.4.4 has the fix.
const floor = "1.4.4";

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };

test("ARK-T570 every CI job that runs bun installs the same exact Bun version, and it is at or above the floor", async () => {
  const ci = Bun.YAML.parse(
    await Bun.file(join(repositoryRoot, ".github/workflows/ci.yml")).text(),
  ) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const jobs = Object.entries(ci.jobs);
  const runsBun = jobs.filter(([, job]) =>
    job.steps.some((step) => /^bunx? /.test(step.run ?? "")),
  );
  const pins = new Map(
    jobs.flatMap(([name, job]) => {
      const setup = job.steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
      return setup ? [[name, String(setup.with?.["bun-version"])] as const] : [];
    }),
  );
  // a job that runs bun without a pinned setup-bun step is named here
  expect(runsBun.map(([name]) => name).filter((name) => !pins.has(name))).toEqual([]);
  expect(runsBun.length).toBeGreaterThan(1);
  for (const [name] of runsBun) {
    const version = pins.get(name)!;
    expect(version, `job ${name} bun-version`).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      Bun.semver.order(version, floor),
      `job ${name} pins ${version}, floor ${floor}`,
    ).toBeGreaterThanOrEqual(0);
  }
  expect(
    new Set(runsBun.map(([name]) => pins.get(name))).size,
    `pins ${JSON.stringify([...pins])}`,
  ).toBe(1);
});
