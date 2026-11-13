import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ArkError } from "./errors.ts";
import {
  type ArkEvent,
  type StageTimes,
  type StepWindow,
  readEvents,
  stageTimes,
  stepWindows,
} from "./events.ts";
import { findRun, projectDirectory, runsDirectory } from "./paths.ts";
import { readResources } from "./resources-file.ts";
import { type PlanDecision, type PlanStep, loadPlan } from "./plan.ts";
import { splitRunTime, withoutInterrupted, withoutNotStarted } from "./time-split.ts";
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

/** Failed tool calls of every session by tool and first command word: count desc, tool asc, word asc. */
function toolErrorList(sessions: SessionWithKey[]) {
  const pairs = new Map<
    string,
    { tool: string; word: string; count: number; first_error: string }
  >();
  for (const call of sessions.flatMap((session) => session.failedCalls)) {
    const key = JSON.stringify([call.tool, call.word]);
    const entry = pairs.get(key);
    if (entry) entry.count += 1;
    else {
      const line = call.error.split("\n").find((text) => text.trim() !== "") ?? "";
      pairs.set(key, {
        tool: call.tool,
        word: call.word,
        count: 1,
        first_error: line.trim().slice(0, 120),
      });
    }
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...pairs.values()].sort(
    (a, b) => b.count - a.count || compare(a.tool, b.tool) || compare(a.word, b.word),
  );
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

function runCommand(command: string[]): unknown {
  try {
    // Bun resolves the command against the PATH of its startup snapshot unless env is passed.
    // No cwd: the tools read each merge request by its URL, so no run folder has to exist.
    const result = Bun.spawnSync(command, {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: MERGE_REQUEST_QUERY_TIMEOUT_MILLISECONDS,
    });
    return result.exitCode === 0 ? JSON.parse(result.stdout.toString()) : null;
  } catch {
    return null; // tool missing, timeout or unparsable output
  }
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** Every item of a paged list API; null when a page cannot be read or the cap cuts the list short. ponytail: capped at 1000 items, raise MAX_PAGES if needed. */
function pagedList(call: (page: number) => string[]): Record<string, any>[] | null {
  const items: Record<string, any>[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = runCommand(call(page));
    if (!Array.isArray(batch)) return null;
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
  return null; // the last allowed page was full: the list may continue, so no number is real
}

type MergeRequestFacts = { comments: number; syncCommits: number; fixCommits: number };
type CommitAfterOpen = { secondParent: string | undefined };

/**
 * Sync commits are merges whose second parent is in the base branch history and is not one of the
 * merge request's own commits (after the merge, its side branches are in the base history too).
 * Every other commit is a fix.
 */
function splitCommits(
  ownCommits: Set<string>,
  commits: CommitAfterOpen[],
  baseHistory: () => Set<string> | null,
): { syncCommits: number; fixCommits: number } | null {
  const merges = commits.filter(
    (commit) => commit.secondParent && !ownCommits.has(commit.secondParent),
  );
  const history = merges.length > 0 ? baseHistory() : new Set<string>();
  if (!history) return null;
  const syncCommits = merges.filter((commit) => history.has(commit.secondParent as string)).length;
  return { syncCommits, fixCommits: commits.length - syncCommits };
}

function queryGithubMergeRequest(url: string, openedAt: number): MergeRequestFacts | null {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) return null;
  const [, host, owner, repo, number] = match;
  const repository = `repos/${owner}/${repo}`;
  const hostArguments = host === "github.com" ? [] : ["--hostname", host];
  const api = (path: string) => (page: number) => [
    "gh",
    "api",
    ...hostArguments,
    `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`,
  ];

  const view = runCommand(["gh", "pr", "view", url, "--json", "baseRefName,comments,reviews"]) as {
    baseRefName?: string;
    comments: unknown[];
    reviews: { body?: string }[];
  } | null;
  const inlineComments = pagedList(api(`${repository}/pulls/${number}/comments`));
  const commits = pagedList(api(`${repository}/pulls/${number}/commits`));
  // The commits endpoint returns at most 250 commits: a full answer may be cut short.
  if (!view || !view.baseRefName || !inlineComments || !commits || commits.length >= 250) {
    return null;
  }
  const base = view.baseRefName;

  const split = splitCommits(
    new Set(commits.map((commit) => commit.sha)),
    commits
      .filter((commit) => toMilliseconds(commit.commit.committer.date) > openedAt)
      .map((commit) => ({ secondParent: commit.parents[1]?.sha })),
    () => {
      const history = pagedList(api(`${repository}/commits?sha=${encodeURIComponent(base)}`));
      return history && new Set(history.map((commit) => commit.sha));
    },
  );
  if (!split) return null;
  return {
    comments:
      view.comments.length +
      view.reviews.filter((review) => review.body).length +
      inlineComments.length,
    ...split,
  };
}

function queryGitlabMergeRequest(url: string, openedAt: number): MergeRequestFacts | null {
  const match = /^https?:\/\/([^/]+)\/(.+?)(?:\/-)?\/merge_requests\/(\d+)/.exec(url);
  if (!match) return null;
  const [, host, projectPath, number] = match;
  // The endpoint comes before --hostname: glab reads the first bare word after "api" as the path.
  const api = (path: string) => (page: number) => [
    "glab",
    "api",
    `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`,
    "--hostname",
    host,
  ];
  const project = `projects/${encodeURIComponent(projectPath)}`;
  const mergeRequest = `${project}/merge_requests/${number}`;

  const details = runCommand(["glab", "api", mergeRequest, "--hostname", host]) as {
    target_branch?: string;
  } | null;
  const notes = pagedList(api(`${mergeRequest}/notes`));
  const commits = pagedList(api(`${mergeRequest}/commits`));
  if (!details || !details.target_branch || !notes || !commits) return null;
  const base = details.target_branch;

  const split = splitCommits(
    new Set(commits.map((commit) => commit.id)),
    commits
      .filter((commit) => toMilliseconds(commit.committed_date) > openedAt)
      .map((commit) => ({ secondParent: commit.parent_ids[1] })),
    () => {
      const history = pagedList(
        api(`${project}/repository/commits?ref_name=${encodeURIComponent(base)}`),
      );
      return history && new Set(history.map((commit) => commit.id));
    },
  );
  if (!split) return null;
  return { comments: notes.filter((note) => !note.system).length, ...split };
}

/** Comments and commits after each merge request opened; every count is "unknown" when gh or glab cannot answer. */
function mergeRequestActivity(events: ArkEvent[]): {
  comments: Unknowable;
  commits: Unknowable;
  syncCommits: Unknowable;
  fixCommits: Unknowable;
} {
  let comments = 0;
  let syncCommits = 0;
  let fixCommits = 0;
  for (const event of events.filter((candidate) => candidate.type === "merge_request.opened")) {
    const url: string = event.data.url;
    const openedAt = toMilliseconds(event.time);
    const facts = url.includes("github.com")
      ? queryGithubMergeRequest(url, openedAt)
      : queryGitlabMergeRequest(url, openedAt);
    if (!facts) {
      return {
        comments: "unknown",
        commits: "unknown",
        syncCommits: "unknown",
        fixCommits: "unknown",
      };
    }
    comments += facts.comments;
    syncCommits += facts.syncCommits;
    fixCommits += facts.fixCommits;
  }
  return { comments, commits: syncCommits + fixCommits, syncCommits, fixCommits };
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

type ResourceEntry = { kind: "suite" | "agent"; name: string; peak_mb: number; cpu_s: number };

/** The resources of a run: "unknown" when `resources.json` holds no figure. */
type ResourcesMetrics = "unknown" | { peak_mb: number; cpu_s: number; top: ResourceEntry[] };

/**
 * The resources of a run from `results/resources.json`: the largest single peak and the CPU seconds of every entry, and the
 * 3 entries with the largest peak. Suite and agent peaks may overlap in time, so peaks are never added; each suite side
 * and each agent is a separate process group, so CPU seconds are. A cached suite has no figures.
 */
function resourcesMetrics(runDirectory: string): ResourcesMetrics {
  const file = readResources(runDirectory);
  const entries: ResourceEntry[] = [];
  for (const [suite, sides] of Object.entries(file?.suites ?? {}))
    for (const [side, use] of Object.entries(sides))
      if ("peak_mb" in use)
        entries.push({
          kind: "suite",
          name: `${suite} ${side}`,
          peak_mb: use.peak_mb,
          cpu_s: use.cpu_s,
        });
  for (const [handle, use] of Object.entries(file?.agents ?? {}))
    entries.push({ kind: "agent", name: handle, ...use });
  if (entries.length === 0) return "unknown";
  return {
    peak_mb: Math.max(...entries.map((entry) => entry.peak_mb)),
    cpu_s: Math.round(entries.reduce((sum, entry) => sum + entry.cpu_s, 0) * 10) / 10,
    top: [...entries].sort((left, right) => right.peak_mb - left.peak_mb).slice(0, 3),
  };
}

function resourcesLine(resources: ResourcesMetrics): string {
  return resources === "unknown"
    ? "resources: unknown"
    : `resources: peak ${resources.peak_mb} MB, ${resources.cpu_s} CPU s; top 3 by memory: ${resources.top
        .map((entry) => `${entry.kind} ${entry.name} ${entry.peak_mb} MB`)
        .join(", ")}`;
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
  const waitingOnYou: number[] = [];
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
    // An older file has no such field: skip it, a missing part is not 0 s.
    if (typeof metrics.time?.waiting_on_you_seconds === "number")
      waitingOnYou.push(metrics.time.waiting_on_you_seconds);
  }
  return {
    runs_compared: runsCompared,
    median_cost_usd: median(costs),
    median_wall_seconds: median(wallSeconds),
    median_waiting_on_you_seconds: median(waitingOnYou),
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
      file: session.file,
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
  const timeSplit = splitRunTime(events, runEnd);
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
  const mergeRequests = mergeRequestActivity(events);

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
      ...timeSplit,
      by_step: sortedObject([...stepSeconds]),
    },
    rework: {
      rounds: Math.max(
        1,
        ...withoutInterrupted(events)
          .filter((event) => event.type === "step.started" && !event.data.merge)
          .map((event) => event.data.round ?? 1),
      ),
      escalations: events.filter(
        (event) => event.type === "gate.answered" && event.data.gate === "escalation",
      ).length,
      findings_sent_back: findingsSentBack,
      findings_left_p0p1: countFindingsLeftP0P1(runDirectory),
      merge_steps: withoutInterrupted(events).filter(
        (event) => event.type === "step.started" && event.data.merge,
      ).length,
    },
    tests: testMetrics(events),
    design_rounds: designRounds,
    decisions: decisionCounts(runDirectory, events),
    human_intervention: {
      plan_changes: planChanges(events),
      mr_comments: mergeRequests.comments,
      mr_commits_after_open: mergeRequests.commits,
      mr_sync_commits: mergeRequests.syncCommits,
      mr_fix_commits: mergeRequests.fixCommits,
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
      tool_error_list: toolErrorList(sessions),
      context_overflows: sessions.reduce((sum, session) => sum + session.contextOverflows, 0),
      idle_gaps: idleGaps,
      master_chief_and_run_lead_cost: summarize(orchestrationMessages),
    },
    resources: resourcesMetrics(runDirectory),
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
      `time: ${Math.round(wallSeconds)}s wall: ${Math.round(timeSplit.waiting_on_you_seconds)}s waiting on you, ${Math.round(timeSplit.working_seconds)}s working, ${Math.round(timeSplit.waiting_to_merge_seconds)}s waiting to merge, ${Math.round(timeSplit.idle_seconds)}s idle`,
      `rework: ${metrics.rework.rounds} rounds, ${metrics.rework.escalations} escalations, ${metrics.rework.findings_sent_back} findings sent back, ${metrics.rework.merge_steps} merge steps`,
      `orchestration: ${metrics.orchestration.restarts} restarts, ${metrics.orchestration.tool_errors} tool errors, ${metrics.orchestration.context_overflows} context overflows, ${metrics.orchestration.idle_gaps} idle gaps`,
      ...metrics.orchestration.tool_error_list
        .slice(0, 5)
        .map(
          (entry) =>
            `tool error: ${entry.tool}${entry.word === "" ? "" : ` ${entry.word}`} x${entry.count}: ${entry.first_error}`,
        ),
      `gate answers: ${metrics.gates.auto_answers} auto, ${metrics.gates.human_answers} human`,
      resourcesLine(metrics.resources),
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
      ...(comparison.median_waiting_on_you_seconds === "unknown"
        ? []
        : [
            `waiting on you: ${Math.round(timeSplit.waiting_on_you_seconds)}s here, ${Math.round(comparison.median_waiting_on_you_seconds)}s typical`,
          ]),
      `wrote ${metricsFile}`,
    ].join("\n"),
  );
}
