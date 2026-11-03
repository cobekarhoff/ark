// test ids: step-node (data-step, data-status), step-cost, step-edge (data-from, data-to),
// step-row, run-select
import { Cost, Phase, Unknown, known } from "./format.tsx";
import { edgePath, layout } from "./layout.ts";
import { useLive } from "./store.tsx";
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

function Dag({ plan }: { plan: PlanStepView[] }) {
  const { placed, edges } = layout(plan.map((step) => ({ id: step.id, needs: step.needs })));
  const at = new Map(
    placed.map(({ id, col, row }) => [
      id,
      { x: pad + col * (nodeWidth + gapX), y: pad + row * (nodeHeight + gapY) },
    ]),
  );
  const width = Math.max(...placed.map((p) => p.col), 0) * (nodeWidth + gapX) + nodeWidth + 2 * pad;
  const height =
    Math.max(...placed.map((p) => p.row), 0) * (nodeHeight + gapY) + nodeHeight + 2 * pad;
  return (
    <div className="graph" tabIndex={0} role="region" aria-label="Plan DAG, scrollable">
      <svg role="group" aria-label="Plan dependency graph" width={width} height={height}>
        {edges.map(({ from, to }) => {
          const start = at.get(from)!;
          const end = at.get(to)!;
          return (
            <path
              key={`${from}>${to}`}
              className="edge"
              data-testid="step-edge"
              data-from={from}
              data-to={to}
              d={edgePath(
                start.x + nodeWidth,
                start.y + nodeHeight / 2,
                end.x,
                end.y + nodeHeight / 2,
              )}
            />
          );
        })}
        {plan.map((step) => {
          const { x, y } = at.get(step.id)!;
          return (
            <g
              key={step.id}
              className={`s-${step.status}`}
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
                ● {statusLabel[step.status]}
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
        <p className="mut">{wanted ? `No open run ${wanted}.` : "No open runs."}</p>
      </>
    );
  const edges = run.plan?.reduce((sum, step) => sum + step.needs.length, 0) ?? 0;
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
      </div>
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
          <Dag plan={run.plan} />
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
                  <td className="id">{step.id}</td>
                  <td>{step.role}</td>
                  <td>{step.harness}</td>
                  <td className="mono">{step.model}</td>
                  <td>{statusLabel[step.status]}</td>
                  <td>
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
