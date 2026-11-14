import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";

/** Script-driven motion (FLIP, view transitions) is not under the CSS rule, so it asks here. */
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A keyboard action does not animate its own result: a result this soon after a key, with no
 * pointer press since, is one. One check for the view transition, FLIP and the highlight.
 */
const keyboardWindowMs = 500;
let lastKeyAt = -Infinity;
addEventListener("keydown", () => (lastKeyAt = performance.now()), true);
addEventListener("pointerdown", () => (lastKeyAt = -Infinity), true);
export const keyboardOrigin = () => performance.now() - lastKeyAt < keyboardWindowMs;

/** A change flashes for this long: the length of the `hl` keyframes in styles.css. */
const highlightMs = 600;
/** FLIP duration: the AC caps it at 250 ms. */
const flipMs = 250;

/**
 * Keys whose value changed since the previous render with other values, for `highlightMs`. The first
 * render is the baseline and flashes nothing, so opening a view, or the first snapshot, highlights
 * nothing; an unchanged push changes no value and flashes nothing. Compare by value, never identity.
 */
export function useChanges(values: Map<string, string>): ReadonlySet<string> {
  const previous = useRef<Map<string, string> | null>(null);
  const [hot, setHot] = useState<ReadonlySet<string>>(new Set());
  // A string dependency: the effect runs when a value changes, not on each tick re-render.
  const signature = JSON.stringify([...values]);
  useEffect(() => {
    const before = previous.current;
    previous.current = values;
    if (!before) return;
    const changed = [...values].filter(([key, value]) => before.get(key) !== value);
    if (changed.length === 0 || keyboardOrigin() || reducedMotion()) return setHot(new Set());
    setHot(new Set(changed.map(([key]) => key)));
    const timer = setTimeout(() => setHot(new Set()), highlightMs);
    return () => clearTimeout(timer);
    // `values` is rebuilt each render; `signature` is its value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return hot;
}

/**
 * A list container: after each render, a child that moved (its place in the container changed)
 * slides from its old place to the new one (FLIP, `flipMs`). Places are relative to the container, so
 * a list that only shifts with the page does not move, and one inside a scaled graph (Fit, 100%) does not move when only the scale changes: places are kept in the container's own pixels. Never nest one `Flip` in another. A child with no earlier place (new)
 * does not animate, nor does anything under reduced motion. The end state is the real layout: no
 * transform is left.
 */
export function Flip(props: HTMLAttributes<HTMLDivElement>) {
  const container = useRef<HTMLDivElement>(null);
  const places = useRef(new Map<Element, { x: number; y: number }>());
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const next = new Map<Element, { x: number; y: number }>();
    const origin = element.getBoundingClientRect();
    // Screen pixels per layout pixel: a CSS scale above the container (the graph viewport) is not a move.
    const scale = element.offsetWidth > 0 ? origin.width / element.offsetWidth : 1;
    for (const child of Array.from(element.children)) {
      // The box includes a slide in flight: take it off, so a re-render mid-slide sees the real place.
      const box = child.getBoundingClientRect();
      const slide = new DOMMatrixReadOnly(getComputedStyle(child).transform);
      const place = {
        x: (box.left - origin.left) / scale - slide.m41,
        y: (box.top - origin.top) / scale - slide.m42,
      };
      next.set(child, place);
      const old = places.current.get(child);
      // Under half a pixel is layout rounding, not a move.
      if (
        !old ||
        reducedMotion() ||
        keyboardOrigin() ||
        (Math.abs(old.x - place.x) < 0.5 && Math.abs(old.y - place.y) < 0.5)
      )
        continue;
      child.animate(
        [
          { transform: `translate(${old.x - place.x}px, ${old.y - place.y}px)` },
          { transform: "none" },
        ],
        { duration: flipMs, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      );
    }
    places.current = next;
  });
  return <div ref={container} {...props} />;
}
