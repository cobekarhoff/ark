import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execJson } from "./exec.ts";

// Only the fields the hub reads. Orca output is local and trusted, so it is cast, not parsed.
export type OrcaRun = {
  id: string;
  objective?: string;
  coordinator_handle: string | null;
};
export type OrcaTerminal = {
  handle: string;
  worktreePath?: string;
  connected?: boolean;
  agentIdentity?: string;
  model?: string;
  title?: string;
};

/**
 * The live Master Chief of a project: the connected coordinator of the Orca run whose objective is
 * exactly `Master Chief: <project> tickets`, in the project workspace. No other terminal counts.
 */
export const findLiveChief = (
  snapshot: { terminals: OrcaTerminal[]; runs: OrcaRun[] },
  project: string,
  workspace: string,
): OrcaTerminal | undefined => {
  const coordinatorHandles = new Set(
    snapshot.runs
      .filter((orcaRun) => orcaRun.objective === `Master Chief: ${project} tickets`)
      .map((orcaRun) => orcaRun.coordinator_handle),
  );
  return snapshot.terminals.find(
    (terminal) =>
      coordinatorHandles.has(terminal.handle) &&
      terminal.connected &&
      terminal.worktreePath !== undefined &&
      resolve(terminal.worktreePath) === workspace,
  );
};

/** Reads Orca now, for an action that must not act on a 3-second-old snapshot. Null when Orca did not answer. */
export async function readTerminals(): Promise<{
  terminals: OrcaTerminal[];
  runs: OrcaRun[];
} | null> {
  const [runList, terminalList] = await Promise.all([
    orcaOrchestration<{ runs?: OrcaRun[] }>("run-list"),
    execJson<{ result?: { terminals?: OrcaTerminal[] } }>(["orca", "terminal", "list", "--json"]),
  ]);
  const terminals = terminalList?.result?.terminals;
  return runList && terminals ? { terminals, runs: runList.runs ?? [] } : null;
}

export const orcaOrchestration = async <T>(...args: string[]): Promise<T | null> =>
  (await execJson<{ result?: T }>(["orca", "orchestration", ...args, "--json"]))?.result ?? null;

/** A closed run whose `retro.md` Close check lacks a non-empty answer to any of the three questions. */
export function retroUnanswered(directory: string): boolean {
  try {
    const closeCheck = readFileSync(join(directory, "retro.md"), "utf8").split(
      /^## Close check\s*$/m,
    )[1];
    if (closeCheck === undefined) return false;
    return !["Biggest pain", "Change now", "Surprise"].every((label) =>
      new RegExp(`^- ${label}:[ \\t]*\\S`, "m").test(closeCheck),
    );
  } catch {
    return false;
  }
}
