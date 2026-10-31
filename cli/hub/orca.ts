import { execJson } from "./exec.ts";
import { switchTerminal, type Agent, type Item } from "./types.ts";

// Only the fields the hub reads. Orca output is local and trusted, so it is cast, not parsed.
type OrcaRun = { id: string; objective?: string; coordinator_handle: string | null };
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
export type OrcaTerminal = {
  handle: string;
  worktreePath?: string;
  connected?: boolean;
  agentIdentity?: string;
  model?: string;
};

export type OrcaSnapshot = {
  /** False when `orca run-list` failed or timed out. */
  ok: boolean;
  /** Agents of each open Ark run, by run id. A run with no entry has unknown agents. */
  agents: Map<string, Agent[]>;
  /** Every live terminal, or null when `orca terminal list` failed. */
  terminals: OrcaTerminal[] | null;
  /** Coordinator handle of every Orca run, so Master Chief detection can skip run leads. */
  coordinatorHandles: Set<string>;
};

export const emptyOrca: OrcaSnapshot = {
  ok: false,
  agents: new Map(),
  terminals: null,
  coordinatorHandles: new Set(),
};

const orcaOrchestration = async <T>(...args: string[]): Promise<T | null> =>
  (await execJson<{ result?: T }>(["orca", "orchestration", ...args, "--json"]))?.result ?? null;

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
    coordinatorHandles: new Set(orcaRuns.flatMap((orcaRun) => orcaRun.coordinator_handle ?? [])),
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
