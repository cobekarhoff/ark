import { execJson } from "./exec.ts";

type Worker = { dispatchId: string; state: string; terminalState: string };

/** Timeouts in ms: lists stay short, a release may stop a terminal. ARK_ORCA_TIMEOUT_MS overrides both (tests). */
export function orcaTimeouts(): { list: number; release: number } {
  const forced = Number(process.env.ARK_ORCA_TIMEOUT_MS);
  return forced > 0 ? { list: forced, release: forced } : { list: 5000, release: 15000 };
}

class OrcaFailure extends Error {}

async function call<T>(args: string[], timeout: number): Promise<T> {
  const command = ["orca", "orchestration", ...args, "--json"];
  if (!Bun.which("orca")) throw new OrcaFailure("orca not found on PATH");
  const reply = await execJson<{ result?: T }>(command, timeout);
  if (reply?.result === undefined)
    throw new OrcaFailure(`orca orchestration ${args[0]} failed or timed out`);
  return reply.result;
}

async function pages<Row>(
  verb: string,
  scope: string[],
  key: string,
  timeout: number,
): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  do {
    const args = [verb, ...scope, "--limit", "100", ...(cursor ? ["--cursor", cursor] : [])];
    const page = await call<Record<string, unknown>>(args, timeout);
    rows.push(...((page[key] as Row[] | undefined) ?? []));
    cursor = (page.nextCursor as string | null | undefined) ?? undefined;
  } while (cursor);
  return rows;
}

/**
 * Releases each settled, unreleased dispatch of the Orca Run "Ark run <run>". Returns the lines to
 * print. Never throws: an Orca failure is one line. A run with no Orca Run returns no lines.
 * Settled = state succeeded|failed|stopped; only reclaimable and release_pending rows are released.
 * release_unknown, retained and released are never released again, so a second sweep calls nothing.
 * A failed release does not stop the rest of its run; the run prints one line for its first failure.
 */
export async function releaseSettledWorkers(
  run: string,
  timeouts = orcaTimeouts(),
): Promise<string[]> {
  const lines: string[] = [];
  try {
    const runs = await pages<{ id: string; objective: string }>(
      "run-list",
      [],
      "runs",
      timeouts.list,
    );
    for (const { id } of runs.filter((orcaRun) => orcaRun.objective === `Ark run ${run}`)) {
      let failure: OrcaFailure | undefined;
      try {
        const workers = await pages<Worker>("worker-list", ["--run", id], "workers", timeouts.list);
        for (const worker of workers) {
          if (!["succeeded", "failed", "stopped"].includes(worker.state)) {
            if (worker.terminalState !== "released")
              lines.push(`${worker.dispatchId} still active, not released`);
          } else if (["reclaimable", "release_pending"].includes(worker.terminalState)) {
            try {
              await call(["worker-release", "--dispatch", worker.dispatchId], timeouts.release);
              lines.push(`${worker.dispatchId} released (${worker.state})`);
            } catch (err) {
              if (!(err instanceof OrcaFailure)) throw err;
              failure ??= err;
            }
          }
        }
      } catch (err) {
        if (!(err instanceof OrcaFailure)) throw err;
        failure ??= err;
      }
      if (failure) lines.push(`orca: workers not released: ${failure.message}`);
    }
  } catch (err) {
    if (!(err instanceof OrcaFailure)) throw err;
    lines.push(`orca: workers not released: ${err.message}`);
  }
  return lines;
}
