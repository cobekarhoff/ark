// Thin shim: the policy lives in `ark hook tool_call` (cli/hook.ts), tested as ordinary CLI code (PRD "Packaging").
// ctx.agent.kind is "main" for the orchestrator session and "sub" for task agents, /tan clones and the advisor (omp docs, extensions.md ExtensionContext.agent).
// The call carries ctx.sessionManager.getSessionId(): the hook finds the run this session is bound to from it (`ark run start` records it under the
// PI_SESSION_ID its bash tool exports; omp docs, session-manager.ts and bash.ts #sessionEnv). The hook child gets this process's live environment.
import { join } from "node:path";
import { GUARDED } from "../cli/guarded";

const CLI = join(import.meta.dir, "..", "cli", "ark.ts");

type Ctx = { cwd: string; agent: { kind: string }; sessionManager: { getSessionId(): string } };

export default function (pi: { on: (event: "tool_call", handler: (event: { toolName: string; input: unknown }, ctx: Ctx) => unknown) => void }) {
  pi.on("tool_call", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !GUARDED.includes(event.toolName)) return; // other tools never reach a file; no need to spawn the CLI for them
    const r = Bun.spawnSync(["bun", CLI, "hook", "tool_call"], {
      cwd: ctx.cwd,
      env: process.env, // explicit: Bun's default spawn env is a startup snapshot
      stdin: Buffer.from(JSON.stringify({ tool: event.toolName, input: event.input, cwd: ctx.cwd, session: ctx.sessionManager.getSessionId() })),
    });
    if (r.exitCode !== 0) return { block: true, reason: r.stderr.toString().trim() || `ark hook failed (exit ${r.exitCode})` };
  });
}
