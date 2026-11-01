/** What the page asks the server to do. `name` is one of the fixed actions in actions.ts. */
export type Action = { name: string; label: string; params: Record<string, unknown> };

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
