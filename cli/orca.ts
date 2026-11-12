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

/** Orca can be slow to answer a list; the hub's 2 s reader limit is too short for the queue and for a one-off command. */
export const orcaTimeoutMilliseconds = orcaTimeout(10_000);

/** One `orca <words> --json` call: its `result`, or why it failed. */
async function orcaCommand<T>(words: string[], timeoutMilliseconds: number): Promise<OrcaRead<T>> {
  if (!Bun.which("orca")) return { ok: false, reason: "orca not found on PATH" };
  const answer = await execResult(["orca", ...words, "--json"], timeoutMilliseconds);
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

/** One `orca orchestration <args> --json` call: its `result`, or why it failed. */
export const orcaRead = <T>(
  args: string[],
  timeoutMilliseconds = readerTimeoutMilliseconds,
): Promise<OrcaRead<T>> => orcaCommand<T>(["orchestration", ...args], timeoutMilliseconds);

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

/** A Task of Master Chief's Run. `ticket` is the id at the start of `<ticket id> <title>`, or null when the title has none. */
export type QueueTask = {
  id: string;
  title: string;
  status: "ready" | "pending";
  ticket: string | null;
};
type TaskRow = { id: string; title: string; status?: string };

/** The Orca Run `Master Chief: <project> tickets` among `runs`, or the reason there is none. */
export function findChiefRun(
  project: string,
  runs: { id: string; objective?: string }[],
): OrcaRead<string> {
  const found = runs.find((orcaRun) => orcaRun.objective === `Master Chief: ${project} tickets`);
  return found
    ? { ok: true, value: found.id }
    : { ok: false, reason: `no Orca Run "Master Chief: ${project} tickets"` };
}

/** The queue of Master Chief's Run: its ready Tasks, then its pending Tasks. task-list has no cursor. */
export async function readChiefTasks(
  chiefRunId: string,
  timeoutMilliseconds = readerTimeoutMilliseconds,
): Promise<OrcaRead<QueueTask[]>> {
  const [ready, pending] = await Promise.all([
    orcaRead<{ tasks?: TaskRow[] }>(
      ["task-list", "--run", chiefRunId, "--ready"],
      timeoutMilliseconds,
    ),
    orcaRead<{ tasks?: TaskRow[] }>(
      ["task-list", "--run", chiefRunId, "--status", "pending"],
      timeoutMilliseconds,
    ),
  ]);
  if (!ready.ok || !pending.ok)
    return {
      ok: false,
      reason: `orca orchestration task-list failed: ${ready.ok ? (pending as { reason: string }).reason : ready.reason}`,
    };
  const queueTask = (row: TaskRow, status: QueueTask["status"]): QueueTask => ({
    id: row.id,
    title: row.title,
    status,
    ticket: row.title.match(/^([A-Z][A-Z0-9]*-\d+)(?:\s|$)/)?.[1] ?? null,
  });
  return {
    ok: true,
    value: [
      ...(ready.value.tasks ?? []).map((row) => queueTask(row, "ready")),
      ...(pending.value.tasks ?? []).map((row) => queueTask(row, "pending")),
    ],
  };
}

/** The whole queue read for a caller that needs nothing else from Orca: the hub. The reason is text for a person. */
export async function readChiefQueue(
  project: string,
  timeoutMilliseconds = readerTimeoutMilliseconds,
): Promise<OrcaRead<QueueTask[]>> {
  const runs = await orcaPages<{ id: string; objective?: string }>(
    "run-list",
    "runs",
    ["--full"],
    timeoutMilliseconds,
  );
  if (!runs.ok) return { ok: false, reason: `orca orchestration run-list failed: ${runs.reason}` };
  const chiefRun = findChiefRun(project, runs.value);
  return chiefRun.ok ? readChiefTasks(chiefRun.value, timeoutMilliseconds) : chiefRun;
}

/** `orcaRead` for callers that only need to know it failed: null on any failure. */
export const orcaOrchestration = async <T>(...args: string[]): Promise<T | null> => {
  const answer = await orcaRead<T>(args);
  return answer.ok ? answer.value : null;
};

// Orca actions of `ark run step start`. Each returns the value or the reason it failed; none throws.
// The run lead's terminal env (ORCA_AGENT_SESSION_ID) names the coordinator, so `worker_done` reaches the lead.
const actionTimeout = () => orcaTimeout(120_000);
const coordinator = (): string[] =>
  process.env.ORCA_AGENT_SESSION_ID
    ? ["--from", `orca_session_id:${process.env.ORCA_AGENT_SESSION_ID}`]
    : [];

/** A started worker. A field the receipt lacks is `unknown`: the worker runs, so it is never a failed start. */
export type StartedWorker = { dispatch: string; terminal: string };

type Receipt = {
  dispatchId?: string;
  dispatch?: { id?: string };
  /** The real receipt holds the handle as a string; an older shape lists it in `effects`. */
  terminal?: string;
  effects?: { kind?: string; id?: string }[];
};

const receiptOf = (receipt: Receipt, terminal?: string): StartedWorker => ({
  dispatch: receipt.dispatchId ?? receipt.dispatch?.id ?? "unknown",
  terminal:
    terminal ??
    (typeof receipt.terminal === "string" ? receipt.terminal : undefined) ??
    receipt.effects?.find((effect) => effect.kind === "terminal")?.id ??
    "unknown",
});

/** `worker-start --agent`: a fresh supervised worker in `worktree`. */
export async function startWorker(options: {
  spec: string;
  title: string;
  worktree: string;
  harness: string;
  model: string;
}): Promise<OrcaRead<StartedWorker>> {
  const started = await orcaCommand<Receipt>(
    [
      "orchestration",
      "worker-start",
      ...coordinator(),
      "--spec",
      options.spec,
      "--task-title",
      options.title,
      "--worktree",
      `path:${options.worktree}`,
      "--agent",
      options.harness,
      "--model",
      options.model,
    ],
    actionTimeout(),
  );
  return started.ok ? { ok: true, value: receiptOf(started.value) } : started;
}

/** `terminal create` running `command` in `worktree`: the terminal handle. */
export async function createTerminal(worktree: string, command: string): Promise<OrcaRead<string>> {
  const created = await orcaCommand<{ terminal?: { handle?: string }; handle?: string }>(
    ["terminal", "create", "--worktree", `path:${worktree}`, "--command", command],
    actionTimeout(),
  );
  if (!created.ok) return created;
  const handle = created.value.terminal?.handle ?? created.value.handle;
  return handle ? { ok: true, value: handle } : { ok: false, reason: "no terminal handle" };
}

/** `worker-start --terminal`: binds a running terminal as a supervised worker (no --model with it). */
export async function bindTerminal(options: {
  terminal: string;
  spec: string;
  title: string;
  worktree: string;
}): Promise<OrcaRead<StartedWorker>> {
  const bound = await orcaCommand<Receipt>(
    [
      "orchestration",
      "worker-start",
      ...coordinator(),
      "--terminal",
      options.terminal,
      "--worktree",
      `path:${options.worktree}`,
      "--spec",
      options.spec,
      "--task-title",
      options.title,
    ],
    actionTimeout(),
  );
  return bound.ok ? { ok: true, value: receiptOf(bound.value, options.terminal) } : bound;
}

/** Closes a terminal. Best effort: the caller already has its answer. */
export async function closeTerminal(handle: string): Promise<void> {
  await orcaCommand(["terminal", "close", "--terminal", handle], actionTimeout());
}
