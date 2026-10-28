// One typed tool per `ark` verb the router skill calls, so the orchestrator can run with bash, eval and lsp switched off (docs/adr/0003, ARK-118-AC1).
// Each tool runs this package's own CLI (not whatever `ark` is on PATH) and returns its stdout; a non-zero exit is the tool's error text.
import { join } from "node:path";
import { humanEnv } from "../cli/launch";

const CLI = join(import.meta.dir, "..", "cli", "ark.ts");

export default function (pi: { zod: any }) {
  const z = pi.zod;
  const gate = z.enum(["G0", "G1", "G2", "GE"]);
  const run_id = z.string().describe("run id printed by ark_run_start");
  const outcome = z.enum(["merged", "abandoned"]);
  // [name, what it does, parameters, argv]
  const verbs: [string, string, Record<string, unknown>, (a: any) => string[]][] = [
    ["ark_run_start", "Start the run for a local ticket (or resume it), bind this session to it, and print `started|resumed <run_id>`. Runs the model preflight first.", { ticket: z.string().describe("ticket ID, e.g. ARK-108") }, (a) => ["run", "start", a.ticket]],
    ["ark_log_route", "Record route.chosen, the first ledger event after run.started.", { run_id: run_id.optional(), playbook: z.string(), why: z.string() }, (a) => ["log", "route", ...(a.run_id ? [a.run_id] : []), a.playbook, a.why]],
    ["ark_advance", "Move the run along a legal transition. Events owned by another ark command are refused.", { run_id, event: z.string(), data: z.record(z.string(), z.unknown()).optional().describe("event data, e.g. {\"repo\":\"ark\"}") }, (a) => ["advance", a.run_id, a.event, ...(a.data ? ["--data", JSON.stringify(a.data)] : [])]],
    ["ark_ws_create", "Create the run's worktree for a repo (default: the project root); prints the worktree, branch and base_sha.", { run_id, repo: z.string().optional().describe("path of an extra repo") }, (a) => ["ws", "create", a.run_id, ...(a.repo ? ["--repo", a.repo] : [])]],
    ["ark_gate_packet", "Build the gate packet from the run artifacts and print its sha256.", { run_id, gate }, (a) => ["gate", "packet", a.run_id, a.gate]],
    ["ark_ac_update", "After a G0 edit, re-read the ticket's acceptance criteria (ACs) into ac.yml and record ac.updated.", { run_id }, (a) => ["ac", "update", a.run_id]],
    ["ark_findings_record", "Validate the judged findings file and record it (judging state).", { run_id, file: z.string().describe("absolute path of the findings JSON") }, (a) => ["findings", "record", a.run_id, a.file]],
    ["ark_artifact_record", "Schema-check an agent's typed result and keep it as artifacts/<agent>/<n>.json.", { run_id, agent: z.enum(["implementer", "validator", "reviewer"]), file: z.string().describe("absolute path of the result JSON") }, (a) => ["artifact", "record", a.run_id, a.agent, a.file]],
    ["ark_trace_check", "Build trace-matrix.md from ac.yml and the recorded test evidence; an error lists why it fails.", { run_id }, (a) => ["trace-check", a.run_id]],
    ["ark_gate_answer", "Record a human gate answer only when the main session's matching ask answer is present.", { run_id, gate, answer: z.string(), packet: z.string() }, (a) => ["gate", "answer", a.run_id, a.gate, a.answer, "--packet", a.packet]],
    ["ark_run_close", "Record a human-confirmed run outcome using the close_packet hash printed by ark_mr and the main session's matching ask result.", { run_id, outcome }, (a) => ["run", "close", a.run_id, a.outcome]],
    ["ark_mr", "Push the run branches with the human's credentials and open a GitHub merge request (PR) per repo; prints close_packet when all are open. Never merges.", { run_id }, (a) => ["mr", a.run_id]],
  ];
  return verbs.map(([name, description, shape, argv]) => ({
    name,
    label: name,
    description,
    loadMode: "essential", // top-level functions, not xd:// devices: the orchestrator has nothing else to run the CLI with
    hidden: true, // exists only where --tools or an agent's tools names it: a subagent or a session started without ark launch never gets one
    parameters: z.object(shape),
    async execute(_id: string, params: unknown, _update: unknown, ctx: { agent: { kind: string }; sessionManager: { getSessionId(): string; getSessionFile(): string | undefined } }, signal?: AbortSignal) {
      if (ctx.agent.kind !== "main") throw new Error("ark tools are available only in the main session");
      const base: Record<string, string | undefined> = { ...process.env, PI_SESSION_ID: ctx.sessionManager.getSessionId(), PI_SESSION_FILE: ctx.sessionManager.getSessionFile() };
      const env = name === "ark_mr" ? humanEnv(base) : base;
      const p = Bun.spawn(["bun", CLI, ...argv(params)], { env, stdout: "pipe", stderr: "pipe", signal });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw new Error((err || out).trim() || `ark exited ${code}`);
      return { content: [{ type: "text", text: out || "ok" }], details: { argv: argv(params), code } };
    },
  }));
}
