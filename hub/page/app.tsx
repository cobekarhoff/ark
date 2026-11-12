import { Component, useEffect, useState, type ReactNode } from "react";
import { Roadmap } from "./Roadmap.tsx";
import {
  costByDay,
  dayOf,
  highestUsage,
  nearLimit,
  percent,
  projectsOf,
  scoped,
} from "./derive.ts";
import { Home } from "./Home.tsx";
import { known } from "./format.tsx";
import { Run } from "./Run.tsx";
import { Runs } from "./Runs.tsx";
import {
  LiveProvider,
  Stale,
  applyTheme,
  hashOf,
  parseRoute,
  retiredTarget,
  withProject,
  savedTheme,
  useHash,
  useLive,
  type ThemeChoice,
} from "./store.tsx";
import { TicketPage } from "./Ticket.tsx";
import type { SourceName } from "../types.ts";

const sourceNames: SourceName[] = [
  "ark",
  "orca",
  "plannotator",
  "github",
  "usage",
  "providerLimits",
  "agentWait",
  "evidence",
  "queue",
];

const views = [
  ["home", "#/", "Home"],
  ["runs", "#/runs", "Runs"],
  ["roadmap", "#/roadmap", "Roadmap"],
] as const;

const themes: [ThemeChoice, string][] = [
  ["auto", "Auto"],
  ["light", "Light"],
  ["dark", "Dark"],
];

/** Auto follows `prefers-color-scheme`; Light and Dark pin it. The choice stays in this browser. */
function ThemeSwitch() {
  const [choice, setChoice] = useState(savedTheme);
  return (
    <div className="seg" role="group" aria-label="Theme">
      {themes.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={choice === value}
          onClick={() => {
            setChoice(value);
            applyTheme(value);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** The one project filter of the site: All projects, or one project. The URL holds it; a click sets the URL. */
function ProjectFilter({ projects, project }: { projects: string[]; project: string | null }) {
  const pick = (name: string | null) => () => {
    location.hash = withProject(location.hash, name);
  };
  return (
    <div className="seg" role="group" aria-label="Project">
      <button type="button" aria-pressed={project === null} onClick={pick(null)}>
        All projects
      </button>
      {projects.map((name) => (
        <button
          key={name}
          type="button"
          className="mono"
          aria-pressed={project === name}
          onClick={pick(name)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

function Shell() {
  const hash = useHash();
  const route = parseRoute(hash);
  const { snapshot: whole, connection } = useLive();
  // The Map is gone: its old links land on Runs. Backlog is now Roadmap. Both keep the query and the tail.
  useEffect(() => {
    const target = retiredTarget(location.hash);
    if (target) location.replace(target);
  }, [hash]);
  // The header counts follow the filter; the limit is per account and does not.
  const snapshot = whole ? scoped(whole, route.project) : null;
  const projects = whole ? projectsOf(whole) : [];
  const needs =
    snapshot && known(snapshot.gates)
      ? snapshot.gates.length +
        (known(snapshot.runs) ? snapshot.runs.reduce((sum, run) => sum + run.waiting.length, 0) : 0)
      : 0;
  const top = whole ? highestUsage(whole.provider_limits) : null;
  const today = snapshot ? (costByDay(snapshot).get(dayOf(new Date())) ?? 0) : null;
  const current = route.view === "run" ? "runs" : route.view === "ticket" ? "roadmap" : route.view;
  return (
    <>
      <a className="skip" href="#main" onClick={(event) => skipTo(event)}>
        Skip to main content
      </a>
      <header className="top">
        <b className="brand">ark hub</b>
        <nav aria-label="Views">
          {views.map(([view, href, label]) => (
            <a
              key={view}
              className="tab"
              href={hashOf(href)}
              aria-current={current === view ? "page" : undefined}
            >
              {label}
              {view === "home" && needs > 0 ? (
                <span className="badge" aria-label={`${needs} need you`}>
                  {needs}
                </span>
              ) : null}
            </a>
          ))}
        </nav>
        <div className="nav-right">
          <ProjectFilter projects={projects} project={route.project} />
          <span
            className="chip"
            data-testid="master-chief"
            title={
              connection === "live"
                ? "live"
                : connection === "reconnecting"
                  ? "reconnecting… showing the last snapshot"
                  : "connecting…"
            }
          >
            <i className={connection === "live" ? "live dot" : "dot"} />
            Master Chief · {snapshot && known(snapshot.runs) ? snapshot.runs.length : "?"} runs
          </span>
          {top && top.used_fraction !== null ? (
            <span className={nearLimit(top) ? "chip alarm" : "chip"} data-testid="nav-usage">
              {top.provider} {top.window} <b>{percent(top.used_fraction)}%</b> · all projects
            </span>
          ) : null}
          {today === null ? null : (
            <span className="mono" data-testid="nav-cost">
              ${today.toFixed(2)} today
            </span>
          )}
          <ThemeSwitch />
        </div>
        <span className="asof-list" role="status" aria-label="Stale sources">
          {sourceNames.map((name) => (
            <Stale key={name} name={name} />
          ))}
        </span>
      </header>
      <main id="main" tabIndex={-1}>
        {route.view === "home" ? <Home /> : null}
        {route.view === "runs" ? <Runs /> : null}
        {route.view === "run" ? <Run run={route.run!} sub={route.sub} /> : null}
        {route.view === "roadmap" ? <Roadmap /> : null}
        {route.view === "ticket" ? <TicketPage id={route.arg!} /> : null}
      </main>
    </>
  );
}

/** The skip link must not change the hash: the hash is the route. */
function skipTo(event: React.MouseEvent) {
  event.preventDefault();
  document.getElementById("main")?.focus();
}

/**
 * A crash in a view must not leave a blank page: it shows the error and a way out. The error clears
 * when the hash changes, so a bad link never traps the tab.
 */
class Boundary extends Component<
  { resetKey: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError = (error: Error) => ({ error });
  componentDidUpdate(previous: { resetKey: string }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey)
      this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main role="alert">
        <h1>This page failed</h1>
        <p className="mut">
          {this.state.error.message}. <button onClick={() => location.reload()}>Reload</button>{" "}
          <a href={hashOf("#/")}>Home</a>
        </p>
      </main>
    );
  }
}

export function App() {
  const hash = useHash();
  return (
    <Boundary resetKey={hash}>
      <LiveProvider>
        <Shell />
      </LiveProvider>
    </Boundary>
  );
}
