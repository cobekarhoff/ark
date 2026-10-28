import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// `ark launch [omp args]`: the orchestrator session as ARK-118 found it can run.
// AC1: no bash, eval or lsp; only read-only built-ins, write/edit (the tool_call hook confines them to the run folder), task/wait/ask/todo and the typed ark_* tools (tools/ark.ts).
//      `--tools` is used, not `bash.enabled: false`: that setting is global and takes bash from the subagents too, which need it.
//      `-e <package dir>` (a directory: omp scans only a directory's tools/, skills/ and agents/) loads the tools and, through package.json, the hook, in any project, plugin installed or not.
// AC2: subagents run inside this process and share its environment, so the whole process starts with git and gh holding no credentials;
//      the ark_merge_request_open tool alone gives its child the human's values back (humanEnvironment).
export const ARK_TOOLS = ["ark_run_start", "ark_log_route", "ark_advance", "ark_worktree_create", "ark_gate_packet", "ark_gate_answer", "ark_run_close", "ark_acceptance_criteria_update", "ark_findings_record", "ark_artifact_record", "ark_trace_check", "ark_merge_request_open"];
// Gate answers and run closes are hidden tools, but their CLI calls still require the matching human ask proof.
// `find` (semantic search) is left out: omp refuses to start when it is unavailable, as on a fresh install; the scout agents do the wide searching.
const BUILTIN = ["read", "grep", "glob", "ask", "task", "wait", "todo", "write", "edit"];
const PACKAGE = join(import.meta.dir, "..");

// Tokens are dropped for good: `ark merge-request open` then needs `gh auth login` (keyring) or a git credential helper, not a token in the environment.
const TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const SAVED = "ARK_LAUNCH_HUMAN_ENV"; // the human's own values of what the launch overrides, as JSON (null = was unset)

type Environment = Record<string, string | undefined>;

// `git config --get-regexp` as the human's git sees it from `cwd`: system, global, the repository and its worktree config, and the human's own command-line entries.
const gitConfigMatching = (baseEnvironment: Environment, cwd: string, pattern: string): [key: string, value: string][] => {
  const result = Bun.spawnSync(["git", "config", "--get-regexp", pattern], { cwd, env: baseEnvironment as Record<string, string> });
  if (result.exitCode !== 0) return []; // 1 = no match; no git or no readable config leaves nothing to reset
  return result.stdout.toString().split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]);
};
// userinfo in an http(s) URL is a credential no reset can strip: https://user:token@host/..., https://token@host/...
const WITH_USERINFO = /https?:\/\/[^/\s@]*@/i;
const redact = (s: string) => s.replace(/(https?:\/\/)[^/\s@]*@/gi, "$1***@");

// The environment of the whole omp process. `credential.helper=` is set at command-line scope (GIT_CONFIG_COUNT), which outranks system, global,
// repo and worktree config, and an empty value resets every helper read before it. The same empty value resets `http.extraHeader` and every
// `http.<url>.extraHeader` the human's config (system, global, the launch directory's repo) sets: an Authorization header there would otherwise go out with every
// fetch. GIT_CONFIG_NOSYSTEM keeps the system config (Apple's names osxkeychain) out altogether.
// Credentials inside a remote URL or a url.<x>.insteadOf rewrite cannot be reset, so such a config refuses the launch. Only the launch directory's repo is scanned.
export function credentialFreeEnvironment(baseEnvironment: Environment, githubConfigDirectory: string, cwd = process.cwd()): Environment {
  for (const [key, value] of gitConfigMatching(baseEnvironment, cwd, "^(remote\\..*\\.(push)?url|url\\..*\\.(push)?insteadof)$"))
    if (WITH_USERINFO.test(key) || WITH_USERINFO.test(value))
      throw new Error(`refusing to launch: git config ${redact(key)} = ${redact(value)} carries credentials in a URL, which an agent's git would use; remove the credentials from the URL (use a credential helper)`);
  const reset = ["credential.helper", "http.extraHeader", ...gitConfigMatching(baseEnvironment, cwd, "^http\\..*\\.extraheader$").map(([key]) => key)];
  const configEntryCount = Number.isInteger(Number(baseEnvironment.GIT_CONFIG_COUNT ?? 0)) ? Number(baseEnvironment.GIT_CONFIG_COUNT ?? 0) : 0;
  const overrides: Environment = { GIT_CONFIG_COUNT: String(configEntryCount + reset.length), GIT_CONFIG_NOSYSTEM: "1", GH_CONFIG_DIR: githubConfigDirectory }; // GH_CONFIG_DIR: empty, so gh is logged out
  reset.forEach((key, i) => Object.assign(overrides, { [`GIT_CONFIG_KEY_${configEntryCount + i}`]: key, [`GIT_CONFIG_VALUE_${configEntryCount + i}`]: "" }));
  const environment: Environment = { ...baseEnvironment, ...overrides, GIT_TERMINAL_PROMPT: "0" }; // a push without credentials fails instead of asking
  // GIT_CONFIG_PARAMETERS (what `git -c` sets) is read after GIT_CONFIG_COUNT, so a helper in it would survive the reset: drop it and restore it for ark_merge_request_open.
  environment[SAVED] = JSON.stringify(Object.fromEntries([...Object.keys(overrides), "GIT_CONFIG_PARAMETERS"].map((key) => [key, baseEnvironment[key] ?? null])));
  delete environment.GIT_CONFIG_PARAMETERS;
  for (const token of TOKENS) delete environment[token];
  return environment;
}

// What the ark_merge_request_open tool's child gets: the launch's overrides undone, nothing else changed.
export function humanEnvironment(environment: Environment): Environment {
  const restoredEnvironment = { ...environment };
  for (const [key, value] of Object.entries(JSON.parse(restoredEnvironment[SAVED] ?? "{}") as Record<string, string | null>)) {
    if (value === null) delete restoredEnvironment[key];
    else restoredEnvironment[key] = value;
  }
  delete restoredEnvironment[SAVED];
  return restoredEnvironment;
}

export function launch(argumentsList: string[]): number {
  const home = process.env.ARK_HOME ?? join(homedir(), ".ark");
  const githubConfigDirectory = join(home, "credential-free", "gh");
  mkdirSync(githubConfigDirectory, { recursive: true });
  const interactive = !argumentsList.some((argument) => argument === "-p" || argument === "--print" || argument === "--mode"); // omp refuses `ask` without a terminal UI
  const tools = [...BUILTIN.filter((toolName) => interactive || toolName !== "ask"), ...ARK_TOOLS].join(",");
  return Bun.spawnSync(["omp", "--tools", tools, "--no-lsp", "-e", PACKAGE, ...argumentsList], { env: credentialFreeEnvironment(process.env, githubConfigDirectory), stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1;
}
