// test ids: step-node (data-step, data-status), step-cost, step-edge (data-from, data-to),
// step-row, run-select, run-waiting, run-age, closed-banner, session-link (data-step)
import { useEffect, useRef } from "react";
import {
  ArrowMarker,
  Cost,
  Phase,
  Unknown,
  attentionOf,
  duration,
  known,
  stepStatus,
} from "./format.tsx";
import type { Attention } from "./format.tsx";
import { Agents } from "./Home.tsx";
import { detourPath, edgePath, layout } from "./layout.ts";
import {
  RunFiles,
  SessionLists,
  Timeline,
  runHref,
  sessionName,
  useRunDetail,
} from "./RunDetail.tsx";
import { useAge, useLive, type Route } from "./store.tsx";
import { FileView, Transcript } from "./Transcript.tsx";
import type { PlanStepView, RunDetail, RunView } from "../types.ts";

const nodeWidth = 240;
const nodeHeight = 92;
const gapX = 70;
const gapY = 24;
const pad = 10;

const statusLabel: Record<PlanStepView["status"], string> = {
  pending: "pending",
  running: "running",
  succeeded: "done",
  failed: "failed",
  stopped: "stopped",
};

function Dag({
  run,
  plan,
  attention,
}: {
  run: string;
  plan: PlanStepView[];
  attention: Attention[];
}) {
  const age = useAge();
  const box = useRef<HTMLDivElement>(null);
  const { placed, edges } = layout(plan.map((step) => ({ id: step.id, needs: step.needs })));
  const column = new Map(placed.map(({ id, col }) => [id, col]));
  const skips = edges.filter(({ from, to }) => column.get(to)! - column.get(from)! > 1);
  // Room above the boxes for one lane per skipping edge.
  const top = pad + (skips.length > 0 ? 8 * skips.length + 8 : 0);
  const at = new Map(
    placed.map(({ id, col, row }) => [
      id,
      { x: pad + col * (nodeWidth + gapX), y: top + row * (nodeHeight + gapY) },
    ]),
  );
  const width = Math.max(...placed.map((p) => p.col), 0) * (nodeWidth + gapX) + nodeWidth + 2 * pad;
  const height =
    top + Math.max(...placed.map((p) => p.row), 0) * (nodeHeight + gapY) + nodeHeight + pad;
  // The page opens on the work in progress: the running steps centered, or the first one when they do not fit.
  const running = plan
    .filter((step) => step.status === "running")
    .map((step) => at.get(step.id)!.x);
  const runningStart = Math.min(...running);
  const runningEnd = Math.max(...running) + nodeWidth;
  useEffect(() => {
    const view = box.current;
    if (!view || running.length === 0) return;
    const fits = runningEnd - runningStart <= view.clientWidth;
    const middle = fits ? (runningStart + runningEnd) / 2 : runningStart + nodeWidth / 2;
    view.scrollLeft = Math.max(0, middle - view.clientWidth / 2);
    // Re-run only when the running steps move, never on each snapshot: the reader may have scrolled.
  }, [runningStart, runningEnd, running.length]);
  return (
    <div ref={box} className="graph" tabIndex={0} role="region" aria-label="Plan DAG, scrollable">
      <svg role="group" aria-label="Plan dependency graph" width={width} height={height}>
        <ArrowMarker id="arrow-dag" />
        {edges.map(({ from, to }) => {
          const start = at.get(from)!;
          const end = at.get(to)!;
          const lane = skips.findIndex((edge) => edge.from === from && edge.to === to);
          const [x1, y1, x2, y2] = [
            start.x + nodeWidth,
            start.y + nodeHeight / 2,
            end.x,
            end.y + nodeHeight / 2,
          ];
          return (
            <path
              key={`${from}>${to}`}
              className="edge"
              data-testid="step-edge"
              data-from={from}
              data-to={to}
              markerEnd="url(#arrow-dag)"
              d={lane < 0 ? edgePath(x1, y1, x2, y2) : detourPath(x1, y1, x2, y2, pad + 8 * lane)}
            />
          );
        })}
        {plan.map((step) => {
          const { x, y } = at.get(step.id)!;
          const state = stepStatus(step, attention, age, statusLabel);
          return (
            <g
              key={step.id}
              className={`s-${state.tone}`}
              data-testid="step-node"
              data-step={step.id}
              data-status={step.status}
            >
              <a
                href={runHref(run, "step", step.id)}
                aria-label={`${step.id}, ${state.label}, open transcript`}
              >
                <title>{`${step.id}: ${step.role} · ${step.harness} · ${step.model}`}</title>
                <rect className="box" x={x} y={y} width={nodeWidth} height={nodeHeight} rx={8} />
                <text className="name" x={x + 12} y={y + 24}>
                  {step.id}
                </text>
                <text x={x + 12} y={y + 44}>
                  {step.role} · {step.harness}
                </text>
                <text className="m" x={x + 12} y={y + 62}>
                  {step.model}
                </text>
                <text className="status" x={x + 12} y={y + 82}>
                  ● {state.label}
                </text>
                <text
                  className="cost"
                  data-testid="step-cost"
                  x={x + nodeWidth - 12}
                  y={y + 82}
                  textAnchor="end"
                  style={step.cost_usd === null ? { fill: "#8b93a1" } : { fill: "#d8dce3" }}
                >
                  {step.cost_usd === null ? "unknown" : `$${step.cost_usd.toFixed(2)}`}
                </text>
              </a>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** One step's session files, or what to say when it has none. */
function stepSessions(detail: RunDetail | null, step: string) {
  return detail?.sessions.filter(
    (session) => session.owner.kind === "step" && session.owner.step === step,
  );
}

function Body({
  run,
  detail,
  loading,
  open,
}: {
  run: RunView;
  detail: RunDetail | null;
  loading: boolean;
  open: boolean;
}) {
  const age = useAge();
  const closed = run.phase === "closed";
  const edges = run.plan?.reduce((sum, step) => sum + step.needs.length, 0) ?? 0;
  const attention = closed ? [] : attentionOf(run, age);
  return (
    <>
      {closed && (
        <div className="closed-banner" data-testid="closed-banner">
          <span className="pill">closed</span> {run.run}
          {detail?.outcome ? ` · ${detail.outcome}` : ""}{" "}
          <span className="mut ended">no agents in Orca</span>
        </div>
      )}
      {attention.length > 0 && (
        <section className="needs" aria-label="This run waits">
          {attention.map((item) => (
            <p key={`${item.step}/${item.kind}`} data-testid="run-waiting" data-kind={item.kind}>
              <span className="pill warn">{item.label}</span>{" "}
              {item.step ? <span className="mono">{item.step}: </span> : null}
              {item.reason}
            </p>
          ))}
        </section>
      )}
      {open && (
        <>
          <h2>Agents</h2>
          <Agents agents={run.agents} />
        </>
      )}
      {run.plan === null ? (
        <>
          <h2>Plan DAG</h2>
          <Unknown /> <span className="mut">No plan yet.</span>
        </>
      ) : (
        <>
          <h2>
            Plan DAG · {run.plan.length} steps · {edges} edges
          </h2>
          <Dag run={run.run} plan={run.plan} attention={attention} />
          <h2>Steps</h2>
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Role</th>
                <th>Harness</th>
                <th>Model</th>
                <th>Status</th>
                <th>Cost</th>
                <th>Transcript</th>
              </tr>
            </thead>
            <tbody>
              {run.plan.map((step) => {
                const sessions = stepSessions(detail, step.id);
                return (
                  <tr key={step.id} data-testid="step-row" data-step={step.id}>
                    <td className="id nw">{step.id}</td>
                    <td className="nw">{step.role}</td>
                    <td className="nw">{step.harness}</td>
                    <td className="mono wrap">{step.model}</td>
                    <td
                      className={
                        stepStatus(step, attention, age, statusLabel).tone === "waiting"
                          ? "nw amber"
                          : "nw"
                      }
                    >
                      {stepStatus(step, attention, age, statusLabel).label}
                    </td>
                    <td className="nw">
                      <Cost usd={step.cost_usd} testId="step-row-cost" />
                    </td>
                    <td className="nw">
                      {sessions && sessions.length > 0 ? (
                        <a
                          href={runHref(run.run, "step", step.id)}
                          data-testid="session-link"
                          data-step={step.id}
                        >
                          Open
                        </a>
                      ) : (
                        <span className="mut">{loading ? "…" : "no session file"}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      <div className="cols">
        <div>
          <h2>Decisions · {detail ? detail.timeline.length : "…"} events</h2>
          {detail ? <Timeline entries={detail.timeline} /> : <p className="mut">Reading…</p>}
        </div>
        <div>
          <h2>Run files</h2>
          {detail ? (
            <RunFiles run={run.run} files={detail.files} />
          ) : (
            <p className="mut">Reading…</p>
          )}
          {detail && (
            <SessionLists run={run.run} sessions={detail.sessions} ready={detail.sessions_ready} />
          )}
        </div>
      </div>
    </>
  );
}

export function Run({ run: wanted, sub }: { run: string | null; sub: Route["sub"] }) {
  const { snapshot } = useLive();
  const age = useAge();
  const openRuns = snapshot && known(snapshot.runs) ? snapshot.runs : null;
  const open = openRuns
    ? (openRuns.find((candidate) => candidate.run === wanted) ??
      (wanted ? null : (openRuns.find((candidate) => candidate.plan !== null) ?? openRuns[0])))
    : null;
  const target = wanted ?? open?.run ?? null;
  const usageReady = snapshot?.sources.usage.read_at != null;
  const state = useRunDetail(target, `${open?.updated_at ?? ""}|${usageReady}`);
  const detail = state.status === "ok" ? state.detail : null;
  const run = open ?? detail?.view ?? null;
  if (!run)
    return (
      <>
        <h1>Run</h1>
        {target === null ? (
          openRuns ? (
            <p className="mut">
              No open runs. <a href="#/map">Back to the Map</a>
            </p>
          ) : (
            <Unknown />
          )
        ) : state.status === "missing" ? (
          <p className="mut">
            No open run {target}, and no closed run by that name.{" "}
            <a href="#/map">Back to the Map</a>
          </p>
        ) : state.status === "failed" ? (
          <p className="bad-text">The hub could not read run {target}.</p>
        ) : (
          <p className="mut">Reading the run…</p>
        )}
      </>
    );

  if (sub?.kind === "file" && sub.arg)
    return <FileView run={run.run} ticket={run.ticket.id} path={sub.arg} />;
  if (sub) {
    const sessions =
      sub.kind === "step"
        ? detail?.sessions.filter((s) => s.owner.kind === "step" && s.owner.step === sub.arg)
        : sub.kind === "lead"
          ? detail?.sessions.filter((s) => s.owner.kind === "lead")
          : detail?.sessions.filter((s) => s.file === sub.arg);
    if (!sessions)
      return (
        <>
          <p className="crumb">
            <a href={runHref(run.run)}>← {run.ticket.id}</a> · transcript
          </p>
          <p className={state.status === "failed" ? "bad-text" : "mut"}>
            {state.status === "failed" ? "The hub could not read this run." : "Reading the run…"}
          </p>
        </>
      );
    return (
      <Transcript
        run={run.run}
        ticket={run.ticket.id}
        title={
          sub.kind === "step"
            ? (sub.arg ?? "step")
            : sub.kind === "lead"
              ? "Run lead"
              : sessions[0]
                ? sessionName(sessions[0])
                : "Session file"
        }
        sessions={sessions}
        empty={
          detail && !detail.sessions_ready
            ? "The session files are not indexed yet. Try again in a few seconds."
            : "No session file maps here. A worker that starts before its step is recorded shows under Unassigned session files."
        }
      />
    );
  }

  const options = openRuns?.some((candidate) => candidate.run === run.run)
    ? (openRuns ?? [])
    : [run, ...(openRuns ?? [])];
  return (
    <>
      <h1>
        {run.ticket.id} · {run.ticket.title}{" "}
        <span className="pill">
          <Phase phase={run.phase} />
        </span>
      </h1>
      <div className="toolbar">
        {options.length > 1 && (
          <select
            aria-label="Run"
            name="run"
            data-testid="run-select"
            value={run.run}
            onChange={(event) => (location.hash = runHref(event.target.value))}
          >
            {options.map((candidate) => (
              <option key={candidate.run} value={candidate.run}>
                {candidate.ticket.id} · {candidate.run}
              </option>
            ))}
          </select>
        )}
        <span className="mut">
          Run cost <Cost usd={run.cost_usd} />
        </span>
        <span className="mut" data-testid="run-age">
          started {duration(age(run.started_at))} ago · last event {duration(age(run.updated_at))}{" "}
          ago
        </span>
      </div>
      <Body run={run} detail={detail} loading={state.status === "loading"} open={open !== null} />
    </>
  );
}
