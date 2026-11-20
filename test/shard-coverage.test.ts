import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(120_000);

const repositoryRoot = join(import.meta.dir, "..");

type CiStep = { uses?: string; run?: string };
type CiJob = {
  if?: string;
  "continue-on-error"?: unknown;
  needs?: string | string[];
  strategy?: { matrix?: { shard?: unknown[] } };
  steps: CiStep[];
};
type CiWorkflow = {
  on: { push?: { branches?: string[] }; pull_request?: Record<string, unknown> | null };
  jobs: Record<string, CiJob>;
};

const workflow = Bun.YAML.parse(
  readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
) as CiWorkflow;
const jobEntries = Object.entries(workflow.jobs);
const runLines = (job: CiJob): string[] =>
  job.steps.flatMap((step) => (step.run ? [step.run] : []));

const shardEntry = jobEntries.find(([, job]) => job.strategy?.matrix);
const staticEntry = jobEntries.find(([, job]) => runLines(job).includes("bun run typecheck"));
const aggregateEntry = jobEntries.find(([name]) => name === "test");
const shardStep = shardEntry
  ? runLines(shardEntry[1]).find((line) => line.startsWith("bun test "))
  : "";

/** The files that `bun test` finds on the disk: every `*.test.ts` except node_modules and test/pw. */
function filesOnDisk(): string[] {
  return [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: repositoryRoot })]
    .filter((path) => !path.includes("node_modules/") && !path.startsWith("test/pw/"))
    .sort();
}

/**
 * Run the real `bun test` of the shard step for shard `shard` in `directory`, as a listing: no test name
 * matches, so Bun selects the shard's files, loads them and runs nothing. `--parallel` is dropped
 * (the selection does not depend on it); `timingsFile` replaces the step's `--timings` value.
 */
async function selectShard(
  directory: string,
  shard: number,
  timingsFile: string | null,
): Promise<{ files: string[]; line: string }> {
  const flags = shardStep!
    .replace(/^bun test /, "")
    .replaceAll("${{ matrix.shard }}", String(shard))
    .split(/\s+/)
    .filter((flag) => flag !== "--parallel")
    .map((flag) =>
      timingsFile && flag.startsWith("--timings=") ? `--timings=${timingsFile}` : flag,
    );
  const report = join(mkdtempSync(join(tmpdir(), "ark-shard-report-")), "report.xml");
  const child = Bun.spawn(
    [
      "bun",
      "test",
      ...flags,
      "--test-name-pattern",
      "zzz-no-test-has-this-name",
      "--reporter=junit",
      `--reporter-outfile=${report}`,
    ],
    { cwd: directory, env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
  );
  const [output] = await Promise.all([
    new Response(child.stderr)
      .text()
      .then(async (error) => error + (await new Response(child.stdout).text())),
    child.exited,
  ]);
  const files = [
    ...readFileSync(report, "utf8").matchAll(/<testsuite name="([^"]+\.test\.ts)"/g),
  ].map((match) => match[1]);
  rmSync(dirname(report), { recursive: true, force: true });
  return {
    files,
    line: /--shard=\d+\/\d+: running \d+\/\d+ test files?/.exec(output)?.[0] ?? output,
  };
}

/** Which of `all` appear in no list, and which appear in more than one. */
function coverageProblems(
  all: string[],
  lists: string[][],
): { missing: string[]; twice: string[] } {
  const counts = new Map(all.map((file) => [file, 0]));
  for (const file of lists.flat()) counts.set(file, (counts.get(file) ?? 0) + 1);
  return {
    missing: [...counts].filter(([, count]) => count === 0).map(([file]) => file),
    twice: [...counts].filter(([, count]) => count > 1).map(([file]) => file),
  };
}

test("ARK-T697 the CI workflow runs on every pull request and every push to main, and its jobs have the shard layout", () => {
  expect(workflow.on.push?.branches).toContain("main");
  expect(workflow.on).toHaveProperty("pull_request");
  expect(Object.keys(workflow.on.pull_request ?? {}), "pull_request filters").toEqual([]);

  expect(shardEntry, "a job with strategy.matrix").toBeDefined();
  expect(staticEntry, "a job that runs bun run typecheck").toBeDefined();
  const [shardName, shardJob] = shardEntry!;
  const [staticName, staticJob] = staticEntry!;
  expect(shardName).not.toBe("test");
  expect([...shardJob.strategy!.matrix!.shard!].map(Number).sort((a, b) => a - b)).toEqual([
    1, 2, 3, 4,
  ]);
  expect(shardStep).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/4(\s|$)/);
  expect(shardStep).toContain("--parallel");
  const timingsPath = /--timings=(\S+)/.exec(shardStep!)?.[1];
  expect(timingsPath, "--timings flag of the shard step").toBeDefined();
  expect(Bun.file(join(repositoryRoot, timingsPath!)).size, timingsPath).toBeGreaterThan(0);

  const shardRuns = runLines(shardJob);
  const install = shardRuns.indexOf("bun install --frozen-lockfile");
  const browser = shardRuns.indexOf("bunx playwright install --with-deps chromium");
  const testStep = shardRuns.indexOf(shardStep!);
  expect(install).toBeGreaterThanOrEqual(0);
  expect(browser).toBeGreaterThan(install);
  expect(testStep).toBeGreaterThan(browser);
  for (const job of [shardJob, staticJob]) {
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
  }

  // Branch protection of main requires the context `test`: a matrix job would report `test (1)`.
  expect(aggregateEntry, "a job named test").toBeDefined();
  const aggregate = aggregateEntry![1];
  expect(aggregate.strategy).toBeUndefined();
  expect(new Set([aggregate.needs].flat())).toEqual(new Set([shardName, staticName]));
  expect(aggregate.if).toContain("always()");
  expect(
    aggregate.steps.filter(
      (step) => /^bunx? /.test(step.run ?? "") || step.uses?.includes("setup-bun"),
    ),
  ).toEqual([]);
});

test("ARK-T697 the timings file is a Bun timings file with one recorded time for each of existing files", () => {
  const timingsPath = /--timings=(\S+)/.exec(shardStep!)![1];
  const timings = JSON.parse(readFileSync(join(repositoryRoot, timingsPath), "utf8")) as {
    version: number;
    files: Record<string, number>;
  };
  expect(timings.version).toBe(1);
  const entries = Object.entries(timings.files);
  expect(entries.length, "recorded files").toBeGreaterThan(0);
  expect(
    entries.filter(([, milliseconds]) => !Number.isFinite(milliseconds) || milliseconds < 0),
  ).toEqual([]);
  expect(entries.some(([, milliseconds]) => milliseconds > 0)).toBe(true);
  const onDisk = new Set(filesOnDisk());
  // a timings entry for a deleted or renamed file hides a gap: name it
  expect(entries.map(([path]) => path).filter((path) => !onDisk.has(path))).toEqual([]);
});

test("ARK-T697 the 4 shards of ci.yml together list every test file on disk exactly once and none is empty", async () => {
  const onDisk = filesOnDisk();
  expect(onDisk.length).toBeGreaterThan(0);
  const shards = await Promise.all(
    [1, 2, 3, 4].map((shard) => selectShard(repositoryRoot, shard, null)),
  );
  const problems = coverageProblems(
    onDisk,
    shards.map((shard) => shard.files),
  );
  expect(problems).toEqual({ missing: [], twice: [] });
  shards.forEach((shard, index) => {
    expect(shard.files.length, `shard ${index + 1} is empty`).toBeGreaterThan(0);
    expect(shard.line).toBe(
      `--shard=${index + 1}/4: running ${shard.files.length}/${onDisk.length} test files`,
    );
  });
});

test("ARK-T697 a test file missing from the timings file runs in exactly one shard, and a timings entry with no file changes nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-shard-scratch-"));
  try {
    const files = Array.from({ length: 9 }, (_, index) => `test/f${index + 1}.test.ts`);
    for (const file of files) {
      mkdirSync(join(directory, "test"), { recursive: true });
      writeFileSync(
        join(directory, file),
        'import { expect, test } from "bun:test";\ntest("passes", () => expect(1).toBe(1));\n',
      );
    }
    const timings = {
      version: 1,
      files: {
        ...Object.fromEntries(files.slice(0, 8).map((file, index) => [file, 1000 * (index + 1)])),
        "test/deleted.test.ts": 5000,
      },
    };
    writeFileSync(join(directory, "timings.json"), JSON.stringify(timings));
    const shards = await Promise.all(
      [1, 2, 3, 4].map((shard) => selectShard(directory, shard, join(directory, "timings.json"))),
    );
    expect(
      coverageProblems(
        files,
        shards.map((shard) => shard.files),
      ),
    ).toEqual({ missing: [], twice: [] });
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual(files);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ARK-T697 the required check test exits 0 only when every needed job succeeded", () => {
  const [shardName] = shardEntry!;
  const [staticName] = staticEntry!;
  const line = runLines(aggregateEntry![1]).join("\n");
  const exitOf = (results: Record<string, string>) => {
    const script = line.replace(
      /\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}/g,
      (_, job: string) => results[job] ?? `UNKNOWN-${job}`,
    );
    expect(script, "an expression the test does not replace").not.toContain("${{");
    return Bun.spawnSync(["bash", "-e", "-c", script], { stderr: "pipe", stdout: "pipe" }).exitCode;
  };
  expect(exitOf({ [staticName]: "success", [shardName]: "success" })).toBe(0);
  for (const result of ["failure", "cancelled", "skipped"]) {
    for (const [failedJob, otherJob] of [
      [staticName, shardName],
      [shardName, staticName],
    ]) {
      expect(
        exitOf({ [failedJob]: result, [otherJob]: "success" }),
        `${failedJob} ${result}`,
      ).not.toBe(0);
    }
  }
});
