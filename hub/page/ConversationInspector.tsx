import { useEffect, useState } from "react";
import type { ConversationAgent, ConversationMessage, RunConversation } from "../conversation.ts";
import type { PlanStepView, SessionFile } from "../types.ts";
import { sentAt, typeOf, useClockText } from "./conversation-model.ts";
import { nameOf, roleClass } from "./ConversationFeed.tsx";
import { Markdown } from "./Markdown.tsx";
import { runHref, transcriptHref } from "./RunDetail.tsx";

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

/**
 * One body, read from the hub when the run answer did not carry it. `text` is null while loading or when
 * there is none; `missing` is true when the hub no longer holds the message (a 404).
 */
function useBody(message: ConversationMessage): { text: string | null; missing: boolean } {
  const [fetched, setFetched] = useState<{
    id: string;
    text: string | null;
    missing: boolean;
  } | null>(null);
  useEffect(() => {
    if (message.body !== undefined) return;
    const controller = new AbortController();
    void fetch(`/api/conversation/message/${encodeURIComponent(message.id)}`, {
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok
          ? { text: ((await response.json()) as { body: string | null }).body, missing: false }
          : { text: null, missing: true },
      )
      .then((found) => setFetched({ id: message.id, ...found }))
      .catch(() => {});
    return () => controller.abort();
  }, [message.id, message.body]);
  if (message.body !== undefined) return { text: message.body, missing: false };
  return fetched?.id === message.id
    ? { text: fetched.text, missing: fetched.missing }
    : { text: null, missing: false };
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
  const threadId = message.thread_id ?? message.id;
  const thread = conversation.messages.filter(
    (candidate) => candidate.id === threadId || candidate.thread_id === threadId,
  );
  const body = useBody(message);
  const clockAt = useClockText();
  const time = (iso: string | null) => (iso === null ? "not recorded" : clockAt(Date.parse(iso)));
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
                  {Number.isFinite(sentAt(candidate)) ? clockAt(sentAt(candidate)) : "?"}
                </span>{" "}
                {candidate.subject ?? "(no subject)"}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {body.text ? (
        <div className="cv-body" data-testid="inspector-body">
          <Markdown text={body.text} />
        </div>
      ) : body.missing ? (
        <p className="mut" data-testid="inspector-body-missing">
          The hub no longer holds this message body.
        </p>
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
  const costs = [...new Set(spans.map((span) => span.step))].flatMap((stepId) => {
    const cost = plan?.find((step) => step.id === stepId)?.cost_usd;
    return typeof cost === "number" ? [cost] : [];
  });
  const clockAt = useClockText();
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
                    {clockAt(Date.parse(span.start))}–
                    {span.end === null ? "still running or crashed" : clockAt(Date.parse(span.end))}
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
        <dt>Step cost, all rounds</dt>
        <dd data-testid="inspector-cost">
          {costs.length === 0
            ? "not recorded"
            : `$${costs.reduce((sum, cost) => sum + cost, 0).toFixed(2)}`}
        </dd>
      </dl>
    </>
  );
}
/** What a click on the project map picked that is not a message or an agent. */
export type InspectorFocus =
  /** A human answer: the person marker on Master Chief's line, by its answer time. */
  | { kind: "person"; time: string }
  /** A station: one step of the run, by step id and start. */
  | { kind: "station"; step: string; start: string }
  /** The run line itself; `start` and `close` (null while open) come from the project run. */
  | { kind: "run"; start: number; close: number | null };

function PersonView({
  conversation,
  time,
  onSelect,
}: {
  conversation: RunConversation;
  time: string;
  onSelect: (id: string) => void;
}) {
  const clockAt = useClockText();
  const answer = conversation.answers.find((candidate) => candidate.time === time);
  const subjects = new Map(conversation.messages.map((message) => [message.id, message.subject]));
  const answered = conversation.questions.filter((question) => question.answered === time);
  return (
    <>
      <h3 className="cv-subject">You answered</h3>
      <dl className="cv-facts">
        <dt>At</dt>
        <dd data-testid="inspector-person-time">{clockAt(Date.parse(time))}</dd>
        <dt>Run</dt>
        <dd className="mono">{conversation.run}</dd>
        <dt>Gate</dt>
        <dd>{answer?.gate ?? "not recorded"}</dd>
        <dt>Answer</dt>
        <dd data-testid="inspector-person-answer">{answer?.answer ?? "(no text)"}</dd>
      </dl>
      {answered.length > 0 ? (
        <ol
          className="cv-thread-list"
          aria-label="Questions answered"
          data-testid="inspector-asked"
        >
          {answered.map((question) => (
            <li key={question.id}>
              <button type="button" onClick={() => onSelect(question.id)}>
                {subjects.get(question.id) ?? "(no subject)"}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mut">No question of this run is paired with this answer.</p>
      )}
    </>
  );
}

function StationView({
  conversation,
  step,
  start,
}: {
  conversation: RunConversation;
  step: string;
  start: string;
}) {
  const clockAt = useClockText();
  const span = conversation.spans.find(
    (candidate) => candidate.step === step && candidate.start === start,
  );
  if (!span) return <p className="mut">This step is not in the run any more.</p>;
  const agent = conversation.agents.find((candidate) =>
    span.agent !== null ? candidate.id === span.agent : candidate.step === step,
  );
  return (
    <>
      <h3 className="cv-subject">Step {span.step}</h3>
      <dl className="cv-facts">
        <dt>Run</dt>
        <dd className="mono">{conversation.run}</dd>
        <dt>Role</dt>
        <dd data-testid="inspector-role">{span.role}</dd>
        <dt>Agent</dt>
        <dd>{agent ? nameOf(agent).name : "not mapped"}</dd>
        <dt>Started</dt>
        <dd>{clockAt(Date.parse(span.start))}</dd>
        <dt>Ended</dt>
        <dd data-testid="inspector-ended">
          {span.end === null ? "still running or crashed" : clockAt(Date.parse(span.end))}
        </dd>
      </dl>
    </>
  );
}

function RunView({
  conversation,
  start,
  close,
}: {
  conversation: RunConversation;
  start: number;
  close: number | null;
}) {
  const clockAt = useClockText();
  return (
    <>
      <h3 className="cv-subject mono">{conversation.run}</h3>
      <dl className="cv-facts">
        <dt>Started</dt>
        <dd>{clockAt(start)}</dd>
        <dt>Closed</dt>
        <dd data-testid="inspector-closed">{close === null ? "still open" : clockAt(close)}</dd>
        <dt>Messages</dt>
        <dd data-testid="inspector-counts">{conversation.messages.length}</dd>
        <dt>Questions</dt>
        <dd>{conversation.questions.length}</dd>
        <dt>Answers</dt>
        <dd>{conversation.answers.length}</dd>
      </dl>
      <div className="cv-actions">
        <a
          className="btn"
          data-testid="inspector-open-run"
          href={runHref(conversation.run, "conversation")}
        >
          Open conversation
        </a>
      </div>
    </>
  );
}

/**
 * The side panel of the feed. A `focus` (project map: person, station, run line) wins, then the selected
 * agent, then the selected message. `conversation` is always the run that owns the click.
 */
export function Inspector({
  conversation,
  selected,
  agent,
  focus = null,
  sessions,
  plan,
  onSelect,
  onAgent,
}: {
  conversation: RunConversation;
  selected: string | null;
  agent: string | null;
  focus?: InspectorFocus | null;
  sessions: SessionFile[] | null;
  plan: PlanStepView[] | null;
  onSelect: (id: string) => void;
  onAgent: (id: string) => void;
}) {
  const agentSelected = focus
    ? undefined
    : conversation.agents.find((candidate) => candidate.id === agent);
  const message = focus
    ? undefined
    : conversation.messages.find((candidate) => candidate.id === selected);
  return (
    <aside
      className={`cv-inspector ${roleClass(agentSelected ?? conversation.agents.find((candidate) => candidate.id === message?.from))}`}
      aria-label="Inspector"
      data-testid="inspector"
    >
      {focus?.kind === "person" ? (
        <PersonView conversation={conversation} time={focus.time} onSelect={onSelect} />
      ) : focus?.kind === "station" ? (
        <StationView conversation={conversation} step={focus.step} start={focus.start} />
      ) : focus?.kind === "run" ? (
        <RunView conversation={conversation} start={focus.start} close={focus.close} />
      ) : agentSelected ? (
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
