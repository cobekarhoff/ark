import { useEffect, useState, type ReactNode } from "react";
import type { Action, Agent, Item } from "../cli/hub/types.ts";
import { MapView } from "./map.tsx";
import { TimelineView } from "./timeline.tsx";
import { Kbd, ViewBar, type View } from "./views.tsx";
import { AbortButton, ChiefBox, RunLeadMessage } from "./steer.tsx";
import {
  agentKey,
  agentTone,
  costText,
  duration,
  heat,
  inFilter,
  kinds,
  minutesSince,
  needRun,
  notificationTime,
  otherFilter,
  phaseBars,
  phaseLabel,
  span,
  splitParts,
  stepColumns,
  stepToneOf,
  usd,
  type Filter,
  type HubState,
  type RunDetail,
  type RunView,
  type Selection,
} from "./model.ts";

type Layer = "palette" | "sheet" | null;
type PaletteEntry = {
  group: string;
  label: string;
  hint?: string;
  run: () => void;
};

function useHub(): HubState | null {
  const [state, setState] = useState<HubState | null>(null);
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (message) => setState(JSON.parse(message.data));
    return () => source.close();
  }, []);
  return state;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const Wait = ({ since, now, big }: { since: string; now: number; big?: boolean }) => {
  const minutes = minutesSince(since, now);
  return (
    <span className={`wait ${heat(minutes)}`} data-heat={heat(minutes) || "calm"} data-big={big}>
      {duration(minutes)}
      <span
        className="age"
        style={{ "--w": `${Math.min(100, (minutes / 240) * 100)}%` } as never}
      />
    </span>
  );
};

const Dots = ({ run }: { run: RunView }) => (
  <span className="dots">
    {run.steps.map((step) => (
      <i
        key={step.id}
        className={`s-${stepToneOf(step.status)} ${step.status === "running" ? "calm" : ""}`}
        title={`${step.id} · ${step.role} · ${step.status}`}
      >
        {step.role[0].toUpperCase()}
      </i>
    ))}
    {run.steps.length === 0 && <i className="ghost">plan</i>}
  </span>
);

export function App() {
  const hub = useHub();
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const [selection, setSelection] = useState<Selection>(null);
  const [view, setView] = useState<View>("home");
  const [layer, setLayer] = useState<Layer>(null);
  const [focus, setFocus] = useState(false);
  const [digestShown, setDigestShown] = useState(true);
  const [theme, setTheme] = useState(() => localStorage.getItem("ark-hub-theme") ?? "dark");
  const [toast, setToast] = useState<string | null>(null);
  const [hashTick, setHashTick] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("ark-hub-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onHashChange = () => setHashTick((tick) => tick + 1);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const known = hub?.projects.map((project) => project.name) ?? [];
  const visible = (project: string) => inFilter(project, filter, known);
  const needs = hub?.needs_me.filter((item) => visible(item.project)) ?? [];
  const runs = hub?.runs.filter((run) => run.open && visible(run.project)) ?? [];
  const agents = hub?.agents.filter((agent) => visible(agent.project)) ?? [];
  const chiefs = hub?.projects.filter((project) => visible(project.name)) ?? [];
  const notifications = hub?.notifications.filter((entry) => visible(entry.item.project)) ?? [];

  const selectedNeed =
    selection?.type === "need" ? needs.find((item) => item.id === selection.id) : undefined;
  const cursor = selectedNeed ?? (selection === null ? needs[0] : undefined);

  // A click on the macOS notification opens /#item=<id>: select that item, tell the server the human
  // acted, and clear the hash so a reload does not select again.
  useEffect(() => {
    if (hub === null || !location.hash.startsWith("#item=")) return;
    const raw = location.hash.slice("#item=".length);
    const id = (() => {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    })();
    history.replaceState(null, "", location.pathname + location.search);
    void fetch("/api/notifications/acted", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const item = hub.needs_me.find((candidate) => candidate.id === id);
    if (!item) return setToast("That item is no longer waiting on you.");
    if (!inFilter(item.project, filter, known)) setFilter("all");
    setSelection({ type: "need", id });
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-need="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  }, [hub, hashTick]);

  async function perform(action: Action | null) {
    if (action === null) return;
    const response = await fetch(`/api/actions/${action.name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action.params),
    });
    const body = (await response.json()) as { error?: string };
    setToast(response.ok ? action.label : `${action.label} failed: ${body.error}`);
  }

  function dismissDigest() {
    setDigestShown(false);
    void fetch("/api/seen", { method: "POST" });
  }

  function move(step: number) {
    if (needs.length === 0) return;
    const at = cursor ? needs.findIndex((item) => item.id === cursor.id) : -1;
    const next = needs[Math.min(needs.length - 1, Math.max(0, at + step))];
    setSelection({ type: "need", id: next.id });
  }

  function open(item: Item) {
    const run = needRun(item, hub?.runs ?? []);
    setSelection(run ? { type: "run", id: run.run } : { type: "need", id: item.id });
  }

  function cycleFilter() {
    const order = ["all", ...known, otherFilter];
    setFilter(order[(order.indexOf(filter) + 1) % order.length]);
  }

  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement;
      if (event.key === "Escape") return setLayer(null);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        return setLayer(layer === "palette" ? null : "palette");
      }
      if (typing || layer !== null || event.metaKey || event.ctrlKey || event.altKey) return;
      const viewKey = ["home", "map", "timeline"][Number(event.key) - 1] as View | undefined;
      if (viewKey) return setView(viewKey);
      // Map and Timeline read their own keys; Home's list keys must not move Home's selection there.
      if (view !== "home") {
        if (event.key === "?") setLayer("sheet");
        else if (event.key === "t") toggleTheme();
        return;
      }
      if (event.key === "j") move(1);
      else if (event.key === "k") move(-1);
      else if (event.key === "Enter" && cursor) open(cursor);
      else if (event.key === "?") setLayer("sheet");
      else if (event.key === "z") setFocus(!focus);
      else if (event.key === "t") toggleTheme();
      else if (event.key === "f") cycleFilter();
      else if (event.key === "d") dismissDigest();
      else if (cursor && event.key === kinds[cursor.kind].key) void perform(cursor.action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (hub === null) return <div className="d-empty">Connecting to the hub…</div>;
  const runPage = location.hash.startsWith("#run=")
    ? decodeURIComponent(location.hash.slice("#run=".length))
    : null;
  if (runPage !== null) return <RunPage hub={hub} run={runPage} perform={perform} />;

  const needCounts = (project: string) =>
    hub.needs_me.filter((item) => inFilter(item.project, project, known)).length;
  const gates = needs.filter((item) => item.kind === "gate");
  const oldestGate = gates.length
    ? Math.max(...gates.map((item) => minutesSince(item.since, now)))
    : 0;
  const today = new Date(now).toDateString();
  const costNumbers = hub.runs
    .filter((run) => visible(run.project) && new Date(run.last_event).toDateString() === today)
    .map((run) => run.cost.usd);
  const cost =
    filter === "all"
      ? hub.tiles.cost_today
      : costNumbers.includes("unknown")
        ? "unknown"
        : costNumbers.reduce((sum: number, value) => sum + (value as number), 0);
  const working = agents.filter((agent) => agent.liveness === "live").length;
  const stuck = agents.filter((agent) => agentTone(agent) === "bad").length;

  const entries: PaletteEntry[] = [
    ...(cursor
      ? [
          {
            group: "Actions",
            label: cursor.action?.label ?? "No action for this item",
            hint: kinds[cursor.kind].key,
            run: () => void perform(cursor.action),
          },
        ]
      : []),
    {
      group: "Actions",
      label: focus ? "Leave focus mode" : "Focus mode: only Needs me",
      hint: "z",
      run: () => setFocus(!focus),
    },
    { group: "Actions", label: "Toggle theme", hint: "t", run: toggleTheme },
    {
      group: "Actions",
      label: "Show keyboard shortcuts",
      hint: "?",
      run: () => setLayer("sheet"),
    },
    ...["all", ...known, otherFilter].map((name) => ({
      group: "Filter",
      label: `Filter: ${name === "all" ? "All projects" : name}`,
      run: () => setFilter(name),
    })),
    { group: "Go to", label: "Home", hint: "1", run: () => setView("home") },
    { group: "Go to", label: "Map", hint: "2", run: () => setView("map") },
    { group: "Go to", label: "Timeline", hint: "3", run: () => setView("timeline") },
    ...needs.map((item) => ({
      group: "Needs me",
      label: `${item.ticket ?? item.source} · ${item.title}`,
      run: () => setSelection({ type: "need", id: item.id }),
    })),
    ...runs.map((run) => ({
      group: "Runs",
      label: `${run.ticket.id} · ${run.ticket.title}`,
      run: () => setSelection({ type: "run", id: run.run }),
    })),
    ...agents.map((agent) => ({
      group: "Agents",
      label: `${agent.role} · ${agent.title}`,
      run: () =>
        setSelection({
          type: "agent",
          id: `${agent.run}:${agent.role}:${agent.title}`,
        }),
    })),
  ];

  return (
    <div className="app" data-focus={focus}>
      <main className="center" hidden={view !== "home"}>
        <header className="top">
          <h1>Ark hub</h1>
          <ViewBar view={view} setView={setView} />
          <div className="chips" role="group" aria-label="Project filter">
            {["all", ...known, otherFilter].map((name) => (
              <button
                key={name}
                className="chip"
                aria-pressed={filter === name}
                onClick={() => setFilter(name)}
              >
                {name === "all" ? "All" : name === otherFilter ? "Other" : name}
                <span className="n">{needCounts(name)}</span>
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={toggleTheme}>
            Theme <Kbd>t</Kbd>
          </button>
          <button className="btn ghost sm" onClick={() => setLayer("sheet")}>
            Shortcuts <Kbd>?</Kbd>
          </button>
        </header>

        {!focus && (
          <div className="stats" role="group" aria-label="Status">
            <button
              className="tile s-working"
              onClick={() =>
                setSelection(agents[0] ? { type: "agent", id: agentKey(agents[0]) } : null)
              }
            >
              <b className="n">
                {working}
                <small>/{agents.length}</small>
              </b>
              <span className="tx">
                <span className="l">Agents working</span>
                <span className="s">{stuck ? `${stuck} stuck or dead` : "none stuck"}</span>
              </span>
            </button>
            <button
              className={`tile ${gates.length ? "s-needs" : "plain"}`}
              onClick={() => gates[0] && setSelection({ type: "need", id: gates[0].id })}
            >
              <b className="n">{gates.length}</b>
              <span className="tx">
                <span className="l">Gates waiting</span>
                <span className="s">
                  {gates.length ? `oldest ${duration(oldestGate)}` : "none open"}
                </span>
              </span>
            </button>
            <button className="tile plain">
              <b className="n">{usd(cost as number | "unknown")}</b>
              <span className="tx">
                <span className="l">{filter === "all" ? "Cost today" : "Run cost in scope"}</span>
                <span className="s">
                  {hub.readers.orca === "unknown" ? "Orca unknown" : "Orca ok"}
                </span>
              </span>
            </button>
            <button
              className="tile plain"
              onClick={() => setSelection(runs[0] ? { type: "run", id: runs[0].run } : null)}
            >
              <b className="n">{runs.length}</b>
              <span className="tx">
                <span className="l">Live runs</span>
                <span className="s">
                  {runs.filter((run) => run.phase === "escalation").length} escalated ·{" "}
                  {runs.filter((run) => run.phase === "merge_requests_open").length} to merge
                </span>
              </span>
            </button>
          </div>
        )}

        {!focus && (
          <div className="chief">
            <span className="chief-label">Master Chief</span>
            {chiefs.map(({ name, chief }) => (
              <span className="chief-item" key={name} data-chief={chief.state}>
                <i
                  className={`dot s-${chief.state === "live" ? "working" : "idle"} ${chief.state === "live" ? "calm" : "hollow"}`}
                />
                <b>{name}</b>
                {chief.state === "live"
                  ? `live · ${chief.harness ?? "?"} · ${chief.model ?? "?"}`
                  : chief.state}
                {chief.state === "live" && (
                  <button
                    className="btn sm ghost"
                    onClick={() =>
                      void perform({
                        name: "orca-terminal-switch",
                        label: `Open ${name} Master Chief`,
                        params: { handle: chief.handle },
                      })
                    }
                  >
                    Open
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {!focus &&
          chiefs.map(({ name, chief }) => (
            <ChiefBox
              key={name}
              project={name}
              live={chief.state === "unknown" ? null : chief.state === "live"}
            />
          ))}

        <div className="scroll">
          {focus ? (
            <p className="hint">
              <span className="focus-note">Focus mode.</span> Only what needs you is shown. Press{" "}
              <Kbd>z</Kbd> to bring the rest back.
            </p>
          ) : (
            digestShown && (
              <div className="brief">
                <div className="brief-main">
                  <p className="lede">{hub.digest}</p>
                </div>
                <button className="btn ghost sm" onClick={dismissDigest}>
                  Dismiss <Kbd>d</Kbd>
                </button>
              </div>
            )
          )}

          <section aria-labelledby="needs-h">
            <div className="sec-h">
              <h2 id="needs-h">Needs me</h2>
              <span className="count">{needs.length}</span>
              <span className="hint">longest wait first · bar = age against 4 h</span>
              <span className="spacer" />
              <span className="hint">
                <Kbd>j</Kbd>
                <Kbd>k</Kbd> move <Kbd>↵</Kbd> open
              </span>
            </div>
            {needs.length === 0 ? (
              <div className="empty">Nothing is waiting on you. Master Chief has it.</div>
            ) : (
              <ul className={`list ${focus ? "big" : ""}`}>
                {needs.map((item) => {
                  const kind = kinds[item.kind];
                  const active = cursor?.id === item.id;
                  return (
                    <li
                      key={item.id}
                      className={`row need s-${kind.tone} ${active ? "cursor" : ""}`}
                      data-need={item.id}
                      aria-current={active}
                    >
                      <button
                        className="row-main needs"
                        onClick={() => setSelection({ type: "need", id: item.id })}
                        onDoubleClick={() => open(item)}
                      >
                        <span className="mk" aria-hidden="true" />
                        <span className="kindcol">
                          <span className="kind">{kind.label}</span>
                          <span className="who">
                            <span className="tag">{item.project}</span>
                            <span className="tkt muted">{item.ticket ?? item.source}</span>
                          </span>
                        </span>
                        <span className="ttl" title={item.title}>
                          {item.title}
                        </span>
                        <Wait since={item.since} now={now} big={focus} />
                      </button>
                      <button
                        className="act"
                        disabled={item.action === null}
                        title={item.action?.label}
                        data-action-key={kind.key}
                        onClick={() => void perform(item.action)}
                      >
                        <span>{kind.short}</span>
                        <Kbd>{kind.key}</Kbd>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {!focus && (
            <section aria-labelledby="runs-h">
              <div className="sec-h">
                <h2 id="runs-h">Live runs</h2>
                <span className="count plain">{runs.length}</span>
                <span className="hint">I implementer · V validator · R reviewer</span>
              </div>
              {runs.length === 0 ? (
                <div className="empty">No live runs.</div>
              ) : (
                <ul className="list">
                  {runs.map((run) => (
                    <li
                      key={run.run}
                      className={`row ${selection?.type === "run" && selection.id === run.run ? "cursor" : ""}`}
                      data-run={run.run}
                    >
                      <button
                        className="row-main runs"
                        onClick={() => setSelection({ type: "run", id: run.run })}
                      >
                        <span className="runmain">
                          <span className="t1">
                            <span className="ttl">{run.ticket.title}</span>
                            <span className="tag">{run.project}</span>
                          </span>
                          <span className="story">{run.story}</span>
                        </span>
                        <span className="pill s-working">{run.phase.replaceAll("_", " ")}</span>
                        <Dots run={run} />
                        <span
                          className="ac"
                          title={`${run.ac.passing} passing, ${run.ac.failing} failing`}
                        >
                          <b className={run.ac.passing ? "p" : "z"}>{run.ac.passing}</b>
                          <i>/</i>
                          <b className={run.ac.failing ? "f" : "z"}>{run.ac.failing}</b>
                        </span>
                        <span className="num">{usd(run.cost.usd)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {!focus && (
            <section aria-labelledby="notifs-h">
              <div className="sec-h">
                <h2 id="notifs-h">Notifications</h2>
                <span className="count plain">{notifications.length}</span>
                <span className="hint">newest first · acted = you opened the hub from it</span>
              </div>
              {notifications.length === 0 ? (
                <div className="empty">
                  {filter === "all"
                    ? "No notifications yet. A new Needs-me item sends one."
                    : `No notifications for ${filter === otherFilter ? "other projects" : filter}.`}
                </div>
              ) : (
                <>
                  <div className="colh notifs" aria-hidden="true">
                    <span />
                    <span>Time</span>
                    <span>Kind</span>
                    <span>Item</span>
                    <span>Acted</span>
                  </div>
                  <ul className="list">
                    {notifications.map((entry) => {
                      const kind = kinds[entry.item.kind];
                      return (
                        <li
                          key={entry.id}
                          className={`row s-${kind.tone}`}
                          data-notification={entry.id}
                        >
                          <button
                            className="row-main notifs"
                            onClick={() => setSelection({ type: "need", id: entry.id })}
                          >
                            <span className="mk" aria-hidden="true" />
                            <span className="muted num" title={entry.time}>
                              {notificationTime(entry.time, now)}
                            </span>
                            <span className="kind">{kind.label}</span>
                            <span className="ttl" title={entry.item.title}>
                              {entry.item.title}
                              <span className="tag">{entry.item.project}</span>
                            </span>
                            <span className={`acted ${entry.acted ? "s-ok" : "muted"}`}>
                              <i className={`dot ${entry.acted ? "" : "hollow"}`} />
                              {entry.acted ? "yes" : "no"}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>
          )}
        </div>
      </main>

      <aside className="detail" aria-label="Detail" hidden={view !== "home"}>
        <Detail hub={hub} now={now} need={cursor} selection={selection} perform={perform} />
      </aside>
      {view === "map" && (
        <MapView
          hub={hub}
          selection={selection}
          setSelection={setSelection}
          perform={perform}
          view={view}
          setView={setView}
          active={layer === null}
        />
      )}
      {view === "timeline" && (
        <TimelineView
          hub={hub}
          now={now}
          perform={perform}
          view={view}
          setView={setView}
          active={layer === null}
        />
      )}

      <footer className="status">
        <div className="achips" role="group" aria-label="Agent activity">
          {agents.map((agent) => (
            <button
              key={agentKey(agent)}
              className="achip"
              onClick={() => setSelection({ type: "agent", id: agentKey(agent) })}
              title={`${agent.title} · ${agent.liveness}`}
            >
              <i className={`dot s-${agentTone(agent)}`} />
              {agent.role}
            </button>
          ))}
          {agents.length === 0 && <span className="sum">No agents</span>}
        </div>
      </footer>

      {layer === "palette" && <Palette entries={entries} close={() => setLayer(null)} />}
      {layer === "sheet" && <Sheet close={() => setLayer(null)} />}
      <div id="toasts" role="status" aria-live="polite">
        {toast !== null && (
          <div className="toast in">
            <b>{toast}</b>
          </div>
        )}
      </div>
    </div>
  );
}

function Detail({
  hub,
  now,
  need,
  selection,
  perform,
}: {
  hub: HubState;
  now: number;
  need: Item | undefined;
  selection: Selection;
  perform: (action: Action | null) => Promise<void>;
}) {
  const run =
    selection?.type === "run"
      ? hub.runs.find((candidate) => candidate.run === selection.id)
      : undefined;
  const agent =
    selection?.type === "agent"
      ? hub.agents.find((candidate) => agentKey(candidate) === selection.id)
      : undefined;

  if (run) {
    return (
      <>
        <div className="d-head">
          <div className="d-id">
            <span className="tag">{run.project}</span>
            <span className="tkt">{run.ticket.id}</span>
          </div>
          <h2>{run.ticket.title}</h2>
          <p className="d-story">{run.story}</p>
          <div className="facts">
            <div>
              <b>
                {run.ac.passing}/{run.ac.total}
              </b>
              <span>AC passing</span>
            </div>
            <div>
              <b>round {run.round}</b>
              <span>of {run.round_budget}</span>
            </div>
            <div>
              <b>{usd(run.cost.usd)}</b>
              <span>cost</span>
            </div>
          </div>
          <div className="bar">
            <button
              className="btn sm"
              data-open-run-detail
              onClick={() => (location.hash = `run=${encodeURIComponent(run.run)}`)}
            >
              Run detail
            </button>
            {run.merge_requests.map((mergeRequest) => (
              <button
                key={mergeRequest.url}
                className="btn sm"
                onClick={() =>
                  void perform({
                    name: "open-url",
                    label: `Open ${mergeRequest.label}`,
                    params: { url: mergeRequest.url },
                  })
                }
              >
                {mergeRequest.label}
              </button>
            ))}
            {run.open && <AbortButton project={run.project} run={run.run} />}
          </div>
        </div>
        {run.open && (
          <section className="d-sec">
            <RunLeadMessage run={run.run} />
          </section>
        )}
        <section className="d-sec">
          <h3>Steps</h3>
          <table className="t">
            <tbody>
              {run.steps.map((step) => (
                <tr key={step.id}>
                  <td>{step.id}</td>
                  <td>{step.role}</td>
                  <td className="r">
                    <span className={`st s-${stepToneOf(step.status)}`}>
                      <i className="dot" />
                      {step.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        {run.agents.map((runAgent) => (
          <AgentSection key={agentKey(runAgent)} agent={runAgent} perform={perform} />
        ))}
      </>
    );
  }
  if (agent)
    return (
      <>
        <div className="d-head">
          <div className="d-id">
            <span className="tag">{agent.project}</span>
          </div>
          <h2>{agent.title}</h2>
        </div>
        <AgentSection agent={agent} perform={perform} />
      </>
    );
  if (need) {
    const kind = kinds[need.kind];
    return (
      <div className={`d-head s-${kind.tone}`}>
        <div className="d-id">
          <span className="pill">{kind.label}</span>
          <span className="tag">{need.project}</span>
          <span className="tkt">{need.ticket ?? need.source}</span>
        </div>
        <h2>{need.title}</h2>
        <div className="d-wait">
          <Wait since={need.since} now={now} big />
          <div className="since">waiting since {new Date(need.since).toLocaleTimeString()}</div>
        </div>
        <div className="bar">
          <button
            className="btn primary"
            disabled={need.action === null}
            onClick={() => void perform(need.action)}
          >
            {need.action?.label ?? "No action"} <Kbd>{kind.key}</Kbd>
          </button>
        </div>
      </div>
    );
  }
  if (selection?.type === "need")
    return <div className="d-empty">This item is no longer waiting on you.</div>;
  return (
    <div className="d-empty">
      Select a row to see it here.
      <br />
      <span className="hint">
        <Kbd>j</Kbd>
        <Kbd>k</Kbd> to move, <Kbd>↵</Kbd> to open
      </span>
    </div>
  );
}

function AgentSection({
  agent,
  perform,
}: {
  agent: Agent;
  perform: (action: Action | null) => Promise<void>;
}) {
  return (
    <section className="d-sec">
      <h3>
        {agent.role}
        <span className="r">{agent.liveness}</span>
      </h3>
      <p className="line-out">{agent.activity || agent.title}</p>
      <dl className="kv">
        <dt>Model</dt>
        <dd>{agent.model ?? "unknown"}</dd>
      </dl>
      {agent.action && (
        <div className="bar">
          <button className="btn sm" onClick={() => void perform(agent.action)}>
            {agent.action.label}
          </button>
        </div>
      )}
    </section>
  );
}

function Palette({ entries, close }: { entries: PaletteEntry[]; close: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = entries
    .filter((entry) =>
      terms.every((term) => `${entry.group} ${entry.label}`.toLowerCase().includes(term)),
    )
    .slice(0, 40);
  const choose = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    close();
    entry.run();
  };
  return (
    <div className="scrim" onClick={close}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="p-in">
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-label="Command palette search"
            placeholder="Jump to a run or agent, or run an action…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") setActive(Math.min(shown.length - 1, active + 1));
              else if (event.key === "ArrowUp") setActive(Math.max(0, active - 1));
              else if (event.key === "Enter") choose(shown[active]);
              else return;
              event.preventDefault();
            }}
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="p-list" role="listbox" aria-label="Results">
          {shown.map((entry, index) => (
            <div
              key={`${entry.group}:${entry.label}`}
              role="option"
              aria-selected={index === active}
              className={`p-item ${index === active ? "active" : ""}`}
              onClick={() => choose(entry)}
            >
              <span />
              <span className="lb">{entry.label}</span>
              <span className="sb">{entry.group}</span>
              {entry.hint ? <Kbd>{entry.hint}</Kbd> : <span />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const shortcuts: [string, [string, string[]][]][] = [
  [
    "Anywhere",
    [
      ["Command palette", ["⌘", "K"]],
      ["This sheet", ["?"]],
      ["Close", ["esc"]],
      ["Focus mode: only Needs me", ["z"]],
      ["Toggle theme", ["t"]],
      ["Cycle project filter", ["f"]],
      ["Dismiss summary", ["d"]],
    ],
  ],
  [
    "Needs me",
    [
      ["Move down / up", ["j", "k"]],
      ["Open the item's run", ["↵"]],
      ["Gate or ticket: Plannotator", ["p"]],
      ["MR or agent: open", ["o"]],
      ["Question: Inbox", ["i"]],
      ["Retro: answer", ["r"]],
    ],
  ],
  [
    "Views",
    [
      ["Home, Map, Timeline", ["1", "2", "3"]],
      ["Map: move between nodes", ["j", "k"]],
      ["Map: dim other nodes on/off", ["v"]],
      ["Map: replay previous / next event", ["[", "]"]],
      ["Map: back to live", ["l"]],
      ["Timeline: zoom 1h, 12h, 24h", ["w"]],
      ["Timeline: cost burn", ["b"]],
    ],
  ],
];

function Sheet({ close }: { close: () => void }) {
  return (
    <div className="scrim" onClick={close}>
      <div
        className="dialog sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="sheet-title">Keyboard shortcuts</h2>
        <div className="cols">
          {shortcuts.map(([title, rows]) => (
            <div key={title}>
              <h3>{title}</h3>
              {rows.map(([text, keys]) => (
                <div className="k" key={text}>
                  <span>{text}</span>
                  <span>
                    {keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="foot">
          <button className="btn" onClick={close}>
            Close <Kbd>esc</Kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Run detail for one run: the pushed detail for open runs, one fetch for closed ones. */
function useRunDetail(hub: HubState, run: string): RunDetail | null | "missing" {
  const pushed = hub.details[run];
  const [fetched, setFetched] = useState<RunDetail | null | "missing">(null);
  useEffect(() => {
    if (pushed) return;
    setFetched(null);
    void fetch(`/api/runs/${encodeURIComponent(run)}`).then(async (response) =>
      setFetched(response.ok ? ((await response.json()) as RunDetail) : "missing"),
    );
  }, [run, pushed === undefined]);
  return pushed ?? fetched;
}

const Panel = ({
  section,
  title,
  hint,
  children,
}: {
  section: string;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) => (
  <section className="rd-panel" data-detail-section={section} aria-label={title}>
    <header>
      <h2>{title}</h2>
      {hint && <span className="hint">{hint}</span>}
    </header>
    <div className="rd-body">{children}</div>
  </section>
);

const NotAvailable = ({ what }: { what: string }) => (
  <div className="rd-na-box" data-state="not available">
    <b>Not available</b>
    {what} was not written for this run, or the file could not be read.
  </div>
);

const Status = ({ status, tone }: { status: string; tone: string }) => (
  <span className={`st s-${tone}`}>
    <i className={`dot ${tone === "idle" ? "hollow" : ""}`} />
    {status}
  </span>
);

function RunPage({
  hub,
  run,
  perform,
}: {
  hub: HubState;
  run: string;
  perform: (action: Action | null) => Promise<void>;
}) {
  const detail = useRunDetail(hub, run);
  const view = hub.runs.find((candidate) => candidate.run === run);
  const crumb = (
    <div className="rd-crumb">
      <a href="#">Runs</a>
      <span>/</span>
      <span className="mono">{run}</span>
    </div>
  );
  if (detail === null || detail === "missing")
    return (
      <div className="rd" data-run-detail={run}>
        {crumb}
        <div className="d-empty">{detail === null ? "Loading run…" : "No such run."}</div>
      </div>
    );
  const lead = detail.agents.find((agent) => agent.role === "run lead" && agent.terminal);
  const openGates = detail.gates.filter((gate) => gate.answered === null).length;
  const tone = stepToneOf(detail.steps.find((step) => step.status === "running")?.status ?? "");
  const bars = phaseBars(detail);
  const barTotal = bars.reduce((sum, bar) => sum + bar.seconds, 0) || 1;
  const parts = splitParts(detail.time_split);
  const stepFor = (criterion: string) =>
    detail.steps.filter((step) => step.criteria.includes(criterion)).map((step) => step.id);

  return (
    <div className="rd" data-run-detail={run} data-phase={detail.phase}>
      {crumb}
      <div className={`rd-head s-${tone}`}>
        <span className="tkt">{detail.ticket.id}</span>
        <h1>{detail.ticket.title}</h1>
        <span className="pill s-working" data-detail-phase>
          {phaseLabel(detail.phase)}
        </span>
        <span className="spacer" />
        {lead && (
          <button
            className="btn"
            onClick={() =>
              void perform({
                name: "orca-terminal-switch",
                label: "Open run lead terminal",
                params: { handle: lead.terminal },
              })
            }
          >
            Open run lead terminal
          </button>
        )}
      </div>
      <div className="rd-facts" data-detail-section="facts">
        <div>
          <span>Phase</span>
          <b>{phaseLabel(detail.phase)}</b>
        </div>
        <div>
          <span>Round</span>
          <b>{view ? `r${view.round} / ${view.round_budget}` : "?"}</b>
        </div>
        <div>
          <span>Wall time</span>
          <b data-detail-wall>{span(detail.wall_seconds)}</b>
        </div>
        <div>
          <span>Cost so far</span>
          <b data-detail-cost>{costText(detail.cost)}</b>
        </div>
        <div>
          <span>Waiting on you</span>
          <b>
            {openGates} open · {detail.gates.length - openGates} closed
          </b>
        </div>
      </div>

      <Panel section="time-split" title="Where the time went">
        <div
          className="rd-split"
          role="img"
          aria-label={parts.map((part) => `${part.label} ${span(part.seconds)}`).join(", ")}
        >
          {parts
            .filter((part) => part.seconds > 0)
            .map((part) => (
              <i
                key={part.key}
                className={part.tone === "na" ? "na" : `s-${part.tone}`}
                style={{ flex: part.seconds }}
                title={`${part.label} ${span(part.seconds)}`}
                data-split={part.key}
              />
            ))}
        </div>
        <div className="rd-split-l">
          {parts.map((part) => (
            <div key={part.key} className="rd-split-row" data-split-row={part.key}>
              <span className={`rd-sw ${part.tone === "na" ? "na" : `s-${part.tone}`}`} />
              <span>
                {part.label}
                {part.note && <span className="faint"> · {part.note}</span>}
              </span>
              <span className="rd-v">
                {span(part.seconds)} · {part.percent}%
              </span>
            </div>
          ))}
        </div>
        <div className="hint">
          Percentages cover the whole wall time. The unavailable segment is never guessed into
          another bucket.
        </div>
      </Panel>

      <Panel section="timeline" title="Phase timeline" hint="gate waits hatched · rounds below">
        <div className="rd-ph">
          {bars.map((bar, i) => (
            <div
              key={`${bar.phase}-${i}`}
              className={`${bar.gate ? "gate" : ""} ${bar.current ? "now" : ""}`}
              style={{ flex: Math.max(bar.seconds / barTotal, 0.04) }}
              data-phase-bar={bar.phase}
            >
              <b>{bar.label}</b>
              <span>{span(bar.seconds)}</span>
            </div>
          ))}
        </div>
        <table className="t" data-detail-table="gates">
          <thead>
            <tr>
              <th>Gate</th>
              <th>Asked</th>
              <th>Answered</th>
              <th className="r">Waited</th>
            </tr>
          </thead>
          <tbody>
            {detail.gates.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No gate asked yet.
                </td>
              </tr>
            )}
            {detail.gates.map((gate) => (
              <tr key={`${gate.gate}-${gate.asked}`} data-gate={gate.gate}>
                <td>{gate.gate}</td>
                <td className="mono">{new Date(gate.asked).toLocaleTimeString()}</td>
                <td className="mono">
                  {gate.answered
                    ? `${new Date(gate.answered).toLocaleTimeString()}${gate.answer ? ` · ${gate.answer}` : ""}`
                    : "open"}
                </td>
                <td className="r mono">{span(gate.wait_seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="t" data-detail-table="rounds">
          <thead>
            <tr>
              <th>Round</th>
              <th>Started</th>
              <th>Steps</th>
            </tr>
          </thead>
          <tbody>
            {detail.rounds.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No round started yet.
                </td>
              </tr>
            )}
            {detail.rounds.map((round) => (
              <tr key={round.round} data-round={round.round}>
                <td>r{round.round}</td>
                <td className="mono">{new Date(round.at).toLocaleTimeString()}</td>
                <td className="mono">{round.steps.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <div className="rd-cols">
        <Panel section="step-graph" title="Step graph" hint="edges = needs">
          <div className="rd-graph">
            {stepColumns(detail.steps).map((column, i) => (
              <div className="rd-graph-part" key={column[0].id}>
                {i > 0 && <i className="rd-edge" />}
                <div className="rd-col">
                  {column.map((step) => (
                    <div
                      key={step.id}
                      className={`rd-node s-${stepToneOf(step.status)} ${step.status === "pending" ? "todo" : ""}`}
                      data-step-node={step.id}
                      data-needs={step.needs.join(" ")}
                    >
                      <b>{step.id}</b>
                      <span>
                        {step.role} · {step.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel section="step-list" title="Steps" hint="cost and wall time per step">
          <table className="t">
            <thead>
              <tr>
                <th>Step</th>
                <th>State</th>
                <th className="r">Wall</th>
                <th className="r">Cost</th>
              </tr>
            </thead>
            <tbody>
              {detail.steps.map((step) => (
                <tr key={step.id} data-step={step.id}>
                  <td className="mono">{step.id}</td>
                  <td>
                    <Status status={step.status} tone={stepToneOf(step.status)} />
                  </td>
                  <td className="r mono" data-step-wall>
                    {span(step.wall_seconds)}
                  </td>
                  <td className="r mono" data-step-cost>
                    {costText(step.cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel
        section="ac-proof"
        title="Acceptance criteria proof"
        hint="latest test.completed joined with results/"
      >
        {detail.ac_proof.state === "not available" ? (
          <NotAvailable what="A test run (test.completed)" />
        ) : (
          <table className="t" data-detail-table="ac-proof">
            <thead>
              <tr>
                <th>AC</th>
                <th>Step</th>
                <th>Proof</th>
                <th>Report</th>
              </tr>
            </thead>
            <tbody>
              {detail.ac_proof.criteria.map((criterion) => {
                const reports = [...new Set(criterion.cases.map((found) => found.report))];
                return (
                  <tr key={criterion.id} data-ac={criterion.id} data-proof={criterion.status}>
                    <td className="rd-ac-id">{criterion.id}</td>
                    <td className="mono">{stepFor(criterion.id).join(", ") || "–"}</td>
                    <td>
                      <Status
                        status={criterion.status}
                        tone={
                          criterion.status === "passing"
                            ? "ok"
                            : criterion.status === "failing"
                              ? "bad"
                              : "idle"
                        }
                      />{" "}
                      <span className="rd-tests">
                        {criterion.cases.filter((found) => found.status === "passed").length} of{" "}
                        {criterion.cases.length}
                        {criterion.cases.some((found) => found.status === "unavailable") &&
                          " · report unavailable"}
                      </span>
                    </td>
                    <td className="mono" data-ac-report>
                      {reports.length ? reports.join(", ") : "–"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="rd-cols">
        <Panel section="plan" title="Plan" hint="plan.md">
          {detail.plan.state === "ok" ? (
            <div className="rd-doc" dangerouslySetInnerHTML={{ __html: detail.plan.html }} />
          ) : (
            <NotAvailable what="plan.md" />
          )}
        </Panel>
        <Panel section="strategies" title="Strategies" hint="strategies.md">
          {detail.strategies.state === "ok" ? (
            detail.strategies.cards.map((card) => (
              <div className="rd-card" key={card.id} data-strategy={card.id}>
                <b>
                  {card.id} {card.title}
                </b>
                {card.chosen && <span className="pill s-ok">chosen</span>}
                {card.recommended && <span className="pill s-working">recommended</span>}
                <div className="hint">{card.approach}</div>
                {card.mockups.map((mockup) => (
                  <div className="hint mono" key={mockup.path}>
                    {mockup.path}
                    {mockup.exists ? "" : " (missing)"}
                  </div>
                ))}
              </div>
            ))
          ) : (
            <NotAvailable what="strategies.md" />
          )}
        </Panel>
      </div>

      <Panel section="evaluation" title="Evaluation" hint="evaluation.md">
        {detail.evaluation.state === "ok" ? (
          <div className="rd-doc">
            {(["blockers", "risks", "surfaces"] as const).map((name) => (
              <div key={name} data-evaluation={name}>
                <h4>{name}</h4>
                {detail.evaluation.state === "ok" && detail.evaluation[name].length ? (
                  <ul>
                    {detail.evaluation[name].map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="muted">None.</div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <NotAvailable what="evaluation.md" />
        )}
      </Panel>

      <Panel
        section="live-agents"
        title="Live agents"
        hint="last 20 lines per terminal · refreshed with the hub · an unreadable terminal is unknown, never empty"
      >
        {!detail.agents_known && (
          <div className="rd-unk" data-state="unknown">
            Orca did not answer: agents unknown.
          </div>
        )}
        <div className="rd-agents">
          {detail.agents.map((agent) => (
            <article
              key={`${agent.role}:${agent.title}`}
              className={`rd-agent s-${agentTone(agent)}`}
              data-agent={agent.title}
            >
              <header>
                <i className="dot" />
                <b>{agent.title}</b>
                <span className="spacer" />
                <span className="pill">{agent.liveness}</span>
              </header>
              <div className="rd-meta">
                <span>
                  wall <b data-agent-wall>{span(agent.wall_seconds)}</b>
                </span>
                <span>
                  cost <b data-agent-cost>{costText(agent.cost)}</b>
                </span>
                <span>{agent.terminal ?? ""}</span>
              </div>
              {agent.output === "unknown" ? (
                <pre className="rd-out" data-output="unknown">
                  <em>Output unknown.</em>
                </pre>
              ) : (
                <pre className="rd-out" data-output="lines">
                  {agent.output.length ? agent.output.slice(-20).join("\n") : "(no output)"}
                </pre>
              )}
            </article>
          ))}
        </div>
      </Panel>

      {/* ark worktree sync did not land a run-lead-message component in this tree; ARK-177 fills this slot. */}
      <section
        className="rd-slot"
        data-slot="run-lead-message"
        data-detail-section="run-lead-message"
        aria-label="Run-lead message (ARK-177)"
      >
        <span className="tag">ARK-177</span>
        <div>
          <b>Run-lead message (ARK-177)</b>
          <div className="hint">Empty slot. ARK-177 renders its message component here.</div>
        </div>
      </section>
    </div>
  );
}
