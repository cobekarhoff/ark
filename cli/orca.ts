import { resolve } from "node:path";
import { execJson, execResult, failureReason, readerTimeoutMilliseconds } from "./exec.ts";

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
    orcaPages<OrcaRun>("run-list", "runs", ["--full"], orcaTimeout(10_000)),
    execJson<{ result?: { terminals?: OrcaTerminal[] } }>(["orca", "terminal", "list", "--json"]),
  ]);
  const terminals = terminalList?.result?.terminals;
  return runList.ok && terminals ? { terminals, runs: runList.value } : null;
}

/** The result of an Orca read: the value, or the reason it failed. */
export type OrcaRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** ARK_ORCA_TIMEOUT_MS overrides every Orca read timeout, so a test can force a timeout. */
export function orcaTimeout(fallbackMilliseconds: number): number {
  const forced = Number(process.env.ARK_ORCA_TIMEOUT_MS);
  return forced > 0 ? forced : fallbackMilliseconds;
}

/** One `orca orchestration <args> --json` call: its `result`, or why it failed. */
export async function orcaRead<T>(
  args: string[],
  timeoutMilliseconds = readerTimeoutMilliseconds,
): Promise<OrcaRead<T>> {
  if (!Bun.which("orca")) return { ok: false, reason: "orca not found on PATH" };
  const answer = await execResult(
    ["orca", "orchestration", ...args, "--json"],
    timeoutMilliseconds,
  );
  if (answer.timedOut || answer.code !== 0)
    return { ok: false, reason: failureReason(answer, timeoutMilliseconds) };
  try {
    const reply: { result?: T } = JSON.parse(answer.stdout);
    if (reply.result !== undefined) return { ok: true, value: reply.result };
  } catch {
    // Falls through to the same reason as an answer with no result.
  }
  return { ok: false, reason: "answer was not JSON with a result" };
}

/**
 * The one reader of paged Orca lists: `--limit 100`, then `--cursor <nextCursor>` until it is
 * null. `key` names the array in `result`. `scope` is extra arguments for every page.
 */
export async function orcaPages<Row>(
  verb: string,
  key: string,
  scope: string[] = [],
  timeoutMilliseconds = readerTimeoutMilliseconds,
): Promise<OrcaRead<Row[]>> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  do {
    const page = await orcaRead<Record<string, unknown>>(
      [verb, ...scope, "--limit", "100", ...(cursor ? ["--cursor", cursor] : [])],
      timeoutMilliseconds,
    );
    if (!page.ok) return page;
    rows.push(...((page.value[key] as Row[] | undefined) ?? []));
    cursor = (page.value.nextCursor as string | null | undefined) ?? undefined;
  } while (cursor);
  return { ok: true, value: rows };
}

/** `orcaRead` for callers that only need to know it failed: null on any failure. */
export const orcaOrchestration = async <T>(...args: string[]): Promise<T | null> => {
  const answer = await orcaRead<T>(args);
  return answer.ok ? answer.value : null;
};
