import { useEffect, useState } from "react";
import { DepGraph, type GraphTicket } from "./DepGraph.tsx";
import { ticketEntries, ticketKey, type TicketEntry } from "./derive.ts";
import { Criteria } from "./Evidence.tsx";
import { OutsideNote, ProjectValue, Unknown, known } from "./format.tsx";
import { Markdown, ViewSwitch } from "./Markdown.tsx";
import { OpenInOrca } from "./OrcaButton.tsx";
import { runHref } from "./RunDetail.tsx";
import { hashOf, ticketHref, useLive } from "./store.tsx";
import type { TicketDocument, TicketView } from "../types.ts";

const node = (entry: TicketEntry, base: TicketEntry["ticket"]): GraphTicket => ({
  key: entry.key,
  id: entry.ticket.id,
  title: entry.ticket.title ?? entry.ticket.id,
  state: entry.state,
  tone: entry.tone,
  href: ticketHref(entry.ticket.id),
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

/** The ticket's document: null once the route answered unreadable, undefined while it loads. */
function useDocument(ticket: TicketView): TicketDocument | null | undefined {
  const key = `${ticket.project}/${ticket.id}`;
  const [read, setRead] = useState<{ key: string; document: TicketDocument | null }>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(
      `/api/ticket/${encodeURIComponent(ticket.project)}/${encodeURIComponent(ticket.id)}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (response) => (response.ok ? (await response.json()).document : null))
      .catch(() => null)
      .then((document: TicketDocument | null) => {
        if (!controller.signal.aborted) setRead({ key, document });
      });
    return () => controller.abort();
    // The signature changes with any edit of the file; an unrelated push changes neither input.
  }, [key, ticket.signature]);
  // A reload of the same ticket keeps the text on screen; another ticket starts loading.
  return read?.key === key ? read.document : undefined;
}

function TicketText({ ticket }: { ticket: TicketView }) {
  const document = useDocument(ticket);
  const [raw, setRaw] = useState(false);
  if (document === undefined)
    return (
      <>
        <div role="status" className="doc-status">
          <span className="spinner" aria-hidden="true" />
          Loading the ticket text…
        </div>
        <div aria-hidden="true">
          {[
            ["Problem", [90, 75, 60]],
            ["Change", [90, 40]],
            ["Evidence", [75, 50]],
            ["Acceptance criteria", [75, 60, 75]],
          ].map(([title, widths]) => (
            <div key={title as string}>
              <h2>{title as string}</h2>
              {(widths as number[]).map((width, index) => (
                <span key={index} className="sk" style={{ width: `${width}%` }} />
              ))}
            </div>
          ))}
        </div>
      </>
    );
  if (document === null)
    return (
      <div role="alert" className="doc-alert">
        <strong>The hub could not read the text of this ticket.</strong>
        The file is missing or does not parse. This page loads it again by itself when the file
        changes.
      </div>
    );
  const section = (text: string, testId: string) =>
    text === "" ? (
      <p className="mut">Not written in the ticket.</p>
    ) : (
      <Markdown text={text} raw={raw} testId={testId} />
    );
  return (
    <>
      <div className="view-bar">
        <ViewSwitch raw={raw} onChange={setRaw} />
      </div>
      <h2>Problem</h2>
      {section(document.problem, "ticket-problem")}
      <h2>Change</h2>
      {section(document.change, "ticket-change")}
      <h2>Evidence</h2>
      {section(document.evidence, "ticket-evidence")}
      <h2>Acceptance criteria · {document.criteria.length}</h2>
      <Criteria
        project={ticket.project}
        ticket={ticket.id}
        criteria={document.criteria}
        raw={raw}
      />
    </>
  );
}

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
    // Esc goes back with the filter of the URL, not the ticket's project.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") location.hash = hashOf("#/roadmap");
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
          <a href={hashOf("#/roadmap")}>← Roadmap</a>
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
        <a href={hashOf("#/roadmap")}>← Roadmap</a>{" "}
        <span className="mut">Esc returns to the list</span>
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
            <ProjectValue project={ticket.project} />
          </div>
          <OutsideNote project={ticket.project} />
          <h1 className="ticket-title">{ticket.title ?? ticket.id}</h1>
          <div className="actions">
            {run ? (
              <a className="btn primary" href={runHref(run.run)}>
                Open run
              </a>
            ) : null}
            {lead ? <OpenInOrca agent={lead} /> : null}
          </div>
          <TicketText ticket={ticket} />
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
                  <a className="mono" href={ticketHref(need.id)} data-testid="dep-link">
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
                  <a className="mono" href={ticketHref(other.ticket.id)} data-testid="unblock-link">
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
