import { useMemo, useRef, useState, type PointerEvent } from "react";
import type { RoleGroup, RunConversation } from "../conversation.ts";
import {
  buildTrace,
  clampView,
  clockText,
  spansDays,
  clusterTicks,
  minimumViewMs,
  type Bar,
  type Range,
  type Tick,
} from "./conversation-model.ts";
import { ArrowMarker } from "./format.tsx";

/** One row's height: the arrow overlay and the row list share it. */
export const rowHeight = 26;

type Props = {
  conversation: RunConversation;
  full: Range;
  view: Range;
  onView: (view: Range) => void;
  selected: string | null;
  /** A click in the trace: the message to select, and the feed scrolls to it. */
  onPick: (id: string) => void;
  /** Time of the top message of the feed, or null. */
  cursor: number | null;
  expanded: ReadonlySet<RoleGroup>;
  onToggle: (group: RoleGroup) => void;
  /** Replay playhead, or null when no replay runs. Everything after it is dimmed. */
  playhead: number | null;
  /** The message just sent during a replay: its arrow animates once. */
  pulse: { id: string; nonce: number } | null;
};

const share = (time: number, view: Range) => (time - view.start) / (view.end - view.start);
const percent = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;

function Minimap({
  conversation,
  full,
  view,
  onView,
}: Pick<Props, "conversation" | "full" | "view" | "onView">) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    mode: "new" | "move";
    anchor: number;
    origin: Range;
    moved: boolean;
  } | null>(null);
  const timeAt = (event: PointerEvent) => {
    const box = track.current!.getBoundingClientRect();
    const fraction = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    return full.start + fraction * (full.end - full.start);
  };
  const width = view.end - view.start;
  return (
    <div
      className="cv-mini"
      ref={track}
      data-testid="trace-minimap"
      onPointerDown={(event) => {
        const time = timeAt(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          mode: time >= view.start && time <= view.end ? "move" : "new",
          anchor: time,
          origin: view,
          moved: false,
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        const time = timeAt(event);
        const distance = Math.abs(time - current.anchor) / (full.end - full.start);
        if (distance < 0.005 && !current.moved) return;
        current.moved = true;
        const delta = time - current.anchor;
        onView(
          clampView(
            current.mode === "move"
              ? { start: current.origin.start + delta, end: current.origin.end + delta }
              : {
                  start: Math.min(current.anchor, time),
                  end: Math.max(current.anchor, time),
                },
            full,
          ),
        );
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        drag.current = null;
        // A click with no drag centres the window on the point.
        if (current && !current.moved) {
          const time = timeAt(event);
          onView(clampView({ start: time - width / 2, end: time + width / 2 }, full));
        }
      }}
    >
      {conversation.messages.map((message) => {
        const time = Date.parse(message.created_at ?? "");
        return Number.isFinite(time) ? (
          <i
            key={message.id}
            className="cv-mini-tick"
            style={{ left: percent(share(time, full)) }}
          />
        ) : null;
      })}
      <div
        className="cv-brush"
        data-testid="trace-brush"
        style={{
          left: percent(share(view.start, full)),
          width: percent(width / (full.end - full.start)),
        }}
      />
    </div>
  );
}

/** Hover names every worker active at the pointer's time: a collapsed row holds overlapping workers. */
function Lane({
  bars,
  ticks,
  view,
  selected,
  onPick,
  onZoomCluster,
  rowKey,
  label,
  playhead,
}: {
  bars: Bar[];
  ticks: Tick[];
  view: Range;
  selected: string | null;
  onPick: (tick: Tick) => void;
  onZoomCluster: (cluster: Tick[]) => void;
  rowKey: string;
  label: string;
  playhead: number | null;
}) {
  const [tip, setTip] = useState<{ x: number; text: string } | null>(null);
  const clusters = useMemo(() => clusterTicks(ticks, view), [ticks, view]);
  return (
    <div
      className="cv-lane"
      data-row={rowKey}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const fraction = (event.clientX - box.left) / box.width;
        const time = view.start + fraction * (view.end - view.start);
        // A bar a pixel wide still names itself.
        const slack = ((view.end - view.start) / box.width) * 2;
        const names = [
          ...new Set(
            bars
              .filter(
                (bar) =>
                  bar.kind === "active" && bar.start - slack <= time && time <= bar.end + slack,
              )
              .map((bar) => bar.label),
          ),
        ];
        setTip(
          names.length > 0
            ? { x: event.clientX - box.left, text: `${label}: ${names.join(", ")}` }
            : null,
        );
      }}
      onPointerLeave={() => setTip(null)}
    >
      {bars.map((bar, at) => {
        const from = Math.max(share(bar.start, view), 0);
        const to = Math.min(share(bar.end, view), 1);
        return to > from ? (
          <span
            key={at}
            className={`cv-bar ${bar.kind}`}
            data-testid={bar.kind === "active" ? "trace-bar" : `trace-${bar.kind}`}
            data-label={bar.label}
            style={{ left: percent(from), width: percent(to - from) }}
          />
        ) : null;
      })}
      {clusters.map((cluster) =>
        cluster.length === 1 ? (
          <button
            key={cluster[0]!.id}
            type="button"
            className={`cv-tick ty-${cluster[0]!.type}${selected === cluster[0]!.id ? " sel" : ""}${playhead !== null && cluster[0]!.time > playhead ? " future" : ""}`}
            data-testid="trace-tick"
            data-id={cluster[0]!.id}
            aria-label={`${cluster[0]!.type ?? "message"} at ${clockText(cluster[0]!.time, true)}`}
            aria-pressed={selected === cluster[0]!.id}
            style={{ left: percent(share(cluster[0]!.time, view)) }}
            onClick={() => onPick(cluster[0]!)}
          />
        ) : (
          <button
            key={cluster[0]!.id}
            type="button"
            className={`cv-cluster${cluster.some((tick) => tick.id === selected) ? " sel" : ""}${playhead !== null && cluster[0]!.time > playhead ? " future" : ""}`}
            data-testid="trace-cluster"
            data-ids={cluster.map((tick) => tick.id).join(" ")}
            aria-label={`${cluster.length} messages from ${clockText(cluster[0]!.time, true)}`}
            style={{ left: percent(share(cluster[0]!.time, view)) }}
            onClick={() => onZoomCluster(cluster)}
          >
            {cluster.length}
          </button>
        ),
      )}
      {tip ? (
        <span className="cv-tip" role="tooltip" data-testid="trace-tip" style={{ left: tip.x }}>
          {tip.text}
        </span>
      ) : null}
    </div>
  );
}

export function Trace({
  conversation,
  full,
  view,
  onView,
  selected,
  onPick,
  cursor,
  expanded,
  onToggle,
  playhead,
  pulse,
}: Props) {
  const trace = useMemo(
    () => buildTrace(conversation, full, expanded),
    [conversation, full, expanded],
  );
  const rowIndex = new Map(trace.rows.map((row, at) => [row.key, at]));
  const picked = trace.ticks.find((tick) => tick.id === selected) ?? null;
  const pulsed = trace.ticks.find((tick) => tick.id === pulse?.id) ?? null;
  const width = view.end - view.start;
  const seconds = width < 10 * 60_000;
  const dated = spansDays(full);
  const labels = [0, 0.25, 0.5, 0.75, 1].map((fraction) => view.start + fraction * width);
  const zoom = (factor: number) => {
    const centre = (view.start + view.end) / 2;
    onView(
      clampView({ start: centre - (width * factor) / 2, end: centre + (width * factor) / 2 }, full),
    );
  };

  // A tick centres the view and keeps its width unless that is wide: then it zooms to a sixth of the run.
  const pickTick = (tick: Tick) => {
    const target = Math.min(width, Math.max((full.end - full.start) / 6, minimumViewMs));
    onView(clampView({ start: tick.time - target / 2, end: tick.time + target / 2 }, full));
    onPick(tick.id);
  };
  const zoomCluster = (cluster: Tick[]) => {
    const first = cluster[0]!.time;
    const last = cluster.at(-1)!.time;
    const pad = Math.max((last - first) / 2, minimumViewMs / 2);
    onView(clampView({ start: first - pad, end: last + pad }, full));
    onPick(cluster[0]!.id);
  };

  return (
    <section className="cv-trace" aria-label="Trace" data-testid="trace">
      <div className="cv-tools">
        <span className="mut">
          {clockText(view.start, seconds, dated)}–{clockText(view.end, seconds, dated)}
        </span>
        <div className="seg end" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" onClick={() => zoom(2)}>
            −
          </button>
          <button type="button" aria-label="Zoom in" onClick={() => zoom(0.5)}>
            +
          </button>
          <button
            type="button"
            data-testid="trace-reset"
            disabled={view.start === full.start && view.end === full.end}
            onClick={() => onView(full)}
          >
            Full run
          </button>
        </div>
      </div>
      <Minimap conversation={conversation} full={full} view={view} onView={onView} />
      <div className="cv-axis" aria-hidden="true">
        {labels.map((time, at) => (
          <span key={at} className="cv-axis-label" style={{ left: percent(at / 4) }}>
            {clockText(time, seconds, dated)}
          </span>
        ))}
      </div>
      <div className="cv-rows" style={{ height: trace.rows.length * rowHeight }}>
        {trace.rows.map((row) => (
          <div
            className={`cv-row ${row.kind} ${row.kind === "chief" ? "r-chief" : row.kind === "lead" ? "r-lead" : row.group ? `r-${row.group}` : "r-other"}`}
            key={row.key}
            data-testid="trace-row"
            data-row={row.key}
          >
            {row.kind === "group" ? (
              <button
                type="button"
                className={`cv-label r-${row.group}`}
                aria-expanded={expanded.has(row.group!)}
                aria-label={`${row.label}, ${row.count} workers`}
                data-testid="trace-group"
                disabled={row.count === 0}
                onClick={() => onToggle(row.group!)}
              >
                <span aria-hidden="true">{expanded.has(row.group!) ? "▾" : "▸"}</span>
                {row.label}
                <span className="mut"> {row.count}</span>
              </button>
            ) : (
              <span className={`cv-label ${row.kind}`}>{row.label}</span>
            )}
            <Lane
              rowKey={row.key}
              label={row.label}
              bars={trace.bars.filter((bar) => bar.row === row.key)}
              ticks={trace.ticks.filter((tick) => tick.row === row.key)}
              view={view}
              selected={selected}
              onPick={pickTick}
              onZoomCluster={zoomCluster}
              playhead={playhead}
            />
            {row.kind === "chief"
              ? conversation.answers.map((answer) => {
                  const time = Date.parse(answer.time);
                  return time >= view.start && time <= view.end ? (
                    <span
                      key={answer.time}
                      className="cv-person"
                      role="img"
                      data-testid="answer-marker"
                      aria-label={`You answered ${answer.gate ?? "a gate"}: ${answer.answer ?? ""} at ${clockText(time, true)}`}
                      title={`You answered ${answer.gate ?? "a gate"}: ${answer.answer ?? ""} at ${clockText(time, true)}`}
                      style={{
                        left: `calc(var(--label) + (100% - var(--label)) * ${share(time, view)})`,
                      }}
                    >
                      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                        <circle cx="6" cy="4" r="2.5" />
                        <path d="M1.5 11a4.5 4.5 0 0 1 9 0z" />
                      </svg>
                    </span>
                  ) : null;
                })
              : null}
          </div>
        ))}
        <svg className="cv-overlay" aria-hidden="true" height={trace.rows.length * rowHeight}>
          <ArrowMarker id="cv-arrowhead" />
          {[
            { tick: picked, className: "cv-arrow", key: "picked" },
            { tick: pulsed, className: "cv-arrow pulse", key: `pulse:${pulse?.nonce}` },
          ].map(({ tick, className, key }) =>
            tick && tick.time >= view.start && tick.time <= view.end ? (
              <line
                key={key}
                data-testid={key === "picked" ? "trace-arrow" : "trace-pulse"}
                data-from={tick.row}
                data-to={tick.toRow}
                className={className}
                x1={percent(share(tick.time, view))}
                y1={(rowIndex.get(tick.row) ?? 0) * rowHeight + rowHeight / 2}
                // Sender and receiver on one row: a short arrow along the row.
                x2={percent(share(tick.time, view) + (tick.row === tick.toRow ? 0.02 : 0))}
                y2={(rowIndex.get(tick.toRow) ?? 0) * rowHeight + rowHeight / 2}
                markerEnd="url(#cv-arrowhead)"
              />
            ) : null,
          )}
        </svg>
        {playhead !== null && playhead >= view.start && playhead <= view.end ? (
          <>
            <div
              className="cv-future"
              data-testid="trace-future"
              style={{
                left: `calc(var(--label) + (100% - var(--label)) * ${share(playhead, view)})`,
              }}
            />
            <div
              className="cv-playhead"
              data-testid="trace-playhead"
              data-time={playhead}
              style={{
                left: `calc(var(--label) + (100% - var(--label)) * ${share(playhead, view)})`,
              }}
            />
          </>
        ) : null}
        {cursor !== null && cursor >= view.start && cursor <= view.end ? (
          <div
            className="cv-cursor"
            data-testid="trace-cursor"
            data-time={cursor}
            style={{ left: `calc(var(--label) + (100% - var(--label)) * ${share(cursor, view)})` }}
          />
        ) : null}
      </div>
    </section>
  );
}
