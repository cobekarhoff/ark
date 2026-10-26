// Thin shim: the policy lives in `ark hook tool_call` (cli/hook.ts), tested as ordinary CLI code (PRD "Packaging").
// ctx.agent.kind is "main" for the orchestrator session and "sub" for task agents, /tan clones and the advisor (omp docs, extensions.md ExtensionContext.agent).
// The hook child gets this process's live environment, so ARK_RUN (the run this session is bound to) reaches it.
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cli", "ark.ts");
const GUARDED = ["edit", "write", "ast_edit", "bash", "eval", "lsp"];

export default function (pi: { on: (event: "tool_call", handler: (event: { toolName: string; input: unknown }, ctx: { cwd: string; agent: { kind: string } }) => unknown) => void }) {
  pi.on("tool_call", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !GUARDED.includes(event.toolName)) return;
    const r = Bun.spawnSync(["bun", CLI, "hook", "tool_call"], {
      cwd: ctx.cwd,
      env: process.env, // explicit: Bun's default env is a startup snapshot, which would miss an ARK_RUN set after launch
      stdin: Buffer.from(JSON.stringify({ tool: event.toolName, input: event.input, cwd: ctx.cwd })),
    });
    if (r.exitCode !== 0) return { block: true, reason: r.stderr.toString().trim() || `ark hook failed (exit ${r.exitCode})` };
  });
}
