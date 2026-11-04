import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type ProjectConfig } from "./config.ts";
import { manualCriteria } from "./criteria.ts";
import { ArkError } from "./errors.ts";
import {
  appendEvent,
  deriveState,
  readEvents,
  type CriterionStatus,
  type RunState,
} from "./events.ts";
import { parsers, type TestResult } from "./parsers/index.ts";
import { findRun } from "./paths.ts";
import { discoverRepos, mirrorRoot } from "./workspace.ts";
import { linkUntouched } from "./worktree.ts";

type Status = CriterionStatus;

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

// The worktree's HEAD for a touched repo, the workspace checkout's HEAD for an untouched one.
function headOf(repo: string, workspace: string, mirror: string): string {
  const mirrored = join(mirror, repo);
  const touched = existsSync(join(mirrored, ".git")) && !lstatSync(mirrored).isSymbolicLink();
  const result = run(["git", "rev-parse", "HEAD"], touched ? mirrored : join(workspace, repo));
  if (result.code !== 0)
    throw new ArkError(`git rev-parse HEAD failed for ${repo}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function criterionStatus(criterion: string, provingResults: TestResult[]): Status {
  const tagged = provingResults.filter((result) => result.criteria.includes(criterion));
  if (tagged.some((result) => result.status === "failed")) return "failing";
  return tagged.some((result) => result.status === "passed") ? "passing" : "missing";
}

function manualStatus(answer: string | undefined): Status {
  return answer === "ok" ? "manual ok" : answer === "problem" ? "manual problem" : "manual pending";
}

type Suite = ProjectConfig["suites"][number];

/** Runs one suite in `cwd`. Its log goes to `<name>.log` of `logDirectory` under `logPrefix`; passed also needs no failed test in the report. */
function runSuite(suite: Suite, cwd: string, logDirectory: string, logPrefix = "") {
  const reportPath = join(logDirectory, `${logPrefix}${suite.name}.report`);
  const outcome = run(["sh", "-c", suite.command.replaceAll("{report}", reportPath)], cwd);
  writeFileSync(
    join(logDirectory, `${logPrefix}${suite.name}.log`),
    outcome.stdout + outcome.stderr,
  );
  const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  const results = parsers[suite.parser]({ report, stdout: outcome.stdout });
  return { results, passed: outcome.code === 0 && results.every((r) => r.status !== "failed") };
}

function composeFor(config: ProjectConfig, root: string, runId: string): string[] | null {
  return config.compose
    ? [
        ...config.compose.trim().split(/\s+/),
        "--project-directory",
        root,
        "-p",
        runId.toLowerCase(),
      ]
    : null;
}

/**
 * Runs every suite on a throwaway checkout of each touched repo at its worktree.created base, so the run's own
 * changes are absent. Untouched repos run on the workspace checkout, as in the head run. Returns whether all passed.
 */
function baseSuitesPassed(
  config: ProjectConfig,
  runId: string,
  resultsDirectory: string,
  worktrees: RunState["worktrees"],
): boolean {
  const root = mkdtempSync(join(tmpdir(), "ark-base-"));
  const added: { source: string; path: string }[] = [];
  const compose = composeFor(config, root, `${runId}-base`);
  try {
    for (const { repo, path: source, base } of [...worktrees].sort((a, b) =>
      a.repo.localeCompare(b.repo),
    )) {
      if (base === undefined) throw new ArkError(`worktree.created of ${repo} has no base commit`);
      const path = join(root, repo);
      mkdirSync(dirname(path), { recursive: true });
      const created = run(["git", "worktree", "add", "--detach", path, base], source);
      if (created.code !== 0)
        throw new ArkError(`base checkout of ${repo} failed: ${created.stderr.trim()}`);
      added.push({ source, path });
    }
    linkUntouched(config.workspace, root, discoverRepos(config.workspace));
    for (const { repo } of worktrees) {
      if (config.setup) {
        const setup = run(["sh", "-c", config.setup], join(root, repo));
        if (setup.code !== 0)
          throw new ArkError(
            `setup failed at the base of ${repo}: ${(setup.stderr || setup.stdout).trim()}`,
          );
      }
    }
    if (compose) {
      const up = run([...compose, "up", "-d", "--wait"], root);
      if (up.code !== 0)
        throw new ArkError(`compose up failed: ${(up.stderr || up.stdout).trim()}`);
    }
    return config.suites
      .map((suite) => runSuite(suite, join(root, suite.repo), resultsDirectory, "base-").passed)
      .every(Boolean);
  } finally {
    if (compose) run([...compose, "down"], root);
    for (const { source, path } of added.reverse())
      run(["git", "worktree", "remove", "--force", path], source);
    rmSync(root, { recursive: true, force: true });
  }
}

export function testRun(runId: string, inProject?: string): void {
  const { project, directory } = findRun(runId, inProject);
  const config = loadConfig(project);
  const mirror = mirrorRoot(directory);
  if (!existsSync(mirror))
    throw new ArkError(`${runId} has no workspace mirror: run ark worktree create first`);
  const resultsDirectory = join(directory, "results");
  mkdirSync(resultsDirectory, { recursive: true });
  const state = deriveState(readEvents(directory));
  const criteria = state.criteria.map((criterion) => criterion.id);
  const manual = new Set(manualCriteria(directory));

  const composeBase = composeFor(config, mirror, runId);
  const checks: { name: string; passed: boolean }[] = [];
  for (const check of config.checks) {
    const outcome = run(["sh", "-c", check.command], join(mirror, check.repo));
    const output = outcome.stdout + outcome.stderr;
    writeFileSync(join(resultsDirectory, `check-${check.name}.log`), output);
    checks.push({ name: check.name, passed: outcome.code === 0 });
    if (outcome.code !== 0) {
      console.log(`check ${check.name} failed`);
      console.log(output.trimEnd().split("\n").slice(-20).join("\n"));
    }
  }
  const suites: { name: string; level: string; passed: boolean }[] = [];
  const provingResults: TestResult[] = [];

  try {
    if (composeBase) {
      const up = run([...composeBase, "up", "-d", "--wait"], mirror);
      if (up.code !== 0)
        throw new ArkError(`compose up failed: ${(up.stderr || up.stdout).trim()}`);
    }
    for (const suite of config.suites) {
      const { results, passed } = runSuite(suite, join(mirror, suite.repo), resultsDirectory);
      if (suite.level !== "unit") provingResults.push(...results);
      suites.push({
        name: suite.name,
        level: suite.level,
        passed,
      });
    }
  } finally {
    if (composeBase) run([...composeBase, "down"], mirror);
  }

  const criterionStatuses = Object.fromEntries(
    criteria.map((criterion) => [
      criterion,
      // A manual criterion is decided by the manual gate alone, also when a test is tagged with it.
      manual.has(criterion)
        ? manualStatus(state.gates[`manual:${criterion}`])
        : criterionStatus(criterion, provingResults),
    ]),
  );
  const heads = Object.fromEntries(
    discoverRepos(config.workspace).map((repo) => [repo, headOf(repo, config.workspace, mirror)]),
  );
  // A refactor run proves behavior stayed the same: the suites also run at the base commit, once per run.
  const events = readEvents(directory);
  const earlier = events.findLast(
    (event) => event.type === "test.completed" && event.data.base_passed !== undefined,
  )?.data.base_passed;
  const basePassed =
    state.kind === "refactor"
      ? (earlier ?? baseSuitesPassed(config, runId, resultsDirectory, state.worktrees))
      : undefined;
  const passed =
    checks.every((check) => check.passed) &&
    suites.every((suite) => suite.passed) &&
    Object.entries(criterionStatuses).every(
      ([criterion, status]) => manual.has(criterion) || status === "passing",
    );
  appendEvent(directory, "test.completed", {
    passed,
    heads,
    suites,
    criteria: criterionStatuses,
    ...(basePassed === undefined ? {} : { base_passed: basePassed }),
  });

  if (basePassed !== undefined) console.log(`base      ${basePassed ? "passed" : "failed"}`);
  for (const suite of suites)
    console.log(`suite      ${suite.name} (${suite.level})  ${suite.passed ? "passed" : "failed"}`);
  for (const [criterion, status] of Object.entries(criterionStatuses))
    console.log(`criterion  ${criterion}  ${status}`);

  const problems = [
    ...checks.filter((check) => !check.passed).map((check) => `check ${check.name} failed`),
    ...suites.filter((suite) => !suite.passed).map((suite) => `suite ${suite.name} failed`),
    ...Object.entries(criterionStatuses)
      .filter(([criterion, status]) => status !== (manual.has(criterion) ? "manual ok" : "passing"))
      .map(([criterion, status]) => `${criterion} is ${status}`),
  ];
  if (problems.length > 0)
    throw new ArkError(`tests did not prove every criterion: ${problems.join("; ")}`);
}
