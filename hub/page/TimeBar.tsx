import type { TimeSplit } from "../types.ts";

/** `1h 12m`, `41m`, `45s`: a span of time. */
export function wall(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${Math.floor(seconds)}s`;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Whole minutes; a part under a minute reads `<1m`, not `0m`. */
const minutesOf = (seconds: number): string =>
  seconds > 0 && seconds < 30 ? "<1m" : `${Math.round(seconds / 60)}m`;

const parts = [
  ["you", "Waiting on you", "waiting_on_you_seconds"],
  ["work", "Working", "working_seconds"],
  ["merge", "Waiting to merge", "waiting_to_merge_seconds"],
  ["idle", "Idle", "idle_seconds"],
] as const;

/** Where a run's time went, from the events: one bar, widths follow the seconds, minutes in the list. */
export function TimeBar({ split, live }: { split: TimeSplit; live: boolean }) {
  const total = parts.reduce((sum, [, , key]) => sum + split[key], 0);
  const label = parts
    .map(([, name, key]) => `${name.toLowerCase()} ${Math.round(split[key] / 60)} minutes`)
    .join(", ");
  return (
    <div className="time-bar" data-testid="time-bar" role="group" aria-label="Where the time went">
      <div className="time-bar-head">
        <h2>Where the time went</h2>
        <span className="total">
          {wall(total)}
          {live ? <span className="live"> so far</span> : null}
        </span>
      </div>
      <div className="bar" role="img" aria-label={label}>
        {parts.map(([id, name, key]) =>
          split[key] > 0 ? (
            <span
              key={id}
              className={id}
              data-testid={`time-seg-${id}`}
              style={{ flexGrow: split[key] }}
              title={`${name} ${minutesOf(split[key])}`}
            />
          ) : null,
        )}
      </div>
      <ul className="parts">
        {parts.map(([id, name, key]) => (
          <li
            key={id}
            className={`${id}${split[key] === 0 ? " zero" : ""}`}
            data-testid={`time-${id}`}
          >
            <i />
            <span className="name">{name}</span>
            <b>{minutesOf(split[key])}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
