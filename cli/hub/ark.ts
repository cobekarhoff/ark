import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deriveState, readEvents, type ArkEvent, type RunState } from "../events.ts";
import { listProjects, projectDirectory, runsDirectory } from "../paths.ts";
import { waitingGate } from "../run.ts";
import type { PlannotatorSession } from "./plannotator.ts";
import type { Action, Item } from "./types.ts";

/** A closed run stays in the hub this long after its last event. */
const closedRunDays = 7;

export type RunInfo = { directory: string; state: RunState; events: ArkEvent[] };

/** Every run of every project that has events, newest first. Closed runs older than a week are left out. */
export function readRuns(now = Date.now()): RunInfo[] {
  const runs: RunInfo[] = [];
  for (const project of listProjects()) {
    const runsRoot = runsDirectory(project);
    if (!existsSync(runsRoot)) continue;
    for (const name of readdirSync(runsRoot)) {
      const directory = join(runsRoot, name);
      const events = readEvents(directory);
      if (events.length === 0) continue;
      const state = deriveState(events);
      const age = now - Date.parse(events[events.length - 1].time);
      if (state.phase === "closed" && age > closedRunDays * 86_400_000) continue;
      runs.push({ directory, state, events });
    }
  }
  return runs.sort((left, right) => right.state.run.localeCompare(left.state.run));
}

/** A closed run whose `retro.md` Close check lacks a non-empty answer to any of the three questions. */
function retroUnanswered(directory: string): boolean {
  try {
    const closeCheck = readFileSync(join(directory, "retro.md"), "utf8").split(
      /^## Close check\s*$/m,
    )[1];
    if (closeCheck === undefined) return false;
    return !["Biggest pain", "Change now", "Surprise"].every((label) =>
      new RegExp(`^- ${label}:[ \\t]*\\S`, "m").test(closeCheck),
    );
  } catch {
    return false;
  }
}

function proposedTickets(project: string): { id: string; title: string; since: string }[] {
  const ticketsRoot = join(projectDirectory(project), "tickets");
  if (!existsSync(ticketsRoot)) return [];
  const found = [];
  for (const name of readdirSync(ticketsRoot)) {
    if (!name.endsWith(".md")) continue;
    const file = join(ticketsRoot, name);
    try {
      const frontmatter = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const fields = frontmatter ? (Bun.YAML.parse(frontmatter[1]) as Record<string, unknown>) : {};
      if (fields?.status === "proposed")
        found.push({
          id: String(fields.id),
          title: String(fields.title),
          since: statSync(file).mtime.toISOString(),
        });
    } catch {
      // A ticket file that does not parse cannot wait for the human.
    }
  }
  return found;
}

const lastTime = (events: ArkEvent[], matches: (event: ArkEvent) => boolean): string =>
  (events.findLast(matches) ?? events[events.length - 1]).time;

/** Items from Ark's own files: waiting gates, ready MRs, proposed tickets and unanswered retros. */
export function arkItems(
  runs: RunInfo[],
  sessions: PlannotatorSession[] | null,
  chiefHandle: (project: string) => string | null,
): Item[] {
  const items: Item[] = [];
  const annotate = (path: string, params: Record<string, unknown>): Action => {
    const session = (sessions ?? []).find((candidate) => candidate.target === path);
    return session
      ? { name: "plannotator-session", label: "Open review", params: { index: session.index } }
      : { name: "plannotator-annotate", label: "Review", params };
  };
  for (const { directory, state, events } of runs) {
    const base = { source: "ark", project: state.project, ticket: state.ticket.id } as const;
    const gate = waitingGate(state);
    if (gate !== "none") {
      const handle = chiefHandle(state.project);
      items.push({
        ...base,
        id: `gate:${state.run}:${gate}`,
        kind: "gate",
        title: `${gate} gate: ${state.ticket.title}`,
        since: lastTime(events, (event) =>
          gate === "criteria"
            ? event.type === "run.started"
            : gate === "plan"
              ? event.type === "plan.checked"
              : gate === "strategy"
                ? event.type === "strategy.recorded"
                : event.type === "step.finished",
        ),
        action:
          gate === "plan" || gate === "strategy"
            ? annotate(join(directory, gate === "plan" ? "plan.md" : "strategies.md"), {
                kind: gate,
                run: state.run,
              })
            : handle
              ? {
                  name: "orca-terminal-switch",
                  label: "Answer in Master Chief",
                  params: { handle },
                }
              : null,
      });
    }
    const reviewed = state.steps.some(
      (step) => step.role === "reviewer" && step.status === "succeeded",
    );
    if (state.phase === "merge_requests_open" && state.last_test?.passed && reviewed) {
      items.push({
        ...base,
        id: `mr:${state.run}`,
        kind: "mr",
        title: `Merge ${state.merge_requests.map((mergeRequest) => `#${mergeRequest.number}`).join(", ")}: ${state.ticket.title}`,
        since: lastTime(events, (event) => event.type === "merge_request.opened"),
        action: {
          name: "open-url",
          label: "Open MR",
          params: { url: state.merge_requests[0].url },
        },
      });
    }
    if (state.phase === "closed" && retroUnanswered(directory)) {
      items.push({
        ...base,
        id: `retro:${state.run}`,
        kind: "retro",
        title: `Retro close check: ${state.ticket.title}`,
        since: statSync(join(directory, "retro.md")).mtime.toISOString(),
        action: annotate(join(directory, "retro.md"), { kind: "retro", run: state.run }),
      });
    }
  }
  for (const project of listProjects()) {
    for (const ticket of proposedTickets(project)) {
      items.push({
        id: `ticket:${project}:${ticket.id}`,
        kind: "ticket",
        source: "ark",
        project,
        ticket: ticket.id,
        title: `Proposed ticket: ${ticket.title}`,
        since: ticket.since,
        action: annotate(join(projectDirectory(project), "tickets", `${ticket.id}.md`), {
          kind: "ticket",
          project,
          ticket: ticket.id,
        }),
      });
    }
  }
  return items;
}
