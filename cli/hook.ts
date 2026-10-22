import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { activeRunDir } from "./run";

// tool_call policy for the main session (PRD "Agents and models": the orchestrator writes only in the run folder). Active run: see activeRunDir in run.ts.
// ponytail: covers edit, write, ast_edit paths and obvious bash redirects/moves onto state.json or ledger.ndjson;
// eval (py/js) and indirect shell writes are not seen. Upgrade: run the orchestrator with a tool list that omits them.

// realpath of the longest existing prefix, so /tmp vs /private/tmp and symlinks compare equal.
const real = (p: string): string => {
  try { return realpathSync(p); } catch { return p === dirname(p) ? p : join(real(dirname(p)), basename(p)); }
};

const BASH_WRITE = /(>>?|\btee\b|\bsed\s+-\S*i|\bmv\b|\bcp\b|\brm\b|\btruncate\b)[^|;&\n]*\b(state\.json|ledger\.ndjson)\b/;

// Throws the refusal reason, returns when the call is allowed. `raw` is {tool, input, cwd} as JSON.
export function hookToolCall(raw: string): void {
  const { tool, input, cwd } = JSON.parse(raw) as { tool: string; input: Record<string, unknown>; cwd: string };
  const run = activeRunDir();
  if (!run) return;
  if (tool === "bash") {
    if (BASH_WRITE.test(String(input.command ?? ""))) throw new Error("blocked: state.json and ledger.ndjson are written only by the ark CLI");
    return;
  }
  if (!["edit", "write", "ast_edit"].includes(tool)) return;
  const paths = [input.path, ...(Array.isArray(input.paths) ? input.paths : [])].filter((p): p is string => typeof p === "string");
  if (!paths.length) throw new Error(`blocked: ${tool} call names no path the hook can check`);
  const runReal = real(run);
  for (const p of paths) {
    if (p === "xd://ast_edit") throw new Error("blocked: the orchestrator does not rewrite code; ast_edit is for subagents");
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(p)) continue; // other internal URLs are not product files
    const rel = relative(runReal, real(resolve(cwd, p)));
    if (rel === ".." || rel.startsWith("../")) throw new Error(`blocked: ${tool} outside the active run folder ${run} (${p}); product code goes to the implementer`);
    if (rel === "state.json" || rel === "ledger.ndjson") throw new Error(`blocked: ${rel} is written only by the ark CLI`);
    if (rel === "ws" || rel.startsWith("ws/")) throw new Error(`blocked: ${tool} in ${rel}; the worktrees belong to the implementer and validator`);
  }
}
