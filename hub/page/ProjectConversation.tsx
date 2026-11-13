import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { ConversationMessage, ConversationReply, ProjectAnswer } from "../conversation.ts";
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
  runAtPlayhead,
  sentAt,
  sentTimes,
  slotOf,
  spansDays,
  typeOf,
  useClockText,
  waitingBands,
  type Axis,
  type Band,
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

function MetroMap({
  runs,
  other,
  axis,
  bands,
  playhead,
  live,
  pulse,
  selected,
  pickMessage,
  pickFocus,
  onFull,
}: {
  runs: ProjectRun[];
  other: ConversationMessage[];
  axis: Axis;
  bands: Band[];
  playhead: number | null;
  /** The run ids that are live at the playhead (or at the end when there is no replay). */
  live: ReadonlySet<string>;
  pulse: Replay["pulse"];
  selected: string | null;
  pickMessage: (run: string | null, id: string) => void;
  pickFocus: (run: string, focus: InspectorFocus) => void;
  onFull: (full: boolean) => void;
}) {
  const slots = Math.max(axis.times.length - 1, 1);
  const step = Math.max(minStep, Math.min(maxStep, targetWidth / slots));
  const x = (time: number) => labelWidth + padding + slotOf(axis, time) * step;
  const width = labelWidth + padding * 2 + slots * step;
  const height = rowStart + runs.length * rowHeight + padding;
  const endX = x(axis.times.at(-1) ?? 0);
  const rowY = new Map(runs.map((run, index) => [run.run, rowStart + (index + 0.5) * rowHeight]));
  const colorOf = new Map(runs.map((run, index) => [run.run, runColors[index % runColors.length]]));
  const beads = buildBeads(runs, other);
  const pulsed = pulse ? beads.find((bead) => bead.id === pulse.id) : undefined;
  return (
    <GraphViewport
      width={width}
      height={height}
      label="Master Chief map"
      scrollClass="pc-scroll"
      onFullChange={onFull}
    >
      {(mode) => (
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
              const color = colorOf.get(run.run);
              return (
                <g key={run.run} style={{ stroke: color }}>
                  <line
                    className="map-branch"
                    x1={x(run.start)}
                    x2={x(run.start)}
                    y1={chiefY}
                    y2={y}
                  />
                  {run.close === null ? null : (
                    <line
                      className="map-branch"
                      x1={x(run.close)}
                      x2={x(run.close)}
                      y1={y}
                      y2={chiefY}
                    />
                  )}
                </g>
              );
            })}
            {beads.map((bead) =>
              bead.onChief && bead.run !== null ? (
                <line
                  key={bead.id}
                  className="map-spur"
                  data-testid="map-spur"
                  data-id={bead.id}
                  data-thick={bead.spur}
                  data-type={typeOf(bead.message)}
                  x1={x(bead.time)}
                  x2={x(bead.time)}
                  y1={chiefY}
                  y2={rowY.get(bead.run)}
                />
              ) : null,
            )}
          </svg>
          <span className="map-chief-label mono" style={{ top: chiefY - 9 }}>
            Master Chief
          </span>
          {bands.map((band) => {
            const left = x(band.start);
            const right = x(
              Number.isFinite(band.end) ? band.end : (axis.times.at(-1) ?? band.start),
            );
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
            const left = x(run.start);
            const right = run.close === null ? endX : x(run.close);
            const state = live.has(run.run) ? "live" : "idle";
            return (
              <div
                key={run.run}
                className="map-run"
                data-testid="map-run"
                data-run={run.run}
                data-state={state}
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
              <button
                key={`${run.run}/${span.step}/${span.start}`}
                type="button"
                className={`map-station r-${span.group ?? "other"}`}
                data-testid="map-station"
                data-run={run.run}
                data-step={span.step}
                aria-label={`Step ${span.step} of ${run.run}`}
                title={`Step ${span.step} (${span.role})`}
                style={{ left: x(Date.parse(span.start)), top: rowY.get(run.run)! - 6 }}
                onClick={() =>
                  pickFocus(run.run, { kind: "station", step: span.step, start: span.start })
                }
              />
            )),
          )}
          {beads
            .filter((bead) => !bead.onChief && bead.run !== null)
            .map((bead) => (
              <button
                key={bead.id}
                type="button"
                className={`map-bead on-run ty-${typeOf(bead.message)}${bead.id === selected ? " sel" : ""}`}
                data-testid="map-bead"
                data-id={bead.id}
                aria-label={`${typeOf(bead.message)}: ${bead.message.subject ?? "no subject"}`}
                style={{ left: x(bead.time), top: rowY.get(bead.run!)! - 5 }}
                onClick={() => pickMessage(bead.run, bead.id)}
              />
            ))}
          {clusterBeads(beads, axis, mode === "actual", step).map((cluster) => {
            const first = cluster[0];
            const left = x(cluster.reduce((sum, bead) => sum + bead.time, 0) / cluster.length);
            return cluster.length === 1 ? (
              <button
                key={first.id}
                type="button"
                className={`map-bead on-chief ty-${typeOf(first.message)}${first.id === selected ? " sel" : ""}`}
                data-testid="map-bead"
                data-id={first.id}
                data-run={first.run ?? ""}
                data-spur={first.spur}
                aria-label={`${typeOf(first.message)}: ${first.message.subject ?? "no subject"}`}
                style={{ left: x(first.time), top: chiefY - 5 }}
                onClick={() => pickMessage(first.run, first.id)}
              />
            ) : (
              // ponytail: a cluster opens its first message; zoom to 100% to pick each one.
              <button
                key={first.id}
                type="button"
                className="map-cluster"
                data-testid="map-cluster"
                data-count={cluster.length}
                aria-label={`${cluster.length} messages; zoom to 100% to see each`}
                title={`${cluster.length} messages: zoom to 100% to see each`}
                style={{ left, top: chiefY - 9 }}
                onClick={() => pickMessage(first.run, first.id)}
              >
                {cluster.length}
              </button>
            );
          })}
          {runs.flatMap((run) =>
            run.conversation.answers.map((answer) => (
              <button
                key={`${run.run}/${answer.time}`}
                type="button"
                className="map-person"
                data-testid="map-person"
                data-run={run.run}
                aria-label={`You answered ${run.run}`}
                style={{ left: x(Date.parse(answer.time)), top: chiefY - 24 }}
                onClick={() => pickFocus(run.run, { kind: "person", time: answer.time })}
              >
                <Person />
              </button>
            )),
          )}
          {playhead === null ? null : (
            <>
              <div
                className="map-playhead"
                data-testid="map-playhead"
                style={{ left: x(playhead), height }}
              />
              {runs
                .filter((run) => live.has(run.run))
                .map((run) => (
                  <span
                    key={run.run}
                    className="map-train"
                    data-testid="map-train"
                    data-run={run.run}
                    style={{ left: x(playhead), top: rowY.get(run.run)! - 6 }}
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
                  left: x(pulsed.time),
                  "--from": `${pulsed.message.from === "chief" ? chiefY : rowY.get(pulsed.run)}px`,
                  "--to": `${pulsed.message.from === "chief" ? rowY.get(pulsed.run) : chiefY}px`,
                } as CSSProperties
              }
            />
          ) : null}
        </div>
      )}
    </GraphViewport>
  );
}

// ---------- strip: to scale ----------

const bins = 96;

function Strip({
  full,
  runs,
  other,
  playhead,
  seek,
}: {
  full: Range;
  runs: ProjectRun[];
  other: ConversationMessage[];
  playhead: number | null;
  seek: (time: number) => void;
}) {
  const dated = spansDays(full);
  const bars = density(sentTimes(runs, other), full, bins);
  const peak = Math.max(...bars, 1);
  const percent = (time: number) => `${((time - full.start) / (full.end - full.start)) * 100}%`;
  const ticks = (messages: ConversationMessage[], run: string) =>
    messages
      .filter((message) => Number.isFinite(sentAt(message)))
      .map((message) => (
        <span
          key={message.id}
          className={`tscale-tick ty-${typeOf(message)}`}
          data-testid="strip-tick"
          data-id={message.id}
          data-run={run}
          style={{ left: percent(sentAt(message)) }}
        />
      ));
  return (
    <section className="tscale" data-testid="strip" aria-label="To scale">
      <header>
        <h3>To scale</h3>
        <span className="mut mono">
          {clockText(full.start, false, dated)} to {clockText(full.end, false, dated)}
        </span>
      </header>
      <div className="tscale-grid">
        <span className="tscale-label mut">messages</span>
        <div className="tscale-density" aria-hidden="true">
          {bars.map((count, index) => (
            <span key={index} style={{ height: `${(count / peak) * 100}%` }} />
          ))}
        </div>
        <span className="tscale-label mono">Master Chief</span>
        <div className="tscale-lane" data-testid="strip-lane" data-run="">
          {ticks(other, "")}
          {runs
            .flatMap((run) => run.conversation.answers)
            .map((answer) => (
              <span
                key={`${answer.time}`}
                className="tscale-answer"
                data-testid="strip-answer"
                style={{ left: percent(Date.parse(answer.time)) }}
              />
            ))}
        </div>
        {runs.map((run) => (
          <StripLane key={run.run} run={run} ticks={ticks(run.conversation.messages, run.run)} />
        ))}
      </div>
      {/* The grid has one column of lanes; the click target is the lane area, the scrubber is the input above. */}
      <div
        className="tscale-hit"
        role="presentation"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          seek(full.start + ((event.clientX - box.left) / box.width) * (full.end - full.start));
        }}
      >
        {playhead === null ? null : (
          <span
            className="tscale-playhead"
            data-testid="strip-playhead"
            style={{ left: percent(playhead) }}
          />
        )}
      </div>
    </section>
  );
}

function StripLane({ run, ticks }: { run: ProjectRun; ticks: ReactNode }) {
  return (
    <>
      <span className="tscale-label mono" title={run.run}>
        {run.run}
      </span>
      <div className="tscale-lane" data-testid="strip-lane" data-run={run.run}>
        {ticks}
      </div>
    </>
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
  const sent = useMemo(
    () => buildBeads(allRuns, other).map((bead) => ({ id: bead.id, time: bead.time })),
    [allRuns, other],
  );
  const replay = useReplay(full, sent);
  const { playhead } = replay;
  // Per-run cuts are memoised by `runAtPlayhead`: a scrub that crosses nothing changes no run's data.
  const shown = useMemo(
    () =>
      playhead === null
        ? filtered
        : {
            runs: filtered.runs.map((run) => ({
              ...run,
              conversation: runAtPlayhead(run.conversation, playhead),
            })),
            other: filtered.other.filter((message) => sentAt(message) <= playhead),
          },
    [filtered, playhead],
  );
  const bands = useMemo(() => waitingBands(shown.runs, playhead ?? Infinity), [shown, playhead]);
  const at = playhead ?? full.end;
  const now = useMemo(() => nowAt(allRuns, other, at), [allRuns, other, at]);
  const live = useMemo(() => new Set(now.live.map((entry) => entry.run)), [now]);
  const types = useMemo(() => projectTypes(allRuns, other), [allRuns, other]);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [mapFull, setMapFull] = useState(false);
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
  const pickMessage = (run: string | null, id: string) =>
    setSelection({ run, message: id, agent: null, focus: null });
  const pickFocus = (run: string, focus: InspectorFocus) =>
    setSelection({ run, message: null, agent: null, focus });

  if (allRuns.length === 0)
    return <p className="mut empty">No run of this project has a message in the window.</p>;
  return (
    <DatedContext.Provider value={spansDays(full)}>
      <Controls filter={filter} onFilter={setFilter} types={types} runs={allRuns} />
      <section className="panel pc-map" aria-label="Metro map">
        <header>
          <h3>In order, not to scale</h3>
          <span className="hint">
            Every event takes the next slot. Click a run line or its label to open the run.
          </span>
        </header>
        <MetroMap
          runs={shown.runs}
          other={shown.other}
          axis={axis}
          bands={bands}
          playhead={playhead}
          live={live}
          pulse={replay.pulse}
          selected={selection?.message ?? null}
          pickMessage={pickMessage}
          pickFocus={pickFocus}
          onFull={setMapFull}
        />
      </section>
      <Player full={full} replay={replay} />
      <Strip
        full={full}
        runs={filtered.runs}
        other={filtered.other}
        playhead={playhead}
        seek={replay.seek}
      />
      <div className={mapFull ? "pc-main pc-over" : "pc-main"}>
        <NowPanel now={now} playhead={at} pickMessage={pickMessage} owner={ownerOf} />
        {owning && selection ? (
          <Inspector
            conversation={owning}
            selected={selection.message}
            agent={selection.agent}
            focus={selection.focus}
            sessions={null}
            plan={selection.run === null ? null : (plans.get(selection.run) ?? null)}
            onSelect={(id) => pickMessage(selection.run, id)}
            onAgent={(id) => setSelection({ ...selection, message: null, agent: id, focus: null })}
          />
        ) : (
          <aside className="cv-inspector" aria-label="Inspector" data-testid="inspector">
            <p className="mut">Click a message, a step, a person or a run to inspect it.</p>
          </aside>
        )}
      </div>
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
