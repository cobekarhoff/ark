// test ids: ticket-page, ticket-problem, ticket-change, ticket-criterion (data-id), ticket-graph,
// depends-on (links: dep-link), unblocks-list (links: unblock-link)
import { useEffect } from "react";
import { DepGraph, type GraphTicket } from "./DepGraph.tsx";
import { ticketEntries, ticketKey, type TicketEntry } from "./derive.ts";
import { Unknown, known } from "./format.tsx";
import { OpenInOrca } from "./OrcaButton.tsx";
import { runHref } from "./RunDetail.tsx";
import { useLive } from "./store.tsx";

/** Paragraphs and bullet lists of plain text: Markdown marks stay as written, nothing becomes HTML. */
function Prose({ text, testId }: { text: string; testId: string }) {
  if (text === "") return <p className="mut">Not written in the ticket.</p>;
  return (
    <div className="prose" data-testid={testId}>
      {text.split(/\n\s*\n/).map((block, index) => {
        const lines = block.split("\n");
        return lines.every((line) => /^\s*[-*] /.test(line)) ? (
          <ul key={index}>
            {lines.map((line, at) => (
              <li key={at}>{line.replace(/^\s*[-*] /, "")}</li>
            ))}
          </ul>
        ) : (
          <p key={index}>{block}</p>
        );
      })}
    </div>
  );
}

const node = (entry: TicketEntry, base: TicketEntry["ticket"]): GraphTicket => ({
  key: entry.key,
  id: entry.ticket.id,
  title: entry.ticket.title ?? entry.ticket.id,
  state: entry.state,
  tone: entry.tone,
  href: `#/ticket/${encodeURIComponent(entry.ticket.id)}`,
  ring: entry.open?.progress
    ? { done: entry.open.progress.steps_done, total: entry.open.progress.steps_total }
    : entry.satisfied || entry.lane === "Closed"
      ? { done: 1, total: 1, label: "✓" }
      : { done: 0, total: 1, label: "–" },
  needs: entry.ticket.depends_on
    .filter((id) => entry.ticket.id === base.id || id === base.id)
    .map((id) => ticketKey(entry.ticket.project, id)),
  satisfied: entry.satisfied,
});

export function TicketPage({ id }: { id: string }) {
  const { snapshot } = useLive();
  const entries = snapshot ? ticketEntries(snapshot) : null;
  const entry = entries
    ? ([...entries.values()].find((candidate) => candidate.ticket.id === id) ?? null)
    : null;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") location.hash = "#/roadmap";
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  if (!snapshot || !entries || !known(snapshot.tickets))
    return (
      <>
        <h1>{id}</h1>
        <Unknown />
      </>
    );
  if (!entry)
    return (
      <>
        <p className="crumb">
          <a href="#/roadmap">← Roadmap</a>
        </p>
        <h1>{id}</h1>
        <p className="mut">No ticket {id} in the roadmap.</p>
      </>
    );
  const { ticket } = entry;
  const all = [...entries.values()].filter((other) => other.ticket.project === ticket.project);
  const dependsOn = ticket.depends_on.map((need) => ({
    id: need,
    entry: entries.get(ticketKey(ticket.project, need)) ?? null,
  }));
  const unblocks = all.filter((other) => other.ticket.depends_on.includes(ticket.id));
  const neighbours = [
    entry,
    ...dependsOn.flatMap((need) => (need.entry ? [need.entry] : [])),
    ...unblocks,
  ];
  const run = entry.open ?? entry.newest;
  const lead =
    entry.open && known(entry.open.agents)
      ? entry.open.agents.find((agent) => agent.role === "run lead")
      : undefined;
  return (
    <div className="ticket-page" data-testid="ticket-page">
      <p className="crumb">
        <a href="#/roadmap">← Roadmap</a> <span className="mut">Esc returns to the list</span>
      </p>
      <div className="ticket-cols">
        <article>
          <div className="meta">
            <span className="mono strong">{ticket.id}</span>
            <span className={`pill ${entry.tone}`}>{entry.state}</span>
            {ticket.milestone ? <span className="pill">{ticket.milestone}</span> : null}
            {ticket.status.replaceAll("_", " ") === entry.state ? null : (
              <span className="pill">{ticket.status}</span>
            )}
          </div>
          <h1 className="ticket-title">{ticket.title ?? ticket.id}</h1>
          <div className="actions">
            {run ? (
              <a className="btn primary" href={runHref(run.run)}>
                Open run
              </a>
            ) : null}
            {lead ? <OpenInOrca agent={lead} /> : null}
          </div>
          {ticket.document === null ? (
            <p className="bad-text">The hub could not read the text of this ticket.</p>
          ) : null}
          {ticket.document ? (
            <>
              <h2>Problem</h2>
              <Prose text={ticket.document.problem} testId="ticket-problem" />
              <h2>Change</h2>
              <Prose text={ticket.document.change} testId="ticket-change" />
              <h2>Acceptance criteria · {ticket.document.criteria.length}</h2>
              <ol className="criteria">
                {ticket.document.criteria.map((criterion) => (
                  <li key={criterion.id} data-testid="ticket-criterion" data-id={criterion.id}>
                    <span className="mono mut">{criterion.id}</span> {criterion.text}
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </article>
        <aside className="side">
          <section className="panel">
            <header>
              <h2>Dependency graph</h2>
            </header>
            <div className="body graph-scroll" data-testid="ticket-graph">
              <DepGraph
                size="compact"
                label={`Dependency graph of ${ticket.id}`}
                focus={entry.key}
                tickets={neighbours.map((other) => node(other, ticket))}
              />
            </div>
          </section>
          <section className="panel" data-testid="depends-on">
            <header>
              <h2>Depends on · {dependsOn.length}</h2>
            </header>
            <ul className="body links">
              {dependsOn.length === 0 ? (
                <li className="mut">Nothing. It can start any time.</li>
              ) : null}
              {dependsOn.map((need) => (
                <li key={need.id}>
                  <a
                    className="mono"
                    href={`#/ticket/${encodeURIComponent(need.id)}`}
                    data-testid="dep-link"
                  >
                    {need.id}
                  </a>{" "}
                  {need.entry?.ticket.title ?? ""}{" "}
                  <span className="pill">{need.entry?.state ?? "unknown"}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel" data-testid="unblocks-list">
            <header>
              <h2>Unblocks · {unblocks.length}</h2>
            </header>
            <ul className="body links">
              {unblocks.length === 0 ? <li className="mut">No ticket waits for it.</li> : null}
              {unblocks.map((other) => (
                <li key={other.key}>
                  <a
                    className="mono"
                    href={`#/ticket/${encodeURIComponent(other.ticket.id)}`}
                    data-testid="unblock-link"
                  >
                    {other.ticket.id}
                  </a>{" "}
                  {other.ticket.title} <span className="pill">{other.state}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
