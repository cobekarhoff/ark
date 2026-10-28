import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// `ark launch [omp args]`: the orchestrator session as ARK-118 found it can run.
// AC1: no bash, eval or lsp; only read-only built-ins, write/edit (the tool_call hook confines them to the run folder), task/wait/ask/todo and the typed ark_* tools (tools/ark.ts).
//      `--tools` is used, not `bash.enabled: false`: that setting is global and takes bash from the subagents too, which need it.
//      `-e <package dir>` (a directory: omp scans only a directory's tools/, skills/ and agents/) loads the tools and, through package.json, the hook, in any project, plugin installed or not.
// AC2: subagents run inside this process and share its environment, so the whole process starts with git and gh holding no credentials;
//      the ark_mr tool alone gives its child the human's values back (humanEnv).
export const ARK_TOOLS = ["ark_run_start", "ark_log_route", "ark_advance", "ark_ws_create", "ark_gate_packet", "ark_gate_answer", "ark_run_close", "ark_ac_update", "ark_findings_record", "ark_artifact_record", "ark_trace_check", "ark_mr"];
// Gate answers and run closes are hidden tools, but their CLI calls still require the matching human ask proof.
// `find` (semantic search) is left out: omp refuses to start when it is unavailable, as on a fresh install; the scout agents do the wide searching.
const BUILTIN = ["read", "grep", "glob", "ask", "task", "wait", "todo", "write", "edit"];
const PACKAGE = join(import.meta.dir, "..");

// Tokens are dropped for good: `ark mr` then needs `gh auth login` (keyring) or a git credential helper, not a token in the environment.
const TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const SAVED = "ARK_LAUNCH_HUMAN_ENV"; // the human's own values of what the launch overrides, as JSON (null = was unset)

type Env = Record<string, string | undefined>;

// `git config --get-regexp` as the human's git sees it from `cwd`: system, global, the repository and its worktree config, and the human's own command-line entries.
const gitConfigMatching = (base: Env, cwd: string, pattern: string): [key: string, value: string][] => {
  const r = Bun.spawnSync(["git", "config", "--get-regexp", pattern], { cwd, env: base as Record<string, string> });
  if (r.exitCode !== 0) return []; // 1 = no match; no git or no readable config leaves nothing to reset
  return r.stdout.toString().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)]);
};
// userinfo in an http(s) URL is a credential no reset can strip: https://user:token@host/..., https://token@host/...
const WITH_USERINFO = /https?:\/\/[^/\s@]*@/i;
const redact = (s: string) => s.replace(/(https?:\/\/)[^/\s@]*@/gi, "$1***@");

// The environment of the whole omp process. `credential.helper=` is set at command-line scope (GIT_CONFIG_COUNT), which outranks system, global,
// repo and worktree config, and an empty value resets every helper read before it. The same empty value resets `http.extraHeader` and every
// `http.<url>.extraHeader` the human's config (system, global, the launch directory's repo) sets: an Authorization header there would otherwise go out with every
// fetch. GIT_CONFIG_NOSYSTEM keeps the system config (Apple's names osxkeychain) out altogether.
// Credentials inside a remote URL or a url.<x>.insteadOf rewrite cannot be reset, so such a config refuses the launch. Only the launch directory's repo is scanned.
export function credentialFreeEnv(base: Env, ghConfigDir: string, cwd = process.cwd()): Env {
  for (const [key, value] of gitConfigMatching(base, cwd, "^(remote\\..*\\.(push)?url|url\\..*\\.(push)?insteadof)$"))
    if (WITH_USERINFO.test(key) || WITH_USERINFO.test(value))
      throw new Error(`refusing to launch: git config ${redact(key)} = ${redact(value)} carries credentials in a URL, which an agent's git would use; remove the credentials from the URL (use a credential helper)`);
  const reset = ["credential.helper", "http.extraHeader", ...gitConfigMatching(base, cwd, "^http\\..*\\.extraheader$").map(([k]) => k)];
  const n = Number.isInteger(Number(base.GIT_CONFIG_COUNT ?? 0)) ? Number(base.GIT_CONFIG_COUNT ?? 0) : 0;
  const set: Env = { GIT_CONFIG_COUNT: String(n + reset.length), GIT_CONFIG_NOSYSTEM: "1", GH_CONFIG_DIR: ghConfigDir }; // GH_CONFIG_DIR: empty, so gh is logged out
  reset.forEach((key, i) => Object.assign(set, { [`GIT_CONFIG_KEY_${n + i}`]: key, [`GIT_CONFIG_VALUE_${n + i}`]: "" }));
  const env: Env = { ...base, ...set, GIT_TERMINAL_PROMPT: "0" }; // a push without credentials fails instead of asking
  // GIT_CONFIG_PARAMETERS (what `git -c` sets) is read after GIT_CONFIG_COUNT, so a helper in it would survive the reset: drop it and restore it for ark_mr.
  env[SAVED] = JSON.stringify(Object.fromEntries([...Object.keys(set), "GIT_CONFIG_PARAMETERS"].map((k) => [k, base[k] ?? null])));
  delete env.GIT_CONFIG_PARAMETERS;
  for (const t of TOKENS) delete env[t];
  return env;
}

// What the ark_mr tool's child gets: the launch's overrides undone, nothing else changed.
export function humanEnv(env: Env): Env {
  const out = { ...env };
  for (const [k, v] of Object.entries(JSON.parse(out[SAVED] ?? "{}") as Record<string, string | null>)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  delete out[SAVED];
  return out;
}

export function launch(args: string[]): number {
  const home = process.env.ARK_HOME ?? join(homedir(), ".ark");
  const gh = join(home, "credential-free", "gh");
  mkdirSync(gh, { recursive: true });
  const interactive = !args.some((a) => a === "-p" || a === "--print" || a === "--mode"); // omp refuses `ask` without a terminal UI
  const tools = [...BUILTIN.filter((t) => interactive || t !== "ask"), ...ARK_TOOLS].join(",");
  return Bun.spawnSync(["omp", "--tools", tools, "--no-lsp", "-e", PACKAGE, ...args], { env: credentialFreeEnv(process.env, gh), stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1;
}
