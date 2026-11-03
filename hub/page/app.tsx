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
          {connected ? "live" : "connecting…"} · read-only
        </span>
        <span className="asof-list">
          {sourceNames.map((name) => (
            <Stale key={name} name={name} />
          ))}
        </span>
      </header>
      <main id="main" tabIndex={-1}>
        {route.view === "home" && <Home />}
        {route.view === "run" && <Run run={route.run} />}
        {route.view === "backlog" && <Backlog />}
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

export const App = () => (
  <LiveProvider>
    <Shell />
  </LiveProvider>
);
