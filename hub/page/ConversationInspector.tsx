import { useEffect, useState } from "react";
import type { ConversationAgent, ConversationMessage, RunConversation } from "../conversation.ts";
import type { PlanStepView, SessionFile } from "../types.ts";
import { clockText, sentAt, typeOf } from "./conversation-model.ts";
import { nameOf, roleClass } from "./ConversationFeed.tsx";
import { Markdown } from "./Markdown.tsx";
import { transcriptHref } from "./RunDetail.tsx";

/** A transcript link, or why the button is disabled. */
export type TranscriptTarget = { href: string } | { reason: string };

/**
 * The transcript link of an agent at a time, or why there is none. Master Chief and an agent with no
 * mapped session have no transcript of this run: the button is disabled and says why.
 */
export function transcriptTarget(
  agent: ConversationAgent | undefined,
  sessions: SessionFile[] | null,
  run: string,
  at: string | null,
): TranscriptTarget {
  if (!agent) return { reason: "This agent is unknown." };
  if (agent.kind === "chief") return { reason: "Master Chief has no transcript in this run." };
  if (at === null) return { reason: "The message has no sent time." };
  if (sessions === null) return { reason: "The session files are still loading." };
  if (agent.kind === "run_lead")
    return sessions.some((session) => session.owner.kind === "lead")
      ? { href: transcriptHref(run, "lead", null, at) }
      : { reason: "The run lead has no session file in this run." };
  if (agent.kind === "worker" && agent.step !== null) {
    const step = agent.step;
    return sessions.some((session) => session.owner.kind === "step" && session.owner.step === step)
      ? { href: transcriptHref(run, "step", step, at) }
      : { reason: `No session file maps to step ${step}.` };
  }
  return { reason: "This agent has no session in this run." };
}

function TranscriptButton({
  label,
  target,
  testId,
}: {
  label: string;
  target: TranscriptTarget;
  testId: string;
}) {
  return "href" in target ? (
    <a className="btn small" href={target.href} data-testid={testId}>
      {label}
    </a>
  ) : (
    <button type="button" className="btn small" disabled title={target.reason} data-testid={testId}>
      {label}
    </button>
  );
}

const minutes = (seconds: number) => `${(seconds / 60).toFixed(1)} min`;
const time = (iso: string | null) =>
  iso === null ? "not recorded" : clockText(Date.parse(iso), true);

/** One body, read from the hub when the run answer did not carry it. Null: none, or still loading. */
function useBody(message: ConversationMessage): string | null {
  const [fetched, setFetched] = useState<{ id: string; body: string | null } | null>(null);
  useEffect(() => {
    if (message.body !== undefined) return;
    const controller = new AbortController();
    void fetch(`/api/conversation/message/${encodeURIComponent(message.id)}`, {
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as { body: string | null }) : null,
      )
      .then((found) => setFetched({ id: message.id, body: found?.body ?? null }))
      .catch(() => {});
    return () => controller.abort();
  }, [message.id, message.body]);
  return message.body !== undefined
    ? message.body
    : fetched?.id === message.id
      ? fetched.body
      : null;
}

function MessageView({
  conversation,
  message,
  sessions,
  onSelect,
  onAgent,
}: {
  conversation: RunConversation;
  message: ConversationMessage;
  sessions: SessionFile[] | null;
  onSelect: (id: string) => void;
  onAgent: (id: string) => void;
}) {
  const agents = new Map(conversation.agents.map((agent) => [agent.id, agent]));
  const from = agents.get(message.from);
  const to = agents.get(message.to);
  const question = conversation.questions.find((candidate) => candidate.id === message.id);
  const answer = question?.answered
    ? conversation.answers.find((candidate) => candidate.time === question.answered)
    : undefined;
  // The wait after the answer's question was picked up: from delivery, or from sending when Orca did not record delivery.
  const waited = question?.answered
    ? (Date.parse(question.answered) - Date.parse(question.delivered ?? question.sent ?? "")) / 1000
    : NaN;
  const thread =
    message.thread_id === null
      ? []
      : conversation.messages.filter((candidate) => candidate.thread_id === message.thread_id);
  const body = useBody(message);
  return (
    <>
      <h3 className="cv-subject">{message.subject ?? "(no subject)"}</h3>
      <dl className="cv-facts">
        <dt>Type</dt>
        <dd data-testid="inspector-type">{typeOf(message)}</dd>
        <dt>From</dt>
        <dd>
          <button type="button" className="cv-name" onClick={() => from && onAgent(from.id)}>
            {nameOf(from).name}
          </button>
        </dd>
        <dt>To</dt>
        <dd>
          <button type="button" className="cv-name" onClick={() => to && onAgent(to.id)}>
            {nameOf(to).name}
          </button>
        </dd>
        <dt>Sent</dt>
        <dd data-testid="inspector-sent">{time(message.created_at)}</dd>
        <dt>Delivered</dt>
        <dd data-testid="inspector-delivered">
          {time(question ? question.delivered : message.delivered_at)}
        </dd>
        {question ? (
          <>
            <dt>Wait</dt>
            <dd data-testid="inspector-wait">
              {question.pickup_seconds === "not recorded"
                ? "not recorded"
                : minutes(question.pickup_seconds)}
            </dd>
          </>
        ) : null}
      </dl>
      {question ? (
        question.answered ? (
          <p className="cv-answer" data-testid="inspector-answer">
            You answered {answer?.gate ?? "the gate"}: {answer?.answer ?? "(no text)"}
            <span className="mut">
              {" "}
              at {time(question.answered)}
              {Number.isFinite(waited) ? `, ${minutes(waited)} after it was picked up` : ""}
            </span>
          </p>
        ) : agents.get(message.to)?.kind === "chief" ? (
          <p className="cv-answer waiting" data-testid="inspector-answer">
            Waiting for an answer from you
          </p>
        ) : null
      ) : null}
      <div className="cv-actions">
        <TranscriptButton
          label="Sender's transcript"
          target={transcriptTarget(from, sessions, conversation.run, message.created_at)}
          testId="inspector-transcript-from"
        />
        <TranscriptButton
          label="Receiver's transcript"
          target={transcriptTarget(to, sessions, conversation.run, message.created_at)}
          testId="inspector-transcript-to"
        />
      </div>
      {thread.length > 1 ? (
        <ol className="cv-thread-list" aria-label="Thread" data-testid="inspector-thread">
          {thread.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                aria-current={candidate.id === message.id ? "true" : undefined}
                onClick={() => onSelect(candidate.id)}
              >
                <span className="mono mut">
                  {Number.isFinite(sentAt(candidate)) ? clockText(sentAt(candidate), true) : "?"}
                </span>{" "}
                {candidate.subject ?? "(no subject)"}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {body ? (
        <div className="cv-body" data-testid="inspector-body">
          <Markdown text={body} />
        </div>
      ) : null}
    </>
  );
}

function AgentView({
  conversation,
  agent,
  plan,
}: {
  conversation: RunConversation;
  agent: ConversationAgent;
  plan: PlanStepView[] | null;
}) {
  const spans = conversation.spans.filter((span) =>
    span.agent !== null ? span.agent === agent.id : agent.step !== null && span.step === agent.step,
  );
  const sent = conversation.messages.filter((message) => message.from === agent.id).length;
  const received = conversation.messages.filter((message) => message.to === agent.id).length;
  const costs = spans.flatMap((span) => {
    const cost = plan?.find((step) => step.id === span.step)?.cost_usd;
    return typeof cost === "number" ? [cost] : [];
  });
  return (
    <>
      <h3 className="cv-subject">{nameOf(agent).name}</h3>
      <dl className="cv-facts">
        <dt>Role</dt>
        <dd data-testid="inspector-role">{nameOf(agent).badge}</dd>
        <dt>Steps</dt>
        <dd>
          {spans.length === 0 ? (
            "none"
          ) : (
            <ul className="cv-steps" data-testid="inspector-steps">
              {spans.map((span) => (
                <li key={`${span.step}:${span.start}`}>
                  <span className="mono">{span.step}</span>{" "}
                  <span className="mut">
                    {clockText(Date.parse(span.start), true)}–
                    {span.end === null
                      ? "still running or crashed"
                      : clockText(Date.parse(span.end), true)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Messages</dt>
        <dd data-testid="inspector-counts">
          {sent} sent, {received} received
        </dd>
        <dt>Cost</dt>
        <dd data-testid="inspector-cost">
          {costs.length === 0
            ? "not recorded"
            : `$${costs.reduce((sum, cost) => sum + cost, 0).toFixed(2)}`}
        </dd>
      </dl>
    </>
  );
}

/** The side panel of the feed: the selected agent, else the selected message. */
export function Inspector({
  conversation,
  selected,
  agent,
  sessions,
  plan,
  onSelect,
  onAgent,
}: {
  conversation: RunConversation;
  selected: string | null;
  agent: string | null;
  sessions: SessionFile[] | null;
  plan: PlanStepView[] | null;
  onSelect: (id: string) => void;
  onAgent: (id: string) => void;
}) {
  const agentSelected = conversation.agents.find((candidate) => candidate.id === agent);
  const message = conversation.messages.find((candidate) => candidate.id === selected);
  return (
    <aside
      className={`cv-inspector ${roleClass(agentSelected ?? conversation.agents.find((candidate) => candidate.id === message?.from))}`}
      aria-label="Inspector"
      data-testid="inspector"
    >
      {agentSelected ? (
        <AgentView conversation={conversation} agent={agentSelected} plan={plan} />
      ) : message ? (
        <MessageView
          conversation={conversation}
          message={message}
          sessions={sessions}
          onSelect={onSelect}
          onAgent={onAgent}
        />
      ) : (
        <p className="mut">Select a message or an agent name to inspect it.</p>
      )}
    </aside>
  );
}
