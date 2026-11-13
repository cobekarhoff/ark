import { flushSync } from "react-dom";
import { keyboardOrigin, reducedMotion } from "./motion.tsx";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { sourceAffects, type Snapshot, type SourceName } from "../types.ts";

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
    // Fires on every reconnect attempt: return the same object when nothing changes, so no re-render.
    source.onerror = () =>
      setLive((previous) =>
        previous.snapshot && previous.connection !== "reconnecting"
          ? { ...previous, connection: "reconnecting" }
          : previous,
      );
    // Bounded loops (pulse, dash) pause while the tab is hidden: styles.css reads this attribute.
    const markHidden = () =>
      document.documentElement.toggleAttribute("data-hidden", document.hidden);
    markHidden();
    document.addEventListener("visibilitychange", markHidden);
    return () => {
      source.close();
      document.removeEventListener("visibilitychange", markHidden);
    };
  }, []);
  return <Context value={live}>{children}</Context>;
}

export const useLive = () => useContext(Context);

const subscribeSecond = (notify: () => void) => {
  const timer = setInterval(notify, 1000);
  return () => clearInterval(timer);
};
const wholeSecond = () => Math.floor(Date.now() / 1000) * 1000;

const subscribeMinute = (notify: () => void) => {
  const timer = setInterval(notify, 60_000);
  return () => clearInterval(timer);
};
const wholeMinute = () => Math.floor(Date.now() / 60_000) * 60_000;

/**
 * One chip for every stale source: `<oldest source> stale N min`, plus `+K` for the others. Click
 * lists what each stale source affects. N = snapshot generated_at - read_at (server clock) + time
 * since the page got the snapshot (browser clock), whole minutes, ticking per minute. While the
 * stream is down the age freezes at the last snapshot: the banner says so. A source never read has
 * no age: `<source> unknown`.
 */
export function StaleChip() {
  const { snapshot, receivedAt, connection } = useLive();
  const tick = useSyncExternalStore(subscribeMinute, wholeMinute);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!snapshot) return null;
  const stale = (Object.keys(sourceAffects) as SourceName[]).filter(
    (n) => !snapshot.sources[n]?.ok,
  );
  if (stale.length === 0) return null;
  const since = connection === "live" ? Math.max(0, tick - receivedAt) : 0;
  const minutes = (name: SourceName) => {
    const readAt = snapshot.sources[name]?.read_at;
    return readAt
      ? Math.max(
          0,
          Math.floor((Date.parse(snapshot.generated_at) - Date.parse(readAt) + since) / 60_000),
        )
      : null;
  };
  // Oldest first: never-read sources have no age and lead.
  const sorted = [...stale].sort((x, y) => (minutes(y) ?? Infinity) - (minutes(x) ?? Infinity));
  const first = sorted[0]!;
  const age = minutes(first);
  const label = `${first} ${age === null ? "unknown" : `stale ${age} min`}${stale.length > 1 ? ` +${stale.length - 1}` : ""}`;
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <span
      className="stale"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className="stale-chip"
        data-testid="stale-chip"
        aria-expanded={open}
        aria-controls={open ? "stale-list" : undefined}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open ? (
        <ul id="stale-list" className="stale-list" data-testid="stale-list">
          {sorted.map((name) => {
            const m = minutes(name);
            return (
              <li key={name} data-source={name}>
                <b>{name}</b>
                <span>{m === null ? "unknown" : `${m} min`}</span>
                <span className="affects">{sourceAffects[name]}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
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
  view: "home" | "runs" | "run" | "roadmap" | "ticket" | "resources";
  run: string | null;
  /**
   * `#/run/<run>/step/<id>`, `/lead`, `/session/<file>` open a transcript; `/file/<path>` shows a run
   * file; `/conversation` is the run page's Conversation tab (no argument). Each argument is one
   * URL-encoded segment.
   */
  sub: {
    kind: "step" | "lead" | "session" | "file" | "conversation";
    arg: string | null;
  } | null;
  /** `?at=<time>` on a transcript route: the transcript opens at the entry nearest this ISO time. */
  at: string | null;
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
export const hashOf = (
  path: string,
  project: string | null = currentProject(),
  at: string | null = null,
) => {
  const query = new URLSearchParams();
  if (project !== null) query.set("project", project);
  if (at !== null) query.set("at", at);
  const text = query.toString();
  return text === "" ? path : `${path}?${text}`;
};

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
  const [, view, part, kind, ...argumentSegments] = path.split("/");
  const arg = part ? decode(part) : null;
  const none = { run: null, sub: null, at: null, arg: null, project };
  if (view === "run" && arg !== null) {
    const subKinds = ["step", "lead", "session", "file", "conversation"] as const;
    const subKind = subKinds.find((candidate) => candidate === kind);
    // A file path may hold plain slashes (`/file/findings/a.md`) or encoded ones; both name the same path.
    const subArg = argumentSegments.map(decode).join("/");
    const sub = subKind ? { kind: subKind, arg: subArg || null } : null;
    return { ...none, view, run: arg, sub, at: new URLSearchParams(query).get("at") };
  }
  if (view === "runs" || view === "run" || view === "map") return { ...none, view: "runs" };
  if (view === "roadmap" && arg === null) return { ...none, view };
  if (view === "resources" && arg === null) return { ...none, view };
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

const hashListeners = new Set<() => void>();
const pathOf = (url: string) => url.split("#")[1]?.split("?")[0] ?? "";

/**
 * One listener for every `useHash`. A route change to another path runs its render inside
 * `document.startViewTransition` (flushSync, so the new DOM is there when the callback returns),
 * unless the browser has none, reduced motion is set, or a key started the change. The project
 * filter changes only the query: no transition.
 */
function onHashChange(event: HashChangeEvent) {
  const render = () => hashListeners.forEach((notify) => notify());
  if (
    typeof document.startViewTransition !== "function" ||
    reducedMotion() ||
    keyboardOrigin() ||
    pathOf(event.oldURL) === pathOf(event.newURL)
  )
    return render();
  document.startViewTransition(() => flushSync(render));
}

const subscribeHash = (notify: () => void) => {
  if (hashListeners.size === 0) {
    addEventListener("hashchange", onHashChange);
  }
  hashListeners.add(notify);
  return () => {
    hashListeners.delete(notify);
    if (hashListeners.size === 0) {
      removeEventListener("hashchange", onHashChange);
    }
  };
};
export const useHash = () => useSyncExternalStore(subscribeHash, () => location.hash);

/** The project filter of the URL; null is All projects. */
export const useProject = () => parseRoute(useHash()).project;
