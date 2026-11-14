import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type ProjectConfig } from "./config.ts";
import { hasTestCriterion, runCriteria } from "./ticket.ts";
import { canonicalCriterion } from "./criterion-id.ts";
import { writeOwnerFile } from "./owner-file.ts";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents, type RunState } from "./events.ts";
import { manualStatus, type CriterionStatus } from "./lifecycle.ts";
import { parsers, type TestResult } from "./parsers/index.ts";
import { readCaseEntries } from "./test-case.ts";
import { caseIdsOutsidePlan, oldIdsTouched } from "./test-audit.ts";
import { loadPlan } from "./plan.ts";
import { findRun } from "./paths.ts";
import { cacheKey, hasCached, hashFiles, loadCached, storeCached } from "./test-cache.ts";
import { openTestBudget, type TestBudget } from "./test-lock.ts";
import { sampleGroup, updateResources, type SideUse } from "./resources-file.ts";
import { callTest, runnerMain } from "./test-runner.ts";
import { discoverRepos, mirrorRoot, repoBase, submodulesOf, targetBranch } from "./workspace.ts";
import { initSubmodule, linkUntouched } from "./worktree.ts";

type Status = CriterionStatus;

const children = new Set<{ pid: number }>();

/** Milliseconds a suite process group gets after SIGTERM before SIGKILL. */
const terminateGraceMilliseconds = 10_000;
const stoppingMilliseconds = 5_000;

/** Set once a signal arrived: no new process starts, and the run stops where it is. */
let stopping = false;

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function waitForGroups(pids: number[], limitMilliseconds: number): Promise<void> {
  const deadline = Date.now() + limitMilliseconds;
  while (pids.some(groupAlive) && Date.now() < deadline) await Bun.sleep(25);
}

/** SIGTERM to every running process group, SIGKILL to those left after the grace time; resolves when all are gone. */
async function stopChildren(): Promise<void> {
  stopping = true;
  const groups = [...children].map((child) => child.pid);
  const send = (signal: "SIGTERM" | "SIGKILL", pids: number[]) => {
    for (const pid of pids)
      try {
        process.kill(-pid, signal);
      } catch {
        // already gone
      }
  };
  send("SIGTERM", groups);
  await waitForGroups(groups, terminateGraceMilliseconds);
  send("SIGKILL", groups.filter(groupAlive));
  await waitForGroups(groups, stoppingMilliseconds);
}

/** `measure` samples the process group, for a suite: the result then holds its `use` (peak memory and CPU seconds). */
async function run(command: string[], cwd: string, env?: Record<string, string>, measure = false) {
  if (stopping) await new Promise<never>(() => {});
  // bun test --parallel workers set JEST_WORKER_ID; Playwright refuses to start when it sees it.
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  delete childEnv.JEST_WORKER_ID;
  const child = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    env: childEnv,
  });
  children.add(child);
  // The group of a detached child is its pid; only a suite is measured.
  const sampler = measure ? sampleGroup(child.pid) : null;
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const usage = child.resourceUsage();
    const use =
      (await sampler?.stop(
        usage ? { cpuMicroseconds: Number(usage.cpuTime.total), maxBytes: usage.maxRSS } : null,
      )) ?? null;
    // A signal is stopping the run: never let it go on to the next process or write results.
    if (stopping) await new Promise<never>(() => {});
    return { code, stdout, stderr, use };
  } finally {
    void sampler?.stop(null);
    children.delete(child);
  }
}

// The worktree for a touched repo, the workspace checkout for an untouched one.
function checkoutOf(repo: string, workspace: string, mirror: string): string {
  const mirrored = join(mirror, repo);
  const touched = existsSync(join(mirrored, ".git")) && !lstatSync(mirrored).isSymbolicLink();
  return touched ? mirrored : join(workspace, repo);
}

async function headOf(repo: string, workspace: string, mirror: string): Promise<string> {
  const result = await run(["git", "rev-parse", "HEAD"], checkoutOf(repo, workspace, mirror));
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
function caseStatus(
  id: string,
  allResults: TestResult[],
  suiteSkipped: boolean,
): "passed" | "failed" | "missing" | "not run" {
  const carrying = allResults.filter((result) => result.cases.includes(id));
  if (carrying.some((result) => result.status === "failed")) return "failed";
  if (carrying.some((result) => result.status === "passed")) return "passed";
  // ponytail: a case with no result is "not run" when any suite was skipped, since no result names its suite; refine when a quick run gates something
  return suiteSkipped ? "not run" : "missing";
}

function verifiedByStatus(
  cases: { id: string; status: "passed" | "failed" | "missing" | "not run" }[],
): Status {
  if (cases.some((entry) => entry.status === "failed")) return "failing";
  if (cases.some((entry) => entry.status === "missing")) return "missing";
  return cases.some((entry) => entry.status === "not run") ? "not run" : "passing";
}

/** A quick run runs the changed files only: its pass proves no AC and proof it left out is not run, not missing. A failure stays. */
const quickStatus = (status: Status, quick: boolean): Status =>
  quick && (status === "passing" || status === "missing") ? "not run" : status;

type Suite = ProjectConfig["suites"][number];

/** `census`: the run's own test files that exist at the pristine base commit, run only to list and count their tests. */
type Side = "base" | "head" | "census";
/** What one side knows of a case: the winning result of every suite that carries it, and the suites that did. */
type CaseEntry = {
  name: string;
  status: TestResult["status"] | "not run";
  repo: string;
  /** Absent for a case that did not run on this side. */
  sha?: string;
  /** The test file that carried the case, when the report names it. */
  file?: string;
  suites: string[];
};
/** One side of a run: the evidence of each case and, for each suite, the repo, SHA and command log that ran. */
type SideRun = {
  side: Side;
  cases: Map<string, CaseEntry>;
  /** `selected` is the file list a suite ran with, when the run chose files (base of a feature, bug or perf run). */
  suites: Map<string, { repo: string; sha: string; log: string; selected?: string[] }>;
  /** Suites skipped on purpose, with the reason. */
  skipped: Map<string, string>;
  /** Suites whose passed result came from the cache. */
  reused: string[];
  /** Test files that failed once and passed on retry. */
  flaky: { suite: string; file: string }[];
  /** Test files that failed at head and at the tip of the target branch, and were not counted. */
  redOnMain: { suite: string; file: string }[];
  /** Every result of each suite that ran on this side. */
  listed: Map<string, TestResult[]>;
};

/** A test that the base has and the head lacks. `file` is absent when the report names none. */
type DeletedTest = { file?: string; name: string };
const statusRank = { "not run": -1, skipped: 0, passed: 1, failed: 2 };

const newSide = (side: Side): SideRun => ({
  side,
  cases: new Map(),
  suites: new Map(),
  skipped: new Map(),
  reused: [],
  flaky: [],
  redOnMain: [],
  listed: new Map(),
});

const countStatus = (results: TestResult[], status: TestResult["status"]) =>
  results.filter((result) => result.status === status).length;

/**
 * The tests of the base that the head lacks, suite by suite: a multiset diff on file plus name (name alone when the
 * report names no file), so a duplicate title counts once per copy. A renamed test is deleted.
 * Sorted by file, then name.
 */
function deletedTests(
  base: Map<string, TestResult[]>,
  head: Map<string, TestResult[]>,
): DeletedTest[] {
  const deleted: DeletedTest[] = [];
  for (const [suite, results] of base) {
    const left = new Map<string, number>();
    for (const result of head.get(suite) ?? []) {
      const key = JSON.stringify([result.file, result.name]);
      left.set(key, (left.get(key) ?? 0) + 1);
    }
    for (const { file, name } of results) {
      const key = JSON.stringify([file, name]);
      if ((left.get(key) ?? 0) > 0) left.set(key, left.get(key)! - 1);
      else deleted.push({ ...(file ? { file } : {}), name });
    }
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return deleted.sort((a, b) => order(a.file ?? "", b.file ?? "") || order(a.name, b.name));
}

/** Merges the results of one suite into the side. A failed test wins over a passed one, a passed over a skipped one, across suites too. */
function addSuite(
  run: SideRun,
  suite: Suite,
  sha: string,
  log: string,
  results: TestResult[],
  scratch: string,
  evidenceDirectory: string,
  selected?: string[],
): void {
  run.suites.set(suite.name, { repo: suite.repo, sha, log, selected });
  for (const result of results) {
    for (const id of result.cases) {
      const entry = run.cases.get(id);
      // ponytail: a case carried by suites of two repos records the repo and SHA of its winning result only
      if (entry === undefined)
        run.cases.set(id, {
          name: result.name,
          status: result.status,
          repo: suite.repo,
          sha,
          suites: [suite.name],
          ...(result.file ? { file: result.file } : {}),
        });
      else {
        if (!entry.suites.includes(suite.name)) entry.suites.push(suite.name);
        if (statusRank[result.status] > statusRank[entry.status])
          Object.assign(entry, {
            name: result.name,
            status: result.status,
            repo: suite.repo,
            sha,
            ...(result.file ? { file: result.file } : {}),
          });
      }
    }
  }
  for (const [id, entry] of run.cases) {
    if (!entry.suites.includes(suite.name)) continue;
    const folder = join(evidenceDirectory, id, run.side);
    mkdirSync(folder, { recursive: true });
    appendFileSync(join(folder, "command.log"), log);
    const screenshots = join(scratch, id, "screenshots");
    if (existsSync(screenshots))
      cpSync(screenshots, join(folder, "screenshots"), { recursive: true });
  }
}

/**
 * A case that one side found and the other did not (a base crash, or a test file the run deleted) gets a failed
 * result and the command log of the suite that carried it on the side that found it, run on this side.
 * A case whose suite was skipped here, or whose file was not in the file list this side ran, never ran: `not run`.
 */
function addMissing(run: SideRun, other: SideRun, evidenceDirectory: string): void {
  for (const [id, found] of other.cases) {
    if (run.cases.has(id)) continue;
    const suite = run.suites.get(found.suites[0]!);
    const notRun =
      run.skipped.has(found.suites[0]!) ||
      (suite?.selected !== undefined &&
        found.file !== undefined &&
        !suite.selected.includes(found.file));
    if (notRun) {
      run.cases.set(id, {
        name: found.name,
        status: "not run",
        repo: found.repo,
        suites: [found.suites[0]!],
      });
      mkdirSync(join(evidenceDirectory, id, run.side), { recursive: true });
      continue;
    }
    if (suite === undefined) continue;
    run.cases.set(id, {
      name: found.name,
      status: "failed",
      repo: suite.repo,
      sha: suite.sha,
      suites: [found.suites[0]!],
    });
    const folder = join(evidenceDirectory, id, run.side);
    mkdirSync(folder, { recursive: true });
    appendFileSync(join(folder, "command.log"), suite.log);
  }
}

/** Where a run writes evidence until it ends. */
const STAGING = "evidence.next";

/**
 * A full run replaces `results/evidence` with its staging folder as a whole, so a case that no longer exists loses its
 * folder; files of the old folder that are not folders (the manual evidence files) stay. A quick run discards its staging.
 */
function publishEvidence(resultsDirectory: string, full: boolean): void {
  const staging = join(resultsDirectory, STAGING);
  const evidence = join(resultsDirectory, "evidence");
  if (full) {
    mkdirSync(staging, { recursive: true });
    if (existsSync(evidence))
      for (const entry of readdirSync(evidence, { withFileTypes: true }))
        if (!entry.isDirectory()) cpSync(join(evidence, entry.name), join(staging, entry.name));
    rmSync(evidence, { recursive: true, force: true });
    renameSync(staging, evidence);
  } else rmSync(staging, { recursive: true, force: true });
}

function writeResults(run: SideRun, evidenceDirectory: string): void {
  for (const [id, { name, status, repo, sha }] of run.cases)
    writeFileSync(
      join(evidenceDirectory, id, run.side, "result.json"),
      `${JSON.stringify({ case: id, name, status, sha, repo }, null, 2)}\n`,
    );
}

/** Where a suite's passed result is kept: the project's cache folder and the key of the result. */
type SuiteCache = { project: string; key: string };

/**
 * Runs each failed test file once more through `base_command` with that one file. A file that passes the second
 * time is flaky: its second results replace the failed ones. No retry (null) when the suite has no
 * `base_command`, or a failed test has no `file` (the report does not name it), so the failure stands.
 */
async function retryFailedFiles(
  suite: Suite,
  cwd: string,
  reportBase: string,
  scratch: string,
  results: TestResult[],
  tmp: string,
  cores: number,
): Promise<{ results: TestResult[]; flaky: string[]; failedFiles: string[]; log: string } | null> {
  const failed = results.filter((result) => result.status === "failed");
  if (failed.length === 0 || suite.base_command === undefined) return null;
  if (failed.some((result) => result.file === undefined)) {
    console.log(`suite      ${suite.name} head  not retried  (a failed test names no file)`);
    return null;
  }
  const failedFiles = [...new Set(failed.map((result) => result.file!))];
  let kept = results;
  let log = "";
  const flaky: string[] = [];
  for (const [index, file] of failedFiles.entries()) {
    const reportPath = `${reportBase}.retry-${index}`;
    const command = suite.base_command
      .replaceAll("{files}", shellQuote(file))
      .replaceAll("{report}", reportPath)
      .replaceAll("<cores>", String(cores));
    const outcome = await run(["sh", "-c", command], cwd, {
      ARK_EVIDENCE_DIR: scratch,
      TMPDIR: tmp,
    });
    const output = outcome.stdout + outcome.stderr;
    const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    const again = parsers[suite.parser]({ report, stdout: outcome.stdout });
    const separator = output === "" || output.endsWith("\n") ? "" : "\n";
    log += `retry ${file}\n${command}\n${output}${separator}exit ${outcome.code}\n`;
    // every test that failed in this file must be back and passed: a skipped or missing result keeps the failure
    const recovered = failed
      .filter((result) => result.file === file)
      .every((original) =>
        again.some((result) => result.name === original.name && result.status === "passed"),
      );
    if (outcome.code === 0 && recovered && again.every((result) => result.status !== "failed")) {
      kept = [...kept.filter((result) => result.file !== file), ...again];
      flaky.push(file);
    }
  }
  return { results: kept, flaky, failedFiles, log };
}

/** One side of a suite in `results/resources.json` of the run folder (`resultsDirectory` is its `results` folder): the `suites` key is this writer's, the hub's keys stay. */
function recordSide(
  resultsDirectory: string,
  suite: string,
  side: "head" | "base",
  use: SideUse | "cached",
): void {
  updateResources(dirname(resultsDirectory), (file) => {
    file.suites ??= {};
    // A cached suite starts no process: keep the last measured figures and mark them cached.
    const next = use === "cached" ? { ...file.suites[suite]?.[side], cached: true as const } : use;
    file.suites[suite] = { ...file.suites[suite], [side]: next };
  });
}

/**
 * Runs one suite in `cwd`, or replays its passed result when `cache` holds one. Its log goes to `<name>.log` of
 * `resultsDirectory` (`base-<name>.log` at base).
 * `ARK_EVIDENCE_DIR` names a scratch folder for the run; the evidence of each test case is merged into `sideRun`.
 * `command.log` is the whole suite output, so every case of the suite shares it. Passed also needs no failed test,
 * after the retry of each failed file. A passed result is stored under `cache`.
 */
let budget: TestBudget | null = null;

async function runSuite(
  suite: Suite,
  cwd: string,
  resultsDirectory: string,
  sideRun: SideRun,
  sha: string,
  /** The suite command, or `base_command` with `{files}` already replaced. */
  template: string = suite.command,
  selected?: string[],
  cache?: SuiteCache,
  mainCheck?: MainCheck,
) {
  const prefix = sideRun.side === "base" ? "base-" : "";
  const reportPath = join(resultsDirectory, `${prefix}${suite.name}.report`);
  const scratch = writeOwnerFile(mkdtempSync(join(tmpdir(), "ark-evidence-")));
  // ARK-390: a private TMPDIR per suite, so two suites or two runs never share temp files.
  const suiteTmpdir = writeOwnerFile(mkdtempSync(join(tmpdir(), "ark-suite-")));
  let taken: { cores: number; waitMilliseconds: number; release: () => void } | null = null;
  try {
    const cached = cache ? loadCached(cache.project, cache.key, scratch) : null;
    if (cached !== null) {
      writeFileSync(join(resultsDirectory, `${prefix}${suite.name}.log`), cached.output);
      addSuite(
        sideRun,
        suite,
        sha,
        cached.log,
        cached.results,
        scratch,
        join(resultsDirectory, STAGING),
        selected,
      );
      sideRun.reused.push(suite.name);
      if (sideRun.side !== "census")
        recordSide(resultsDirectory, suite.name, sideRun.side, "cached");
      for (const file of cached.flaky) sideRun.flaky.push({ suite: suite.name, file });
      const redOnMain = cached.redOnMain ?? [];
      for (const file of redOnMain) sideRun.redOnMain.push({ suite: suite.name, file });
      return { results: cached.results, passed: true, flaky: cached.flaky, reused: true, code: 0 };
    }
    // ARK-390: a cached suite takes no cores; a suite that runs waits for its cores in the host budget.
    taken = await budget!.take(suite.cores);
    const command = template
      .replaceAll("{report}", reportPath)
      .replaceAll("<cores>", String(taken.cores));
    const started = Date.now();
    const outcome = await run(
      ["sh", "-c", command],
      cwd,
      {
        ARK_EVIDENCE_DIR: scratch,
        TMPDIR: suiteTmpdir,
      },
      true,
    );
    if (sideRun.side !== "census")
      recordSide(resultsDirectory, suite.name, sideRun.side, {
        ...outcome.use!,
        wall_s: Math.round((Date.now() - started) / 100) / 10,
        wait_s: Math.round(taken.waitMilliseconds / 100) / 10,
      });
    let output = outcome.stdout + outcome.stderr;
    const separator = output === "" || output.endsWith("\n") ? "" : "\n";
    let log = `${command}\n${output}${separator}exit ${outcome.code}\n`;
    const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    let results = parsers[suite.parser]({ report, stdout: outcome.stdout });
    // A failure at base is data, so only the head side retries.
    const retried =
      sideRun.side === "head"
        ? await retryFailedFiles(suite, cwd, reportPath, scratch, results, suiteTmpdir, taken.cores)
        : null;
    if (retried !== null) {
      results = retried.results;
      output += retried.log;
      log += retried.log;
    }
    writeFileSync(join(resultsDirectory, `${prefix}${suite.name}.log`), output);
    addSuite(sideRun, suite, sha, log, results, scratch, join(resultsDirectory, STAGING), selected);
    const flaky = retried?.flaky ?? [];
    for (const file of flaky) sideRun.flaky.push({ suite: suite.name, file });
    // A file that still fails after its retry goes once to the tip of the target branch (ARK-428).
    const redOnMain: string[] = [];
    const stillFailed = results.filter((result) => result.status === "failed");
    if (mainCheck !== undefined && stillFailed.length > 0) {
      const reason =
        suite.base_command === undefined
          ? "the suite has no base_command"
          : stillFailed.some((result) => result.file === undefined)
            ? "a failed test names no file"
            : null;
      const checked =
        reason !== null
          ? { reason }
          : await mainCheck.check(suite, stillFailed, {
              scratch,
              tmp: suiteTmpdir,
              cores: taken.cores,
              reportBase: reportPath,
            });
      if ("reason" in checked)
        console.log(`suite      ${suite.name} head  not checked on main  (${checked.reason})`);
      else {
        redOnMain.push(...checked.red);
        for (const file of checked.unchecked)
          console.log(
            `suite      ${suite.name} head  not red on main  (${file}: not every test that failed at head fails at the tip)`,
          );
        output += checked.log;
        log += checked.log;
        writeFileSync(join(resultsDirectory, `${prefix}${suite.name}.log`), output);
        for (const file of redOnMain) sideRun.redOnMain.push({ suite: suite.name, file });
      }
    }
    const red = new Set(redOnMain);
    const unresolved = (retried?.failedFiles ?? []).filter(
      (file) => !flaky.includes(file) && !red.has(file),
    );
    // A non-zero exit is the failed tests only when every failed file passed on retry or is red on main.
    const passed =
      (outcome.code === 0 || (retried !== null && unresolved.length === 0)) &&
      results.every(
        (result) =>
          result.status !== "failed" || (result.file !== undefined && red.has(result.file)),
      );
    if (passed && cache)
      storeCached(
        cache.project,
        cache.key,
        { results, output, log, flaky, ...(redOnMain.length > 0 ? { redOnMain } : {}) },
        scratch,
      );
    return { results, passed, flaky, reused: false, code: outcome.code };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(suiteTmpdir, { recursive: true, force: true });
    taken?.release();
  }
}

/** The commit the base side of `ark test` runs at: the newest synced target commit, else the worktree.created base. `base` itself stays the created base for every other reader. */
const baseSide = (worktree?: RunState["worktrees"][number]): string | undefined =>
  worktree?.synced ?? worktree?.base;

const testFolder = /(^|\/)(test|tests|features)\//;

/** The head files that go into the base checkout: each the diff adds or changes under a test folder, and each selected test file wherever it lives, that exists at head. Deleted and renamed-from files stay at base. */
async function headTestPaths(
  headPath: string,
  base: string,
  selected: string[],
): Promise<string[]> {
  const changed = await run(
    ["git", "diff", "--name-only", "--no-renames", "--diff-filter=AM", "-z", base, "HEAD"],
    headPath,
  );
  if (changed.code !== 0)
    throw new ArkError(`git diff against the base failed in ${headPath}: ${changed.stderr.trim()}`);
  const paths = [
    ...changed.stdout.split("\0").filter((path) => testFolder.test(path)),
    ...selected,
  ];
  return paths.filter((path) => path !== "" && existsSync(join(headPath, path)));
}

function copyHeadTests(headPath: string, basePath: string, paths: string[]): void {
  for (const path of paths) {
    mkdirSync(dirname(join(basePath, path)), { recursive: true });
    copyFileSync(join(headPath, path), join(basePath, path));
  }
}

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

async function gitPaths(args: string[], cwd: string): Promise<string[]> {
  const result = await run(["git", ...args], cwd);
  if (result.code !== 0)
    throw new ArkError(`git ${args[0]} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter((path) => path !== "");
}

/** Why a suite is skipped in this run, or null. Only a quick run honors `paths`, matched against `git diff --name-only <base>..HEAD` (merge-in files count). A folder entry ends with `/`. */
export async function pathsSkipReason(
  suite: Suite,
  quick: boolean,
  worktrees: RunState["worktrees"],
  mirror: string,
): Promise<string | null> {
  if (!quick || suite.paths === undefined) return null;
  const base = worktrees.find((worktree) => worktree.repo === suite.repo)?.base;
  const changed =
    base === undefined
      ? []
      : await gitPaths(["diff", "--name-only", "-z", `${base}..HEAD`], join(mirror, suite.repo));
  const covered = (path: string) =>
    suite.paths!.some(
      (entry) => path === entry || path.startsWith(entry.endsWith("/") ? entry : `${entry}/`),
    );
  return changed.some(covered) ? null : `diff touches none of: ${suite.paths.join(", ")}`;
}

/** A suite runs only when its repo has a worktree in the run; repo `.` is the worktree repo of a one-repo project. One rule for the head and base passes. */
export function suiteRepoInRun(suite: Suite, worktrees: RunState["worktrees"]): boolean {
  return suite.repo === "." || worktrees.some((worktree) => worktree.repo === suite.repo);
}

/** Every path the run's own commits changed (first-parent, no merges), so a file that came in only through a merge-in is not here. */
async function touchedPaths(base: string, repoPath: string): Promise<Set<string>> {
  return new Set(
    await gitPaths(
      ["log", "--first-parent", "--no-merges", "--name-only", "--format=", "-z", `${base}..HEAD`],
      repoPath,
    ),
  );
}

/** The test files of the run's own commits (no merge-in files) that match `base_files`. */
async function ownPaths(suite: Suite, base: string, mirror: string): Promise<string[]> {
  const glob = new Bun.Glob(suite.base_files!);
  return [...(await touchedPaths(base, join(mirror, suite.repo)))].filter((path) =>
    glob.match(path),
  );
}

/** The own test files that still exist at head. */
async function ownTestFiles(suite: Suite, base: string, mirror: string): Promise<string[]> {
  return (await ownPaths(suite, base, mirror)).filter((path) =>
    existsSync(join(mirror, suite.repo, path)),
  );
}

/** The own test files that exist at the base commit: the changed and the deleted ones. */
async function ownBaseFiles(suite: Suite, base: string, mirror: string): Promise<string[]> {
  const cwd = join(mirror, suite.repo);
  const files: string[] = [];
  for (const path of await ownPaths(suite, base, mirror))
    if ((await run(["git", "cat-file", "-e", `${base}:${path}`], cwd)).code === 0) files.push(path);
  return files;
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
 * Runs suites on a throwaway checkout of each touched repo at its base side (the commit of the newest worktree.synced event that has one, else its worktree.created base), after the head's
 * test files are copied in, so a new test meets the base build. Untouched repos run on the workspace checkout,
 * as in the head run. A refactor run, and a suite with no `base_files`, run the whole suite; any other run
 * runs `base_command` on the test files of its own commits and skips a suite with none, and with every
 * suite skipped there is no checkout, setup or compose. Returns whether all that ran passed; a failure here is
 * data except for `kind: refactor`.
 * A suite whose key (the base commits, the hash of the copied test files, the suite command) has a stored passed
 * result is replayed; when every suite of the plan is stored there is no checkout, setup or compose.
 * Each checkout is a `git clone --shared`, not a worktree: it registers nothing in the source repo, so a run
 * killed before its cleanup leaves only a temp folder, never a dangling detached worktree.
 */
async function baseSuitesPassed(
  config: ProjectConfig,
  project: string,
  runId: string,
  resultsDirectory: string,
  mirror: string,
  worktrees: RunState["worktrees"],
  baseRun: SideRun,
  censusRun: SideRun,
  refactor: boolean,
): Promise<boolean> {
  const plan: PlanEntry[] = [];
  for (const suite of config.suites) {
    if (!suiteRepoInRun(suite, worktrees)) continue;
    if (refactor || suite.base_files === undefined) {
      // A refactor runs whole, but its added test files still need to reach base.
      const base = baseSide(worktrees.find((worktree) => worktree.repo === suite.repo));
      const files =
        suite.base_files === undefined || base === undefined
          ? undefined
          : await ownTestFiles(suite, base, mirror);
      plan.push({ suite, command: suite.command, files });
      continue;
    }
    const base = baseSide(worktrees.find((worktree) => worktree.repo === suite.repo));
    const files = base === undefined ? [] : await ownTestFiles(suite, base, mirror);
    if (files.length === 0) {
      baseRun.skipped.set(suite.name, "no changed test file");
      console.log(`suite      ${suite.name} base  skipped  (no changed test file)`);
    } else
      plan.push({
        suite,
        command: suite.base_command!.replaceAll("{files}", files.map(shellQuote).join(" ")),
        files,
      });
  }
  // The base run holds the head's copy of each changed test file, so it cannot list a test the head removed from
  // one. The census runs the pristine base: a whole-suite configuration runs the whole suite, any other the
  // run's own files as the base has them.
  const census: PlanEntry[] = [];
  for (const suite of config.suites) {
    if (!suiteRepoInRun(suite, worktrees)) continue;
    const base = baseSide(worktrees.find((worktree) => worktree.repo === suite.repo));
    if (base === undefined) continue;
    if (refactor || suite.base_files === undefined) {
      census.push({ suite, command: suite.command });
      continue;
    }
    const files = await ownBaseFiles(suite, base, mirror);
    if (files.length > 0)
      census.push({
        suite,
        command: suite.base_command!.replaceAll("{files}", files.map(shellQuote).join(" ")),
        files,
      });
  }
  if (plan.length === 0 && census.length === 0) return true;
  const censusDirectory = join(resultsDirectory, "census");
  mkdirSync(censusDirectory, { recursive: true });
  return runAtBase(config, project, runId, mirror, worktrees, [
    { run: censusRun, plan: census, directory: censusDirectory },
    { run: baseRun, plan, directory: resultsDirectory, copyHead: true },
  ]);
}

type PlanEntry = { suite: Suite; command: string; files?: string[] };
type BasePhase = { run: SideRun; plan: PlanEntry[]; directory: string; copyHead?: boolean };

/**
 * Clones each worktree repo shared into `root` at `commitOf(entry)`, detached, then links the untouched repos and runs
 * `setup`. `label` names the side in the errors.
 */
async function prepareCheckout(
  config: ProjectConfig,
  root: string,
  worktrees: RunState["worktrees"],
  commitOf: (entry: RunState["worktrees"][number]) => string | undefined,
  label: string,
): Promise<void> {
  for (const entry of [...worktrees].sort((a, b) => a.repo.localeCompare(b.repo))) {
    const { repo, path: source } = entry;
    const commit = commitOf(entry);
    if (commit === undefined) throw new ArkError(`worktree.created of ${repo} has no base commit`);
    const path = join(root, repo);
    mkdirSync(dirname(path), { recursive: true });
    const cloned = await run(
      ["git", "clone", "--shared", "--no-checkout", "--quiet", source, path],
      root,
    );
    const created =
      cloned.code === 0
        ? await run(["git", "checkout", "--quiet", "--detach", commit], path)
        : cloned;
    if (created.code !== 0)
      throw new ArkError(`${label} checkout of ${repo} failed: ${created.stderr.trim()}`);
    // after the clone: a repo of "." is cloned into the root, which must still be empty
    writeOwnerFile(root);
    if (existsSync(join(path, ".gitmodules"))) {
      // these runs use the pointer the commit records, never the run's library head; the head worktree's
      // folders are a local source, so an unreachable remote does not stop the run
      try {
        for (const submodule of submodulesOf(path))
          initSubmodule(path, submodule, [join(source, submodule.path)]);
      } catch (err) {
        if (!(err instanceof ArkError)) throw err;
        throw new ArkError(`${label} submodules of ${repo} failed: ${err.message}`);
      }
    }
  }
  linkUntouched(config.workspace, root, discoverRepos(config.workspace));
  for (const { repo } of worktrees) {
    if (config.setup) {
      const setup = await run(["sh", "-c", config.setup], join(root, repo));
      if (setup.code !== 0)
        throw new ArkError(
          `setup failed at the ${label} of ${repo}: ${(setup.stderr || setup.stdout).trim()}`,
        );
    }
  }
}

type MainCheck = {
  /** The files of the `failed` tests that the run did not touch and in which every test that failed at head also fails at the tip of the target branch, matched by name (`red`), the other files, e.g. renamed or deleted there, or with a test that passes there (`unchecked`), and the command log; or why none was checked. */
  check(
    suite: Suite,
    failed: TestResult[],
    env: { scratch: string; tmp: string; cores: number; reportBase: string },
  ): Promise<{ red: string[]; unchecked: string[]; log: string } | { reason: string }>;
  close(): Promise<void>;
};

/**
 * ARK-428: runs one test file at the tip of the target branch (`origin/<target>` after `git fetch origin`) in a lazy
 * throwaway checkout, made like the base checkout (`git clone --shared`, never a worktree; setup, compose). The
 * checkout appears on the first file to check and is removed by `close`. A file the run touched is never run
 * there. A file is red on main when each test that failed at head also fails there, matched by name, also when the file was flaky at head.
 */
function mainCheckOf(
  config: ProjectConfig,
  runId: string,
  mirror: string,
  worktrees: RunState["worktrees"],
): MainCheck {
  let root: string | null = null;
  let compose: string[] | null = null;
  let ready: Promise<string | null> | null = null;
  /** Null when the checkout is ready, else the reason it is not. */
  const prepare = async (): Promise<string | null> => {
    try {
      const commits = new Map<string, string>();
      for (const { repo, path } of worktrees) {
        const fetched = await run(["git", "fetch", "origin"], path);
        if (fetched.code !== 0)
          return `git fetch origin failed in ${repo}: ${fetched.stderr.trim()}`;
        const target = targetBranch(path, repoBase(config, repo));
        const tip = await run(["git", "rev-parse", "--verify", `origin/${target}^{commit}`], path);
        if (tip.code !== 0) return `origin/${target} of ${repo} not found`;
        commits.set(repo, tip.stdout.trim());
      }
      root = mkdtempSync(join(tmpdir(), "ark-tip-"));
      compose = composeFor(config, root, `${runId}-tip`);
      await prepareCheckout(config, root, worktrees, (entry) => commits.get(entry.repo), "tip");
      if (compose) {
        const up = await run([...compose, "up", "-d", "--wait"], root);
        if (up.code !== 0) return `compose up failed: ${(up.stderr || up.stdout).trim()}`;
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  return {
    async check(suite, failed, env) {
      const base = baseSide(worktrees.find((worktree) => worktree.repo === suite.repo));
      if (base === undefined) return { reason: `the run has no base commit for ${suite.repo}` };
      const touched = await touchedPaths(base, join(mirror, suite.repo));
      const candidates = [...new Set(failed.map((result) => result.file!))].filter(
        (file) => !touched.has(file),
      );
      if (candidates.length === 0) return { red: [], unchecked: [], log: "" };
      ready ??= prepare();
      const reason = await ready;
      if (reason !== null) return { reason };
      const red: string[] = [];
      const unchecked: string[] = [];
      let log = "";
      for (const [index, file] of candidates.entries()) {
        const reportPath = `${env.reportBase}.main-${index}`;
        const command = suite
          .base_command!.replaceAll("{files}", shellQuote(file))
          .replaceAll("{report}", reportPath)
          .replaceAll("<cores>", String(env.cores));
        const outcome = await run(["sh", "-c", command], join(root!, suite.repo), {
          ARK_EVIDENCE_DIR: env.scratch,
          TMPDIR: env.tmp,
        });
        const output = outcome.stdout + outcome.stderr;
        const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
        const again = parsers[suite.parser]({ report, stdout: outcome.stdout });
        const separator = output === "" || output.endsWith("\n") ? "" : "\n";
        log += `main ${file}\n${command}\n${output}${separator}exit ${outcome.code}\n`;
        const sameFailures = failed
          .filter((result) => result.file === file)
          .every((original) =>
            again.some((result) => result.name === original.name && result.status === "failed"),
          );
        if (sameFailures) red.push(file);
        else unchecked.push(file);
      }
      return { red, unchecked, log };
    },
    async close() {
      if (ready !== null) await ready;
      if (compose && root !== null)
        await run([...compose, "down"], existsSync(root) ? root : tmpdir());
      if (root !== null) rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Runs the phases in order on one throwaway checkout of each touched repo at its base commit. A phase with
 * `copyHead` first copies the head's test files in (the base run); the others see the pristine base (the census).
 * Returns whether the plan of the copyHead phase passed.
 */
async function runAtBase(
  config: ProjectConfig,
  project: string,
  runId: string,
  mirror: string,
  worktrees: RunState["worktrees"],
  phases: BasePhase[],
): Promise<boolean> {
  // What gets copied into the base checkout, per repo, and what the plan's keys hash.
  const plan = phases.find((phase) => phase.copyHead)!.plan;
  const copied = new Map<string, string[]>();
  for (const entry of worktrees) {
    const { repo } = entry;
    const base = baseSide(entry);
    if (base === undefined) throw new ArkError(`worktree.created of ${repo} has no base commit`);
    if ((await run(["git", "cat-file", "-e", `${base}^{commit}`], join(mirror, repo))).code !== 0)
      throw new ArkError(
        `base commit ${base} of ${repo} is not in the worktree: run \`ark worktree sync ${runId}\` to fetch the target branch again`,
      );
    copied.set(
      repo,
      await headTestPaths(
        join(mirror, repo),
        base,
        plan.filter((entry) => entry.suite.repo === repo).flatMap((entry) => entry.files ?? []),
      ),
    );
  }
  const bases = [...worktrees]
    .map((entry) => [entry.repo, baseSide(entry)])
    .sort(([a], [b]) => a!.localeCompare(b!));
  const touched = new Set(worktrees.map((worktree) => worktree.repo));
  // ponytail: an untouched repo is keyed by its workspace head, not by uncommitted edits in it
  const untouchedHeads = await Promise.all(
    discoverRepos(config.workspace)
      .filter((repo) => !touched.has(repo))
      .sort()
      .map(async (repo) => [repo, await headOf(repo, config.workspace, mirror)]),
  );
  const testFiles = hashFiles(
    [...copied].flatMap(([repo, paths]) =>
      paths.map((path) => ({ path: `${repo}/${path}`, absolute: join(mirror, repo, path) })),
    ),
  );
  const keyed = phases.map((phase) =>
    phase.plan.map((entry) => ({
      ...entry,
      cache: {
        project,
        key: cacheKey({
          side: phase.run.side,
          bases,
          untouchedHeads,
          // the census runs the pristine base: no head file is in its key
          testFiles: phase.copyHead ? testFiles : "",
          suite: [
            entry.suite.name,
            entry.suite.repo,
            entry.suite.parser,
            entry.suite.base_command,
            entry.command,
          ],
          setup: config.setup,
          compose: config.compose,
        }),
      },
    })),
  );
  const allCached = keyed.every((entries) =>
    entries.every((entry) => hasCached(project, entry.cache.key)),
  );
  const root = allCached ? null : mkdtempSync(join(tmpdir(), "ark-base-"));
  const compose = root === null ? null : composeFor(config, root, `${runId}-base`);
  try {
    if (root !== null) await prepareCheckout(config, root, worktrees, baseSide, "base");
    if (compose && root !== null) {
      const up = await run([...compose, "up", "-d", "--wait"], root);
      if (up.code !== 0)
        throw new ArkError(`compose up failed: ${(up.stderr || up.stdout).trim()}`);
    }
    // Every suite runs, also after a failed one.
    let allPassed = true;
    const checkBase = () => {
      if (root !== null && !existsSync(root)) throw new ArkError(`base checkout missing: ${root}`);
    };
    for (const [index, phase] of phases.entries()) {
      if (phase.copyHead && root !== null)
        for (const { repo } of worktrees)
          copyHeadTests(join(mirror, repo), join(root, repo), copied.get(repo)!);
      for (const { suite, command, files, cache } of keyed[index]!) {
        checkBase();
        const { results, passed, reused } = await runSuite(
          suite,
          join(root ?? "", suite.repo),
          phase.directory,
          phase.run,
          baseSide(worktrees.find((worktree) => worktree.repo === suite.repo)) ??
            (await headOf(suite.repo, config.workspace, mirror)),
          command,
          files,
          cache,
        );
        phase.run.listed.set(suite.name, results);
        if (reused && phase.copyHead)
          console.log(`suite      ${suite.name} base  reused  base key ${cache.key.slice(0, 6)}`);
        if (phase.copyHead) allPassed &&= passed;
      }
    }
    checkBase();
    return allPassed;
  } finally {
    // a vanished root is no cwd: down runs from tmpdir() (it names the root by --project-directory), so spawn cannot throw over the ArkError
    if (compose && root !== null)
      await run([...compose, "down"], existsSync(root) ? root : tmpdir());
    if (root !== null) rmSync(root, { recursive: true, force: true });
  }
}

/** `ark test`: the caller side. The runner below does the work, detached from this process. */
export async function testRun(
  runId: string,
  inProject: string | undefined,
  options: { quick: boolean; wait: boolean; stop: boolean },
): Promise<void> {
  const { project, directory } = findRun(runId, inProject);
  await callTest(runId, project, directory, options);
}

/** `ark test-runner`: the process of the detached runner; returns its exit code. SIGTERM stops every suite process group. */
export function testRunnerMain(runId: string, project: string, quick: boolean): Promise<number> {
  const { directory } = findRun(runId, project);
  return runnerMain(directory, quick, () => executeTest(runId, project, quick), stopChildren);
}

async function executeTest(runId: string, inProject: string, quick: boolean): Promise<void> {
  const { project, directory } = findRun(runId, inProject);
  const config = loadConfig(project);
  const mirror = mirrorRoot(directory);
  if (!existsSync(mirror))
    throw new ArkError(`${runId} has no workspace mirror: run ark worktree create first`);
  const resultsDirectory = join(directory, "results");
  mkdirSync(resultsDirectory, { recursive: true });
  // ARK-422: every run writes to a staging folder; only a full run replaces `results/evidence` with it (see below).
  // A stopped run leaves its staging folder behind: remove it first.
  const evidenceDirectory = join(resultsDirectory, STAGING);
  rmSync(evidenceDirectory, { recursive: true, force: true });
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

  // The checks and suites of every ark test on the host share one CPU budget, held by this runner until it exits.
  budget = openTestBudget(runId, config.test_budget_cores, {
    minimumFreeMemoryPercent: config.test_min_free_memory_percent,
    maximumSwapGigabytes: config.test_max_swap_gb,
  });
  const started = Date.now();
  try {
    const composeBase = composeFor(config, mirror, runId);
    const checks: { name: string; passed: boolean }[] = [];
    for (const check of config.checks) {
      const taken = await budget.take(check.cores);
      const outcome = await run(
        ["sh", "-c", check.command.replaceAll("<cores>", String(taken.cores))],
        join(mirror, check.repo),
      ).finally(taken.release);
      const output = outcome.stdout + outcome.stderr;
      writeFileSync(join(resultsDirectory, `check-${check.name}.log`), output);
      checks.push({ name: check.name, passed: outcome.code === 0 });
      if (outcome.code !== 0) {
        console.log(`check ${check.name} failed`);
        console.log(output.trimEnd().split("\n").slice(-20).join("\n"));
      }
    }
    // ARK-384: once per bun suite, on the diff from the run's base; reads git objects, so the cache keys are unchanged.
    for (const suite of config.suites) {
      const label = `old id    suite ${suite.name} (${suite.parser})`;
      if (suite.parser !== "bun") {
        console.log(`${label}  skipped  (parser ${suite.parser} has no old-id check)`);
        continue;
      }
      const base = baseSide(state.worktrees.find((worktree) => worktree.repo === suite.repo));
      if (base === undefined) {
        console.log(`${label}  skipped  (no base commit)`);
        continue;
      }
      let touched: string[];
      try {
        // ARK-463: from the merge base of HEAD and the newest synced target commit, so a target commit that sync merged never counts; a synced commit that HEAD lacks (a reset `--merge` step) leaves the diff at their merge base.
        const mergeBase = await run(["git", "merge-base", "HEAD", base], join(mirror, suite.repo));
        if (mergeBase.code !== 0)
          throw new ArkError(`git merge-base failed: ${mergeBase.stderr.trim()}`);
        touched = await oldIdsTouched(
          join(mirror, suite.repo),
          mergeBase.stdout.trim(),
          suite,
          config.suites,
        );
      } catch (err) {
        // A scan that cannot run is no old-id declaration: say why, and leave the verdict to the suites.
        console.log(`${label}  skipped  (scan failed: ${String(err)})`);
        continue;
      }
      writeFileSync(join(resultsDirectory, `check-old-id-${suite.name}.log`), touched.join("\n"));
      checks.push({ name: `old-id ${suite.name}`, passed: touched.length === 0 });
      if (touched.length === 0) console.log(`${label}  passed  (0 old-id declarations touched)`);
      else {
        console.log(`${label}  failed`);
        console.log(touched.join("\n"));
        console.log(
          "fix       write a test case (ark test-case new <KEY>), start the title with its id, name it in the plan",
        );
      }
    }
    // ARK-431: a changed test must hold only case ids that plan.yml test_cases lists. Ids only, any action passes.
    let planned: Set<string> | undefined;
    try {
      planned = new Set(loadPlan(directory).test_cases.map((testCase) => testCase.id));
    } catch (err) {
      console.log(`plan-membership check  skipped  (${String(err)})`);
    }
    for (const suite of planned === undefined ? [] : config.suites) {
      const label = `plan-membership suite ${suite.name} (${suite.parser})`;
      // the newest synced target commit, not the created base: what main changed is not this run's change
      const base = baseSide(state.worktrees.find((worktree) => worktree.repo === suite.repo));
      if (suite.parser !== "bun" || base === undefined) continue;
      let missing: string[];
      try {
        missing = await caseIdsOutsidePlan(
          join(mirror, suite.repo),
          base,
          suite,
          config.suites,
          planned!,
        );
      } catch (err) {
        console.log(`${label}  skipped  (scan failed: ${String(err)})`);
        continue;
      }
      writeFileSync(
        join(resultsDirectory, `check-plan-membership-${suite.name}.log`),
        missing.join("\n"),
      );
      checks.push({ name: `plan-membership ${suite.name}`, passed: missing.length === 0 });
      if (missing.length === 0) console.log(`${label}  passed  (0 case ids outside the plan)`);
      else {
        console.log(`${label}  failed`);
        console.log(missing.join("\n"));
        console.log("fix       add the id to test_cases with the action reuse, update or retire");
      }
    }
    const repos = discoverRepos(config.workspace);
    const heads = Object.fromEntries(
      await Promise.all(
        repos.map(async (repo) => [repo, await headOf(repo, config.workspace, mirror)]),
      ),
    );
    // A dirty checkout has results no head names: nothing of this run is read from or stored in the cache.
    const dirty = (
      await Promise.all(
        repos.map(
          async (repo) =>
            (
              await run(
                ["git", "status", "--porcelain"],
                checkoutOf(repo, config.workspace, mirror),
              )
            ).stdout !== "",
        ),
      )
    ).some(Boolean);
    const mode = quick ? "quick" : "full";
    const suites: {
      name: string;
      level: string;
      passed: boolean;
      reused?: boolean;
      flaky?: string[];
    }[] = [];
    const headKeys = new Map<string, string>();
    // ARK-333: the exit code of each head suite, printed with a failed suite; not part of the recorded `suites`.
    const exitCodes = new Map<string, number>();
    // The join through `verified_by` counts every level; the old tag path only integration and e2e.
    const allResults: TestResult[] = [];
    const provingResults: TestResult[] = [];
    const headResults = new Map<string, TestResult[]>();
    const headRun = newSide("head");
    // A quick run is not a gate, so it needs no main check.
    const mainCheck = quick ? undefined : mainCheckOf(config, runId, mirror, state.worktrees);
    const baseRun = newSide("base");
    const censusRun = newSide("census");

    try {
      if (composeBase) {
        const up = await run([...composeBase, "up", "-d", "--wait"], mirror);
        if (up.code !== 0)
          throw new ArkError(`compose up failed: ${(up.stderr || up.stdout).trim()}`);
      }
      for (const suite of config.suites) {
        if (!suiteRepoInRun(suite, state.worktrees)) {
          console.log(`skipped ${suite.name} (repo ${suite.repo} not in run)`);
          continue;
        }
        const skip = await pathsSkipReason(suite, quick, state.worktrees, mirror);
        if (skip !== null) {
          headRun.skipped.set(suite.name, skip);
          console.log(`suite      ${suite.name} head  skipped  (${skip})`);
          continue;
        }
        // A quick run runs the own-commit files of a suite with base_files, and the whole suite of one without.
        let template: string | undefined;
        let files: string[] | undefined;
        if (quick && suite.base_files !== undefined) {
          const base = state.worktrees.find((worktree) => worktree.repo === suite.repo)?.base;
          files = base === undefined ? [] : await ownTestFiles(suite, base, mirror);
          if (files.length === 0) {
            headRun.skipped.set(suite.name, "no changed test file");
            console.log(`suite      ${suite.name} head  skipped  (no changed test file)`);
            continue;
          }
          template = suite.base_command!.replaceAll("{files}", files.map(shellQuote).join(" "));
        }
        const key = cacheKey({
          side: "head",
          mode,
          heads,
          suite: [
            suite.name,
            suite.repo,
            suite.parser,
            suite.base_command,
            template ?? suite.command,
          ],
          setup: config.setup,
          compose: config.compose,
        });
        headKeys.set(suite.name, key.slice(0, 6));
        const { results, passed, flaky, reused, code } = await runSuite(
          suite,
          join(mirror, suite.repo),
          resultsDirectory,
          headRun,
          heads[suite.repo]!,
          template,
          files,
          dirty ? undefined : { project, key },
          mainCheck,
        );
        exitCodes.set(suite.name, code);
        allResults.push(...results);
        headResults.set(suite.name, results);
        if (suite.level !== "unit") provingResults.push(...results);
        suites.push({
          name: suite.name,
          level: suite.level,
          passed,
          ...(reused ? { reused } : {}),
          ...(flaky.length > 0 ? { flaky } : {}),
        });
      }
    } finally {
      if (composeBase) await run([...composeBase, "down"], mirror);
      await mainCheck?.close();
    }

    const criterionStatuses: Record<string, Status> = {};
    const via: Record<string, string> = {};
    // ARK-333: the test case ids that read `missing`, one hint line each after the criterion line.
    const missingCases: Record<string, string[]> = {};
    for (const criterion of criteria) {
      const verifiedBy = ticketCriteria.get(criterion)?.verified_by ?? [];
      if (manual.has(criterion)) {
        // A manual criterion is decided by the manual gate alone, also when a test is tagged with it.
        criterionStatuses[criterion] = manualStatus(state.gates[`manual:${criterion}`]);
        via[criterion] = `method ${ticketCriteria.get(criterion)?.method}`;
      } else if (verifiedBy.length > 0) {
        const cases = verifiedBy.map((id) => ({
          id,
          status: caseStatus(id, allResults, headRun.skipped.size > 0),
        }));
        criterionStatuses[criterion] = quickStatus(verifiedByStatus(cases), quick);
        via[criterion] = `via ${cases.map((entry) => `${entry.id} ${entry.status}`).join(", ")}`;
        missingCases[criterion] = cases
          .filter((entry) => entry.status === "missing")
          .map((entry) => entry.id);
      } else {
        criterionStatuses[criterion] = quickStatus(
          criterionStatus(criterion, provingResults),
          quick,
        );
        via[criterion] = "via tag";
      }
    }
    // Every run also runs the suites at the base commit; a passed base result is reused by its key.
    // A base failure is data, except that a refactor run must keep its behavior.
    // A quick run has no base run.
    const basePassed =
      quick ||
      (await baseSuitesPassed(
        config,
        project,
        runId,
        resultsDirectory,
        mirror,
        // An old worktree.created event may hold no base: only a refactor run, which needs the base, refuses it.
        state.kind === "refactor"
          ? state.worktrees
          : state.worktrees.filter((worktree) => worktree.base !== undefined),
        baseRun,
        censusRun,
        state.kind === "refactor",
      ));
    // What the base lists comes from the pristine census alone, never from the base run, which holds the head's
    // copy of the test files. A suite with no census (only added test files, no changed test file, a quick run)
    // contributes nothing.
    const baseListed = censusRun.listed;
    const counted = !quick && (baseListed.size > 0 || baseRun.listed.size > 0);
    const passedCount = countStatus(allResults, "passed");
    const skippedCount = countStatus(allResults, "skipped");
    const baseSkipped = [...baseListed.values()].reduce(
      (sum, results) => sum + countStatus(results, "skipped"),
      0,
    );
    const deleted = counted ? deletedTests(baseListed, headResults) : [];
    if (!quick) {
      addMissing(baseRun, headRun, evidenceDirectory);
      addMissing(headRun, baseRun, evidenceDirectory);
    }
    writeResults(headRun, evidenceDirectory);
    writeResults(baseRun, evidenceDirectory);
    publishEvidence(resultsDirectory, !quick);
    const passed =
      checks.every((check) => check.passed) &&
      suites.every((suite) => suite.passed) &&
      Object.entries(criterionStatuses).every(
        ([criterion, status]) =>
          manual.has(criterion) || status === "passing" || status === "not run",
      );
    const reused = [
      ...headRun.reused.map((name) => `head:${name}`),
      ...baseRun.reused.map((name) => `base:${name}`),
    ];
    appendEvent(directory, "test.completed", {
      passed,
      ...(checks.length > 0 ? { checks } : {}),
      heads,
      suites,
      ...(headRun.flaky.length > 0 ? { flaky: headRun.flaky } : {}),
      ...(headRun.redOnMain.length > 0
        ? { red_on_main: [...new Set(headRun.redOnMain.map(({ file }) => file))] }
        : {}),
      ...(reused.length > 0 ? { reused } : {}),
      criteria: criterionStatuses,
      passed_count: passedCount,
      skipped: skippedCount,
      ...(counted ? { base_skipped: baseSkipped, deleted } : {}),
      ...(state.kind === "refactor" && !quick ? { base_passed: basePassed } : {}),
      mode: quick ? "quick" : "full",
      duration: Math.round((Date.now() - started) / 1000),
    });

    if (!quick) console.log(`base      ${basePassed ? "passed" : "failed"}`);
    for (const suite of suites) {
      console.log(
        `suite      ${suite.name} (${suite.level})  ${suite.passed ? "passed" : "failed"}${suite.reused ? `  reused  head key ${headKeys.get(suite.name)}` : ""}${suite.flaky ? `  flaky: ${suite.flaky.join(", ")} (failed once, passed on retry)` : ""}`,
      );
      if (suite.passed) continue;
      // ARK-333: why the suite failed, as a failed check prints it: the exit code, the log, its last 20 lines.
      console.log(`exit code  ${exitCodes.get(suite.name)}`);
      console.log(`log        results/${suite.name}.log`);
      const log = readFileSync(join(resultsDirectory, `${suite.name}.log`), "utf8");
      console.log(log.trimEnd().split("\n").slice(-20).join("\n"));
    }
    for (const { suite, file } of headRun.redOnMain)
      console.log(
        `red on main  ${suite}  ${file}  (fails at the tip of the target branch too, not counted)`,
      );
    console.log(
      `tests      ${passedCount} passed, ${skippedCount} skipped${counted ? ` (base ${baseSkipped}), ${deleted.length} deleted` : ""}`,
    );
    for (const { file, name } of deleted)
      console.log(`deleted    ${file === undefined ? "" : `${file}  `}${name}`);
    for (const [criterion, status] of Object.entries(criterionStatuses)) {
      console.log(`criterion  ${criterion}  ${status.padEnd(14)}  ${via[criterion]}`);
      for (const id of missingCases[criterion] ?? [])
        console.log(`  no test title starts with ${id}`);
    }
    for (const id of [...new Set([...headRun.cases.keys(), ...baseRun.cases.keys()])].sort())
      console.log(`evidence   results/evidence/${id}/{base,head}`);

    if (quick) console.log(`mode: quick (not a gate: run ark test ${runId} before the MR)`);
    const problems = [
      ...checks.filter((check) => !check.passed).map((check) => `check ${check.name} failed`),
      ...suites.filter((suite) => !suite.passed).map((suite) => `suite ${suite.name} failed`),
      ...(state.kind === "refactor" && !quick && !basePassed && hasTestCriterion(directory)
        ? ["refactor run: the suites fail at the base commit"]
        : []),
      ...Object.entries(criterionStatuses)
        .filter(
          ([criterion, status]) =>
            status !== "not run" && status !== (manual.has(criterion) ? "manual ok" : "passing"),
        )
        .map(([criterion, status]) => `${criterion} is ${status}`),
    ];
    if (problems.length > 0)
      throw new ArkError(`tests did not prove every criterion: ${problems.join("; ")}`);
  } finally {
    budget.close();
    budget = null;
  }
}
