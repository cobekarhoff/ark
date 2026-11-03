import type { PlanStepView, RunView, Snapshot } from "../types.ts";

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

export function Cost({ usd, testId = "cost" }: { usd: number | null; testId?: string }) {
  return usd === null ? (
    <span className="pill unk" data-testid={testId}>
      unknown
    </span>
  ) : (
    <span className="mono" data-testid={testId}>
      {dollars.format(usd)}
    </span>
  );
}

/** `45 s`, `12 min`, `3 h 39 min`: non-breaking, so a cell never splits a duration. */
export function duration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return `${Math.floor(milliseconds / 1000)}\u00a0s`;
  if (minutes < 60) return `${minutes}\u00a0min`;
  return `${Math.floor(minutes / 60)}\u00a0h ${minutes % 60}\u00a0min`;
}

/** A running step with no event for this long is shown as idle: Orca does not say a worker is paused. */
export const idleMinutes = 30;

export type Attention = {
  kind: "waiting" | "idle";
  label: string;
  reason: string;
  step: string | null;
};

/**
 * What stops an open run from going on, or null. `waiting` comes from a question or blocked report
 * nobody has read; `idle` is a running step with no event for 30 minutes (a worker that paused for
 * the human leaves no other trace).
 */
export function attentionOf(run: RunView, age: (time: string) => number): Attention[] {
  const waits: Attention[] = run.waiting.map((wait) => ({
    kind: "waiting",
    label: "waiting",
    reason: wait.reason,
    step: wait.step,
  }));
  const running = run.plan?.filter((step) => step.status === "running") ?? [];
  const quiet = age(run.updated_at);
  if (waits.length === 0 && quiet >= idleMinutes * 60_000)
    for (const step of running)
      waits.push({
        kind: "idle",
        label: `idle ${Math.floor(quiet / 60_000)}\u00a0min`,
        reason: "the run logged no event; the worker may be paused for you",
        step: step.id,
      });
  return waits;
}

/** The status text of a step: a running step carries its duration, a waiting or idle one says so. */
export function stepStatus(
  step: PlanStepView,
  attention: Attention[],
  age: (time: string) => number,
  statusLabel: Record<PlanStepView["status"], string>,
): { label: string; tone: string } {
  const flagged = attention.find((item) => item.step === step.id);
  if (flagged)
    return {
      label: flagged.kind === "idle" ? `running · ${flagged.label}` : flagged.label,
      tone: "waiting",
    };
  const running = step.status === "running" && step.started_at;
  return {
    label: running ? `running ${duration(age(step.started_at!))}` : statusLabel[step.status],
    tone: step.status,
  };
}

/** Arrowhead of every edge of a graph; `id` is unique per svg. */
export function ArrowMarker({ id }: { id: string }) {
  return (
    <defs>
      <marker
        id={id}
        viewBox="0 0 8 8"
        refX="7.5"
        refY="4"
        markerWidth="8"
        markerHeight="8"
        markerUnits="userSpaceOnUse"
        orient="auto"
      >
        <path d="M0,0 L8,4 L0,8 z" className="arrow" />
      </marker>
    </defs>
  );
}

/** `merge_requests_open` reads as `merge requests open`. */
export const phaseLabel = (phase: string) => phase.replaceAll("_", " ");

export const Unknown = () => <span className="pill unk">unknown</span>;

/** Colour group of a run phase: the legend of the Map. */
export function phaseClass(phase: string | null): string {
  switch (phase) {
    case null:
      return "p-none";
    case "planning":
      return "p-plan";
    case "building":
      return "p-build";
    case "merge_requests_open":
      return "p-review";
    case "closed":
      return "p-done";
    default:
      return "p-gate"; // awaiting_criteria, awaiting_strategy, escalation: the run waits for the human
  }
}

export function Phase({ phase }: { phase: string }) {
  return (
    <span className={phaseClass(phase)} data-phase={phase}>
      <span className="dot" />
      {phase}
    </span>
  );
}

export type Loaded<T> = Exclude<T, "unknown">;
export const known = <T,>(value: T | "unknown"): value is T => value !== "unknown";
export type Tickets = Exclude<Snapshot["tickets"], "unknown">;
