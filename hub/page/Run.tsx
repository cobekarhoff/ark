// test ids: step-node (data-step, data-status), step-cost, step-edge (data-from, data-to),
// step-row, run-select, run-waiting, run-age
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
import { detourPath, edgePath, layout } from "./layout.ts";
import { useAge, useLive } from "./store.tsx";
import type { PlanStepView } from "../types.ts";

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

function Dag({ plan, attention }: { plan: PlanStepView[]; attention: Attention[] }) {
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
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function Run({ run: wanted }: { run: string | null }) {
  const { snapshot } = useLive();
  const age = useAge();
  if (!snapshot || !known(snapshot.runs))
    return (
      <>
        <h1>Run</h1>
        <Unknown />
      </>
    );
  const runs = snapshot.runs;
  const run =
    runs.find((candidate) => candidate.run === wanted) ??
    (wanted ? null : (runs.find((candidate) => candidate.plan !== null) ?? runs[0]));
  if (!run)
    return (
      <>
        <h1>Run</h1>
        <p className="mut">
          {wanted ? `No open run ${wanted}.` : "No open runs."} <a href="#/map">Back to the Map</a>
        </p>
      </>
    );
  const edges = run.plan?.reduce((sum, step) => sum + step.needs.length, 0) ?? 0;
  const attention = attentionOf(run, age);
  return (
    <>
      <h1>
        {run.ticket.id} · {run.ticket.title}{" "}
        <span className="pill">
          <Phase phase={run.phase} />
        </span>
      </h1>
      <div className="toolbar">
        {runs.length > 1 && (
          <select
            aria-label="Run"
            name="run"
            data-testid="run-select"
            value={run.run}
            onChange={(event) =>
              (location.hash = `#/run/${encodeURIComponent(event.target.value)}`)
            }
          >
            {runs.map((candidate) => (
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
          <Dag plan={run.plan} attention={attention} />
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
              </tr>
            </thead>
            <tbody>
              {run.plan.map((step) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
