import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as bunTest from "./parsers/bun-test";

// One parser per `format`; a new framework is one more entry (PRD "Setup and configuration").
export const parsers = { "bun-test": bunTest } as const;

export type Suite = { format: keyof typeof parsers; level: string; collect?: string; run: string; junit: string; tests?: string[]; env?: { up?: string; down?: string } };
export type RepoConfig = { commands?: { build?: string }; suites: Record<string, Suite> };

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

export function loadRepo(dir: string): RepoConfig {
  const file = join(dir, ".ark", "repo.yml");
  if (!existsSync(file)) throw new Error(`no ${file}`);
  const cfg = Bun.YAML.parse(readFileSync(file, "utf8")) as RepoConfig | null;
  const suites = Object.entries(cfg?.suites ?? {});
  if (!suites.length) throw new Error(`${file} has no suites`);
  for (const [name, s] of suites) {
    const at = `${file}: suites.${name}`;
    for (const k of ["format", "level", "run", "junit"] as const) if (typeof s[k] !== "string" || !s[k]) throw new Error(`${at}.${k} must be a non-empty string`);
    if (!(s.format in parsers)) throw new Error(`${at}.format '${s.format}' has no parser (known: ${Object.keys(parsers).join(", ")})`);
    if (!s.run.includes("{tags}")) throw new Error(`${at}.run must contain {tags}`);
    for (const k of ["up", "down"] as const) if (s.env?.[k] !== undefined && typeof s.env[k] !== "string") throw new Error(`${at}.env.${k} must be a string`);
  }
  return cfg as RepoConfig;
}

const testGlobs = (s: Suite) => s.tests ?? ["**/*.test.ts", "test/**"];
const isTest = (s: Suite, f: string) => testGlobs(s).some((g) => new Bun.Glob(g).match(f));
const show = (wt: string, ref: string, f: string) => {
  const r = Bun.spawnSync(["git", "-C", wt, "show", `${ref}:${f}`]);
  return r.exitCode === 0 ? r.stdout.toString() : "";
};

// Test files changed between base and head that still exist at head (what red-green overlays).
export function changedTestFiles(wt: string, base: string, cfg: RepoConfig): string[] {
  const files = git(wt, "diff", "--name-only", "--diff-filter=d", `${base}..HEAD`).split("\n").filter(Boolean);
  return files.filter((f) => Object.values(cfg.suites).some((s) => isTest(s, f)));
}

// AC7: files in base..HEAD that are test files carrying an AC tag, before or after the change.
export function touchedTaggedTests(wt: string, base: string, cfg: RepoConfig): string[] {
  const files = git(wt, "diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean);
  return files.filter((f) =>
    Object.values(cfg.suites).some((s) => isTest(s, f) && [show(wt, "HEAD", f), show(wt, base, f)].some(parsers[s.format].taggedFile)));
}
