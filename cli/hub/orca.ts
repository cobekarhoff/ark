import { execJson } from "../exec.ts";
import { orcaOrchestration, type OrcaRun, type OrcaTerminal } from "../orca.ts";

export type { OrcaTerminal };
import { switchTerminal, type Agent, type Item } from "./types.ts";

type OrcaTask = { id: string; task_title: string };
type OrcaWorker = {
  taskId: string;
  agentTerminalHandle: string;
  projection?: {
    provider?: { model?: string };
    stage?: { activity?: string };
    liveness?: { verdict?: string };
  };
};
export type OrcaSnapshot = {
  /** False when `orca run-list` failed or timed out. */
  ok: boolean;
  /** Agents of each open Ark run, by run id. A run with no entry has unknown agents. */
  agents: Map<string, Agent[]>;
  /** Every live terminal, or null when `orca terminal list` failed. */
  terminals: OrcaTerminal[] | null;
  /** Every Orca run, so Master Chief detection can find the Master Chief Run of a project. */
  runs: OrcaRun[];
};

export const emptyOrca: OrcaSnapshot = {
  ok: false,
  agents: new Map(),
  terminals: null,
  runs: [],
};

/** The live run lead terminal of an Ark run: the coordinator of the Orca run whose objective is `Ark run <run>`. */
export const findRunLead = (
  snapshot: { terminals: OrcaTerminal[]; runs: OrcaRun[] },
  run: string,
): OrcaTerminal | undefined => {
  const handle = snapshot.runs.find(
    (orcaRun) => orcaRun.objective === `Ark run ${run}`,
  )?.coordinator_handle;
  return snapshot.terminals.find((terminal) => terminal.handle === handle && terminal.connected);
};

async function agentsOf(
  orcaRun: OrcaRun,
  run: string,
  project: string,
  runOpen: boolean,
): Promise<Agent[]> {
  const [tasks, workers, terminal] = await Promise.all([
    orcaOrchestration<{ tasks?: OrcaTask[] }>("task-list", "--run", orcaRun.id),
    orcaOrchestration<{ workers?: OrcaWorker[] }>(
      "worker-list",
      "--run",
      orcaRun.id,
      "--include-remote",
    ),
    orcaRun.coordinator_handle
      ? execJson<{ result?: { terminal?: OrcaTerminal } }>([
          "orca",
          "terminal",
          "show",
          "--terminal",
          orcaRun.coordinator_handle,
          "--json",
        ])
      : null,
  ]);
  const titles = new Map((tasks?.tasks ?? []).map((task) => [task.id, task.task_title]));
  const lead = terminal?.result?.terminal;
  const runLead: Agent = {
    run,
    project,
    role: "run lead",
    title: orcaRun.objective ?? orcaRun.id,
    model: lead?.agentIdentity ?? null,
    // A closed run's lead is expected to be gone.
    liveness: lead ? (lead.connected ? "live" : runOpen ? "exited" : "done") : "unknown",
    activity: "unknown",
    terminal: orcaRun.coordinator_handle,
    action: switchTerminal(orcaRun.coordinator_handle),
  };
  const workerAgents = (workers?.workers ?? []).map((worker): Agent => ({
    run,
    project,
    role: "worker",
    title: titles.get(worker.taskId) ?? worker.taskId,
    model: worker.projection?.provider?.model ?? null,
    liveness: worker.projection?.liveness?.verdict ?? "unknown",
    activity: worker.projection?.stage?.activity ?? "unknown",
    terminal: worker.agentTerminalHandle ?? null,
    action: switchTerminal(worker.agentTerminalHandle ?? null),
  }));
  return [runLead, ...workerAgents];
}

/** Reads Orca once. Each call has a hard timeout, so a slow Orca delays this reader and nothing else. */
export async function readOrca(
  openRuns: { run: string; project: string }[],
): Promise<OrcaSnapshot> {
  const [runList, terminalList] = await Promise.all([
    orcaOrchestration<{ runs?: OrcaRun[] }>("run-list"),
    execJson<{ result?: { terminals?: OrcaTerminal[] } }>(["orca", "terminal", "list", "--json"]),
  ]);
  const terminals = terminalList?.result?.terminals ?? null;
  if (!runList) return { ...emptyOrca, terminals };
  const orcaRuns = runList.runs ?? [];
  const leadOf = new Map(
    orcaRuns
      .filter((orcaRun) => orcaRun.objective?.startsWith("Ark run "))
      .map((orcaRun) => [orcaRun.objective!.slice("Ark run ".length), orcaRun]),
  );
  const agents = new Map<string, Agent[]>();
  await Promise.all(
    openRuns.map(async ({ run, project }) => {
      const orcaRun = leadOf.get(run);
      if (orcaRun) agents.set(run, await agentsOf(orcaRun, run, project, true));
    }),
  );
  return {
    ok: true,
    agents,
    terminals,
    runs: orcaRuns,
  };
}

/**
 * Stuck or dead agents of open runs. `since` gives the time the hub first saw the problem,
 * because Orca reports no start time for a verdict.
 */
export function orcaItems(
  agents: Agent[],
  ticketOf: (run: string) => string | null,
  since: (id: string) => string,
): Item[] {
  return agents
    .filter((agent) => ["stuck", "dead", "exited"].includes(agent.liveness))
    .map((agent) => {
      const id = `agent:${agent.run}:${agent.terminal ?? agent.role}`;
      return {
        id,
        kind: "agent",
        source: "orca",
        project: agent.project,
        ticket: ticketOf(agent.run),
        title: `${agent.role} "${agent.title}" is ${agent.liveness}`,
        since: since(id),
        action: agent.action,
      };
    });
}

/**
 * The last `lines` lines of a terminal, or "unknown" when `orca terminal read` fails, times out or
 * returns no output list. Blank trailing lines are dropped.
 */
export async function readTerminalTail(handle: string, lines = 20): Promise<string[] | "unknown"> {
  const read = await execJson<{ result?: { terminal?: { tail?: unknown } } }>([
    "orca",
    "terminal",
    "read",
    "--terminal",
    handle,
    "--limit",
    String(lines),
    "--json",
  ]);
  const tail = read?.result?.terminal?.tail;
  if (!Array.isArray(tail) || !tail.every((line) => typeof line === "string")) return "unknown";
  const output = tail as string[];
  while (output.length > 0 && output[output.length - 1].trim() === "") output.pop();
  return output.slice(-lines);
}
