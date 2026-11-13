import { useEffect, useState } from "react";
import type { ConversationReply, RunConversation } from "../conversation.ts";

type State =
  | { status: "loading" }
  | { status: "failed"; reason: string }
  | { status: "ok"; reply: ConversationReply & RunConversation };

/**
 * Reads `GET /api/run/<run>/conversation` (read only). `refreshKey` changes when the run logged a new
 * event; the last answer stays on screen while the next one loads, so a poll never resets the tab.
 */
export function useConversation(run: string, refreshKey: string): State {
  const [state, setState] = useState<{ run: string; value: State }>({
    run,
    value: { status: "loading" },
  });
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/run/${encodeURIComponent(run)}/conversation`, { signal: controller.signal })
      .then(async (response): Promise<State> => {
        if (!response.ok)
          return {
            status: "failed",
            reason:
              response.status === 503
                ? "the hub has not read the inbox yet; open any page of the hub, then retry"
                : `the hub answered ${response.status}`,
          };
        return { status: "ok", reply: await response.json() };
      })
      .catch((err): State => ({ status: "failed", reason: String(err) }))
      .then((value) => {
        if (!controller.signal.aborted) setState({ run, value });
      });
    return () => controller.abort();
  }, [run, refreshKey]);
  return state.run === run ? state.value : { status: "loading" };
}

/** The read's own states: each one is a notice, never a silent gap. */
function Notices({ reply }: { reply: ConversationReply }) {
  return (
    <>
      {reply.directory === "loading" ? (
        <p className="mut" role="status" data-testid="conversation-loading">
          The agent directory is still loading, so some agents show by their raw handle.
        </p>
      ) : null}
      {reply.truncated ? (
        <p className="warn-box" role="status" data-testid="conversation-truncated">
          The inbox read was cut: the oldest messages may be missing.
        </p>
      ) : null}
      {reply.stale ? (
        <p className="warn-box" role="status" data-testid="conversation-stale">
          The inbox could not be read just now: this shows the last read.
        </p>
      ) : null}
    </>
  );
}

export function Conversation({ run, refreshKey }: { run: string; refreshKey: string }) {
  const state = useConversation(run, refreshKey);
  if (state.status === "loading") return <p className="mut">Reading the conversation…</p>;
  if (state.status === "failed")
    return (
      <p className="bad-text" role="alert">
        The hub could not read the conversation: {state.reason}.
      </p>
    );
  const { reply } = state;
  return (
    <section data-testid="conversation" aria-label="Conversation">
      <Notices reply={reply} />
      <p className="mut" data-testid="conversation-summary">
        {reply.messages.length} messages between {reply.agents.length} agents.
      </p>
    </section>
  );
}
