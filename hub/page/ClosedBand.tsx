import { dollars } from "./format.tsx";
import { runHref } from "./RunDetail.tsx";
import type { ClosedBand as ClosedBandData } from "../types.ts";

export const notRecorded = "not recorded";

/** `1h 12m`, `41m`, `45s`: the wall time of a closed run. */
function wall(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${Math.floor(seconds)}s`;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const outcomeTone: Record<string, string> = {
  merged: "ok",
  aborted: "bad",
  abandoned: "warn",
  handed_off: "p-build",
};

function Stat({
  label,
  testId,
  value,
}: {
  label: string;
  testId: string;
  value: string | number | null;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-testid={testId} className={value === null ? "nr" : undefined}>
        {value ?? notRecorded}
      </dd>
    </div>
  );
}

/**
 * The summary of a closed run, above the plan. The only place the page shows the outcome.
 * `data-testid="closed-band"` is stable: ARK-355 adds its time bar inside the band.
 */
export function ClosedBand({
  run,
  outcome,
  closedAt,
  band,
  files,
}: {
  run: string;
  outcome: string | null;
  closedAt: string | null;
  band: ClosedBandData;
  files: string[];
}) {
  const links = files.filter((path) => path === "retro.md" || path.startsWith("findings/"));
  const { passing, total } = band.criteria;
  return (
    <section className="closed-band" data-testid="closed-band" aria-label="Closed run summary">
      <div className="band-top">
        <span className={`pill ${outcomeTone[outcome ?? ""] ?? "unk"}`} data-testid="band-outcome">
          {outcome ?? "unknown"}
        </span>
        {closedAt ? <span>Closed {closedAt.slice(0, 10)}</span> : null}
        <span className="band-links">
          {links.map((path) => (
            <a
              key={path}
              href={runHref(run, "file", path)}
              className="mono"
              data-testid="band-link"
              data-path={path}
            >
              {path}
            </a>
          ))}
        </span>
      </div>
      <dl className="band-stats">
        <Stat
          label="Wall time"
          testId="band-wall"
          value={band.wall_seconds === null ? null : wall(band.wall_seconds)}
        />
        <Stat
          label="ACs passing"
          testId="band-acs"
          value={total === 0 ? "–" : `${passing} of ${total}`}
        />
        <Stat
          label="Cost"
          testId="band-cost"
          value={band.cost_usd === notRecorded ? null : dollars.format(band.cost_usd as number)}
        />
        <Stat
          label="Rework rounds"
          testId="band-rounds"
          value={band.rework_rounds === notRecorded ? null : (band.rework_rounds as number)}
        />
      </dl>
      {band.escaped_defects.length > 0 ? (
        <div className="band-escaped">
          <h2>Escaped defects ({band.escaped_defects.length})</h2>
          <ul>
            {band.escaped_defects.map((defect, index) => (
              <li key={index} data-testid="band-defect">
                <b className="mono">{defect.ticket}</b>
                <span>
                  {defect.note}
                  {defect.fix ? <span className="mut"> · fix: {defect.fix}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
