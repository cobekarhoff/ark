import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// `ark launch [omp args]`: the orchestrator session as ARK-118 found it can run.
// AC1: no bash, eval or lsp; only read-only built-ins, write/edit (the tool_call hook confines them to the run folder), task/wait/ask/todo and the typed ark_* tools (tools/ark.ts).
//      `--tools` is used, not `bash.enabled: false`: that setting is global and takes bash from the subagents too, which need it.
// AC2: subagents run inside this process and share its environment, so the whole process starts with git and gh holding no credentials;
//      the ark_mr tool alone gives its child the normal environment back (RESTORE).
export const ARK_TOOLS = ["ark_run_start", "ark_log_route", "ark_advance", "ark_ws_create", "ark_gate_packet", "ark_gate_answer", "ark_findings_record", "ark_artifact_record", "ark_trace_check", "ark_mr"];
// The hook that confines write and edit to the run folder. Loaded here as well as by the plugin, so the confinement holds even if the plugin is not installed (twice, it only checks twice).
const HOOK = join(import.meta.dir, "..", "extensions", "index.ts");
const BUILTIN = ["read", "grep", "glob", "find", "ask", "task", "wait", "todo", "write", "edit"];

// What the launcher sets that `ark mr` must not inherit. Tokens (GH_TOKEN, GITHUB_TOKEN, ...) are unset for good: `ark mr` needs `gh auth login` (keyring) or a git credential helper.
export const RESTORE = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GH_CONFIG_DIR"];
const TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

const gitConfig = (key: string) => Bun.spawnSync(["git", "config", "--get", key]).stdout.toString().trim();

export function launch(args: string[]): number {
  const home = process.env.ARK_HOME ?? join(homedir(), ".ark");
  const dir = join(home, "credential-free");
  mkdirSync(join(dir, "gh"), { recursive: true });
  // Identity so the agent can commit; the empty helper resets whatever the system or repo config lists (git: "configuring the empty string resets the helper list").
  const global = join(dir, "gitconfig");
  writeFileSync(global, `[user]\n\tname = ${gitConfig("user.name")}\n\temail = ${gitConfig("user.email")}\n[credential]\n\thelper =\n`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_GLOBAL: global, // system config (Apple's sets osxkeychain) is skipped by the next line
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", // a push without credentials fails instead of asking
    GH_CONFIG_DIR: join(dir, "gh"), // no hosts.yml: gh is logged out
  };
  for (const t of TOKENS) delete env[t];
  const print = args.includes("-p") || args.includes("--print"); // omp has no `ask` without a UI
  const tools = [...BUILTIN.filter((t) => !(print && t === "ask")), ...ARK_TOOLS].join(",");
  return Bun.spawnSync(["omp", "--tools", tools, "--no-lsp", "-e", HOOK, ...args], { env, stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1;
}
