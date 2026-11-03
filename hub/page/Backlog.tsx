// test ids: ticket-row (data-ticket, aria-current marks the selection), ticket-select, filter-text,
// filter-status, show-done, group (data-group), copy-button, copy-preview, ticket-run (data-run),
// ticket-link. No control here changes a ticket.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ticketEntries, ticketKey, type TicketEntry } from "./derive.ts";
import { Phase, Unknown, known } from "./format.tsx";
import { runHref } from "./RunDetail.tsx";
import { useLive } from "./store.tsx";
import type { TicketView } from "../types.ts";

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

export const promptFor = (ids: string[]) => `Queue ${ids.join(", ")} in this order.`;

const groups = [
  ["In a run", "an agent is on it right now"],
  ["In progress", "started by hand"],
  ["Ready", "unblocked tickets first"],
  ["Proposed", "not approved yet"],
  ["Other", "any other status"],
  ["Done", "done and superseded"],
] as const;

function groupOf(entry: TicketEntry): (typeof groups)[number][0] {
  const { status } = entry.ticket;
  if (status === "done" || status === "superseded") return "Done";
  if (entry.open) return "In a run";
  if (status === "in_progress") return "In progress";
  if (status === "ready") return "Ready";
  if (status === "proposed") return "Proposed";
  return "Other";
}

/** What the list keeps while a ticket page is open, so Esc lands on the same row and scroll position. */
type Remembered = {
  scroll: number;
  cursor: string | null;
  text: string;
  status: string;
  showDone: boolean;
};
let remembered: Remembered | null = null;

/** A form field has the focus: its keys are text, not shortcuts. */
const isTyping = (target: EventTarget | null) =>
  (target instanceof HTMLInputElement && target.type !== "checkbox") ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement;

export function Backlog() {
  const { snapshot } = useLive();
  const [text, setText] = useState(() => remembered?.text ?? "");
  const [status, setStatus] = useState(() => remembered?.status ?? "");
  const [showDone, setShowDone] = useState(() => remembered?.showDone ?? false);
  const [cursor, setCursor] = useState<string | null>(() => remembered?.cursor ?? null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState("");
  const tickets = snapshot && known(snapshot.tickets) ? snapshot.tickets : null;
  const entries = useMemo(
    () => (snapshot ? ticketEntries(snapshot) : new Map<string, TicketEntry>()),
    [snapshot],
  );
  // Every run of a ticket, newest first (the order of `all`).
  const runsOf = new Map(
    (snapshot && known(snapshot.ticket_runs) ? snapshot.ticket_runs : []).map((entry) => [
      ticketKey(entry.project, entry.ticket),
      entry.all,
    ]),
  );
  const statuses = useMemo(
    () => [...new Set((tickets ?? []).map((ticket) => ticket.status))].sort(),
    [tickets],
  );

  const needle = text.trim().toLowerCase();
  const matching = (tickets ?? []).filter(
    (ticket) =>
      (status === "" || ticket.status === status) &&
      (needle === "" ||
        [ticket.id, ticket.title ?? "", ticket.milestone ?? "", ...ticket.depends_on].some(
          (field) => field.toLowerCase().includes(needle),
        )),
  );
  const doneCount = matching.filter(
    (ticket) => groupOf(entries.get(ticketKey(ticket.project, ticket.id))!) === "Done",
  ).length;
  const grouped = groups
    .map(([name, hint]) => ({
      name,
      hint,
      rows: matching
        .filter((ticket) => groupOf(entries.get(ticketKey(ticket.project, ticket.id))!) === name)
        // Unblocked tickets first, then by id.
        .toSorted(
          (left, right) =>
            Number(left.depends_on.length > 0 && name === "Ready") -
              Number(right.depends_on.length > 0 && name === "Ready") ||
            left.id.localeCompare(right.id),
        ),
    }))
    .filter((group) => group.rows.length > 0 && (group.name !== "Done" || showDone));
  const order = grouped.flatMap((group) => group.rows.map((ticket) => ticket.id));
  const current = cursor !== null && order.includes(cursor) ? cursor : (order[0] ?? null);

  const remember = () => {
    remembered = { scroll: window.scrollY, cursor: current, text, status, showDone };
  };

  // Back from a ticket page: the same scroll position, once the rows exist.
  const loaded = tickets !== null;
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
          .querySelector(`[data-testid="ticket-row"][data-ticket="${CSS.escape(next)}"]`)
          ?.scrollIntoView({ block: "nearest" });
        return;
      }
      // Enter on a link, button, select or textarea keeps its own action; anywhere else (the search
      // field included) it opens the selected ticket.
      const control =
        event.target instanceof HTMLElement ? event.target.closest("a, button") : null;
      const checkbox = event.target instanceof HTMLInputElement && event.target.type === "checkbox";
      const native =
        event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === "Enter" && current !== null && !control && !checkbox && !native) {
        event.preventDefault();
        remember();
        location.hash = `#/ticket/${encodeURIComponent(current)}`;
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (!tickets)
    return (
      <>
        <h1>Backlog</h1>
        <Unknown />
      </>
    );
  const ids = dependencyOrder([...selected], tickets);
  const prompt = promptFor(ids);
  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied("Copied");
    } catch {
      setCopied("Copy failed: select the text below");
    }
  };
  const open = tickets.filter((ticket) => !["done", "superseded"].includes(ticket.status)).length;
  return (
    <>
      <h1>
        Backlog{" "}
        <span className="mut sub">
          Done tickets are hidden. j / k to move, Enter to read, / to search.
        </span>
      </h1>
      <div className="toolbar">
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
        <select
          name="status"
          aria-label="Filter by status"
          data-testid="filter-status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">status: all</option>
          {statuses.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <label className="check">
          <input
            type="checkbox"
            data-testid="show-done"
            checked={showDone}
            onChange={(event) => setShowDone(event.target.checked)}
          />
          Show done ({doneCount})
        </label>
        <span className="mut end" aria-live="polite">
          {open} open · {ids.length} selected {copied}
        </span>
        <button
          type="button"
          className="btn primary"
          data-testid="copy-button"
          disabled={ids.length === 0}
          onClick={copy}
        >
          Copy prompt for Master Chief
        </button>
      </div>
      <table className="btable">
        <thead>
          <tr>
            <th className="sel-col">
              <span className="sr">Select</span>
            </th>
            <th>ID</th>
            <th>Title</th>
            <th>Status</th>
            <th>M</th>
            <th>Depends on</th>
            <th className="num">Unblocks</th>
            <th>Runs</th>
          </tr>
        </thead>
        {grouped.map((group) => (
          <tbody key={group.name} data-testid="group" data-group={group.name}>
            <tr className="group-row">
              <th colSpan={8} scope="colgroup">
                {group.name} <span className="count">{group.rows.length}</span>{" "}
                <span className="hint">{group.hint}</span>
              </th>
            </tr>
            {group.rows.map((ticket) => {
              const runs = runsOf.get(ticketKey(ticket.project, ticket.id)) ?? [];
              const unblocks = tickets.filter(
                (other) => other.project === ticket.project && other.depends_on.includes(ticket.id),
              ).length;
              return (
                <tr
                  key={`${ticket.project}/${ticket.id}`}
                  data-testid="ticket-row"
                  data-ticket={ticket.id}
                  aria-current={ticket.id === current ? "true" : undefined}
                  onClick={(event) => {
                    if (!(event.target as HTMLElement).closest("a, input, button"))
                      setCursor(ticket.id);
                  }}
                >
                  <td className="sel-col">
                    <input
                      type="checkbox"
                      aria-label={`Select ${ticket.id}`}
                      data-testid="ticket-select"
                      checked={selected.has(ticket.id)}
                      onChange={() => toggle(ticket.id)}
                    />
                  </td>
                  <td className="id nw">
                    <a
                      href={`#/ticket/${encodeURIComponent(ticket.id)}`}
                      data-testid="ticket-link"
                      onClick={() => {
                        setCursor(ticket.id);
                        remembered = {
                          scroll: window.scrollY,
                          cursor: ticket.id,
                          text,
                          status,
                          showDone,
                        };
                      }}
                    >
                      {ticket.id}
                    </a>
                  </td>
                  <td className="wrap">{ticket.title}</td>
                  <td className="nw">
                    <span className="pill">{ticket.status}</span>
                  </td>
                  <td className="nw">{ticket.milestone ?? "—"}</td>
                  <td className="mono">
                    {ticket.depends_on.length === 0
                      ? "—"
                      : ticket.depends_on.map((id) => (
                          <span key={id} className="chip nw">
                            {id}
                          </span>
                        ))}
                  </td>
                  <td className="num">{unblocks === 0 ? "" : unblocks}</td>
                  <td className="nw">
                    {runs.map((entry) => (
                      <div key={entry.run}>
                        <a
                          className="mono"
                          href={runHref(entry.run)}
                          data-testid="ticket-run"
                          data-run={entry.run}
                        >
                          {entry.run}
                        </a>{" "}
                        <span className="pill">
                          <Phase phase={entry.phase} />
                        </span>
                      </div>
                    ))}
                    {runs.length === 0 ? <span className="mut">no runs</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
      {order.length === 0 ? <p className="mut">No ticket matches.</p> : null}
      <p className="mut" data-testid="copy-preview">
        {ids.length === 0 ? "Select tickets to copy a prompt." : `Copies: “${prompt}”`} No button
        changes a ticket.
      </p>
    </>
  );
}
