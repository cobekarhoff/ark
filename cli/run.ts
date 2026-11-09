import { now as hubNow } from "./clock.ts";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { releaseSettledWorkers } from "./orca-release.ts";
import { loadConfig, mergeRequestsMode, type ProjectConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import {
  appendEvent,
  deriveState,
  readEvents,
  waitingGate,
  writeState,
  type ArkEvent,
  type EventData,
  type RunState,
} from "./events.ts";
import { ticketStatusAfter } from "./lifecycle.ts";
import { arkHome, findRun, listProjects, runsDirectory } from "./paths.ts";
import { runningCost } from "./retro.ts";
import { assertShippable, staleHeads } from "./merge-request.ts";
import { assertAllowed } from "./transitions.ts";
import { commitsAhead, worktreeCleanup } from "./worktree.ts";
import { loadPlan, repoGraph, type Plan } from "./plan.ts";
import { hasTestCriterion, manualCriteria, readTicket, setTicketStatus } from "./ticket.ts";

const runIdPattern = /^(\d{4}-\d{2}-\d{2})-(.+)-(\d+)$/;

function resolveProject(absoluteTicketFile: string, project?: string): string {
  const chosen = project ?? process.env.ARK_PROJECT;
  if (chosen) return chosen;
  const projectsRoot = join(resolve(arkHome()), "projects") + sep;
  const inside = absoluteTicketFile.startsWith(projectsRoot)
    ? absoluteTicketFile.slice(projectsRoot.length).split(sep)[0]
    : "";
  if (inside && listProjects().includes(inside)) return inside;
  throw new ArkError(
    "cannot tell the project: pass --project <name>, set ARK_PROJECT, or keep the ticket file inside the project folder",
  );
}

function today(): string {
  const now = new Date(hubNow());
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Largest whole unit only: Nm, Nh or Nd. */
function formatAge(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function runStart(ticketFile: string, project?: string): void {
  if (!existsSync(ticketFile)) throw new ArkError(`ticket file not found: ${ticketFile}`);
  const absoluteTicketFile = resolve(ticketFile);
  const projectName = resolveProject(absoluteTicketFile, project);
  const config = loadConfig(projectName);
  const ticket = readTicket(absoluteTicketFile);

  const runsRoot = runsDirectory(projectName);
  const date = today();
  let highestNumber = 0;
  for (const name of existsSync(runsRoot) ? readdirSync(runsRoot).sort() : []) {
    const parts = name.match(runIdPattern);
    if (!parts || parts[2] !== ticket.id) continue;
    const state = deriveState(readEvents(join(runsRoot, name)));
    if (state.events > 0 && state.phase !== "closed")
      throw new ArkError(`ticket ${ticket.id} already has an open run: ${name}`);
    if (parts[1] === date) highestNumber = Math.max(highestNumber, Number(parts[3]));
  }

  const run = `${date}-${ticket.id}-${highestNumber + 1}`;
  const directory = join(runsRoot, run);
  mkdirSync(directory, { recursive: true });
  try {
    copyFileSync(absoluteTicketFile, join(directory, "ticket.md"));
    appendEvent(directory, "run.started", {
      run,
      project: projectName,
      ticket: { id: ticket.id, title: ticket.title },
      kind: ticket.kind,
      criteria: ticket.criteria,
      criteria_gate: true,
      ticket_file: absoluteTicketFile,
      round_budget: config.round_budget,
    });
  } catch (err) {
    rmSync(directory, { recursive: true, force: true });
    throw err;
  }
  warnSetTicketStatus(absoluteTicketFile, projectName, "in_progress");
  if ((ticket.kind === "bug" || ticket.kind === "refactor") && !hasTestCriterion(directory))
    console.warn(
      `warning: kind ${ticket.kind} has no method: test AC, so its red-test or base-pass rule does not apply`,
    );
  console.log(run);
}

/** The most extra rounds `gates.escalation: auto` grants in one run. */
const autoEscalationCap = 2;

function refused(action: () => void): boolean {
  try {
    action();
    return false;
  } catch (err) {
    if (!(err instanceof ArkError)) throw err;
    return true;
  }
}

/**
 * Records escalation one_more_round by auto when `start` is refused only for an escalation reason:
 * the answer is dry-run first, so a start refused for any other reason leaves no answer.
 * Returns the count line, or null when nothing was recorded.
 */
function answerEscalationByAuto(
  directory: string,
  events: ArkEvent[],
  state: RunState,
  start: EventData,
): string | null {
  if (state.escalation_requested || state.implementer === "human") return null;
  if (!refused(() => assertAllowed(state, "step.started", start, directory))) return null;
  const used = events.filter(
    (event) =>
      event.type === "gate.answered" &&
      event.data.gate === "escalation" &&
      event.data.by === "auto" &&
      !event.data.merge,
  ).length;
  if (!start.merge && used >= autoEscalationCap) return null;
  const answer = {
    gate: "escalation",
    answer: "one_more_round",
    by: "auto",
    ...(start.merge ? { merge: true } : {}),
  };
  if (refused(() => assertAllowed(state, "gate.answered", answer, directory))) return null;
  const answered = deriveState([
    ...events,
    {
      seq: events.length + 1,
      time: new Date(hubNow()).toISOString(),
      type: "gate.answered",
      data: answer,
    },
  ]);
  if (refused(() => assertAllowed(answered, "step.started", start, directory))) return null;
  appendEvent(directory, "gate.answered", answer);
  return `escalation one_more_round by auto (${start.merge ? "merge, not counted" : `${used + 1} of ${autoEscalationCap}`})`;
}

export function runStep(
  runId: string,
  stepId: string,
  action: string,
  failed = false,
  merge = false,
  notStarted = false,
  inProject?: string,
): void {
  if (action !== "start" && action !== "finish")
    throw new ArkError(`unknown step action "${action}": use start or finish`);
  if (failed && action === "start") throw new ArkError("--failed only applies to finish");
  if (merge && action === "finish") throw new ArkError("--merge only applies to start");
  if (notStarted && action === "start") throw new ArkError("--not-started only applies to finish");
  if (notStarted && !failed) throw new ArkError("--not-started needs --failed");
  if (notStarted && merge) throw new ArkError("--not-started cannot be used with --merge");
  const { project, directory } = findRun(runId, inProject);
  const events = readEvents(directory);
  const state = deriveState(events);

  if (action === "finish") {
    const outcome = failed ? "failed" : "succeeded";
    const last = events.findLast(
      (event) =>
        (event.type === "step.started" || event.type === "step.finished") &&
        event.data.step === stepId,
    );
    if (notStarted && last?.type !== "step.started")
      throw new ArkError(`--not-started needs a running start of step ${stepId}`);
    const started = events.findLast(
      (event) => event.type === "step.started" && event.data.step === stepId,
    );
    appendEvent(directory, "step.finished", {
      step: stepId,
      outcome,
      ...(started?.data.merge ? { merge: true } : {}),
      ...(notStarted ? { not_started: true } : {}),
    });
    console.log(`${runId} ${stepId} ${outcome}${notStarted ? " (not started)" : ""}`);
    return;
  }

  // Refuse on the phase first, so a run before plan approval names the missing gate, not an unknown step.
  assertAllowed(
    state,
    "step.started",
    { step: stepId, role: "", repo: "", round: state.round },
    directory,
  );
  const planned = state.steps.find((step) => step.id === stepId);
  if (!planned)
    throw new ArkError(
      `unknown step ${stepId}: the checked plan has ${state.steps.map((step) => step.id).join(", ") || "no steps"}`,
    );
  const finishes = events.filter(
    (event) =>
      event.type === "step.finished" &&
      event.data.step === stepId &&
      !event.data.merge &&
      !event.data.not_started,
  ).length;
  const round = planned.role === "implementer" && !merge ? finishes + 1 : state.round;
  const start: EventData = {
    step: stepId,
    role: planned.role,
    repo: planned.repo,
    round,
    ...(merge ? { merge: true } : {}),
  };
  if (planned.role === "implementer" && loadConfig(project).gates.escalation === "auto") {
    const line = answerEscalationByAuto(directory, events, state, start);
    if (line) console.log(line);
  }
  appendEvent(directory, "step.started", start);
  console.log(
    `${runId} ${stepId} started (${merge ? "merge, " : ""}round ${round}/${deriveState(readEvents(directory)).round_budget})`,
  );
}

/** Sets a local ticket's status. A failure only warns: the run is already recorded. */
function warnSetTicketStatus(ticketFile: string, project: string, status: string): void {
  try {
    if (loadConfig(project).ticket_source !== "local") return;
    if (existsSync(ticketFile) && setTicketStatus(ticketFile, status)) return;
    console.warn(`warning: could not set status ${status} in ${ticketFile}`);
  } catch (err) {
    console.warn(
      `warning: ticket status not updated: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Keeps a local ticket's status in step with its run. handed_off leaves the file as it is. */
function syncClosedTicket(started: EventData | undefined, outcome: string): void {
  const status = ticketStatusAfter(outcome);
  if (!status || !started?.ticket_file) return;
  warnSetTicketStatus(started.ticket_file, started.project, status);
}

export async function runClose(runId: string, outcome: string, inProject?: string): Promise<void> {
  const { project, directory } = findRun(runId, inProject);
  const events = readEvents(directory);
  if (outcome === "handed_off") {
    const state = deriveState(events);
    assertAllowed(state, "run.closed", { outcome }, directory);
    assertShippable(runId, project, directory, events, state);
  }
  const started = events.find((event) => event.type === "run.started");
  appendEvent(directory, "run.closed", { outcome });
  console.log(`${runId} closed: ${outcome}`);
  if (outcome === "handed_off" && statusMergeRequestsMode(project) === "none")
    for (const line of localOnlyLines(project, directory, deriveState(readEvents(directory))).slice(
      1,
    ))
      console.log(line);
  syncClosedTicket(started?.data, outcome);
  worktreeCleanup(runId, inProject);
  // After the record and the cleanup, so an Orca failure cannot fail the close.
  for (const line of await releaseSettledWorkers(runId)) console.log(line);
}

/** Releases the settled workers of every closed run. Read-only for Ark: records no event. */
export async function runCloseSweep(inProject?: string): Promise<void> {
  const projects = listProjects();
  const requested = inProject ?? process.env.ARK_PROJECT;
  if (requested && !projects.includes(requested))
    throw new ArkError(`project ${requested} does not exist under ${arkHome()}/projects`);
  for (const project of requested ? [requested] : projects) {
    const runsRoot = runsDirectory(project);
    for (const name of existsSync(runsRoot) ? readdirSync(runsRoot).sort() : []) {
      const events = join(runsRoot, name, "events.ndjson");
      if (!existsSync(events) || deriveState(readEvents(join(runsRoot, name))).phase !== "closed")
        continue;
      const lines = await releaseSettledWorkers(name);
      if (lines.length > 0)
        console.log([`${name}:`, ...lines.map((line) => `  ${line}`)].join("\n"));
    }
  }
}

function costLine(directory: string): string {
  try {
    const { usd, tokens } = runningCost(directory);
    return `cost: ${usd === "unknown" ? "unknown" : `$${usd.toFixed(2)}`} (${tokens} tokens)`;
  } catch {
    return "cost: unknown";
  }
}

export function status(runId?: string, project?: string): void {
  const projects = listProjects();
  const requested = project ?? process.env.ARK_PROJECT;
  if (requested && !projects.includes(requested))
    throw new ArkError(`project ${requested} does not exist under ${arkHome()}/projects`);
  if (runId !== undefined) return printRun(runId, project);
  let invalidCount = 0;
  for (const project of requested ? [requested] : projects) {
    try {
      loadConfig(project);
    } catch (err) {
      if (!(err instanceof ArkError)) throw err;
      console.log(`config error: ${project}: ${err.message}`);
      invalidCount += 1;
    }
  }
  const lines: string[] = [];
  for (const project of projects) {
    const runsRoot = runsDirectory(project);
    for (const name of existsSync(runsRoot) ? readdirSync(runsRoot).sort() : []) {
      const directory = join(runsRoot, name);
      if (!existsSync(join(directory, "events.ndjson"))) continue;
      const state = writeState(directory);
      if (state.phase !== "closed") {
        const newest = readEvents(directory).at(-1);
        const age = newest ? hubNow() - Date.parse(newest.time) : 0;
        lines.push(
          `${name}  ${state.phase}  ${state.current_step ?? "-"}  ${formatAge(age)}${age > 24 * 3_600_000 ? "  stale" : ""}`,
        );
      }
    }
  }
  console.log(lines.length > 0 ? lines.join("\n") : "no open runs");
  if (invalidCount > 0) throw new ArkError(`${invalidCount} project config(s) invalid`);
}

function testHeadLines(directory: string): string[] {
  const events = readEvents(directory);
  if (!events.some((event) => event.type === "test.completed")) return [];
  const stale = staleHeads(events);
  if (stale.length === 0) return ["test head: current"];
  return stale.map(
    ({ repo, tested, current }) =>
      `test head: stale (${repo} tested ${tested?.slice(0, 8) ?? "nothing"}, now ${current.slice(0, 8)})`,
  );
}

/** ark status stays readable without a valid ark.yml: a missing or invalid one counts as open. */
function statusMergeRequestsMode(project: string): ProjectConfig["merge_requests"] {
  try {
    return mergeRequestsMode(project);
  } catch {
    return "open";
  }
}

/** The plan's repo order, repos list and steps, or none when the plan is missing or invalid (status stays readable). */
function readablePlan(directory: string, ticketId: string): Plan | undefined {
  try {
    return loadPlan(directory, ticketId);
  } catch {
    return undefined;
  }
}

/** The plan's merge order, or none when the graph cannot be ordered (a dependency cycle): status stays readable. */
function repoOrder(plan: Plan): string[] {
  try {
    return repoGraph(plan).order;
  } catch {
    return [];
  }
}

/**
 * The `none` project's merge request line, then one `branch` line for each worktree with commits beyond its base, in
 * merge order (the repos graph, else step needs), each followed by the bump steps of its repo that are not done.
 * A bump of a repo with no branch line comes after the last branch line.
 */
function localOnlyLines(project: string, directory: string, state: RunState): string[] {
  const workspace = loadConfig(project).workspace;
  const plan = readablePlan(directory, state.ticket.id);
  const order = plan ? repoOrder(plan) : [];
  const position = (repo: string) => {
    const index = order.indexOf(repo);
    return index < 0 ? order.length : index;
  };
  const repos = [...new Set([...order, ...state.worktrees.map((worktree) => worktree.repo)])];
  const width = Math.max(0, ...repos.map((repo) => repo.length)) + 3;
  const pendingBumps = (repo: string) =>
    (plan?.repos.find((entry) => entry.repo === repo)?.depends_on ?? [])
      .filter(
        (edge) =>
          edge.bump && state.steps.find((step) => step.id === edge.bump)?.status !== "succeeded",
      )
      .map(
        (edge) => `           pending bump: ${edge.bump} (${edge.kind} ${edge.repo}, ${edge.pin})`,
      );
  const lines: string[] = [];
  const unlisted: string[] = [];
  const worktrees = [...state.worktrees].sort(
    (left, right) => position(left.repo) - position(right.repo),
  );
  const branchRepos = new Set<string>();
  for (const { repo, branch, base } of worktrees) {
    const ahead = commitsAhead(join(workspace, repo), branch, base);
    if (!ahead) continue;
    branchRepos.add(repo);
    lines.push(
      `branch   ${position(repo) + 1}  ${repo.padEnd(width)}${branch}   ${ahead} commit(s) ahead of ${base?.slice(0, 8)}`,
      ...pendingBumps(repo),
    );
  }
  for (const repo of order) if (!branchRepos.has(repo)) unlisted.push(...pendingBumps(repo));
  const fallback =
    plan && plan.repos.length === 0 && new Set(plan.steps.map((step) => step.repo)).size > 1
      ? ["order: from step needs (no repos list)"]
      : [];
  return ["merge requests: none (local only)", ...fallback, ...lines, ...unlisted];
}

/** The words of `from` and `to` that differ, with "..." on each cut side. */
function changedWords(from: string, to: string): [string, string] {
  const a = from.split(/\s+/);
  const b = to.split(/\s+/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const cut = (words: string[]) =>
    [
      head > 0 ? "..." : "",
      words.slice(head, words.length - tail).join(" "),
      tail > 0 ? "..." : "",
    ].join("");
  return [cut(a), cut(b)];
}

function amendedLines(state: RunState): string[] {
  if (state.amended_criteria.length === 0) return [];
  return [
    "amended criteria:",
    ...state.amended_criteria.flatMap((amended) => {
      const [before, after] = changedWords(amended.old, amended.new);
      return [
        `  ${amended.id} by ${amended.by}: ${amended.reason.replace(/\s+/g, " ")}`,
        `    old: ${before}`,
        `    new: ${after}`,
      ];
    }),
  ];
}

function printRun(runId: string, inProject?: string): void {
  const { project, directory } = findRun(runId, inProject);
  const state = writeState(directory);
  if (state.events === 0) throw new ArkError(`run ${runId} has no events`);
  const answered = readEvents(directory)
    .filter((event) => event.type === "gate.answered")
    .map(
      (event) =>
        `  ${event.data.gate} ${event.data.answer} by ${event.data.by === "auto" ? "auto" : "human"}`,
    );
  const current = state.steps.find((step) => step.id === state.current_step);
  const manualPending = manualCriteria(directory).filter(
    (id) => state.gates[`manual:${id}`] !== "ok",
  );
  const lines = [
    `run: ${basename(directory)}`,
    `ticket: ${state.ticket.id} ${state.ticket.title}`,
    `kind: ${state.kind}`,
    `phase: ${state.phase}${state.outcome ? ` (${state.outcome})` : ""}`,
    `round: ${state.round}/${state.round_budget}`,
    `current step: ${current ? `${current.id} (${current.status})` : "none"}`,
    `waiting gate: ${waitingGate(state)}`,
    ...(manualPending.length > 0 ? [`manual pending: ${manualPending.join(", ")}`] : []),
    ...(answered.length > 0 ? ["gates answered:", ...answered] : []),
    ...amendedLines(state),
    `last test: ${state.last_test ? (state.last_test.passed ? "passed" : "failed") : "none"}`,
    ...testHeadLines(directory),
    ...(statusMergeRequestsMode(project) === "none"
      ? localOnlyLines(project, directory, state)
      : [
          `merge requests: ${state.merge_requests.length === 0 ? "none" : ""}`,
          ...state.merge_requests.map((request) => `  ${request.repo} ${request.url}`),
        ]),
    costLine(directory),
  ];
  console.log(lines.join("\n"));
}
