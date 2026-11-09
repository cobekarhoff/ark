import { useEffect, useState } from "react";
import { ExternalLink } from "./format.tsx";
import { hashOf } from "./store.tsx";
import type { RunDetail, SessionFile, TimelineEntry } from "../types.ts";

export type DetailState =
  | { status: "loading" | "missing" | "failed" }
  | { status: "ok"; detail: RunDetail };

/**
 * Reads one run on request (`GET /api/run/<run>`): any run, open or closed, is never in the snapshot.
 * The last answer for the same run stays on screen while a newer one loads. `refreshKey` changes when
 * the run logged a new event, so the timeline and session list follow the live run.
 */
export function useRunDetail(run: string | null, refreshKey: string): DetailState {
  const [state, setState] = useState<{ run: string | null; value: DetailState }>({
    run,
    value: { status: "loading" },
  });
  useEffect(() => {
    if (run === null) return;
    const controller = new AbortController();
    void fetch(`/api/run/${encodeURIComponent(run)}`, { signal: controller.signal })
      .then(async (response): Promise<DetailState> => {
        if (response.status === 404) return { status: "missing" };
        if (!response.ok) return { status: "failed" };
        return { status: "ok", detail: await response.json() };
      })
      .catch((): DetailState => ({ status: "failed" }))
      .then((value) => {
        if (!controller.signal.aborted) setState({ run, value });
      });
    return () => controller.abort();
  }, [run, refreshKey]);
  return state.run === run ? state.value : { status: "loading" };
}

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" });

/** `10:44`, with the day when it is not today. */
export function Clock({ time }: { time: string }) {
  const date = new Date(time);
  const today = day.format(date) === day.format(new Date());
  return (
    <time dateTime={time} title={time}>
      {today ? "" : `${day.format(date)} `}
      {clock.format(date)}
    </time>
  );
}

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return <p className="mut">No decisions recorded yet.</p>;
  return (
    <ol className="tl" aria-label="Decisions timeline" data-testid="timeline">
      {entries.map((entry, index) => (
        <li key={index} data-testid="timeline-entry" data-type={entry.type}>
          <Clock time={entry.time} />
          <span className="kind">{entry.type}</span>
          <span className="why">
            {entry.counts && (
              <span data-testid="timeline-counts">
                <span className="pill bad">{entry.counts.fail} fail</span>{" "}
                <span className="pill ok">{entry.counts.pass} pass</span>
                {entry.counts.missing > 0 && <> {entry.counts.missing} missing</>}
                {entry.counts.notRun > 0 && <> {entry.counts.notRun} not run</>}{" "}
              </span>
            )}
            {entry.url ? <ExternalLink url={entry.url}>{entry.why}</ExternalLink> : entry.why}
          </span>
        </li>
      ))}
    </ol>
  );
}

export const runHref = (run: string, ...parts: string[]) =>
  hashOf(`#/run/${[run, ...parts].map(encodeURIComponent).join("/")}`);

export function RunFiles({ run, files }: { run: string; files: string[] }) {
  if (files.length === 0)
    return <p className="mut">No plan, strategy, retro or result file yet.</p>;
  return (
    <ul className="files">
      {files.map((path) => (
        <li key={path}>
          <a
            href={runHref(run, "file", path)}
            className="mono"
            data-testid="run-file-link"
            data-path={path}
          >
            {path}
          </a>
          <span className="mut">text</span>
        </li>
      ))}
    </ul>
  );
}

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1 << 20
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1 << 20)).toFixed(1)} MB`;

/** `omp/<name>`: the harness and the file name, so a list of files stays readable. */
export const sessionName = (session: SessionFile) =>
  `${session.harness}/${session.file.split("/").at(-1)}`;

/**
 * The run lead's file and every file under the run folder that no step or lead rule claimed. They
 * are listed, so no transcript hides behind the start-time rule.
 */
export function SessionLists({
  run,
  sessions,
  ready,
}: {
  run: string;
  sessions: SessionFile[];
  ready: boolean;
}) {
  const lead = sessions.find((session) => session.owner.kind === "lead");
  const unassigned = sessions.filter((session) => session.owner.kind === "unassigned");
  return (
    <>
      <h2>Run lead</h2>
      {lead ? (
        <p>
          <a href={runHref(run, "lead")} data-testid="run-lead-link">
            Transcript
          </a>{" "}
          <span className="mut mono">{sessionName(lead)}</span>
        </p>
      ) : (
        <p className="mut">
          {ready ? "No session file maps to the run lead." : "Session files not read yet."}
        </p>
      )}
      <h2>Unassigned session files · {ready ? unassigned.length : "?"}</h2>
      <ul className="files">
        {unassigned.map((session) => (
          <li key={session.file} data-testid="unassigned-file" data-file={session.file}>
            <a href={runHref(run, "session", session.file)} className="mono">
              {sessionName(session)}
            </a>
            <span className="mut mono">
              {session.start ? <Clock time={session.start} /> : "no start time"} ·{" "}
              {size(session.size)}
            </span>
          </li>
        ))}
      </ul>
      <p className="note">
        Sessions under the run folder that match no step window and are not the run lead. Shown so
        no transcript hides.
      </p>
    </>
  );
}
