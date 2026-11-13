import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** A graph is never drawn below this scale: smaller text is unreadable. Below it the box scrolls. */
export const minScale = 0.6;
/** Room around the graph, matched by `.gv-scroll` padding. */
const padding = 8;

const focusable = 'a[href], button:not(:disabled), [tabindex="0"]';

/**
 * Fit, 100% and Full screen around one graph of `width` x `height` pixels. The graph is drawn at its
 * own size and scaled with a CSS transform, so HTML cards and SVG scale together; the box is sized to
 * the scaled graph, because a transform does not change what scrolls. Fit is width only: a tall graph
 * keeps its scale and scrolls down. Full screen moves this one graph into a fixed layer (no second
 * copy, so test ids stay unique), closes on Esc, Close and a route change, and returns the focus.
 */
export function GraphViewport({
  width,
  height,
  label,
  scrollClass,
  focusY = null,
  children,
}: {
  width: number;
  height: number;
  /** Names the scroll region and the dialog. */
  label: string;
  /** Class of the scroll box in the page; the overlay lifts its height limit. */
  scrollClass: string;
  /** Unscaled y of a spot to keep in the middle of the box, such as the running step. */
  focusY?: number | null;
  /** A function receives the zoom mode, for a graph that draws fewer marks at Fit. */
  children: ReactNode | ((mode: "fit" | "actual") => ReactNode);
}) {
  const [full, setFull] = useState(false);
  const [mode, setMode] = useState<"fit" | "actual">("fit");
  const [available, setAvailable] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const fullButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const wasFull = useRef(false);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth - 2 * padding);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [full]);

  const fit = available > 0 ? Math.min(1, Math.max(minScale, available / width)) : 1;
  const scale = mode === "fit" ? fit : 1;

  useEffect(() => {
    const element = scroll.current;
    if (!element || focusY === null) return;
    element.scrollTop = Math.max(0, focusY * scale - element.clientHeight / 2);
    // Only when the spot or the scale moves, never on each snapshot: the reader may have scrolled.
  }, [focusY, scale, full]);

  useEffect(() => {
    if (full) closeButton.current?.focus();
    else if (wasFull.current) fullButton.current?.focus();
    wasFull.current = full;
  }, [full]);

  useEffect(() => {
    if (!full) return;
    const close = () => setFull(false);
    // Capture, so the page's own Esc handler (ticket page: back to the Roadmap) never sees it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (event.key !== "Tab" || !root.current) return;
      const stops = [...root.current.querySelectorAll<HTMLElement>(focusable)];
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (!stops.includes(active as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    addEventListener("keydown", onKey, true);
    // A node is a hash link: the route changes under an overlay that is component state.
    addEventListener("hashchange", close);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      removeEventListener("keydown", onKey, true);
      removeEventListener("hashchange", close);
      document.body.style.overflow = overflow;
    };
  }, [full]);

  return (
    <div
      ref={root}
      className={full ? "gv full" : "gv"}
      data-testid="graph-viewport"
      data-scale={scale.toFixed(3)}
      data-mode={mode}
      role={full ? "dialog" : undefined}
      aria-modal={full ? true : undefined}
      aria-label={full ? `${label}, full screen` : undefined}
    >
      <div className="gv-bar">
        <div className="seg" role="group" aria-label="Zoom">
          <button type="button" aria-pressed={mode === "fit"} onClick={() => setMode("fit")}>
            Fit
          </button>
          <button type="button" aria-pressed={mode === "actual"} onClick={() => setMode("actual")}>
            100%
          </button>
        </div>
        <span className="gv-scale mono" aria-live="off">
          {Math.round(scale * 100)}%
        </span>
        {full ? (
          <button ref={closeButton} type="button" className="btn" onClick={() => setFull(false)}>
            Close
          </button>
        ) : (
          <button
            ref={fullButton}
            type="button"
            className="btn"
            onClick={() => {
              setMode("fit");
              setFull(true);
            }}
          >
            Full screen
          </button>
        )}
      </div>
      <div
        ref={scroll}
        className={`gv-scroll ${scrollClass}`}
        tabIndex={0}
        role="region"
        aria-label={`${label}, scrollable`}
      >
        <div className="gv-box" style={{ width: width * scale, height: height * scale }}>
          <div
            className="gv-graph"
            style={{ width, height, transform: `scale(${scale})`, transformOrigin: "0 0" }}
          >
            {typeof children === "function" ? children(mode) : children}
          </div>
        </div>
      </div>
    </div>
  );
}
