import { Markdown } from "./Markdown.tsx";
import { OpenInOrca } from "./OrcaButton.tsx";
import {
  costByDay,
  dayOf,
  highestUsage,
  needsHuman,
  nearLimit,
  percent,
  reviewQueue,
  stuckAgents,
  isUnknownProject,
  scoped,
  type Stuck,
} from "./derive.ts";
import {
  Cost,
  ExternalLink,
  Phase,
  Unknown,
  UnknownProject,
  attentionOf,
  duration,
  isSlow,
  known,
  currentStepText,
  type Attention,
} from "./format.tsx";
import { Clock, runHref } from "./RunDetail.tsx";
import { useAge, useLive, useNow, useProject } from "./store.tsx";
import type {
  CriterionEvidence,
  Gate,
  MergeRequestView,
  ProviderWindow,
  RunView,
  Snapshot,
} from "../types.ts";

type Waiting = { run: RunView; item: Attention };

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function Tile({
  tile,
  label,
  value,
  note,
  tone,
}: {
  tile: string;
  label: string;
  value: React.ReactNode;
  note: React.ReactNode;
  tone?: "warn" | "alarm";
}) {
  return (
    <div className={tone ? `tile ${tone}` : "tile"} data-testid="tile" data-tile={tile}>
      <b className="big">{value}</b>
      <span className="tile-text">
        <span className="tile-label">{label}</span>
        <span className="tile-note">{note}</span>
      </span>
    </div>
  );
}

function Resets({ limit }: { limit: ProviderWindow }) {
  const now = useNow();
  if (limit.resets_at === null) return <>reset time unknown</>;
  return (
    <>
      resets <Clock time={limit.resets_at} /> · in{" "}
      {duration(Math.max(0, Date.parse(limit.resets_at) - now))}
    </>
  );
}

function Panel({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count?: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <header>
        <h2>
          {title}
          {count === undefined ? "" : ` · `}
          {count}
        </h2>
        {hint ? <span className="hint">{hint}</span> : null}
      </header>
      <div className="body">{children}</div>
    </section>
  );
}

function NeedsMe({ gates, waiting }: { gates: Gate[] | "unknown"; waiting: Waiting[] }) {
  const count = known(gates) ? gates.length + waiting.length : null;
  return (
    <Panel title="Needs me" count={count ?? <Unknown />} hint="gates and questions, oldest first">
      {count === 0 ? <p className="mut">Nothing waits for you.</p> : null}
      {known(gates)
        ? gates.map((gate) => (
            <div className="item" key={gate.id} data-testid="gate" data-gate={gate.id}>
              <div className="item-head">
                <span className="pill warn">{gate.kind}</span>
                <a className="mono strong" href={runHref(gate.run)}>
                  {gate.ticket}
                </a>
                <span className="mut end">
                  <Since time={gate.since} />
                </span>
              </div>
              <Markdown text={gate.question} />
              <div className="actions">
                {gate.review_url ? (
                  <ExternalLink
                    url={gate.review_url}
                    className="btn primary"
                    data-testid="gate-link"
                  >
                    Open Plannotator review ↗
                  </ExternalLink>
                ) : (
                  <span className="pill unk">no review</span>
                )}
                <a className="btn" href={runHref(gate.run)}>
                  Open run
                </a>
              </div>
            </div>
          ))
        : null}
      {waiting.map(({ run, item }) => (
        <div
          className="item"
          key={`${run.run}/${item.kind}/${item.step}/${item.reason}`}
          data-testid="waiting"
          data-run={run.run}
          data-kind={item.kind}
        >
          <div className="item-head">
            <span className="pill warn">{item.label}</span>
            <a className="mono strong" href={runHref(run.run)}>
              {run.ticket.id}
            </a>
          </div>
          <p>
            {item.step ? (
              <>
                Step <span className="mono">{item.step}</span>:{" "}
              </>
            ) : (
              "Run: "
            )}
            {item.reason}
          </p>
        </div>
      ))}
    </Panel>
  );
}

function Since({ time }: { time: string }) {
  const age = useAge();
  return <>{duration(age(time))}</>;
}

function StuckAgents({ stuck }: { stuck: Stuck[] }) {
  return (
    <Panel title="Stuck agents" count={stuck.length} hint="no progress for 5 min, or a prompt">
      {stuck.length === 0 ? <p className="mut">No agent is stuck.</p> : null}
      {stuck.map((entry) => (
        <div
          className="item"
          key={`${entry.run.run}/${entry.step}/${entry.agent?.terminal ?? entry.text}`}
          data-testid="stuck"
          data-run={entry.run.run}
          data-kind={entry.kind}
        >
          <div className="item-head">
            <span className={entry.kind === "waiting" ? "pill bad" : "pill warn"}>
              {entry.text}
            </span>
            <a className="mono strong" href={runHref(entry.run.run)}>
              {entry.run.ticket.id}
            </a>
            <span>{entry.agent?.role ?? entry.step}</span>
          </div>
          {entry.lastLine ? <pre className="term">{entry.lastLine}</pre> : null}
          <div className="actions">
            {entry.agent ? <OpenInOrca agent={entry.agent} /> : null}
            <a className="btn" href={runHref(entry.run.run)}>
              Open run
            </a>
          </div>
        </div>
      ))}
    </Panel>
  );
}

const ciClass = { passing: "ok", failing: "bad", pending: "warn", unknown: "unk" } as const;
const checkClass = { pass: "ok", fail: "bad", pending: "warn" } as const;

function proofTotals(criteria: CriterionEvidence[]) {
  let pass = 0;
  let fail = 0;
  for (const criterion of criteria)
    for (const proof of criterion.proof)
      if (proof.result === "pass") pass += 1;
      else if (proof.result === "fail") fail += 1;
  return { pass, fail };
}

export function MergeRequest({ request }: { request: MergeRequestView }) {
  return (
    <div data-testid="mr" data-state={request.state} className="mr">
      <ExternalLink url={request.url} className="mono strong">
        !{request.number}
      </ExternalLink>{" "}
      <span data-testid="mr-state">{request.state}</span>{" "}
      <span className={`pill ${ciClass[request.ci]}`} data-testid="ci" data-ci={request.ci}>
        {request.ci}
      </span>
    </div>
  );
}

function Review({ run, rank }: { run: RunView; rank: number }) {
  const age = useAge();
  const evidence = run.evidence;
  const totals = evidence ? proofTotals(evidence.criteria) : null;
  const passing = evidence?.criteria.filter((criterion) => criterion.status === "passing").length;
  const oldest = run.merge_requests
    .map((request) => request.created_at)
    .filter((time) => time !== null)
    .toSorted()[0];
  const size = run.merge_requests.reduce(
    (sum, request) => ({
      additions: sum.additions + (request.additions ?? 0),
      deletions: sum.deletions + (request.deletions ?? 0),
      files: sum.files + (request.changed_files ?? 0),
    }),
    { additions: 0, deletions: 0, files: 0 },
  );
  const sized = run.merge_requests.some((request) => request.additions !== null);
  return (
    <div className="item" data-testid="review" data-run={run.run}>
      <div className="item-head">
        <span className="rank">{rank}</span>
        <a className="mono strong" href={runHref(run.run)}>
          {run.ticket.id}
        </a>
        <span className="title2">{run.ticket.title}</span>
      </div>
      {run.merge_requests.map((request) => (
        <div key={request.url}>
          <MergeRequest request={request} />
          {request.checks.length > 0 ? (
            <div className="checks">
              {request.checks.map((check) => (
                <span
                  key={check.name}
                  className={`pill ${checkClass[check.result]}`}
                  data-testid="check"
                >
                  {check.url ? (
                    <ExternalLink url={check.url}>{check.name}</ExternalLink>
                  ) : (
                    check.name
                  )}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
      <dl className="stats">
        <div>
          <dt>Tests</dt>
          <dd data-testid="tests">
            {totals ? (
              <>
                <span className="mono">{totals.pass}</span> pass ·{" "}
                <span className={totals.fail > 0 ? "mono bad-text" : "mono"}>{totals.fail}</span>{" "}
                fail
              </>
            ) : (
              <span className="mut">unknown</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Findings</dt>
          <dd data-testid="findings">
            {evidence?.findings ? (
              <>
                <span className="mono">P1 {evidence.findings.p1}</span> ·{" "}
                <span className="mono">P2 {evidence.findings.p2}</span> ·{" "}
                <span className="mono">P3 {evidence.findings.p3}</span>{" "}
                <a
                  href={runHref(run.run, "file", evidence.findings.path)}
                  data-testid="findings-link"
                >
                  open
                </a>
              </>
            ) : (
              <span className="mut">no review file</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Diff</dt>
          <dd data-testid="diff">
            {sized ? (
              <>
                <span className="mono add">+{size.additions}</span>{" "}
                <span className="mono del">−{size.deletions}</span> · {size.files} files
              </>
            ) : (
              <span className="mut">unknown</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Waiting</dt>
          <dd data-testid="waited">
            {oldest ? duration(age(oldest)) : <span className="mut">unknown</span>}
          </dd>
        </div>
      </dl>
      <div className="acs">
        <span className="mut">
          Acceptance {evidence ? `${passing}/${evidence.criteria.length}` : "unknown"}
        </span>
        {evidence?.criteria.map((criterion, index) => (
          <span
            key={criterion.id}
            className={`ac ${criterion.status === "passing" ? "ok" : criterion.status === "failing" ? "bad" : "none"}`}
            data-testid="ac-square"
            data-status={criterion.status}
            title={`${criterion.id}: ${criterion.status}`}
          >
            {index + 1}
          </span>
        ))}
      </div>
    </div>
  );
}

function ReviewQueue({ runs }: { runs: RunView[] | "unknown" }) {
  const queue = known(runs) ? reviewQueue(runs) : null;
  return (
    <Panel title="Review queue" count={queue?.length ?? <Unknown />} hint="merge order">
      {queue === null ? <Unknown /> : null}
      {queue?.length === 0 ? <p className="mut">No merge request waits for review.</p> : null}
      {queue?.map((run, index) => (
        <Review key={run.run} run={run} rank={index + 1} />
      ))}
    </Panel>
  );
}

function Progress({ run }: { run: RunView }) {
  const age = useAge();
  const progress = run.progress;
  const elapsed = progress?.current ? age(progress.current.started_at) : 0;
  const idle = attentionOf(run, age).find((item) => item.kind === "idle");
  return (
    <div className="run" data-testid="run" data-run={run.run}>
      <div className="item-head">
        <a className="mono strong" href={runHref(run.run)}>
          {run.ticket.id}
        </a>
        <span className="title1">{run.ticket.title}</span>
      </div>
      <div className="run-line">
        <Phase phase={run.phase} />
        {progress ? (
          <>
            <span
              className="steps"
              aria-label={`${progress.steps_done} of ${progress.steps_total} steps`}
            >
              {Array.from({ length: progress.steps_total }, (_, index) => (
                <i key={index} className={index < progress.steps_done ? "on" : ""} />
              ))}
            </span>
            <span className="mono" data-testid="steps-done">
              {progress.steps_done}/{progress.steps_total}
            </span>
            <span className="mono" data-testid="round">
              round {progress.round} of {progress.round_budget}
            </span>
          </>
        ) : (
          <span className="mut">no plan yet</span>
        )}
        <span className="end">
          <Cost usd={run.cost_usd} />
        </span>
      </div>
      {progress?.current ? (
        <div className={isSlow(progress.current, elapsed) ? "step-time slow" : "step-time"}>
          <span data-testid="step-time">{currentStepText(progress.current, elapsed)}</span>
        </div>
      ) : null}
      <div className="mut small">
        <span data-testid="run-age">last event {duration(age(run.updated_at))} ago</span>
        {idle ? (
          <>
            {" "}
            · <span data-testid="run-idle">{idle.label}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function UsageWindow({ limit }: { limit: ProviderWindow }) {
  const near = nearLimit(limit);
  const fraction = limit.used_fraction;
  return (
    <div
      className={near ? "usage near" : "usage"}
      data-testid="usage-window"
      data-provider={limit.provider}
      data-window={limit.window}
      data-near={near}
    >
      <div className="usage-head">
        <b>{limit.provider}</b> <span className="mut">{limit.window} window · all projects</span>
        <b className="end big-pct">{fraction === null ? "unknown" : `${percent(fraction)}%`}</b>
      </div>
      <div className="meter" aria-hidden="true">
        <i style={{ width: `${Math.min(100, percent(fraction ?? 0))}%` }} />
      </div>
      <div className="small" data-testid="usage-reset">
        <Resets limit={limit} />
        {near ? " · agents will stall until it resets" : ""}
      </div>
    </div>
  );
}

function Usage({ snapshot }: { snapshot: Snapshot }) {
  const limits = snapshot.provider_limits;
  const days = costByDay(snapshot);
  const today = new Date();
  const lastDays = Array.from({ length: 5 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (4 - index));
    return { day: dayOf(date), cost: days.get(dayOf(date)) ?? 0 };
  });
  const most = Math.max(1, ...lastDays.map((entry) => entry.cost));
  return (
    <Panel title="Usage and cost" hint="daily cost, USD">
      {known(limits) ? (
        limits.length === 0 ? (
          <p className="mut">No provider limit reported.</p>
        ) : (
          limits.map((limit) => (
            <UsageWindow key={`${limit.provider}/${limit.window}`} limit={limit} />
          ))
        )
      ) : (
        <Unknown />
      )}
      <div className="days">
        {lastDays.map((entry, index) => (
          <div key={entry.day} data-testid="cost-day" data-day={entry.day}>
            <span className="mono">{dollars.format(entry.cost)}</span>
            <i style={{ height: `${Math.max(2, (entry.cost / most) * 48)}px` }} />
            <span className="mut small">{index === 4 ? "today" : entry.day.slice(5)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function Home() {
  const { snapshot: whole } = useLive();
  const age = useAge();
  const project = useProject();
  if (!whole)
    return (
      <>
        <h1 className="sr">Home</h1>
        <p className="mut">
          <Unknown />
        </p>
      </>
    );
  if (isUnknownProject(whole, project))
    return (
      <>
        <h1>Home</h1>
        <UnknownProject project={project!} />
      </>
    );
  const snapshot = scoped(whole, project);
  const { runs, gates } = snapshot;
  const waiting = known(runs)
    ? runs.flatMap((run) =>
        // An idle step is a guess, not a gate: it shows under Stuck agents, never here.
        attentionOf(run, age)
          .filter((item) => item.kind === "waiting")
          .map((item) => ({ run, item })),
      )
    : [];
  const stuck = stuckAgents(snapshot, age);
  const queue = known(runs) ? reviewQueue(runs) : [];
  const needs = known(gates) ? gates.length + waiting.length : null;
  const top = highestUsage(snapshot.provider_limits);
  const days = costByDay(snapshot);
  const todayCost = days.get(dayOf(new Date())) ?? 0;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const oldestReview = queue
    .flatMap((run) => run.merge_requests.map((request) => request.created_at))
    .filter((time) => time !== null)
    .toSorted()[0];
  const escalated = known(runs) ? runs.filter((run) => needsHuman(snapshot, run)).length : 0;
  return (
    <>
      <h1 className="sr">Home · {project ?? "All projects"}</h1>
      <section className="tiles" aria-label="What needs you first">
        <Tile
          tile="needs-me"
          label="Needs me"
          value={needs ?? "?"}
          tone={needs ? "warn" : undefined}
          note={known(gates) && gates[0] ? gates[0].ticket : "nothing waits"}
        />
        <Tile
          tile="reviews"
          label="Reviews waiting"
          value={known(runs) ? queue.length : "?"}
          note={oldestReview ? `oldest ${duration(age(oldestReview))}` : "none waiting"}
        />
        <Tile
          tile="stuck"
          label="Stuck agents"
          value={stuck.length}
          tone={stuck.length > 0 ? "warn" : undefined}
          note={stuck[0] ? stuck[0].run.ticket.id : "none stuck"}
        />
        <Tile
          tile="usage"
          label={top ? `${top.provider} ${top.window} limit` : "Usage limit"}
          value={top?.used_fraction == null ? "?" : `${percent(top.used_fraction)}%`}
          tone={top && nearLimit(top) ? "alarm" : undefined}
          note={
            top ? (
              <>
                <Resets limit={top} /> · all projects
              </>
            ) : (
              "unknown · all projects"
            )
          }
        />
        <Tile
          tile="cost"
          label="Cost today"
          value={dollars.format(todayCost)}
          note={`vs ${dollars.format(days.get(dayOf(yesterday)) ?? 0)} yesterday`}
        />
        <Tile
          tile="runs"
          label="Open runs"
          value={known(runs) ? runs.length : "?"}
          note={`${escalated} need${escalated === 1 ? "s" : ""} you`}
        />
      </section>
      <div className="cols3">
        <div className="stack">
          <NeedsMe gates={gates} waiting={waiting} />
          <StuckAgents stuck={stuck} />
        </div>
        <ReviewQueue runs={runs} />
        <div className="stack">
          <Panel
            title="Run progress"
            count={known(runs) ? runs.length : <Unknown />}
            hint="steps, round, time in step"
          >
            {known(runs) ? (
              runs.length === 0 ? (
                <p className="mut">No open runs.</p>
              ) : (
                runs.map((run) => <Progress key={run.run} run={run} />)
              )
            ) : (
              <Unknown />
            )}
          </Panel>
          <Usage snapshot={snapshot} />
        </div>
      </div>
    </>
  );
}
