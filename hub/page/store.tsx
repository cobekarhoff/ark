import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Snapshot, SourceName } from "../types.ts";

/** `connecting` until the first snapshot; `reconnecting` when the stream dropped after one, which stays on screen. */
type Connection = "connecting" | "live" | "reconnecting";

type Live = {
  snapshot: Snapshot | null;
  /** Browser clock at the last message: the age of a source adds the time since this. */
  receivedAt: number;
  connection: Connection;
};

const initial: Live = { snapshot: null, receivedAt: 0, connection: "connecting" };
const Context = createContext<Live>(initial);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<Live>(initial);
  useEffect(() => {
    const source = new EventSource("/events");
    source.onmessage = (message) =>
      setLive({ snapshot: JSON.parse(message.data), receivedAt: Date.now(), connection: "live" });
    source.onerror = () =>
      setLive((previous) => ({
        ...previous,
        connection: previous.snapshot ? "reconnecting" : "connecting",
      }));
    return () => source.close();
  }, []);
  return <Context value={live}>{children}</Context>;
}

export const useLive = () => useContext(Context);

const subscribeSecond = (notify: () => void) => {
  const timer = setInterval(notify, 1000);
  return () => clearInterval(timer);
};
const wholeSecond = () => Math.floor(Date.now() / 1000) * 1000;

/**
 * `<source> as of N s ago` when that source did not answer its last read, `<source> unknown`
 * before its first good read. N = snapshot generated_at - read_at (server clock) + time since the
 * page got the snapshot (browser clock): no clock of the browser is compared with the server's.
 */
export function Stale({ name }: { name: SourceName }) {
  const { snapshot, receivedAt } = useLive();
  const now = useSyncExternalStore(subscribeSecond, wholeSecond);
  const status = snapshot?.sources[name];
  if (!snapshot || !status || status.ok) return null;
  const label =
    status.read_at === null
      ? `${name} unknown`
      : `${name} as of ${Math.max(
          0,
          Math.floor(
            (Date.parse(snapshot.generated_at) -
              Date.parse(status.read_at) +
              Math.max(0, now - receivedAt)) /
              1000,
          ),
        )} s ago`;
  return (
    <span className="asof" data-testid="stale-label" data-source={name}>
      {label}
    </span>
  );
}

/** Browser time in ms, ticking each second: for a time the provider names itself (a limit's reset). */
export const useNow = () => useSyncExternalStore(subscribeSecond, wholeSecond);

/**
 * Age of a server timestamp in milliseconds, ticking each second. Like `Stale`, it adds the time
 * since the page got the snapshot to `generated_at - time` (server clock), so no clock of the
 * browser is compared with the server's.
 */
export function useAge(): (time: string) => number {
  const { snapshot, receivedAt } = useLive();
  const now = useSyncExternalStore(subscribeSecond, wholeSecond);
  return (time) =>
    Math.max(
      0,
      (snapshot ? Date.parse(snapshot.generated_at) : 0) -
        Date.parse(time) +
        Math.max(0, now - receivedAt),
    );
}

/** Hash routes: client-side, so a view change never reaches the server. */
export type Route = {
  view: "home" | "runs" | "run" | "roadmap" | "ticket";
  run: string | null;
  /**
   * `#/run/<run>/step/<id>`, `/lead`, `/session/<file>` open a transcript; `/file/<path>` shows a run
   * file. Each argument is one URL-encoded segment.
   */
  sub: { kind: "step" | "lead" | "session" | "file"; arg: string | null } | null;
  /** `#/ticket/<id>`: the ticket of the page. A ticket id is taken as unique across projects. */
  arg: string | null;
  /** `?project=<name>` on every route: the site-wide project filter. The URL is its only state; null is All projects. */
  project: string | null;
};

/** The filter of the URL as the browser holds it now. Links read it at render, so every link keeps it. */
export const currentProject = (): string | null => parseRoute(location.hash).project;

/**
 * A hash for `path` (`#/runs`, `#/ticket/ARK-1`) with the project filter: the filter of the URL, or
 * `project` when the caller sets one (`null` for All projects). The one builder of every link.
 */
export const hashOf = (path: string, project: string | null = currentProject()) =>
  project === null ? path : `${path}?project=${encodeURIComponent(project)}`;

export const ticketHref = (id: string) => hashOf(`#/ticket/${encodeURIComponent(id)}`);

/** The same page with another filter: the header control keeps the route and swaps the query. */
export const withProject = (hash: string, project: string | null) =>
  hashOf(hash.split("?")[0] || "#/", project);

/** A hash that does not decode (a truncated pasted link) keeps its raw text instead of crashing. */
const decode = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/**
 * Where a retired hash goes, or null. The Map is gone, and a bare `#/run` with no run to pick: both
 * open Runs. Backlog is now Roadmap. The query (the filter) and `#/backlog/<ticket>`'s tail stay.
 */
export const retiredTarget = (hash: string): string | null =>
  /^#\/(map(\/|\?|$)|run\/?(\?|$))/.test(hash)
    ? `#/runs${hash.includes("?") ? hash.slice(hash.indexOf("?")) : ""}`
    : /^#\/backlog(\/|\?|$)/.test(hash)
      ? hash.replace("#/backlog", "#/roadmap")
      : null;

export function parseRoute(hash: string): Route {
  const [path, query = ""] = hash.split("?");
  const project = new URLSearchParams(query).get("project");
  const [, view, part, kind, subArg] = path.split("/");
  const arg = part ? decode(part) : null;
  const none = { run: null, sub: null, arg: null, project };
  if (view === "run" && arg !== null) {
    const subKinds = ["step", "lead", "session", "file"] as const;
    const subKind = subKinds.find((candidate) => candidate === kind);
    const sub = subKind ? { kind: subKind, arg: subArg ? decode(subArg) : null } : null;
    return { ...none, view, run: arg, sub };
  }
  if (view === "runs" || view === "run" || view === "map") return { ...none, view: "runs" };
  if (view === "roadmap" && arg === null) return { ...none, view };
  if ((view === "ticket" || view === "roadmap") && arg !== null)
    return { ...none, view: "ticket", arg };
  return { ...none, view: "home" };
}

export type ThemeChoice = "auto" | "light" | "dark";
const themeKey = "ark-hub-theme";

/** The saved choice. The browser keeps it: choosing a theme sends no request. */
export function savedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(themeKey);
    return value === "light" || value === "dark" ? value : "auto";
  } catch {
    return "auto";
  }
}

/** `auto` removes the pin, so `prefers-color-scheme` decides. */
export function applyTheme(choice: ThemeChoice): void {
  if (choice === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = choice;
  try {
    localStorage.setItem(themeKey, choice);
  } catch {
    // A browser that refuses storage still switches the theme for this page.
  }
}

const subscribeHash = (notify: () => void) => {
  addEventListener("hashchange", notify);
  return () => removeEventListener("hashchange", notify);
};
export const useHash = () => useSyncExternalStore(subscribeHash, () => location.hash);

/** The project filter of the URL; null is All projects. */
export const useProject = () => parseRoute(useHash()).project;
