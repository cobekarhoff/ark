/** What the page asks the server to do. `name` is one of the fixed actions in actions.ts. */
export type Action = {
  name: string;
  label: string;
  params: Record<string, unknown>;
};

export type ItemKind = "gate" | "mr" | "question" | "agent" | "ticket" | "retro";
export type Source = "ark" | "orca" | "plannotator";

/** One thing that waits for the human. */
export type Item = {
  id: string;
  kind: ItemKind;
  source: Source;
  project: string;
  ticket: string | null;
  title: string;
  since: string;
  action: Action | null;
};

/** `unknown` means the reader failed or timed out. It is never turned into live, dead or stuck. */
export type Agent = {
  run: string;
  project: string;
  role: string;
  title: string;
  model: string | null;
  liveness: string;
  activity: string;
  terminal: string | null;
  action: Action | null;
};

export const switchTerminal = (handle: string | null, label = "Open terminal"): Action | null =>
  handle ? { name: "orca-terminal-switch", label, params: { handle } } : null;

/** Item kinds as the human reads them, in the Needs-me list and in notification titles. */
export const kindLabels: Record<ItemKind, string> = {
  gate: "Gate",
  mr: "Merge request",
  question: "Question",
  agent: "Agent",
  ticket: "Approval",
  retro: "Retro",
};

/** The fixed lines the steering buttons type into Master Chief. The abort line names the run, so the page shows it before the human confirms. */
export const instructions = {
  "approve-and-queue":
    "Hub: approve and queue the proposed tickets in the order shown. The human asked for it.",
  "reorder-queue":
    "Hub: reorder the queue by priority, highest first, and tell the human the new order.",
  pause: "Hub: pause. Do not start new runs. Let running runs finish their current step.",
  resume: "Hub: resume. Start queued runs again.",
  "retry-stuck-agent":
    "Hub: retry the stuck agent. Nudge it, and if it does not respond, restart its step.",
} as const;
export const abortInstruction = (run: string) => `Hub: abort run ${run}. The human confirmed it.`;
