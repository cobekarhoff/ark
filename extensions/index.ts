// Thin shim: the policy lives in `ark hook tool_call` (cli/hook.ts), tested as ordinary CLI code (PRD "Packaging").
// context.agent.kind is "main" for the orchestrator session and "sub" for task agents, /tan clones and the advisor (omp docs, extensions.md ExtensionContext.agent).
// The call carries context.sessionManager.getSessionId(): the hook finds the run this session is bound to from it (`ark run start` records it under the
// PI_SESSION_ID its bash tool exports; omp docs, session-manager.ts and bash.ts #sessionEnv). The hook child gets this process's live environment.
import { join } from "node:path";
import { GUARDED } from "../cli/guarded";

const commandLineInterfacePath = join(import.meta.dir, "..", "cli", "ark.ts");

type ExtensionContext = { cwd: string; agent: { kind: string }; sessionManager: { getSessionId(): string } };

export default function (extension: { on: (event: "tool_call", handler: (event: { toolName: string; input: unknown }, context: ExtensionContext) => unknown) => void }) {
  extension.on("tool_call", (event, context) => {
    // The typed ark_* tools are the orchestrator's: omp hands every subagent the session's custom tools too, and ark_merge_request_open runs with the human's credentials (ARK-118).
    if (context.agent.kind !== "main" && event.toolName.startsWith("ark_")) return { block: true, reason: `blocked: ${event.toolName} is the orchestrator's tool; subagents never call the ark CLI that way` };
    if (context.agent.kind !== "main" || !GUARDED.includes(event.toolName)) return; // other tools never reach a file; no need to spawn the CLI for them
    const result = Bun.spawnSync(["bun", commandLineInterfacePath, "hook", "tool_call"], {
      cwd: context.cwd,
      env: process.env, // explicit: Bun's default spawn env is a startup snapshot
      stdin: Buffer.from(JSON.stringify({ tool: event.toolName, input: event.input, cwd: context.cwd, session: context.sessionManager.getSessionId() })),
    });
    if (result.exitCode !== 0) return { block: true, reason: result.stderr.toString().trim() || `ark hook failed (exit ${result.exitCode})` };
  });
}
