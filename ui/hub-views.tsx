import { useEffect, useState, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import type { AgentsAnswer } from "../cli/hub/agents.ts";
import type { BacklogAnswer, Ticket } from "../cli/hub/backlog.ts";
import type { MetricsAnswer } from "../cli/hub/metrics.ts";
import type { ProjectsAnswer } from "../cli/hub/projects.ts";
import type { Hit, SearchAnswer } from "../cli/hub/search.ts";
import { switchTerminal, type Action } from "../cli/hub/types.ts";
import { inFilter, otherFilter, type Filter, type HubState } from "./model.ts";

type Perform = (action: Action | null) => Promise<void>;
type ViewProps = {
  hub: HubState;
  filter: Filter;
  known: string[];
  perform: Perform;
  /** The detail pane element. The view renders the opened item into it. */
  pane: HTMLElement | null;
};

/** Reads one API route now and again every 5 seconds, so a view never shows a stale answer for long. */
function useApi<T>(url: string | null): { data: T | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; data: T | null; failed: boolean }>({
    url,
    data: null,
    failed: false,
  });
  useEffect(() => {
    if (url === null) return;
    let live = true;
    const load = async () => {
      try {
        const response = await fetch(url);
        const body = (await response.json()) as T;
        if (live) setState({ url, data: response.ok ? body : null, failed: !response.ok });
      } catch {
        if (live) setState({ url, data: null, failed: true });
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [url]);
  // An answer for another url (a new week, a new query) is not this url's answer.
  return state.url === url ? state : { data: null, failed: false };
}

const Banner = ({
  tone,
  title,
  children,
}: {
  tone: string;
  title: string;
  children?: ReactNode;
}) => (
  <div className={`banner s-${tone}`} role="status">
    <div>
      <b>{title}</b>
      {children && <p>{children}</p>}
    </div>
  </div>
);

const Detail = ({ pane, children }: { pane: HTMLElement | null; children: ReactNode }) =>
  pane && createPortal(children, pane);

const NoItem = ({ pane }: { pane: HTMLElement | null }) => (
  <Detail pane={pane}>
    <div className="d-empty">Select a row to see it here.</div>
  </Detail>
);

const OpenInOrca = ({ handle, perform }: { handle: string; perform: Perform }) => (
  <button
    className="btn primary"
    onClick={() => void perform(switchTerminal(handle, "Open in Orca"))}
  >
    Open in Orca
  </button>
);

const money = (usd: number | "unavailable", includesUnknown = false) =>
  usd === "unavailable" ? "not available" : `$${usd.toFixed(2)}${includesUnknown ? "+" : ""}`;

const seconds = (value: number | "unavailable") =>
  value === "unavailable" ? "not available" : `${Math.round(value / 60)} min`;

/* Backlog */

const statusOrder = [
  "proposed",
  "ready",
  "in_progress",
  "blocked",
  "done",
  "unknown",
  "unreadable",
];

export function Backlog({ hub, filter, known, perform, pane }: ViewProps) {
  const { data, failed } = useApi<BacklogAnswer>("/api/backlog");
  const [selected, setSelected] = useState<string | null>(null);
  if (failed) return <Banner tone="bad" title="The hub could not read the tickets." />;
  if (data === null) return <div className="empty">Reading tickets…</div>;
  const tickets = data.tickets.filter((ticket) => inFilter(ticket.project, filter, known));
  const key = (ticket: Ticket) => `${ticket.project}:${ticket.id}`;
  const open = tickets.find((ticket) => key(ticket) === selected);
  const statuses = [...new Set(tickets.map((ticket) => ticket.status))].sort(
    (left, right) =>
      (statusOrder.indexOf(left) + 1 || 99) - (statusOrder.indexOf(right) + 1 || 99) ||
      left.localeCompare(right),
  );
  const chiefLive = (project: string) =>
    hub.projects.find((candidate) => candidate.name === project)?.chief.state === "live";
  const steer = (project: string, instruction: string, label: string) =>
    perform({ name: "chief-instruction", label, params: { project, instruction } });
  const queued = [...new Set(tickets.map((ticket) => ticket.project))];
  return (
    <>
      {queued.map((project) => (
        <div className="sec-h" key={project}>
          <h2>{project}</h2>
          <span className="spacer" />
          {!chiefLive(project) && (
            <span className="hint">No live Master Chief: approve and reorder are off.</span>
          )}
          <button
            className="btn sm"
            disabled={!chiefLive(project)}
            onClick={() => void steer(project, "reorder-queue", `Reorder queue of ${project}`)}
          >
            Reorder queue
          </button>
        </div>
      ))}
      {tickets.length === 0 && <div className="empty">No tickets.</div>}
      {statuses.map((status) => (
        <section key={status} aria-label={status}>
          <div className="sec-h">
            <h2>{status.replaceAll("_", " ")}</h2>
            <span className="count plain">
              {tickets.filter((ticket) => ticket.status === status).length}
            </span>
          </div>
          <ul className="list">
            {tickets
              .filter((ticket) => ticket.status === status)
              .map((ticket) => (
                <li
                  key={key(ticket)}
                  className={`row ${selected === key(ticket) ? "cursor" : ""}`}
                  data-ticket={key(ticket)}
                >
                  <button className="row-main v-backlog" onClick={() => setSelected(key(ticket))}>
                    <span className="tkt">{ticket.id}</span>
                    <span className="ttl">{ticket.title ?? `Unreadable: ${ticket.error}`}</span>
                    <span className="muted">{ticket.milestone ?? "no milestone"}</span>
                    <span className="muted" title="depends on">
                      {ticket.depends_on.length ? ticket.depends_on.join(", ") : "no dependencies"}
                    </span>
                    <span className="tag">{ticket.project}</span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
      {open ? (
        <Detail pane={pane}>
          <div className="d-head">
            <div className="d-id">
              <span className="pill">{open.status}</span>
              <span className="tag">{open.project}</span>
              <span className="tkt">{open.id}</span>
            </div>
            <h2>{open.title ?? "Unreadable ticket"}</h2>
            {open.error && <p className="d-story">{open.error}</p>}
            <dl className="kv">
              <dt>Milestone</dt>
              <dd>{open.milestone ?? "none"}</dd>
              <dt>Depends on</dt>
              <dd>{open.depends_on.join(", ") || "nothing"}</dd>
              <dt>File</dt>
              <dd>{open.file}</dd>
            </dl>
            {open.status === "proposed" && (
              <div className="bar">
                <button
                  className="btn primary"
                  disabled={!chiefLive(open.project)}
                  onClick={() =>
                    void steer(open.project, "approve-and-queue", `Approve and queue ${open.id}`)
                  }
                >
                  Approve and queue
                </button>
              </div>
            )}
          </div>
        </Detail>
      ) : (
        <NoItem pane={pane} />
      )}
    </>
  );
}

/* Agents */

export function Agents({ filter, known, perform, pane }: ViewProps) {
  const { data, failed } = useApi<AgentsAnswer>("/api/agents");
  const [selected, setSelected] = useState<string | null>(null);
  if (failed) return <Banner tone="bad" title="The hub did not answer." />;
  if (data === null) return <div className="empty">Asking Orca…</div>;
  if (data.state === "unknown")
    return (
      <Banner tone="bad" title="Orca is not reachable, so the agent list is not available.">
        The hub cannot tell whether agents are running. This is not an empty list.
      </Banner>
    );
  const agents = data.agents.filter((agent) => inFilter(agent.project, filter, known));
  const open = agents.find((agent) => agent.terminal === selected);
  return (
    <>
      {agents.length === 0 ? (
        <div className="empty">Orca lists no agents in this scope.</div>
      ) : (
        <ul className="list">
          {agents.map((agent) => (
            <li
              key={agent.terminal}
              className={`row ${selected === agent.terminal ? "cursor" : ""}`}
              data-agent={agent.terminal}
            >
              <button className="row-main v-agents" onClick={() => setSelected(agent.terminal)}>
                <span className="tag">{agent.project}</span>
                <span className={`st s-${agent.state === "live" ? "working" : "idle"}`}>
                  <i className="dot" />
                  {agent.state}
                </span>
                <span>
                  {agent.harness} · {agent.model ?? "model unknown"}
                </span>
                <span
                  className="num"
                  title={agent.cost.reason ?? "cost of the sessions in this agent's folder"}
                >
                  {money(agent.cost.usd, agent.cost.includes_unknown)}
                </span>
                <span className="muted line">{agent.last_line ?? "no output"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <Detail pane={pane}>
          <div className="d-head">
            <div className="d-id">
              <span className="pill">{open.state}</span>
              <span className="tag">{open.project}</span>
            </div>
            <h2>{open.title}</h2>
            <dl className="kv">
              <dt>Harness</dt>
              <dd>{open.harness}</dd>
              <dt>Model</dt>
              <dd>{open.model ?? "unknown"}</dd>
              <dt>Cost</dt>
              <dd>
                {money(open.cost.usd, open.cost.includes_unknown)}
                {open.cost.reason && ` (${open.cost.reason})`}
              </dd>
              <dt>Folder</dt>
              <dd>{open.folder ?? "unknown"}</dd>
              <dt>Last output</dt>
              <dd>{open.last_line ?? "none"}</dd>
            </dl>
            <div className="bar">
              <OpenInOrca handle={open.terminal} perform={perform} />
            </div>
          </div>
        </Detail>
      ) : (
        <NoItem pane={pane} />
      )}
    </>
  );
}

/* Metrics */

export function Metrics({ filter, known, pane }: ViewProps) {
  const [week, setWeek] = useState(() => new Date().toISOString().slice(0, 10));
  const [selected, setSelected] = useState<string | null>(null);
  const scoped = filter === "all" ? "" : `&project=${encodeURIComponent(filter)}`;
  // No run belongs to "other": the runs live in Ark projects only.
  const { data, failed } = useApi<MetricsAnswer>(
    filter === otherFilter || (filter !== "all" && !known.includes(filter))
      ? null
      : `/api/metrics?week=${week}${scoped}`,
  );
  const weekPicker = (
    <div className="sec-h">
      <label>
        <span className="hint">Week containing </span>
        <input type="date" value={week} onChange={(event) => setWeek(event.target.value)} />
      </label>
      {data && (
        <span className="hint">
          {data.week.start} to {data.week.end} (Monday to Sunday, UTC)
        </span>
      )}
    </div>
  );
  if (filter === otherFilter)
    return (
      <>
        {weekPicker}
        <div className="empty">Runs belong to Ark projects. Nothing is under Other.</div>
      </>
    );
  if (failed || data === null)
    return (
      <>
        {weekPicker}
        {failed ? (
          <Banner tone="bad" title="The hub could not read the metrics." />
        ) : (
          <div className="empty">Reading metrics…</div>
        )}
      </>
    );
  const outcomes = Object.entries(data.runs_by_outcome);
  const maximum = Math.max(
    0,
    ...data.cost_by_day.flatMap((day) => (day.usd === "unavailable" ? [] : [day.usd])),
  );
  const open = data.runs.find((run) => run.run === selected);
  const tile = (label: string, value: string, note?: string) => (
    <div className="tile plain" key={label}>
      <span className="tx">
        <span className="l">{label}</span>
        <b className="n">{value}</b>
        {note && <span className="s">{note}</span>}
      </span>
    </div>
  );
  return (
    <>
      {weekPicker}
      <div className="stats" role="group" aria-label="Week numbers">
        {tile(
          "Runs by outcome",
          String(data.runs.length),
          outcomes.map(([name, count]) => `${count} ${name}`).join(" · ") || "no closed runs",
        )}
        {tile("Median wall time", seconds(data.median_wall_seconds))}
        {tile("Median gate wait", seconds(data.median_gate_wait_seconds))}
        {tile(
          "Override rate",
          data.override_rate.value === "unavailable"
            ? "not available"
            : `${Math.round(data.override_rate.value * 100)}%`,
          `${data.override_rate.runs_with_value} of ${data.runs.length} runs`,
        )}
        {tile(
          "Design rounds",
          data.design_rounds.value === "unavailable"
            ? "not available"
            : String(data.design_rounds.value),
          `${data.design_rounds.runs_with_value} of ${data.runs.length} runs`,
        )}
      </div>
      <div className="sec-h">
        <h2>Cost by day</h2>
      </div>
      {data.cost_by_day.length === 0 ? (
        <div className="empty">No closed runs in this week.</div>
      ) : (
        <ul className="list" aria-label="Cost by day">
          {data.cost_by_day.map((day) => (
            <li className="row" key={day.day} data-day={day.day}>
              <span className="row-main v-day">
                <span className="tkt">{day.day}</span>
                <span
                  className="bar-fill"
                  style={{
                    width: `${day.usd === "unavailable" || maximum === 0 ? 0 : (day.usd / maximum) * 100}%`,
                  }}
                />
                <span className="num">
                  {money(day.usd, day.includes_unknown)}
                  {day.includes_unknown && day.usd !== "unavailable" && " (some cost unknown)"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="sec-h">
        <h2>Runs</h2>
        <span className="count plain">{data.runs.length}</span>
        {data.unreadable.length > 0 && (
          <span className="hint">
            {data.unreadable.length} metrics.json unreadable:{" "}
            {data.unreadable.map((run) => run.run).join(", ")}
          </span>
        )}
      </div>
      <ul className="list">
        {data.runs.map((run) => (
          <li
            className={`row ${selected === run.run ? "cursor" : ""}`}
            key={run.run}
            data-run-metrics={run.run}
          >
            <button className="row-main v-runs" onClick={() => setSelected(run.run)}>
              <span className="tkt">{run.run}</span>
              <span className="tag">{run.project}</span>
              <span className="muted">{run.outcome}</span>
              <span className="num">{money(run.cost_usd ?? "unavailable")}</span>
            </button>
          </li>
        ))}
      </ul>
      {open ? (
        <Detail pane={pane}>
          <div className="d-head">
            <div className="d-id">
              <span className="pill">{open.outcome}</span>
              <span className="tag">{open.project}</span>
            </div>
            <h2>{open.run}</h2>
            <dl className="kv">
              <dt>Closed</dt>
              <dd>{open.closed_at}</dd>
              <dt>Cost</dt>
              <dd>{money(open.cost_usd ?? "unavailable")}</dd>
              <dt>Wall time</dt>
              <dd>{seconds(open.wall_seconds ?? "unavailable")}</dd>
              <dt>Gate wait</dt>
              <dd>{seconds(open.gate_wait_seconds ?? "unavailable")}</dd>
              <dt>Override rate</dt>
              <dd>
                {open.override_rate === null
                  ? "not available"
                  : `${Math.round(open.override_rate * 100)}%`}
              </dd>
              <dt>Design rounds</dt>
              <dd>{open.design_rounds ?? "not available"}</dd>
            </dl>
          </div>
        </Detail>
      ) : (
        <NoItem pane={pane} />
      )}
    </>
  );
}

/* Search */

const sessionNotice: Record<string, [string, string]> = {
  disabled: [
    "Orca history is disabled. Agent sessions were not searched.",
    "These hits come from tickets, runs, plan.md and retro.md only. A session that matches is not in the list. This is not the same as no matches.",
  ],
  unavailable: [
    "Orca session search is unavailable. Agent sessions were not searched.",
    "Local hits are shown.",
  ],
  unknown: [
    "Orca did not answer. Agent sessions were not searched.",
    "Local hits are shown. Retry when Orca is running.",
  ],
};

export function Search({ filter, known, pane }: ViewProps) {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const { data, failed } = useApi<SearchAnswer>(
    asked === null ? null : `/api/search?q=${encodeURIComponent(asked)}`,
  );
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setSelected(null);
    setAsked(query.trim() === "" ? null : query.trim());
  };
  const hits = data?.hits.filter((hit) => inFilter(hit.project, filter, known)) ?? [];
  const open: Hit | undefined = selected === null ? undefined : hits[selected];
  const notice = data ? sessionNotice[data.orca.state] : undefined;
  return (
    <>
      <form className="steer" onSubmit={submit}>
        <label>
          <span className="steer-label">
            Search tickets, runs, plans, retros and agent sessions
          </span>
          <span className="steer-row">
            <input
              value={query}
              autoComplete="off"
              placeholder="Text to find"
              aria-label="Search text"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="btn primary" type="submit">
              Search
            </button>
          </span>
        </label>
      </form>
      {failed && <Banner tone="bad" title="The hub could not search." />}
      {notice && (
        <Banner tone={data?.orca.state === "disabled" ? "needs" : "bad"} title={notice[0]}>
          {notice[1]}
        </Banner>
      )}
      {data && !failed && (
        <>
          {data.orca.state === "enabled" && !data.hits.some((hit) => hit.kind === "session") && (
            <div className="hint" data-session-search="enabled">
              Agent sessions were searched: no session matches.
            </div>
          )}
          {hits.length === 0 ? (
            <div className="empty">No local matches in this scope.</div>
          ) : (
            <ul className="list">
              {hits.map((hit, index) => (
                <li
                  className={`row ${selected === index ? "cursor" : ""}`}
                  key={`${hit.kind}:${hit.title}:${index}`}
                  data-hit={hit.kind}
                >
                  <button className="row-main v-search" onClick={() => setSelected(index)}>
                    <span className="pill">{hit.kind}</span>
                    <span className="tag">{hit.project}</span>
                    <span className="ttl">{hit.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {open ? (
        <Detail pane={pane}>
          <div className="d-head">
            <div className="d-id">
              <span className="pill">{open.kind}</span>
              <span className="tag">{open.project}</span>
            </div>
            <h2>{open.title}</h2>
            {open.snippet && <p className="line-out">{open.snippet}</p>}
            <dl className="kv">
              {Object.entries(open.target).map(([name, value]) => (
                <div key={name} className="kvrow">
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Detail>
      ) : (
        <NoItem pane={pane} />
      )}
    </>
  );
}

/* Projects and settings */

export function Projects({ filter, known, perform, pane }: ViewProps) {
  const { data, failed } = useApi<ProjectsAnswer>("/api/projects");
  const [selected, setSelected] = useState<string | null>(null);
  if (failed) return <Banner tone="bad" title="The hub could not read the projects." />;
  if (data === null) return <div className="empty">Reading projects…</div>;
  const projects = data.projects.filter((project) => inFilter(project.name, filter, known));
  const open = projects.find((project) => project.name === selected);
  return (
    <>
      {projects.length === 0 && <div className="empty">No projects in this scope.</div>}
      <ul className="list">
        {projects.map((project) => (
          <li
            className={`row ${selected === project.name ? "cursor" : ""}`}
            key={project.name}
            data-project={project.name}
          >
            <button className="row-main v-projects" onClick={() => setSelected(project.name)}>
              <span className="tag">{project.name}</span>
              <span>
                {project.ticket_source ? `tickets: ${project.ticket_source}` : "ark.yml unreadable"}
              </span>
              <span className={`st s-${project.chief.state === "live" ? "working" : "idle"}`}>
                <i className="dot" />
                Master Chief {project.chief.state}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open ? (
        <Detail pane={pane}>
          <div className="d-head">
            <div className="d-id">
              <span className="tag">{open.name}</span>
            </div>
            <h2>{open.name}</h2>
            {open.error && <p className="d-story">{open.error}</p>}
            <dl className="kv">
              <dt>Ticket source</dt>
              <dd>{open.ticket_source ?? "unknown"}</dd>
              <dt>Workspace</dt>
              <dd>{open.workspace ?? "unknown"}</dd>
              <dt>Master Chief</dt>
              <dd>
                {open.chief.state === "live"
                  ? `live · ${open.chief.harness ?? "?"} · ${open.chief.model ?? "?"}`
                  : open.chief.state === "unknown"
                    ? "unknown (Orca did not answer)"
                    : "not running"}
              </dd>
            </dl>
            <div className="bar">
              {open.chief.state === "live" && (
                <OpenInOrca handle={open.chief.handle} perform={perform} />
              )}
              {open.chief.state === "missing" && (
                <button
                  className="btn primary"
                  onClick={() =>
                    void perform({
                      name: "chief-spawn",
                      label: `Spawn Master Chief for ${open.name}`,
                      params: { project: open.name },
                    })
                  }
                >
                  Spawn Master Chief
                </button>
              )}
            </div>
          </div>
          {open.roles && (
            <section className="d-sec">
              <h3>Roles (edit ark.yml by hand or through Master Chief)</h3>
              <table className="t">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Harness · model</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(open.roles).map(([role, config]) => (
                    <tr key={role}>
                      <td>{role}</td>
                      <td>
                        {config.harness} {config.model}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </Detail>
      ) : (
        <NoItem pane={pane} />
      )}
    </>
  );
}
