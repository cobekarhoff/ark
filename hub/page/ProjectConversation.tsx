import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  ConversationMessage,
  ConversationReply,
  ProjectAnswer,
  RunConversation,
} from "../conversation.ts";
import type { RunView } from "../types.ts";
import {
  buildAxis,
  buildBeads,
  clockText,
  clusterBeads,
  DatedContext,
  density,
  filterProject,
  noFilter,
  nowAt,
  projectRange,
  projectRuns,
  projectTypes,
  sentAt,
  sentTimes,
  slotOf,
  spansDays,
  typeOf,
  useClockText,
  waitingBands,
  type Axis,
  type Bead,
  type Now,
  type ProjectFilter,
  type ProjectRun,
  type Range,
} from "./conversation-model.ts";
import { Notices } from "./Conversation.tsx";
import { Inspector, type InspectorFocus } from "./ConversationInspector.tsx";
import { Player, useReplay, type Replay } from "./ConversationReplay.tsx";
import { GraphViewport } from "./GraphViewport.tsx";
import { reducedMotion } from "./motion.tsx";
import { runHref } from "./RunDetail.tsx";

type ProjectReply = ConversationReply & ProjectAnswer;
type State =
  | { status: "loading" }
  | { status: "failed"; reason: string }
  | { status: "ok"; reply: ProjectReply; failure: string | null };

/**
 * Reads `GET /api/conversation` (read only). `refreshKey` changes when an open run changed; the last good
 * answer stays on screen while the next one loads, and a loading directory is read again every 3 s.
 */
function useProjectConversation(refreshKey: string): State {
  const [state, setState] = useState<State>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const loadingDirectory = state.status === "ok" && state.reply.directory === "loading";
  useEffect(() => {
    if (!loadingDirectory) return;
    const timer = setTimeout(() => setRetry((count) => count + 1), 3000);
    return () => clearTimeout(timer);
  }, [loadingDirectory, retry]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/conversation", { signal: controller.signal })
      .then(async (response): Promise<State> => {
        if (!response.ok)
          return {
            status: "failed",
            reason:
              response.status === 503
                ? "the hub has not read the inbox yet; open any page of the hub, then retry"
                : `the hub answered ${response.status}`,
          };
        return { status: "ok", reply: await response.json(), failure: null };
      })
      .catch((err): State => ({ status: "failed", reason: String(err) }))
      .then((value) => {
        if (controller.signal.aborted) return;
        setState((previous) =>
          value.status === "failed" && previous.status === "ok"
            ? { ...previous, failure: value.reason }
            : value,
        );
      });
    return () => controller.abort();
  }, [refreshKey, retry]);
  return state;
}

// ---------- map geometry: the map is a fixed-size graph, so GraphViewport scales it ----------

const labelWidth = 190;
const padding = 24;
const chiefY = 28;
const rowStart = 60;
const rowHeight = 34;
const minStep = 14;
const maxStep = 60;
/** Few events spread out to about this wide; many events make the graph wider and Fit shrinks it. */
const targetWidth = 900;
const runColors = ["var(--blue)", "var(--green)", "var(--amber)", "var(--dim)"];

type Selection = {
  /** The owning run; null for a message of no run. */
  run: string | null;
  message: string | null;
  agent: string | null;
  focus: InspectorFocus | null;
};

function Person() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="4" r="3" />
      <path d="M1 13c0-3.5 2.7-5.5 6-5.5s6 2 6 5.5z" />
    </svg>
  );
}

/**
 * Room of the map (graph pixels) for `slots` gaps between events. At 100% a slot is `minStep` to `maxStep`
 * wide and a busy window scrolls; at Fit the slots shrink to fill the room, so the whole window is in view
 * with readable labels and a crowd of beads is clustered.
 */
function mapWidth(slots: number, mode: "fit" | "actual", available: number): number {
  const chrome = labelWidth + padding * 2;
  const wide = Math.max(minStep, Math.min(maxStep, targetWidth / slots));
  const fitted = available > 0 ? (available - chrome) / slots : wide;
  const step = mode === "actual" ? wide : Math.max(0.25, Math.min(maxStep, fitted));
  return chrome + slots * step;
}

type MapBead = Bead;

/** Each mark is its own memoised component: a scrub re-renders only the marks that cross the playhead. */
const BeadButton = memo(function BeadButton({
  bead,
  left,
  top,
  shown,
  selected,
  onPick,
}: {
  bead: MapBead;
  left: number;
  top: number;
  shown: boolean;
  selected: boolean;
  onPick: PickMessage;
}) {
  if (!shown) return null;
  const label = `${typeOf(bead.message)}: ${bead.message.subject ?? "no subject"}`;
  return (
    <button
      type="button"
      className={`map-bead ${bead.onChief ? "on-chief" : "on-run"} ty-${typeOf(bead.message)}${selected ? " sel" : ""}`}
      data-testid="map-bead"
      data-id={bead.id}
      {...(bead.onChief ? { "data-run": bead.run ?? "", "data-spur": bead.spur } : {})}
      aria-label={label}
      style={{ left, top }}
      onClick={() => onPick(bead.run, bead.id)}
    />
  );
});

const ClusterButton = memo(function ClusterButton({
  first,
  count,
  left,
  top,
  onPick,
}: {
  first: MapBead;
  count: number;
  left: number;
  top: number;
  onPick: PickMessage;
}) {
  if (count === 0) return null;
  // ponytail: a cluster opens its first message; zoom to 100% to pick each one.
  return (
    <button
      type="button"
      className="map-cluster"
      data-testid="map-cluster"
      data-count={count}
      aria-label={`${count} messages; zoom to 100% to see each`}
      title={`${count} messages: zoom to 100% to see each`}
      style={{ left, top }}
      onClick={() => onPick(first.run, first.id)}
    >
      {count}
    </button>
  );
});

const SpurLine = memo(function SpurLine({
  bead,
  left,
  fromY,
  toY,
  shown,
}: {
  bead: MapBead;
  left: number;
  fromY: number;
  toY: number;
  shown: boolean;
}) {
  if (!shown) return null;
  return (
    <line
      className="map-spur"
      data-testid="map-spur"
      data-id={bead.id}
      data-thick={bead.spur}
      data-type={typeOf(bead.message)}
      x1={left}
      x2={left}
      y1={fromY}
      y2={toY}
    />
  );
});

const PersonButton = memo(function PersonButton({
  run,
  time,
  left,
  shown,
  onFocus,
}: {
  run: string;
  time: string;
  left: number;
  shown: boolean;
  onFocus: PickFocus;
}) {
  if (!shown) return null;
  return (
    <button
      type="button"
      className="map-person"
      data-testid="map-person"
      data-run={run}
      aria-label={`You answered ${run}`}
      style={{ left, top: chiefY - 24 }}
      onClick={() => onFocus(run, { kind: "person", time })}
    >
      <Person />
    </button>
  );
});

const StationButton = memo(function StationButton({
  run,
  span,
  left,
  top,
  onFocus,
}: {
  run: string;
  span: RunConversation["spans"][number];
  left: number;
  top: number;
  onFocus: PickFocus;
}) {
  return (
    <button
      type="button"
      className={`map-station r-${span.group ?? "other"}`}
      data-testid="map-station"
      data-run={run}
      data-step={span.step}
      aria-label={`Step ${span.step} of ${run}`}
      title={`Step ${span.step} (${span.role})`}
      style={{ left, top }}
      onClick={() => onFocus(run, { kind: "station", step: span.step, start: span.start })}
    />
  );
});

function Drawing({
  mode,
  width,
  height,
  runs,
  beads,
  axis,
  playhead,
  live,
  pulse,
  selected,
  pickMessage,
  pickFocus,
}: {
  mode: "fit" | "actual";
  width: number;
  height: number;
  runs: ProjectRun[];
  beads: Bead[];
  axis: Axis;
  playhead: number | null;
  live: ReadonlySet<string>;
  pulse: Replay["pulse"];
  selected: string | null;
  pickMessage: PickMessage;
  pickFocus: PickFocus;
}) {
  const slots = Math.max(axis.times.length - 1, 1);
  const step = (width - labelWidth - padding * 2) / slots;
  const xOf = (time: number) => labelWidth + padding + slotOf(axis, time) * step;
  const endX = xOf(axis.times.at(-1) ?? 0);
  const upto = playhead ?? Infinity;
  const rowY = useMemo(
    () => new Map(runs.map((run, index) => [run.run, rowStart + (index + 0.5) * rowHeight])),
    [runs],
  );
  const colorOf = useMemo(
    () => new Map(runs.map((run, index) => [run.run, runColors[index % runColors.length]])),
    [runs],
  );
  const bands = useMemo(() => waitingBands(runs, upto), [runs, upto]);
  const clusters = useMemo(
    () => clusterBeads(beads, axis, mode === "actual", step),
    [beads, axis, mode, step],
  );
  const pulsed = pulse ? beads.find((bead) => bead.id === pulse.id) : undefined;
  const beadY = (bead: Bead) => rowY.get(bead.run!)! - 5;
  return (
    <div className="map" data-testid="map" style={{ width, height }}>
      <svg className="map-svg" width={width} height={height} aria-hidden="true">
        <line
          className="map-chief-line"
          x1={labelWidth}
          x2={width - padding}
          y1={chiefY}
          y2={chiefY}
        />
        {runs.map((run) => {
          const y = rowY.get(run.run)!;
          return (
            <g key={run.run} style={{ stroke: colorOf.get(run.run) }}>
              <line
                className="map-branch"
                x1={xOf(run.start)}
                x2={xOf(run.start)}
                y1={chiefY}
                y2={y}
              />
              {run.close === null ? null : (
                <line
                  className="map-branch"
                  x1={xOf(run.close)}
                  x2={xOf(run.close)}
                  y1={y}
                  y2={chiefY}
                />
              )}
            </g>
          );
        })}
        {beads.map((bead) =>
          bead.onChief && bead.run !== null ? (
            <SpurLine
              key={bead.id}
              bead={bead}
              left={xOf(bead.time)}
              fromY={chiefY}
              toY={rowY.get(bead.run)!}
              shown={bead.time <= upto}
            />
          ) : null,
        )}
      </svg>
      <span className="map-chief-label mono" style={{ top: chiefY - 9 }}>
        Master Chief
      </span>
      {bands.map((band) => {
        const left = xOf(band.start);
        const right = xOf(Number.isFinite(band.end) ? band.end : (axis.times.at(-1) ?? band.start));
        return rowY.has(band.run) ? (
          <div
            key={band.question}
            className="map-band"
            data-testid="map-band"
            data-run={band.run}
            data-question={band.question}
            data-open={band.open}
            role="img"
            aria-label={`${band.run} waiting on you`}
            title="waiting on you"
            style={{ left, width: Math.max(right - left, 4), top: rowY.get(band.run)! - 9 }}
          />
        ) : null;
      })}
      {runs.map((run) => {
        const y = rowY.get(run.run)!;
        const left = xOf(run.start);
        const right = run.close === null ? endX : xOf(run.close);
        return (
          <div
            key={run.run}
            className="map-run"
            data-testid="map-run"
            data-run={run.run}
            data-state={live.has(run.run) ? "live" : "idle"}
            style={
              {
                top: y - rowHeight / 2,
                height: rowHeight,
                "--c": colorOf.get(run.run),
              } as CSSProperties
            }
          >
            <button
              type="button"
              className="map-run-row"
              data-testid="map-run-row"
              aria-label={`Inspect run ${run.run}`}
              onClick={() =>
                pickFocus(run.run, { kind: "run", start: run.start, close: run.close })
              }
            />
            <a
              className="map-run-badge mono"
              data-testid="map-run-badge"
              href={runHref(run.run, "conversation")}
              title={`${run.run}: open its Conversation tab`}
            >
              {run.run}
            </a>
            <a
              className="map-run-line"
              data-testid="map-run-line"
              data-run={run.run}
              data-open={run.close === null}
              href={runHref(run.run, "conversation")}
              aria-label={`Open the Conversation tab of ${run.run}`}
              style={{ left, width: Math.max(right - left, 8) }}
            />
          </div>
        );
      })}
      {runs.flatMap((run) =>
        run.conversation.spans.map((span) => (
          <StationButton
            key={`${run.run}/${span.step}/${span.start}`}
            run={run.run}
            span={span}
            left={xOf(Date.parse(span.start))}
            top={rowY.get(run.run)! - 6}
            onFocus={pickFocus}
          />
        )),
      )}
      {beads
        .filter((bead) => !bead.onChief && bead.run !== null)
        .map((bead) => (
          <BeadButton
            key={bead.id}
            bead={bead}
            left={xOf(bead.time)}
            top={beadY(bead)}
            shown={bead.time <= upto}
            selected={bead.id === selected}
            onPick={pickMessage}
          />
        ))}
      {clusters.map((cluster) => {
        const first = cluster[0];
        // Members are in time order, so the shown ones are a prefix: count them for the playhead.
        const shownCount = cluster.filter((bead) => bead.time <= upto).length;
        if (cluster.length === 1)
          return (
            <BeadButton
              key={first.id}
              bead={first}
              left={xOf(first.time)}
              top={chiefY - 5}
              shown={shownCount === 1}
              selected={first.id === selected}
              onPick={pickMessage}
            />
          );
        return (
          <ClusterButton
            key={first.id}
            first={first}
            count={shownCount}
            left={xOf(cluster.reduce((sum, bead) => sum + bead.time, 0) / cluster.length)}
            top={chiefY - 9}
            onPick={pickMessage}
          />
        );
      })}
      {runs.flatMap((run) =>
        run.conversation.answers.map((answer) => (
          <PersonButton
            key={`${run.run}/${answer.time}`}
            run={run.run}
            time={answer.time}
            left={xOf(Date.parse(answer.time))}
            shown={Date.parse(answer.time) <= upto}
            onFocus={pickFocus}
          />
        )),
      )}
      {playhead === null ? null : (
        <>
          <div
            className="map-playhead"
            data-testid="map-playhead"
            style={{ left: xOf(playhead), height }}
          />
          {runs
            .filter((run) => live.has(run.run))
            .map((run) => (
              <span
                key={run.run}
                className="map-train"
                data-testid="map-train"
                data-run={run.run}
                style={{ left: xOf(playhead), top: rowY.get(run.run)! - 6 }}
              />
            ))}
        </>
      )}
      {pulse && pulsed?.onChief && pulsed.run !== null && !reducedMotion() ? (
        <span
          key={pulse.nonce}
          className="map-dot"
          data-testid="map-dot"
          data-id={pulsed.id}
          style={
            {
              left: xOf(pulsed.time),
              "--from": `${pulsed.message.from === "chief" ? chiefY : rowY.get(pulsed.run)}px`,
              "--to": `${pulsed.message.from === "chief" ? rowY.get(pulsed.run) : chiefY}px`,
            } as CSSProperties
          }
        />
      ) : null}
    </div>
  );
}

function MetroMap({
  runs,
  axis,
  onFull,
  ...drawing
}: {
  runs: ProjectRun[];
  beads: Bead[];
  axis: Axis;
  playhead: number | null;
  /** The run ids that are live at the playhead (or at the end when there is no replay). */
  live: ReadonlySet<string>;
  pulse: Replay["pulse"];
  selected: string | null;
  pickMessage: PickMessage;
  pickFocus: PickFocus;
  onFull: (full: boolean) => void;
}) {
  const slots = Math.max(axis.times.length - 1, 1);
  const height = rowStart + runs.length * rowHeight + padding;
  return (
    <GraphViewport
      width={(mode, available) => mapWidth(slots, mode, available)}
      height={height}
      label="Master Chief map"
      scrollClass="pc-scroll"
      onFullChange={onFull}
    >
      {(mode, width) => (
        <Drawing mode={mode} width={width} height={height} runs={runs} axis={axis} {...drawing} />
      )}
    </GraphViewport>
  );
}

// ---------- strip: to scale ----------

const bins = 96;

type PickMessage = (run: string | null, id: string) => void;
type PickFocus = (run: string, focus: InspectorFocus) => void;

/** The lanes and ticks never depend on the playhead, so a scrub leaves them alone. */
const StripLanes = memo(function StripLanes({
  full,
  runs,
  other,
  pickMessage,
  pickFocus,
}: {
  full: Range;
  runs: ProjectRun[];
  other: ConversationMessage[];
  pickMessage: PickMessage;
  pickFocus: PickFocus;
}) {
  const bars = density(sentTimes(runs, other), full, bins);
  const peak = Math.max(...bars, 1);
  const percent = (time: number) => `${((time - full.start) / (full.end - full.start)) * 100}%`;
  // A tick opens its message, as a bead of the map does; the click must not seek.
  const ticks = (messages: ConversationMessage[], run: string | null) =>
    messages
      .filter((message) => Number.isFinite(sentAt(message)))
      .map((message) => (
        <span
          key={message.id}
          className={`tscale-tick ty-${typeOf(message)}`}
          data-testid="strip-tick"
          data-id={message.id}
          data-run={run ?? ""}
          title={message.subject ?? typeOf(message)}
          style={{ left: percent(sentAt(message)) }}
          onClick={(event) => {
            event.stopPropagation();
            pickMessage(run, message.id);
          }}
        />
      ));
  return (
    <div className="tscale-grid">
      <span className="tscale-label mut">messages</span>
      <div className="tscale-density" aria-hidden="true">
        {bars.map((count, index) => (
          <span key={index} style={{ height: `${(count / peak) * 100}%` }} />
        ))}
      </div>
      <span className="tscale-label mono">Master Chief</span>
      <div className="tscale-lane" data-testid="strip-lane" data-run="">
        {ticks(other, null)}
        {runs.flatMap((run) =>
          run.conversation.answers.map((answer) => (
            <span
              key={`${run.run}/${answer.time}`}
              className="tscale-answer"
              data-testid="strip-answer"
              data-run={run.run}
              title={`You answered ${run.run}`}
              style={{ left: percent(Date.parse(answer.time)) }}
              onClick={(event) => {
                event.stopPropagation();
                pickFocus(run.run, { kind: "person", time: answer.time });
              }}
            />
          )),
        )}
      </div>
      {runs.map((run) => (
        <Fragment key={run.run}>
          <span className="tscale-label mono" title={run.run}>
            {run.run}
          </span>
          <div className="tscale-lane" data-testid="strip-lane" data-run={run.run}>
            {ticks(run.conversation.messages, run.run)}
          </div>
        </Fragment>
      ))}
    </div>
  );
});

function Strip({
  full,
  runs,
  other,
  playhead,
  seek,
  pickMessage,
  pickFocus,
}: {
  full: Range;
  runs: ProjectRun[];
  other: ConversationMessage[];
  playhead: number | null;
  seek: (time: number) => void;
  pickMessage: PickMessage;
  pickFocus: PickFocus;
}) {
  const hit = useRef<HTMLDivElement>(null);
  const dated = spansDays(full);
  return (
    <section
      className="tscale"
      data-testid="strip"
      aria-label="To scale"
      onClick={(event) => {
        // The lane area is the scrubber of the replay; the input above it works from the keyboard.
        const box = hit.current?.getBoundingClientRect();
        if (
          !box ||
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          return;
        seek(full.start + ((event.clientX - box.left) / box.width) * (full.end - full.start));
      }}
    >
      <header>
        <h3>To scale</h3>
        <span className="mut mono">
          {clockText(full.start, false, dated)} to {clockText(full.end, false, dated)}
        </span>
      </header>
      <StripLanes
        full={full}
        runs={runs}
        other={other}
        pickMessage={pickMessage}
        pickFocus={pickFocus}
      />
      <div className="tscale-hit" ref={hit} aria-hidden="true">
        {playhead === null ? null : (
          <span
            className="tscale-playhead"
            data-testid="strip-playhead"
            style={{ left: `${((playhead - full.start) / (full.end - full.start)) * 100}%` }}
          />
        )}
      </div>
    </section>
  );
}

// ---------- the view ----------

function NowPanel({
  now,
  playhead,
  pickMessage,
  owner,
}: {
  now: Now;
  playhead: number;
  pickMessage: (run: string | null, id: string) => void;
  owner: (id: string) => string | null;
}) {
  const clockAt = useClockText();
  return (
    <aside className="panel pc-now" data-testid="now" aria-label="Now">
      <header>
        <h3>Now</h3>
        <span className="mono mut" data-testid="now-time">
          {clockAt(playhead)}
        </span>
      </header>
      <dl className="cv-facts">
        <dt>Live runs</dt>
        <dd data-testid="now-live">{now.live.length}</dd>
        <dt>Messages</dt>
        <dd data-testid="now-messages">{now.messages}</dd>
        <dt>Human answers</dt>
        <dd data-testid="now-answers">{now.answers}</dd>
      </dl>
      <ul className="pc-list" aria-label="Live runs">
        {now.live.map((entry) => (
          <li key={entry.run} data-testid="now-run" data-run={entry.run}>
            <span className="mono">{entry.run}</span>{" "}
            <span className="mut" data-testid="now-step">
              {entry.step ?? "between steps"}
            </span>
          </li>
        ))}
      </ul>
      <h4>Latest messages</h4>
      <ol className="pc-list" aria-label="Latest messages" data-testid="now-latest">
        {now.latest.map((message) => (
          <li key={message.id} data-id={message.id}>
            <button type="button" onClick={() => pickMessage(owner(message.id), message.id)}>
              <span className="mut">{clockAt(sentAt(message))}</span> {typeOf(message)}:{" "}
              {message.subject ?? "(no subject)"}
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function Controls({
  filter,
  onFilter,
  types,
  runs,
}: {
  filter: ProjectFilter;
  onFilter: (filter: ProjectFilter) => void;
  types: Map<string, number>;
  runs: ProjectRun[];
}) {
  return (
    <div className="pc-controls">
      <div className="seg" role="group" aria-label="Message types">
        {[...types].map(([type, count]) => (
          <button
            key={type}
            type="button"
            aria-pressed={filter.types.has(type)}
            data-testid="map-type"
            data-type={type}
            onClick={() => {
              const next = new Set(filter.types);
              if (!next.delete(type)) next.add(type);
              onFilter({ ...filter, types: next });
            }}
          >
            {type} <span className="count">{count}</span>
          </button>
        ))}
      </div>
      <label>
        <span className="mut">Run </span>
        <select
          data-testid="map-run-filter"
          value={filter.run ?? ""}
          onChange={(event) => onFilter({ ...filter, run: event.target.value || null })}
        >
          <option value="">All runs</option>
          {runs.map((run) => (
            <option key={run.run} value={run.run}>
              {run.run}
            </option>
          ))}
        </select>
      </label>
      <input
        type="search"
        data-testid="map-search"
        placeholder="Search subjects"
        aria-label="Search subjects"
        title="Matches the subject only: the project read holds no message body."
        value={filter.search}
        onChange={(event) => onFilter({ ...filter, search: event.target.value })}
      />
    </div>
  );
}

function Loaded({
  reply,
  project,
  openRuns,
  plans,
}: {
  reply: ProjectReply;
  project: string | null;
  openRuns: RunView[] | null;
  plans: Map<string, RunView["plan"]>;
}) {
  const openStarted = useMemo(
    () => (openRuns ? new Map(openRuns.map((run) => [run.run, run.started_at])) : null),
    [openRuns],
  );
  const other = reply.other.messages;
  const allRuns = useMemo(
    () => projectRuns(reply.runs, project, openStarted),
    [reply.runs, project, openStarted],
  );
  const full = useMemo(() => projectRange(allRuns, other), [allRuns, other]);
  const axis = useMemo(() => buildAxis(allRuns, other), [allRuns, other]);
  const [filter, setFilter] = useState<ProjectFilter>(noFilter);
  const filtered = useMemo(() => filterProject(allRuns, other, filter), [allRuns, other, filter]);
  const beads = useMemo(() => buildBeads(filtered.runs, filtered.other), [filtered]);
  const sent = useMemo(
    () => buildBeads(allRuns, other).map((bead) => ({ id: bead.id, time: bead.time })),
    [allRuns, other],
  );
  const replay = useReplay(full, sent);
  const { playhead } = replay;
  const at = playhead ?? full.end;
  // The Now panel counts what the map and the strip show: the same filter, the same time.
  const now = useMemo(() => nowAt(filtered.runs, filtered.other, at), [filtered, at]);
  const live = useMemo(() => new Set(now.live.map((entry) => entry.run)), [now]);
  const types = useMemo(() => projectTypes(allRuns, other), [allRuns, other]);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [mapFull, setMapFull] = useState(false);
  const side = useRef<HTMLDivElement>(null);
  // A click must show its result: bring the inspector into view when the page is too narrow for the side column.
  useEffect(() => {
    if (selection)
      side.current
        ?.querySelector('[data-testid="inspector"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [selection]);
  const ownerOf = useMemo(() => {
    const owners = new Map<string, string | null>();
    for (const run of allRuns)
      for (const message of run.conversation.messages) owners.set(message.id, run.run);
    return (id: string) => owners.get(id) ?? null;
  }, [allRuns]);
  const unowned = useMemo(
    () => ({
      run: "",
      project: project ?? "",
      agents: reply.other.agents,
      spans: [],
      answers: [],
      questions: [],
      messages: other,
    }),
    [reply.other.agents, other, project],
  );
  const owning = selection
    ? selection.run === null
      ? unowned
      : (allRuns.find((run) => run.run === selection.run)?.conversation ?? null)
    : null;
  const pickMessage = useCallback(
    (run: string | null, id: string) =>
      setSelection({ run, message: id, agent: null, focus: null }),
    [],
  );
  const pickFocus = useCallback(
    (run: string, focus: InspectorFocus) =>
      setSelection({ run, message: null, agent: null, focus }),
    [],
  );

  if (allRuns.length === 0)
    return <p className="mut empty">No run of this project has a message in the window.</p>;
  return (
    <DatedContext.Provider value={spansDays(full)}>
      <Controls filter={filter} onFilter={setFilter} types={types} runs={allRuns} />
      <div
        className={`pc-top${mapFull ? " pc-over" : ""}${mapFull && selection ? " pc-inspecting" : ""}`}
      >
        <section className="panel pc-map" aria-label="Metro map">
          <header>
            <h3>In order, not to scale</h3>
            <span className="hint">
              Every event takes the next slot. Click a run line or its label to open the run.
            </span>
          </header>
          <MetroMap
            runs={filtered.runs}
            beads={beads}
            axis={axis}
            playhead={playhead}
            live={live}
            pulse={replay.pulse}
            selected={selection?.message ?? null}
            pickMessage={pickMessage}
            pickFocus={pickFocus}
            onFull={setMapFull}
          />
        </section>
        <div className="pc-side" ref={side}>
          {owning && selection ? (
            <Inspector
              conversation={owning}
              selected={selection.message}
              agent={selection.agent}
              focus={selection.focus}
              sessions={null}
              plan={selection.run === null ? null : (plans.get(selection.run) ?? null)}
              onSelect={(id) => pickMessage(selection.run, id)}
              onAgent={(id) =>
                setSelection({ ...selection, message: null, agent: id, focus: null })
              }
            />
          ) : (
            <aside className="cv-inspector" aria-label="Inspector" data-testid="inspector">
              <p className="mut">Click a message, a step, a person or a run to inspect it.</p>
            </aside>
          )}
          <NowPanel now={now} playhead={at} pickMessage={pickMessage} owner={ownerOf} />
        </div>
      </div>
      <Player full={full} replay={replay} />
      <Strip
        full={full}
        runs={filtered.runs}
        other={filtered.other}
        playhead={playhead}
        seek={replay.seek}
        pickMessage={pickMessage}
        pickFocus={pickFocus}
      />
    </DatedContext.Provider>
  );
}

/** The Conversation mode of the Runs page: Master Chief and the runs of the project, over the window. */
export function ProjectConversation({
  project,
  openRuns,
}: {
  project: string | null;
  openRuns: RunView[] | null;
}) {
  const refreshKey = openRuns?.map((run) => `${run.run}:${run.updated_at}`).join("|") ?? "";
  const state = useProjectConversation(refreshKey);
  const plans = useMemo(
    () => new Map((openRuns ?? []).map((run) => [run.run, run.plan])),
    [openRuns],
  );
  if (state.status === "loading") return <p className="mut">Reading the conversation…</p>;
  if (state.status === "failed")
    return (
      <p className="bad-text" role="alert">
        The hub could not read the conversation: {state.reason}.
      </p>
    );
  return (
    <section data-testid="project-conversation" aria-label="Conversation">
      {state.failure === null ? null : (
        <p className="warn-box" role="alert" data-testid="conversation-refetch-failed">
          The hub could not read the conversation just now ({state.failure}): this shows the last
          read.
        </p>
      )}
      <Notices reply={state.reply} />
      <Loaded reply={state.reply} project={project} openRuns={openRuns} plans={plans} />
    </section>
  );
}
