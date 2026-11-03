import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Snapshot, SourceName } from "../types.ts";

type Live = {
  snapshot: Snapshot | null;
  /** Browser clock at the last message: the age of a source adds the time since this. */
  receivedAt: number;
  connected: boolean;
};

const Context = createContext<Live>({ snapshot: null, receivedAt: 0, connected: false });

/** The only connection of the page: one EventSource on /events. Views read it; none fetches. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<Live>({ snapshot: null, receivedAt: 0, connected: false });
  useEffect(() => {
    const source = new EventSource("/events");
    source.onmessage = (message) =>
      setLive({ snapshot: JSON.parse(message.data), receivedAt: Date.now(), connected: true });
    source.onerror = () => setLive((previous) => ({ ...previous, connected: false }));
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

export const sourceNames: SourceName[] = ["ark", "orca", "plannotator", "github", "usage"];

/** Hash routes: client-side, so a view change never reaches the server. */
export type Route = {
  view: "home" | "run" | "backlog" | "map";
  run: string | null;
  /** `#/backlog/<ticket>` marks a row; `#/map/finished` shows finished tickets. */
  arg: string | null;
};

/** A hash that does not decode (a truncated pasted link) keeps its raw text instead of crashing. */
const decode = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

export function parseRoute(hash: string): Route {
  const [, view, part] = hash.split("/");
  const arg = part ? decode(part) : null;
  if (view === "run") return { view, run: arg, arg: null };
  if (view === "backlog" || view === "map") return { view, run: null, arg };
  return { view: "home", run: null, arg: null };
}

const subscribeHash = (notify: () => void) => {
  addEventListener("hashchange", notify);
  return () => removeEventListener("hashchange", notify);
};
export const useHash = () => useSyncExternalStore(subscribeHash, () => location.hash);
