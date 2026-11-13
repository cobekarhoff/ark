import { useEffect, useState, type ReactNode } from "react";
import { DepGraph, type GraphTicket } from "./DepGraph.tsx";
import { outcomeOf, ticketEntries, ticketKey, type TicketEntry } from "./derive.ts";
import { Criteria } from "./Evidence.tsx";
import { OutsideNote, outcomeRing, ProjectValue, Unknown, known } from "./format.tsx";
import { Markdown, ViewSwitch } from "./Markdown.tsx";
import { OpenInOrca } from "./OrcaButton.tsx";
import { runHref } from "./RunDetail.tsx";
import { hashOf, ticketHref, useLive } from "./store.tsx";
import type { TicketDocument, TicketView } from "../types.ts";

const node = (entry: TicketEntry): GraphTicket => ({
  key: entry.key,
  id: entry.ticket.id,
  title: entry.ticket.title ?? entry.ticket.id,
  state: entry.state,
  tone: entry.tone,
  href: ticketHref(entry.ticket.id),
  outcome: outcomeOf(entry),
  ring: entry.open?.progress
    ? { done: entry.open.progress.steps_done, total: entry.open.progress.steps_total }
    : outcomeOf(entry) !== undefined
      ? outcomeRing(outcomeOf(entry)!)
      : entry.satisfied || entry.lane === "Closed"
        ? { done: 1, total: 1, label: "✓" }
        : { done: 0, total: 1, label: "–" },
  needs: entry.ticket.depends_on.map((id) => ticketKey(entry.ticket.project, id)),
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

const proseSections = [
  ["problem", "Problem"],
  ["change", "Change"],
  ["evidence", "Evidence"],
] as const;
/** A part counts as in view once its top has scrolled under the sticky bar. */
const viewLine = 96;

/** The chips marked now, as `<prose id> <criterion id or empty>`: the two columns scroll side by side. */
function useMarked(enabled: boolean, criteria: string[]): string {
  const [marked, setMarked] = useState("");
  const key = criteria.join(",");
  useEffect(() => {
    if (!enabled) return;
    const passed = (id: string) =>
      (window.document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= viewLine;
    const update = () => {
      const atBottom = innerHeight + scrollY >= window.document.documentElement.scrollHeight - 2;
      const ids = proseSections.map(([name]) => `sec-${name}`);
      const prose = atBottom ? ids.at(-1) : (ids.filter(passed).at(-1) ?? ids[0]);
      const criterion = key
        .split(",")
        .filter((id) => key !== "" && passed(`crit-${id}`))
        .at(-1);
      setMarked(`${prose} ${criterion === undefined ? "" : `crit-${criterion}`}`);
    };
    update();
    addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update);
    return () => {
      removeEventListener("scroll", update);
      removeEventListener("resize", update);
    };
  }, [enabled, key]);
  return marked;
}

const jump = (id: string) => window.document.getElementById(id)?.scrollIntoView({ block: "start" });

/**
 * The ticket text in two columns under the graph band: Problem, Change and Evidence on the left, the
 * relations and the acceptance criteria on the right, with a sticky bar of chips and the
 * Rendered / Raw switch. A chip is a button, never a link: the router is the hash.
 */
function TicketText({ ticket, relations }: { ticket: TicketView; relations: ReactNode }) {
  const text = useDocument(ticket);
  const [raw, setRaw] = useState(false);
  const marked = useMarked(
    !!text,
    text ? text.criteria.map((criterion) => criterion.id) : [],
  ).split(" ");
  if (!text)
    return (
      <div className="ticket-cols">
        <div className="ticket-prose">
          {text === null ? (
            <div role="alert" className="doc-alert">
              <strong>The hub could not read the text of this ticket.</strong>
              The file is missing or does not parse. This page loads it again by itself when the
              file changes.
            </div>
          ) : (
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
          )}
        </div>
        <aside className="side">{relations}</aside>
      </div>
    );
  const section = (body: string, testId: string) =>
    body === "" ? (
      <p className="mut">Not written in the ticket.</p>
    ) : (
      <Markdown text={body} raw={raw} testId={testId} />
    );
  const chip = (id: string, label: ReactNode, extra = "") => (
    <button
      key={id}
      type="button"
      className={`outline-chip${extra}`}
      aria-current={marked.includes(id) ? "location" : undefined}
      onClick={() => jump(id)}
    >
      {label}
    </button>
  );
  return (
    <>
      <nav className="outline-bar" aria-label="Ticket outline" data-testid="outline-bar">
        {proseSections.map(([name, label]) => chip(`sec-${name}`, label))}
        <span className="outline-sep" role="separator" />
        <button
          type="button"
          className="outline-chip"
          aria-current={marked[1] === "" ? undefined : "location"}
          onClick={() => jump("sec-criteria")}
        >
          Acceptance criteria <span className="count">{text.criteria.length}</span>
        </button>
        {text.criteria.map((criterion) => chip(`crit-${criterion.id}`, criterion.id, " mono"))}
        <span className="outline-switch">
          <ViewSwitch raw={raw} onChange={setRaw} />
        </span>
      </nav>
      <div className="ticket-cols">
        <div className="ticket-prose">
          <section id="sec-problem" className="ticket-section">
            <h2>Problem</h2>
            {section(text.problem, "ticket-problem")}
          </section>
          <section id="sec-change" className="ticket-section">
            <h2>Change</h2>
            {section(text.change, "ticket-change")}
          </section>
          <section id="sec-evidence" className="ticket-section">
            <h2>Evidence</h2>
            {section(text.evidence, "ticket-evidence")}
          </section>
        </div>
        <aside className="side">
          {relations}
          <section className="panel" id="sec-criteria">
            <header>
              <h2>Acceptance criteria</h2>
              <span className="count">{text.criteria.length}</span>
            </header>
            <div className="body">
              <Criteria
                project={ticket.project}
                ticket={ticket.id}
                criteria={text.criteria}
                raw={raw}
              />
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

/** A relation with entries is a panel; an empty one is a single line. */
function Relation({
  title,
  testId,
  count,
  children,
}: {
  title: string;
  testId: string;
  count: number;
  children: ReactNode;
}) {
  return count === 0 ? (
    <p className="relnone" data-testid={testId}>
      <b>{title}</b> · none
    </p>
  ) : (
    <section className="panel" data-testid={testId}>
      <header>
        <h2>
          {title} · {count}
        </h2>
      </header>
      <ul className="body links">{children}</ul>
    </section>
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
      <section className="panel ticket-band">
        <header>
          <h2>Dependency graph</h2>
        </header>
        <div className="body" data-testid="ticket-graph">
          <DepGraph
            size="compact"
            label={`Dependency graph of ${ticket.id}`}
            focus={entry.key}
            tickets={neighbours.map(node)}
          />
        </div>
      </section>
      <TicketText
        ticket={ticket}
        relations={
          <>
            <Relation title="Depends on" testId="depends-on" count={dependsOn.length}>
              {dependsOn.map((need) => (
                <li key={need.id}>
                  <a className="mono" href={ticketHref(need.id)} data-testid="dep-link">
                    {need.id}
                  </a>{" "}
                  {need.entry?.ticket.title ?? ""}{" "}
                  <span className="pill">{need.entry?.state ?? "unknown"}</span>
                </li>
              ))}
            </Relation>
            <Relation title="Unblocks" testId="unblocks-list" count={unblocks.length}>
              {unblocks.map((other) => (
                <li key={other.key}>
                  <a className="mono" href={ticketHref(other.ticket.id)} data-testid="unblock-link">
                    {other.ticket.id}
                  </a>{" "}
                  {other.ticket.title} <span className="pill">{other.state}</span>
                </li>
              ))}
            </Relation>
          </>
        }
      />
    </div>
  );
}
