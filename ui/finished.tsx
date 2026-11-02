import { useEffect, useState } from "react";

type Kind = "ticket" | "agent" | "run";

/** Finished work: a done or superseded ticket, an exited agent, a closed run that needs nothing from the human. */
export function isFinished(
  kind: Kind,
  item: { status?: string; state?: string; needs_you?: number },
): boolean {
  if (kind === "ticket") return item.status === "done" || item.status === "superseded";
  if (kind === "agent") return item.state === "exited";
  return item.state === "closed" && item.needs_you === 0;
}

const changed = "ark-finished-change";
const keys = () => location.hash.slice(1).split("&").filter(Boolean);
const readOn = () => keys().includes("finished=1");

/** The toggle is the hash key `finished=1`. Other hash keys stay; the key goes away when off. */
export function useShowFinished(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readOn);
  useEffect(() => {
    const sync = () => setOn(readOn());
    window.addEventListener("hashchange", sync);
    window.addEventListener(changed, sync);
    sync();
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener(changed, sync);
    };
  }, []);
  const set = (next: boolean) => {
    const rest = keys().filter((key) => key !== "finished=1");
    const hash = (next ? [...rest, "finished=1"] : rest).join("&");
    history.replaceState(null, "", location.pathname + location.search + (hash ? `#${hash}` : ""));
    window.dispatchEvent(new Event(changed));
  };
  return [on, set];
}

export function FinishedToggle({
  on,
  set,
  hidden,
  label,
}: {
  on: boolean;
  set: (on: boolean) => void;
  hidden: number;
  /** Text of the off state; the Map says "Show finished" without a count. */
  label?: string;
}) {
  return (
    <button className="btn sm" aria-pressed={on} onClick={() => set(!on)}>
      {on ? "Hide finished" : (label ?? `Show finished (${hidden} hidden)`)}
    </button>
  );
}

/** Empty-state text that names the hidden count, with the Show finished button. */
export function EmptyFinished({
  plain,
  what,
  hidden,
  set,
}: {
  plain: string;
  what: string;
  hidden: number;
  set: (on: boolean) => void;
}) {
  if (hidden === 0) return <div className="empty">{plain}</div>;
  return (
    <div className="empty">
      {what} {hidden} finished hidden.{" "}
      <button className="btn sm" onClick={() => set(true)}>
        Show finished
      </button>
    </div>
  );
}
