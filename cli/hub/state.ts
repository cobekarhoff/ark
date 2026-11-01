import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import type { RunState } from "../events.ts";
import { arkHome, listProjects } from "../paths.ts";
import { runningCost } from "../retro.ts";
import { buildDetail, type RunDetail } from "./detail.ts";
import { collectHistory } from "./history.ts";
import { arkItems, readRuns, type RunInfo } from "./ark.ts";
import { readNotifications } from "./notify.ts";
import { emptyOrca, orcaItems, readOrca, type OrcaSnapshot } from "./orca.ts";
import {
  emptyPlannotator,
  plannotatorItems,
  readPlannotator,
  type PlannotatorSnapshot,
} from "./plannotator.ts";
import type { Agent } from "./types.ts";

type Cost = { usd: number | "unknown"; tokens: number };
type ChiefState =
  | { state: "live"; handle: string; harness: string | null; model: string | null }
  | { state: "missing" }
  | { state: "unknown" };

const lastSeenFile = () => join(arkHome(), "hub.json");

/** When the human last looked at the hub, or null before the first visit. */
export function readLastSeen(): string | null {
  try {
    return JSON.parse(readFileSync(lastSeenFile(), "utf8")).last_seen ?? null;
  } catch {
    return null;
  }
}

export function markSeen(): void {
  writeFileSync(lastSeenFile(), JSON.stringify({ last_seen: new Date().toISOString() }));
}

const criterionLabel = (id: string, ticket: string) =>
  id.startsWith(`${ticket}-`) ? id.slice(ticket.length + 1) : id;

/** One sentence about the run, as in "ARK-170 is building: 2 of 4 steps done, AC4 failing". */
function storyLine(state: RunState): string {
  const ticket = state.ticket.id;
  const done = state.steps.filter((step) => step.status === "succeeded").length;
  const failing = state.criteria
    .filter((criterion) => criterion.status === "failing")
    .map((criterion) => criterionLabel(criterion.id, ticket));
  switch (state.phase) {
    case "awaiting_criteria":
      return `${ticket} waits for you to accept its criteria`;
    case "planning":
      return state.plan?.valid
        ? `${ticket} waits for you to approve its plan`
        : `${ticket} is planning: the plan is not valid yet`;
    case "escalation":
      return `${ticket} is stuck: round ${state.round} of ${state.round_budget} spent${failing.length ? `, ${failing.join(", ")} failing` : ""}`;
    case "merge_requests_open":
      return `${ticket} has ${state.merge_requests.length} MR${state.merge_requests.length === 1 ? "" : "s"} open`;
    case "closed":
      return `${ticket} closed: ${state.outcome}`;
    default:
      return `${ticket} is building: ${done} of ${state.steps.length} steps done${failing.length ? `, ${failing.join(", ")} failing` : ""}`;
  }
}

/** The repo name for an MR label. The repo `.` is the workspace root, so it gets the workspace folder name. */
function repoName(project: string, repo: string): string {
  if (repo !== ".") return basename(repo);
  try {
    return basename(resolve(loadConfig(project).workspace));
  } catch {
    return project;
  }
}

function digestOf(runs: RunInfo[], waiting: number, lastSeen: string | null): string {
  const since = lastSeen === null ? 0 : Date.parse(lastSeen);
  const events = runs
    .flatMap((run) => run.events)
    .filter((event) => Date.parse(event.time) > since);
  const count = (matches: (type: string, outcome?: string) => boolean) =>
    events.filter((event) => matches(event.type, event.data.outcome)).length;
  const parts = [
    `steps finished: ${count((type, outcome) => type === "step.finished" && outcome === "succeeded")}`,
    `MRs opened: ${count((type) => type === "merge_request.opened")}`,
    `runs closed: ${count((type) => type === "run.closed")}`,
  ].filter((part) => !part.endsWith(": 0"));
  const waits = `items waiting for you: ${waiting}`;
  const away = lastSeen === null ? "Welcome" : `Since ${new Date(lastSeen).toLocaleTimeString()}`;
  return `${away}, ${[...parts, waits].join("; ")}.`;
}

/**
 * The hub's data. `state()` reads Ark's files fresh and is cheap, so a change in `events.ndjson`
 * shows at once. `refresh()` reads Orca and Plannotator, each call with a hard timeout, and keeps
 * the last answer; a slow or failing reader never blocks `state()`.
 */
export function createHub() {
  let orca: OrcaSnapshot = emptyOrca;
  let plannotator: PlannotatorSnapshot = emptyPlannotator;
  const costs = new Map<string, Cost>();
  /** Detail of each open run, rebuilt by `refresh()`: it reads agent terminals, so `state()` cannot. */
  let details: Record<string, RunDetail> = {};
  const firstSeen = new Map<string, string>();

  const chiefOf = (project: string, workspace: string | null): ChiefState => {
    if (!orca.ok || orca.terminals === null || workspace === null) return { state: "unknown" };
    const terminal = orca.terminals.find(
      (candidate) =>
        candidate.connected &&
        candidate.worktreePath !== undefined &&
        resolve(candidate.worktreePath) === workspace &&
        !orca.coordinatorHandles.has(candidate.handle),
    );
    return terminal
      ? {
          state: "live",
          handle: terminal.handle,
          harness: terminal.agentIdentity ?? null,
          model: terminal.model ?? null,
        }
      : { state: "missing" };
  };

  const workspaceOf = (project: string): string | null => {
    try {
      return resolve(loadConfig(project).workspace);
    } catch {
      return null;
    }
  };

  return {
    async refresh(): Promise<void> {
      const runs = readRuns();
      const openRuns = runs
        .filter(({ state }) => state.phase !== "closed")
        .map(({ state }) => ({ run: state.run, project: state.project }));
      const projects = listProjects().flatMap((name) => {
        const workspace = workspaceOf(name);
        return workspace ? [{ name, workspace }] : [];
      });
      [orca, plannotator] = await Promise.all([readOrca(openRuns), readPlannotator(projects)]);
      await collectHistory(runs, orca.agents);
      const today = new Date().toDateString();
      const built: Record<string, RunDetail> = {};
      await Promise.all(
        runs
          .filter(({ state }) => state.phase !== "closed")
          .map(async (run) => {
            built[run.state.run] = await buildDetail(run, orca.agents.get(run.state.run));
          }),
      );
      details = built;
      for (const { directory, state, events } of runs) {
        if (built[state.run]) {
          costs.set(state.run, built[state.run].cost);
          continue;
        }
        const active =
          state.phase !== "closed" ||
          new Date(events[events.length - 1].time).toDateString() === today;
        if (!active) continue;
        try {
          costs.set(state.run, runningCost(directory));
        } catch {
          costs.set(state.run, { usd: "unknown", tokens: 0 });
        }
      }
    },

    /** Fresh detail of any run, or null when no run has that id. */
    async detail(run: string): Promise<RunDetail | null> {
      const info = readRuns().find(({ state }) => state.run === run);
      return info ? buildDetail(info, orca.agents.get(run)) : null;
    },

    state() {
      const now = new Date().toISOString();
      const runs = readRuns();
      const projects = listProjects().map((name) => ({
        name,
        chief: chiefOf(name, workspaceOf(name)),
      }));
      const chiefHandle = (project: string) => {
        const chief = projects.find((candidate) => candidate.name === project)?.chief;
        return chief?.state === "live" ? chief.handle : null;
      };
      const agents: Agent[] = runs.flatMap(({ state }) => orca.agents.get(state.run) ?? []);
      const ticketOf = (run: string) =>
        runs.find(({ state }) => state.run === run)?.state.ticket.id ?? null;
      const since = (id: string) => {
        if (!firstSeen.has(id)) firstSeen.set(id, now);
        return firstSeen.get(id)!;
      };
      const needsMe = [
        ...arkItems(runs, plannotator.sessions, chiefHandle),
        ...plannotatorItems(plannotator),
        ...orcaItems(agents, ticketOf, since),
      ].sort(
        (left, right) =>
          Date.parse(left.since) - Date.parse(right.since) || left.id.localeCompare(right.id),
      );

      const today = new Date().toDateString();
      const runViews = runs.map(({ state, events }) => {
        const criteria = state.criteria.map((criterion) => criterion.status);
        const open = state.phase !== "closed";
        return {
          run: state.run,
          project: state.project,
          ticket: state.ticket,
          open,
          phase: state.phase,
          round: state.round,
          round_budget: state.round_budget,
          steps: state.steps,
          gates: state.gates,
          criteria: state.criteria,
          ac: {
            passing: criteria.filter((status) => status === "passing").length,
            failing: criteria.filter((status) => status === "failing").length,
            total: criteria.length,
          },
          cost: costs.get(state.run) ?? { usd: "unknown" as const, tokens: 0 },
          story: storyLine(state),
          merge_requests: state.merge_requests.map((mergeRequest) => ({
            ...mergeRequest,
            label: `${repoName(state.project, mergeRequest.repo)} #${mergeRequest.number}`,
          })),
          last_event: events[events.length - 1].time,
          agents: orca.agents.get(state.run) ?? [],
          agents_known: orca.agents.has(state.run),
        };
      });
      const costToday = runs
        .filter(({ events }) => new Date(events[events.length - 1].time).toDateString() === today)
        .map(({ state }) => costs.get(state.run)?.usd ?? "unknown");
      const lastSeen = readLastSeen();
      return {
        projects,
        runs: runViews,
        needs_me: needsMe,
        agents,
        readers: {
          orca: orca.ok ? "ok" : "unknown",
          plannotator: plannotator.sessions === null ? "unknown" : "ok",
        },
        tiles: {
          agents_working: agents.filter((agent) => agent.liveness === "live").length,
          gates_waiting: needsMe.filter((item) => item.kind === "gate").length,
          cost_today: costToday.includes("unknown")
            ? "unknown"
            : costToday.reduce((sum: number, usd) => sum + (usd as number), 0),
          live_runs: runViews.filter((run) => run.open).length,
        },
        notifications: readNotifications(),
        details,
        last_seen: lastSeen,
        digest: digestOf(runs, needsMe.length, lastSeen),
      };
    },
  };
}

/** Known MR URLs, the only URLs the `open-url` action opens. */
export const knownUrls = (state: { runs: { merge_requests: { url: string }[] }[] }): Set<string> =>
  new Set(state.runs.flatMap((run) => run.merge_requests.map((mergeRequest) => mergeRequest.url)));
