import { useEffect, useId, useRef, useState, type KeyboardEvent, type SubmitEvent } from "react";
import { Cost } from "./format.tsx";
import { Markdown } from "./Markdown.tsx";
import { ticketHref, useLive, useProject } from "./store.tsx";
import type { CompanionItem, CompanionRow, CompanionsReply, CompanionState } from "../types.ts";

const refreshMilliseconds = 10_000;
const limitCharacters = 400;
const shownIdeas = 4;
const refusal =
  "the hub refused the write. Open it at the 127.0.0.1 address it prints, the only address it accepts for this.";

/** The companions route, read again when Ark's files or the usage index change, every 10 s (Orca state has no push), and after each action. */
function useCompanions() {
  const { snapshot } = useLive();
  const [reply, setReply] = useState<CompanionsReply | null>(null);
  const [failed, setFailed] = useState(false);
  const [token, setToken] = useState(0);
  const pushed = `${snapshot?.sources.ark.read_at}|${snapshot?.sources.usage.read_at}`;
  useEffect(() => {
    const timer = setInterval(() => setToken((previous) => previous + 1), refreshMilliseconds);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/companions", { signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as CompanionsReply) : null))
      .then((value) => {
        if (controller.signal.aborted) return;
        setFailed(value === null);
        if (value !== null) setReply(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [pushed, token]);
  return { reply, failed, reload: () => setToken((previous) => previous + 1) };
}

type Action = "approve" | "dismiss" | "ask";
type Outcome = { ok: true } | { ok: false; message: string };

/** One write. The message of a refusal is the hub's own `error`, so the row says what the server said. */
async function write(action: Action, body: Record<string, unknown>): Promise<Outcome> {
  try {
    const response = await fetch(`/api/companions/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    if (response.status === 403) return { ok: false, message: refusal };
    const detail = await response.json().then(
      (value: { error?: unknown }) => (typeof value.error === "string" ? value.error : ""),
      () => "",
    );
    return { ok: false, message: detail || `the hub answered ${response.status}` };
  } catch {
    return { ok: false, message: "the hub did not answer" };
  }
}

const characters = (value: string) => Array.from(value).length;

/** Text with `code` spans and nothing else: React escapes the rest, so agent-written text never becomes markup. */
function Codes({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/`([^`]+)`/)
        .map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part))}
    </>
  );
}

const whenText = (time: string) =>
  new Date(time).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function StateCell({ row }: { row: CompanionRow }) {
  if (row.state === "unavailable")
    return (
      <span className="pill unk" title="Orca did not answer, so the state is not known">
        unavailable
      </span>
    );
  if (row.state === "running") return <span className="pill ok">running</span>;
  return (
    <>
      <span className="pill warn">not running</span>
      <span className="co-why">
        next <code>ark companions sync</code> starts it
      </span>
    </>
  );
}

function Table({ rows, many }: { rows: (CompanionRow & { project: string })[]; many: boolean }) {
  return (
    <section className="panel" aria-label="Companions">
      <table className="co-table" data-testid="companions-table">
        <thead>
          <tr>
            <th scope="col">Companion</th>
            <th scope="col">State</th>
            <th scope="col">Last wake</th>
            <th scope="col">Triggers</th>
            <th scope="col" className="co-num">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.project}/${row.name}`}
              data-testid="companion-row"
              data-companion={row.name}
              data-state={row.state}
            >
              <td className="co-who">
                <span className="co-name" translate="no">
                  {row.name}
                </span>
                <span className="co-cfg">
                  {many ? `${row.project} · ` : ""}
                  {row.harness} · {row.model}
                </span>
              </td>
              <td data-label="State" data-testid="companion-state">
                <span>
                  <StateCell row={row} />
                </span>
              </td>
              <td data-label="Last wake" data-testid="companion-wake">
                <span>
                  {row.last_wake ? (
                    <>
                      <time dateTime={row.last_wake.time}>{whenText(row.last_wake.time)}</time>
                      <span className="co-why">
                        <span className="mono">{row.last_wake.trigger}</span>
                        {row.last_wake.run ? (
                          <>
                            {" · "}
                            <span className="mono">{row.last_wake.run}</span>
                          </>
                        ) : null}
                      </span>
                    </>
                  ) : (
                    <>
                      <span>none</span>
                      <span className="co-why">never woken</span>
                    </>
                  )}
                </span>
              </td>
              <td data-label="Triggers">
                <ul className="co-triggers" data-testid="companion-triggers">
                  {row.on.map((trigger) => (
                    <li key={trigger}>{trigger}</li>
                  ))}
                </ul>
              </td>
              <td data-label="Cost" className="co-num">
                <span>
                  <Cost usd={row.cost} testId="companion-cost" />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

type Form = "dismiss" | "ask";
type Shown = CompanionItem & { project: string };

/** The dismiss or ask form of one item: a counted textarea, refusals on the form itself. */
function ItemForm({
  kind,
  item,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  kind: Form;
  item: Shown;
  busy: boolean;
  error: string | null;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const dismiss = kind === "dismiss";
  const count = characters(text);
  const shownError = local ?? error;
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (text.trim() === "")
      return setLocal(
        dismiss
          ? "Add a reason. The companion reads it before it proposes again."
          : "Write the question first.",
      );
    if (count > limitCharacters)
      return setLocal(`Over the limit of ${limitCharacters} characters (${count}). Shorten it.`);
    setLocal(null);
    onSubmit(text);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") onCancel();
  };
  return (
    <form
      className="co-form"
      data-form={kind}
      noValidate
      onSubmit={submit}
      onKeyDown={onKey}
      data-testid={`companion-${kind}-form`}
    >
      <label htmlFor={id}>
        {dismiss ? (
          "Reason"
        ) : (
          <>
            Question for <span className="mono">{item.companion}</span>
          </>
        )}{" "}
        <span className="hint">
          {dismiss
            ? `Saved to companions/${item.companion}/dismissed.md. The companion reads it before it proposes again.`
            : "Wakes the companion. Its answer goes to Master Chief."}
        </span>
      </label>
      <textarea
        id={id}
        name={dismiss ? "reason" : "question"}
        rows={2}
        autoComplete="off"
        spellCheck
        aria-invalid={shownError ? true : undefined}
        aria-describedby={shownError ? `${id}-error` : undefined}
        placeholder={dismiss ? "Already covered by ARK-498…" : "Which runs did this fail on…"}
        value={text}
        autoFocus
        onChange={(event) => {
          setText(event.target.value);
          setLocal(null);
        }}
      />
      {shownError ? (
        <p className="co-err" id={`${id}-error`} data-testid="companion-form-error">
          {shownError}
        </p>
      ) : null}
      <div className="row">
        <button type="submit" className="btn" disabled={busy}>
          {busy
            ? dismiss
              ? "Dismissing…"
              : "Sending…"
            : dismiss
              ? item.kind === "ticket"
                ? "Dismiss ticket"
                : "Dismiss idea"
              : "Send question"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <span className={count > limitCharacters ? "co-count over" : "co-count"} aria-hidden="true">
          {count} / {limitCharacters}
        </span>
      </div>
    </form>
  );
}

function Item({
  item,
  askOff,
  onChanged,
}: {
  item: Shown;
  /** Why Ask is off, or null when the companion's worker runs. */
  askOff: string | null;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [marked, setMarked] = useState<"approved" | "dismissed" | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const dismissButton = useRef<HTMLButtonElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);
  const done = marked ?? item.done;
  const reference = item.kind === "ticket" ? item.ref : `idea from ${item.companion}`;
  const target = { project: item.project, name: item.companion };
  const itemRef = { kind: item.kind, ref: item.ref };

  const speak = (text: string, error: boolean) => {
    setMessage({ text, error });
    // The message is read out when it appears; focus moves to it so a keyboard user lands on the result.
    queueMicrotask(() => status.current?.focus());
  };
  const close = (which: Form) => {
    setForm(null);
    setFormError(null);
    (which === "dismiss" ? dismissButton : askButton).current?.focus();
  };
  const open = (which: Form) => {
    setMessage(null);
    setFormError(null);
    setForm(form === which ? null : which);
  };

  const approve = async () => {
    setBusy("approve");
    setMessage(null);
    const outcome = await write("approve", { ...target, id: item.ref });
    setBusy(null);
    if (!outcome.ok) return speak(`Not approved: ${outcome.message}`, true);
    setMarked("approved");
    speak(`Approved. ${item.ref} is ready; Master Chief queues it next.`, false);
    onChanged();
  };
  const dismiss = async (reason: string) => {
    setBusy("dismiss");
    setFormError(null);
    const outcome = await write("dismiss", { ...target, item: itemRef, reason });
    setBusy(null);
    if (!outcome.ok) return setFormError(`Not dismissed: ${outcome.message}`);
    setForm(null);
    setMarked("dismissed");
    speak(`Dismissed. The reason is saved to companions/${item.companion}/dismissed.md.`, false);
    onChanged();
  };
  const ask = async (question: string) => {
    setBusy("ask");
    setFormError(null);
    const outcome = await write("ask", { ...target, item: itemRef, question });
    setBusy(null);
    if (!outcome.ok) return setFormError(`Not sent: ${outcome.message}`);
    setForm(null);
    speak(`Question sent to ${item.companion}. Its answer goes to Master Chief.`, false);
  };

  return (
    <li
      data-testid="companion-item"
      data-kind={item.kind}
      data-ref={item.ref}
      data-companion={item.companion}
      data-done={done ?? undefined}
    >
      <div>
        <div className="co-item-head">
          {item.kind === "ticket" ? (
            <a className="mono strong" href={ticketHref(item.ref)}>
              {item.ref}
            </a>
          ) : null}
          <span className="title">
            <Codes text={item.title} />
          </span>
        </div>
        {item.body ? (
          <div className="co-item-body">
            <Markdown text={item.body} />
          </div>
        ) : null}
        <p className="co-item-meta">
          <span className="mono" translate="no">
            {item.companion}
          </span>
        </p>
      </div>
      <div className="co-item-actions">
        {done === "approved" ? <span className="pill ok">approved</span> : null}
        {done === "dismissed" ? <span className="pill">dismissed</span> : null}
        {done === null ? (
          <>
            {item.kind === "ticket" ? (
              <button
                type="button"
                className="btn primary"
                aria-label={`Approve ${item.ref}`}
                disabled={busy !== null}
                onClick={approve}
              >
                {busy === "approve" ? "Approving…" : "Approve"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              ref={dismissButton}
              aria-expanded={form === "dismiss"}
              aria-label={`Dismiss ${reference}`}
              onClick={() => open("dismiss")}
            >
              Dismiss…
            </button>
            <button
              type="button"
              className="btn"
              ref={askButton}
              aria-expanded={form === "ask"}
              aria-label={`Ask about ${reference}`}
              disabled={askOff !== null}
              title={askOff ?? undefined}
              onClick={() => open("ask")}
            >
              Ask…
            </button>
          </>
        ) : null}
      </div>
      {done === null && form !== null ? (
        <ItemForm
          key={form}
          kind={form}
          item={item}
          busy={busy === form}
          error={formError}
          onSubmit={form === "dismiss" ? dismiss : ask}
          onCancel={() => close(form)}
        />
      ) : null}
      <p
        className={message?.error ? "co-status err" : "co-status"}
        role="status"
        tabIndex={-1}
        ref={status}
        data-testid="companion-status"
      >
        {message?.text}
      </p>
    </li>
  );
}

function Items({
  list,
  states,
  onChanged,
}: {
  list: Shown[];
  /** `project/companion` to state. */
  states: Map<string, CompanionState>;
  onChanged: () => void;
}) {
  return (
    <ul className="co-items">
      {list.map((item) => {
        const state = states.get(`${item.project}/${item.companion}`);
        return (
          <Item
            key={`${item.project}/${item.companion}/${item.kind}/${item.ref}`}
            item={item}
            askOff={
              state === "running"
                ? null
                : state === "unavailable"
                  ? "Ask needs Orca"
                  : "Ask needs the companion running"
            }
            onChanged={onChanged}
          />
        );
      })}
    </ul>
  );
}

function Section({
  title,
  count,
  testId,
  children,
}: {
  title: string;
  count: number;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <h2 className="co-h2">
        {title} <span className="co-count">{count}</span>
      </h2>
      <section className="panel" aria-label={title} data-testid={testId}>
        {children}
      </section>
    </>
  );
}

export function Companions() {
  const project = useProject();
  const { reply, failed, reload } = useCompanions();
  const [allIdeas, setAllIdeas] = useState(false);
  if (reply === null)
    return (
      <>
        <h1>Companions</h1>
        <p className="mut" role="status">
          {failed ? "The hub did not answer. Reload the page." : "Loading…"}
        </p>
      </>
    );
  const shown = reply.projects.filter((entry) => project === null || entry.project === project);
  const errors = shown.flatMap((entry) => ("error" in entry ? [entry] : []));
  const loaded = shown.flatMap((entry) => ("error" in entry ? [] : [entry]));
  const rows = loaded.flatMap((entry) =>
    entry.companions.map((row) => ({ ...row, project: entry.project })),
  );
  const tickets = loaded.flatMap((entry) =>
    entry.tickets.map((item) => ({ ...item, project: entry.project })),
  );
  const ideas = loaded.flatMap((entry) =>
    entry.ideas.map((item) => ({ ...item, project: entry.project })),
  );
  const running = rows.filter((row) => row.state === "running").length;
  const states = new Map(rows.map((row) => [`${row.project}/${row.name}`, row.state]));
  // The first shownIdeas of each companion: one busy companion never hides the others' latest.
  const shownPerCompanion = new Map<string, number>();
  const latestIdeas = ideas.filter((item) => {
    const key = `${item.project}/${item.companion}`;
    const count = (shownPerCompanion.get(key) ?? 0) + 1;
    shownPerCompanion.set(key, count);
    return count <= shownIdeas;
  });
  const unavailable = reply.orca === "unavailable";
  return (
    <>
      <h1>
        Companions
        <span className="sub mut">
          {rows.length === 0
            ? "none listed in ark.yml"
            : unavailable
              ? `${rows.length} listed in ark.yml`
              : `${rows.length} listed in ark.yml · ${running} running`}
        </span>
      </h1>
      {unavailable && rows.length > 0 ? (
        <div className="co-notice" role="status" data-testid="companions-orca-notice">
          <b>Orca is not answering</b>
          <p>
            Companion state is unknown, not stopped. Last wake, cost, ideas and tickets come from
            files and are current. Approve and Dismiss still work. Ask needs Orca and is off.
          </p>
        </div>
      ) : null}
      {errors.map((entry) => (
        <div className="co-notice" role="alert" key={entry.project} data-testid="companions-error">
          <b>The ark.yml of {entry.project} does not load</b>
          <p>{entry.error}</p>
        </div>
      ))}
      {rows.length === 0 ? (
        errors.length > 0 ? null : (
          <section className="panel" aria-label="No companions" data-testid="companions-empty">
            <div className="co-empty">
              <p>
                <strong>No companions yet.</strong> A companion is an always-on helper agent that
                Ark keeps running and wakes on run events. Add a <code>companions</code> list to{" "}
                <code>ark.yml</code>, then run <code>ark companions sync</code>.
              </p>
              <pre className="co-sample">
                {`companions:
  - name: docs-gardener
    instructions: companions/docs-gardener.md
    harness: claude
    model: sonnet
    on: [run.merged]`}
              </pre>
            </div>
          </section>
        )
      ) : (
        <>
          <Table rows={rows} many={loaded.length > 1} />
          <Section title="Proposed tickets" count={tickets.length} testId="companion-tickets">
            {tickets.length > 0 ? (
              <Items list={tickets} states={states} onChanged={reload} />
            ) : (
              <div className="co-empty">
                <p>
                  <strong>No proposed tickets.</strong> A companion proposes one with{" "}
                  <code>ark companion propose</code>. It lands here as <code>proposed</code> and is
                  never queued until you approve it.
                </p>
              </div>
            )}
          </Section>
          <Section title="Latest ideas" count={ideas.length} testId="companion-ideas">
            {ideas.length > 0 ? (
              <>
                <Items list={allIdeas ? ideas : latestIdeas} states={states} onChanged={reload} />
                {ideas.length > latestIdeas.length ? (
                  <div className="co-more">
                    <span className="mut">
                      {allIdeas
                        ? `All ${ideas.length} shown.`
                        : `Latest ${shownIdeas} of each companion: ${latestIdeas.length} of ${ideas.length} shown.`}
                    </span>
                    <button type="button" className="btn" onClick={() => setAllIdeas(!allIdeas)}>
                      {allIdeas ? "Show fewer" : `Show ${ideas.length - latestIdeas.length} more`}
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="co-empty">
                <p>
                  <strong>No ideas yet.</strong> A companion writes ideas to{" "}
                  <code>companions/&lt;name&gt;/ideas.md</code> after a wake. The latest show here.
                </p>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}
