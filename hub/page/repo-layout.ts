/**
 * Layout of the repo graph (docs/design/repo-graph/hybrid-1.html): one card per repo in columns by dependency
 * depth, labelled repo edges between the cards, and, in an expanded card, its steps in phase columns. Pure: the
 * order of `repos` is the order `repoGraph` gave in the snapshot, and this never re-derives it.
 */
import type { MergeRequestView, PlanStepView, RepoState, RepoView, StepStatus } from "../types.ts";

export const phases = [
  { key: "implement", label: "Implement" },
  { key: "bump", label: "Bump" },
  { key: "validate", label: "Validate" },
  { key: "review", label: "Review" },
] as const;
export type PhaseKey = (typeof phases)[number]["key"];

/** The one rule from a step to its phase column. A bump step is one that a repo edge names in `bump`; its role is implementer. */
export const phaseOf = (step: PlanStepView, bumpSteps: ReadonlySet<string>): PhaseKey =>
  bumpSteps.has(step.id)
    ? "bump"
    : step.role === "validator"
      ? "validate"
      : step.role === "reviewer"
        ? "review"
        : "implement";

/** A repo graph is drawn from this many repos (the card state of `RunView.repos` is null below two step repos). */
export const collapsedFrom = 4;

export type Tone = "done" | "running" | "failed" | "ready" | "pending";

/** The tone of a repo that has only its state (the ticket chain): the card refines it with its steps and CI. */
export const toneOfState = (state: RepoState): Tone =>
  state === "merged"
    ? "done"
    : state === "open" || state === "ahead"
      ? "ready"
      : state === "closed"
        ? "failed"
        : "pending";

export function cardTone(
  view: RepoView,
  mergeRequest: MergeRequestView | undefined,
  steps: PlanStepView[],
): Tone {
  if (view.state === "merged") return "done";
  if (mergeRequest?.ci === "failing") return "failed";
  if (mergeRequest?.ci === "pending" || steps.some((step) => step.status === "running"))
    return "running";
  return toneOfState(view.state);
}

const size = {
  card: 236,
  top: 164,
  columnGap: 128,
  lane: 64,
  itemGap: 20,
  margin: 8,
  pad: 10,
  phaseWidth: 148,
  phaseGap: 8,
  chipHeight: 62,
  chipGap: 6,
  headHeight: 18,
};

export type Chip = {
  step: PlanStepView;
  phase: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type PhaseColumn = {
  label: string;
  x: number;
  headY: number;
  columnY: number;
  height: number;
};
export type CardLayout = {
  view: RepoView;
  open: boolean;
  /** Dependency depth: the card's column. */
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: PhaseColumn[];
  chips: Chip[];
};
export type EdgeLayout = {
  id: string;
  from: string;
  to: string;
  kind: string;
  pin: string;
  evidence: string;
  bump: string;
  bumpState: string | null;
  d: string;
  pill: { x: number; y: number };
};
export type StepEdge = { from: string; to: string; d: string; backward: boolean };
export type RepoLayout = {
  width: number;
  height: number;
  cards: CardLayout[];
  edges: EdgeLayout[];
  /** Step needs inside one open card: always drawn. */
  intraEdges: StepEdge[];
  /** Step needs between repos: drawn only while one of their steps has hover or focus. */
  crossEdges: StepEdge[];
};

const curve = (x1: number, y1: number, x2: number, y2: number, minimumBend = 28) =>
  `C${x1 + Math.max(minimumBend, (x2 - x1) / 2)} ${y1} ${x2 - Math.max(minimumBend, (x2 - x1) / 2)} ${y2} ${x2} ${y2}`;
const backCurve = (x1: number, y1: number, x2: number, y2: number) => {
  const bend = Math.max(36, (x1 - x2) / 2);
  return `C${x1 - bend} ${y1} ${x2 + bend} ${y2} ${x2} ${y2}`;
};

const statusRank: Record<StepStatus, number> = {
  running: 0,
  failed: 1,
  interrupted: 1,
  pending: 2,
  stopped: 3,
  succeeded: 3,
};

/** Topological layers first; inside a layer the active steps float up. */
function orderedSteps(steps: PlanStepView[]): PlanStepView[] {
  const layer = new Map<string, number>();
  const level = (step: PlanStepView, seen: Set<string>): number => {
    const known = layer.get(step.id);
    if (known !== undefined) return known;
    if (seen.has(step.id)) return 0; // a cycle: break it instead of looping
    seen.add(step.id);
    let result = 0;
    for (const need of step.needs) {
      const dependency = steps.find((other) => other.id === need);
      if (dependency) result = Math.max(result, level(dependency, seen) + 1);
    }
    layer.set(step.id, result);
    return result;
  };
  for (const step of steps) level(step, new Set());
  return steps
    .map((step, index) => ({ step, index }))
    .sort(
      (a, b) =>
        layer.get(a.step.id)! - layer.get(b.step.id)! ||
        statusRank[a.step.status] - statusRank[b.step.status] ||
        a.index - b.index,
    )
    .map(({ step }) => step);
}

export function repoLayout(
  repos: RepoView[],
  plan: PlanStepView[],
  expanded: ReadonlySet<string>,
): RepoLayout {
  const bumpSteps = new Set(repos.flatMap((repo) => repo.depends_on.map((edge) => edge.bump)));
  bumpSteps.delete("");
  const stepById = new Map(plan.map((step) => [step.id, step]));
  const edges = repos.flatMap((repo) =>
    repo.depends_on.map((edge) => ({
      ...edge,
      id: `${edge.repo}>${repo.repo}`,
      from: edge.repo,
      to: repo.repo,
      lanes: [] as { column: number; y: number }[],
      stepEdges: 0,
      sx: 0,
      sy: 0,
      tx: 0,
      ty: 0,
    })),
  );
  const depth = new Map<string, number>();
  const level = (repo: string, seen: Set<string>): number => {
    const known = depth.get(repo);
    if (known !== undefined) return known;
    if (seen.has(repo)) return 0; // the snapshot has no graph for a cycle; this only guards a hand-built value
    seen.add(repo);
    const result = Math.max(
      0,
      ...edges.filter((edge) => edge.to === repo).map((edge) => level(edge.from, seen) + 1),
    );
    depth.set(repo, result);
    return result;
  };
  for (const { repo } of repos) level(repo, new Set());

  const columns = Array.from({ length: Math.max(0, ...depth.values()) + 1 }, () => ({
    cards: [] as CardLayout[],
    lanes: [] as { column: number; y: number }[],
    width: 0,
    x: 0,
  }));
  const cardOf = new Map<string, CardLayout>();
  const stackOf = new Map<string, number>();
  const presentOf = new Map<string, { label: string; steps: PlanStepView[] }[]>();
  for (const view of repos) {
    const open = expanded.has(view.repo);
    const steps = open ? orderedSteps(plan.filter((step) => step.repo === view.repo)) : [];
    const present = phases
      .map((phase) => ({
        ...phase,
        steps: steps.filter((step) => phaseOf(step, bumpSteps) === phase.key),
      }))
      .filter((phase) => phase.steps.length > 0);
    const stack = Math.max(0, ...present.map((phase) => phase.steps.length));
    const columnHeight = stack * size.chipHeight + (stack - 1) * size.chipGap + 8;
    const span = present.length * size.phaseWidth + (present.length - 1) * size.phaseGap;
    const card: CardLayout = {
      view,
      open,
      column: depth.get(view.repo)!,
      x: 0,
      y: 0,
      width: present.length > 0 ? Math.max(size.card, size.pad * 2 + span) : size.card,
      height: size.top + (present.length > 0 ? 8 + size.headHeight + columnHeight + 12 : 0),
      columns: [],
      chips: [],
    };
    stackOf.set(view.repo, columnHeight);
    cardOf.set(view.repo, card);
    columns[card.column]!.cards.push(card);
    presentOf.set(view.repo, present); // chips are placed once the card has its x and y
  }
  for (const edge of edges)
    for (let column = depth.get(edge.from)! + 1; column < depth.get(edge.to)!; column++) {
      const lane = { column, y: 0 };
      edge.lanes.push(lane);
      columns[column]!.lanes.push(lane);
    }
  let x = size.margin;
  for (const column of columns) {
    column.width = Math.max(0, ...column.cards.map((card) => card.width));
    column.x = x;
    x += column.width + size.columnGap;
  }
  const width = x - size.columnGap + size.margin;
  let bottom = 0;
  for (const column of columns) {
    let y = size.margin;
    for (const card of column.cards) {
      card.x = column.x;
      card.y = y;
      y += card.height + size.itemGap;
    }
    for (const lane of column.lanes) {
      lane.y = y;
      y += size.lane + size.itemGap;
    }
    bottom = Math.max(bottom, y - size.itemGap);
  }

  const chipOf = new Map<string, Chip>();
  for (const card of cardOf.values()) {
    const present = presentOf.get(card.view.repo)!;
    if (present.length === 0) continue;
    const span = present.length * size.phaseWidth + (present.length - 1) * size.phaseGap;
    const left = card.x + (card.width - span) / 2;
    const headY = card.y + size.top + 8;
    const columnY = headY + size.headHeight;
    present.forEach((phase, index) => {
      const columnX = left + index * (size.phaseWidth + size.phaseGap);
      card.columns.push({
        label: phase.label,
        x: columnX,
        headY,
        columnY,
        height: stackOf.get(card.view.repo)!,
      });
      phase.steps.forEach((step, row) => {
        const chip = {
          step,
          phase: index,
          x: columnX + 4,
          y: columnY + 4 + row * (size.chipHeight + size.chipGap),
          width: size.phaseWidth - 8,
          height: size.chipHeight,
        };
        card.chips.push(chip);
        chipOf.set(step.id, chip);
      });
    });
  }

  // Ports on the card header: the nearest neighbours take the top ports.
  for (const card of cardOf.values()) {
    edges
      .filter((edge) => edge.from === card.view.repo)
      .sort((a, b) => depth.get(a.to)! - depth.get(b.to)!)
      .forEach((edge, index) => {
        edge.sx = card.x + card.width;
        edge.sy = card.y + 24 + index * 12;
      });
    edges
      .filter((edge) => edge.to === card.view.repo)
      .sort((a, b) => depth.get(b.from)! - depth.get(a.from)!)
      .forEach((edge, index) => {
        edge.tx = card.x - 1;
        edge.ty = card.y + 24 + index * 12;
      });
  }
  const laneRoute = (
    sx: number,
    sy: number,
    lanes: { column: number; y: number }[],
    tx: number,
    ty: number,
    offsetY: number,
  ) => {
    let d = `M${sx} ${sy}`;
    let px = sx;
    let py = sy;
    for (const lane of lanes) {
      const column = columns[lane.column]!;
      const cy = lane.y + size.lane / 2 + offsetY;
      d += `${curve(px, py, column.x, cy)}L${column.x + column.width} ${cy}`;
      px = column.x + column.width;
      py = cy;
    }
    return d + curve(px, py, tx, ty);
  };
  const laidEdges: EdgeLayout[] = edges.map((edge) => {
    const lane = edge.lanes[0];
    const column = lane ? columns[lane.column]! : null;
    return {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      pin: edge.pin,
      evidence: edge.evidence,
      bump: edge.bump,
      bumpState: edge.bump_state,
      d: laneRoute(edge.sx, edge.sy, edge.lanes, edge.tx, edge.ty, 0),
      pill:
        lane && column
          ? { x: column.x + column.width / 2, y: lane.y + size.lane / 2 }
          : { x: (edge.sx + edge.tx) / 2, y: (edge.sy + edge.ty) / 2 },
    };
  });

  // Step needs: inside a card along the phase order; across repos, drawn on hover or focus of a step only.
  const anchor = (stepId: string, side: "in" | "out") => {
    const chip = chipOf.get(stepId);
    if (chip)
      return { x: side === "in" ? chip.x - 1 : chip.x + chip.width, y: chip.y + chip.height / 2 };
    const card = cardOf.get(stepById.get(stepId)!.repo)!;
    return { x: side === "in" ? card.x - 1 : card.x + card.width, y: card.y + size.top - 24 };
  };
  const intraEdges: StepEdge[] = [];
  const crossEdges: StepEdge[] = [];
  for (const step of plan) {
    const toCard = cardOf.get(step.repo);
    for (const needId of step.needs) {
      const need = stepById.get(needId);
      const fromCard = need && cardOf.get(need.repo);
      if (!need || !fromCard || !toCard) continue;
      if (fromCard === toCard) {
        if (!fromCard.open) continue;
        const a = chipOf.get(needId)!;
        const b = chipOf.get(step.id)!;
        let d: string;
        if (b.phase - a.phase > 1) {
          // Skips a phase column: runs under the columns so it never reads as coming from the column it passes.
          const ax = a.x + a.width;
          const ay = a.y + a.height / 2;
          const bx = b.x - 1;
          const by = b.y + b.height / 2;
          const ry = fromCard.columns[0]!.columnY + stackOf.get(fromCard.view.repo)! + 7;
          d = `M${ax} ${ay}C${ax + 22} ${ay} ${ax + 22} ${ry} ${ax + 46} ${ry}L${bx - 46} ${ry}C${bx - 22} ${ry} ${bx - 22} ${by} ${bx} ${by}`;
        } else if (a.phase < b.phase)
          d = `M${a.x + a.width} ${a.y + a.height / 2}${curve(a.x + a.width, a.y + a.height / 2, b.x - 1, b.y + b.height / 2, 6)}`;
        else if (a.phase > b.phase)
          d = `M${a.x} ${a.y + a.height / 2}${backCurve(a.x, a.y + a.height / 2, b.x + b.width + 1, b.y + b.height / 2)}`;
        else if (a.y < b.y)
          d = `M${a.x + a.width / 2} ${a.y + a.height}L${b.x + b.width / 2} ${b.y - 1}`;
        else d = `M${a.x + a.width / 2} ${a.y}L${b.x + b.width / 2} ${b.y + b.height + 1}`;
        intraEdges.push({ from: needId, to: step.id, d, backward: false });
        continue;
      }
      if (!fromCard.open && !toCard.open) continue;
      if (toCard.column > fromCard.column) {
        const start = anchor(needId, "out");
        const end = anchor(step.id, "in");
        const repoEdge = edges.find((edge) => edge.from === need.repo && edge.to === step.repo);
        const lanes = repoEdge ? repoEdge.lanes : [];
        crossEdges.push({
          from: needId,
          to: step.id,
          d: laneRoute(
            start.x,
            start.y,
            lanes,
            end.x,
            end.y,
            lanes.length > 0 ? 22 + 5 * repoEdge!.stepEdges++ : 0,
          ),
          backward: false,
        });
      } else {
        // Backward (a review that waits on a later repo): a direct curve, only ever visible while hovered.
        const start = anchor(needId, "in");
        const end = anchor(step.id, "out");
        const ry = bottom + 10;
        crossEdges.push({
          from: needId,
          to: step.id,
          d: `M${start.x} ${start.y}C${start.x - 30} ${start.y} ${start.x - 30} ${ry} ${start.x - 60} ${ry}L${end.x + 60} ${ry}C${end.x + 30} ${ry} ${end.x + 30} ${end.y} ${end.x} ${end.y}`,
          backward: true,
        });
      }
    }
  }
  return {
    width,
    height: bottom + size.margin + (crossEdges.some((edge) => edge.backward) ? 20 : 0),
    // The snapshot's order, not the depth order: a card keeps its place in the list across a re-layout.
    cards: repos.map((view) => cardOf.get(view.repo)!),
    edges: laidEdges,
    intraEdges,
    crossEdges,
  };
}

export const cardTop = size.top;
export const phaseColumnWidth = size.phaseWidth;
