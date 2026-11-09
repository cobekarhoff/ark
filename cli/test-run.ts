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
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents, type RunState } from "./events.ts";
import { manualStatus, type CriterionStatus } from "./lifecycle.ts";
import { parsers, type TestResult } from "./parsers/index.ts";
import { readCaseEntries } from "./test-case.ts";
import { findRun } from "./paths.ts";
import { takeTestLock } from "./test-lock.ts";
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

// The worktree's HEAD for a touched repo, the workspace checkout's HEAD for an untouched one.
async function headOf(repo: string, workspace: string, mirror: string): Promise<string> {
  const mirrored = join(mirror, repo);
  const touched = existsSync(join(mirrored, ".git")) && !lstatSync(mirrored).isSymbolicLink();
  const result = await run(
    ["git", "rev-parse", "HEAD"],
    touched ? mirrored : join(workspace, repo),
  );
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

type Suite = ProjectConfig["suites"][number];

type Side = "base" | "head";
/** What one side knows of a case: the winning result of every suite that carries it, and the suites that did. */
type CaseEntry = {
  name: string;
  status: TestResult["status"];
  repo: string;
  sha: string;
  suites: string[];
};
/** One side of a run: the evidence of each case and, for each suite, the repo, SHA and command log that ran. */
type SideRun = {
  side: Side;
  cases: Map<string, CaseEntry>;
  suites: Map<string, { repo: string; sha: string; log: string }>;
};
const statusRank = { skipped: 0, passed: 1, failed: 2 };

const newSide = (side: Side): SideRun => ({ side, cases: new Map(), suites: new Map() });

/** Merges the results of one suite into the side. A failed test wins over a passed one, a passed over a skipped one, across suites too. */
function addSuite(
  run: SideRun,
  suite: Suite,
  sha: string,
  log: string,
  results: TestResult[],
  scratch: string,
  evidenceDirectory: string,
): void {
  run.suites.set(suite.name, { repo: suite.repo, sha, log });
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
        });
      else {
        if (!entry.suites.includes(suite.name)) entry.suites.push(suite.name);
        if (statusRank[result.status] > statusRank[entry.status])
          Object.assign(entry, { name: result.name, status: result.status, repo: suite.repo, sha });
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
 */
function addMissing(run: SideRun, other: SideRun, evidenceDirectory: string): void {
  for (const [id, found] of other.cases) {
    if (run.cases.has(id)) continue;
    const suite = run.suites.get(found.suites[0]!);
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

/**
 * Runs one suite in `cwd`. Its log goes to `<name>.log` of `resultsDirectory` (`base-<name>.log` at base).
 * `ARK_EVIDENCE_DIR` names a scratch folder for the run; the evidence of each test case is merged into `sideRun`.
 * `command.log` is the whole suite output, so every case of the suite shares it. Passed also needs no failed test.
 */
async function runSuite(
  suite: Suite,
  cwd: string,
  resultsDirectory: string,
  sideRun: SideRun,
  sha: string,
) {
  const prefix = sideRun.side === "base" ? "base-" : "";
  const reportPath = join(resultsDirectory, `${prefix}${suite.name}.report`);
  const command = suite.command.replaceAll("{report}", reportPath);
  const scratch = mkdtempSync(join(tmpdir(), "ark-evidence-"));
  try {
    const outcome = await run(["sh", "-c", command], cwd, { ARK_EVIDENCE_DIR: scratch });
    const output = outcome.stdout + outcome.stderr;
    writeFileSync(join(resultsDirectory, `${prefix}${suite.name}.log`), output);
    const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    const results = parsers[suite.parser]({ report, stdout: outcome.stdout });
    const separator = output === "" || output.endsWith("\n") ? "" : "\n";
    addSuite(
      sideRun,
      suite,
      sha,
      `${command}\n${output}${separator}exit ${outcome.code}\n`,
      results,
      scratch,
      join(resultsDirectory, "evidence"),
    );
    return {
      results,
      passed: outcome.code === 0 && results.every((result) => result.status !== "failed"),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const testFolder = /(^|\/)(test|tests|features)\//;

/** Copies the head's version of each file the diff adds or changes under a test folder into the base checkout. Deleted and renamed-from files stay at base. */
async function copyHeadTests(headPath: string, basePath: string, base: string): Promise<void> {
  const changed = await run(
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
 * Each checkout is a `git clone --shared`, not a worktree: it registers nothing in the source repo, so a run
 * killed before its cleanup leaves only a temp folder, never a dangling detached worktree.
 */
async function baseSuitesPassed(
  config: ProjectConfig,
  runId: string,
  resultsDirectory: string,
  mirror: string,
  worktrees: RunState["worktrees"],
  baseRun: SideRun,
): Promise<boolean> {
  const root = mkdtempSync(join(tmpdir(), "ark-base-"));
  const compose = composeFor(config, root, `${runId}-base`);
  try {
    for (const { repo, path: source, base } of [...worktrees].sort((a, b) =>
      a.repo.localeCompare(b.repo),
    )) {
      if (base === undefined) throw new ArkError(`worktree.created of ${repo} has no base commit`);
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
      await copyHeadTests(join(mirror, repo), path, base);
    }
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
    if (compose) {
      const up = await run([...compose, "up", "-d", "--wait"], root);
      if (up.code !== 0)
        throw new ArkError(`compose up failed: ${(up.stderr || up.stdout).trim()}`);
    }
    // Every suite runs, also after a failed one.
    let allPassed = true;
    for (const suite of config.suites) {
      const { passed } = await runSuite(
        suite,
        join(root, suite.repo),
        resultsDirectory,
        baseRun,
        await headOf(suite.repo, root, root),
      );
      allPassed &&= passed;
    }
    return allPassed;
  } finally {
    if (compose) await run([...compose, "down"], root);
    rmSync(root, { recursive: true, force: true });
  }
}

export async function testRun(runId: string, inProject?: string): Promise<void> {
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

  // One ark test at a time per host: the checks, compose and suites all load the machine.
  const releaseLock = await takeTestLock(runId, stopChildren);
  try {
    const composeBase = composeFor(config, mirror, runId);
    const checks: { name: string; passed: boolean }[] = [];
    for (const check of config.checks) {
      const outcome = await run(["sh", "-c", check.command], join(mirror, check.repo));
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
    const headRun = newSide("head");
    const baseRun = newSide("base");

    try {
      if (composeBase) {
        const up = await run([...composeBase, "up", "-d", "--wait"], mirror);
        if (up.code !== 0)
          throw new ArkError(`compose up failed: ${(up.stderr || up.stdout).trim()}`);
      }
      for (const suite of config.suites) {
        const { results, passed } = await runSuite(
          suite,
          join(mirror, suite.repo),
          resultsDirectory,
          headRun,
          await headOf(suite.repo, config.workspace, mirror),
        );
        allResults.push(...results);
        if (suite.level !== "unit") provingResults.push(...results);
        suites.push({
          name: suite.name,
          level: suite.level,
          passed,
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
        const cases = verifiedBy.map((id) => ({ id, status: caseStatus(id, allResults) }));
        criterionStatuses[criterion] = verifiedByStatus(cases);
        via[criterion] = `via ${cases.map((entry) => `${entry.id} ${entry.status}`).join(", ")}`;
      } else {
        criterionStatuses[criterion] = criterionStatus(criterion, provingResults);
        via[criterion] = "via tag";
      }
    }
    const heads = Object.fromEntries(
      await Promise.all(
        discoverRepos(config.workspace).map(async (repo) => [
          repo,
          await headOf(repo, config.workspace, mirror),
        ]),
      ),
    );
    // Every run also runs the suites at the base commit, on each `ark test`: the new tests change from round to round.
    // A base failure is data, except that a refactor run must keep its behavior.
    const basePassed = await baseSuitesPassed(
      config,
      runId,
      resultsDirectory,
      mirror,
      // An old worktree.created event may hold no base: only a refactor run, which needs the base, refuses it.
      state.kind === "refactor"
        ? state.worktrees
        : state.worktrees.filter((worktree) => worktree.base !== undefined),
      baseRun,
    );
    addMissing(baseRun, headRun, evidenceDirectory);
    addMissing(headRun, baseRun, evidenceDirectory);
    writeResults(headRun, evidenceDirectory);
    writeResults(baseRun, evidenceDirectory);
    const passed =
      checks.every((check) => check.passed) &&
      suites.every((suite) => suite.passed) &&
      Object.entries(criterionStatuses).every(
        ([criterion, status]) => manual.has(criterion) || status === "passing",
      );
    appendEvent(directory, "test.completed", {
      passed,
      ...(checks.length > 0 ? { checks } : {}),
      heads,
      suites,
      criteria: criterionStatuses,
      ...(state.kind === "refactor" ? { base_passed: basePassed } : {}),
    });

    console.log(`base      ${basePassed ? "passed" : "failed"}`);
    for (const suite of suites)
      console.log(
        `suite      ${suite.name} (${suite.level})  ${suite.passed ? "passed" : "failed"}`,
      );
    for (const [criterion, status] of Object.entries(criterionStatuses))
      console.log(`criterion  ${criterion}  ${status.padEnd(14)}  ${via[criterion]}`);
    for (const id of [...new Set([...headRun.cases.keys(), ...baseRun.cases.keys()])].sort())
      console.log(`evidence   results/evidence/${id}/{base,head}`);

    const problems = [
      ...checks.filter((check) => !check.passed).map((check) => `check ${check.name} failed`),
      ...suites.filter((suite) => !suite.passed).map((suite) => `suite ${suite.name} failed`),
      ...(state.kind === "refactor" && !basePassed && hasTestCriterion(directory)
        ? ["refactor run: the suites fail at the base commit"]
        : []),
      ...Object.entries(criterionStatuses)
        .filter(
          ([criterion, status]) => status !== (manual.has(criterion) ? "manual ok" : "passing"),
        )
        .map(([criterion, status]) => `${criterion} is ${status}`),
    ];
    if (problems.length > 0)
      throw new ArkError(`tests did not prove every criterion: ${problems.join("; ")}`);
  } finally {
    releaseLock();
  }
}
