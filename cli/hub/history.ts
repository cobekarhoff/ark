import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execJson } from "./exec.ts";
import type { RunInfo } from "./ark.ts";
import type { Agent } from "./types.ts";

/**
 * One observed change. `kind` is `ci` (subject: the MR URL; state: pending, passing or failing) or
 * `liveness` (subject: the terminal handle; state: live, stuck, dead, exited, paused or unknown).
 * Orca exposes no run-level pause flag, so a pause shows as the `paused` liveness verdict.
 */
export type HistoryRecord = {
  time: string;
  kind: "ci" | "liveness";
  subject: string;
  state: string;
};

/** `gh` and `glab` each wait at most this long; a slower answer is no record. */
const ciTimeoutMilliseconds = 5000;

const failingConclusions: Record<string, true> = {
  FAILURE: true,
  ERROR: true,
  TIMED_OUT: true,
  CANCELLED: true,
  ACTION_REQUIRED: true,
  STARTUP_FAILURE: true,
};

/**
 * Every record of the run, oldest first, or [] when the file is missing. Time before the first
 * record is unavailable: callers must not guess it. A torn or foreign line is skipped.
 */
export function readHistory(directory: string): HistoryRecord[] {
  const file = join(directory, "history.ndjson");
  if (!existsSync(file)) return [];
  const records: HistoryRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const record = JSON.parse(line);
      if (
        typeof record.time === "string" &&
        typeof record.kind === "string" &&
        typeof record.subject === "string" &&
        typeof record.state === "string"
      )
        records.push(record);
    } catch {
      // blank or partial line
    }
  }
  return records;
}

/** pending, passing, failing, or null when the reader failed or the MR has no checks. */
async function readChecks(
  mergeRequest: { url: string; number: number },
  cwd: string,
): Promise<string | null> {
  if (mergeRequest.url.includes("github.com")) {
    const view = await execJson<{
      statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[];
    }>(
      ["gh", "pr", "view", mergeRequest.url, "--json", "statusCheckRollup"],
      ciTimeoutMilliseconds,
      undefined,
      cwd,
    );
    const checks = view?.statusCheckRollup;
    if (!checks || checks.length === 0) return null;
    if (checks.some((check) => failingConclusions[check.conclusion ?? check.state ?? ""]))
      return "failing";
    const settled = checks.every((check) =>
      check.status
        ? check.status === "COMPLETED"
        : check.state !== "PENDING" && check.state !== "EXPECTED",
    );
    return settled ? "passing" : "pending";
  }
  const view = await execJson<{
    head_pipeline?: { status?: string };
    pipeline?: { status?: string };
  }>(
    ["glab", "mr", "view", String(mergeRequest.number), "--output", "json"],
    ciTimeoutMilliseconds,
    undefined,
    cwd,
  );
  const status = (view?.head_pipeline ?? view?.pipeline)?.status;
  if (!status) return null;
  if (status === "success") return "passing";
  return status === "failed" || status === "canceled" ? "failing" : "pending";
}

/**
 * Appends a record for each observation whose state differs from the last record of the same
 * kind and subject. A poll that changes nothing writes nothing. Only the hub calls this.
 */
function appendChanges(
  directory: string,
  observations: Omit<HistoryRecord, "time">[],
  time: string,
): void {
  const last = new Map<string, string>();
  for (const record of readHistory(directory))
    last.set(`${record.kind} ${record.subject}`, record.state);
  for (const observation of observations) {
    if (last.get(`${observation.kind} ${observation.subject}`) === observation.state) continue;
    appendFileSync(
      join(directory, "history.ndjson"),
      `${JSON.stringify({ time, ...observation })}\n`,
    );
  }
}

/**
 * Records CI and liveness changes for each open run. `agents` is Orca's answer per run: a run with
 * no entry means Orca failed, so no liveness is recorded for it. A failed `gh` or `glab` call records nothing.
 */
export async function collectHistory(
  runs: RunInfo[],
  agents: Map<string, Agent[]>,
  time = new Date().toISOString(),
): Promise<void> {
  await Promise.all(
    runs
      .filter(({ state }) => state.phase !== "closed")
      .map(async ({ directory, state }) => {
        const observations: Omit<HistoryRecord, "time">[] = (agents.get(state.run) ?? []).flatMap(
          (agent) =>
            agent.terminal
              ? [{ kind: "liveness" as const, subject: agent.terminal, state: agent.liveness }]
              : [],
        );
        const checks = await Promise.all(
          state.merge_requests.map(async (mergeRequest) => {
            const worktree = state.worktrees.find(
              (candidate) => candidate.repo === mergeRequest.repo,
            );
            return worktree ? readChecks(mergeRequest, worktree.path) : null;
          }),
        );
        state.merge_requests.forEach((mergeRequest, index) => {
          const checkState = checks[index];
          if (checkState)
            observations.push({ kind: "ci", subject: mergeRequest.url, state: checkState });
        });
        try {
          appendChanges(directory, observations, time);
        } catch {
          // a read-only run folder must not break the hub
        }
      }),
  );
}
