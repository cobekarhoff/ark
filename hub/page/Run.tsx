import { GraphViewport } from "./GraphViewport.tsx";
import { Agents } from "./Agents.tsx";
import { ClosedBand } from "./ClosedBand.tsx";
import { TimeBar } from "./TimeBar.tsx";
import {
  ArrowMarker,
  Cost,
  ExternalLink,
  Phase,
  Ring,
  Unknown,
  attentionOf,
  duration,
  isSlow,
  known,
  stepStatus,
  currentStepText,
  OutsideNote,
  ProjectValue,
} from "./format.tsx";
import type { Attention } from "./format.tsx";
import { TestEvidence } from "./Evidence.tsx";
import { MergeRequest } from "./Home.tsx";
import { layout } from "./layout.ts";
import {
  RunFiles,
  SessionLists,
  Timeline,
  runHref,
  sessionName,
  useRunDetail,
} from "./RunDetail.tsx";
import { hashOf, ticketHref, useAge, useLive, type Route } from "./store.tsx";
import { FileView, Transcript } from "./Transcript.tsx";
import type { PlanStepView, RunDetail, RunView } from "../types.ts";

const nodeWidth = 250;
const nodeHeight = 92;
const gapX = 24;
const gapY = 36;
const pad = 10;

/**
 * The plan from top to bottom: a step is a row of the layout, steps that can run together sit side
 * by side. An edge that skips a row runs down a lane left of the boxes, so it never passes behind one.
 */
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
  const { placed, edges } = layout(plan.map((step) => ({ id: step.id, needs: step.needs })));
  const level = new Map(placed.map(({ id, col }) => [id, col]));
  const skips = edges.filter(({ from, to }) => level.get(to)! - level.get(from)! > 1);
  // Room left of the boxes for one lane per skipping edge.
  const left = pad + (skips.length > 0 ? 10 * skips.length + 8 : 0);
  const at = new Map(
    placed.map(({ id, col, row }) => [
      id,
      { x: left + row * (nodeWidth + gapX), y: pad + col * (nodeHeight + gapY) },
    ]),
  );
  const width =
    left + Math.max(...placed.map((p) => p.row), 0) * (nodeWidth + gapX) + nodeWidth + pad;
  const height =
    pad + Math.max(...placed.map((p) => p.col), 0) * (nodeHeight + gapY) + nodeHeight + pad;
  const running = plan.find((step) => step.status === "running");
  // The page opens on the work in progress: the viewport scrolls the running step into the middle.
  const runningY = running ? at.get(running.id)!.y + nodeHeight / 2 : null;
  return (
    <GraphViewport
      width={width}
      height={height}
      label="Plan DAG"
      scrollClass="graph"
      focusY={runningY}
    >
      <svg role="group" aria-label="Plan dependency graph" width={width} height={height}>
        <ArrowMarker id="arrow-dag" />
        {edges.map(({ from, to }) => {
          const start = at.get(from)!;
          const end = at.get(to)!;
          const lane = skips.findIndex((edge) => edge.from === from && edge.to === to);
          const [x1, y1, x2, y2] = [
            start.x + nodeWidth / 2,
            start.y + nodeHeight,
            end.x + nodeWidth / 2,
            end.y,
          ];
          const middle = (y1 + y2) / 2;
          const laneX = pad + 10 * lane;
          return (
            <path
              key={`${from}>${to}`}
              className="edge"
              data-testid="step-edge"
              data-from={from}
              data-to={to}
              markerEnd="url(#arrow-dag)"
              d={
                lane < 0
                  ? `M${x1},${y1} C${x1},${middle} ${x2},${middle} ${x2},${y2}`
                  : `M${x1},${y1} C${x1},${y1 + 30} ${laneX},${y1 + 30} ${laneX},${y1 + 60} L${laneX},${y2 - 60} C${laneX},${y2 - 30} ${x2},${y2 - 30} ${x2},${y2}`
              }
            />
          );
        })}
        {plan.map((step) => {
          const { x, y } = at.get(step.id)!;
          const state = stepStatus(step, attention, age);
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
                  className={step.cost_usd === null ? "cost unk" : "cost"}
                  data-testid="step-cost"
                  x={x + nodeWidth - 12}
                  y={y + 82}
                  textAnchor="end"
                >
                  {step.cost_usd === null ? "unknown" : `$${step.cost_usd.toFixed(2)}`}
                </text>
              </a>
            </g>
          );
        })}
      </svg>
    </GraphViewport>
  );
}

/** One step's session files, or what to say when it has none. */
function stepSessions(detail: RunDetail | null, step: string) {
  return detail?.sessions.filter(
    (session) => session.owner.kind === "step" && session.owner.step === step,
  );
}

/** The steps done, the round, the time in the step against its role, the cost and the start. */
function Strip({ run }: { run: RunView }) {
  const age = useAge();
  const progress = run.progress;
  const done =
    progress?.steps_done ?? run.plan?.filter((step) => step.status === "succeeded").length ?? 0;
  const total = progress?.steps_total ?? run.plan?.length ?? 0;
  const current = progress?.current ?? null;
  const elapsed = current ? age(current.started_at) : 0;
  const scale = current?.slow_above_seconds ? current.slow_above_seconds * 1000 : null;
  return (
    <section className="strip" aria-label="Progress">
      <div>
        <span className="label">Steps</span>
        <span className="strip-value">
          <Ring done={done} total={total} />
          <b className="mono" data-testid="steps-done">
            {done} of {total}
          </b>
        </span>
      </div>
      <div>
        <span className="label">Round</span>
        <b className="mono strip-value" data-testid="round">
          {progress ? `round ${progress.round} of ${progress.round_budget}` : `round ${run.round}`}
        </b>
      </div>
      <div className="wide">
        <span className="label">Time in step vs typical</span>
        {current ? (
          <>
            <span className="meter" aria-hidden="true">
              <i
                className={isSlow(current, elapsed) ? "slow" : ""}
                style={{ width: `${scale ? Math.min(100, (elapsed / scale) * 100) : 0}%` }}
              />
            </span>
            <b className="mono" data-testid="step-time">
              {currentStepText(current, elapsed)}
            </b>
          </>
        ) : (
          <span className="mut">no step runs</span>
        )}
      </div>
      <div>
        <span className="label">Cost so far</span>
        <b className="strip-value">
          <Cost usd={run.cost_usd} />
        </b>
      </div>
      <div>
        <span className="label">Started</span>
        <b className="strip-value" data-testid="run-age">
          {duration(age(run.started_at))} ago
        </b>
      </div>
    </section>
  );
}

function Evidence({ run }: { run: RunView }) {
  const evidence = run.evidence;
  return (
    <section className="panel" data-testid="evidence">
      <header>
        <h2>Merge request</h2>
      </header>
      <div className="body">
        {run.merge_requests.length === 0 ? (
          <p className="mut">No merge request yet. It opens after the review step passes.</p>
        ) : null}
        {run.merge_requests.map((request) => (
          <div key={request.url} className="evidence-mr">
            <MergeRequest request={request} />
            {request.additions !== null ? (
              <span className="mut small">
                +{request.additions} −{request.deletions ?? 0} · {request.changed_files ?? 0} files
              </span>
            ) : null}
            <div className="checks">
              {request.checks.map((check) => (
                <span key={check.name} className="pill">
                  {check.url ? (
                    <ExternalLink url={check.url}>{check.name}</ExternalLink>
                  ) : (
                    check.name
                  )}{" "}
                  <span className="mut">{check.result}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
        {evidence ? (
          <>
            <ul className="links">
              {evidence.criteria.map((criterion) => (
                <li
                  key={criterion.id}
                  data-testid="evidence-criterion"
                  data-id={criterion.id}
                  data-status={criterion.status}
                >
                  <span className="mono">{criterion.id}</span>{" "}
                  <span
                    className={`pill ${criterion.status === "passing" ? "ok" : criterion.status === "failing" ? "bad" : "unk"}`}
                  >
                    {criterion.status}
                  </span>{" "}
                  <span className="mut">
                    {criterion.proof.length} {criterion.proof.length === 1 ? "test" : "tests"}
                    {criterion.proof.some((proof) => proof.result === "fail")
                      ? ", some failing"
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
            {evidence.findings ? (
              <p>
                Findings P1 {evidence.findings.p1} · P2 {evidence.findings.p2} · P3{" "}
                {evidence.findings.p3}{" "}
                <a href={runHref(run.run, "file", evidence.findings.path)}>open</a>
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
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
  const attention = closed ? [] : attentionOf(run, age);
  return (
    <>
      {closed ? (
        <div className="closed-banner" data-testid="closed-banner">
          <span className="pill">closed</span> {run.run}{" "}
          <span className="mut ended">no agents in Orca</span>
        </div>
      ) : null}
      {closed && detail?.band ? (
        <ClosedBand
          run={run.run}
          outcome={detail.outcome}
          closedAt={detail.closed_at}
          band={detail.band}
          timeSplit={detail.time_split}
          files={detail.files}
        />
      ) : null}
      {!closed && detail ? (
        <div className="open-top">
          <TimeBar split={detail.time_split} live />
        </div>
      ) : null}
      <Strip run={run} />
      <div className="runcols">
        <section className="panel plan-panel">
          <header>
            <h2>Plan</h2>
            <span className="count">{run.plan?.length ?? 0} steps</span>
            <span className="hint">click a step for its transcript</span>
          </header>
          {run.plan === null ? (
            <div className="body">
              <Unknown /> <span className="mut">No plan yet.</span>
            </div>
          ) : (
            <>
              <Dag run={run.run} plan={run.plan} attention={attention} />
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
                    const state = stepStatus(step, attention, age);
                    return (
                      <tr key={step.id} data-testid="step-row" data-step={step.id}>
                        <td className="id nw">{step.id}</td>
                        <td className="nw">{step.role}</td>
                        <td className="nw">{step.harness}</td>
                        <td className="mono wrap">{step.model}</td>
                        <td className={state.tone === "waiting" ? "nw amber" : "nw"}>
                          {state.label}
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
        </section>
        <div className="stack">
          {attention.length > 0 ? (
            <section className="panel warn-panel" aria-label="This run waits">
              <header>
                <h2>This run waits</h2>
              </header>
              <div className="body">
                {attention.map((item) => (
                  <p
                    key={`${item.step}/${item.kind}`}
                    data-testid="run-waiting"
                    data-kind={item.kind}
                  >
                    <span className="pill warn">{item.label}</span>{" "}
                    {item.step ? <span className="mono">{item.step}: </span> : null}
                    {item.reason}
                  </p>
                ))}
              </div>
            </section>
          ) : null}
          {open ? (
            <section className="panel">
              <header>
                <h2>Agents</h2>
                <span className="hint">run lead and workers</span>
              </header>
              <div className="body" data-testid="agents">
                <Agents agents={run.agents} />
              </div>
            </section>
          ) : null}
          <Evidence run={run} />
          <section className="panel">
            <header>
              <h2>Ticket</h2>
              <span className="mono mut">{run.ticket.id}</span>
            </header>
            <div className="body">
              <p className="strong">{run.ticket.title}</p>
              <a className="btn" href={ticketHref(run.ticket.id)} data-testid="ticket-link">
                Read ticket and dependency graph
              </a>
            </div>
          </section>
        </div>
      </div>
      <TestEvidence run={run.run} phase={run.phase} />
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
          {detail ? (
            <SessionLists run={run.run} sessions={detail.sessions} ready={detail.sessions_ready} />
          ) : null}
        </div>
      </div>
    </>
  );
}

export function Run({ run: wanted, sub }: { run: string; sub: Route["sub"] }) {
  const { snapshot } = useLive();
  const openRuns = snapshot && known(snapshot.runs) ? snapshot.runs : null;
  const open = openRuns?.find((candidate) => candidate.run === wanted) ?? null;
  const usageReady = snapshot?.sources.usage.read_at != null;
  const state = useRunDetail(wanted, `${open?.updated_at ?? ""}|${usageReady}`);
  const detail = state.status === "ok" ? state.detail : null;
  const run = open ?? detail?.view ?? null;
  if (!run)
    return (
      <>
        <h1>Run</h1>
        {state.status === "missing" ? (
          <p className="mut">
            No open run {wanted}, and no closed run by that name.{" "}
            <a href={hashOf("#/runs")}>Back to Runs</a>
          </p>
        ) : state.status === "failed" ? (
          <p className="bad-text">The hub could not read run {wanted}.</p>
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
        files={detail?.files ?? []}
        empty={
          detail && !detail.sessions_ready
            ? "The session files are not indexed yet. Try again in a few seconds."
            : "No session file maps here. A worker that starts before its step is recorded shows under Unassigned session files."
        }
      />
    );
  }

  return (
    <>
      <p className="crumb">
        <a href={hashOf("#/runs")}>← Runs</a>
      </p>
      <h1 className="run-title">
        <span className="pill">
          <Phase phase={run.phase} />
        </span>{" "}
        <span className="mono">{run.ticket.id}</span> {run.ticket.title}
      </h1>
      <p className="meta mut mono small">
        <span>{run.run}</span>
        <ProjectValue project={run.project} />
      </p>
      <OutsideNote project={run.project} />
      <Body run={run} detail={detail} loading={state.status === "loading"} open={open !== null} />
    </>
  );
}
