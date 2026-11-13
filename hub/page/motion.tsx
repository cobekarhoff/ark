import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";

/** Script-driven motion (FLIP, view transitions) is not under the CSS rule, so it asks here. */
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    setHot(new Set(changed.map(([key]) => key)));
    if (changed.length === 0) return;
    const timer = setTimeout(() => setHot(new Set()), highlightMs);
    return () => clearTimeout(timer);
    // `values` is rebuilt each render; `signature` is its value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return hot;
}

/**
 * A list container: after each render, a child that moved (its offset in the container changed)
 * slides from its old place to the new one (FLIP, `flipMs`). A child with no earlier place (new)
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
    for (const child of Array.from(element.children) as HTMLElement[]) {
      const place = { x: child.offsetLeft, y: child.offsetTop };
      next.set(child, place);
      const old = places.current.get(child);
      if (!old || reducedMotion() || (old.x === place.x && old.y === place.y)) continue;
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
