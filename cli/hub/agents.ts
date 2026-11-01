import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { isInside, readUsageIn, type SessionWithKey } from "../usage/index.ts";
import { listProjects, projectDirectory } from "../paths.ts";
import { execJson } from "./exec.ts";
import type { OrcaTerminal } from "./orca.ts";
import { switchTerminal, type Action } from "./types.ts";

export type AgentCost = {
  /** `unavailable` when no usage reader can measure this agent. It is never 0. */
  usd: number | "unavailable";
  tokens: number;
  /** True when some messages in the folder had no cost, so `usd` is a lower bound. */
  includes_unknown: boolean;
  /** Why the cost is unavailable. */
  reason?: string;
};

export type OrcaAgent = {
  terminal: string;
  /** `live` when Orca shows the terminal connected, else `exited`. */
  state: string;
  harness: string;
  model: string | null;
  title: string;
  folder: string | null;
  project: string;
  /** Cost of the sessions that ran in the agent's folder. A folder shared by several agents counts all of them. */
  cost: AgentCost;
  last_line: string | null;
  action: Action | null;
};

type AgentTerminal = OrcaTerminal & { title?: string; preview?: string; orphaned?: boolean };

/** The project whose workspace or project folder holds the path, else `other`. */
export function projectOfPath(path: string | null): string {
  if (path === null) return "other";
  const folder = resolve(path);
  for (const name of listProjects()) {
    if (isInside(folder, projectDirectory(name))) return name;
    try {
      if (isInside(folder, resolve(loadConfig(name).workspace))) return name;
    } catch {
      // A project whose ark.yml cannot be read cannot claim a folder by its workspace.
    }
  }
  return "other";
}

const lastLine = (preview: string | undefined): string | null => {
  const line = (preview ?? "")
    .split("\n")
    .map((text) => text.replace(/\p{Cc}/gu, "").trim())
    .findLast((text) => text !== "");
  return line ? line.slice(0, 200) : null;
};

const costTtlMilliseconds = 30_000;
const costCache = new Map<string, { at: number; sessions: SessionWithKey[] }>();

/** Sessions per folder. Scans the session roots once for the folders not cached in the last 30 seconds. */
function sessionsIn(folders: string[]): Map<string, SessionWithKey[]> {
  const now = Date.now();
  const stale = folders.filter(
    (folder) => now - (costCache.get(folder)?.at ?? 0) > costTtlMilliseconds,
  );
  if (stale.length > 0)
    for (const [folder, sessions] of readUsageIn(stale))
      costCache.set(folder, { at: now, sessions });
  return new Map(folders.map((folder) => [folder, costCache.get(folder)!.sessions]));
}

function costOf(
  harness: string,
  folder: string | null,
  sessions: Map<string, SessionWithKey[]>,
): AgentCost {
  const unavailable = (reason: string): AgentCost => ({
    usd: "unavailable",
    tokens: 0,
    includes_unknown: true,
    reason,
  });
  if (harness !== "omp" && harness !== "claude")
    return unavailable(`no usage reader for harness ${harness}`);
  if (folder === null) return unavailable("Orca gave no folder for this agent");
  const messages = (sessions.get(folder) ?? [])
    .filter((session) => session.harness === harness)
    .flatMap((session) => session.messages);
  if (messages.length === 0) return unavailable("no session file for this agent's folder");
  const known = messages.filter((message) => message.costUsd !== "unknown");
  return {
    usd:
      known.length === 0
        ? "unavailable"
        : known.reduce((sum, message) => sum + (message.costUsd as number), 0),
    tokens: messages.reduce(
      (sum, message) =>
        sum + message.input + message.output + message.cacheRead + message.cacheWrite,
      0,
    ),
    includes_unknown: known.length < messages.length,
    ...(known.length === 0 ? { reason: "the sessions record no cost" } : {}),
  };
}

export type AgentsAnswer =
  | { state: "ok"; agents: OrcaAgent[] }
  | { state: "unknown"; agents: null };

/**
 * The Agents API: every Orca terminal that runs an agent, also one Ark did not start.
 * When Orca does not answer the list is `unknown`, not empty.
 */
export async function readAgents(): Promise<AgentsAnswer> {
  const list = await execJson<{ result?: { terminals?: AgentTerminal[] } }>([
    "orca",
    "terminal",
    "list",
    "--json",
  ]);
  const terminals = list?.result?.terminals;
  if (!terminals) return { state: "unknown", agents: null };
  const running = terminals.filter((terminal) => terminal.agentIdentity);
  const folders = [
    ...new Set(
      running.flatMap((terminal) => (terminal.worktreePath ? [terminal.worktreePath] : [])),
    ),
  ];
  const sessions = sessionsIn(folders);
  return {
    state: "ok",
    agents: running.map((terminal) => {
      const harness = terminal.agentIdentity!;
      const folder = terminal.worktreePath ?? null;
      return {
        terminal: terminal.handle,
        state: terminal.connected ? "live" : "exited",
        harness,
        model: terminal.model ?? null,
        title: terminal.title ?? terminal.handle,
        folder,
        project: projectOfPath(folder),
        cost: costOf(harness, folder, sessions),
        last_line: lastLine(terminal.preview),
        action: switchTerminal(terminal.handle, "Open in Orca"),
      };
    }),
  };
}
