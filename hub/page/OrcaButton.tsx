// test ids: open-in-orca (data-terminal), orca-ended, orca-status
import { useState } from "react";
import type { Agent } from "../types.ts";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; reason: string };

/** The reason a click did nothing, in words the human can act on. */
function reasonFor(status: number): string {
  if (status === 403)
    return `refused: open the hub at http://127.0.0.1:${location.port}, the only address it accepts for this`;
  if (status === 400) return "this terminal is no longer live in Orca";
  return "Orca did not answer";
}

/**
 * "Open in Orca" for a live agent, else the label that says why there is no button. The button
 * posts the terminal handle; the hub runs `orca terminal switch` and sends no text to the terminal.
 */
export function OpenInOrca({ agent }: { agent: Agent }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  if (agent.running)
    return (
      <span
        className="mut ended"
        data-testid="orca-running"
        title="Orca has no terminal to switch to for this agent."
      >
        running in Orca, open it from its chat tab
      </span>
    );
  if (!agent.live || agent.terminal === null)
    return (
      <span
        className="mut ended"
        data-testid="orca-ended"
        title="The Orca terminal is gone. The transcript is still readable."
      >
        ended, not in Orca
      </span>
    );
  const terminal = agent.terminal;
  const open = async () => {
    setState({ kind: "sending" });
    try {
      const response = await fetch("/api/open-in-orca", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ terminal }),
      });
      setState(
        response.ok ? { kind: "idle" } : { kind: "failed", reason: reasonFor(response.status) },
      );
    } catch {
      setState({ kind: "failed", reason: "the hub did not answer" });
    }
  };
  return (
    <>
      <button
        type="button"
        className="btn-orca"
        data-testid="open-in-orca"
        data-terminal={terminal}
        disabled={state.kind === "sending"}
        onClick={open}
      >
        Open in Orca
      </button>
      <span className="bad-text" role="status" data-testid="orca-status">
        {state.kind === "failed" ? state.reason : ""}
      </span>
    </>
  );
}
