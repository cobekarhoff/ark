// test ids: see RoadmapParts.tsx and RoadmapGraph.tsx; here: roadmap-page, roadmap-vision, view-list,
// view-graph, filter-text, milestone-filter, notes-link, roadmap-error (the message and line),
// roadmap-none (the line). No control here changes a ticket or a rank.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ticketEntries, ticketKey } from "./derive.ts";
import { Unknown, known } from "./format.tsx";
import { RoadmapGraph } from "./RoadmapGraph.tsx";
import {
  BrainstormCommand,
  Card,
  Icon,
  Notices,
  Rail,
  ReviewPanel,
  Row,
  Section,
  ShippedBar,
  type RoadmapData,
} from "./RoadmapParts.tsx";
import { useLive } from "./store.tsx";
import type { Roadmap as RoadmapModel, RoadmapItem } from "../roadmap.ts";
import type { Snapshot, TicketView } from "../types.ts";

/**
 * Selected IDs in dependency order: a ticket comes after every selected ticket it depends on,
 * directly or through unselected ones. Ties go to the smaller ID. A cycle falls back to ID order.
 */
export function dependencyOrder(selected: string[], tickets: TicketView[]): string[] {
  const needs = new Map(tickets.map((ticket) => [ticket.id, ticket.depends_on]));
  const chosen = new Set(selected);
  const before = new Map<string, Set<string>>();
  for (const id of chosen) {
    const found = new Set<string>();
    const seen = new Set<string>();
    const walk = (current: string) => {
      for (const need of needs.get(current) ?? []) {
        if (seen.has(need)) continue;
        seen.add(need);
        if (chosen.has(need)) found.add(need);
        walk(need);
      }
    };
    walk(id);
    found.delete(id);
    before.set(id, found);
  }
  const order: string[] = [];
  const left = [...chosen].sort();
  while (left.length > 0) {
    const index = Math.max(
      0,
      left.findIndex((id) => [...before.get(id)!].every((d) => order.includes(d))),
    );
    order.push(...left.splice(index, 1));
  }
  return order;
}

const horizons = [
  ["now", "Now", "Your top picks, in the order you ranked them"],
  ["next", "Next", "After Now"],
  ["later", "Later", "Not started on purpose"],
  ["unranked", "Unranked", "Open and approved, but in no list in ROADMAP.md"],
] as const;

const isFinished = (status: string) => status === "done" || status === "superseded";

/** What the page keeps while a ticket page is open, so Esc lands on the same row and scroll position. */
type Remembered = {
  scroll: number;
  cursor: string | null;
  text: string;
  milestone: string | null;
  view: "list" | "graph";
  project: string | null;
};
let remembered: Remembered | null = null;

/** A form field has the focus: its keys are text, not shortcuts. */
const isTyping = (target: EventTarget | null) =>
  (target instanceof HTMLInputElement && target.type !== "checkbox") ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement;

type Pick = { rank: number | null; item: RoadmapItem; horizon: string };

/** One project's roadmap against its tickets, narrowed by the search text and the milestone. */
function build(snapshot: Snapshot, project: string, needle: string, milestone: string | null) {
  if (!known(snapshot.tickets) || snapshot.roadmap === "unknown") return null;
  const tickets = snapshot.tickets.filter((ticket) => ticket.project === project);
  const entries = ticketEntries(snapshot);
  const open = tickets.filter((ticket) => !isFinished(ticket.status));
  const data: RoadmapData = {
    project,
    byId: new Map(tickets.map((ticket) => [ticket.id, ticket])),
    entries,
    runsOf: new Map(
      (known(snapshot.ticket_runs) ? snapshot.ticket_runs : []).map((entry) => [
        ticketKey(entry.project, entry.ticket),
        entry.all,
      ]),
    ),
    open,
  };
  const matches = (id: string, title: string | null, own: string | null) =>
    (milestone === null || (own ?? "") === milestone) &&
    (needle === "" ||
      [id, title ?? "", own ?? ""].some((field) => field.toLowerCase().includes(needle)));
  const roadmap = snapshot.roadmap[project];
  const ok = roadmap && "vision" in roadmap ? (roadmap as RoadmapModel) : null;

  // A finished ticket never shows in a horizon, even when ROADMAP.md still lists it.
  let rank = 0;
  const sections = ok
    ? horizons.map(([key, name, hint]) => ({
        name,
        hint,
        picks: ok[key]
          .filter((item) => !isFinished(item.status))
          .map((item): Pick => ({
            rank: key === "unranked" ? null : ++rank,
            item,
            horizon: key,
          }))
          .filter(({ item }) => matches(item.id, item.title, item.milestone)),
      }))
    : [];
  const review = (
    ok
      ? ok.review
      : tickets.filter((ticket) => ["proposed", "unreadable", "unknown"].includes(ticket.status))
  ).map((item) => ({ id: item.id, title: item.title, milestone: item.milestone }));

  // Graph: ranked tickets first, then the rest by id.
  const ranked = sections.flatMap((section) => section.picks.map((pick) => pick.item.id));
  const graphTickets = [
    ...ranked.map((id) => data.byId.get(id)!),
    ...open
      .filter((ticket) => !ranked.includes(ticket.id))
      .filter((ticket) => matches(ticket.id, ticket.title, ticket.milestone))
      .toSorted((a, b) => a.id.localeCompare(b.id)),
  ].filter((ticket, at, all) => all.indexOf(ticket) === at);
  return { data, roadmap, sections, review, graphTickets, tickets, ok };
}

export function Roadmap() {
  const { snapshot } = useLive();
  const [text, setText] = useState(() => remembered?.text ?? "");
  const [milestone, setMilestone] = useState<string | null>(() => remembered?.milestone ?? null);
  const [view, setView] = useState<"list" | "graph">(() => remembered?.view ?? "list");
  const [cursor, setCursor] = useState<string | null>(() => remembered?.cursor ?? null);
  const [chosen, setChosen] = useState<string | null>(() => remembered?.project ?? null);
  // The projects the header lists: those with tickets.
  const names =
    snapshot && known(snapshot.tickets)
      ? [...new Set(snapshot.tickets.map((ticket) => ticket.project))].sort()
      : [];
  const project = chosen !== null && names.includes(chosen) ? chosen : (names[0] ?? null);
  const needle = text.trim().toLowerCase();
  const model = useMemo(
    () => (snapshot && project !== null ? build(snapshot, project, needle, milestone) : null),
    [snapshot, project, needle, milestone],
  );

  const order = useMemo(() => {
    if (!model) return [];
    if (view === "list") return model.sections.flatMap((s) => s.picks.map((pick) => pick.item.id));
    const lanes = model.ok ? model.ok.milestones.map((entry) => entry.id) : [];
    const laneAt = (ticket: TicketView) => {
      const at = lanes.indexOf(ticket.milestone ?? "");
      return at === -1 ? lanes.length : at;
    };
    return model.graphTickets.toSorted((a, b) => laneAt(a) - laneAt(b)).map((ticket) => ticket.id);
  }, [model, view]);
  const current = cursor !== null && order.includes(cursor) ? cursor : (order[0] ?? null);

  const remember = (id: string | null = current) => {
    remembered = { scroll: window.scrollY, cursor: id, text, milestone, view, project };
  };

  // Back from a ticket page: the same scroll position, once the rows exist.
  const loaded = model !== null;
  useLayoutEffect(() => {
    if (!loaded || !remembered) return;
    window.scrollTo(0, remembered.scroll);
    remembered = null;
  }, [loaded]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const typing = isTyping(event.target);
      if (event.key === "Escape" && typing) {
        (event.target as HTMLElement).blur();
        return;
      }
      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('[data-testid="filter-text"]')?.focus();
        return;
      }
      if ((event.key === "j" || event.key === "k") && !typing) {
        event.preventDefault();
        const at = current === null ? -1 : order.indexOf(current);
        const next =
          order[Math.min(order.length - 1, Math.max(0, at + (event.key === "j" ? 1 : -1)))];
        if (next === undefined) return;
        setCursor(next);
        document
          .querySelector(
            `:is([data-testid="ticket-row"],[data-testid="graph-node"])[data-ticket="${CSS.escape(next)}"]`,
          )
          ?.scrollIntoView({ block: "nearest" });
        return;
      }
      // Enter on a link, button or textarea keeps its own action; anywhere else (the search field
      // included) it opens the selected ticket.
      const control =
        event.target instanceof HTMLElement ? event.target.closest("a, button") : null;
      const native =
        event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === "Enter" && current !== null && !control && !native) {
        event.preventDefault();
        remember();
        location.hash = `#/ticket/${encodeURIComponent(current)}`;
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (!snapshot || !known(snapshot.tickets) || !known(snapshot.roadmap))
    return (
      <>
        <h1>Roadmap</h1>
        <Unknown />
      </>
    );
  if (!model || project === null)
    return (
      <>
        <h1>Roadmap</h1>
        <p className="mut">No project has tickets yet.</p>
      </>
    );

  const { data, roadmap, sections, review, graphTickets, ok } = model;
  const prompt = `Evaluate ${dependencyOrder(
    review.map((item) => item.id),
    model.tickets,
  ).join(", ")}.`;
  const picked = ok?.milestones.find((entry) => entry.id === milestone);
  const shown = sections.reduce((sum, section) => sum + section.picks.length, 0);
  const onOpen = (id: string) => () => {
    setCursor(id);
    remember(id);
  };

  const toolbar = (
    <div className="rm-toolbar">
      <div className="seg big" role="group" aria-label="View">
        <button
          type="button"
          aria-pressed={view === "list"}
          data-testid="view-list"
          onClick={() => setView("list")}
        >
          <Icon name="list" />
          List
        </button>
        <button
          type="button"
          aria-pressed={view === "graph"}
          data-testid="view-graph"
          onClick={() => setView("graph")}
        >
          <Icon name="graph" />
          Graph
        </button>
      </div>
      <input
        type="search"
        name="q"
        autoComplete="off"
        spellCheck={false}
        aria-label="Search id or title"
        placeholder="Search id or title…"
        data-testid="filter-text"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <span className="rm-filter" data-testid="milestone-filter">
        {milestone === null ? (
          "All milestones"
        ) : (
          <>
            Milestone <b>{picked ? `${picked.id} ${picked.name}` : milestone}</b>
            <button
              type="button"
              aria-label="Show all milestones"
              onClick={() => setMilestone(null)}
            >
              <Icon name="x" />
              Clear
            </button>
          </>
        )}
      </span>
      <span className="rm-right">
        {ok && ok.warnings.length > 0 ? (
          <button
            type="button"
            className="rm-linkbtn"
            data-testid="notes-link"
            onClick={() =>
              document.getElementById("roadmap-notes")?.scrollIntoView({ block: "center" })
            }
          >
            {ok.warnings.length} {ok.warnings.length === 1 ? "note" : "notes"} on ROADMAP.md
          </button>
        ) : null}
        <BrainstormCommand />
      </span>
    </div>
  );

  const switcher =
    names.length > 1 ? (
      <div className="seg rm-projects" role="group" aria-label="Project">
        {names.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={name === project}
            onClick={() => {
              setChosen(name);
              setMilestone(null);
            }}
          >
            {name}
          </button>
        ))}
      </div>
    ) : null;

  if (roadmap && "none" in roadmap)
    return (
      <div className="rm-page solo" data-testid="roadmap-page">
        <h1 className="sr">Roadmap</h1>
        {switcher}
        <p className="rm-solo" data-testid="roadmap-none">
          {"This project's roadmap lives in "}
          {roadmap.none}.
        </p>
        <BrainstormCommand />
      </div>
    );

  return (
    <div className={`rm-page${ok ? "" : " solo"}`} data-testid="roadmap-page">
      <h1 className="sr">Roadmap</h1>
      {switcher}
      {ok ? (
        <Rail
          milestones={ok.milestones}
          selected={milestone}
          onSelect={setMilestone}
          openCount={data.open.length}
        />
      ) : null}
      <div className="rm-main">
        {ok ? (
          <p className="rm-vision" data-testid="roadmap-vision">
            {ok.vision}
          </p>
        ) : null}
        {toolbar}
        {ok && view === "graph" ? (
          <>
            <ReviewPanel items={review} prompt={prompt} bar />
            <div className="rm-legend">
              <span>
                <svg viewBox="0 0 28 8" aria-hidden="true">
                  <path d="M0 4h28" className="rm-edge finished" />
                </svg>
                Dependency finished
              </span>
              <span>
                <svg viewBox="0 0 28 8" aria-hidden="true">
                  <path d="M0 4h28" className="rm-edge open" />
                </svg>
                Dependency still open, blocks the ticket
              </span>
              <span>
                <i className="rm-swatch" />
                Proposed
              </span>
              <span className="rm-legend-end">
                {graphTickets.length} open tickets · arrows run from a ticket to what it unblocks
              </span>
            </div>
            {graphTickets.length === 0 ? (
              <p className="rm-empty">No open ticket matches.</p>
            ) : (
              <RoadmapGraph
                tickets={graphTickets}
                milestones={ok?.milestones ?? []}
                data={data}
                cursor={current}
                onOpen={(id) => onOpen(id)()}
              />
            )}
          </>
        ) : (
          <div className="rm-layout">
            <div className="rm-lists">
              {ok ? (
                <>
                  {sections.map((section) => (
                    <Section
                      key={section.name}
                      name={section.name}
                      hint={section.hint}
                      count={section.picks.length}
                    >
                      {section.picks.length === 0 ? (
                        <p className="rm-empty">Nothing here.</p>
                      ) : section.name === "Now" ? (
                        <div className="rm-grid-now">
                          {section.picks.map((pick) => (
                            <Card
                              key={pick.item.id}
                              pick={pick}
                              data={data}
                              current={pick.item.id === current}
                              onOpen={onOpen(pick.item.id)}
                              onHover={() => setCursor(pick.item.id)}
                            />
                          ))}
                        </div>
                      ) : (
                        <ul className="rm-rows">
                          {section.picks.map((pick) => (
                            <Row
                              key={pick.item.id}
                              pick={pick}
                              data={data}
                              current={pick.item.id === current}
                              onOpen={onOpen(pick.item.id)}
                              onHover={() => setCursor(pick.item.id)}
                            />
                          ))}
                        </ul>
                      )}
                    </Section>
                  ))}
                  {shown === 0 ? <p className="rm-empty">No ticket matches.</p> : null}
                </>
              ) : (
                <p className="rm-error" role="alert" data-testid="roadmap-error">
                  ROADMAP.md does not read. {(roadmap as { error: string }).error}
                </p>
              )}
            </div>
            <ReviewPanel items={review} prompt={prompt} bar={false} />
          </div>
        )}
        {ok ? <Notices warnings={ok.warnings} /> : null}
      </div>
      {ok ? <ShippedBar shipped={ok.shipped} milestones={ok.milestones} /> : null}
    </div>
  );
}
