// One typed tool per `ark` verb the router skill calls, so the orchestrator can run with bash, eval and lsp switched off (docs/adr/0003, ARK-118-AC1).
// Each tool runs this package's own CLI (not whatever `ark` is on PATH) and returns its stdout; a non-zero exit is the tool's error text.
import { join } from "node:path";
import { humanEnvironment } from "../cli/launch";

const commandLineInterfacePath = join(import.meta.dir, "..", "cli", "ark.ts");

export default function (extension: { zod: any }) {
  const schema = extension.zod;
  const gate = schema.enum(["criteria", "plan", "evidence", "escalation"]);
  const run_id = schema.string().describe("run id printed by ark_run_start");
  const outcome = schema.enum(["merged", "abandoned"]);
  // [name, what it does, parameters, argv]
  const verbs: [string, string, Record<string, unknown>, (parameters: any) => string[]][] = [
    ["ark_run_start", "Start the run for a local ticket (or resume it), bind this session to it, and print `started|resumed <run_id>`. Runs the model preflight first.", { ticket: schema.string().describe("ticket ID, e.g. ARK-108") }, (parameters) => ["run", "start", parameters.ticket]],
    ["ark_log_route", "Record route.chosen, the first ledger event after run.started.", { run_id: run_id.optional(), playbook: schema.string(), why: schema.string() }, (parameters) => ["log", "route", ...(parameters.run_id ? [parameters.run_id] : []), parameters.playbook, parameters.why]],
    ["ark_advance", "Move the run along a legal transition. Events owned by another ark command are refused.", { run_id, event: schema.string(), data: schema.record(schema.string(), schema.unknown()).optional().describe("event data, e.g. {\"repo\":\"ark\"}") }, (parameters) => ["advance", parameters.run_id, parameters.event, ...(parameters.data ? ["--data", JSON.stringify(parameters.data)] : [])]],
    ["ark_worktree_create", "Create the run's worktree for a repo (default: the project root); prints the worktree, branch and base_sha.", { run_id, repo: schema.string().optional().describe("path of an extra repo") }, (parameters) => ["worktree", "create", parameters.run_id, ...(parameters.repo ? ["--repo", parameters.repo] : [])]],
    ["ark_gate_packet", "Build the gate packet from the run artifacts and print its sha256.", { run_id, gate }, (parameters) => ["gate", "packet", parameters.run_id, parameters.gate]],
    ["ark_acceptance_criteria_update", "After a criteria edit, re-read the ticket's acceptance criterion (AC) entries into ac.yml and record acceptance_criteria.updated.", { run_id }, (parameters) => ["acceptance-criteria", "update", parameters.run_id]],
    ["ark_findings_record", "Validate the judged findings file and record it (judging state).", { run_id, file: schema.string().describe("absolute path of the findings JavaScript Object Notation (JSON)") }, (parameters) => ["findings", "record", parameters.run_id, parameters.file]],
    ["ark_artifact_record", "Schema-check an agent's typed result and keep it as artifacts/<agent>/<n>.json.", { run_id, agent: schema.enum(["implementer", "validator", "reviewer"]), file: schema.string().describe("absolute path of the result JavaScript Object Notation (JSON)") }, (parameters) => ["artifact", "record", parameters.run_id, parameters.agent, parameters.file]],
    ["ark_trace_check", "Build trace-matrix.md from ac.yml and the recorded test evidence; an error lists why it fails.", { run_id }, (parameters) => ["trace-check", parameters.run_id]],
    ["ark_gate_answer", "Record a human gate answer only when the main session's matching ask answer is present.", { run_id, gate, answer: schema.string(), packet: schema.string() }, (parameters) => ["gate", "answer", parameters.run_id, parameters.gate, parameters.answer, "--packet", parameters.packet]],
    ["ark_run_close", "Record a human-confirmed run outcome using the close_packet hash printed by ark_merge_request_open and the main session's matching ask result.", { run_id, outcome }, (parameters) => ["run", "close", parameters.run_id, parameters.outcome]],
    ["ark_merge_request_open", "Push the run branches with the human's credentials and open a merge request (MR), a GitHub pull request, per repo; prints close_packet when all are open. Never merges.", { run_id }, (parameters) => ["merge-request", "open", parameters.run_id]],
  ];
  return verbs.map(([name, description, shape, argumentsFor]) => ({
    name,
    label: name,
    description,
    loadMode: "essential", // top-level functions, not xd:// devices: the orchestrator has nothing else to run the CLI with
    hidden: true, // exists only where --tools or an agent's tools names it: a subagent or a session started without ark launch never gets one
    parameters: schema.object(shape),
    async execute(_id: string, parameters: unknown, _update: unknown, context: { sessionManager: { getSessionId(): string; getSessionFile(): string | undefined } }, signal?: AbortSignal) {
      const base: Record<string, string | undefined> = { ...process.env, PI_SESSION_ID: context.sessionManager.getSessionId(), PI_SESSION_FILE: context.sessionManager.getSessionFile() };
      const environment = name === "ark_merge_request_open" ? humanEnvironment(base) : base;
      const subprocess = Bun.spawn(["bun", commandLineInterfacePath, ...argumentsFor(parameters)], { env: environment, stdout: "pipe", stderr: "pipe", signal });
      const [stdout, stderr, code] = await Promise.all([new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited]);
      if (code !== 0) throw new Error((stderr || stdout).trim() || `ark exited ${code}`);
      return { content: [{ type: "text", text: stdout || "ok" }], details: { argv: argumentsFor(parameters), code } };
    },
  }));
}
