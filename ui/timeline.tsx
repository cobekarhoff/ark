import { useEffect, useState } from "react";
import type { Cost, Lane, Segment } from "../cli/hub/timeline.ts";
import type { Action } from "../cli/hub/types.ts";
import { duration, minutesSince, usd, type HubState } from "./model.ts";
import { clock, Kbd, ViewBar, type View } from "./views.tsx";

const windows = [1, 12, 24];
const tickMinutes: Record<number, number> = { 1: 15, 12: 120, 24: 240 };
const bucketCount = 24;

/** Events track, steps track, then what only the hub history can tell. */
const tracks: { name: string; kinds: Segment["kind"][] }[] = [
  { name: "phases · gates", kinds: ["phase", "gate"] },
  { name: "steps", kinds: ["worker"] },
  { name: "liveness · stall · CI", kinds: ["chief", "stall", "pause", "ci", "unavailable"] },
];
const fromHistory = (kind: Segment["kind"]) =>
  ["chief", "stall", "pause", "ci", "unavailable"].includes(kind);

type Pick = { lane: string; segment: string | null } | null;

/** Bucketed burn from the cumulative series. A bucket with an unknown message is "?", never $0. */
function burnOf(cost: Cost, start: number, end: number) {
  const size = (end - start) / bucketCount;
  const buckets = Array.from({ length: bucketCount }, () => ({ value: 0, unknown: false }));
  let previous = cost.baseline;
  for (const point of cost.series) {
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((Date.parse(point.at) - start) / size)),
    );
    if (point.usd === "unknown") buckets[index].unknown = true;
    else {
      buckets[index].value += point.usd - previous;
      previous = point.usd;
    }
  }
  return buckets;
}

function blockClass(segment: Segment, now: number) {
  const open = segment.to === null;
  if (segment.kind === "unavailable") return "unav";
  if (segment.kind === "gate") {
    const waited = minutesSince(segment.from, now);
    return `k-gate ${open ? `live ${waited >= 120 ? "old" : waited < 30 ? "new" : ""}` : "done"}`;
  }
  if (segment.kind === "stall") return `k-stall ${open ? "live" : ""}`;
  if (segment.kind === "pause" || segment.kind === "ci") return "k-wait";
  if (segment.kind === "chief") return segment.state === "live" ? "k-ok" : "k-wait";
  if (segment.kind === "worker")
    return open ? "k-work" : segment.state === "failed" ? "k-fail" : "k-ok";
  return open ? "k-work cur" : "k-ok";
}

type Props = {
  hub: HubState;
  now: number;
  perform: (action: Action | null) => Promise<void>;
  view: View;
  setView: (view: View) => void;
  /** False while the palette or the shortcut sheet is open. */
  active: boolean;
};

export function TimelineView({ hub, now, perform, view, setView, active }: Props) {
  const [hours, setHours] = useState(12);
  const [lanes, setLanes] = useState<Lane[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [burn, setBurn] = useState(false);
  // Only the Timeline keeps this. Home and the Map never read it.
  const [pick, setPick] = useState<Pick>(null);

  useEffect(() => {
    let stale = false;
    fetch(`/api/timeline?hours=${hours}`)
      .then((response) => response.json() as Promise<{ hours: number; lanes: Lane[] }>)
      .then((body) => {
        if (stale || body.hours !== hours) return;
        setLanes(body.lanes);
        setFailed(false);
      })
      .catch(() => !stale && setFailed(true));
    return () => {
      stale = true;
    };
  }, [hub, hours]);

  useEffect(() => {
    if (!active || view !== "timeline") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey) return;
      if (event.key === "w") setHours(windows[(windows.indexOf(hours) + 1) % windows.length]);
      else if (event.key === "b") setBurn(!burn);
      else if (event.key === "Escape") setPick(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const end = now;
  const start = end - hours * 3_600_000;
  const percent = (time: number) =>
    Math.min(100, Math.max(0, ((time - start) / (end - start)) * 100));
  const step = tickMinutes[hours] * 60_000;
  const offset = new Date(now).getTimezoneOffset() * 60_000;
  const ticks: number[] = [];
  for (let tick = Math.ceil((start - offset) / step) * step + offset; tick <= end; tick += step)
    ticks.push(tick);

  const waiting = (lanes ?? []).flatMap((lane) =>
    lane.segments
      .filter((segment) => segment.kind === "gate" && segment.to === null)
      .map((segment) => ({ lane, segment })),
  );
  const chosen = lanes?.find((lane) => lane.id === pick?.lane);
  const chosenSegment = pick?.segment
    ? chosen?.segments[Number(pick.segment.slice(pick.segment.lastIndexOf(":") + 1))]
    : undefined;
  const needOf = (segment: Segment) => hub.needs_me.find((item) => item.id === segment.item);
  const burned = (lanes ?? []).flatMap((lane) => burnOf(lane.cost, start, end));

  function select(lane: Lane, index: number, segment: Segment) {
    const key = `${lane.id}:${index}`;
    setPick(pick?.segment === key ? null : { lane: lane.id, segment: key });
    if (segment.kind === "gate" && segment.to === null)
      void perform(needOf(segment)?.action ?? null);
  }

  return (
    <>
      <main className="center">
        <header className="top">
          <h1>Ark hub</h1>
          <ViewBar view={view} setView={setView} />
          <span className="spacer" />
          <span className="hint">
            <Kbd>w</Kbd> window <b data-testid="window">{hours}h</b> <Kbd>b</Kbd> cost burn
          </span>
        </header>
        <div className="scroll timeline-view">
          <section className="panel tm-panel" aria-label="Timeline">
            <div className="tm-axis">
              <div>
                {hours}h window <span className="muted">hatched = no history</span>
              </div>
              <div className="ax">
                {ticks.map((tick) => (
                  <i key={tick} style={{ left: `${percent(tick)}%` }}>
                    {clock(tick)}
                  </i>
                ))}
              </div>
            </div>
            {failed && (
              <p className="hint">The Timeline could not be read. The hub may be restarting.</p>
            )}
            {lanes === null ? (
              <div className="empty">Loading the Timeline…</div>
            ) : lanes.length === 0 ? (
              <div className="empty">No Master Chief, run or agent in this window.</div>
            ) : (
              <div className="tm-lanes">
                {lanes.map((lane) => {
                  const selected = pick?.lane === lane.id;
                  const buckets = burn ? burnOf(lane.cost, start, end) : [];
                  const peak = Math.max(0.01, ...buckets.map((bucket) => bucket.value));
                  return (
                    <div
                      key={lane.id}
                      className={`tm-lane ${selected ? "sel" : ""}`}
                      data-lane={lane.id}
                    >
                      <div className="lane-row">
                        <button
                          className="lh"
                          aria-pressed={selected}
                          onClick={() =>
                            setPick(
                              selected && pick?.segment === null
                                ? null
                                : { lane: lane.id, segment: null },
                            )
                          }
                        >
                          <span className="nm">{lane.label}</span>
                          <span className="meta">{lane.kind}</span>
                          <span className="meta">cost {usd(lane.cost.usd)}</span>
                        </button>
                        <div>
                          {tracks
                            .filter(
                              (track) => lane.kind === "run" || track.name.startsWith("liveness"),
                            )
                            .map((track) => (
                              <div className="tr" key={track.name} aria-label={track.name}>
                                {lane.segments.flatMap((segment, index) => {
                                  if (!track.kinds.includes(segment.kind)) return [];
                                  const from = Date.parse(segment.from);
                                  const to = segment.to === null ? end : Date.parse(segment.to);
                                  if (to < start) return [];
                                  const key = `${lane.id}:${index}`;
                                  const left = percent(from);
                                  const width = percent(to) - left;
                                  return [
                                    <button
                                      key={key}
                                      className={`blk ${blockClass(segment, now)} ${pick?.segment === key ? "pick" : ""}`}
                                      data-segment={key}
                                      data-kind={segment.kind}
                                      data-open={segment.to === null}
                                      data-source={fromHistory(segment.kind) ? "history" : "events"}
                                      style={{ left: `${left}%`, width: `${width}%` }}
                                      title={`${segment.kind} ${segment.item ?? ""}`.trim()}
                                      aria-label={`${segment.kind} ${segment.item ?? ""}, ${clock(from)} to ${segment.to === null ? "now" : clock(to)}`}
                                      onClick={() => select(lane, index, segment)}
                                    >
                                      {width > 8
                                        ? segment.kind === "unavailable"
                                          ? "UNAVAILABLE"
                                          : (segment.item ?? segment.kind).replace(
                                              /^\w+:[^:]*:/,
                                              "",
                                            )
                                        : ""}
                                    </button>,
                                  ];
                                })}
                              </div>
                            ))}
                          {burn && (
                            <div className="burn" aria-label="Cost burn">
                              {buckets.map((bucket, index) => {
                                const left = (index / bucketCount) * 100;
                                return bucket.unknown ? (
                                  <span
                                    key={index}
                                    className="q"
                                    style={{
                                      left: `${left}%`,
                                      width: `${100 / bucketCount - 0.3}%`,
                                    }}
                                    title="no provider cost value"
                                  >
                                    ?
                                  </span>
                                ) : (
                                  <span
                                    key={index}
                                    className="spend"
                                    style={{
                                      left: `${left}%`,
                                      width: `${100 / bucketCount - 0.3}%`,
                                      height: `${(bucket.value / peak) * 26}px`,
                                    }}
                                    title={usd(bucket.value)}
                                  />
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <span className="now" style={{ left: "100%" }} title="now" />
              </div>
            )}
            <div className="tm-foot">
              {burn ? (
                <span data-testid="burn">
                  Burn in {hours}h:{" "}
                  <b>
                    {lanes?.some((lane) => lane.cost.series.length > 0)
                      ? usd(burned.reduce((sum, bucket) => sum + bucket.value, 0))
                      : "?"}
                  </b>
                  {burned.some((bucket) => bucket.unknown) && (
                    <>
                      {" "}
                      + <b>?</b>{" "}
                      <span className="muted">(no provider value, never counted as $0)</span>
                    </>
                  )}
                </span>
              ) : (
                <span className="muted">Cost burn hidden</span>
              )}
              <span>
                <i className="sw gate" />
                gate (click runs its action)
              </span>
              <span>
                <i className="sw unav" />
                UNAVAILABLE: no history collected, not guessed
              </span>
            </div>
          </section>
        </div>
      </main>

      <aside className="detail" aria-label="Detail">
        <div className="d-head">
          {chosen ? (
            <>
              <div className="d-id">
                <span className="pill">{chosenSegment ? chosenSegment.kind : chosen.kind}</span>
              </div>
              <h2>{chosenSegment ? (chosenSegment.item ?? chosenSegment.kind) : chosen.label}</h2>
              <dl className="kv">
                <dt>Lane</dt>
                <dd>{chosen.label}</dd>
                {chosenSegment ? (
                  <>
                    <dt>Start</dt>
                    <dd className="mono">{clock(chosenSegment.from)}</dd>
                    <dt>End</dt>
                    <dd className="mono">{chosenSegment.to ? clock(chosenSegment.to) : "now"}</dd>
                    <dt>Length</dt>
                    <dd className="mono">
                      {duration(
                        Math.floor(
                          ((chosenSegment.to ? Date.parse(chosenSegment.to) : now) -
                            Date.parse(chosenSegment.from)) /
                            60_000,
                        ),
                      )}
                    </dd>
                    <dt>Source</dt>
                    <dd className="mono">
                      {fromHistory(chosenSegment.kind) ? "hub/history.ndjson" : "events.ndjson"}
                    </dd>
                  </>
                ) : (
                  <>
                    <dt>Cost</dt>
                    <dd>{usd(chosen.cost.usd)}</dd>
                    <dt>Segments</dt>
                    <dd>{chosen.segments.length}</dd>
                  </>
                )}
              </dl>
              {chosenSegment?.kind === "unavailable" && (
                <p className="hint">
                  No history exists for this interval. Liveness, stalls, pauses and CI were never
                  recorded, so Ark leaves it blank.
                </p>
              )}
              {chosenSegment?.kind === "gate" && needOf(chosenSegment) && (
                <button
                  className="btn primary"
                  onClick={() => void perform(needOf(chosenSegment)?.action ?? null)}
                >
                  {needOf(chosenSegment)?.action?.label ?? "No action"}
                </button>
              )}
            </>
          ) : (
            <div className="d-empty">
              Click a lane or a block to see it here.
              <br />
              <span className="hint">Timeline selection is separate from Home and the Map.</span>
            </div>
          )}
        </div>
        <section className="d-sec">
          <h3>Waiting on you</h3>
          {waiting.length === 0 ? (
            <p className="hint">No gate is open in this window.</p>
          ) : (
            waiting
              .toSorted(
                (left, right) => Date.parse(left.segment.from) - Date.parse(right.segment.from),
              )
              .map(({ lane, segment }) => (
                <button
                  key={`${lane.id}:${segment.item}`}
                  className="ask"
                  onClick={() =>
                    setPick({
                      lane: lane.id,
                      segment: `${lane.id}:${lane.segments.indexOf(segment)}`,
                    })
                  }
                >
                  <span className="mono">{duration(minutesSince(segment.from, now))}</span>
                  <span>
                    <b>{segment.item?.replace(/^\w+:[^:]*:/, "")}</b>
                    <br />
                    <span className="muted">{lane.label}</span>
                  </span>
                </button>
              ))
          )}
        </section>
      </aside>
    </>
  );
}
