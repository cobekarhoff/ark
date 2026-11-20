import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(120_000);

const repositoryRoot = join(import.meta.dir, "..");

type CiJob = { strategy?: { matrix?: { shard?: unknown[] } }; steps: { run?: string }[] };
type Listing = {
  config: { workers: number; shard: { current: number; total: number } | null };
  suites: ListedSuite[];
};
type ListedSuite = { suites?: ListedSuite[]; specs?: { id: string; file: string }[] };

/** `playwright test --list` of `command` under CI=true: the resolved config and every listed spec id. */
function list(command: string): {
  config: Listing["config"];
  specs: { id: string; file: string }[];
} {
  const env: Record<string, string | undefined> = { ...process.env, CI: "true" };
  // a junit report path would replace the reporter of the config
  delete env.PLAYWRIGHT_JUNIT_OUTPUT_FILE;
  // bun test --parallel workers set JEST_WORKER_ID; Playwright refuses to start when it sees it
  delete env.JEST_WORKER_ID;
  const result = Bun.spawnSync(["bash", "-c", `${command} --list --reporter=json`], {
    cwd: repositoryRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const listing = JSON.parse(result.stdout.toString()) as Listing;
  const collect = (suite: ListedSuite): { id: string; file: string }[] => [
    ...(suite.specs ?? []),
    ...(suite.suites ?? []).flatMap(collect),
  ];
  return { config: listing.config, specs: listing.suites.flatMap(collect) };
}

test("ARK-T698 the Playwright step of ci.yml runs with 4 workers under CI and lists every spec of test/pw exactly once", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
  ) as { jobs: Record<string, CiJob> };
  const job = Object.values(workflow.jobs).find((candidate) =>
    candidate.steps.some((step) => step.run?.includes("playwright test")),
  )!;
  expect(job, "a job with a playwright test step").toBeDefined();
  const command = job.steps.find((step) => step.run?.includes("playwright test"))!.run!;
  for (const filter of [
    "--grep",
    "--grep-invert",
    "--project",
    "--last-failed",
    "--only-changed",
  ]) {
    expect(command, `filter ${filter}`).not.toContain(filter);
  }
  // the command is `bunx playwright test` plus flags, with no file argument
  expect(command.replace(/--[\w-]+(=\S+)?/g, "").trim()).toBe("bunx playwright test");

  const shards = job.strategy?.matrix?.shard ?? [null];
  const runs = shards.map((shard) =>
    list(command.replaceAll("${{ matrix.shard }}", String(shard))),
  );
  for (const run of runs) {
    if (run.config.shard) expect(run.config.shard.total, "shard total").toBe(2);
    else expect(run.config.workers, "workers under CI=true").toBe(4);
  }

  // control: the unfiltered list of the whole suite
  const everything = list("bunx playwright test");
  const listed = runs.flatMap((run) => run.specs.map((spec) => spec.id));
  expect(new Set(listed).size, "a spec listed twice").toBe(listed.length);
  expect(listed.sort()).toEqual(everything.specs.map((spec) => spec.id).sort());

  const files = [...new Bun.Glob("test/pw/*.pw.ts").scanSync({ cwd: repositoryRoot })].map((path) =>
    path.replace("test/pw/", ""),
  );
  expect(files.length).toBeGreaterThan(0);
  expect([...new Set(everything.specs.map((spec) => spec.file))].sort()).toEqual(files.sort());
});
