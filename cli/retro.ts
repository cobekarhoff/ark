import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ArkError } from "./errors.ts";
import {
  type ArkEvent,
  type StageTimes,
  type StepWindow,
  deriveState,
  readEvents,
  stageTimes,
  stepWindows,
  waitingGate,
} from "./events.ts";
import { findRun, projectDirectory, runsDirectory } from "./paths.ts";
import { type PlanDecision, type PlanStep, loadPlan } from "./plan.ts";
import { type SessionWithKey, type UsageMessage, readUsage } from "./usage/index.ts";
import { type Owner, ownersOf, stageOf } from "./usage/owners.ts";

const IDLE_GAP_SECONDS = 600;
const MERGE_REQUEST_QUERY_TIMEOUT_MILLISECONDS = 10_000;

export type CostGroup = { usd: number | "unknown"; tokens: number; includes_unknown: boolean };
type Unknowable = number | "unknown";
export type Message = UsageMessage & { sessionKey: string; cwd: string };
const toMilliseconds = (time: string): number => Date.parse(time);
const secondsBetween = (from: number, to: number): number => (to - from) / 1000;

function sortedObject<Value>(entries: Iterable<[string, Value]>): Record<string, Value> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/** A group with no messages, or only unknown costs, has usd "unknown": nothing was measured. */
export function summarize(messages: UsageMessage[]): CostGroup {
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
export function collectMessages(runDirectory: string): {
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

type HelperModel = { model: string; purpose: string; usd: number | "unknown"; tokens: number };

/** Where a session file's messages belong: its owner, with an unassigned file told apart as a stage session. */
type Placement =
  | { kind: "step"; window: StepWindow }
  | { kind: "lead" | "evaluator" | "designer" | "unassigned" };

function placementOf(owner: Owner, messages: UsageMessage[], stages: StageTimes): Placement {
  if (owner.kind === "step") return { kind: "step", window: owner.window };
  if (owner.kind === "lead") return { kind: "lead" };
  return {
    kind:
      stageOf(
        messages.map((message) => toMilliseconds(message.time)),
        stages,
      ) ?? "unassigned",
  };
}

/** Strategy records after the first one and before the strategy answer. */
function designRoundCount(events: ArkEvent[]): number {
  const answer = events.findIndex(
    (event) => event.type === "gate.answered" && event.data.gate === "strategy",
  );
  const before = answer === -1 ? events : events.slice(0, answer);
  return Math.max(0, before.filter((event) => event.type === "strategy.recorded").length - 1);
}

/** Plan change answers, plus every plan approve after the first (by human or auto). */
function planChanges(events: ArkEvent[]): number {
  const planAnswers = events.filter(
    (event) => event.type === "gate.answered" && event.data.gate === "plan",
  );
  const changes = planAnswers.filter((event) => event.data.answer === "change").length;
  const approves = planAnswers.filter((event) => event.data.answer === "approve").length;
  return changes + Math.max(0, approves - 1);
}

/** A strategy answer or a decided plan decision is overridden when it is not the recommended one. */
function decisionCounts(
  runDirectory: string,
  events: ArkEvent[],
): { total: number; overridden: number } {
  let total = 0;
  let overridden = 0;
  let recommended = "";
  for (const event of events) {
    if (event.type === "strategy.recorded") recommended = event.data.recommended;
    if (
      event.type === "gate.answered" &&
      event.data.gate === "strategy" &&
      event.data.answer !== "abort"
    ) {
      total += 1;
      if (event.data.answer !== recommended) overridden += 1;
    }
  }
  let decisions: PlanDecision[] = [];
  try {
    decisions = loadPlan(runDirectory).decisions;
  } catch (err) {
    if (!(err instanceof ArkError)) throw err; // no plan.yml, or one that does not parse: no plan decisions
  }
  for (const decision of decisions.filter((candidate) => candidate.chosen)) {
    total += 1;
    if (decision.chosen !== decision.recommended) overridden += 1;
  }
  return { total, overridden };
}

/** Each gate wait of the run, in order; `answered` is null while the gate is open. */
export type GateWait = {
  gate: string;
  asked: string;
  answered: string | null;
  answer: string | null;
  /** Who answered; events from before `by` existed read as human. */
  by: "human" | "auto" | null;
};

export function gateWaits(events: ArkEvent[]): GateWait[] {
  const waits: GateWait[] = [];
  const waiting = new Map<string, GateWait>();
  const ask = (gate: string, time: string) => {
    if (waiting.has(gate)) return;
    const wait = { gate, asked: time, answered: null, answer: null, by: null };
    waiting.set(gate, wait);
    waits.push(wait);
  };
  events.forEach((event, index) => {
    if (event.type === "gate.answered") {
      const key = event.data.gate === "manual" ? `manual:${event.data.criterion}` : event.data.gate;
      const wait = waiting.get(key);
      if (wait) {
        wait.answered = event.time;
        wait.answer = event.data.answer ?? null;
        wait.by = event.data.by === "auto" ? "auto" : "human";
      }
      waiting.delete(key);
    }
    if (event.type === "test.completed")
      for (const [criterion, status] of Object.entries(event.data.criteria ?? {}))
        if (status === "manual pending") ask(`manual:${criterion}`, event.time);
    // ponytail: O(n²) replay; fold with a step function if logs reach thousands of events
    const state = deriveState(events.slice(0, index + 1));
    const gate = waitingGate(state);
    if (gate !== "none") ask(gate, event.time);
    if (
      state.phase === "merge_requests_open" &&
      event.type === "step.finished" &&
      event.data.outcome === "failed"
    )
      ask("escalation", event.time);
  });
  return waits;
}

/** Test runs of the run: how many, how many suite results came from the cache, and the files that were flaky. */
function testMetrics(events: ArkEvent[]) {
  const completed = events.filter((event) => event.type === "test.completed");
  const flaky = new Set<string>();
  let reused = 0;
  for (const event of completed) {
    reused += Array.isArray(event.data.reused) ? event.data.reused.length : 0;
    for (const entry of event.data.flaky ?? []) flaky.add(`${entry.suite}: ${entry.file}`);
  }
  return { runs: completed.length, reused_suites: reused, flaky_files: [...flaky].sort() };
}

/**
 * Gate wait: from the moment a gate needs an answer to the answer. The criteria gate needs one at
 * run start (it opens on every run since ARK-311; an older log opens it only without ACs or with blockers), the strategy gate at a
 * strategy record of 2 or more cards, the plan gate at the first valid plan check after its last answer, the escalation gate
 * when the run enters phase `escalation` (a spent budget with a failed test or `ark escalate`), or at a failed step once
 * merge requests are open. An unanswered gate adds nothing.
 */
function gateWaitSeconds(events: ArkEvent[]): number {
  const intervals = gateWaits(events)
    .filter((wait) => wait.answered !== null)
    .map((wait) => [toMilliseconds(wait.asked), toMilliseconds(wait.answered as string)])
    .sort((left, right) => left[0] - right[0]);
  let coveredMilliseconds = 0;
  let coveredUntil = -Infinity;
  for (const [start, end] of intervals) {
    coveredMilliseconds += Math.max(0, end - Math.max(start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, end);
  }
  return secondsBetween(0, coveredMilliseconds);
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

export function escapedDefects(
  project: string,
  runId: string,
): { ticket: string; run: string; note: string; fix: string; reviewer: string }[] {
  const file = join(projectDirectory(project), "escaped-defects.yml");
  if (!existsSync(file)) return [];
  const parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed))
    throw new ArkError(`${file}: must be a list of { ticket, run, note, fix, reviewer }`);
  return parsed
    .filter((entry) => entry?.run === runId)
    .map((entry) => ({
      ticket: String(entry.ticket ?? ""),
      run: runId,
      note: String(entry.note ?? ""),
      fix: String(entry.fix ?? ""),
      reviewer: String(entry.reviewer ?? ""),
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

const ROUND_FILE = /^round-\d+\.md$/;
const RANKED_LINE = /^\s*#*\s*(?:(?:\d+\.|[-*])\s+)?(?:\*\*|__)?P[0-3]\b/;

/** Ranked P0 to P3 lines in every findings/round-<number>.md file. No findings folder means 0. */
const DECISION_LINE = /^\s*(?:[-*]\s+)?(?:\*\*|__)?P[01]\b/;

/** P0 and P1 lines of `## Run lead decision` whose first of `leave` and `send back` is `leave`. */
function countFindingsLeftP0P1(runDirectory: string): number {
  const findingsDirectory = join(runDirectory, "findings");
  if (!existsSync(findingsDirectory)) return 0;
  let count = 0;
  for (const name of readdirSync(findingsDirectory).filter((file) => file.endsWith(".md"))) {
    let inDecision = false;
    for (const line of readFileSync(join(findingsDirectory, name), "utf8").split("\n")) {
      if (/^#{1,6}\s/.test(line)) inDecision = /^##\s+Run lead decision\s*$/i.test(line);
      else if (inDecision && DECISION_LINE.test(line)) {
        const decision = /\b(leave|send back)\b/i.exec(line)?.[1].toLowerCase();
        if (decision === "leave") count++;
      }
    }
  }
  return count;
}

function countFindingsSentBack(runDirectory: string): number {
  const findingsDirectory = join(runDirectory, "findings");
  if (!existsSync(findingsDirectory)) return 0;
  let count = 0;
  for (const name of readdirSync(findingsDirectory).filter((file) => ROUND_FILE.test(file)))
    for (const line of readFileSync(join(findingsDirectory, name), "utf8").split("\n"))
      if (RANKED_LINE.test(line)) count++;
  return count;
}

/** A step that finished with not_started never ran: drop its last start and that finish. */
function withoutNotStarted(events: ArkEvent[]): ArkEvent[] {
  const dropped = new Set<ArkEvent>();
  events.forEach((event, index) => {
    if (event.type !== "step.finished" || !event.data.not_started) return;
    dropped.add(event);
    const started = events
      .slice(0, index)
      .findLast(
        (candidate) => candidate.type === "step.started" && candidate.data.step === event.data.step,
      );
    if (started) dropped.add(started);
  });
  return events.filter((event) => !dropped.has(event));
}

export function retro(runId: string, inProject?: string): void {
  const { project, directory: runDirectory } = findRun(runId, inProject);
  const events = withoutNotStarted(readEvents(runDirectory));
  if (events.length === 0) throw new ArkError(`run ${runId} has no events`);

  const firstTime = toMilliseconds(events[0].time);
  const runEnd = toMilliseconds(events[events.length - 1].time);
  const windows = stepWindows(events);
  const { messages, sessions } = collectMessages(runDirectory);

  // Each session file goes whole to one owner (the same rule as the hub); its messages follow it.
  const stages = stageTimes(events);
  const owners = ownersOf(
    sessions.map((session) => ({
      cwd: session.cwd,
      start: session.start,
      mtime: session.mtime,
      times: session.messages.map((message) => toMilliseconds(message.time)),
    })),
    [resolve(runDirectory), realpathSync(runDirectory)],
    windows,
    firstTime,
    stages,
  );
  const placements = new Map<string, Placement>(
    sessions.map((session, index) => [
      session.file,
      placementOf(owners[index], session.messages, stages),
    ]),
  );
  const placementOfMessage = (message: Message): Placement =>
    placements.get(message.sessionFile) ?? { kind: "unassigned" };
  const stepOf = new Map<Message, StepWindow>();
  for (const message of messages) {
    const placement = placementOfMessage(message);
    if (placement.kind === "step") stepOf.set(message, placement.window);
  }
  const designRounds = designRoundCount(events);
  const roleOf = (message: Message): string => {
    const placement = placementOfMessage(message);
    return placement.kind === "step"
      ? placement.window.role
      : placement.kind === "evaluator" || placement.kind === "designer"
        ? placement.kind
        : "orchestration";
  };
  const orchestrationMessages = messages.filter(
    (message) => placementOfMessage(message).kind === "lead",
  );
  const unassignedMessages = messages.filter(
    (message) => placementOfMessage(message).kind === "unassigned",
  );
  const stepIds = [...new Set(windows.map((window) => window.id))];
  const roleOfStep = new Map(windows.map((window) => [window.id, window.role]));

  const byStep = groupBy(messages, (message) =>
    placementOfMessage(message).kind === "unassigned"
      ? "unassigned"
      : (stepOf.get(message)?.id ?? "orchestration"),
  );
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

  // Actual models per step ID; rework rounds share an ID. A step with no session has an empty list.
  const actualModels = sortedObject(
    stepIds.map((id): [string, string[]] => [
      id,
      [
        ...new Set(
          [...stepOf]
            .filter(([message, window]) => window.id === id && !message.helper)
            .map(([message]) => message.model),
        ),
      ].sort(),
    ]),
  );
  // Helper calls (a `purpose`) of the files a step owns: one entry per model and purpose, cost included.
  const helperModels = sortedObject(
    stepIds.flatMap((id): [string, HelperModel[]][] => {
      const own = [...stepOf].filter(([message, window]) => window.id === id && message.helper);
      const groups = new Map<string, Message[]>();
      for (const [message] of own) {
        const key = JSON.stringify([message.model, message.purpose]);
        groups.set(key, [...(groups.get(key) ?? []), message]);
      }
      const entries = [...groups.values()]
        .map((members) => ({
          model: members[0].model,
          purpose: members[0].purpose ?? "",
          usd: summarize(members).usd,
          tokens: summarize(members).tokens,
        }))
        .sort(
          (left, right) =>
            (left.model < right.model ? -1 : left.model > right.model ? 1 : 0) ||
            (left.purpose < right.purpose ? -1 : left.purpose > right.purpose ? 1 : 0),
        );
      return entries.length > 0 ? [[id, entries]] : [];
    }),
  );
  const unassignedFiles = sessions
    .filter((session) => placements.get(session.file)?.kind === "unassigned")
    .map((session) => session.file.slice(session.file.lastIndexOf("/") + 1));
  let planSteps: PlanStep[] = [];
  try {
    planSteps = loadPlan(runDirectory).steps;
  } catch (err) {
    if (!(err instanceof ArkError)) throw err; // no plan.yml, or one that does not parse: nothing to compare
  }
  // plan.yml says anthropic/claude-x, session messages say claude-x: compare and judge vendors on the name after the last "/".
  const bareModels = Object.fromEntries(
    Object.entries(actualModels).map(([stepId, models]) => [
      stepId,
      models.map((model) => model.slice(model.lastIndexOf("/") + 1)),
    ]),
  );
  const modelChangedLines = planSteps
    .filter((step) => {
      const planned = step.model.slice(step.model.lastIndexOf("/") + 1);
      return (bareModels[step.id] ?? []).some((model) => model !== planned);
    })
    .map(
      (step) =>
        `model changed: step ${step.id} planned ${step.model}, ran ${actualModels[step.id].join(", ")}`,
    );
  // Vendor from the model name: claude- is anthropic, gpt- is openai, else none.
  // Same vendor review: judged on the executed step windows (the repo and role the messages ran in), not on plan.yml.
  const vendorsByRepoStep = new Map<string, Map<string, { role: string; vendors: Set<string> }>>();
  for (const [message, window] of stepOf) {
    if (message.helper) continue;
    const vendorName = message.model.slice(message.model.lastIndexOf("/") + 1);
    const vendor = vendorName.startsWith("claude-")
      ? "anthropic"
      : vendorName.startsWith("gpt-")
        ? "openai"
        : null;
    if (!vendor) continue;
    const stepsInRepo = vendorsByRepoStep.get(window.repo) ?? new Map();
    const entry = stepsInRepo.get(window.id) ?? { role: window.role, vendors: new Set<string>() };
    entry.vendors.add(vendor);
    stepsInRepo.set(window.id, entry);
    vendorsByRepoStep.set(window.repo, stepsInRepo);
  }
  const sameVendorGroups: string[] = [];
  const mixedSteps: string[] = [];
  for (const [repo, stepsInRepo] of [...vendorsByRepoStep].sort(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    const entries = [...stepsInRepo].sort(([left], [right]) => (left < right ? -1 : 1));
    const builders = entries.filter(([, entry]) => entry.role === "implementer");
    // Validators run on the implementer's vendor by design, so only reviewers set the flag.
    const checkers = entries.filter(([, entry]) => entry.role === "reviewer");
    // A checker with two vendors is mixed: neither same vendor nor cross vendor.
    for (const [id, entry] of checkers)
      if (entry.vendors.size > 1)
        mixedSteps.push(`${id} (${[...entry.vendors].sort().join(", ")}) in ${repo}`);
    const checkersShared = checkers.filter(
      ([, entry]) =>
        entry.vendors.size === 1 &&
        builders.some(([, builder]) =>
          [...entry.vendors].every((vendor) => builder.vendors.has(vendor)),
        ),
    );
    if (checkersShared.length > 0)
      sameVendorGroups.push(
        `${checkersShared.map(([id]) => id).join(", ")} with ${builders
          .filter(([, builder]) =>
            checkersShared.some(([, entry]) =>
              [...entry.vendors].every((vendor) => builder.vendors.has(vendor)),
            ),
          )
          .map(([id]) => id)
          .join(", ")} in ${repo}`,
      );
  }
  const closed = events.some((event) => event.type === "run.closed");
  const findingsSentBack = countFindingsSentBack(runDirectory);
  const mergeRequests = mergeRequestActivity(runDirectory, events);

  let idleGaps = 0;
  for (const session of sessions) {
    const times = session.messages
      .map((message) => toMilliseconds(message.time))
      .sort((left, right) => left - right);
    for (let i = 1; i < times.length; i++)
      if (secondsBetween(times[i - 1], times[i]) > IDLE_GAP_SECONDS) idleGaps += 1;
  }

  const unassignedGroup = summarize(unassignedMessages);
  const gateAnswers = events.filter((event) => event.type === "gate.answered");
  const metrics = {
    run: runId,
    actual_models: actualModels,
    ...(Object.keys(helperModels).length > 0 ? { helper_models: helperModels } : {}),
    same_vendor_review: sameVendorGroups.length > 0,
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
          .filter((event) => event.type === "step.started" && !event.data.merge)
          .map((event) => event.data.round ?? 1),
      ),
      escalations: events.filter(
        (event) => event.type === "gate.answered" && event.data.gate === "escalation",
      ).length,
      findings_sent_back: findingsSentBack,
      findings_left_p0p1: countFindingsLeftP0P1(runDirectory),
      merge_steps: events.filter((event) => event.type === "step.started" && event.data.merge)
        .length,
    },
    tests: testMetrics(events),
    design_rounds: designRounds,
    decisions: decisionCounts(runDirectory, events),
    human_intervention: {
      plan_changes: planChanges(events),
      mr_comments: mergeRequests.comments,
      mr_commits_after_open: mergeRequests.commits,
    },
    gates: {
      auto_answers: gateAnswers.filter((event) => event.data.by === "auto").length,
      human_answers: gateAnswers.filter((event) => event.data.by !== "auto").length,
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
      `rework: ${metrics.rework.rounds} rounds, ${metrics.rework.escalations} escalations, ${metrics.rework.findings_sent_back} findings sent back, ${metrics.rework.merge_steps} merge steps`,
      `orchestration: ${metrics.orchestration.restarts} restarts, ${metrics.orchestration.tool_errors} tool errors, ${metrics.orchestration.context_overflows} context overflows, ${metrics.orchestration.idle_gaps} idle gaps`,
      `gate answers: ${metrics.gates.auto_answers} auto, ${metrics.gates.human_answers} human`,
      ...gateAnswers
        .filter((event) => event.data.gate === "escalation")
        .map(
          (event) =>
            `escalation ${event.data.answer} by ${event.data.by === "auto" ? "auto" : "human"}`,
        ),
      ...modelChangedLines,
      `same vendor review: ${sameVendorGroups.length > 0 ? `true (${sameVendorGroups.join("; ")})` : "false"}`,
      ...Object.entries(helperModels).map(([id, entries]) => {
        const group = summarize(
          [...stepOf]
            .filter(([message, window]) => window.id === id && message.helper)
            .map(([m]) => m),
        );
        return `helper models: ${id} ${formatUsd(group.usd, group.includes_unknown)} (${[...new Set(entries.map((entry) => entry.purpose))].join(", ")})`;
      }),
      ...(unassignedFiles.length > 0
        ? [
            `unassigned: ${unassignedFiles.length} ${unassignedFiles.length === 1 ? "file" : "files"}, ${formatUsd(unassignedGroup.usd, unassignedGroup.includes_unknown)}, ${unassignedGroup.tokens} tokens (${[...unassignedFiles.slice(0, 3), ...(unassignedFiles.length > 3 ? [`+${unassignedFiles.length - 3} more`] : [])].join(", ")}; no step window held the file start)`,
          ]
        : []),
      ...(mixedSteps.length > 0 ? [`mixed review steps: ${mixedSteps.join("; ")}`] : []),
      `compared with ${comparison.runs_compared} earlier closed runs`,
      `wrote ${metricsFile}`,
    ].join("\n"),
  );
}
