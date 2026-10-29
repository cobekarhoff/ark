import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents } from "./events.ts";
import { parsers, type TestResult } from "./parsers/index.ts";
import { findRun } from "./paths.ts";
import { discoverRepos, mirrorRoot } from "./workspace.ts";

type Status = "passing" | "failing" | "missing";

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

// The worktree's HEAD for a touched repo, the workspace checkout's HEAD for an untouched one.
function headOf(repo: string, workspace: string, mirror: string): string {
  const mirrored = join(mirror, repo);
  const touched = existsSync(join(mirrored, ".git")) && !lstatSync(mirrored).isSymbolicLink();
  const result = run(["git", "rev-parse", "HEAD"], touched ? mirrored : join(workspace, repo));
  if (result.code !== 0) throw new ArkError(`git rev-parse HEAD failed for ${repo}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function criterionStatus(criterion: string, provingResults: TestResult[]): Status {
  const tagged = provingResults.filter((result) => result.criteria.includes(criterion));
  if (tagged.some((result) => result.status === "failed")) return "failing";
  return tagged.some((result) => result.status === "passed") ? "passing" : "missing";
}

export function testRun(runId: string): void {
  const { project, directory } = findRun(runId);
  const config = loadConfig(project);
  const mirror = mirrorRoot(directory);
  if (!existsSync(mirror)) throw new ArkError(`${runId} has no workspace mirror: run ark worktree create first`);
  const resultsDirectory = join(directory, "results");
  mkdirSync(resultsDirectory, { recursive: true });
  const criteria = deriveState(readEvents(directory)).criteria.map((criterion) => criterion.id);

  const composeBase = config.compose ? [...config.compose.trim().split(/\s+/), "--project-directory", mirror, "-p", runId.toLowerCase()] : null;
  const suites: { name: string; level: string; passed: boolean }[] = [];
  const provingResults: TestResult[] = [];

  try {
    if (composeBase) {
      const up = run([...composeBase, "up", "-d", "--wait"], mirror);
      if (up.code !== 0) throw new ArkError(`compose up failed: ${(up.stderr || up.stdout).trim()}`);
    }
    for (const suite of config.suites) {
      const reportPath = join(resultsDirectory, `${suite.name}.report`);
      const outcome = run(["sh", "-c", suite.command.replaceAll("{report}", reportPath)], join(mirror, suite.repo));
      writeFileSync(join(resultsDirectory, `${suite.name}.log`), outcome.stdout + outcome.stderr);
      const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
      const results = parsers[suite.parser]({ report, stdout: outcome.stdout });
      if (suite.level !== "unit") provingResults.push(...results);
      suites.push({ name: suite.name, level: suite.level, passed: outcome.code === 0 && results.every((result) => result.status !== "failed") });
    }
  } finally {
    if (composeBase) run([...composeBase, "down"], mirror);
  }

  const criterionStatuses = Object.fromEntries(criteria.map((criterion) => [criterion, criterionStatus(criterion, provingResults)]));
  const heads = Object.fromEntries(discoverRepos(config.workspace).map((repo) => [repo, headOf(repo, config.workspace, mirror)]));
  const passed = suites.every((suite) => suite.passed) && Object.values(criterionStatuses).every((status) => status === "passing");
  appendEvent(directory, "test.completed", { passed, heads, suites, criteria: criterionStatuses });

  for (const suite of suites) console.log(`suite      ${suite.name} (${suite.level})  ${suite.passed ? "passed" : "failed"}`);
  for (const [criterion, status] of Object.entries(criterionStatuses)) console.log(`criterion  ${criterion}  ${status}`);

  const problems = [
    ...suites.filter((suite) => !suite.passed).map((suite) => `suite ${suite.name} failed`),
    ...Object.entries(criterionStatuses).filter(([, status]) => status !== "passing").map(([criterion, status]) => `${criterion} is ${status}`),
  ];
  if (problems.length > 0) throw new ArkError(`tests did not prove every criterion: ${problems.join("; ")}`);
}
