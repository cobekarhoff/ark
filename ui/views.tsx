import type { ReactNode } from "react";

export type View =
  | "home"
  | "map"
  | "timeline"
  | "backlog"
  | "agents"
  | "metrics"
  | "search"
  | "projects";

/** The views in bar order. The key switches to the view from anywhere. */
export const views: { view: View; label: string; key: string }[] = [
  { view: "home", label: "Home", key: "1" },
  { view: "map", label: "Map", key: "2" },
  { view: "timeline", label: "Timeline", key: "3" },
  { view: "backlog", label: "Backlog", key: "4" },
  { view: "agents", label: "Agents", key: "5" },
  { view: "metrics", label: "Metrics", key: "6" },
  { view: "search", label: "Search", key: "7" },
  { view: "projects", label: "Projects and settings", key: "8" },
];

export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

export function ViewBar({ view, setView }: { view: View; setView: (view: View) => void }) {
  return (
    <nav className="vbar" aria-label="Views">
      {views.map((entry) => (
        <button
          key={entry.view}
          className="vbtn"
          data-view={entry.view}
          aria-current={entry.view === view ? "page" : undefined}
          onClick={() => setView(entry.view)}
        >
          {entry.label} <Kbd>{entry.key}</Kbd>
        </button>
      ))}
    </nav>
  );
}

/** Color tone of a state string from the Map and Timeline APIs. "unavailable" has no tone: it is hatched. */
export function stateTone(state: string): string {
  if (state === "unavailable") return "unavail";
  if (["unknown", "not_started", "missing", "pending", "stopped", "exited"].includes(state))
    return "none";
  if (["succeeded", "ok", "passing", "closed", "done"].includes(state)) return "ok";
  if (["failed", "failing", "stuck", "dead"].includes(state)) return "bad";
  if (["waiting", "queued"].includes(state)) return "waiting";
  return "working";
}

/** Time of day, with the date when it is not today. */
export function clock(time: string | number): string {
  const date = new Date(time);
  const hours = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date().toDateString()
    ? hours
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${hours}`;
}
