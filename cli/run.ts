import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { loadConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents, writeState, type RunState } from "./events.ts";
import { arkHome, findRun, listProjects, runsDirectory } from "./paths.ts";
import { runningCost } from "./retro.ts";
import { assertAllowed } from "./transitions.ts";
import { worktreeCleanup } from "./worktree.ts";

const runIdPattern = /^(\d{4}-\d{2}-\d{2})-(.+)-(\d+)$/;

function readTicket(ticketFile: string): { id: string; title: string; criteria: string[] } {
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
  const criteria = fields.acceptance_criteria ?? [];
  if (!Array.isArray(criteria))
    throw new ArkError(`${ticketFile}: acceptance_criteria must be a list`);
  const ids = criteria.map((criterion, i) => {
    if (typeof criterion?.id !== "string" || typeof criterion?.text !== "string") {
      throw new ArkError(`${ticketFile}: acceptance_criteria[${i}] needs id and text`);
    }
    return criterion.id as string;
  });
  return { id: fields.id as string, title: fields.title as string, criteria: ids };
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
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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
      criteria: ticket.criteria,
      ticket_file: absoluteTicketFile,
      round_budget: config.round_budget,
    });
  } catch (err) {
    rmSync(directory, { recursive: true, force: true });
    throw err;
  }
  console.log(run);
}

export function runStep(runId: string, stepId: string, action: string, failed = false): void {
  if (action !== "start" && action !== "finish")
    throw new ArkError(`unknown step action "${action}": use start or finish`);
  if (failed && action === "start") throw new ArkError("--failed only applies to finish");
  const { directory } = findRun(runId);
  const events = readEvents(directory);
  const state = deriveState(events);

  if (action === "finish") {
    const outcome = failed ? "failed" : "succeeded";
    appendEvent(directory, "step.finished", { step: stepId, outcome });
    console.log(`${runId} ${stepId} ${outcome}`);
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
    (event) => event.type === "step.finished" && event.data.step === stepId,
  ).length;
  const round = planned.role === "implementer" ? finishes + 1 : state.round;
  appendEvent(directory, "step.started", {
    step: stepId,
    role: planned.role,
    repo: planned.repo,
    round,
  });
  console.log(`${runId} ${stepId} started (round ${round}/${state.round_budget})`);
}

export function runClose(runId: string, outcome: string): void {
  const { directory } = findRun(runId);
  appendEvent(directory, "run.closed", { outcome });
  console.log(`${runId} closed: ${outcome}`);
  worktreeCleanup(runId);
}

export function waitingGate(state: RunState): string {
  if (state.phase === "awaiting_criteria") return "criteria";
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
  if (runId !== undefined) return printRun(runId);
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
      if (state.phase !== "closed")
        lines.push(`${name}  ${state.phase}  ${state.current_step ?? "-"}`);
    }
  }
  console.log(lines.length > 0 ? lines.join("\n") : "no open runs");
  if (invalidCount > 0) throw new ArkError(`${invalidCount} project config(s) invalid`);
}

function printRun(runId: string): void {
  const { directory } = findRun(runId);
  const state = writeState(directory);
  if (state.events === 0) throw new ArkError(`run ${runId} has no events`);
  const current = state.steps.find((step) => step.id === state.current_step);
  const lines = [
    `run: ${basename(directory)}`,
    `ticket: ${state.ticket.id} ${state.ticket.title}`,
    `phase: ${state.phase}${state.outcome ? ` (${state.outcome})` : ""}`,
    `round: ${state.round}/${state.round_budget}`,
    `current step: ${current ? `${current.id} (${current.status})` : "none"}`,
    `waiting gate: ${waitingGate(state)}`,
    `last test: ${state.last_test ? (state.last_test.passed ? "passed" : "failed") : "none"}`,
    `merge requests: ${state.merge_requests.length === 0 ? "none" : ""}`,
    ...state.merge_requests.map((request) => `  ${request.repo} ${request.url}`),
    costLine(directory),
  ];
  console.log(lines.join("\n"));
}
