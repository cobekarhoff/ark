import { useEffect, useRef, useState } from "react";
import { Code, Json } from "./Code.tsx";
import { Markdown, ViewSwitch } from "./Markdown.tsx";
import { Clock, runHref, sessionName } from "./RunDetail.tsx";
import type { SessionFile, TranscriptEntry, TranscriptPage, TranscriptResult } from "../types.ts";

type Pages =
  | { status: "loading"; entries: TranscriptEntry[]; next: number | null }
  | { status: "ok" | "more"; entries: TranscriptEntry[]; next: number | null }
  | { status: "failed"; entries: TranscriptEntry[]; next: number | null; reason: string };

type Chip = "message" | "tool" | "thinking" | "errors";
const chips: { id: Chip; label: string }[] = [
  { id: "message", label: "Messages" },
  { id: "tool", label: "Tools" },
  { id: "thinking", label: "Thinking" },
  { id: "errors", label: "Errors" },
];
const isError = (entry: TranscriptEntry) => entry.kind === "tool" && entry.status === "error";

/** One list row: the first words of the entry. The full text is in the inspector. */
const firstWords = (text: string) => text.slice(0, 200).split("\n", 1)[0] ?? "";
const rowLabel = (entry: TranscriptEntry) =>
  entry.kind === "message" ? entry.role : entry.kind === "thinking" ? "thinking" : entry.name;
const rowSummary = (entry: TranscriptEntry) =>
  entry.kind === "tool" ? firstWords(entry.summary || entry.args) : firstWords(entry.text);

function Row({
  entry,
  selected,
  onSelect,
}: {
  entry: TranscriptEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`trow ${entry.kind}${isError(entry) ? " err" : ""}`}
      data-testid="transcript-entry"
      data-kind={entry.kind}
      data-status={entry.kind === "tool" ? entry.status : undefined}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="mono mut t">{entry.time ? <Clock time={entry.time} /> : ""}</span>
      <span className="k">{rowLabel(entry)}</span>
      <span className="s">{rowSummary(entry)}</span>
      {isError(entry) && entry.kind === "tool" && entry.result !== "" && (
        <span className="e">{entry.result}</span>
      )}
    </button>
  );
}

const languageOf = (path: string) => path.split(".").at(-1) ?? "";

/** What a tool call did: a bash command through Code, a written file through Code, any other arguments through Json. */
function Arguments({ entry }: { entry: Extract<TranscriptEntry, { kind: "tool" }> }) {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(entry.args);
    if (value && typeof value === "object") parsed = value;
  } catch {
    // A cut that broke the JSON shows as written.
  }
  if (entry.name === "bash" && typeof parsed.command === "string")
    return <Code code={parsed.command} language="bash" />;
  const path = parsed.path ?? parsed.file_path;
  if (entry.name === "write" && typeof path === "string" && typeof parsed.content === "string")
    return (
      <>
        <p className="mono mut">{path}</p>
        <Code code={parsed.content} language={languageOf(path)} />
      </>
    );
  const before = parsed.old_text ?? parsed.oldText ?? parsed.old_string;
  const after = parsed.new_text ?? parsed.newText ?? parsed.new_string;
  if (entry.name === "edit" && typeof path === "string" && typeof after === "string") {
    const prefixed = (sign: string, text: string) =>
      text
        .split("\n")
        .map((line) => sign + line)
        .join("\n");
    return (
      <>
        <p className="mono mut">{path}</p>
        <Code
          code={
            (typeof before === "string" ? prefixed("- ", before) + "\n" : "") +
            prefixed("+ ", after)
          }
          language="diff"
        />
      </>
    );
  }
  return <Json text={entry.args} />;
}

const parsesAsJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

type ResultState =
  | { status: "idle" | "loading" | "missing" | "failed" }
  | ({ status: "ok" } & TranscriptResult);

/** The full result of one call, read on click only. The state lives above the inspector, so a loaded result survives a move of the selection. */
function FullResult({
  state,
  size,
  onShow,
}: {
  state: ResultState;
  size: number;
  onShow: () => void;
}) {
  if (state.status === "ok") {
    return (
      <div data-testid="full-result">
        <p className="mut">
          {state.size.toLocaleString()} characters
          {state.cut && " · cut at 64,000 characters"}
        </p>
        {parsesAsJson(state.text) ? <Json text={state.text} /> : <Code code={state.text} />}
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn"
        data-testid="show-result"
        disabled={state.status === "loading"}
        onClick={onShow}
      >
        {state.status === "loading"
          ? "Reading…"
          : `Show result${size > 0 ? ` · ${size < 1000 ? `${size} characters` : `${Math.round(size / 1000)} KB`}` : ""}`}
      </button>
      {state.status === "missing" && (
        <p className="mut" role="status" data-testid="result-missing">
          This result is not available: the call has no result in the file yet.
        </p>
      )}
      {state.status === "failed" && (
        <p className="bad-text" role="alert">
          The hub could not read this result.
        </p>
      )}
    </>
  );
}

function Inspector({
  entry,
  raw,
  results,
  onShowResult,
}: {
  entry: TranscriptEntry;
  raw: boolean;
  results: Record<string, ResultState>;
  onShowResult: (callId: string) => void;
}) {
  const callId = entry.kind === "tool" ? entry.callId : undefined;
  if (entry.kind === "tool")
    return (
      <>
        <h2 className="mono">
          {entry.name}{" "}
          <span
            className={`pill ${entry.status === "ok" ? "ok" : entry.status === "error" ? "bad" : "unk"}`}
          >
            {entry.status === "unknown" ? "no result" : entry.status}
          </span>
        </h2>
        {raw ? (
          <pre className="raw" tabIndex={0}>
            {entry.args}
          </pre>
        ) : (
          <Arguments entry={entry} />
        )}
        {entry.result !== "" && (
          <p className="res" data-testid="tool-result">
            {entry.result}
          </p>
        )}
        {callId !== undefined && (
          <FullResult
            state={results[callId] ?? { status: "idle" }}
            size={entry.resultSize}
            onShow={() => onShowResult(callId)}
          />
        )}
      </>
    );
  const body = <Markdown text={entry.text} raw={raw} testId="entry-text" />;
  if (entry.kind === "thinking")
    return (
      <details className="think" data-testid="thinking">
        <summary>thinking · {entry.text.split("\n").length} lines</summary>
        {body}
      </details>
    );
  return (
    <>
      <h2>{entry.role}</h2>
      {body}
    </>
  );
}

type Selection = { kind: "entry"; index: number } | { kind: "file"; path: string } | null;

/** One session file, 200 entries a page: the server reads each page in the usage worker thread. */
function SessionPages({
  run,
  session,
  files,
}: {
  run: string;
  session: SessionFile;
  files: string[];
}) {
  const [pages, setPages] = useState<Pages>({ status: "loading", entries: [], next: null });
  const [on, setOn] = useState<Set<Chip>>(new Set());
  const [selected, setSelected] = useState<Selection>(null);
  const [raw, setRaw] = useState(false);
  const [results, setResults] = useState<Record<string, ResultState>>({});
  const showResult = async (callId: string) => {
    const set = (state: ResultState) => setResults((current) => ({ ...current, [callId]: state }));
    set({ status: "loading" });
    try {
      const response = await fetch(
        `/api/run/${encodeURIComponent(run)}/transcript/result?file=${encodeURIComponent(session.file)}&call=${encodeURIComponent(callId)}`,
      );
      if (response.status === 404) return set({ status: "missing" });
      if (!response.ok) return set({ status: "failed" });
      set({ status: "ok", ...(await response.json()) });
    } catch {
      set({ status: "failed" });
    }
  };
  const list = useRef<HTMLDivElement>(null);
  const load = async (cursor: number, previous: TranscriptEntry[], signal?: AbortSignal) => {
    setPages((current) => ({ ...current, status: cursor === 0 ? "loading" : "more" }));
    try {
      const response = await fetch(
        `/api/run/${encodeURIComponent(run)}/transcript?file=${encodeURIComponent(session.file)}&cursor=${cursor}`,
        { signal },
      );
      if (!response.ok) throw new Error(`the hub answered ${response.status}`);
      const page: TranscriptPage = await response.json();
      setPages({ status: "ok", entries: [...previous, ...page.entries], next: page.next });
    } catch (err) {
      if (signal?.aborted) return;
      setPages({
        status: "failed",
        entries: previous,
        next: cursor === 0 ? null : cursor,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(0, [], controller.signal);
    return () => controller.abort();
    // The component is keyed by file: it mounts once per session file.
  }, []);

  // Errors overrides the kind chips: only failed calls. Else the kind chips combine; none on = all.
  const visible = pages.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) =>
      on.has("errors") ? isError(entry) : on.size === 0 || on.has(entry.kind),
    );
  const counts: Record<Chip, number> = {
    message: pages.entries.filter((entry) => entry.kind === "message").length,
    tool: pages.entries.filter((entry) => entry.kind === "tool").length,
    thinking: pages.entries.filter((entry) => entry.kind === "thinking").length,
    errors: pages.entries.filter(isError).length,
  };
  const entry = selected?.kind === "entry" ? pages.entries[selected.index] : undefined;

  // j and k move through the visible entries, r switches Rendered and Raw.
  const keys = useRef({ visible, selected });
  keys.current = { visible, selected };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable;
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "r") return setRaw((current) => !current);
      if (event.key !== "j" && event.key !== "k") return;
      const { visible: rows, selected: current } = keys.current;
      if (rows.length === 0) return;
      const at = rows.findIndex(
        ({ index }) => current?.kind === "entry" && index === current.index,
      );
      const next = event.key === "j" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
      setSelected({ kind: "entry", index: rows[next]!.index });
      list.current
        ?.querySelectorAll("[data-testid=transcript-entry]")
        [next]?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div
        className={`filterbar${on.has("errors") ? " only-errors" : ""}`}
        role="group"
        aria-label="Filter"
      >
        {chips.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`fchip${id === "errors" ? " errors" : ""}`}
            data-testid={`chip-${id}`}
            aria-pressed={on.has(id)}
            onClick={() =>
              setOn((current) => {
                const next = new Set(current);
                if (!next.delete(id)) next.add(id);
                return next;
              })
            }
          >
            {label} <span className="n">{counts[id]}</span>
          </button>
        ))}
        <span className="mut" data-testid="transcript-count">
          Showing {visible.length} of {pages.entries.length} loaded entries
        </span>
        <span className="grow" />
        <ViewSwitch raw={raw} onChange={setRaw} />
      </div>
      <div className="tsplit">
        <div className="tlist">
          <div ref={list} className="msgs" aria-label="Transcript" data-testid="transcript">
            {visible.map(({ entry: row, index }) => (
              <Row
                key={index}
                entry={row}
                selected={selected?.kind === "entry" && selected.index === index}
                onSelect={() => setSelected({ kind: "entry", index })}
              />
            ))}
          </div>
          {pages.status === "failed" && (
            <p className="bad-text" role="alert">
              Could not read this file: {pages.reason}.
            </p>
          )}
          {pages.status === "loading" && <p className="mut">Reading…</p>}
          {pages.status !== "loading" &&
            pages.entries.length === 0 &&
            pages.status !== "failed" && <p className="mut">This file holds no message yet.</p>}
          <div className="more">
            <button
              type="button"
              className="btn"
              data-testid="load-more"
              disabled={pages.next === null || pages.status === "more"}
              onClick={() => pages.next !== null && void load(pages.next, pages.entries)}
            >
              Load more
            </button>
            <span className="mut">
              {pages.next === null
                ? `End of file · ${pages.entries.length} entries`
                : `${pages.entries.length} entries loaded · 200 per page`}
              . Chip counts cover the loaded entries only.
            </span>
          </div>
          {files.length > 0 && (
            <div className="tfiles">
              <h2>Run files</h2>
              <ul className="files">
                {files.map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      className="mono linkish"
                      data-testid="transcript-run-file"
                      data-path={path}
                      aria-current={
                        selected?.kind === "file" && selected.path === path ? "true" : undefined
                      }
                      onClick={() => setSelected({ kind: "file", path })}
                    >
                      {path}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <section className="inspector" aria-label="Inspector" data-testid="inspector">
          {selected?.kind === "file" ? (
            <>
              <h2 className="mono">{selected.path}</h2>
              <FileBody run={run} path={selected.path} />
            </>
          ) : entry ? (
            <Inspector
              key={selected?.kind === "entry" ? selected.index : 0}
              entry={entry}
              raw={raw}
              results={results}
              onShowResult={(callId) => void showResult(callId)}
            />
          ) : (
            <p className="mut">Select an entry. j and k move, r switches Rendered and Raw.</p>
          )}
        </section>
      </div>
    </>
  );
}

/** The transcript of a step, the run lead or one unassigned file. A step with several files lists them. */
export function Transcript({
  run,
  ticket,
  title,
  sessions,
  files,
  empty,
}: {
  run: string;
  ticket: string;
  title: string;
  sessions: SessionFile[];
  files: string[];
  empty: string;
}) {
  const [index, setIndex] = useState(0);
  const session = sessions[Math.min(index, sessions.length - 1)];
  return (
    <>
      <p className="crumb">
        <a href={runHref(run)}>← {ticket}</a> · transcript
      </p>
      <h1>{title}</h1>
      {!session ? (
        <p className="mut">{empty}</p>
      ) : (
        <>
          {sessions.length > 1 && (
            <p className="sub">
              {sessions.map((candidate, position) => (
                <button
                  key={candidate.file}
                  type="button"
                  className="btn"
                  aria-pressed={candidate === session}
                  data-testid="transcript-file"
                  data-file={candidate.file}
                  onClick={() => setIndex(position)}
                >
                  {candidate.harness} · {candidate.start ? <Clock time={candidate.start} /> : "?"}
                </button>
              ))}
            </p>
          )}
          <p className="meta">
            <span>
              <b>harness</b>
              {session.harness}
            </span>
            <span>
              <b>session</b>
              <span className="mono">{sessionName(session)}</span>
            </span>
            <span>
              <b>window</b>
              {session.start ? <Clock time={session.start} /> : "?"} → <Clock time={session.end} />
            </span>
          </p>
          <SessionPages key={session.file} run={run} session={session} files={files} />
        </>
      )}
    </>
  );
}

/** A run file's body: .md through Markdown, .json through Json, any other file through Code as plain text. Raw shows the source as written. */
export function FileBody({ run, path }: { run: string; path: string }) {
  const [state, setState] = useState<
    { status: "loading" | "missing" | "failed" } | { status: "ok"; text: string }
  >({
    status: "loading",
  });
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/run/${encodeURIComponent(run)}/file?path=${encodeURIComponent(path)}`, {
      signal: controller.signal,
    })
      .then(async (response) =>
        response.status === 404
          ? setState({ status: "missing" })
          : response.ok
            ? setState({ status: "ok", text: await response.text() })
            : setState({ status: "failed" }),
      )
      .catch(() => controller.signal.aborted || setState({ status: "failed" }));
    return () => controller.abort();
  }, [run, path]);
  return (
    <>
      {state.status === "loading" && <p className="mut">Reading…</p>}
      {state.status === "missing" && (
        <p className="mut" data-testid="file-missing">
          No such file in this run folder.
        </p>
      )}
      {state.status === "failed" && <p className="bad-text">The hub could not read this file.</p>}
      {state.status === "ok" && (
        <>
          {(path.endsWith(".md") || path.endsWith(".json")) && (
            <div className="view-bar">
              <ViewSwitch raw={raw} onChange={setRaw} />
            </div>
          )}
          {raw ? (
            <pre
              className="raw"
              tabIndex={0}
              aria-label={`${path}, source`}
              data-testid="run-file-text"
            >
              {state.text}
            </pre>
          ) : path.endsWith(".md") ? (
            <Markdown text={state.text} testId="run-file-text" />
          ) : path.endsWith(".json") ? (
            <Json text={state.text} />
          ) : (
            <Code code={state.text} />
          )}
        </>
      )}
    </>
  );
}

/** A run file on its own page. */
export function FileView({ run, ticket, path }: { run: string; ticket: string; path: string }) {
  return (
    <>
      <p className="crumb">
        <a href={runHref(run)}>← {ticket}</a> · run file
      </p>
      <h1 className="mono" style={{ fontSize: 18 }}>
        {path}
      </h1>
      <FileBody run={run} path={path} />
      <p className="note">Only files inside the run folder.</p>
    </>
  );
}
