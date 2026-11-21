import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  strategy?: { matrix?: Record<string, unknown[]> };
  steps: CiStep[];
};
type CiWorkflow = {
  on: {
    push?: { branches?: string[] };
    pull_request?: Record<string, unknown> | null;
  };
  jobs: Record<string, CiJob>;
};

const workflow = Bun.YAML.parse(
  readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
) as CiWorkflow;
const bunfig = Bun.TOML.parse(readFileSync(join(repositoryRoot, "bunfig.toml"), "utf8")) as {
  test: { pathIgnorePatterns: string[] };
};
const bunfigIgnorePatterns = bunfig.test.pathIgnorePatterns;
const jobEntries = Object.entries(workflow.jobs);
const runLines = (job: CiJob): string[] =>
  job.steps.flatMap((step) => (step.run ? [step.run] : []));
const bunTestStep = (job: CiJob): string | undefined =>
  runLines(job).find((line) => line.startsWith("bun test "));

// Jobs are found by what they run, not by their order.
const shardEntry = jobEntries.find(([, job]) => bunTestStep(job)?.includes("--shard="));
const hubEntry = jobEntries.find(([name, job]) => name !== shardEntry?.[0] && bunTestStep(job));
const staticEntry = jobEntries.find(([, job]) => runLines(job).includes("bun run typecheck"));
const aggregateEntry = jobEntries.find(([name]) => name === "test");
const shardStep = shardEntry ? bunTestStep(shardEntry[1]) : "";
const hubStep = hubEntry ? bunTestStep(hubEntry[1]) : "";
/** The hub timing files: the shard step's ignored paths that the bunfig does not already ignore. */
const hubPaths = [...(shardStep ?? "").matchAll(/--path-ignore-patterns=(\S+)/g)]
  .map((match) => match[1])
  .filter((pattern) => !bunfigIgnorePatterns.includes(pattern))
  .sort();
/** One value for each matrix entry of the hub timing job: a space-separated list of paths. */
const hubMatrixValues = Object.values(hubEntry?.[1].strategy?.matrix ?? {}).flat() as string[];

/** The files that `bun test` finds on the disk: every `*.test.ts` except node_modules and test/pw. */
function filesOnDisk(): string[] {
  return [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: repositoryRoot })]
    .filter((path) => !path.includes("node_modules/") && !path.startsWith("test/pw/"))
    .sort();
}

/**
 * Run the real `bun test` with `flags` in `directory`, as a listing: no test name matches, so Bun
 * selects the files, loads them and runs nothing. Returns the files Bun listed and its
 * `--shard=k/N: running a/b test files` line, if any.
 */
async function listFiles(
  directory: string,
  flags: string[],
): Promise<{ files: string[]; line: string }> {
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
  ].map((match) => match[1].replace(/^\.\//, ""));
  rmSync(dirname(report), { recursive: true, force: true });
  return {
    files,
    line: /--shard=\d+\/\d+: running \d+\/\d+ test files?/.exec(output)?.[0] ?? output,
  };
}

/**
 * The shard step's flags for shard `shard`. `--parallel` is dropped (the selection does not depend
 * on it); `timingsFile` replaces the step's `--timings` value.
 */
function selectShard(directory: string, shard: number, timingsFile: string | null) {
  const flags = shardStep!
    .replace(/^bun test /, "")
    .replaceAll("${{ matrix.shard }}", String(shard))
    .split(/\s+/)
    .filter((flag) => flag !== "--parallel")
    .map((flag) =>
      timingsFile && flag.startsWith("--timings=") ? `--timings=${timingsFile}` : flag,
    );
  return listFiles(directory, flags);
}

/** The hub timing step's flags and paths for one matrix value. */
function selectHubEntry(directory: string, matrixValue: string) {
  const flags = hubStep!
    .replace(/^bun test /, "")
    .replace(/\$\{\{\s*matrix\.\w+\s*\}\}/g, matrixValue)
    .split(/\s+/);
  return listFiles(directory, flags);
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

test("ARK-T697 the CI workflow runs on every pull request and every push to main, and its jobs have the shard and hub timing layout", () => {
  expect(workflow.on.push?.branches).toContain("main");
  expect(workflow.on).toHaveProperty("pull_request");
  expect(Object.keys(workflow.on.pull_request ?? {}), "pull_request filters").toEqual([]);

  expect(shardEntry, "a job whose bun test step has --shard").toBeDefined();
  expect(hubEntry, "a second job that runs bun test").toBeDefined();
  expect(staticEntry, "a job that runs bun run typecheck").toBeDefined();
  const [shardName, shardJob] = shardEntry!;
  const [hubName, hubJob] = hubEntry!;
  const [staticName, staticJob] = staticEntry!;
  expect(shardName).not.toBe("test");
  expect(hubName).not.toBe("test");
  expect(
    [...(shardJob.strategy!.matrix!.shard as unknown[])].map(Number).sort((a, b) => a - b),
  ).toEqual([1, 2, 3, 4]);
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

  // The hub timing files starve each other under --parallel: the job runs them in one serial process.
  const hubRuns = runLines(hubJob);
  expect(hubRuns.indexOf("bun install --frozen-lockfile")).toBeGreaterThanOrEqual(0);
  expect(hubRuns.indexOf(hubStep!)).toBeGreaterThan(
    hubRuns.indexOf("bun install --frozen-lockfile"),
  );
  expect(hubStep).not.toContain("--parallel");
  expect(hubStep).not.toContain("--shard");
  expect(hubPaths.length, "hub timing paths ignored by the shard step").toBeGreaterThan(0);
  // Bun exits 0 and skips a path that does not exist: a renamed hub timing file would go unnoticed.
  expect(hubPaths.filter((path) => !existsSync(join(repositoryRoot, path)))).toEqual([]);

  for (const job of [shardJob, hubJob, staticJob]) {
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
  }

  // Branch protection of main requires the context `test`: a matrix job would report `test (1)`.
  expect(aggregateEntry, "a job named test").toBeDefined();
  const aggregate = aggregateEntry![1];
  expect(aggregate.strategy).toBeUndefined();
  expect(new Set([aggregate.needs].flat())).toEqual(new Set([shardName, hubName, staticName]));
  expect(aggregate.if).toContain("always()");
  expect(
    aggregate.steps.filter(
      (step) => /^bunx? /.test(step.run ?? "") || step.uses?.includes("setup-bun"),
    ),
  ).toEqual([]);
});

test("ARK-T697 the timings file is a Bun timings file whose entries are recorded times of existing files", () => {
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

test("ARK-T697 the 4 shards and the hub timing entries of ci.yml together list every test file on disk exactly once and none is empty", async () => {
  const onDisk = filesOnDisk();
  expect(onDisk.length).toBeGreaterThan(0);
  const [shards, hubEntries] = await Promise.all([
    Promise.all([1, 2, 3, 4].map((shard) => selectShard(repositoryRoot, shard, null))),
    Promise.all(hubMatrixValues.map((value) => selectHubEntry(repositoryRoot, value))),
  ]);
  expect(hubEntries.length, "hub timing matrix entries").toBeGreaterThan(0);
  hubEntries.forEach((entry, index) => {
    expect(entry.files.length, `hub timing entry ${index + 1} is empty`).toBeGreaterThan(0);
  });
  // the entries run exactly the files the shard step ignores: a renamed path would lose a file here
  expect(
    coverageProblems(
      hubPaths,
      hubEntries.map((entry) => entry.files),
    ),
  ).toEqual({
    missing: [],
    twice: [],
  });
  expect(hubEntries.flatMap((entry) => entry.files).sort()).toEqual(hubPaths);

  expect(
    coverageProblems(
      onDisk,
      [...shards, ...hubEntries].map((job) => job.files),
    ),
  ).toEqual({ missing: [], twice: [] });
  shards.forEach((shard, index) => {
    expect(shard.files.length, `shard ${index + 1} is empty`).toBeGreaterThan(0);
    expect(shard.line).toBe(
      `--shard=${index + 1}/4: running ${shard.files.length}/${onDisk.length - hubPaths.length} test files`,
    );
  });
});

test("ARK-T697 a test file missing from the timings file runs in exactly one shard, and a timings entry with no file, a test/pw file and a hub timing file run in none", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ark-shard-scratch-"));
  try {
    const passing =
      'import { expect, test } from "bun:test";\ntest("passes", () => expect(1).toBe(1));\n';
    const files = Array.from({ length: 9 }, (_, index) => `test/f${index + 1}.test.ts`);
    // a file under the bunfig ignore pattern and one at each hub timing path: no shard may take them
    const notInShards = ["test/pw/ignored.test.ts", ...hubPaths];
    for (const file of [...files, ...notInShards]) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), passing);
    }
    // the repo's bunfig ignore list, without its preload
    writeFileSync(
      join(directory, "bunfig.toml"),
      `[test]\npathIgnorePatterns = ${JSON.stringify(bunfigIgnorePatterns)}\n`,
    );
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
    // the union is exactly the 9 files: test/pw/ignored.test.ts and the hub timing paths are in no shard
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual(files);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ARK-T697 the required check test exits 0 only when every needed job succeeded", () => {
  const neededJobs = [staticEntry![0], shardEntry![0], hubEntry![0]];
  const line = runLines(aggregateEntry![1]).join("\n");
  const exitOf = (results: Record<string, string>) => {
    const script = line.replace(
      /\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}/g,
      (_, job: string) => results[job] ?? `UNKNOWN-${job}`,
    );
    expect(script, "an expression the test does not replace").not.toContain("${{");
    return Bun.spawnSync(["bash", "-e", "-c", script], {
      stderr: "pipe",
      stdout: "pipe",
    }).exitCode;
  };
  const allSuccess = Object.fromEntries(neededJobs.map((job) => [job, "success"]));
  expect(exitOf(allSuccess)).toBe(0);
  for (const result of ["failure", "cancelled", "skipped"]) {
    for (const failedJob of neededJobs) {
      expect(exitOf({ ...allSuccess, [failedJob]: result }), `${failedJob} ${result}`).not.toBe(0);
    }
  }
});
