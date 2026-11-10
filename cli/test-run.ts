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
import { oldIdsTouched } from "./test-audit.ts";
import { findRun } from "./paths.ts";
import { cacheKey, hasCached, hashFiles, loadCached, storeCached } from "./test-cache.ts";
import { openTestBudget, type TestBudget } from "./test-lock.ts";
import { callTest, runnerMain } from "./test-runner.ts";
import { discoverRepos, mirrorRoot, submodulesOf } from "./workspace.ts";
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

async function run(command: string[], cwd: string, env?: Record<string, string>) {
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
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // A signal is stopping the run: never let it go on to the next process or write results.
    if (stopping) await new Promise<never>(() => {});
    return { code, stdout, stderr };
  } finally {
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

type Side = "base" | "head";
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
};
const statusRank = { "not run": -1, skipped: 0, passed: 1, failed: 2 };

const newSide = (side: Side): SideRun => ({
  side,
  cases: new Map(),
  suites: new Map(),
  skipped: new Map(),
  reused: [],
  flaky: [],
});

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
): Promise<{ results: TestResult[]; flaky: string[]; allPassed: boolean; log: string } | null> {
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
  return { results: kept, flaky, allPassed: flaky.length === failedFiles.length, log };
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
) {
  const prefix = sideRun.side === "base" ? "base-" : "";
  const reportPath = join(resultsDirectory, `${prefix}${suite.name}.report`);
  const scratch = writeOwnerFile(mkdtempSync(join(tmpdir(), "ark-evidence-")));
  // ARK-390: a private TMPDIR per suite, so two suites or two runs never share temp files.
  const suiteTmpdir = writeOwnerFile(mkdtempSync(join(tmpdir(), "ark-suite-")));
  let taken: { cores: number; release: () => void } | null = null;
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
        join(resultsDirectory, "evidence"),
        selected,
      );
      sideRun.reused.push(suite.name);
      for (const file of cached.flaky) sideRun.flaky.push({ suite: suite.name, file });
      return { results: cached.results, passed: true, flaky: cached.flaky, reused: true };
    }
    // ARK-390: a cached suite takes no cores; a suite that runs waits for its cores in the host budget.
    taken = await budget!.take(suite.cores);
    const command = template
      .replaceAll("{report}", reportPath)
      .replaceAll("<cores>", String(taken.cores));
    const outcome = await run(["sh", "-c", command], cwd, {
      ARK_EVIDENCE_DIR: scratch,
      TMPDIR: suiteTmpdir,
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
    addSuite(
      sideRun,
      suite,
      sha,
      log,
      results,
      scratch,
      join(resultsDirectory, "evidence"),
      selected,
    );
    const flaky = retried?.flaky ?? [];
    for (const file of flaky) sideRun.flaky.push({ suite: suite.name, file });
    // A non-zero exit is the failed tests only when every failed file passed on retry.
    const passed =
      (outcome.code === 0 || retried?.allPassed === true) &&
      results.every((result) => result.status !== "failed");
    if (passed && cache)
      storeCached(cache.project, cache.key, { results, output, log, flaky }, scratch);
    return { results, passed, flaky, reused: false };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(suiteTmpdir, { recursive: true, force: true });
    taken?.release();
  }
}

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

/** The test files of the run's own commits (no merge-in files) that still exist at head and match `base_files`. */
async function ownTestFiles(suite: Suite, base: string, mirror: string): Promise<string[]> {
  const glob = new Bun.Glob(suite.base_files!);
  const cwd = join(mirror, suite.repo);
  const logged = await gitPaths(
    ["log", "--first-parent", "--no-merges", "--name-only", "--format=", "-z", `${base}..HEAD`],
    cwd,
  );
  return [...new Set(logged)].filter((path) => glob.match(path) && existsSync(join(cwd, path)));
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
 * Runs suites on a throwaway checkout of each touched repo at its worktree.created base, after the head's
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
  refactor: boolean,
): Promise<boolean> {
  const plan: { suite: Suite; command: string; files?: string[] }[] = [];
  for (const suite of config.suites) {
    if (refactor || suite.base_files === undefined) {
      // A refactor runs whole, but its added test files still need to reach base.
      const base = worktrees.find((worktree) => worktree.repo === suite.repo)?.base;
      const files =
        suite.base_files === undefined || base === undefined
          ? undefined
          : await ownTestFiles(suite, base, mirror);
      plan.push({ suite, command: suite.command, files });
      continue;
    }
    const base = worktrees.find((worktree) => worktree.repo === suite.repo)?.base;
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
  if (plan.length === 0) return true;
  // What gets copied into the base checkout, per repo, and what the plan's keys hash.
  const copied = new Map<string, string[]>();
  for (const { repo, base } of worktrees) {
    if (base === undefined) throw new ArkError(`worktree.created of ${repo} has no base commit`);
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
    .map(({ repo, base }) => [repo, base])
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
  const keyed = plan.map((entry) => ({
    ...entry,
    cache: {
      project,
      key: cacheKey({
        side: "base",
        bases,
        untouchedHeads,
        testFiles,
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
  }));
  const allCached = keyed.every((entry) => hasCached(project, entry.cache.key));
  const root = allCached ? null : mkdtempSync(join(tmpdir(), "ark-base-"));
  const compose = root === null ? null : composeFor(config, root, `${runId}-base`);
  try {
    if (root !== null)
      for (const { repo, path: source, base } of [...worktrees].sort((a, b) =>
        a.repo.localeCompare(b.repo),
      )) {
        if (base === undefined)
          throw new ArkError(`worktree.created of ${repo} has no base commit`);
        const path = join(root, repo);
        mkdirSync(dirname(path), { recursive: true });
        const cloned = await run(
          ["git", "clone", "--shared", "--no-checkout", "--quiet", source, path],
          root,
        );
        const created =
          cloned.code === 0
            ? await run(["git", "checkout", "--quiet", "--detach", base], path)
            : cloned;
        if (created.code !== 0)
          throw new ArkError(`base checkout of ${repo} failed: ${created.stderr.trim()}`);
        // after the clone: a repo of "." is cloned into the root, which must still be empty
        writeOwnerFile(root);
        if (existsSync(join(path, ".gitmodules"))) {
          // base runs use the pointer the base commit records, never the run's library head; the head worktree's
          // folders are a local source, so an unreachable remote does not stop the base side
          try {
            for (const submodule of submodulesOf(path))
              initSubmodule(path, submodule, [join(source, submodule.path)]);
          } catch (err) {
            if (!(err instanceof ArkError)) throw err;
            throw new ArkError(`base submodules of ${repo} failed: ${err.message}`);
          }
        }
        copyHeadTests(join(mirror, repo), path, copied.get(repo)!);
      }
    if (root !== null) {
      linkUntouched(config.workspace, root, discoverRepos(config.workspace));
      for (const { repo } of worktrees) {
        if (config.setup) {
          const setup = await run(["sh", "-c", config.setup], join(root, repo));
          if (setup.code !== 0)
            throw new ArkError(
              `setup failed at the base of ${repo}: ${(setup.stderr || setup.stdout).trim()}`,
            );
        }
      }
    }
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
    for (const { suite, command, files, cache } of keyed) {
      checkBase();
      const { passed, reused } = await runSuite(
        suite,
        join(root ?? "", suite.repo),
        resultsDirectory,
        baseRun,
        worktrees.find((worktree) => worktree.repo === suite.repo)?.base ??
          (await headOf(suite.repo, config.workspace, mirror)),
        command,
        files,
        cache,
      );
      if (reused)
        console.log(`suite      ${suite.name} base  reused  base key ${cache.key.slice(0, 6)}`);
      allPassed &&= passed;
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

  // The checks and suites of every ark test on the host share one CPU budget, held by this runner until it exits.
  budget = openTestBudget(runId, config.test_budget_cores);
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
      const base = state.worktrees.find((worktree) => worktree.repo === suite.repo)?.base;
      if (base === undefined) {
        console.log(`${label}  skipped  (no base commit)`);
        continue;
      }
      const touched = await oldIdsTouched(join(mirror, suite.repo), base, suite, config.suites);
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
    // The join through `verified_by` counts every level; the old tag path only integration and e2e.
    const allResults: TestResult[] = [];
    const provingResults: TestResult[] = [];
    const headRun = newSide("head");
    const baseRun = newSide("base");

    try {
      if (composeBase) {
        const up = await run([...composeBase, "up", "-d", "--wait"], mirror);
        if (up.code !== 0)
          throw new ArkError(`compose up failed: ${(up.stderr || up.stdout).trim()}`);
      }
      for (const suite of config.suites) {
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
        const { results, passed, flaky, reused } = await runSuite(
          suite,
          join(mirror, suite.repo),
          resultsDirectory,
          headRun,
          heads[suite.repo]!,
          template,
          files,
          dirty ? undefined : { project, key },
        );
        allResults.push(...results);
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
        const cases = verifiedBy.map((id) => ({
          id,
          status: caseStatus(id, allResults, headRun.skipped.size > 0),
        }));
        criterionStatuses[criterion] = quickStatus(verifiedByStatus(cases), quick);
        via[criterion] = `via ${cases.map((entry) => `${entry.id} ${entry.status}`).join(", ")}`;
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
        state.kind === "refactor",
      ));
    if (!quick) {
      addMissing(baseRun, headRun, evidenceDirectory);
      addMissing(headRun, baseRun, evidenceDirectory);
    }
    writeResults(headRun, evidenceDirectory);
    writeResults(baseRun, evidenceDirectory);
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
      ...(reused.length > 0 ? { reused } : {}),
      criteria: criterionStatuses,
      ...(state.kind === "refactor" && !quick ? { base_passed: basePassed } : {}),
      mode: quick ? "quick" : "full",
      duration: Math.round((Date.now() - started) / 1000),
    });

    if (!quick) console.log(`base      ${basePassed ? "passed" : "failed"}`);
    for (const suite of suites)
      console.log(
        `suite      ${suite.name} (${suite.level})  ${suite.passed ? "passed" : "failed"}${suite.reused ? `  reused  head key ${headKeys.get(suite.name)}` : ""}${suite.flaky ? `  flaky: ${suite.flaky.join(", ")} (failed once, passed on retry)` : ""}`,
      );
    for (const [criterion, status] of Object.entries(criterionStatuses))
      console.log(`criterion  ${criterion}  ${status.padEnd(14)}  ${via[criterion]}`);
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
