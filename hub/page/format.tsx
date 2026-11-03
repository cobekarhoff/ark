import type { Snapshot } from "../types.ts";

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
