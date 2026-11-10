import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { stepTimeText } from "../progress.ts";
import { currentProject, withProject } from "./store.tsx";
import type { PlanStepView, RunProgress, RunView, Snapshot } from "../types.ts";
import type { Phase as RunPhase } from "../../cli/lifecycle.ts";

export const dollars = new Intl.NumberFormat("en-US", {
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
const idleMinutes = 30;

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

const stepLabel: Record<PlanStepView["status"], string> = {
  pending: "pending",
  running: "running",
  succeeded: "done",
  failed: "failed",
  interrupted: "interrupted",
  stopped: "stopped",
};

/** The status text of a step: a running step carries its duration, a waiting or idle one says so. */
export function stepStatus(
  step: PlanStepView,
  attention: Attention[],
  age: (time: string) => number,
): { label: string; tone: string } {
  const flagged = attention.find((item) => item.step === step.id);
  if (flagged)
    return {
      label: flagged.kind === "idle" ? `running · ${flagged.label}` : flagged.label,
      tone: "waiting",
    };
  const running = step.status === "running" && step.started_at;
  return {
    label: running ? `running ${duration(age(step.started_at!))}` : stepLabel[step.status],
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

export const phaseLabel = (phase: string) => phase.replaceAll("_", " ");

export const Unknown = () => <span className="pill unk">unknown</span>;

/** A filter that names no project: an empty state with the way out, never another project's data. */
export const UnknownProject = ({ project }: { project: string }) => (
  <p className="mut" data-testid="unknown-project">
    No project named <b className="mono">{project}</b>.{" "}
    <a href={withProject(location.hash, null)}>All projects</a>
  </p>
);

/** The project of a run or ticket page, as a labelled value. */
export const ProjectValue = ({ project }: { project: string }) => (
  <span data-testid="page-project">
    <b>Project</b> <span className="mono">{project}</span>
  </span>
);

/**
 * Said when a page opened by a direct link belongs to another project than the filter of the URL.
 * The control keeps the URL's filter; the link is the only way to change it from here.
 */
export function OutsideNote({ project }: { project: string }) {
  const filter = currentProject();
  if (filter === null || filter === project) return null;
  return (
    <p className="outside" role="note" data-testid="outside-filter">
      <span>
        Outside the filter <b className="mono">{filter}</b>: this page is in{" "}
        <b className="mono">{project}</b>.
      </span>
      <a href={withProject(location.hash, project)}>Show {project}</a>
    </p>
  );
}

/** Colour group of a run phase: the legend of the Map. */
export function phaseClass(phase: RunPhase | null): string {
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
    case "awaiting_criteria":
    case "awaiting_strategy":
    case "escalation":
      return "p-gate"; // the run waits for the human
  }
}

export function Phase({ phase }: { phase: RunPhase }) {
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

/** Only an http or https URL becomes a link: a `javascript:` URL from run text stays text. */
export function ExternalLink({
  url,
  children,
  ...rest
}: { url: string; children: ReactNode } & Omit<ComponentProps<"a">, "href">) {
  let safe = false;
  try {
    safe = ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    // not a URL: shown as text
  }
  return safe ? (
    <a href={url} target="_blank" rel="noreferrer" {...rest}>
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

/** The rule of `hub/progress.ts`, fed with the figures of the snapshot: no ETA. */
export const currentStepText = (current: NonNullable<RunProgress["current"]>, elapsedMs: number) =>
  stepTimeText(
    current.role,
    elapsedMs / 1000,
    current.typical_seconds === null || current.slow_above_seconds === null
      ? undefined
      : { median: current.typical_seconds, p90: current.slow_above_seconds, count: 0 },
  );

/** True when the step runs longer than the p90 of its role. */
export const isSlow = (current: NonNullable<RunProgress["current"]>, elapsedMs: number) =>
  current.slow_above_seconds !== null && elapsedMs / 1000 > current.slow_above_seconds;

/** A ring of steps done: the conic fill is the fraction, the label sits inside. */
export function Ring({ done, total, label }: { done: number; total: number; label?: string }) {
  return (
    <span
      className="ring"
      role="img"
      aria-label={`${done} of ${total} steps done`}
      data-testid="ring"
      data-steps-done={done}
      data-steps-total={total}
      style={{ "--p": total === 0 ? 0 : done / total } as CSSProperties}
    >
      <span>{label ?? `${done}/${total}`}</span>
    </span>
  );
}
