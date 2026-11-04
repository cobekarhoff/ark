import { now as hubNow } from "./clock.ts";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { releaseSettledWorkers } from "./orca-release.ts";
import { loadConfig, mergeRequestsMode, type ProjectConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { manualCriteria } from "./criteria.ts";
import {
  appendEvent,
  deriveState,
  readEvents,
  writeState,
  type ArkEvent,
  type EventData,
  ticketKinds,
  type RunState,
  type TicketKind,
} from "./events.ts";
import { arkHome, findRun, listProjects, runsDirectory } from "./paths.ts";
import { runningCost } from "./retro.ts";
import { assertShippable, staleHeads } from "./merge-request.ts";
import { assertAllowed } from "./transitions.ts";
import { commitsAhead, worktreeCleanup } from "./worktree.ts";

const runIdPattern = /^(\d{4}-\d{2}-\d{2})-(.+)-(\d+)$/;

function readTicket(ticketFile: string): {
  id: string;
  title: string;
  kind: TicketKind;
  criteria: string[];
} {
  const frontmatter = readFileSync(ticketFile, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter)
    throw new ArkError(
      `${ticketFile}: the ticket needs YAML frontmatter with id, title and acceptance_criteria`,
    );
  const fields = (Bun.YAML.parse(frontmatter[1]) ?? {}) as Record<string, unknown>;
  for (const key of ["id", "title"]) {
    if (typeof fields[key] !== "string" || fields[key] === "")
      throw new ArkError(`${ticketFile}: ticket field ${key} is required`);
  }
  const kind = fields.kind ?? "feature";
  if (!(ticketKinds as readonly unknown[]).includes(kind))
    throw new ArkError(
      `${ticketFile}: kind must be one of ${ticketKinds.join(", ")}, not ${JSON.stringify(kind)}`,
    );
  const criteria = fields.acceptance_criteria ?? [];
  if (!Array.isArray(criteria))
    throw new ArkError(`${ticketFile}: acceptance_criteria must be a list`);
  const ids = criteria.map((criterion, i) => {
    if (typeof criterion?.id !== "string" || typeof criterion?.text !== "string") {
      throw new ArkError(`${ticketFile}: acceptance_criteria[${i}] needs id and text`);
    }
    return criterion.id as string;
  });
  return {
    id: fields.id as string,
    title: fields.title as string,
    kind: kind as TicketKind,
    criteria: ids,
  };
}

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

/** Sets the first `status:` line of the ticket front matter. Changes no other byte. Returns false when there is no such line. */
function setTicketStatus(ticketFile: string, status: string): boolean {
  const text = readFileSync(ticketFile, "utf8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return false;
  const line = /^status:[^\r\n]*/m.exec(frontmatter[0]);
  if (!line) return false;
  const start = line.index + (frontmatter.index ?? 0);
  writeFileSync(
    ticketFile,
    text.slice(0, start) + `status: ${status}` + text.slice(start + line[0].length),
  );
  return true;
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
      ticket_file: absoluteTicketFile,
      round_budget: config.round_budget,
    });
  } catch (err) {
    rmSync(directory, { recursive: true, force: true });
    throw err;
  }
  warnSetTicketStatus(absoluteTicketFile, projectName, "in_progress");
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
  if (!refused(() => assertAllowed(state, "step.started", start))) return null;
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
  if (refused(() => assertAllowed(state, "gate.answered", answer))) return null;
  const answered = deriveState([
    ...events,
    {
      seq: events.length + 1,
      time: new Date(hubNow()).toISOString(),
      type: "gate.answered",
      data: answer,
    },
  ]);
  if (refused(() => assertAllowed(answered, "step.started", start))) return null;
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
  assertAllowed(state, "step.started", { step: stepId, role: "", repo: "", round: state.round });
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
  const status =
    outcome === "merged"
      ? "done"
      : outcome === "aborted" || outcome === "abandoned"
        ? "ready"
        : undefined;
  if (!status || !started?.ticket_file) return;
  warnSetTicketStatus(started.ticket_file, started.project, status);
}

export async function runClose(runId: string, outcome: string, inProject?: string): Promise<void> {
  const { project, directory } = findRun(runId, inProject);
  const events = readEvents(directory);
  if (outcome === "handed_off") {
    const state = deriveState(events);
    assertAllowed(state, "run.closed", { outcome });
    assertShippable(runId, project, directory, events, state);
  }
  const started = events.find((event) => event.type === "run.started");
  appendEvent(directory, "run.closed", { outcome });
  console.log(`${runId} closed: ${outcome}`);
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

export function waitingGate(state: RunState): string {
  if (state.phase === "awaiting_criteria") return "criteria";
  if (state.phase === "awaiting_strategy") return "strategy";
  if (state.phase === "planning" && state.plan?.valid) return "plan";
  if (state.phase === "escalation") return "escalation";
  return "none";
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

/** The `none` project's merge request line and one `branch` line for each worktree with commits beyond its base. */
function localOnlyLines(project: string, state: RunState): string[] {
  const workspace = loadConfig(project).workspace;
  const branches: string[] = [];
  for (const { repo, branch, base } of state.worktrees) {
    const ahead = commitsAhead(join(workspace, repo), branch, base);
    if (ahead)
      branches.push(
        `branch   ${repo}  ${branch}  ${ahead} commit(s) ahead of ${base?.slice(0, 8)}`,
      );
  }
  return ["merge requests: none (local only)", ...branches];
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
      ? localOnlyLines(project, state)
      : [
          `merge requests: ${state.merge_requests.length === 0 ? "none" : ""}`,
          ...state.merge_requests.map((request) => `  ${request.repo} ${request.url}`),
        ]),
    costLine(directory),
  ];
  console.log(lines.join("\n"));
}
