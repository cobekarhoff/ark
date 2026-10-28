import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { boundRunDirectory } from "./binding";
import { GUARDED } from "./guarded";
import { project, projectRoot, readLedger, runDirectory } from "./run";

// tool_call policy for the main session (PRD "Agents and models": the orchestrator writes only in the run folder).
// A speed bump, not a sandbox: tampering with the ledger is detected by its hash chain, and product changes by attribution (ARK-115).
// ponytail: bash is checked for obvious redirects/moves onto state.json or ledger.ndjson only; indirect shell writes are not seen.

// realpath of the longest existing prefix, so /tmp vs /private/tmp and symlinks compare equal.
const real = (path: string): string => {
  try { return realpathSync(path); } catch { return path === dirname(path) ? path : join(real(dirname(path)), basename(path)); }
};

const BASH_WRITE = /(>>?|\btee\b|\bsed\s+-\S*i|\bmv\b|\bcp\b|\brm\b|\btruncate\b)[^|;&\n]*\b(state\.json|ledger\.ndjson)\b/;
// lsp actions that cannot change a file. `rename` applies unless `apply` is false; `code_actions` only lists unless `apply` is true. Anything else, unknown actions included, is blocked.
const LSP_READ = ["diagnostics", "definition", "references", "hover", "symbols", "type_definition", "implementation", "status", "capabilities"];
// Internal URLs a write may name: OMP-owned scratch, peer messages, and cancelling a background job. Every other scheme can reach a file or a process the hook cannot see.
const urlOk = (scheme: string, path: string) => scheme === "local" || scheme === "agent" || (scheme === "proc" && /\/kill$/.test(path));

// The ledger decides whether a run is open, never the cached state.json (ARK-115-AC2): editing state.json must not free the session.
const open = (directory: string) => {
  try {
    const status = project(readLedger(directory)).status;
    return status !== "done" && status !== "aborted";
  } catch { return true; } // a ledger that cannot be replayed keeps the run guarded
};

// The run folder this call is bound by, or undefined when the session is free.
// 1. The session's own binding (made by `ark run start` under its session id) decides alone: its run is missing -> blocked; closed -> free.
// 2. No binding: the project's active-run pointer (the cwd's ark.yml), when there is one: it names no run -> blocked; a closed run -> free.
// 3. No binding and no pointer: not an Ark session.
function boundRun(session: unknown): string | undefined {
  const bound = boundRunDirectory(session);
  if (bound !== undefined) {
    if (!existsSync(bound)) throw new Error(`blocked: this session is bound to run folder ${bound}, which no longer exists; fix it with 'ark run start <ID>'`);
    return open(bound) ? bound : undefined;
  }
  let root: string;
  try { root = projectRoot(); } catch { return undefined; } // no ark.yml: not an Ark project
  const activeRunFile = join(root, "active-run");
  if (!existsSync(activeRunFile)) return undefined;
  let directory: string;
  try { directory = runDirectory(readFileSync(activeRunFile, "utf8").trim()); } catch (error) { throw new Error(`blocked: ${(error as Error).message} (active-run pointer); fix the binding with 'ark run start <ID>'`); }
  return open(directory) ? directory : undefined;
}

// Throws the refusal reason, returns when the call is allowed. `raw` is {tool, input, cwd} as JSON.
export function hookToolCall(raw: string): void {
  const { tool, input, cwd, session } = JSON.parse(raw) as { tool: string; input: Record<string, unknown>; cwd: string; session?: string };
  if (!GUARDED.includes(tool)) return;
  let activeRunDirectory: string | undefined;
  try { activeRunDirectory = boundRun(session); } catch (error) { if (tool !== "bash") throw error; activeRunDirectory = ""; } // a broken binding must not stop the bash call that repairs it; the redirect check still applies
  if (activeRunDirectory !== undefined) guard(activeRunDirectory, tool, input, cwd);
}

function guard(activeRunDirectory: string, tool: string, input: Record<string, unknown>, cwd: string): void {
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
  // `edit` in patch mode may also name a rename destination per edit.
  const renames = Array.isArray(input.edits) ? input.edits.map((editEntry) => (typeof editEntry === "object" && editEntry !== null && "rename" in editEntry ? editEntry.rename : undefined)) : [];
  const paths = [input.path, ...(Array.isArray(input.paths) ? input.paths : []), ...renames].filter((path): path is string => typeof path === "string");
  if (!paths.length) throw new Error(`blocked: ${tool} call names no path the hook can check`);
  const runReal = real(activeRunDirectory);
  for (const raw of paths) {
    const path = raw.trim().replace(/^\[(.*)#[0-9A-Za-z]+\]$/, "$1"); // hashline header `[path#TAG]`: the tool unwraps it, so must the check
    const scheme = path.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1].toLowerCase();
    if (/:conflict:\/\//i.test(path) || scheme === "conflict") throw new Error(`blocked: ${path} rewrites the file holding the conflict; product code goes to the implementer`);
    if (scheme === "xd") { // a tool device runs the named tool with the JSON in `content`: apply the same policy to that call
      const device = path.slice("xd://".length).split(/[/?#]/)[0].toLowerCase();
      if (device === "ast_edit") throw new Error("blocked: the orchestrator does not rewrite code; ast_edit is for subagents");
      if (!GUARDED.includes(device)) continue;
      let args: Record<string, unknown>;
      try { args = JSON.parse(String(input.content)); } catch { throw new Error(`blocked: ${path} content is not JSON the hook can check`); }
      guard(activeRunDirectory, device, args, cwd);
      continue;
    }
    if (scheme) {
      if (urlOk(scheme, path)) continue;
      throw new Error(`blocked: ${tool} on ${path}; ${scheme}:// can reach files outside the run folder`);
    }
    // `archive.zip:member`, `db.sqlite:table`, `file:10-20`: the file written is some prefix before a colon, so check each (a symlinked container resolves to its real file).
    const at = [...path.matchAll(/:/g)].map((match) => path.slice(0, match.index));
    for (const candidate of [...at, path]) {
      // A glob (ast_edit paths, edit targets) may match anywhere below its literal prefix: check the prefix, and refuse one that is the run folder itself.
      const glob = /[*?[{]/.test(candidate);
      const literal = glob ? candidate.split("/").slice(0, candidate.split("/").findIndex((segment) => /[*?[{]/.test(segment))).join("/") || "/" : candidate;
      const relativePath = relative(runReal, real(resolve(cwd, literal.replace(/^~(?=\/|$)/, homedir()))));
      if (relativePath === "" && (glob || tool === "ast_edit")) throw new Error(`blocked: ${tool} on ${path} reaches the run folder's ledger and worktrees; name files under ${activeRunDirectory} instead`);
      if (relativePath === ".." || relativePath.startsWith("../")) throw new Error(`blocked: ${tool} outside the active run folder ${activeRunDirectory} (${path}); product code goes to the implementer`);
      if (relativePath === "state.json" || relativePath === "ledger.ndjson" || relativePath === ".main-session") throw new Error(`blocked: ${relativePath} is written only by the ark CLI`);
      if (relativePath === "worktrees" || relativePath.startsWith("worktrees/")) throw new Error(`blocked: ${tool} in ${relativePath}; the worktrees belong to the implementer and validator`);
    }
  }
}
