import { Component, type ReactNode } from "react";
import { Backlog } from "./Backlog.tsx";
import { Home } from "./Home.tsx";
import { MapView } from "./Map.tsx";
import { Run } from "./Run.tsx";
import { LiveProvider, Stale, parseRoute, sourceNames, useHash, useLive } from "./store.tsx";

const views = [
  ["home", "#/", "Home"],
  ["run", "#/run", "Run"],
  ["backlog", "#/backlog", "Backlog"],
  ["map", "#/map", "Map"],
] as const;

function Shell() {
  const route = parseRoute(useHash());
  const { snapshot, connected } = useLive();
  const projects = Array.isArray(snapshot?.tickets)
    ? [...new Set(snapshot.tickets.map((ticket) => ticket.project))].sort()
    : [];
  return (
    <>
      <a className="skip" href="#main" onClick={(event) => skipTo(event)}>
        Skip to main content
      </a>
      <header>
        <b>ark hub</b>
        <nav aria-label="Views">
          {views.map(([view, href, label]) => (
            <a key={view} href={href} aria-current={route.view === view ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <span className="mut">
          {projects.length > 0 ? `project ${projects.join(", ")} · ` : ""}
          {connected ? "live" : "connecting…"} · view only · focuses Orca
        </span>
        <span className="asof-list">
          {sourceNames.map((name) => (
            <Stale key={name} name={name} />
          ))}
        </span>
      </header>
      <main id="main" tabIndex={-1}>
        {route.view === "home" && <Home />}
        {route.view === "run" && <Run run={route.run} sub={route.sub} />}
        {route.view === "backlog" && <Backlog focus={route.arg} />}
        {route.view === "map" && <MapView />}
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
          <a href="#/">Home</a>
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
