import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { projectRoot, runDir } from "./run";

// tool_call policy for the main session (PRD "Agents and models": the orchestrator writes only in the run folder).
// A speed bump, not a sandbox: tampering with the ledger is detected by its hash chain, and product changes by attribution (ARK-115).
// ponytail: bash is checked for obvious redirects/moves onto state.json or ledger.ndjson only; indirect shell writes are not seen.

// realpath of the longest existing prefix, so /tmp vs /private/tmp and symlinks compare equal.
const real = (p: string): string => {
  try { return realpathSync(p); } catch { return p === dirname(p) ? p : join(real(dirname(p)), basename(p)); }
};

const BASH_WRITE = /(>>?|\btee\b|\bsed\s+-\S*i|\bmv\b|\bcp\b|\brm\b|\btruncate\b)[^|;&\n]*\b(state\.json|ledger\.ndjson)\b/;
const GUARDED = ["edit", "write", "ast_edit", "bash", "eval", "lsp"];
// lsp actions that cannot change a file. `rename` applies unless `apply` is false; `code_actions` only lists unless `apply` is true. Anything else, unknown actions included, is blocked.
const LSP_READ = ["diagnostics", "definition", "references", "hover", "symbols", "type_definition", "implementation", "status", "capabilities"];
// Internal URLs a write may name: OMP-owned scratch, peer messages, and cancelling a background job. Every other scheme can reach a file or a process the hook cannot see.
const urlOk = (scheme: string, p: string) => scheme === "local" || scheme === "agent" || (scheme === "proc" && /\/kill$/.test(p));

// The run this session is bound to: ARK_RUN (set by the router) when it names an open run, else the project's active-run pointer when that does.
// ARK_RUN is fixed at launch, so a closed one must not hide the run the pointer moved to. Fails closed: a binding that names no run,
// or whose state.json cannot be read, binds the session; only when every named run is done or aborted is the session free.
function boundRun(): string | undefined {
  let root: string;
  try { root = projectRoot(); } catch { return undefined; } // no ark.yml: not an Ark project
  const ptr = join(root, "active-run");
  const named = [[process.env.ARK_RUN, "ARK_RUN"], [existsSync(ptr) ? readFileSync(ptr, "utf8").trim() : "", "active-run pointer"]];
  for (const [id, source] of named) {
    if (!id) continue;
    let dir: string;
    try { dir = runDir(id); } catch (e) { throw new Error(`blocked: ${(e as Error).message} (${source}); fix the binding with 'ark run start <ID>'`); }
    try {
      const status = (JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { status: string }).status;
      if (status !== "done" && status !== "aborted") return dir;
    } catch { return dir; }
  }
  return undefined;
}

// Throws the refusal reason, returns when the call is allowed. `raw` is {tool, input, cwd} as JSON.
export function hookToolCall(raw: string): void {
  const { tool, input, cwd } = JSON.parse(raw) as { tool: string; input: Record<string, unknown>; cwd: string };
  if (!GUARDED.includes(tool)) return;
  let run: string | undefined;
  try { run = boundRun(); } catch (e) { if (tool !== "bash") throw e; run = ""; } // a broken binding must not stop the bash call that repairs it; the redirect check still applies
  if (run !== undefined) guard(run, tool, input, cwd);
}

function guard(run: string, tool: string, input: Record<string, unknown>, cwd: string): void {
  if (tool === "bash") {
    if (BASH_WRITE.test(String(input.command ?? ""))) throw new Error("blocked: state.json and ledger.ndjson are written only by the ark CLI");
    return;
  }
  if (tool === "eval") throw new Error("blocked: eval can write any file; the orchestrator works through the ark CLI and subagents");
  if (tool === "lsp") {
    const read = LSP_READ.includes(String(input.action)) || (input.action === "rename" && input.apply === false) || (input.action === "code_actions" && input.apply !== true);
    if (!read)
      throw new Error(`blocked: lsp ${String(input.action)} can rewrite product files; the implementer does that`);
    return;
  }
  if (!["edit", "write", "ast_edit"].includes(tool)) return;
  const paths = [input.path, ...(Array.isArray(input.paths) ? input.paths : [])].filter((p): p is string => typeof p === "string");
  if (!paths.length) throw new Error(`blocked: ${tool} call names no path the hook can check`);
  const runReal = real(run);
  for (const raw of paths) {
    const p = raw.trim().replace(/^\[(.*)#[0-9A-Za-z]+\]$/, "$1"); // hashline header `[path#TAG]`: the tool unwraps it, so must the check
    const scheme = p.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1].toLowerCase();
    if (/:conflict:\/\//i.test(p) || scheme === "conflict") throw new Error(`blocked: ${p} rewrites the file holding the conflict; product code goes to the implementer`);
    if (scheme === "xd") { // a tool device runs the named tool with the JSON in `content`: apply the same policy to that call
      const device = p.slice("xd://".length).split(/[/?#]/)[0].toLowerCase();
      if (device === "ast_edit") throw new Error("blocked: the orchestrator does not rewrite code; ast_edit is for subagents");
      if (!GUARDED.includes(device)) continue;
      let args: Record<string, unknown>;
      try { args = JSON.parse(String(input.content)); } catch { throw new Error(`blocked: ${p} content is not JSON the hook can check`); }
      guard(run, device, args, cwd);
      continue;
    }
    if (scheme) {
      if (urlOk(scheme, p)) continue;
      throw new Error(`blocked: ${tool} on ${p}; ${scheme}:// can reach files outside the run folder`);
    }
    // `archive.zip:member`, `db.sqlite:table`, `file:10-20`: the file written is some prefix before a colon, so check each (a symlinked container resolves to its real file).
    const at = [...p.matchAll(/:/g)].map((m) => p.slice(0, m.index));
    for (const candidate of [...at, p]) {
      const rel = relative(runReal, real(resolve(cwd, candidate.replace(/^~(?=\/|$)/, homedir()))));
      if (rel === ".." || rel.startsWith("../")) throw new Error(`blocked: ${tool} outside the active run folder ${run} (${p}); product code goes to the implementer`);
      if (rel === "state.json" || rel === "ledger.ndjson") throw new Error(`blocked: ${rel} is written only by the ark CLI`);
      if (rel === "ws" || rel.startsWith("ws/")) throw new Error(`blocked: ${tool} in ${rel}; the worktrees belong to the implementer and validator`);
    }
  }
}
