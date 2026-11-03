// test ids: ticket-row (data-ticket), ticket-select, filter-text, filter-status, copy-button,
// copy-preview, copy-status, ticket-run (data-run). No control here changes a ticket.
import { useEffect, useMemo, useState } from "react";
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

/** `focus` is the ticket of `#/backlog/<ticket>`: its row is marked and scrolled into view. */
export function Backlog({ focus }: { focus: string | null }) {
  const { snapshot } = useLive();
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState("");
  const tickets = snapshot && known(snapshot.tickets) ? snapshot.tickets : null;
  // Every run of a ticket, newest first (the order of `all`).
  const runsOf = new Map(
    (snapshot && known(snapshot.ticket_runs) ? snapshot.ticket_runs : []).map((entry) => [
      `${entry.project}/${entry.ticket}`,
      entry.all,
    ]),
  );
  const loaded = tickets !== null;
  useEffect(() => {
    if (focus && loaded)
      document
        .querySelector(`[data-testid="ticket-row"][data-ticket="${CSS.escape(focus)}"]`)
        ?.scrollIntoView({ block: "center" });
  }, [focus, loaded]);
  const statuses = useMemo(
    () => [...new Set((tickets ?? []).map((ticket) => ticket.status))].sort(),
    [tickets],
  );
  if (!tickets)
    return (
      <>
        <h1>Backlog</h1>
        <Unknown />
      </>
    );
  const needle = text.trim().toLowerCase();
  const shown = tickets.filter(
    (ticket) =>
      (status === "" || ticket.status === status) &&
      (needle === "" ||
        [ticket.id, ticket.title ?? "", ticket.milestone ?? "", ...ticket.depends_on].some(
          (field) => field.toLowerCase().includes(needle),
        )),
  );
  const ids = dependencyOrder([...selected], tickets);
  const prompt = promptFor(ids);
  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const allShown = shown.length > 0 && shown.every((ticket) => selected.has(ticket.id));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied("Copied");
    } catch {
      setCopied("Copy failed: select the text below");
    }
  };
  return (
    <>
      <h1>Backlog</h1>
      <div className="toolbar">
        <input
          type="search"
          name="q"
          autoComplete="off"
          spellCheck={false}
          aria-label="Filter by text"
          placeholder="Filter by text…"
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
        <span className="mut end" aria-live="polite">
          {ids.length} selected · {copied}
        </span>
        <button type="button" data-testid="copy-button" disabled={ids.length === 0} onClick={copy}>
          Copy prompt for Master Chief
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Select all shown tickets"
                checked={allShown}
                onChange={() =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    for (const ticket of shown) {
                      if (allShown) next.delete(ticket.id);
                      else next.add(ticket.id);
                    }
                    return next;
                  })
                }
              />
            </th>
            <th>ID</th>
            <th>Title</th>
            <th>Status</th>
            <th>Runs</th>
            <th>Milestone</th>
            <th>depends_on</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((ticket) => (
            <tr
              key={`${ticket.project}/${ticket.id}`}
              data-testid="ticket-row"
              data-ticket={ticket.id}
              aria-current={ticket.id === focus ? "true" : undefined}
            >
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${ticket.id}`}
                  data-testid="ticket-select"
                  checked={selected.has(ticket.id)}
                  onChange={() => toggle(ticket.id)}
                />
              </td>
              <td className="id nw">{ticket.id}</td>
              <td className="wrap">{ticket.title}</td>
              <td className="nw">
                <span className="pill">{ticket.status}</span>
              </td>
              <td className="nw">
                {(runsOf.get(`${ticket.project}/${ticket.id}`) ?? []).map((entry) => (
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
                {!runsOf.has(`${ticket.project}/${ticket.id}`) && (
                  <span className="mut">no runs</span>
                )}
              </td>
              <td className="nw">{ticket.milestone ?? "—"}</td>
              <td className="mono">
                {ticket.depends_on.length === 0
                  ? "—"
                  : ticket.depends_on.map((id, index) => (
                      <span key={id}>
                        {index > 0 && ", "}
                        <span className="nw">{id}</span>
                      </span>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p className="mut">No ticket matches.</p>}
      <p className="mut" data-testid="copy-preview">
        {ids.length === 0 ? "Select tickets to copy a prompt." : `Copies: “${prompt}”`} No button
        changes a ticket.
      </p>
    </>
  );
}
