/**
 * Reads the text of a project's `ROADMAP.md` against its tickets. Pure: no file, no clock. The
 * ticket shape is defined here, so this module imports nothing from `sources.ts`. The format is
 * in `docs/reference/roadmap.md`.
 */

import { isFinishedTicket } from "../cli/lifecycle.ts";

export type RoadmapTicket = {
  id: string;
  title: string | null;
  /** `proposed`, `ready`, `in_progress`, `done` or `superseded`. */
  status: string;
  milestone: string | null;
  depends_on: string[];
};

export type RoadmapItem = {
  id: string;
  title: string | null;
  status: string;
  milestone: string | null;
  /** Set only on a `proposed` ticket. */
  proposed?: true;
};

export type MilestoneState = "done" | "active" | "later";

export type RoadmapMilestone = {
  id: string;
  name: string;
  outcome: string;
  state: MilestoneState;
  done: number;
  superseded: number;
  open: number;
};

export type RoadmapWarning = {
  kind: "missing_ticket" | "unranked" | "rank_above_dependency" | "finished_listed";
  /** The ticket first, then for `rank_above_dependency` the unfinished dependency below it. */
  ids: string[];
  message: string;
};

export type Roadmap = {
  vision: string;
  milestones: RoadmapMilestone[];
  now: RoadmapItem[];
  next: RoadmapItem[];
  later: RoadmapItem[];
  unranked: RoadmapItem[];
  review: RoadmapItem[];
  /** The `done` and `superseded` tickets of each milestone, in roadmap order. */
  shipped: { milestone: string; tickets: RoadmapItem[] }[];
  warnings: RoadmapWarning[];
};

export type RoadmapError = { line: number; message: string };
export type RoadmapResult = { ok: true; roadmap: Roadmap } | { ok: false; errors: RoadmapError[] };

const states: readonly string[] = ["done", "active", "later"];
const horizons = ["now", "next", "later"] as const;
const toItem = (ticket: RoadmapTicket): RoadmapItem => ({
  id: ticket.id,
  title: ticket.title,
  status: ticket.status,
  milestone: ticket.milestone,
  ...(ticket.status === "proposed" ? { proposed: true as const } : {}),
});

type Line = { number: number; text: string };

export function readRoadmap(markdown: string, tickets: RoadmapTicket[]): RoadmapResult {
  const sections = new Map<string, Line[]>();
  let current: Line[] | null = null;
  markdown.split(/\r?\n/).forEach((text, index) => {
    const heading = text.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = [];
      sections.set(heading[1].toLowerCase(), current);
    } else current?.push({ number: index + 1, text });
  });

  const errors: RoadmapError[] = [];
  const vision = (sections.get("vision") ?? [])
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join(" ");
  if (!sections.has("vision") || vision === "")
    errors.push({ line: 1, message: "The file has no `## Vision` section with a paragraph." });

  const milestones: RoadmapMilestone[] = [];
  for (const line of sections.get("milestones") ?? []) {
    if (!line.text.trim().startsWith("|")) continue;
    const cells = line.text
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
    if (/^-+$/.test(cells[0].replace(/:/g, "")) || cells[0].toLowerCase() === "id") continue;
    const [id, name = "", outcome = "", state = ""] = cells;
    if (!states.includes(state)) {
      errors.push({
        line: line.number,
        message: `Milestone ${id} has state "${state}". Use done, active or later.`,
      });
      continue;
    }
    milestones.push({
      id,
      name,
      outcome,
      state: state as MilestoneState,
      done: 0,
      superseded: 0,
      open: 0,
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const warnings: RoadmapWarning[] = [];
  const lists = horizons.map((horizon) =>
    (sections.get(horizon) ?? []).flatMap((line) => {
      const id = line.text.match(/^\s*-\s+(\S+)/)?.[1];
      return id ? [id] : [];
    }),
  );
  const position = new Map<string, [number, number]>();
  lists.forEach((ids, horizon) =>
    ids.forEach((id, index) => position.has(id) || position.set(id, [horizon, index])),
  );

  for (const id of position.keys()) {
    const ticket = byId.get(id);
    if (!ticket)
      warnings.push({
        kind: "missing_ticket",
        ids: [id],
        message: `${id} is listed but has no ticket file.`,
      });
    else if (isFinishedTicket(ticket.status))
      warnings.push({
        kind: "finished_listed",
        ids: [id],
        message: `${id} is ${ticket.status} and still listed.`,
      });
  }

  const before = (a: [number, number], b: [number, number]) =>
    a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  for (const [id, place] of position) {
    const ticket = byId.get(id);
    if (!ticket || isFinishedTicket(ticket.status)) continue;
    for (const dependency of ticket.depends_on) {
      const target = byId.get(dependency);
      const targetPlace = position.get(dependency);
      if (target && !isFinishedTicket(target.status) && targetPlace && before(place, targetPlace))
        warnings.push({
          kind: "rank_above_dependency",
          ids: [id, dependency],
          message: `${id} is ranked above ${dependency}, which it depends on and which is not finished.`,
        });
    }
  }

  const horizon = (ids: string[]) =>
    ids.flatMap((id) => {
      const ticket = byId.get(id);
      return ticket && !isFinishedTicket(ticket.status) ? [toItem(ticket)] : [];
    });
  const open = tickets.filter((ticket) => !isFinishedTicket(ticket.status));
  const unranked = open.filter(
    (ticket) => ticket.status !== "proposed" && !position.has(ticket.id),
  );
  for (const ticket of unranked)
    warnings.push({
      kind: "unranked",
      ids: [ticket.id],
      message: `${ticket.id} is open and in no list.`,
    });

  const known = new Set(milestones.map((milestone) => milestone.id));
  const order = [
    ...milestones.map((milestone) => milestone.id),
    ...new Set(tickets.map((t) => t.milestone ?? "").filter((id) => !known.has(id))),
  ];
  for (const milestone of milestones)
    for (const ticket of tickets.filter((t) => t.milestone === milestone.id))
      if (ticket.status === "done") milestone.done++;
      else if (ticket.status === "superseded") milestone.superseded++;
      else milestone.open++;

  return {
    ok: true,
    roadmap: {
      vision,
      milestones,
      now: horizon(lists[0]),
      next: horizon(lists[1]),
      later: horizon(lists[2]),
      unranked: unranked.map(toItem),
      review: tickets.filter((ticket) => ticket.status === "proposed").map(toItem),
      shipped: order.flatMap((id) => {
        const finished = tickets.filter(
          (t) => (t.milestone ?? "") === id && isFinishedTicket(t.status),
        );
        return finished.length > 0 ? [{ milestone: id, tickets: finished.map(toItem) }] : [];
      }),
      warnings,
    },
  };
}
