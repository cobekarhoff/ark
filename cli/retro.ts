import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "./errors.ts";
import { type ArkEvent, readEvents } from "./events.ts";
import { findRun, projectDirectory, runsDirectory } from "./paths.ts";
import { type SessionWithKey, type UsageMessage, isInside, readUsage } from "./usage/index.ts";

const IDLE_GAP_SECONDS = 600;
const MERGE_REQUEST_QUERY_TIMEOUT_MILLISECONDS = 10_000;

type CostGroup = { usd: number | "unknown"; tokens: number; includes_unknown: boolean };
type Unknowable = number | "unknown";
type Message = UsageMessage & { sessionKey: string; cwd: string };
type StepWindow = { id: string; role: string; repo: string; start: number; end: number | null };

const toMilliseconds = (time: string): number => Date.parse(time);
const secondsBetween = (from: number, to: number): number => (to - from) / 1000;

function sortedObject<Value>(entries: Iterable<[string, Value]>): Record<string, Value> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/** A group with no messages, or only unknown costs, has usd "unknown": nothing was measured. */
function summarize(messages: UsageMessage[]): CostGroup {
  let known = 0;
  let knownCount = 0;
  let tokens = 0;
  for (const message of messages) {
    tokens += message.input + message.output + message.cacheRead + message.cacheWrite;
    if (message.costUsd !== "unknown") {
      known += message.costUsd;
      knownCount += 1;
    }
  }
  return {
    usd: knownCount === 0 ? "unknown" : known,
    tokens,
    includes_unknown: knownCount < messages.length || messages.length === 0,
  };
}

function groupBy(
  messages: Message[],
  keyOf: (message: Message) => string,
): Record<string, CostGroup> {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const key = keyOf(message);
    groups.set(key, [...(groups.get(key) ?? []), message]);
  }
  return sortedObject([...groups].map(([key, members]) => [key, summarize(members)]));
}

/** Every session message of the run, oldest first, so sums are always added in the same order. */
function collectMessages(runDirectory: string): {
  messages: Message[];
  sessions: SessionWithKey[];
} {
  const sessions = readUsage(runDirectory);
  const messages = sessions
    .flatMap((session) =>
      session.messages.map((message) => ({
        ...message,
        sessionKey: session.sessionKey,
        cwd: session.cwd,
      })),
    )
    .sort(
      (left, right) =>
        toMilliseconds(left.time) - toMilliseconds(right.time) ||
        (left.sessionFile < right.sessionFile ? -1 : 1),
    );
  return { messages, sessions };
}

/** Running cost for `ark status`: a number only when every message has a known cost. */
export function runningCost(runDirectory: string): { usd: number | "unknown"; tokens: number } {
  const group = summarize(collectMessages(runDirectory).messages);
  return { usd: group.includes_unknown ? "unknown" : group.usd, tokens: group.tokens };
}

function stepWindows(events: ArkEvent[]): StepWindow[] {
  const windows: StepWindow[] = [];
  for (const event of events) {
    if (event.type === "step.started") {
      windows.push({
        id: event.data.step,
        role: event.data.role,
        repo: event.data.repo,
        start: toMilliseconds(event.time),
        end: null,
      });
    }
    if (event.type === "step.finished") {
      const open = windows.findLast(
        (window) => window.id === event.data.step && window.end === null,
      );
      if (open) open.end = toMilliseconds(event.time);
    }
  }
  return windows;
}

/** A message belongs to a step when its session ran in the step's worktree during the step's window. */
function windowOf(
  message: Message,
  windows: StepWindow[],
  runDirectory: string,
  runEnd: number,
): StepWindow | undefined {
  const time = toMilliseconds(message.time);
  return windows.find(
    (window) =>
      isInside(message.cwd, join(runDirectory, "workspace", window.repo)) &&
      time >= window.start &&
      time <= (window.end ?? runEnd),
  );
}

/**
 * Gate wait: from the moment a gate needs an answer to the answer. The criteria gate needs one at
 * run start when the ticket has no ACs and at an evaluation with blockers, the plan gate at each valid plan check, the escalation gate at the failed step that
 * spent the round budget.
 */
function gateWaitSeconds(events: ArkEvent[]): number {
  const waitingSince = new Map<string, number>();
  let total = 0;
  for (const event of events) {
    const time = toMilliseconds(event.time);
    if (event.type === "run.started" && event.data.criteria.length === 0)
      waitingSince.set("criteria", time);
    if (event.type === "evaluation.recorded" && event.data.blockers.length > 0)
      waitingSince.set("criteria", waitingSince.get("criteria") ?? time);
    if (event.type === "plan.checked" && event.data.valid) waitingSince.set("plan", time);
    if (event.type === "step.finished" && event.data.outcome === "failed")
      waitingSince.set("escalation", time);
    if (event.type === "gate.answered") {
      const since = waitingSince.get(event.data.gate);
      if (since !== undefined) total += secondsBetween(since, time);
      waitingSince.delete(event.data.gate);
    }
  }
  return total;
}

function runCommand(command: string[], cwd: string): unknown {
  try {
    // Bun resolves the command against the PATH of its startup snapshot unless env is passed.
    const result = Bun.spawnSync(command, {
      cwd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: MERGE_REQUEST_QUERY_TIMEOUT_MILLISECONDS,
    });
    return result.exitCode === 0 ? JSON.parse(result.stdout.toString()) : null;
  } catch {
    return null; // tool missing, directory gone, timeout or unparsable output
  }
}

type MergeRequestFacts = { comments: number; commitTimes: string[] };

function queryMergeRequest(url: string, number: number, cwd: string): MergeRequestFacts | null {
  if (url.includes("github.com")) {
    const answer = runCommand(
      ["gh", "pr", "view", String(number), "--json", "comments,reviews,commits"],
      cwd,
    ) as {
      comments: unknown[];
      reviews: { body?: string }[];
      commits: { committedDate: string }[];
    } | null;
    if (!answer) return null;
    return {
      comments: answer.comments.length + answer.reviews.filter((review) => review.body).length,
      commitTimes: answer.commits.map((commit) => commit.committedDate),
    };
  }
  const notes = runCommand(
    ["glab", "api", `projects/:fullpath/merge_requests/${number}/notes?per_page=100`],
    cwd,
  ) as { system: boolean }[] | null;
  const commits = runCommand(
    ["glab", "api", `projects/:fullpath/merge_requests/${number}/commits?per_page=100`],
    cwd,
  ) as { committed_date: string }[] | null;
  if (!notes || !commits) return null;
  return {
    comments: notes.filter((note) => !note.system).length,
    commitTimes: commits.map((commit) => commit.committed_date),
  };
}

/** Comments and commits after the merge request opened; "unknown" when gh or glab cannot answer. */
function mergeRequestActivity(
  runDirectory: string,
  events: ArkEvent[],
): { comments: Unknowable; commits: Unknowable } {
  let comments = 0;
  let commits = 0;
  for (const event of events.filter((candidate) => candidate.type === "merge_request.opened")) {
    const facts = queryMergeRequest(
      event.data.url,
      event.data.number,
      join(runDirectory, "workspace", event.data.repo),
    );
    if (!facts) return { comments: "unknown", commits: "unknown" };
    comments += facts.comments;
    commits += facts.commitTimes.filter(
      (time) => toMilliseconds(time) > toMilliseconds(event.time),
    ).length;
  }
  return { comments, commits };
}

function escapedDefects(
  project: string,
  runId: string,
): { ticket: string; run: string; note: string }[] {
  const file = join(projectDirectory(project), "escaped-defects.yml");
  if (!existsSync(file)) return [];
  const parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed))
    throw new ArkError(`${file}: must be a list of { ticket, run, note }`);
  return parsed
    .filter((entry) => entry?.run === runId)
    .map((entry) => ({
      ticket: String(entry.ticket ?? ""),
      run: runId,
      note: String(entry.note ?? ""),
    }))
    .sort((left, right) => (left.ticket < right.ticket ? -1 : left.ticket > right.ticket ? 1 : 0));
}

function median(values: number[]): Unknowable {
  if (values.length === 0) return "unknown";
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The project's other closed runs that already have a metrics.json. */
function compareWithEarlierRuns(project: string, runId: string) {
  const costs: number[] = [];
  const wallSeconds: number[] = [];
  let runsCompared = 0;
  const directory = runsDirectory(project);
  for (const name of existsSync(directory) ? readdirSync(directory).sort() : []) {
    const metricsFile = join(directory, name, "metrics.json");
    if (
      name === runId ||
      !existsSync(metricsFile) ||
      readEvents(join(directory, name)).at(-1)?.type !== "run.closed"
    )
      continue;
    const metrics = JSON.parse(readFileSync(metricsFile, "utf8"));
    runsCompared += 1;
    if (typeof metrics.cost?.total_usd === "number") costs.push(metrics.cost.total_usd);
    if (typeof metrics.time?.wall_seconds === "number") wallSeconds.push(metrics.time.wall_seconds);
  }
  return {
    runs_compared: runsCompared,
    median_cost_usd: median(costs),
    median_wall_seconds: median(wallSeconds),
  };
}

function formatUsd(usd: Unknowable, includesUnknown: boolean): string {
  if (usd === "unknown") return "unknown";
  return `$${usd.toFixed(2)}${includesUnknown ? " (some costs unknown)" : ""}`;
}

export function retro(runId: string): void {
  const { project, directory: runDirectory } = findRun(runId);
  const events = readEvents(runDirectory);
  if (events.length === 0) throw new ArkError(`run ${runId} has no events`);

  const firstTime = toMilliseconds(events[0].time);
  const runEnd = toMilliseconds(events[events.length - 1].time);
  const windows = stepWindows(events);
  const { messages, sessions } = collectMessages(runDirectory);

  const stepOf = new Map<Message, StepWindow>();
  for (const message of messages) {
    const window = windowOf(message, windows, runDirectory, runEnd);
    if (window) stepOf.set(message, window);
  }
  // The evaluator session ends at the last evaluation.recorded. The run lead session outlasts it.
  const evaluationEnd = events.findLast((event) => event.type === "evaluation.recorded")?.time;
  const evaluatorSessions = new Set(
    messages
      .filter((message) => !stepOf.has(message))
      .map((message) => message.sessionKey)
      .filter((key) =>
        messages
          .filter((message) => message.sessionKey === key)
          .every(
            (message) =>
              !stepOf.has(message) &&
              evaluationEnd !== undefined &&
              toMilliseconds(message.time) <= toMilliseconds(evaluationEnd),
          ),
      ),
  );
  const roleOf = (message: Message): string =>
    stepOf.get(message)?.role ??
    (evaluatorSessions.has(message.sessionKey) ? "evaluator" : "orchestration");
  const orchestrationMessages = messages.filter((message) => roleOf(message) === "orchestration");
  const stepIds = [...new Set(windows.map((window) => window.id))];
  const roleOfStep = new Map(windows.map((window) => [window.id, window.role]));

  const byStep = groupBy(messages, (message) => stepOf.get(message)?.id ?? "orchestration");
  const byRole = groupBy(messages, roleOf);
  for (const id of stepIds) byStep[id] ??= summarize([]); // a step that ran with no session found has unknown cost
  for (const role of roleOfStep.values()) byRole[role] ??= summarize([]);
  const total = summarize(messages);
  const reviewer = byRole.reviewer;
  const implementer = byRole.implementer;
  const ratioKnown =
    reviewer &&
    implementer &&
    reviewer.usd !== "unknown" &&
    implementer.usd !== "unknown" &&
    !reviewer.includes_unknown &&
    !implementer.includes_unknown &&
    implementer.usd > 0;

  const wallSeconds = secondsBetween(firstTime, runEnd);
  const gateWait = gateWaitSeconds(events);
  const stepSeconds = new Map<string, number>();
  for (const window of windows) {
    stepSeconds.set(
      window.id,
      (stepSeconds.get(window.id) ?? 0) + secondsBetween(window.start, window.end ?? runEnd),
    );
  }

  const stepSessions = new Map<string, Set<string>>();
  for (const [message, window] of stepOf)
    stepSessions.set(window.id, (stepSessions.get(window.id) ?? new Set()).add(message.sessionKey));
  const closed = events.some((event) => event.type === "run.closed");
  const finishedFailedByReviewer = events.filter(
    (event) =>
      event.type === "step.finished" &&
      event.data.outcome === "failed" &&
      roleOfStep.get(event.data.step) === "reviewer",
  ).length;
  const mergeRequests = mergeRequestActivity(runDirectory, events);

  let idleGaps = 0;
  for (const session of sessions) {
    const times = session.messages
      .map((message) => toMilliseconds(message.time))
      .sort((left, right) => left - right);
    for (let i = 1; i < times.length; i++)
      if (secondsBetween(times[i - 1], times[i]) > IDLE_GAP_SECONDS) idleGaps += 1;
  }

  const metrics = {
    run: runId,
    cost: {
      total_usd: total.usd,
      tokens: total.tokens,
      by_step: sortedObject(Object.entries(byStep)),
      by_role: sortedObject(Object.entries(byRole)),
      by_model: groupBy(messages, (message) => message.model),
      review_to_build_ratio: ratioKnown
        ? (reviewer.usd as number) / (implementer.usd as number)
        : "unknown",
      includes_unknown: total.includes_unknown,
    },
    time: {
      wall_seconds: wallSeconds,
      work_seconds: wallSeconds - gateWait,
      by_step: sortedObject([...stepSeconds]),
      gate_wait_seconds: gateWait,
    },
    rework: {
      rounds: Math.max(
        1,
        ...events
          .filter((event) => event.type === "step.started")
          .map((event) => event.data.round ?? 1),
      ),
      escalations: events.filter(
        (event) => event.type === "gate.answered" && event.data.gate === "escalation",
      ).length,
      findings_sent_back: finishedFailedByReviewer,
    },
    human_intervention: {
      plan_changes: events.filter(
        (event) =>
          event.type === "gate.answered" &&
          event.data.gate === "plan" &&
          event.data.answer === "change",
      ).length,
      mr_comments: mergeRequests.comments,
      mr_commits_after_open: mergeRequests.commits,
    },
    escaped_defects: escapedDefects(project, runId),
    orchestration: {
      sessions: new Set(sessions.map((session) => session.sessionKey)).size,
      restarts: [...stepSessions.values()].reduce((sum, keys) => sum + keys.size - 1, 0),
      crashes: sessions.filter((session) => session.crashed).length,
      stalled_workers: closed
        ? new Set(windows.filter((window) => window.end === null).map((window) => window.id)).size
        : 0,
      dead_dispatches: stepIds.filter((id) => !stepSessions.has(id)).length,
      tool_errors: messages.filter((message) => message.toolError).length,
      context_overflows: sessions.reduce((sum, session) => sum + session.contextOverflows, 0),
      idle_gaps: idleGaps,
      master_chief_and_run_lead_cost: summarize(orchestrationMessages),
    },
    comparison: compareWithEarlierRuns(project, runId),
  };

  const metricsFile = join(runDirectory, "metrics.json");
  const rounded = (_key: string, value: unknown) =>
    typeof value === "number" ? Math.round(value * 1e6) / 1e6 : value;
  writeFileSync(metricsFile, `${JSON.stringify(metrics, rounded, 2)}\n`);

  const comparison = metrics.comparison;
  console.log(
    [
      `retro ${runId}`,
      `cost: ${formatUsd(total.usd, total.includes_unknown)}, ${total.tokens} tokens`,
      `time: ${Math.round(wallSeconds)}s wall, ${Math.round(gateWait)}s waiting at gates`,
      `rework: ${metrics.rework.rounds} rounds, ${metrics.rework.escalations} escalations, ${metrics.rework.findings_sent_back} findings sent back`,
      `orchestration: ${metrics.orchestration.restarts} restarts, ${metrics.orchestration.tool_errors} tool errors, ${metrics.orchestration.context_overflows} context overflows, ${metrics.orchestration.idle_gaps} idle gaps`,
      `compared with ${comparison.runs_compared} earlier closed runs`,
      `wrote ${metricsFile}`,
    ].join("\n"),
  );
}
