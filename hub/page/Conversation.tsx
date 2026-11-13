import { useEffect, useMemo, useState } from "react";
import type { ConversationReply, RoleGroup, RunConversation } from "../conversation.ts";
import type { PlanStepView, SessionFile } from "../types.ts";
import { atPlayhead, clampView, runRange, sentAt, type Range } from "./conversation-model.ts";
import { Feed } from "./ConversationFeed.tsx";
import { Inspector } from "./ConversationInspector.tsx";
import { Player, useReplay } from "./ConversationReplay.tsx";
import { Trace } from "./ConversationTrace.tsx";

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
  const [retry, setRetry] = useState(0);
  const loadingDirectory =
    state.run === run && state.value.status === "ok" && state.value.reply.directory === "loading";
  // The directory loads in the background and logs no event: read again until it is ready.
  useEffect(() => {
    if (!loadingDirectory) return;
    const timer = setTimeout(() => setRetry((count) => count + 1), 3000);
    return () => clearTimeout(timer);
  }, [loadingDirectory, retry, run]);
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
  }, [run, refreshKey, retry]);
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

/** The trace and the feed, linked: a selected message marks its tick and arrow, and the trace cursor follows the feed. */
function Linked({
  conversation,
  sessions,
  plan,
}: {
  conversation: RunConversation;
  sessions: SessionFile[] | null;
  plan: PlanStepView[] | null;
}) {
  const full = useMemo(() => runRange(conversation), [conversation]);
  const [zoomed, setZoomed] = useState<Range | null>(null);
  const view = zoomed ? clampView(zoomed, full) : full;
  const [selected, setSelected] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ id: string; nonce: number } | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<RoleGroup>>(new Set());
  const replay = useReplay(
    full,
    useMemo(
      () =>
        conversation.messages.flatMap((message) =>
          Number.isFinite(sentAt(message)) ? [{ id: message.id, time: sentAt(message) }] : [],
        ),
      [conversation],
    ),
  );
  const shown = useMemo(
    () => (replay.playhead === null ? conversation : atPlayhead(conversation, replay.playhead)),
    [conversation, replay.playhead],
  );
  // The feed follows the newest message of a playing replay.
  const { pulse } = replay;
  useEffect(() => {
    if (pulse) setReveal(pulse);
  }, [pulse]);

  const fromTrace = (id: string) => {
    setSelected(id);
    setAgent(null);
    setReveal((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }));
  };
  // A click in the feed moves the trace only when the message is out of view.
  const fromFeed = (id: string) => {
    setSelected(id);
    setAgent(null);
    const message = conversation.messages.find((candidate) => candidate.id === id);
    const time = message ? sentAt(message) : NaN;
    if (Number.isFinite(time) && (time < view.start || time > view.end)) {
      const width = view.end - view.start;
      setZoomed({ start: time - width / 2, end: time + width / 2 });
    }
  };
  return (
    <>
      <Player full={full} replay={replay} />
      <Trace
        conversation={conversation}
        full={full}
        view={view}
        onView={setZoomed}
        selected={selected}
        onPick={fromTrace}
        cursor={cursor}
        expanded={expanded}
        onToggle={(group) =>
          setExpanded((previous) => {
            const next = new Set(previous);
            if (!next.delete(group)) next.add(group);
            return next;
          })
        }
        playhead={replay.playhead}
        pulse={replay.pulse}
      />
      <div className="cv-main">
        <Feed
          conversation={shown}
          selected={selected}
          reveal={reveal}
          onSelect={fromFeed}
          onAgent={setAgent}
          onTop={setCursor}
        />
        <Inspector
          conversation={conversation}
          selected={selected}
          agent={agent}
          sessions={sessions}
          plan={plan}
          onSelect={fromFeed}
          onAgent={setAgent}
        />
      </div>
    </>
  );
}

export function Conversation({
  run,
  refreshKey,
  sessions,
  plan,
}: {
  run: string;
  refreshKey: string;
  /** The run's session files, null while the run detail loads. */
  sessions: SessionFile[] | null;
  plan: PlanStepView[] | null;
}) {
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
      <Linked conversation={reply} sessions={sessions} plan={plan} />
    </section>
  );
}
