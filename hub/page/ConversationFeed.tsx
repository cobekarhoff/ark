import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ArkEvent } from "../../cli/events.ts";
import type { ConversationAgent, ConversationMessage, RunConversation } from "../conversation.ts";
import {
  buildFeed,
  clockText,
  eventsChip,
  foldEventsAt,
  sentAt,
  typeOf,
  type FeedItem,
} from "./conversation-model.ts";
import { Markdown } from "./Markdown.tsx";

/** A body longer than this many lines or characters is cut, with "Show more". */
const cutLines = 8;
const cutCharacters = 600;

/** The role class of an agent: its colour, shared by the avatar, the badge and the trace. */
export function roleClass(agent: ConversationAgent | undefined): string {
  if (!agent) return "r-other";
  if (agent.kind === "chief") return "r-chief";
  if (agent.kind === "run_lead") return "r-lead";
  return agent.group ? `r-${agent.group}` : "r-other";
}

export function nameOf(agent: ConversationAgent | undefined): { name: string; badge: string } {
  if (!agent) return { name: "unknown", badge: "unknown" };
  switch (agent.kind) {
    case "chief":
      return { name: "Master Chief", badge: "chief" };
    case "run_lead":
      return { name: "Run lead", badge: "run lead" };
    case "worker":
      return { name: agent.step ?? agent.title ?? "worker", badge: agent.role ?? "worker" };
    case "session":
      return { name: agent.handle ?? "session", badge: "session" };
    case "unmapped":
      return { name: agent.handle ?? "unmapped", badge: "unmapped" };
  }
}

const initials = (name: string) =>
  name
    .split(/[\s:_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");

function Avatar({ agent }: { agent: ConversationAgent | undefined }) {
  return (
    <span className={`cv-avatar ${roleClass(agent)}`} aria-hidden="true">
      {initials(nameOf(agent).name)}
    </span>
  );
}

function Body({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > cutCharacters || text.split("\n").length > cutLines;
  return (
    <div className="cv-body-wrap">
      <div className={long && !open ? "cv-body clamp" : "cv-body"} data-clamped={long && !open}>
        <Markdown text={text} />
      </div>
      {long ? (
        <button
          type="button"
          className="btn small"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function Answer({
  conversation,
  message,
}: {
  conversation: RunConversation;
  message: ConversationMessage;
}) {
  if (message.type !== "question" && message.type !== "escalation") return null;
  const question = conversation.questions.find((candidate) => candidate.id === message.id);
  const toChief = conversation.agents.find((agent) => agent.id === message.to)?.kind === "chief";
  if (question?.answered) {
    const answer = conversation.answers.find((candidate) => candidate.time === question.answered);
    return (
      <p className="cv-answer" data-testid="feed-answer">
        You answered {answer?.gate ?? "the gate"}: {answer?.answer ?? "(no text)"}
        <span className="mut"> at {clockText(Date.parse(question.answered), true)}</span>
      </p>
    );
  }
  // Only Master Chief's questions wait for the human.
  return toChief ? (
    <p className="cv-answer waiting" data-testid="feed-waiting">
      Waiting for an answer from you
    </p>
  ) : null;
}

function Message({
  conversation,
  message,
  reply = false,
  selected,
  onSelect,
  onAgent,
}: {
  conversation: RunConversation;
  message: ConversationMessage;
  reply?: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onAgent: (id: string) => void;
}) {
  const agents = new Map(conversation.agents.map((agent) => [agent.id, agent]));
  const from = agents.get(message.from);
  const to = agents.get(message.to);
  const { name, badge } = nameOf(from);
  const time = sentAt(message);
  const card = message.type === "question" || message.type === "escalation";
  const choose = (event: KeyboardEvent) => {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      onSelect(message.id);
    }
  };
  return (
    <article
      className={`cv-msg ${roleClass(from)}${card ? ` cv-card ty-${message.type}` : ""}${reply ? " reply" : ""}`}
      data-testid="feed-message"
      data-id={message.id}
      data-type={typeOf(message)}
      data-t={Number.isFinite(time) ? time : undefined}
      aria-current={selected === message.id ? "true" : undefined}
      tabIndex={0}
      onClick={() => onSelect(message.id)}
      onKeyDown={choose}
    >
      <Avatar agent={from} />
      <div className="cv-content">
        <header className="cv-head">
          <button
            type="button"
            className="cv-name"
            data-testid="feed-agent"
            onClick={(event) => {
              event.stopPropagation();
              if (from) onAgent(from.id);
            }}
          >
            {name}
          </button>
          <span className={`cv-badge ${roleClass(from)}`}>{badge}</span>
          <span className="mut">to {nameOf(to).name}</span>
          <span className="mut mono end">
            {Number.isFinite(time) ? clockText(time, true) : "time unknown"}
          </span>
        </header>
        <div className="cv-subject">
          {message.type && message.type !== "status" ? (
            <span className="cv-type">{message.type}</span>
          ) : null}
          {message.subject ?? "(no subject)"}
        </div>
        {message.body ? <Body text={message.body} /> : null}
        <Answer conversation={conversation} message={message} />
      </div>
    </article>
  );
}

function eventText(event: ArkEvent): string {
  const detail = [event.data.step, event.data.gate, event.data.criterion].find(
    (value): value is string => typeof value === "string",
  );
  return detail ? `${event.type} ${detail}` : event.type;
}

function Events({ events }: { events: ArkEvent[] }) {
  const [open, setOpen] = useState(false);
  const folded = events.length >= foldEventsAt && !open;
  return (
    <div className="cv-events" data-testid={folded ? "feed-events-folded" : "feed-events"}>
      {folded ? (
        <button
          type="button"
          className="cv-fold"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          {events.length} Ark events, {clockText(Date.parse(events[0]!.time), true)}–
          {clockText(Date.parse(events.at(-1)!.time), true)}
        </button>
      ) : (
        <>
          {events.length >= foldEventsAt ? (
            <button
              type="button"
              className="cv-fold"
              aria-expanded={true}
              onClick={() => setOpen(false)}
            >
              Fold {events.length} Ark events
            </button>
          ) : null}
          {events.map((event) => (
            <p className="cv-event" key={event.seq} data-testid="feed-event">
              <span className="mono">{clockText(Date.parse(event.time), true)}</span>{" "}
              {eventText(event)}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * Chips and search above the messages, oldest first. `reveal` scrolls the feed to a message (a trace click);
 * `onTop` reports the time of the message at the top, which the trace cursor follows.
 */
export function Feed({
  conversation,
  selected,
  reveal,
  onSelect,
  onAgent,
  onTop,
}: {
  conversation: RunConversation;
  selected: string | null;
  reveal: { id: string; nonce: number } | null;
  onSelect: (id: string) => void;
  onAgent: (id: string) => void;
  onTop: (time: number | null) => void;
}) {
  const [active, setActive] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState("");
  const [openThreads, setOpenThreads] = useState<ReadonlySet<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const items = buildFeed(conversation, active, search);

  const types = [...new Set(conversation.messages.map(typeOf))].sort();
  const chips = [...types, ...(conversation.events?.length ? [eventsChip] : [])];
  const counts = new Map<string, number>();
  for (const message of conversation.messages)
    counts.set(typeOf(message), (counts.get(typeOf(message)) ?? 0) + 1);
  counts.set(eventsChip, conversation.events?.length ?? 0);

  // A reveal of a message the chips or the search hide clears them; one in a collapsed thread opens it.
  useEffect(() => {
    if (!reveal) return;
    const shown = (items: FeedItem[]) =>
      items.find(
        (item) =>
          item.kind === "message" &&
          (item.message.id === reveal.id || item.replies.some((reply) => reply.id === reveal.id)),
      );
    if (!shown(buildFeed(conversation, active, search))) {
      setActive(new Set());
      setSearch("");
    }
    const thread = shown(buildFeed(conversation, new Set(), ""));
    if (thread?.kind === "message" && thread.message.id !== reveal.id)
      setOpenThreads((previous) => new Set(previous).add(thread.message.id));
    // Scrolled after the clear and the open have rendered.
    const frame = requestAnimationFrame(() => {
      const element = scroller.current?.querySelector<HTMLElement>(
        `[data-id="${CSS.escape(reveal.id)}"]`,
      );
      if (element && scroller.current) scroller.current.scrollTop = element.offsetTop - 8;
    });
    return () => cancelAnimationFrame(frame);
    // Only a new reveal scrolls; the data and filters are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  // The time of the first message whose bottom is below the top of the feed.
  const reportTop = () => {
    const box = scroller.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    const first = [...box.querySelectorAll<HTMLElement>("[data-t]")].find(
      (element) => element.getBoundingClientRect().bottom > top + 1,
    );
    onTop(first ? Number(first.dataset.t) : null);
  };
  // After each render the list may have changed under the same scroll position.
  useEffect(reportTop);

  const toggle = (chip: string) =>
    setActive((previous) => {
      const next = new Set(previous);
      if (!next.delete(chip)) next.add(chip);
      return next;
    });

  return (
    <section className="cv-feed" aria-label="Messages" data-testid="feed">
      <div className="cv-feedhead">
        <div className="seg" role="group" aria-label="Filter by type">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              aria-pressed={active.has(chip)}
              data-testid="feed-chip"
              data-chip={chip}
              onClick={() => toggle(chip)}
            >
              {chip} <span className="mut">{counts.get(chip) ?? 0}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          value={search}
          placeholder="Search subject and body"
          aria-label="Search messages"
          data-testid="feed-search"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="cv-scroller" ref={scroller} onScroll={reportTop} tabIndex={-1}>
        {items.length === 0 ? (
          <p className="mut" data-testid="feed-empty">
            {conversation.messages.length === 0
              ? "No messages in this run."
              : "No message matches the chips and the search."}
          </p>
        ) : null}
        {items.map((item: FeedItem) =>
          item.kind === "events" ? (
            <Events key={`events:${item.events[0]!.seq}`} events={item.events} />
          ) : (
            <div className="cv-thread" key={item.message.id}>
              <Message
                conversation={conversation}
                message={item.message}
                selected={selected}
                onSelect={onSelect}
                onAgent={onAgent}
              />
              {item.replies.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="cv-fold"
                    aria-expanded={openThreads.has(item.message.id)}
                    data-testid="feed-replies"
                    onClick={() =>
                      setOpenThreads((previous) => {
                        const next = new Set(previous);
                        if (!next.delete(item.message.id)) next.add(item.message.id);
                        return next;
                      })
                    }
                  >
                    {item.replies.length} {item.replies.length === 1 ? "reply" : "replies"}
                  </button>
                  {openThreads.has(item.message.id)
                    ? item.replies.map((replyMessage) => (
                        <Message
                          key={replyMessage.id}
                          conversation={conversation}
                          message={replyMessage}
                          reply
                          selected={selected}
                          onSelect={onSelect}
                          onAgent={onAgent}
                        />
                      ))
                    : null}
                </>
              ) : null}
            </div>
          ),
        )}
      </div>
    </section>
  );
}
