// test ids: transcript, transcript-entry (data-kind), transcript-tool (data-status), tool-result,
// thinking, load-more, transcript-file (data-file), run-file-text
import { useEffect, useState } from "react";
import { Clock, runHref, sessionName } from "./RunDetail.tsx";
import type { SessionFile, TranscriptEntry, TranscriptPage } from "../types.ts";

type Pages =
  | { status: "loading"; entries: TranscriptEntry[]; next: number | null }
  | { status: "ok" | "more"; entries: TranscriptEntry[]; next: number | null }
  | { status: "failed"; entries: TranscriptEntry[]; next: number | null; reason: string };

function Entry({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "thinking")
    return (
      <details className="think" data-testid="thinking">
        <summary>
          thinking · {entry.text.split("\n").length} lines{" "}
          {entry.time && (
            <span className="mono">
              <Clock time={entry.time} />
            </span>
          )}
        </summary>
        <p>{entry.text}</p>
      </details>
    );
  if (entry.kind === "tool")
    return (
      <div
        className={entry.status === "error" ? "tool err" : "tool"}
        data-testid="transcript-tool"
        data-status={entry.status}
      >
        <div className="head">
          <span className="name">{entry.name}</span>
          <span className="args">{entry.args}</span>
          <span
            className={`pill ${entry.status === "ok" ? "ok" : entry.status === "error" ? "bad" : "unk"}`}
          >
            {entry.status === "unknown" ? "no result" : entry.status}
          </span>
          {entry.time && (
            <span className="mono mut">
              <Clock time={entry.time} />
            </span>
          )}
        </div>
        {entry.result !== "" && (
          <div className="res" data-testid="tool-result">
            {entry.result}
          </div>
        )}
      </div>
    );
  return (
    <article className={entry.role === "user" ? "msg user" : "msg"}>
      <header>
        <span className="role">{entry.role}</span>
        {entry.time && (
          <span className="mono">
            <Clock time={entry.time} />
          </span>
        )}
      </header>
      <p>{entry.text}</p>
    </article>
  );
}

/** One session file, 200 entries a page: the server reads each page in the usage worker thread. */
function SessionPages({ run, session }: { run: string; session: SessionFile }) {
  const [pages, setPages] = useState<Pages>({ status: "loading", entries: [], next: null });
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
  return (
    <>
      <div className="msgs" aria-label="Transcript" data-testid="transcript">
        {pages.entries.map((entry, index) => (
          <div key={index} data-testid="transcript-entry" data-kind={entry.kind}>
            <Entry entry={entry} />
          </div>
        ))}
      </div>
      {pages.status === "failed" && (
        <p className="bad-text" role="alert">
          Could not read this file: {pages.reason}.
        </p>
      )}
      {pages.status === "loading" && <p className="mut">Reading…</p>}
      {pages.status !== "loading" && pages.entries.length === 0 && pages.status !== "failed" && (
        <p className="mut">This file holds no message yet.</p>
      )}
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
            : `Showing ${pages.entries.length} entries · 200 per page`}
          . Result lines are cut to the first line; the full result never reaches this page.
        </span>
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
  empty,
}: {
  run: string;
  ticket: string;
  title: string;
  sessions: SessionFile[];
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
          <SessionPages key={session.file} run={run} session={session} />
        </>
      )}
    </>
  );
}

/** A run file as plain text: React escapes it, so nothing in it is markup. */
export function FileView({ run, ticket, path }: { run: string; ticket: string; path: string }) {
  const [state, setState] = useState<
    { status: "loading" | "missing" | "failed" } | { status: "ok"; text: string }
  >({
    status: "loading",
  });
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
      <p className="crumb">
        <a href={runHref(run)}>← {ticket}</a> · run file
      </p>
      <h1 className="mono" style={{ fontSize: 18 }}>
        {path}
      </h1>
      {state.status === "loading" && <p className="mut">Reading…</p>}
      {state.status === "missing" && (
        <p className="mut" data-testid="file-missing">
          No such file in this run folder.
        </p>
      )}
      {state.status === "failed" && <p className="bad-text">The hub could not read this file.</p>}
      {state.status === "ok" && (
        <pre
          className="file"
          tabIndex={0}
          aria-label={`${path}, plain text`}
          data-testid="run-file-text"
        >
          {state.text}
        </pre>
      )}
      <p className="note">Plain text, no Markdown render. Only files inside the run folder.</p>
    </>
  );
}
