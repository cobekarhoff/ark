import { useEffect, useRef, useState } from "react";
import { GraphViewport } from "./GraphViewport.tsx";
import { ArrowMarker, Ring, stepStatus } from "./format.tsx";
import type { Attention } from "./format.tsx";
import { Flip, keyboardOrigin, reducedMotion, useChanges } from "./motion.tsx";
import {
  cardTone,
  collapsedFrom,
  phaseColumnWidth,
  phaseOf,
  repoLayout,
  type CardLayout,
  type EdgeLayout,
  type Tone,
} from "./repo-layout.ts";
import { runHref } from "./RunDetail.tsx";
import { useAge } from "./store.tsx";
import type { MergeRequestView, PlanStepView, RepoView, RunView } from "../types.ts";

const ciText: Record<MergeRequestView["ci"], string> = {
  passing: "CI passed",
  failing: "CI failed",
  pending: "CI running",
  unknown: "CI unknown",
};
const ciClass: Record<MergeRequestView["ci"], string> = {
  passing: "ok",
  failing: "bad",
  pending: "build",
  unknown: "unk",
};

/** The state of a repo that has no MR, in words: a branch with commits, a clean one, or none yet. */
const branchText = (view: RepoView): string =>
  view.state === "ahead"
    ? `${view.branch?.ahead} commit${view.branch?.ahead === 1 ? "" : "s"} ahead`
    : view.state === "clean"
      ? "no commits yet"
      : view.state === "pending"
        ? "no branch yet"
        : "unknown";

/** The order word: an MR run merges in order, a closed hand-off hands off in order; a run with no MR yet only has an order. */
function orderWord(run: RunView): string {
  if (run.merge_requests.length > 0) return "merge order";
  return run.phase === "closed" ? "hand-off order" : "repo order";
}

type EdgeKind = "finished" | "blocking" | "into-running";

function Card({
  layout,
  steps,
  mergeRequests,
  mergeRequest,
  count,
  order,
  targeted,
  related,
  hot,
  toggle,
}: {
  layout: CardLayout;
  steps: PlanStepView[];
  mergeRequests: MergeRequestView[];
  mergeRequest: MergeRequestView | undefined;
  count: number;
  order: string;
  targeted: boolean;
  related: boolean;
  hot: boolean;
  toggle: () => void;
}) {
  const { view, open } = layout;
  const tone = cardTone(view, mergeRequest, steps);
  const done = steps.filter((step) => step.status === "succeeded").length;
  const bumps = new Set(
    steps.length === 0 ? [] : view.depends_on.map((edge) => edge.bump).filter(Boolean),
  );
  return (
    <div
      className={`rcard s-${tone}${open ? " open" : ""}${targeted ? " targeted" : ""}${related ? " related" : ""}${hot ? " hl" : ""}`}
      data-testid="repo-card"
      data-repo={view.repo}
      data-order={view.order}
      data-state={view.state}
      data-tone={tone}
      style={{ left: layout.x, top: layout.y, width: layout.width, height: layout.height }}
    >
      <div className="rcard-top">
        <button
          type="button"
          className="rtoggle"
          data-testid="repo-toggle"
          aria-expanded={open}
          aria-label={`${view.repo}, ${open ? "collapse" : "expand"} steps`}
          onClick={toggle}
        >
          <span className="badge" title={`${view.order} of ${count} in ${order}`}>
            {view.order}
          </span>
          <span className="rname" title={view.repo}>
            {view.repo}
          </span>
          <svg className="chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
        <p className="why" data-testid="repo-why">
          {view.why}
        </p>
        {mergeRequest ? (
          <div className="rmr" data-testid="repo-mr">
            <div className="line">
              <span className="num mono">!{mergeRequest.number}</span>
              <span className={`pill ${mergeRequest.state === "merged" ? "ok" : ""}`}>
                {mergeRequest.state}
              </span>
              <span className={`pill ${ciClass[mergeRequest.ci]}`}>{ciText[mergeRequest.ci]}</span>
            </div>
            <div className="sub" data-testid="repo-waits">
              {mergeRequest.waits_for.length === 0 ? (
                <span className="mut">no upstream</span>
              ) : (
                <>
                  waits for
                  {mergeRequest.waits_for.map((number) => {
                    const met = mergeRequests.find((other) => other.number === number)?.state;
                    return (
                      <span key={number} className={met === "merged" ? "met" : "unmet"}>
                        {" "}
                        !{number}
                        {met === "merged" ? " ✓" : ""}
                      </span>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="rmr" data-testid="repo-handoff">
            <div className="line">
              <span className="mut">{view.branch ? "hand-off" : "no MR"}</span>
              <span
                className={`pill ${view.state === "ahead" ? "ok" : view.state === "unknown" ? "unk" : ""}`}
              >
                {branchText(view)}
              </span>
            </div>
            <div className="sub branch mono" data-testid="repo-branch" title="hand-off branch">
              {view.branch ? view.branch.name : "-"}
            </div>
          </div>
        )}
        <div className="rfoot">
          {steps.length > 0 ? (
            <>
              <Ring done={done} total={steps.length} />
              <span>
                {done}/{steps.length} steps
              </span>
              <span className="strip" aria-hidden="true">
                {steps.map((step) => (
                  <i
                    key={step.id}
                    className={`sdot s-${step.status}${bumps.has(step.id) ? " bump" : ""}`}
                    data-testid="step-dot"
                    data-step={step.id}
                    data-status={step.status}
                  />
                ))}
              </span>
            </>
          ) : (
            <span className="mut">no steps listed</span>
          )}
        </div>
      </div>
      {layout.columns.map((column) => (
        <span key={column.label}>
          <span
            className="phase-head"
            data-testid="phase-head"
            style={{ left: column.x - layout.x, top: column.headY - layout.y }}
          >
            {column.label}
          </span>
          <span
            className="phase-col"
            style={{
              left: column.x - layout.x,
              top: column.columnY - layout.y,
              width: phaseColumnWidth,
              height: column.height,
            }}
          />
        </span>
      ))}
    </div>
  );
}

function EdgeTip({ edge, at }: { edge: EdgeLayout; at: { x: number; y: number } }) {
  return (
    <div
      className="redge-tip"
      role="tooltip"
      data-testid="edge-tip"
      style={{ left: at.x, top: at.y + 26 }}
    >
      <div className="t">
        <span className="pill">{edge.kind}</span>
        <span>
          {edge.to} depends on {edge.from}
        </span>
      </div>
      <dl>
        <dt>pin</dt>
        <dd className="mono">{edge.pin}</dd>
        <dt>evidence</dt>
        <dd className="mono" data-testid="edge-evidence">
          {edge.evidence}
        </dd>
        <dt>bump</dt>
        <dd data-testid="edge-bump">
          {edge.bump ? (
            <>
              <span className="mono">{edge.bump}</span> {edge.bumpState}
            </>
          ) : (
            <span className="mut">no bump step for this edge</span>
          )}
        </dd>
      </dl>
    </div>
  );
}

/**
 * The repo graph of a run with two or more step repos (docs/design/repo-graph/hybrid-1.html): a card per repo in
 * the order of `RunView.repos`, labelled repo edges, and in an open card its steps in phase columns. Free text
 * (`why`, `pin`, `evidence`) is drawn as text only.
 */
export function RepoGraph({
  run,
  repos,
  plan,
  attention,
  target,
}: {
  run: RunView;
  repos: RepoView[];
  plan: PlanStepView[];
  attention: Attention[];
  /** The repo a link named (`#/run/<run>/repo/<repo>`): its card opens and takes the focus. */
  target: string | null;
}) {
  const age = useAge();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(repos.length >= collapsedFrom ? [] : repos.map((view) => view.repo)),
  );
  const [traced, setTraced] = useState<string | null>(null);
  const [hotEdge, setHotEdge] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const layout = repoLayout(repos, plan, expanded);
  const allOpen = repos.every((view) => expanded.has(view.repo));

  const mergeRequestOf = (repo: string) => run.merge_requests.find((other) => other.repo === repo);
  const stepsOf = (repo: string) => plan.filter((step) => step.repo === repo);
  const changes = useChanges(
    new Map([
      ...repos.map((view): [string, string] => {
        const mergeRequest = mergeRequestOf(view.repo);
        return [
          `repo:${view.repo}`,
          `${view.state}|${view.mr}|${mergeRequest?.ci}|${view.branch?.ahead}|${view.depends_on.map((edge) => edge.bump_state).join(",")}`,
        ];
      }),
      ...plan.map((step): [string, string] => [`step:${step.id}`, step.status]),
    ]),
  );

  // A link to a card opens it, even in a collapsed 4+ repo graph, and puts the focus on it.
  useEffect(() => {
    if (target === null || !repos.some((view) => view.repo === target)) return;
    setExpanded((before) => (before.has(target) ? before : new Set([...before, target])));
    const toggle = [...(root.current?.querySelectorAll<HTMLElement>("[data-repo]") ?? [])]
      .find((card) => card.dataset.repo === target)
      ?.querySelector<HTMLElement>(".rtoggle");
    toggle?.focus({ preventScroll: true });
    toggle?.scrollIntoView({
      block: "nearest",
      behavior: reducedMotion() || keyboardOrigin() ? "auto" : "smooth",
    });
    // Only a new target acts: a snapshot push must not take back a card the reader closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const bumpSteps = new Set(repos.flatMap((view) => view.depends_on.map((edge) => edge.bump)));
  bumpSteps.delete("");
  const toneOf = (repo: string): Tone =>
    cardTone(
      repos.find((view) => view.repo === repo)!,
      mergeRequestOf(repo),
      stepsOf(repo),
    );
  const edgeKind = (edge: EdgeLayout): EdgeKind =>
    toneOf(edge.from) !== "done"
      ? "blocking"
      : toneOf(edge.to) === "running"
        ? "into-running"
        : "finished";

  // A step with hover or focus: its needs and dependents stay, the rest dims.
  const joined = new Set<string>();
  const joinedRepos = new Set<string>();
  if (traced !== null) {
    joined.add(traced);
    for (const step of plan)
      if (step.id === traced) step.needs.forEach((need) => joined.add(need));
      else if (step.needs.includes(traced)) joined.add(step.id);
    for (const step of plan) if (joined.has(step.id)) joinedRepos.add(step.repo);
  }
  const touches = (edge: { from: string; to: string }) =>
    traced !== null && (edge.from === traced || edge.to === traced);
  const hotLayout = hotEdge === null ? null : layout.edges.find((edge) => edge.id === hotEdge);

  const arrow = "arrow-repo";
  return (
    <div ref={root} className="rgraph-wrap" data-testid="repo-graph" data-count={repos.length}>
      <div className="rgraph-bar">
        <span className="pill" data-testid="repo-order">
          {orderWord(run)} · {repos.length} repos
        </span>
        <button
          type="button"
          className="btn sm"
          data-testid="expand-all"
          aria-pressed={allOpen}
          onClick={() => setExpanded(new Set(allOpen ? [] : repos.map((view) => view.repo)))}
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>
      <GraphViewport
        width={layout.width}
        height={layout.height}
        label="Repo graph"
        scrollClass="rgraph"
      >
        <div
          className={`rcanvas${traced === null ? "" : " tracing"}`}
          style={{ width: layout.width, height: layout.height }}
        >
          <Flip className="rlayer">
            {layout.cards.map((card) => (
              <Card
                key={card.view.repo}
                layout={card}
                steps={stepsOf(card.view.repo)}
                mergeRequests={run.merge_requests}
                mergeRequest={mergeRequestOf(card.view.repo)}
                count={repos.length}
                order={orderWord(run)}
                targeted={target === card.view.repo}
                related={joinedRepos.has(card.view.repo)}
                hot={changes.has(`repo:${card.view.repo}`)}
                toggle={() =>
                  setExpanded((before) => {
                    const next = new Set(before);
                    if (!next.delete(card.view.repo)) next.add(card.view.repo);
                    return next;
                  })
                }
              />
            ))}
            {layout.cards.flatMap((card) =>
              card.chips.map((chip) => {
                const state = stepStatus(chip.step, attention, age);
                const bumpEdge = card.view.depends_on.find((edge) => edge.bump === chip.step.id);
                const bump = phaseOf(chip.step, bumpSteps) === "bump";
                return (
                  <a
                    key={chip.step.id}
                    href={runHref(run.run, "step", chip.step.id)}
                    className={`rstep s-${state.tone}${bump ? " bump" : ""}${joined.has(chip.step.id) ? (chip.step.id === traced ? " self" : " rel") : ""}${changes.has(`step:${chip.step.id}`) ? " hl" : ""}`}
                    data-testid="step-chip"
                    data-step={chip.step.id}
                    data-repo={card.view.repo}
                    data-phase={phaseOf(chip.step, bumpSteps)}
                    data-status={chip.step.status}
                    aria-label={`${chip.step.id}, ${chip.step.role}, ${bumpEdge?.bump_state ? `bump ${bumpEdge.bump_state}` : state.label}, open transcript`}
                    style={{ left: chip.x, top: chip.y, width: chip.width, height: chip.height }}
                    onMouseEnter={() => setTraced(chip.step.id)}
                    onMouseLeave={() => setTraced(null)}
                    onFocus={() => setTraced(chip.step.id)}
                    onBlur={() => setTraced(null)}
                  >
                    <span className="sid">{chip.step.id}</span>
                    <span className="sstat">
                      {bump && bumpEdge?.bump_state ? `bump · ${bumpEdge.bump_state}` : state.label}
                    </span>
                    <span className="smeta">{chip.step.model.split("/").pop()}</span>
                  </a>
                );
              }),
            )}
          </Flip>
          <svg
            className="redges"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
            data-testid="repo-edges"
          >
            <ArrowMarker id={arrow} />
            {layout.intraEdges.map((edge) => (
              <path
                key={`${edge.from}>${edge.to}`}
                className={`edge sedge${touches(edge) ? " hot" : ""}`}
                data-testid="intra-edge"
                data-from={edge.from}
                data-to={edge.to}
                d={edge.d}
                markerEnd={`url(#${arrow})`}
              />
            ))}
            {layout.edges.map((edge) => {
              const kind = edgeKind(edge);
              return (
                <g key={edge.id}>
                  <path
                    className={`edge redge ${kind}${hotEdge === edge.id ? " hot" : ""}`}
                    data-testid="repo-edge"
                    data-from={edge.from}
                    data-to={edge.to}
                    data-kind={edge.kind}
                    data-flow={kind}
                    d={edge.d}
                    markerEnd={`url(#${arrow})`}
                  />
                  <path
                    className="hit"
                    d={edge.d}
                    onMouseEnter={() => setHotEdge(edge.id)}
                    onMouseLeave={() => setHotEdge(null)}
                  />
                </g>
              );
            })}
            {layout.crossEdges.filter(touches).map((edge) => (
              <path
                key={`${edge.from}>${edge.to}`}
                className="edge sedge cross"
                data-testid="cross-edge"
                data-from={edge.from}
                data-to={edge.to}
                d={edge.d}
                markerEnd={`url(#${arrow})`}
              />
            ))}
          </svg>
          {layout.edges.map((edge) => (
            <button
              key={edge.id}
              type="button"
              className={`edge-pill ${edgeKind(edge)}${hotEdge === edge.id ? " hot" : ""}`}
              data-testid="edge-pill"
              data-from={edge.from}
              data-to={edge.to}
              style={{ left: edge.pill.x, top: edge.pill.y }}
              aria-label={`${edge.to} depends on ${edge.from} by ${edge.kind}, ${edge.pin}${edge.bump ? `, bump ${edge.bumpState}` : ""}. Evidence ${edge.evidence}`}
              onMouseEnter={() => setHotEdge(edge.id)}
              onMouseLeave={() => setHotEdge(null)}
              onFocus={() => setHotEdge(edge.id)}
              onBlur={() => setHotEdge(null)}
            >
              <span className="kind">{edge.kind}</span>
              <span className="pin">{edge.pin}</span>
            </button>
          ))}
          {hotLayout ? <EdgeTip edge={hotLayout} at={hotLayout.pill} /> : null}
        </div>
      </GraphViewport>
    </div>
  );
}
