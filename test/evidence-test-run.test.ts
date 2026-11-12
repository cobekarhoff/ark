import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";
import {
  expectHookEndedOnlyItsRuns,
  holdRunners,
  macOnly,
  recordStartedRun,
  proveFixtureSkipsMemoryWait,
  stopHeld,
  stopStartedRuns,
} from "./orphan-runners.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it. Every test here runs real suites,
// some of them in Chromium, at base and at head.
setDefaultTimeout(180_000);

// ARK-419: no test-runner of a run this file started outlives its test.
afterEach(stopStartedRuns);

const repositoryRoot = resolve(import.meta.dir, "..");
const playwrightModule = join(repositoryRoot, "node_modules/@playwright/test/index.mjs");
const helpersModule = join(repositoryRoot, "test/pw/helpers.ts");
const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

type Suite = {
  name: string;
  level: string;
  repo: string;
  command: string;
  parser: "bun";
  base_files?: string;
  base_command?: string;
};

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${directory}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commitAll(directory: string, message: string): void {
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", message);
}

function writeFiles(directory: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
}

function fixtureDirectory(): string {
  return mkdtempSync(join(tmpdir(), "fixture-"));
}

/** A repo with `files` inside `workspace`; returns its base commit, read with git. */
function createRepo(workspace: string, name: string, files: Record<string, string>): string {
  const path = join(workspace, name);
  mkdirSync(dirname(path), { recursive: true });
  renameSync(tempGitRepo(files), path);
  return git(path, "rev-parse", "HEAD");
}

/**
 * Starts a run at the building phase: ticket with one manual AC that the human already accepted (so `ark test`
 * exits 0 when the suites pass), approved plan with one step per repo, worktrees in the mirror.
 */
function startBuildingRun(options: {
  workspace: string;
  suites: Suite[];
  repos: string[];
  kind?: string;
  /** Adds the AC FAKE-1-AC2 with `method: test`, proven by a test whose name starts with the case id ARK-T1 (an old-id title fails ark test when touched). */
  testCriterion?: boolean;
}): {
  runId: string;
  runDirectory: string;
  mirror: string;
} {
  const arkHome = tempArkHome();
  writeProject("demo", {
    workspace: options.workspace,
    ticket_source: "local",
    test_min_free_memory_percent: 0,
    test_max_swap_gb: 1000,
    suites: options.suites,
    roles,
  });
  const ticket = writeTicket(
    "demo",
    "FAKE-1",
    [
      { id: "FAKE-1-AC1", text: "A person checks it", manual: true },
      ...(options.testCriterion
        ? [{ id: "FAKE-1-AC2", text: "A test checks it", method: "test", verified_by: ["ARK-T1"] }]
        : []),
    ],
    "Ticket FAKE-1",
    options.kind,
  );
  const runId = ark("run", "start", ticket, "--project", "demo").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-1-\d+/,
  )![0];
  const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
  recordStartedRun({ runId, runDirectory });
  recordEvaluation(runDirectory);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
      summary: {
        why: "Test the run.",
        changes: [
          { criterion: "FAKE-1-AC1", where: "tests", now: "None.", fix: "A person checks." },
          ...(options.testCriterion
            ? [{ criterion: "FAKE-1-AC2", where: "tests", now: "None.", fix: "A test checks." }]
            : []),
        ],
      },
      steps: options.repos.map((repo, index) => ({
        id: `build-${index}`,
        // A bug run starts with a validator step; a perf run names its result files in the first and last goal.
        role: options.kind === "bug" && index === 0 ? "validator" : "implementer",
        repo,
        harness: "claude",
        model: "claude-sonnet",
        needs: [],
        goal: "Write results/baseline.md first and results/compare.md last.",
        criteria: options.testCriterion ? ["FAKE-1-AC1", "FAKE-1-AC2"] : ["FAKE-1-AC1"],
      })),
      test_cases: options.testCriterion
        ? [
            {
              id: "proves-AC2",
              criterion: "FAKE-1-AC2",
              level: "integration",
              given: [],
              when: ["run it"],
              // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
              then: ["it works"],
              expected: "it works",
            },
          ]
        : [],
    }),
  );
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
    ["worktree", "create", runId],
    ["gate", "record", runId, "manual", "FAKE-1-AC1", "ok"],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
  }
  return { runId, runDirectory, mirror: join(runDirectory, "workspace") };
}

const evidenceOf = (runDirectory: string) => join(runDirectory, "results", "evidence");
const readText = (...path: string[]) => readFileSync(join(...path), "utf8");
const readResult = (runDirectory: string, id: string, side: "base" | "head") =>
  JSON.parse(readText(evidenceOf(runDirectory), id, side, "result.json"));

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function expectPng(file: string): void {
  expect(existsSync(file), file).toBe(true);
  expect(statSync(file).size).toBeGreaterThan(8);
  expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
}

const caseEntry = (id: string) =>
  [
    "---",
    `id: ${id}`,
    `title: ${id} fixture entry`,
    "level: integration",
    "technique: fixture",
    "priority: low",
    "risk: none",
    "status: active",
    "changed_by: FAKE-1",
    "---",
    "",
    ...[
      "Objective",
      "Preconditions",
      "Steps",
      "Expected results",
      "Screenshot checkpoints",
    ].flatMap((section) => [`## ${section}`, "", "x", ""]),
  ].join("\n");

const copiedPaths = [
  "test/new.test.ts",
  "tests/nested/deep/b.test.ts",
  "features/y.feature",
  "test/fixtures/data.json",
  "test/cases/ARK-Y.md",
  "packages/app/test/new.test.ts",
  "packages/app/tests/new.test.ts",
  "packages/app/features/y.feature",
  "test/helpers/util.ts",
  "features/x.feature",
  "packages/app/test/helpers/h.ts",
  "packages/app/features/z.feature",
  "test/renamed.test.ts",
];
const keptPaths = [
  "test/keep.test.ts",
  "test/old-name.test.ts",
  "tests/nested/a.test.ts",
  "packages/app/tests/a.test.ts",
  "test/cases/ARK-X.md",
  "src/feature.ts",
];
const absentPaths = ["packages/app/src/p.ts"];

const baseFiles = (name: string): Record<string, string> => ({
  "README.md": `${name}\n`,
  "src/feature.ts": "export const base = true;\n",
  "test/keep.test.ts": "// kept at base\n",
  "test/old-name.test.ts": "// renamed at head\n",
  "test/helpers/util.ts": "v1\n",
  "tests/nested/a.test.ts": "// nested\n",
  "features/x.feature": "v1\n",
  "test/cases/ARK-X.md": caseEntry("ARK-X"),
  "test/cases/ARK-T1.md": caseEntry("ARK-T1"),
  "packages/app/test/helpers/h.ts": "v1\n",
  "packages/app/features/z.feature": "v1\n",
  "packages/app/tests/a.test.ts": "// app nested\n",
});

type NewTest = "needs-feature" | "fails-both" | "head-marker" | "passes";

/** `prefix` starts each test name, so a test can carry the id of an AC. */
function newTestContent(mode: NewTest, prefix = ""): string {
  const imports = 'import { expect, test } from "bun:test";\n';
  if (mode === "needs-feature")
    return `${imports}import { feature } from "../src/feature.ts";\ntest("${prefix}feature works", () => { expect(feature()).toBe(1); });\n`;
  if (mode === "fails-both")
    return `${imports}import { feature } from "../src/feature.ts";\ntest("${prefix}feature works", () => { expect(feature()).toBe(2); });\n`;
  if (mode === "head-marker")
    return `${imports}import { readFileSync } from "node:fs";\ntest("${prefix}production has no head marker", () => { expect(readFileSync("src/feature.ts", "utf8")).not.toContain("head-only"); });\n`;
  return `${imports}test("${prefix}passes", () => {});\n`;
}

function applyHeadChanges(repository: string, mode: NewTest, testCriterion = false): void {
  writeFiles(repository, {
    "src/feature.ts":
      mode === "head-marker"
        ? "export const base = true;\n// head-only\n"
        : "export const base = true;\nexport function feature() { return 1; }\n",
    "test/new.test.ts": newTestContent(mode, testCriterion ? "ARK-T1 " : ""),
    "tests/nested/deep/b.test.ts": "// deep\n",
    "features/y.feature": "y\n",
    "test/fixtures/data.json": "{}\n",
    "test/cases/ARK-Y.md": caseEntry("ARK-Y"),
    "packages/app/test/new.test.ts": "// app new\n",
    "packages/app/tests/new.test.ts": "// app tests new\n",
    "packages/app/features/y.feature": "y\n",
    "test/helpers/util.ts": "v2\n",
    "features/x.feature": "v2\n",
    "packages/app/test/helpers/h.ts": "v2\n",
    "packages/app/features/z.feature": "v2\n",
    "packages/app/src/p.ts": "export const p = 1;\n",
  });
  git(repository, "rm", "-q", "test/keep.test.ts");
  git(repository, "mv", "test/old-name.test.ts", "test/renamed.test.ts");
  commitAll(repository, "head changes");
}

/** Prints which checkout runs, its commit, and the git blob of each probed path (or `absent`), and counts the run. */
function writeProbe(directory: string): string {
  const file = join(directory, "probe.sh");
  writeFileSync(
    file,
    `#!/bin/sh
# usage: probe.sh <repo> <suite> <base sha> <counter file> <report>
sha=$(git rev-parse HEAD)
if [ "$sha" = "$3" ]; then side=base; else side=head; fi
case "$5" in */census/*) side=census;; esac
echo "SUITE=$1/$2 CHECKOUT=$side SHA=$sha"
echo "$side" >> "$4"
for path in ${[...copiedPaths, ...keptPaths, ...absentPaths].join(" ")}; do
  if [ -e "$path" ]; then echo "FILE $path $(git hash-object "$path")"; else echo "FILE $path absent"; fi
done
`,
  );
  return file;
}

const repoNames = ["repoA", "repoB"];

function twoRepoRun(kind: string, mode: NewTest, testCriterion = false) {
  const directory = fixtureDirectory();
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const probe = writeProbe(directory);
  const counters = join(directory, "counters");
  mkdirSync(counters);
  const baseShas: Record<string, string> = {};
  for (const name of repoNames) baseShas[name] = createRepo(workspace, name, baseFiles(name));
  const probeCommand = (name: string, suite: string) =>
    `sh ${probe} ${name} ${suite} ${baseShas[name]} ${join(counters, `${name}-${suite}`)} {report}`;
  const bunTest = (files: string) =>
    `bun test ${files} --reporter=junit --reporter-outfile={report}`;
  // s1 and s2 each match a test file of the run's own commits. s3 matches none: only a refactor run runs it at base.
  const suites = repoNames.flatMap((name): Suite[] => [
    {
      name: `${name}-s1`,
      level: "integration",
      repo: name,
      command: `${probeCommand(name, "s1")} && ${bunTest("./test/new.test.ts")}`,
      parser: "bun",
      base_files: "test/new.test.ts",
      base_command: `${probeCommand(name, "s1")} && ${bunTest("{files}")}`,
    },
    {
      name: `${name}-s2`,
      level: "integration",
      repo: name,
      command: probeCommand(name, "s2"),
      parser: "bun",
      base_files: "features/*.feature",
      // A probe ignores the file list; `{files}` is required, so it sits in a comment.
      base_command: `${probeCommand(name, "s2")} # {files}`,
    },
    {
      name: `${name}-s3`,
      level: "integration",
      repo: name,
      command: probeCommand(name, "s3"),
      parser: "bun",
      base_files: "nomatch/*.test.ts",
      // A probe ignores the file list; `{files}` is required, so it sits in a comment.
      base_command: `${probeCommand(name, "s3")} # {files}`,
    },
  ]);
  const run = startBuildingRun({ workspace, suites, repos: repoNames, kind, testCriterion });
  for (const name of repoNames) applyHeadChanges(join(run.mirror, name), mode, testCriterion);
  const runsAt = (name: string, suite: string, side: "base" | "head") => {
    const file = join(counters, `${name}-${suite}`);
    return existsSync(file)
      ? readText(file)
          .split("\n")
          .filter((line) => line === side).length
      : 0;
  };
  return { ...run, baseShas, runsAt };
}

type TwoRepoRun = { baseShas: Record<string, string>; mirror: string; runDirectory: string };

const fileTable = (log: string) =>
  Object.fromEntries(
    log
      .split("\n")
      .filter((line) => line.startsWith("FILE "))
      .map((line) => {
        const [, path, value] = line.split(" ");
        return [path, value];
      }),
  );

/** ARK-T1 steps 3 to 5: every suite ran at its own repo's base, with the head's test files and no production files. */
function expectBaseRuns(run: TwoRepoRun): void {
  expect(run.baseShas.repoA).not.toBe(run.baseShas.repoB);
  for (const name of repoNames) {
    const headRepository = join(run.mirror, name);
    const expected: Record<string, string> = {};
    for (const path of copiedPaths) expected[path] = git(headRepository, "hash-object", path);
    for (const path of keptPaths)
      expected[path] = git(headRepository, "rev-parse", `${run.baseShas[name]}:${path}`);
    for (const path of absentPaths) expected[path] = "absent";
    for (const suite of ["s1", "s2"]) {
      const baseLog = readText(run.runDirectory, "results", `base-${name}-${suite}.log`);
      expect(baseLog).toContain(`SUITE=${name}/${suite} CHECKOUT=base SHA=${run.baseShas[name]}`);
      expect(fileTable(baseLog)).toEqual(expected);
      const headLog = readText(run.runDirectory, "results", `${name}-${suite}.log`);
      expect(headLog).toContain(
        `SUITE=${name}/${suite} CHECKOUT=head SHA=${git(headRepository, "rev-parse", "HEAD")}`,
      );
    }
  }
}

describe("ark test base run", () => {
  test("ARK-T1 a feature run runs at each repo's own base only the suites with a changed own test file, with the head's test files, exits 0, and runs the base again with new head content", () => {
    const run = twoRepoRun("feature", "needs-feature");

    // The new test fails in a plain checkout of the base: it needs `feature()`.
    const plain = join(fixtureDirectory(), "plain-base");
    git(join(run.mirror, "repoA"), "worktree", "add", "--detach", plain, run.baseShas.repoA);
    writeFileSync(join(plain, "test/new.test.ts"), newTestContent("needs-feature"));
    const handRun = Bun.spawnSync(["bun", "test", "./test/new.test.ts"], {
      cwd: plain,
      stdout: "pipe",
      stderr: "pipe",
    });
    git(join(run.mirror, "repoA"), "worktree", "remove", "--force", plain);
    expect(handRun.exitCode).not.toBe(0);
    expect(handRun.stderr.toString() + handRun.stdout.toString()).toContain("feature");

    const first = ark("test", run.runId);
    expect(first.code, first.err + first.out).toBe(0);
    expectBaseRuns(run);
    for (const name of repoNames) {
      expect(run.runsAt(name, "s1", "base")).toBe(1);
      // s3 has no changed own test file: it ran at head only.
      expect(run.runsAt(name, "s3", "base")).toBe(0);
      expect(run.runsAt(name, "s3", "head")).toBe(1);
    }

    // New head content: the next ark test copies it again and runs the base again.
    for (const name of repoNames) {
      writeFiles(join(run.mirror, name), {
        "test/new.test.ts": `${newTestContent("needs-feature")}// second content\n`,
      });
      commitAll(join(run.mirror, name), "change the new test");
    }
    const second = ark("test", run.runId);
    expect(second.code, second.err + second.out).toBe(0);
    expectBaseRuns(run);
    for (const name of repoNames) {
      expect(run.runsAt(name, "s1", "base")).toBe(2);
      expect(readText(run.runDirectory, "results", `base-${name}-s1.log`)).toContain(
        `FILE test/new.test.ts ${git(join(run.mirror, name), "hash-object", "test/new.test.ts")}`,
      );
    }
  });

  test.each(["bug", "perf"])(
    "ARK-T1 a %s run exits 0 and runs at base only the suites with a changed own test file",
    (kind) => {
      const run = twoRepoRun(kind, "needs-feature");
      const result = ark("test", run.runId);
      expect(result.code, result.err + result.out).toBe(0);
      expectBaseRuns(run);
      for (const name of repoNames) expect(run.runsAt(name, "s3", "base")).toBe(0);
    },
  );

  test("ARK-T1 a refactor run runs every suite at base, exits non-zero with a method test AC whose suites fail there, and runs the base again with changed tests", () => {
    const run = twoRepoRun("refactor", "needs-feature", true);
    const first = ark("test", run.runId);
    expect(first.code).not.toBe(0);
    expect(first.err).toContain("refactor run: the suites fail at the base commit");
    expectBaseRuns(run);
    expect(run.runsAt("repoA", "s1", "base")).toBe(1);
    for (const name of repoNames) expect(run.runsAt(name, "s3", "base")).toBe(1);

    for (const name of repoNames) {
      writeFiles(join(run.mirror, name), {
        "test/new.test.ts": newTestContent("passes", "ARK-T1 "),
      });
      commitAll(join(run.mirror, name), "make the new test pass");
    }
    const second = ark("test", run.runId);
    expect(second.code, second.err + second.out).toBe(0);
    expect(run.runsAt("repoA", "s1", "base")).toBe(2);
  });

  test("ARK-T1 a feature run whose new test also fails at head exits non-zero", () => {
    const run = twoRepoRun("feature", "fails-both");
    expect(ark("test", run.runId).code).not.toBe(0);
  });

  test.each([
    ["bug", "fails-both"],
    ["perf", "fails-both"],
    ["refactor", "head-marker"],
  ] as [string, NewTest][])(
    "ARK-T1 a %s run whose test fails at head exits non-zero and the head log shows the failure",
    (kind, mode) => {
      const run = twoRepoRun(kind, mode);
      const result = ark("test", run.runId);
      expect(result.code).not.toBe(0);
      expect(result.err).toContain("suite repoA-s1 failed");
      expect(readText(run.runDirectory, "results", "repoA-s1.log")).toMatch(/\b1 fail\b/);
      if (kind === "refactor")
        // The suites pass at base: only the head failure refuses.
        expect(readText(run.runDirectory, "results", "base-repoA-s1.log")).toMatch(/\b1 pass\b/);
    },
  );
});

describe("ark test case evidence", () => {
  test("ARK-T2 ark test writes base and head result.json with the SHA of the checkout that ran, not run for a suite skipped at base and failed for a crashed base suite", () => {
    const directory = fixtureDirectory();
    const workspace = join(directory, "workspace");
    mkdirSync(workspace);
    const junit = (files: string) =>
      `bun test ${files} --reporter=junit --reporter-outfile={report}`;
    const baseShas = {
      touched: createRepo(workspace, "touched", {
        "README.md": "touched\n",
        "test/suite-a.test.ts": `import { existsSync } from "node:fs";
import { expect, test } from "bun:test";
test("FAKE-T1 fails at base", () => { expect(existsSync("src/flag.txt")).toBe(true); });
test("FAKE-T2 passes", () => {});
test.skip("FAKE-T3 is skipped", () => {});
`,
        "test/suite-b-sibling.test.ts": `import { test } from "bun:test";\ntest("FAKE-T7 sibling passes", () => {});\n`,
      }),
      touched2: createRepo(workspace, "touched2", {
        "README.md": "touched2\n",
        "test/suite-c.test.ts": `import { test } from "bun:test";\ntest("FAKE-T5 workspace", () => {});\n`,
      }),
      untouched: createRepo(workspace, "untouched", {
        "README.md": "untouched\n",
        "test/suite-d.test.ts": `import { test } from "bun:test";\ntest("FAKE-T6 untouched", () => {});\n`,
      }),
    };
    const run = startBuildingRun({
      workspace,
      repos: ["touched", "touched2"],
      suites: [
        {
          name: "suite-a",
          level: "integration",
          repo: "touched",
          command: junit("./test/suite-a.test.ts"),
          parser: "bun",
          base_files: "test/suite-a.test.ts",
          base_command: junit("{files}"),
        },
        {
          name: "suite-b",
          level: "integration",
          repo: "touched",
          command: junit("./test/suite-b.test.ts ./test/suite-b-sibling.test.ts"),
          parser: "bun",
          base_files: "test/suite-b*.test.ts",
          base_command: junit("{files}"),
        },
        {
          name: "suite-c",
          level: "integration",
          repo: "touched2",
          command: junit("./test/suite-c.test.ts"),
          parser: "bun",
          base_files: "test/suite-c.test.ts",
          base_command: junit("{files}"),
        },
        {
          name: "suite-d",
          level: "integration",
          repo: "untouched",
          command: junit("./test/suite-d.test.ts"),
          parser: "bun",
          base_files: "test/suite-d.test.ts",
          base_command: junit("{files}"),
        },
      ],
    });
    // touched: head adds the production flag, the module that only head has and the new test file of suite B.
    const touched = join(run.mirror, "touched");
    writeFiles(touched, {
      "src/flag.txt": "on\n",
      "src/head-module.ts": "export const value = 1;\n",
      "test/suite-a.test.ts": `${readText(touched, "test/suite-a.test.ts")}// own change\n`,
      "test/suite-b-sibling.test.ts": `${readText(touched, "test/suite-b-sibling.test.ts")}// own change\n`,
      "test/suite-b.test.ts": `import { expect, test } from "bun:test";
import { value } from "../src/head-module.ts";
test("FAKE-T4 needs head module", () => { expect(value).toBe(1); });
`,
    });
    commitAll(touched, "head");
    // touched2: the run's checkout moves on; the project's clone gets a commit that the run never sees.
    const touched2 = join(run.mirror, "touched2");
    writeFiles(touched2, {
      "src/c.txt": "c\n",
      "test/suite-c.test.ts": `${readText(touched2, "test/suite-c.test.ts")}// own change\n`,
    });
    commitAll(touched2, "head");
    git(join(workspace, "touched2"), "commit", "-q", "--allow-empty", "-m", "only in the clone");
    expect(git(join(workspace, "touched2"), "rev-parse", "HEAD")).not.toBe(
      git(touched2, "rev-parse", "HEAD"),
    );

    const result = ark("test", run.runId);
    expect(result.code, result.err + result.out).toBe(0);

    const shas = {
      touched: { base: baseShas.touched, head: git(touched, "rev-parse", "HEAD") },
      touched2: { base: baseShas.touched2, head: git(touched2, "rev-parse", "HEAD") },
      untouched: {
        base: baseShas.untouched,
        head: git(join(workspace, "untouched"), "rev-parse", "HEAD"),
      },
    };
    expect(shas.touched.base).not.toBe(shas.touched.head);
    const expected: Record<
      string,
      { name: string; base: string; head: string; repo: keyof typeof shas }
    > = {
      "FAKE-T1": { name: "FAKE-T1 fails at base", base: "failed", head: "passed", repo: "touched" },
      "FAKE-T2": { name: "FAKE-T2 passes", base: "passed", head: "passed", repo: "touched" },
      "FAKE-T3": { name: "FAKE-T3 is skipped", base: "skipped", head: "skipped", repo: "touched" },
      "FAKE-T4": {
        name: "FAKE-T4 needs head module",
        base: "failed",
        head: "passed",
        repo: "touched",
      },
      "FAKE-T5": { name: "FAKE-T5 workspace", base: "passed", head: "passed", repo: "touched2" },
      // suite-d has no changed test file: it is skipped at the base on purpose.
      "FAKE-T6": { name: "FAKE-T6 untouched", base: "not run", head: "passed", repo: "untouched" },
    };
    for (const [id, entry] of Object.entries(expected)) {
      for (const side of ["base", "head"] as const) {
        expect(readResult(run.runDirectory, id, side), `${id} ${side}`).toEqual({
          case: id,
          name: entry.name,
          status: entry[side],
          // A case that did not run on a side has no commit there.
          sha: entry[side] === "not run" ? undefined : shas[entry.repo][side],
          repo: entry.repo,
        });
      }
    }
    expect(shas.untouched.base).toBe(shas.untouched.head);

    // The base run crashed before reporting FAKE-T4: its folder still holds the suite's command.log.
    const baseLog = readText(evidenceOf(run.runDirectory), "FAKE-T4", "base", "command.log").split(
      "\n",
    );
    expect(baseLog[0]).toStartWith("bun test ");
    expect(baseLog[0]).toContain("test/suite-b.test.ts");
    expect(baseLog[0]).toContain("test/suite-b-sibling.test.ts");
    expect(baseLog.at(-2)).toBe("exit 1");
    expect(readText(evidenceOf(run.runDirectory), "FAKE-T7", "base", "command.log")).toBe(
      readText(evidenceOf(run.runDirectory), "FAKE-T4", "base", "command.log"),
    );

    // A case that no longer appears loses its folder.
    writeFiles(touched, {
      "test/suite-a.test.ts": `import { existsSync } from "node:fs";
import { expect, test } from "bun:test";
test("FAKE-T1 fails at base", () => { expect(existsSync("src/flag.txt")).toBe(true); });
test.skip("FAKE-T3 is skipped", () => {});
`,
    });
    commitAll(touched, "drop FAKE-T2");
    expect(ark("test", run.runId).code).toBe(0);
    expect(existsSync(join(evidenceOf(run.runDirectory), "FAKE-T2"))).toBe(false);
    for (const id of ["FAKE-T1", "FAKE-T3", "FAKE-T4", "FAKE-T5", "FAKE-T6"])
      expect(existsSync(join(evidenceOf(run.runDirectory), id, "head", "result.json")), id).toBe(
        true,
      );
  });

  /** One repo, one suite for each test file in `files`; the head commit applies `headChange`. */
  function evidenceRun(
    files: Record<string, string>,
    suites: Record<string, string>,
    headChange: (mirror: string) => void,
    kind?: string,
  ) {
    const bunTest = (file: string) =>
      `bun test ${file} --reporter=junit --reporter-outfile={report}`;
    const run = startBuildingRun({
      kind,
      workspace: tempGitRepo(files),
      repos: ["."],
      suites: Object.entries(suites).map(([name, file]) => ({
        name,
        level: "integration",
        repo: ".",
        command: bunTest(file),
        parser: "bun" as const,
      })),
    });
    headChange(run.mirror);
    commitAll(run.mirror, "head");
    return { ...run, result: ark("test", run.runId) };
  }

  test("ARK-T2 a case whose test file the run deleted still gets a failed head result and the head command.log", () => {
    const run = evidenceRun(
      {
        "test/old.test.ts": `import { test } from "bun:test";\ntest("FAKE-T1 removed test", () => {});\n`,
        "test/keep.test.ts": `import { test } from "bun:test";\ntest("FAKE-T2 kept test", () => {});\n`,
      },
      { all: "./test" },
      (mirror) => {
        rmSync(join(mirror, "test/old.test.ts"));
      },
      "refactor",
    );
    expect(run.result.code, run.result.err + run.result.out).toBe(0);
    const base = readResult(run.runDirectory, "FAKE-T1", "base");
    const head = readResult(run.runDirectory, "FAKE-T1", "head");
    expect(base).toMatchObject({ name: "FAKE-T1 removed test", status: "passed" });
    expect(head).toMatchObject({
      case: "FAKE-T1",
      name: "FAKE-T1 removed test",
      status: "failed",
      sha: git(run.mirror, "rev-parse", "HEAD"),
    });
    const headLog = readText(evidenceOf(run.runDirectory), "FAKE-T1", "head", "command.log");
    expect(headLog).toBe(readText(evidenceOf(run.runDirectory), "FAKE-T2", "head", "command.log"));
    expect(headLog.split("\n").at(-2)).toBe("exit 0");
    expect(run.result.out).toContain("results/evidence/FAKE-T1/{base,head}");
  });

  test("ARK-T2 two suites carrying one case keep the failure and both command logs", () => {
    const run = evidenceRun(
      {
        "test/a.test.ts": `import { expect, test } from "bun:test";\ntest("FAKE-T1 first fails", () => { expect(1).toBe(2); });\n`,
        "test/b.test.ts": `import { test } from "bun:test";\ntest("FAKE-T1 second passes", () => {});\n`,
      },
      { first: "./test/a.test.ts", second: "./test/b.test.ts" },
      (mirror) => writeFiles(mirror, { "src/head.txt": "head\n" }),
    );
    expect(run.result.code).toBe(1);
    for (const side of ["base", "head"] as const) {
      expect(readResult(run.runDirectory, "FAKE-T1", side)).toMatchObject({
        name: "FAKE-T1 first fails",
        status: "failed",
      });
      const log = readText(evidenceOf(run.runDirectory), "FAKE-T1", side, "command.log");
      expect(log).toContain("./test/a.test.ts");
      expect(log).toContain("./test/b.test.ts");
      expect(log).toMatch(/\b1 fail\b/);
    }
  });

  const configuredCommand =
    "bun test test/suite.test.ts --reporter=junit --reporter-outfile={report}";

  /** One suite whose two cases print MARK-BASE or MARK-HEAD; `failsAt` is the checkout where FAKE-T1 fails. */
  function logRun(failsAt: "base" | "head", headExitCode?: number) {
    const directory = fixtureDirectory();
    const baseShaFile = join(directory, "base-sha.txt");
    const workspace = tempGitRepo({
      "test/suite.test.ts": `import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
const side = sha === readFileSync(${JSON.stringify(baseShaFile)}, "utf8").trim() ? "base" : "head";
console.log("MARK-" + side.toUpperCase());
test("FAKE-T1 differs", () => { expect(side === ${JSON.stringify(failsAt)}).toBe(false); });
test("FAKE-T2 passes", () => {});
afterAll(() => { if (side === "head" && ${headExitCode ?? 0} !== 0) process.exitCode = ${headExitCode ?? 0}; });
`,
    });
    writeFileSync(baseShaFile, git(workspace, "rev-parse", "HEAD"));
    const run = startBuildingRun({
      workspace,
      repos: ["."],
      suites: [
        {
          name: "fake",
          level: "integration",
          repo: ".",
          command: configuredCommand,
          parser: "bun",
        },
      ],
    });
    writeFiles(run.mirror, { "src/head.txt": "head\n" });
    commitAll(run.mirror, "head");
    const result = ark("test", run.runId);
    return { ...run, result };
  }

  /** The command line the test builds from the fixture config and the report file that appeared on disk. */
  function expectedFirstLine(runDirectory: string, side: "base" | "head"): string {
    const reports = readdirSync(join(runDirectory, "results")).filter((name) =>
      name.endsWith(".report"),
    );
    const report = reports.find((name) => name.startsWith("base-") === (side === "base"));
    expect(report, `${side} report among ${reports.join(", ")}`).toBeDefined();
    return configuredCommand.replace("{report}", join(runDirectory, "results", report!));
  }

  const logOf = (run: { runDirectory: string }, id: string, side: "base" | "head") =>
    readText(evidenceOf(run.runDirectory), id, side, "command.log");

  test.each([
    ["base 1 and head 0", "base", undefined, { base: 1, head: 0 }],
    ["head 2", "base", 2, { base: 1, head: 2 }],
    ["base 0 and head 1", "head", undefined, { base: 0, head: 1 }],
  ] as const)(
    "ARK-T5 command.log has the command, the checkout's output and the real exit line (%s)",
    (_name, failsAt, headExitCode, exits) => {
      const run = logRun(failsAt, headExitCode);
      expect(run.result.out).not.toBe("");
      for (const side of ["base", "head"] as const) {
        const log = logOf(run, "FAKE-T1", side);
        const lines = log.split("\n");
        expect(lines[0]).toBe(expectedFirstLine(run.runDirectory, side));
        expect(lines.at(-1)).toBe("");
        expect(lines.at(-2)).toBe(`exit ${exits[side]}`);
        const output = lines.slice(1, -2).join("\n");
        expect(output).toContain(side === "base" ? "MARK-BASE" : "MARK-HEAD");
        expect(output).not.toContain(side === "base" ? "MARK-HEAD" : "MARK-BASE");
        // Every case of the suite holds the same log.
        expect(logOf(run, "FAKE-T2", side)).toBe(log);
        expect(log.trimEnd().endsWith(`exit ${exits[side]}`)).toBe(true);
      }
    },
  );
});

function playwrightRun(arkEvidenceDirectory: string | undefined, output: string) {
  const environment: Record<string, string | undefined> = { ...process.env };
  delete environment.ARK_EVIDENCE_DIR;
  delete environment.JEST_WORKER_ID; // set by bun test --parallel; Playwright refuses it
  if (arkEvidenceDirectory !== undefined) environment.ARK_EVIDENCE_DIR = arkEvidenceDirectory;
  const result = Bun.spawnSync(
    [
      "bunx",
      "playwright",
      "test",
      "test/pw/checkpoint.pw.ts",
      "--reporter=line",
      "--output",
      output,
    ],
    { cwd: repositoryRoot, env: environment, stdout: "pipe", stderr: "pipe" },
  );
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

const uiConfig = `import { defineConfig } from ${JSON.stringify(playwrightModule)};
export default defineConfig({
  testDir: "test/pw",
  testMatch: "**/*.pw.ts",
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE ? [["junit"]] : [["list"]],
  use: { screenshot: "only-on-failure" },
});
`;

/** The spec `FAKE-T9 shows feature`: `#feature` is on the page of the head only. */
function featureSpec(checkpointAfterAssertion: boolean): string {
  const feature = 'await checkpoint(page, "feature-visible");';
  return `import { expect, test } from ${JSON.stringify(playwrightModule)};
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { checkpoint } from ${JSON.stringify(helpersModule)};

test("FAKE-T9 shows feature", async ({ page }) => {
  const server = createServer((_request, response) => response.end(readFileSync("src/page.html")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(\`http://127.0.0.1:\${(server.address() as { port: number }).port}\`);
    await checkpoint(page, "opened");
    ${checkpointAfterAssertion ? "" : feature}
    await expect(page.locator("#feature")).toBeVisible({ timeout: 500 });
    ${checkpointAfterAssertion ? feature : ""}
  } finally {
    server.close();
  }
});
`;
}

const idsSpec = `import { test } from ${JSON.stringify(playwrightModule)};
import { checkpoint } from ${JSON.stringify(helpersModule)};

test("FAKE-T8 ARK-T3 two ids in one title", async ({ page }) => {
  await page.setContent("<p>two</p>");
  await checkpoint(page, "two-ids");
});

test("a title with no case id", async ({ page }) => {
  await page.setContent("<p>none</p>");
  await checkpoint(page, "orphan");
});
`;

/** A one-repo UI project; `ark test` runs its Playwright suite at base and at head. The page has `#feature` at head only. */
function uiRun(checkpointAfterAssertion: boolean) {
  const realSpec = readFileSync(join(repositoryRoot, "test/pw/checkpoint.pw.ts"), "utf8")
    .replace('"@playwright/test"', JSON.stringify(playwrightModule))
    .replace('"./helpers.ts"', JSON.stringify(helpersModule));
  const workspace = tempGitRepo({
    "package.json": '{"type":"module"}\n',
    ".gitignore": "test-results\n",
    "playwright.config.ts": uiConfig,
    "src/page.html": "<p>Page without the feature</p>\n",
  });
  const run = startBuildingRun({
    workspace,
    repos: ["."],
    suites: [
      {
        name: "ui",
        level: "e2e",
        repo: ".",
        command: `PLAYWRIGHT_JUNIT_OUTPUT_FILE={report} ${join(repositoryRoot, "node_modules/.bin/playwright")} test --reporter=junit`,
        parser: "bun",
      },
    ],
  });
  writeFiles(run.mirror, {
    "src/page.html": '<p>Page</p><div id="feature">Feature</div>\n',
    "test/pw/feature.pw.ts": featureSpec(checkpointAfterAssertion),
    "test/pw/checkpoint.pw.ts": realSpec,
    "test/pw/ids.pw.ts": idsSpec,
  });
  commitAll(run.mirror, "head");
  // Scratch folders live in the temp dir: a fresh one shows that ark test removes them.
  const temporary = fixtureDirectory();
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  const result = ark("test", run.runId);
  process.env.TMPDIR = previous;
  return { ...run, result, temporary };
}

const screenshotNames = (runDirectory: string, id: string, side: "base" | "head") =>
  listFiles(join(evidenceOf(runDirectory), id, side, "screenshots"))
    .map((file) => file.split("/").at(-1)!)
    .sort();

describe("checkpoint screenshots", () => {
  test("ARK-T3 checkpoint writes a PNG under ARK_EVIDENCE_DIR and writes nothing without it", () => {
    const evidence = fixtureDirectory();
    const written = playwrightRun(evidence, fixtureDirectory());
    expect(written.code, written.out).toBe(0);
    expectPng(join(evidence, "ARK-T3", "screenshots", "after-click.png"));

    const notExported = fixtureDirectory();
    const output = fixtureDirectory();
    const silent = playwrightRun(undefined, output);
    expect(silent.code, silent.out).toBe(0);
    expect(listFiles(notExported)).toEqual([]);
    expect(
      listFiles(output).filter((file) => file.includes("screenshots") || file.endsWith(".png")),
    ).toEqual([]);
  });

  // One `ark test` of the UI project serves the three tests below: it runs Chromium at base and at head.
  let sharedRun:
    | {
        runDirectory: string;
        temporary: string;
        result: { code: number; out: string; err: string };
      }
    | undefined;
  const featureRun = () => (sharedRun ??= uiRun(false));

  test("ARK-T3 ark test moves a test's checkpoints to the base and head case folders, removes the scratch folder and drops a test with no case id", () => {
    const run = featureRun();
    expect(run.result.code, run.result.err + run.result.out).toBe(0);
    const evidence = evidenceOf(run.runDirectory);
    for (const side of ["base", "head"] as const)
      expectPng(join(evidence, "ARK-T3", side, "screenshots", "after-click.png"));
    expect(readdirSync(run.temporary).filter((name) => name.startsWith("ark-evidence-"))).toEqual(
      [],
    );
    expect(listFiles(evidence).filter((file) => file.endsWith("orphan.png"))).toEqual([]);
    expect(readdirSync(evidence).sort()).toEqual(["ARK-T3", "FAKE-T8", "FAKE-T9"]);
  });

  test("ARK-T3 a title with several case ids copies that test's checkpoints to each case and no other test's", () => {
    const run = featureRun();
    for (const side of ["base", "head"] as const) {
      // ARK-T3 holds its own test's picture and the multi-id test's; FAKE-T8 only the multi-id test's.
      expect(screenshotNames(run.runDirectory, "ARK-T3", side)).toEqual([
        "after-click.png",
        "two-ids.png",
      ]);
      expect(screenshotNames(run.runDirectory, "FAKE-T8", side)).toEqual(["two-ids.png"]);
    }
  });

  test("ARK-T4 a UI case that fails at base keeps the same checkpoint names as at head, and ark test exits 0", () => {
    const run = featureRun();
    expect(run.result.code, run.result.err + run.result.out).toBe(0);
    const evidence = evidenceOf(run.runDirectory);
    expect(readResult(run.runDirectory, "FAKE-T9", "base").status).toBe("failed");
    expect(readResult(run.runDirectory, "FAKE-T9", "head").status).toBe("passed");
    const baseNames = screenshotNames(run.runDirectory, "FAKE-T9", "base");
    const headNames = screenshotNames(run.runDirectory, "FAKE-T9", "head");
    expect(baseNames).toEqual(["feature-visible.png", "opened.png"]);
    expect(headNames).toEqual(baseNames);
    for (const side of ["base", "head"] as const)
      for (const name of baseNames) expectPng(join(evidence, "FAKE-T9", side, "screenshots", name));
  });

  test("ARK-T4 a checkpoint after the failing assertion leaves the base with fewer screenshots than the head", () => {
    // Why a checkpoint goes before its assertion: after it, a base failure never reaches the call.
    const run = uiRun(true);
    expect(run.result.code, run.result.err + run.result.out).toBe(0);
    expect(screenshotNames(run.runDirectory, "FAKE-T9", "base")).toEqual(["opened.png"]);
    expect(screenshotNames(run.runDirectory, "FAKE-T9", "head")).toEqual([
      "feature-visible.png",
      "opened.png",
    ]);
  });
});

// ARK-419: the demo fixture of this suite ends no suite on a memory wait and leaves no runner behind.
const orphanFixture = {
  start: (body: string) =>
    startBuildingRun({
      workspace: tempGitRepo({
        "e2e.test.ts": `import { test } from "bun:test";\ntest("evidence suite probe", async () => { ${body} }, 400_000);\n`,
      }),
      suites: [
        {
          name: "e2e",
          level: "e2e",
          repo: ".",
          command: "bun test --reporter=junit --reporter-outfile={report} ./e2e.test.ts",
          parser: "bun",
        },
      ],
      repos: ["."],
    }),
};

// The file-level afterEach of this suite stops the runs it started; the first test leaves two runners for it.
describe("ARK-T236 runners after the suite hook", () => {
  afterAll(stopHeld);
  macOnly(
    "ARK-T236 a runner that ignores SIGTERM runs beside a runner the test started",
    () => holdRunners(orphanFixture),
    120_000,
  );
  macOnly(
    "ARK-T236 after the suite hook ends, no test-runner process of a run the suite started remains and the runner of another run lives",
    expectHookEndedOnlyItsRuns,
    60_000,
  );
});

macOnly(
  "ARK-T235 the demo fixture of this suite finishes with free memory and swap past the default limits",
  () => proveFixtureSkipsMemoryWait(orphanFixture),
  120_000,
);
