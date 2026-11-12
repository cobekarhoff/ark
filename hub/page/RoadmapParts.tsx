import { useEffect, useState, type ReactNode } from "react";
import type { TicketEntry } from "./derive.ts";

import { phaseLabel } from "./format.tsx";
import { Markdown } from "./Markdown.tsx";
import { runHref } from "./RunDetail.tsx";
import { ticketHref } from "./store.tsx";
import type { RoadmapItem, RoadmapMilestone, RoadmapWarning } from "../roadmap.ts";
import type { TicketRunView, TicketView } from "../types.ts";
import { isFinishedTicket } from "../../cli/lifecycle.ts";

export type RoadmapData = {
  byId: Map<string, TicketView>;
  entries: Map<string, TicketEntry>;
  runsOf: Map<string, TicketRunView["all"]>;
  /** Open tickets of the project (not done, not superseded). */
  open: TicketView[];
  project: string;
};

export const entryOf = (data: RoadmapData, id: string) =>
  data.entries.get(`${data.project}/${id}`) as TicketEntry;

/** Dependencies that are not finished, then the open tickets that wait on this one. */
export const relationsOf = (data: RoadmapData, id: string) => ({
  blockedBy: (data.byId.get(id)?.depends_on ?? []).filter(
    (need) => !isFinishedTicket(data.byId.get(need)?.status),
  ),
  unblocks: data.open.filter((other) => other.depends_on.includes(id)).map((other) => other.id),
});

/** `why` texts carry `code` spans. */
export function Why({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`]+`)/)
        .map((part, at) =>
          part.startsWith("`") && part.length > 1 ? (
            <code key={at}>{part.slice(1, -1)}</code>
          ) : (
            part
          ),
        )}
    </>
  );
}

export function Icon({ name }: { name: "chevron" | "copy" | "list" | "graph" | "x" | "info" }) {
  const paths = {
    chevron: <path d="M6 3.5 10.5 8 6 12.5" />,
    copy: (
      <>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
      </>
    ),
    list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.1M2.5 8h.1M2.5 12h.1" />,
    graph: (
      <>
        <circle cx="3.5" cy="4" r="1.7" />
        <circle cx="3.5" cy="12" r="1.7" />
        <circle cx="12.5" cy="8" r="1.7" />
        <path d="M5 4.6c3 0 4 1.6 6 3M5 11.4c3 0 4-1.6 6-3" />
      </>
    ),
    x: <path d="m4 4 8 8M12 4l-8 8" />,
    info: <path d="M8 7.2V11M8 5v.1M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z" />,
  };
  return (
    <svg className="rm-icon" viewBox="0 0 16 16" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

/** The run phase while a run is open, the derived queue state for a ready ticket, else the ticket status. */
export function StatusChip({ entry }: { entry: TicketEntry }) {
  const { status } = entry.ticket;
  const showState = status === "ready" && !entry.open;
  const label = entry.open
    ? phaseLabel(entry.open.phase)
    : showState
      ? entry.state
      : status.replaceAll("_", " ");
  const tone = entry.open
    ? entry.tone.replace("p-", "")
    : status === "proposed"
      ? "proposed"
      : showState
        ? entry.state === "queued"
          ? "ready"
          : entry.state === "approved, not queued"
            ? "proposed"
            : "none"
        : status === "in_progress"
          ? "build"
          : "none";
  return (
    <span className={`rm-chip ${tone}`} data-testid="status-chip">
      {status === "proposed" && !entry.open ? "proposed" : label}
    </span>
  );
}

export const MilestoneChip = ({ id }: { id: string | null }) =>
  id ? (
    <span className="rm-chip outline mono" data-testid="milestone-chip">
      {id}
    </span>
  ) : null;

function IdLinks({ ids, data, testId }: { ids: string[]; data: RoadmapData; testId: string }) {
  return (
    <>
      {ids.map((id) =>
        data.byId.has(id) ? (
          <a key={id} className="rm-id" href={ticketHref(id)} data-testid={testId}>
            {id}
          </a>
        ) : (
          <span key={id} className="rm-id" data-testid={testId}>
            {id}
          </span>
        ),
      )}
    </>
  );
}

export function Relation({
  label,
  ids,
  data,
  testId,
}: {
  label: string;
  ids: string[];
  data: RoadmapData;
  testId: string;
}) {
  if (ids.length === 0) return null;
  return (
    <span className="rm-rel">
      <span className="rm-rel-label">{label}</span>
      <IdLinks ids={ids} data={data} testId={testId} />
    </span>
  );
}

export function RunLinks({ id, data }: { id: string; data: RoadmapData }) {
  const runs = data.runsOf.get(`${data.project}/${id}`) ?? [];
  return (
    <>
      {runs.map((run) => (
        <a
          key={run.run}
          className="rm-run mono"
          href={runHref(run.run)}
          data-testid="ticket-run"
          data-run={run.run}
          title={`${run.run}: ${phaseLabel(run.phase)}`}
        >
          {run.run}
        </a>
      ))}
    </>
  );
}

type Pick = { rank: number | null; item: RoadmapItem; horizon: string };

export function Card({
  pick,
  data,
  current,
  onOpen,
  onHover,
}: {
  pick: Pick;
  data: RoadmapData;
  current: boolean;
  onOpen: () => void;
  onHover: () => void;
}) {
  const { item } = pick;
  const entry = entryOf(data, item.id);
  const { blockedBy, unblocks } = relationsOf(data, item.id);
  return (
    <article
      className={`rm-card${item.proposed ? " proposed" : ""}`}
      data-testid="ticket-row"
      data-ticket={item.id}
      data-horizon={pick.horizon}
      aria-current={current ? "true" : undefined}
      onMouseEnter={onHover}
    >
      <div className="rm-card-top">
        <span className="rm-rank" data-testid="rank">
          {pick.rank}
        </span>
        <b className="mono">{item.id}</b>
        <MilestoneChip id={item.milestone} />
        <span className="rm-push" />
        <StatusChip entry={entry} />
      </div>
      <h3 className="rm-card-title">
        <a href={ticketHref(item.id)} data-testid="ticket-link" onClick={onOpen}>
          {item.title ?? item.id}
        </a>
      </h3>
      {entry.ticket.why ? (
        <p className="rm-why clamp3">
          <Why text={entry.ticket.why} />
        </p>
      ) : null}
      <div className="rm-rels">
        <Relation label="Blocked by" ids={blockedBy} data={data} testId="blocked-by" />
        <Relation label="Unblocks" ids={unblocks} data={data} testId="unblocks" />
        <span className="rm-rel">
          <RunLinks id={item.id} data={data} />
        </span>
      </div>
    </article>
  );
}

export function Row({
  pick,
  data,
  current,
  onOpen,
  onHover,
}: {
  pick: Pick;
  data: RoadmapData;
  current: boolean;
  onOpen: () => void;
  onHover: () => void;
}) {
  const { item } = pick;
  const entry = entryOf(data, item.id);
  const { blockedBy, unblocks } = relationsOf(data, item.id);
  return (
    <li
      className={`rm-row${item.proposed ? " proposed" : ""}`}
      data-testid="ticket-row"
      data-ticket={item.id}
      data-horizon={pick.horizon}
      aria-current={current ? "true" : undefined}
      onMouseEnter={onHover}
    >
      <span className={pick.rank === null ? "rm-rk none" : "rm-rk"} data-testid="rank">
        {pick.rank ?? "·"}
      </span>
      <b className="mono rm-rid">{item.id}</b>
      <StatusChip entry={entry} />
      <div className="rm-main">
        <div className="rm-line">
          <a
            className="rm-rtitle"
            href={ticketHref(item.id)}
            data-testid="ticket-link"
            onClick={onOpen}
          >
            {item.title ?? item.id}
          </a>
          <span className="rm-rrels">
            <Relation label="Blocked by" ids={blockedBy} data={data} testId="blocked-by" />
            <Relation label="Unblocks" ids={unblocks} data={data} testId="unblocks" />
            <MilestoneChip id={item.milestone} />
          </span>
        </div>
        <div className="rm-line">
          <span className="rm-rwhy">
            {entry.ticket.why ? <Why text={entry.ticket.why} /> : null}
          </span>
          <span className="rm-rrels">
            <RunLinks id={item.id} data={data} />
          </span>
        </div>
      </div>
    </li>
  );
}

export function Section({
  name,
  hint,
  children,
  count,
}: {
  name: string;
  hint: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section
      className={`rm-sec ${name.toLowerCase()}`}
      data-testid="roadmap-section"
      data-section={name}
    >
      <div className="rm-sec-head">
        <h2>{name}</h2>
        <span className="rm-count">{count}</span>
        <span className="rm-hint">{hint}</span>
      </div>
      {children}
    </section>
  );
}

/** Copies a text; the label below says whether the browser let it. */
export function useCopy() {
  const [message, setMessage] = useState("");
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Copied");
    } catch {
      setMessage("Copy failed: select the text");
    }
  };
  return { message, copy };
}

export function ReviewPanel({
  items,
  prompt,
  bar,
}: {
  items: { id: string; title: string | null; milestone: string | null }[];
  prompt: string;
  /** The Graph view shows the review as one bar: the graph needs the width. */
  bar: boolean;
}) {
  const { message, copy } = useCopy();
  const button = (
    <button
      type="button"
      className="btn primary rm-copy"
      data-testid="copy-button"
      disabled={items.length === 0}
      onClick={() => copy(prompt)}
    >
      <Icon name="copy" />
      Copy prompt for Master Chief
    </button>
  );
  const text =
    "Master Chief evaluates these tickets and you approve them. Nothing is queued until you do.";
  return (
    <aside
      className={bar ? "rm-review bar" : "rm-review"}
      data-testid="review"
      aria-label="Needs your review"
    >
      <div className="rm-review-head">
        <div className="rm-review-top">
          <h2>Needs your review</h2>
          <span className="rm-count" data-testid="review-count">
            {items.length}
          </span>
          {bar ? <p>{text}</p> : null}
          {bar ? button : null}
        </div>
        {bar ? null : <p>{text}</p>}
        {bar ? null : button}
        <span className="sr" aria-live="polite" data-testid="copy-status">
          {message}
        </span>
      </div>
      {bar ? null : (
        <ul className="rm-review-list">
          {items.map((item) => (
            <li key={item.id}>
              <a
                className="rm-rv"
                href={ticketHref(item.id)}
                data-testid="review-item"
                data-ticket={item.id}
                title={item.title ?? item.id}
              >
                <span className="rm-rv-top">
                  <b className="mono">{item.id}</b>
                  <MilestoneChip id={item.milestone} />
                </span>
                <span className="rm-rvt">{item.title ?? item.id}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {bar || items.length > 0 ? null : (
        <p className="rm-review-empty">Nothing is waiting for you.</p>
      )}
    </aside>
  );
}

export function BrainstormCommand() {
  const { message, copy } = useCopy();
  return (
    <span className="rm-add">
      Add an idea:
      <button
        type="button"
        className="rm-cmd"
        data-testid="copy-command"
        aria-label="Copy /ark brainstorm"
        onClick={() => copy("/ark brainstorm")}
      >
        /ark brainstorm
        <Icon name="copy" />
      </button>
      <span className="sr" aria-live="polite">
        {message}
      </span>
    </span>
  );
}

const rangeOf = (milestones: RoadmapMilestone[]) =>
  milestones.length === 1
    ? milestones[0].id
    : `${milestones[0].id}–${milestones[milestones.length - 1].id}`;

export function Rail({
  milestones,
  selected,
  onSelect,
  openCount,
  shipped,
}: {
  milestones: RoadmapMilestone[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  openCount: number;
  shipped: number;
}) {
  const [folded, setFolded] = useState(false);
  const done = milestones.filter((milestone) => milestone.state === "done");
  const doneTickets = done.reduce((sum, milestone) => sum + milestone.done, 0);
  const pick = (id: string) => onSelect(selected === id ? null : id);
  return (
    <nav className="rm-rail" aria-label="Milestones" data-testid="milestone-rail">
      <div className="rm-rail-head">
        <h2>Milestones</h2>
        <span>in order</span>
      </div>
      <button
        type="button"
        className="rm-all"
        aria-pressed={selected === null}
        data-testid="milestone-all"
        onClick={() => onSelect(null)}
      >
        All milestones
        <span className="mono">
          {openCount} open · {shipped} shipped
        </span>
      </button>
      {done.length > 0 ? (
        <div className="rm-fold">
          <button
            type="button"
            className={`rm-foldbtn${selected !== null && done.some((m) => m.id === selected) ? " has-filter" : ""}`}
            aria-expanded={folded}
            data-testid="done-fold"
            onClick={() => setFolded(!folded)}
          >
            <Icon name="chevron" />
            <b>{rangeOf(done)}</b>
            <span>
              {done.length} {done.length === 1 ? "milestone" : "milestones"} · {doneTickets} done
            </span>
          </button>
          {folded ? (
            <ul className="rm-ms-list">
              {done.map((milestone) => (
                <MilestonePick
                  key={milestone.id}
                  milestone={milestone}
                  pressed={selected === milestone.id}
                  onPick={() => pick(milestone.id)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <ul className="rm-ms-list">
        {milestones
          .filter((milestone) => milestone.state !== "done")
          .map((milestone) => (
            <MilestonePick
              key={milestone.id}
              milestone={milestone}
              pressed={selected === milestone.id}
              onPick={() => pick(milestone.id)}
            />
          ))}
      </ul>
    </nav>
  );
}

function MilestonePick({
  milestone,
  pressed,
  onPick,
}: {
  milestone: RoadmapMilestone;
  pressed: boolean;
  onPick: () => void;
}) {
  const total = milestone.done + milestone.open;
  return (
    <li className={`rm-ms ${milestone.state}`}>
      <button
        type="button"
        className="rm-ms-pick"
        aria-pressed={pressed}
        data-testid="milestone-pick"
        data-milestone={milestone.id}
        data-state={milestone.state}
        onClick={onPick}
      >
        <span className="rm-ms-head">
          <span className="rm-ms-id mono">{milestone.id}</span>
          <span className="rm-ms-name">{milestone.name}</span>
          {milestone.state === "done" ? null : (
            <span className={`rm-chip ${milestone.state === "active" ? "blue" : "none"}`}>
              {milestone.state}
            </span>
          )}
        </span>
        {milestone.state === "done" ? null : (
          <span className="rm-ms-outcome">{milestone.outcome}</span>
        )}
        <span className="rm-meter" aria-hidden="true">
          <i
            data-testid="milestone-bar"
            style={{ width: total === 0 ? "0%" : `${(100 * milestone.done) / total}%` }}
          />
        </span>
        <span className="rm-ms-foot">
          <b>{milestone.done}</b> done · <b>{milestone.open}</b> open
        </span>
      </button>
    </li>
  );
}

export function Notices({ warnings }: { warnings: RoadmapWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <section className="rm-notes" data-testid="roadmap-notes" tabIndex={-1}>
      <h2>
        <Icon name="info" />
        {warnings.length} {warnings.length === 1 ? "note" : "notes"} on ROADMAP.md
      </h2>
      <ul>
        {warnings.map((warning, at) => (
          <li key={at} data-testid="roadmap-warning" data-kind={warning.kind}>
            <span className="mono">{warning.kind}</span>
            <div>
              <Markdown text={warning.message} />
              <span className="mono" data-testid="warning-ids">
                {warning.ids.join(", ")}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Shipped = { milestone: string; tickets: RoadmapItem[] };

/** Every shipped ticket with status done, declared milestone or not. */
export const doneTotal = (shipped: Shipped[]) =>
  shipped.reduce(
    (sum, entry) => sum + entry.tickets.filter((ticket) => ticket.status === "done").length,
    0,
  );

/** The Shipped bar's open folds: kept across a visit to a ticket page. */
export type ShippedFolds = {
  open: boolean;
  unfolded: ReadonlySet<string>;
  supersededOpen: ReadonlySet<string>;
};

export function ShippedBar({
  shipped,
  milestones,
  initial,
  onFolds,
}: {
  shipped: Shipped[];
  milestones: RoadmapMilestone[];
  initial?: ShippedFolds;
  onFolds: (folds: ShippedFolds) => void;
}) {
  const [open, setOpen] = useState(initial?.open ?? false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(initial?.unfolded ?? new Set());
  const [supersededOpen, setSupersededOpen] = useState<ReadonlySet<string>>(
    initial?.supersededOpen ?? new Set(),
  );
  useEffect(() => onFolds({ open, unfolded, supersededOpen }), [open, unfolded, supersededOpen]);
  const flip = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const total = doneTotal(shipped);
  const countsOf = (entry: Shipped) => {
    const milestone = milestones.find((candidate) => candidate.id === entry.milestone);
    const done = entry.tickets.filter((ticket) => ticket.status === "done");
    return {
      name: milestone?.name ?? (entry.milestone === "" ? "No milestone" : entry.milestone),
      outcome: milestone?.outcome ?? "",
      done: milestone?.done ?? done.length,
      superseded: milestone?.superseded ?? entry.tickets.length - done.length,
      doneTickets: done,
      supersededTickets: entry.tickets.filter((ticket) => ticket.status !== "done"),
    };
  };
  return (
    <footer className="rm-foot" data-testid="shipped-bar">
      <button
        type="button"
        className="rm-shipped-toggle"
        aria-expanded={open}
        data-testid="shipped-toggle"
        onClick={() => setOpen(!open)}
      >
        <Icon name="chevron" />
        <span>Shipped</span>
        <b data-testid="shipped-total">{total} done</b>
        {shipped.map((entry) => (
          <span
            key={entry.milestone}
            className="rm-ship-mini mono"
            data-testid="shipped-count"
            data-milestone={entry.milestone}
          >
            {entry.milestone === "" ? "–" : entry.milestone} {countsOf(entry).done}
          </span>
        ))}
      </button>
      {open ? (
        <div className="rm-ship-panel" data-testid="shipped-panel">
          <p className="rm-ship-intro">
            Finished work by milestone. Superseded tickets sit in their own fold.
          </p>
          {shipped.map((entry) => {
            const counts = countsOf(entry);
            const isOpen = unfolded.has(entry.milestone);
            return (
              <div
                className="rm-sfold"
                key={entry.milestone}
                data-testid="shipped-fold"
                data-milestone={entry.milestone}
              >
                <button
                  type="button"
                  className="rm-sfold-head"
                  aria-expanded={isOpen}
                  onClick={() => setUnfolded(flip(unfolded, entry.milestone))}
                >
                  <Icon name="chevron" />
                  <b className="mono">{entry.milestone === "" ? "–" : entry.milestone}</b>
                  <span className="rm-nm">{counts.name}</span>
                  <span className="rm-sub">{counts.done} done</span>
                </button>
                {isOpen ? (
                  <>
                    {counts.outcome ? <p className="rm-outcome">{counts.outcome}</p> : null}
                    <ShippedList tickets={counts.doneTickets} />
                    {counts.supersededTickets.length > 0 ? (
                      <>
                        <button
                          type="button"
                          className="rm-sfold-head nested"
                          aria-expanded={supersededOpen.has(entry.milestone)}
                          data-testid="superseded-fold"
                          onClick={() => setSupersededOpen(flip(supersededOpen, entry.milestone))}
                        >
                          <Icon name="chevron" />
                          <span>{counts.superseded} superseded</span>
                        </button>
                        {supersededOpen.has(entry.milestone) ? (
                          <ShippedList tickets={counts.supersededTickets} />
                        ) : null}
                      </>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </footer>
  );
}

function ShippedList({ tickets }: { tickets: RoadmapItem[] }) {
  return (
    <ul className="rm-done-list">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <a href={ticketHref(ticket.id)} data-testid="shipped-ticket" data-ticket={ticket.id}>
            <b className="mono">{ticket.id}</b>
            <span>{ticket.title ?? ticket.id}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
