import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type ProjectConfig } from "./config.ts";
import { runCriteria } from "./criteria.ts";
import { canonicalCriterion } from "./criterion-id.ts";
import { ArkError } from "./errors.ts";
import {
  appendEvent,
  deriveState,
  readEvents,
  type CriterionStatus,
  type RunState,
} from "./events.ts";
import { parsers, type TestResult } from "./parsers/index.ts";
import { readCaseEntries } from "./test-case.ts";
import { findRun } from "./paths.ts";
import { discoverRepos, mirrorRoot } from "./workspace.ts";
import { linkUntouched } from "./worktree.ts";

type Status = CriterionStatus;

function run(command: string[], cwd: string, env?: Record<string, string>) {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
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

// The old path: the results tagged with the AC id. `proofResults` holds integration and e2e results only.
function criterionStatus(criterion: string, proofResults: TestResult[]): Status {
  const tagged = proofResults.filter((result) =>
    result.criteria.some((id) => canonicalCriterion(id) === criterion),
  );
  if (tagged.some((result) => result.status === "failed")) return "failing";
  return tagged.some((result) => result.status === "passed") ? "passing" : "missing";
}

/** The `verified_by` join over the results of every level. A failing result of a case wins; a case with no passing result is missing. */
function caseStatus(id: string, allResults: TestResult[]): "passed" | "failed" | "missing" {
  const carrying = allResults.filter((result) => result.cases.includes(id));
  if (carrying.some((result) => result.status === "failed")) return "failed";
  return carrying.some((result) => result.status === "passed") ? "passed" : "missing";
}

function verifiedByStatus(
  cases: { id: string; status: "passed" | "failed" | "missing" }[],
): Status {
  if (cases.some((entry) => entry.status === "failed")) return "failing";
  return cases.some((entry) => entry.status === "missing") ? "missing" : "passing";
}

function manualStatus(answer: string | undefined): Status {
  return answer === "ok" ? "manual ok" : answer === "problem" ? "manual problem" : "manual pending";
}

type Suite = ProjectConfig["suites"][number];

type Side = "base" | "head";
type CaseEntry = { name: string; status: TestResult["status"] };
const statusRank = { skipped: 0, passed: 1, failed: 2 };

/** One entry for each test case id in the results. A failed test wins over a passed one, a passed over a skipped one. */
function caseEntries(results: TestResult[]): Map<string, CaseEntry> {
  const entries = new Map<string, CaseEntry>();
  for (const result of results) {
    for (const id of result.cases) {
      const entry = entries.get(id);
      if (entry === undefined) {
        entries.set(id, { name: result.name, status: result.status });
        continue;
      }
      if (statusRank[result.status] > statusRank[entry.status]) {
        entry.status = result.status;
        entry.name = result.name;
      }
    }
  }
  return entries;
}

/**
 * Writes `results/evidence/<case id>/<side>/` for each case: `result.json`, the suite's `command.log` and the
 * screenshots that `checkpoint` left in the scratch folder under the case id (`checkpoint` writes one folder for each case id of a test title).
 * `fallback` holds the cases found at head: one that the base run did not report gets a failed result.
 */
function writeEvidence(
  evidenceDirectory: string,
  side: Side,
  sha: string,
  commandLog: string,
  scratch: string,
  cases: Map<string, CaseEntry>,
  fallback?: Map<string, CaseEntry>,
): void {
  const all = new Map(cases);
  for (const [id, entry] of fallback ?? [])
    if (!all.has(id)) all.set(id, { name: entry.name, status: "failed" });
  for (const [id, entry] of all) {
    const folder = join(evidenceDirectory, id, side);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "result.json"),
      `${JSON.stringify({ case: id, name: entry.name, status: entry.status, sha }, null, 2)}\n`,
    );
    writeFileSync(join(folder, "command.log"), commandLog);
    const screenshots = join(scratch, id, "screenshots");
    if (existsSync(screenshots))
      cpSync(screenshots, join(folder, "screenshots"), { recursive: true });
  }
}

/**
 * Runs one suite in `cwd`. Its log goes to `<name>.log` of `resultsDirectory` (`base-<name>.log` at base).
 * `ARK_EVIDENCE_DIR` names a scratch folder for the run; the evidence of each test case is written after parsing.
 * `command.log` is the whole suite output, so every case of the suite shares it. Passed also needs no failed test.
 */
function runSuite(
  suite: Suite,
  cwd: string,
  resultsDirectory: string,
  side: Side,
  sha: string,
  fallback?: Map<string, CaseEntry>,
) {
  const prefix = side === "base" ? "base-" : "";
  const reportPath = join(resultsDirectory, `${prefix}${suite.name}.report`);
  const command = suite.command.replaceAll("{report}", reportPath);
  const scratch = mkdtempSync(join(tmpdir(), "ark-evidence-"));
  try {
    const outcome = run(["sh", "-c", command], cwd, { ARK_EVIDENCE_DIR: scratch });
    const output = outcome.stdout + outcome.stderr;
    writeFileSync(join(resultsDirectory, `${prefix}${suite.name}.log`), output);
    const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    const results = parsers[suite.parser]({ report, stdout: outcome.stdout });
    const cases = caseEntries(results);
    const separator = output === "" || output.endsWith("\n") ? "" : "\n";
    writeEvidence(
      join(resultsDirectory, "evidence"),
      side,
      sha,
      `${command}\n${output}${separator}exit ${outcome.code}\n`,
      scratch,
      cases,
      fallback,
    );
    return {
      results,
      cases,
      passed: outcome.code === 0 && results.every((result) => result.status !== "failed"),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const testFolder = /(^|\/)(test|tests|features)\//;

/** Copies the head's version of each file the diff adds or changes under a test folder into the base checkout. Deleted and renamed-from files stay at base. */
function copyHeadTests(headPath: string, basePath: string, base: string): void {
  const changed = run(
    ["git", "diff", "--name-only", "--no-renames", "--diff-filter=AM", "-z", base, "HEAD"],
    headPath,
  );
  if (changed.code !== 0)
    throw new ArkError(`git diff against the base failed in ${headPath}: ${changed.stderr.trim()}`);
  for (const path of changed.stdout.split("\0")) {
    if (path === "" || !testFolder.test(path) || !existsSync(join(headPath, path))) continue;
    mkdirSync(dirname(join(basePath, path)), { recursive: true });
    copyFileSync(join(headPath, path), join(basePath, path));
  }
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
 * Runs every suite on a throwaway checkout of each touched repo at its worktree.created base, after the head's
 * test files are copied in, so a new test meets the base build. Untouched repos run on the workspace checkout,
 * as in the head run. Returns whether all passed; a failure here is data except for `kind: refactor`.
 */
function baseSuitesPassed(
  config: ProjectConfig,
  runId: string,
  resultsDirectory: string,
  mirror: string,
  worktrees: RunState["worktrees"],
  headCases: Map<string, Map<string, CaseEntry>>,
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
      copyHeadTests(join(mirror, repo), path, base);
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
      .map(
        (suite) =>
          runSuite(
            suite,
            join(root, suite.repo),
            resultsDirectory,
            "base",
            headOf(suite.repo, root, root),
            headCases.get(suite.name),
          ).passed,
      )
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
  // The folders of the cases this run finds are written again below; a case that no longer appears loses its folder.
  const evidenceDirectory = join(resultsDirectory, "evidence");
  if (existsSync(evidenceDirectory))
    for (const entry of readdirSync(evidenceDirectory, { withFileTypes: true }))
      if (entry.isDirectory()) rmSync(join(evidenceDirectory, entry.name), { recursive: true });
  const state = deriveState(readEvents(directory));
  const criteria = state.criteria.map((criterion) => criterion.id);
  const ticketCriteria = new Map(
    runCriteria(directory).map((criterion) => [criterion.id, criterion]),
  );
  const manual = new Set(
    [...ticketCriteria.values()]
      .filter((criterion) => criterion.method !== "test")
      .map((criterion) => criterion.id),
  );
  const entryProblems = discoverRepos(config.workspace).flatMap(
    (repo) =>
      readCaseEntries(join(mirror, repo), repo === "." ? "test/cases" : `${repo}/test/cases`)
        .problems,
  );
  if (entryProblems.length > 0)
    throw new ArkError(entryProblems.map((problem) => `test case entry ${problem}`).join("; "));

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
  // The join through `verified_by` counts every level; the old tag path only integration and e2e.
  const allResults: TestResult[] = [];
  const provingResults: TestResult[] = [];
  const headCases = new Map<string, Map<string, CaseEntry>>();

  try {
    if (composeBase) {
      const up = run([...composeBase, "up", "-d", "--wait"], mirror);
      if (up.code !== 0)
        throw new ArkError(`compose up failed: ${(up.stderr || up.stdout).trim()}`);
    }
    for (const suite of config.suites) {
      const { results, passed, cases } = runSuite(
        suite,
        join(mirror, suite.repo),
        resultsDirectory,
        "head",
        headOf(suite.repo, config.workspace, mirror),
      );
      headCases.set(suite.name, cases);
      allResults.push(...results);
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

  const criterionStatuses: Record<string, Status> = {};
  const via: Record<string, string> = {};
  for (const criterion of criteria) {
    const verifiedBy = ticketCriteria.get(criterion)?.verified_by ?? [];
    if (manual.has(criterion)) {
      // A manual criterion is decided by the manual gate alone, also when a test is tagged with it.
      criterionStatuses[criterion] = manualStatus(state.gates[`manual:${criterion}`]);
      via[criterion] = `method ${ticketCriteria.get(criterion)?.method}`;
    } else if (verifiedBy.length > 0) {
      const cases = verifiedBy.map((id) => ({ id, status: caseStatus(id, allResults) }));
      criterionStatuses[criterion] = verifiedByStatus(cases);
      via[criterion] = `via ${cases.map((entry) => `${entry.id} ${entry.status}`).join(", ")}`;
    } else {
      criterionStatuses[criterion] = criterionStatus(criterion, provingResults);
      via[criterion] = "via tag";
    }
  }
  const heads = Object.fromEntries(
    discoverRepos(config.workspace).map((repo) => [repo, headOf(repo, config.workspace, mirror)]),
  );
  // Every run also runs the suites at the base commit, on each `ark test`: the new tests change from round to round.
  // A base failure is data, except that a refactor run must keep its behavior.
  const basePassed = baseSuitesPassed(
    config,
    runId,
    resultsDirectory,
    mirror,
    // An old worktree.created event may hold no base: only a refactor run, which needs the base, refuses it.
    state.kind === "refactor"
      ? state.worktrees
      : state.worktrees.filter((worktree) => worktree.base !== undefined),
    headCases,
  );
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
    ...(state.kind === "refactor" ? { base_passed: basePassed } : {}),
  });

  console.log(`base      ${basePassed ? "passed" : "failed"}`);
  for (const suite of suites)
    console.log(`suite      ${suite.name} (${suite.level})  ${suite.passed ? "passed" : "failed"}`);
  for (const [criterion, status] of Object.entries(criterionStatuses))
    console.log(`criterion  ${criterion}  ${status.padEnd(14)}  ${via[criterion]}`);
  for (const id of [
    ...new Set([...headCases.values()].flatMap((cases) => [...cases.keys()])),
  ].sort())
    console.log(`evidence   results/evidence/${id}/{base,head}`);

  const problems = [
    ...checks.filter((check) => !check.passed).map((check) => `check ${check.name} failed`),
    ...suites.filter((suite) => !suite.passed).map((suite) => `suite ${suite.name} failed`),
    ...(state.kind === "refactor" && !basePassed
      ? ["refactor run: the suites fail at the base commit"]
      : []),
    ...Object.entries(criterionStatuses)
      .filter(([criterion, status]) => status !== (manual.has(criterion) ? "manual ok" : "passing"))
      .map(([criterion, status]) => `${criterion} is ${status}`),
  ];
  if (problems.length > 0)
    throw new ArkError(`tests did not prove every criterion: ${problems.join("; ")}`);
}
