import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as bunTest from "./parsers/bun-test";

// One parser per `format`; a new framework is one more entry (PRD "Setup and configuration").
export const parsers = { "bun-test": bunTest } as const;

export type Suite = { format: keyof typeof parsers; level: string; collect?: string; run: string; junit: string; tests?: string[]; env?: { up?: string; down?: string; vars?: Record<string, string> } };
export type RepoConfig = { commands?: { build?: string }; suites: Record<string, Suite> };

// Untrimmed stdout, for NUL-separated (-z) output where a path may begin or end in whitespace.
export function gitRaw(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "--no-replace-objects", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}
export const git = (cwd: string, ...args: string[]) => gitRaw(cwd, ...args).trim();

// Paths of `git diff --name-only <args>`, read with -z so no name is quoted or escaped (core.quotePath). --no-renames lists both the old and the new path of a move,
// so moving a tagged test out of the test globs still shows the test as touched.
export const diffFiles = (cwd: string, ...args: string[]) => gitRaw(cwd, "diff", "-z", "--name-only", "--no-renames", ...args).split("\0").filter(Boolean);

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
export function loadRepo(dir: string, ref?: string): RepoConfig {
  const file = ref ? `${ref}:.ark/repo.yml` : join(dir, ".ark", "repo.yml");
  if (!ref && !existsSync(file)) throw new Error(`no ${file}`);
  const cfg = Bun.YAML.parse(ref ? git(dir, "show", file) : readFileSync(file, "utf8")) as RepoConfig | null;
  const suites = Object.entries(cfg?.suites ?? {});
  if (!suites.length) throw new Error(`${file} has no suites`);
  for (const [name, s] of suites) {
    const at = `${file}: suites.${name}`;
    for (const k of ["format", "level", "run", "junit"] as const) if (typeof s[k] !== "string" || !s[k]) throw new Error(`${at}.${k} must be a non-empty string`);
    if (!(s.format in parsers)) throw new Error(`${at}.format '${s.format}' has no parser (known: ${Object.keys(parsers).join(", ")})`);
    if (!s.run.includes("{tags}")) throw new Error(`${at}.run must contain {tags}`);
    for (const k of ["up", "down"] as const) if (s.env?.[k] !== undefined && typeof s.env[k] !== "string") throw new Error(`${at}.env.${k} must be a string`);
    if (s.env?.vars !== undefined && (typeof s.env.vars !== "object" || s.env.vars === null || Object.values(s.env.vars).some((v) => typeof v !== "string"))) throw new Error(`${at}.env.vars must map names to strings`);
  }
  return cfg as RepoConfig;
}

// Without `tests`: the files bun test discovers, plus everything under the usual test directories (helpers and fixtures a test imports).
const testGlobs = (s: Suite) => s.tests ?? ["**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}", "**/{test,tests,__tests__}/**"];
// The suite's test files in a checkout: its globs (default: bun's discovery) against `cwd`, dependencies excluded.
export const suiteTestFiles = (s: Suite, cwd: string): string[] =>
  testGlobs(s).flatMap((g) => [...new Bun.Glob(g).scanSync({ cwd, onlyFiles: true })]).filter((f) => !f.split("/").includes("node_modules"));
const isTest = (s: Suite, f: string) => testGlobs(s).some((g) => new Bun.Glob(g).match(f));
export const isTestFile = (cfg: RepoConfig, f: string) => Object.values(cfg.suites).some((s) => isTest(s, f));
const show = (wt: string, ref: string, f: string) => {
  const r = Bun.spawnSync(["git", "--no-replace-objects", "-C", wt, "show", `${ref}:${f}`]);
  return r.exitCode === 0 ? r.stdout.toString() : "";
};

// Test files changed between base and head that still exist at head (what red-green overlays).
export function changedTestFiles(wt: string, base: string, cfg: RepoConfig, head = "HEAD"): string[] {
  return diffFiles(wt, "--diff-filter=d", `${base}..${head}`).filter((f) => isTestFile(cfg, f));
}

// AC7: files in from..HEAD that are test files carrying an AC tag, before or after the change.
// `from` is where the step began: the repo's last recorded head_sha, or its base_sha before the first step.
export function touchedTaggedTests(wt: string, from: string, cfg: RepoConfig): string[] {
  return diffFiles(wt, `${from}..HEAD`).filter((f) =>
    Object.values(cfg.suites).some((s) => isTest(s, f) && [show(wt, "HEAD", f), show(wt, from, f)].some(parsers[s.format].taggedFile)));
}
