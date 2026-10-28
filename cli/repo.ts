import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as bunTest from "./parsers/bun-test";

// One parser per `format`; a new framework is one more entry (PRD "Setup and configuration").
export const parsers = { "bun-test": bunTest } as const;

export type Suite = { format: keyof typeof parsers; level: string; collect?: string; run: string; junit: string; tests?: string[]; env?: { up?: string; down?: string; vars?: Record<string, string> } };
export type RepoConfig = { commands?: { build?: string }; suites: Record<string, Suite> };

// Untrimmed stdout, for NUL-separated (-z) output where a path may begin or end in whitespace.
export function gitRaw(cwd: string, ...argumentsList: string[]): string {
  const result = Bun.spawnSync(["git", "--no-replace-objects", "-C", cwd, ...argumentsList]);
  if (result.exitCode !== 0) throw new Error(`git ${argumentsList.join(" ")} failed in ${cwd}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}
export const git = (cwd: string, ...argumentsList: string[]) => gitRaw(cwd, ...argumentsList).trim();

// Paths of `git diff --name-only <args>`, read with -z so no name is quoted or escaped (core.quotePath). --no-renames lists both the old and the new path of a move,
// so moving a tagged test out of the test globs still shows the test as touched.
export const diffFiles = (cwd: string, ...argumentsList: string[]) => gitRaw(cwd, "diff", "-z", "--name-only", "--no-renames", ...argumentsList).split("\0").filter(Boolean);

// Uncommitted paths: tracked edits and untracked, non-ignored files from `git status -z` (names stay literal; a rename lists its source as a second entry),
// plus tracked files flagged assume-unchanged (lowercase tag) or skip-worktree (`S`) in `git ls-files -v`, which `git status` then never reports.
export function dirtyFiles(cwd: string): string[] {
  const parts = gitRaw(cwd, "status", "--porcelain", "-z", "--untracked-files=all").split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    paths.push(parts[i].slice(3));
    if (/[RC]/.test(parts[i].slice(0, 2))) i++;
  }
  for (const entry of gitRaw(cwd, "ls-files", "-v", "-z").split("\0")) {
    if (/^[a-zS] /.test(entry)) paths.push(`${entry.slice(2)} (hidden from git status by assume-unchanged or skip-worktree)`);
  }
  return paths;
}
// `ref`: read the config as committed at that ref instead of from disk (the AC7 guard trusts the base config, not the implementer's edit of it).
export function loadRepo(directory: string, reference?: string): RepoConfig {
  const file = reference ? `${reference}:.ark/repo.yml` : join(directory, ".ark", "repo.yml");
  if (!reference && !existsSync(file)) throw new Error(`no ${file}`);
  const repoConfig = Bun.YAML.parse(reference ? git(directory, "show", file) : readFileSync(file, "utf8")) as RepoConfig | null;
  const suites = Object.entries(repoConfig?.suites ?? {});
  if (!suites.length) throw new Error(`${file} has no suites`);
  for (const [name, suite] of suites) {
    const at = `${file}: suites.${name}`;
    for (const key of ["format", "level", "run", "junit"] as const) if (typeof suite[key] !== "string" || !suite[key]) throw new Error(`${at}.${key} must be a non-empty string`);
    if (!(suite.format in parsers)) throw new Error(`${at}.format '${suite.format}' has no parser (known: ${Object.keys(parsers).join(", ")})`);
    if (!suite.run.includes("{tags}")) throw new Error(`${at}.run must contain {tags}`);
    for (const key of ["up", "down"] as const) if (suite.env?.[key] !== undefined && typeof suite.env[key] !== "string") throw new Error(`${at}.env.${key} must be a string`);
    if (suite.env?.vars !== undefined && (typeof suite.env.vars !== "object" || suite.env.vars === null || Object.values(suite.env.vars).some((value) => typeof value !== "string"))) throw new Error(`${at}.env.vars must map names to strings`);
  }
  return repoConfig as RepoConfig;
}

// Without `tests`: the files bun test discovers, plus everything under the usual test directories (helpers and fixtures a test imports).
const testGlobs = (suite: Suite) => suite.tests ?? ["**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}", "**/{test,tests,__tests__}/**"];
// The suite's test files in a checkout: its globs (default: bun's discovery) against `cwd`, dependencies excluded.
export const suiteTestFiles = (suite: Suite, cwd: string): string[] =>
  testGlobs(suite).flatMap((glob) => [...new Bun.Glob(glob).scanSync({ cwd, onlyFiles: true })]).filter((file) => !file.split("/").includes("node_modules"));
const isTest = (suite: Suite, file: string) => testGlobs(suite).some((glob) => new Bun.Glob(glob).match(file));
export const isTestFile = (repoConfig: RepoConfig, file: string) => Object.values(repoConfig.suites).some((suite) => isTest(suite, file));
const show = (worktree: string, reference: string, file: string) => {
  const result = Bun.spawnSync(["git", "--no-replace-objects", "-C", worktree, "show", `${reference}:${file}`]);
  return result.exitCode === 0 ? result.stdout.toString() : "";
};

// Test files changed between base and head that still exist at head (what red-green overlays).
export function changedTestFiles(worktree: string, base: string, repoConfig: RepoConfig, head = "HEAD"): string[] {
  return diffFiles(worktree, "--diff-filter=d", `${base}..${head}`).filter((file) => isTestFile(repoConfig, file));
}

// AC7: files in from..HEAD that are test files carrying an AC tag, before or after the change.
// `from` is where the step began: the repo's last recorded head_sha, or its base_sha before the first step.
export function touchedTaggedTests(worktree: string, from: string, repoConfig: RepoConfig): string[] {
  return diffFiles(worktree, `${from}..HEAD`).filter((file) =>
    Object.values(repoConfig.suites).some((suite) => isTest(suite, file) && [show(worktree, "HEAD", file), show(worktree, from, file)].some(parsers[suite.format].taggedFile)));
}
