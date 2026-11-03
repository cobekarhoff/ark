// test ids: ticket-row (data-ticket), ticket-select, filter-text, filter-status, copy-button,
// copy-preview, copy-status. No control here changes a ticket.
import { useMemo, useState } from "react";
import { Unknown, known } from "./format.tsx";
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

export function Backlog() {
  const { snapshot } = useLive();
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState("");
  const tickets = snapshot && known(snapshot.tickets) ? snapshot.tickets : null;
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
              <td className="id">{ticket.id}</td>
              <td>{ticket.title}</td>
              <td>
                <span className="pill">{ticket.status}</span>
              </td>
              <td>{ticket.milestone ?? "—"}</td>
              <td className="mono">
                {ticket.depends_on.length === 0 ? "—" : ticket.depends_on.join(", ")}
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
