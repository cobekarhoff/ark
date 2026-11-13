import { now as hubNow, waitFor } from "./clock.ts";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { releaseSettledWorkers } from "./orca-release.ts";
import {
  bindTerminal,
  closeTerminal,
  createTerminal,
  readTerminals,
  startWorker,
  type StartedWorker,
} from "./orca.ts";
import { buildSpec, reviewRangeStart } from "./spec.ts";
import { watchSession } from "./usage/index.ts";
import { loadConfig, mergeRequestsMode, type ProjectConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { checkRoles } from "./role-check.ts";
import {
  appendEvent,
  deriveState,
  readEvents,
  waitingGate,
  writeState,
  lastWorker,
  type ArkEvent,
  type EventData,
  type RunState,
} from "./events.ts";
import { ticketStatusAfter } from "./lifecycle.ts";
import { arkHome, findRun, listProjects, runsDirectory } from "./paths.ts";
import { runningCost } from "./retro.ts";
import { assertShippable, staleHeads } from "./merge-request.ts";
import { runnerStatusLines } from "./test-runner.ts";
import { assertAllowed } from "./transitions.ts";
import { commitsAhead, submoduleLines, worktreeCleanup, worktreeDirtyLines } from "./worktree.ts";
import { repoBase, targetBranch } from "./workspace.ts";
import { loadPlan, repoGraph, type Plan, type PlanStep } from "./plan.ts";
import { hasTestCriterion, manualCriteria, readTicket, setTicketStatus } from "./ticket.ts";
import { unplannedWithoutReason } from "../skills/pr-writing/lib/ledger.ts";

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

/**
 * Records a running step as interrupted once Orca shows its worker terminal gone. It never guesses:
 * a terminal Orca lists in any state (disconnected too) or an Orca that does not answer refuses it.
 * It runs no git command, so the worktree keeps every file.
 */
async function markInterrupted(
  runId: string,
  directory: string,
  events: ArkEvent[],
  state: RunState,
  stepId: string,
): Promise<void> {
  const status = state.steps.find((step) => step.id === stepId)?.status;
  if (status !== "running")
    throw new ArkError(
      `step.finished refused: ${stepId} is ${status ?? "not in the plan"}, not running`,
    );
  // Only a worker recorded by the latest start of the step counts; an earlier start's terminal says nothing about this one.
  const lastStart = events.findLastIndex(
    (event) => event.type === "step.started" && event.data.step === stepId,
  );
  const worker = lastWorker(events.slice(lastStart + 1), stepId);
  if (worker === null) {
    // No worker record: only an Orca that answers and lists no terminal of the step's worktree proves it gone.
    const repo = state.steps.find((step) => step.id === stepId)?.repo;
    const worktree = state.worktrees.find((entry) => entry.repo === repo)?.path;
    const snapshot = await readTerminals();
    if (snapshot === null)
      throw new ArkError(
        `step.finished refused: ${stepId} has no worker record and Orca did not answer (orca terminal list failed), so ark cannot tell if its worker is live`,
      );
    const there = worktree
      ? snapshot.terminals.find(
          (terminal) =>
            terminal.worktreePath !== undefined &&
            resolve(terminal.worktreePath) === resolve(worktree),
        )
      : undefined;
    if (there)
      throw new ArkError(
        `step.finished refused: Orca lists terminal ${there.handle} in the worktree of ${stepId}, so its worker may be live`,
      );
  } else {
    if (!worker.terminal || worker.terminal === "unknown")
      throw new ArkError(
        `step.finished refused: no worker terminal is recorded for ${stepId}, so ark cannot tell if its worker is live`,
      );
    const snapshot = await readTerminals();
    if (snapshot === null)
      throw new ArkError(
        `step.finished refused: cannot tell if the worker of ${stepId} is live (orca terminal list failed)`,
      );
    const listed = snapshot.terminals.find((terminal) => terminal.handle === worker.terminal);
    if (listed)
      throw new ArkError(
        `step.finished refused: the worker of ${stepId} is live (terminal ${worker.terminal}, ${listed.connected === false ? "disconnected" : "running"})`,
      );
  }
  const started = events.findLast(
    (event) => event.type === "step.started" && event.data.step === stepId,
  );
  appendEvent(directory, "step.finished", {
    step: stepId,
    outcome: "interrupted",
    ...(started?.data.merge ? { merge: true } : {}),
  });
  console.log(
    `${runId} ${stepId} interrupted (round ${started?.data.round ?? state.round} given back, worktree untouched)`,
  );
}

/** How long `start` waits for the worker's session file before it records the session as unknown. */
const sessionWaitMilliseconds = 60_000;

/** The command that restores a worker session, by harness. Others start fresh. */
const restoreCommands: Record<string, (session: string) => string> = {
  omp: (session) => `omp --restore ${shellQuote(session)}`,
};

const shellQuote = (text: string): string =>
  /^[\w./:@%+=,-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

/** True when the last real finish of the step was an interrupt and no worker has started since. */
function takesOverFromDeadWorker(events: ArkEvent[], stepId: string): boolean {
  const last = events.findLastIndex(
    (event) =>
      event.type === "step.finished" && event.data.step === stepId && !event.data.not_started,
  );
  return (
    last >= 0 &&
    events[last].data.outcome === "interrupted" &&
    !events
      .slice(last + 1)
      .some((event) => event.type === "worker.started" && event.data.step === stepId)
  );
}

/** A finished --merge step merged origin's target by hand: record the newest target commit HEAD contains (the merge-base with origin's target, so a later fetch does not hide it), so ark test's base side follows it. Nothing is recorded when that commit is not newer than the current base. */
function recordMergedTarget(project: string, directory: string, repo: string): void {
  const worktree = deriveState(readEvents(directory)).worktrees.find(
    (entry) => entry.repo === repo,
  );
  if (!worktree) return;
  const target = targetBranch(worktree.path, repoBase(loadConfig(project), repo));
  const mergeBase = Bun.spawnSync([
    "git",
    "-C",
    worktree.path,
    "merge-base",
    "HEAD",
    `origin/${target}`,
  ]);
  if (mergeBase.exitCode !== 0) return;
  const commit = mergeBase.stdout.toString().trim();
  const current = worktree.synced ?? worktree.base;
  if (!current) return;
  const isNewer =
    commit !== current &&
    Bun.spawnSync(["git", "-C", worktree.path, "merge-base", "--is-ancestor", current, commit])
      .exitCode === 0;
  if (isNewer)
    appendEvent(directory, "worktree.synced", { repo, conflict: false, target_commit: commit });
}

/**
 * Starts the worker of a plan step through Orca and records `step.started` and `worker.started`.
 * The caller has validated the start. A step that was interrupted restores its recorded session, or starts
 * a fresh worker whose spec says to read `git status` and `git diff` first. When Orca starts no worker, the
 * start is recorded as not_started (the round goes back) and this throws. Returns the lines to print.
 */
async function launchWorker(
  runId: string,
  project: string,
  directory: string,
  planStep: PlanStep,
  start: EventData,
): Promise<string[]> {
  const events = readEvents(directory);
  const state = deriveState(events);
  const worktree = state.worktrees.find((entry) => entry.repo === planStep.repo)?.path;
  if (!worktree)
    throw new ArkError(
      `step.started refused: no worktree for repo ${planStep.repo} (create it with ark worktree create)`,
    );
  // The plan step's pair, which `ark plan check` validated against roles; a pair roles lacks needs a plan repair.
  const { harness, model } = planStep;
  const allowed = Object.values(loadConfig(project).roles).some(
    (role) => role.harness === harness && role.model === model,
  );
  if (!allowed)
    throw new ArkError(
      `step.started refused: plan step ${planStep.id} uses ${harness}/${model}, which is not in ark.yml roles; repair the plan (ark plan check) before the start`,
    );
  const title = `${planStep.id} (${planStep.role}, ${planStep.repo})`;
  const takeover = !start.merge && takesOverFromDeadWorker(events, planStep.id);
  const spec = buildSpec({
    run: runId,
    directory,
    state,
    step: planStep,
    interrupted: takeover,
    ...(start.merge
      ? { mergeBase: targetBranch(worktree, repoBase(loadConfig(project), planStep.repo)) }
      : {}),
  });

  let worker: StartedWorker | undefined;
  let workerHarness = harness;
  let session: string | undefined;
  let how = "fresh";
  let reason = "";
  if (takeover) {
    const previous = lastWorker(events, planStep.id);
    const restore =
      previous && Object.hasOwn(restoreCommands, previous.harness)
        ? restoreCommands[previous.harness]
        : undefined;
    if (!previous || !previous.session || previous.session === "unknown")
      reason = "no session recorded";
    else if (!restore) reason = `harness ${previous.harness} has no restore command`;
    else {
      const terminal = await createTerminal(worktree, restore(previous.session));
      if (!terminal.ok) reason = `restore failed: ${terminal.reason}`;
      else {
        const bound = await bindTerminal({ terminal: terminal.value, spec, title, worktree });
        if (bound.ok) {
          worker = bound.value;
          session = previous.session;
          workerHarness = previous.harness;
          how = "restored";
        } else {
          await closeTerminal(terminal.value);
          reason = `restore failed: terminal did not bind: ${bound.reason}`;
        }
      }
    }
    if (!worker) how = `fresh after interrupt (${reason})`;
  }

  const watch = worker ? null : watchSession(harness, worktree);
  if (!worker) {
    const started = await startWorker({ spec, title, worktree, harness, model });
    if (!started.ok) {
      appendEvent(directory, "step.started", start);
      appendEvent(directory, "step.finished", {
        step: planStep.id,
        outcome: "failed",
        not_started: true,
      });
      throw new ArkError(`${planStep.id} not started: orca worker-start failed: ${started.reason}`);
    }
    worker = started.value;
  }
  appendEvent(directory, "step.started", start);
  let sessionLine = session;
  if (!session) {
    session = watch ? await waitFor(watch, sessionWaitMilliseconds, 1000) : undefined;
    sessionLine =
      session ??
      `unknown (${watch ? `no session file in ${sessionWaitMilliseconds / 1000} s` : `${harness} keeps no session files`})`;
  }
  appendEvent(directory, "worker.started", {
    step: planStep.id,
    dispatch: worker.dispatch,
    terminal: worker.terminal,
    harness: workerHarness,
    session: session ?? "unknown",
  });
  return [
    `${runId} ${planStep.id} started (${start.merge ? "merge, " : ""}round ${start.round}/${deriveState(readEvents(directory)).round_budget})`,
    `  worker: ${how}, ${how === "restored" ? `${workerHarness} --restore` : `${harness} ${model}`}, terminal ${worker.terminal}, dispatch ${worker.dispatch}`,
    `  session: ${sessionLine}`,
    ...(takeover && how !== "restored"
      ? ["  brief: an earlier worker was interrupted; it reads `git status` and `git diff` first"]
      : []),
  ];
}

export async function runStep(
  runId: string,
  stepId: string,
  action: string,
  failed = false,
  merge = false,
  notStarted = false,
  inProject?: string,
): Promise<void> {
  if (action !== "start" && action !== "finish" && action !== "interrupted")
    throw new ArkError(`unknown step action "${action}": use start, finish or interrupted`);
  if (failed && action !== "finish") throw new ArkError("--failed only applies to finish");
  if (merge && action !== "start") throw new ArkError("--merge only applies to start");
  if (notStarted && action !== "finish") throw new ArkError("--not-started only applies to finish");
  if (notStarted && !failed) throw new ArkError("--not-started needs --failed");
  if (notStarted && merge) throw new ArkError("--not-started cannot be used with --merge");
  const { project, directory } = findRun(runId, inProject);
  const events = readEvents(directory);
  const state = deriveState(events);

  if (action === "interrupted") {
    await markInterrupted(runId, directory, events, state, stepId);
    return;
  }

  if (action === "finish") {
    const planned = state.steps.find((step) => step.id === stepId);
    const worktree = state.worktrees.find((entry) => entry.repo === planned?.repo)?.path;
    if (planned && !failed && worktree && existsSync(worktree)) {
      // fails closed: a git status failure throws and no step.finished is recorded
      const dirty = worktreeDirtyLines(
        loadConfig(project),
        state.worktrees,
        planned.repo,
        worktree,
      );
      if (dirty.length > 0)
        throw new ArkError(
          `step ${stepId} refused: ${planned.repo} has uncommitted changes:\n${dirty.map((line) => `  ${line}`).join("\n")}\ncommit them, then finish again (use --failed to close a step that did not finish its work)`,
        );
    }
    if (planned?.role === "reviewer" && !failed && worktree && existsSync(worktree)) {
      const start = reviewRangeStart(directory, state, planned, false);
      // An uncountable range (unknown sha) is not read as empty.
      if (start && commitsAhead(worktree, "HEAD", start) === 0) {
        const end = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "HEAD"])
          .stdout.toString()
          .trim();
        throw new ArkError(
          `step ${stepId} refused: the review range ${start}..${end} has no commits; a reviewer needs code to review (use --failed to close a step that did not review)`,
        );
      }
      const unplanned = unplannedWithoutReason(directory, planned.repo);
      if (unplanned.length > 0)
        throw new ArkError(
          `step ${stepId} refused: a changed file is not in the plan and has no reason: ${unplanned.join(", ")}.\n` +
            `Write one line per file in the first ## Merge risk block of findings/${stepId}.md:\n` +
            unplanned.map((file) => `  - Not in plan: ${file} — <reason>`).join("\n"),
        );
    }
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
    if (started?.data.merge && outcome === "succeeded")
      recordMergedTarget(project, directory, started.data.repo);
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
      !event.data.not_started &&
      event.data.outcome !== "interrupted",
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
  const planStep = readablePlan(directory, state.ticket.id)?.steps.find(
    (step) => step.id === stepId,
  );
  const human = planned.role === "implementer" && state.implementer === "human";
  if (!planStep || human) {
    // A human implementer (take_over) or a step plan.yml does not hold has no worker to launch: it is only recorded.
    appendEvent(directory, "step.started", start);
    console.log(
      `${runId} ${stepId} started (${merge ? "merge, " : ""}round ${round}/${deriveState(readEvents(directory)).round_budget})${human ? ", human implementer: no worker launched" : ""}`,
    );
    return;
  }
  // The refusals come before the Orca call, so a refused start launches no worker.
  assertAllowed(deriveState(readEvents(directory)), "step.started", start, directory);
  const lines = await launchWorker(runId, project, directory, planStep, start);
  console.log(lines.join("\n"));
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
  const configs: Record<string, ProjectConfig> = {};
  for (const project of requested ? [requested] : projects) {
    try {
      configs[project] = loadConfig(project);
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
  const roleCheck = checkRoles(configs);
  if (roleCheck.lines.length > 0) console.log(roleCheck.lines.join("\n"));
  if (invalidCount > 0) throw new ArkError(`${invalidCount} project config(s) invalid`);
  if (roleCheck.failures > 0) throw new ArkError(`${roleCheck.failures} role(s) cannot run`);
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

/** Submodule lines need the config's workspace; without a valid ark.yml, status prints none. */
function statusSubmoduleLines(project: string, worktrees: RunState["worktrees"]): string[] {
  try {
    return submoduleLines(loadConfig(project), worktrees);
  } catch {
    return [];
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
  // A submodule needs the head of the upstream worktree branch; a package needs a version that is not published yet.
  const neededValue = (edge: { kind: string; repo: string }) => {
    const upstream = state.worktrees.find((worktree) => worktree.repo === edge.repo);
    if (!upstream || edge.kind !== "submodule") return "<published version>";
    const head = Bun.spawnSync(["git", "-C", upstream.path, "rev-parse", "HEAD"]);
    return head.exitCode === 0 ? head.stdout.toString().trim().slice(0, 8) : "<published version>";
  };
  const pendingBumps = (repo: string) =>
    (plan?.repos.find((entry) => entry.repo === repo)?.depends_on ?? [])
      .filter(
        (edge) =>
          edge.bump && state.steps.find((step) => step.id === edge.bump)?.status !== "succeeded",
      )
      .map(
        (edge) =>
          `           pending bump: ${edge.bump} (${edge.kind} ${edge.repo}, ${edge.pin}) needs ${neededValue(edge)}`,
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
    ...statusSubmoduleLines(project, state.worktrees),
    `last test: ${state.last_test ? (state.last_test.passed ? "passed" : "failed") + (state.last_test.mode === "quick" ? " (quick, not a gate)" : "") : "none"}`,
    ...runnerStatusLines(directory),
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
