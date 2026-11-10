import { useEffect, useState } from "react";
import { Markdown } from "./Markdown.tsx";
import { ticketHref } from "./store.tsx";
import type {
  AcEvidence,
  CaseRef,
  CommandRun,
  EvidenceSection,
  PlanCaseEvidence,
  RunTestEvidence,
  SideEvidence,
  TestCaseRecord,
  TicketCases,
  TicketCriterionView,
} from "../types.ts";

type Read<T> = { status: "loading" | "failed" } | { status: "ok"; value: T };

/** One read of `url` per `key`: the page asks again only when the key changes. */
function useRead<T>(url: string, key: string, enabled = true): Read<T> {
  const [state, setState] = useState<{ key: string; read: Read<T> }>({
    key,
    read: { status: "loading" },
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal })
      .then(async (response): Promise<Read<T>> =>
        response.ok ? { status: "ok", value: await response.json() } : { status: "failed" },
      )
      .catch((): Read<T> => ({ status: "failed" }))
      .then((read) => {
        if (!controller.signal.aborted) setState({ key, read });
      });
    return () => controller.abort();
    // The key stands for the url: it is the only input that may start a new read.
  }, [key]);
  return state.key === key ? state.read : { status: "loading" };
}

const resultClass = (result: string) =>
  result === "active" || result === "pass" ? "ok" : result === "fail" ? "bad" : "unk";

const imageUrl = (run: string, path: string) =>
  `/api/run/${encodeURIComponent(run)}/image?path=${encodeURIComponent(path)}`;

/** A case in the ticket page: its link opens the case and the tickets and ACs it verifies. A missing case is text, never a link. */
function CaseEntry({
  record,
  open,
  onToggle,
  ticket,
}: {
  record: TestCaseRecord;
  open: boolean;
  onToggle: () => void;
  ticket: string;
}) {
  if (record.missing)
    return (
      <li data-testid="case-entry" data-id={record.id} data-state="missing">
        <span className="case-chip missing" data-testid="case-missing">
          <span className="mono">{record.id}</span>
          <span className="pill bad">missing</span>
        </span>
      </li>
    );
  const status = record.status ?? "";
  const refs = record.verifies ?? [];
  return (
    <li data-testid="case-entry" data-id={record.id} data-state={status}>
      <a
        className="case-chip"
        href={ticketHref(ticket)}
        data-testid="case-link"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          onToggle();
        }}
      >
        <span className="mono">{record.id}</span>
        {record.level ? <span className="lv">{record.level}</span> : null}
        <span className={`pill ${resultClass(status)}`}>{status}</span>
      </a>
      {record.reason ? <span className="case-also">reason: {record.reason}</span> : null}
      {open ? (
        <div className="case-open">
          <dl>
            <dt>Title</dt>
            <dd>{record.title ?? record.name}</dd>
            {record.technique ? (
              <>
                <dt>Technique</dt>
                <dd>{record.technique}</dd>
              </>
            ) : null}
            {record.priority ? (
              <>
                <dt>Priority</dt>
                <dd>{record.priority}</dd>
              </>
            ) : null}
            {record.risk ? (
              <>
                <dt>Risk</dt>
                <dd>{record.risk}</dd>
              </>
            ) : null}
            {record.changed_by ? (
              <>
                <dt>Changed by</dt>
                <dd className="mono">{record.changed_by}</dd>
              </>
            ) : null}
            {record.sha ? (
              <>
                <dt>Commit</dt>
                <dd className="mono">{record.sha}</dd>
              </>
            ) : null}
            {record.version !== undefined ? (
              <>
                <dt>Version</dt>
                <dd>{record.version}</dd>
              </>
            ) : null}
            {record.versions && record.versions.length > 0 ? (
              <>
                <dt>Versions</dt>
                <dd>
                  {record.versions.map((version) => (
                    <span key={version.commit} className="mono small case-version">
                      {version.commit} {version.changed_by || "no changed_by"}
                    </span>
                  ))}
                </dd>
              </>
            ) : null}
          </dl>
          <p className="small mut">Verifies</p>
          <ul
            className="case-listing"
            data-testid="case-listing"
            aria-label={`ACs that ${record.id} verifies`}
          >
            {refs.map((ref) => (
              <li key={`${ref.ticket}/${ref.criterion}`} data-testid="case-listing-ref">
                <a className="mono" href={ticketHref(ref.ticket)}>
                  {ref.ticket}
                </a>{" "}
                <span className="mono">{ref.criterion}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The acceptance criteria of a ticket: id, method, one entry for each `verified_by` case (read once
 * on request) and a warning on a `method: test` criterion that has no integration or E2E case.
 */
export function Criteria({
  project,
  ticket,
  criteria,
  raw = false,
}: {
  project: string;
  ticket: string;
  criteria: TicketCriterionView[];
  raw?: boolean;
}) {
  const read = useRead<TicketCases>(
    `/api/ticket/${encodeURIComponent(project)}/${encodeURIComponent(ticket)}/cases`,
    `${project}/${ticket}`,
    // A ticket that names no test case needs no read.
    criteria.some((criterion) => criterion.verified_by.length > 0),
  );
  const [opened, setOpened] = useState<string | null>(null);
  const records = new Map(
    read.status === "ok" ? read.value.cases.map((record) => [record.id, record]) : [],
  );
  return (
    <ol className="criteria crit-list">
      {criteria.map((criterion) => {
        const listed = criterion.verified_by.map((id) => records.get(id));
        // A case of a source that records no level (zephyr) is unknown, not weak: only known unit cases warn.
        const strong = listed.some(
          (record) => record && !record.missing && record.level !== "unit" && record.level !== "",
        );
        const warn =
          criterion.method === "test" &&
          !strong &&
          (criterion.verified_by.length === 0 || read.status === "ok");
        return (
          <li
            key={criterion.id}
            className={warn ? "flag" : undefined}
            data-testid="ticket-criterion"
            data-id={criterion.id}
          >
            <div className="crit-head">
              <span className="mono strong">{criterion.id}</span>
              <span className="pill" data-testid="criterion-method">
                method: {criterion.method}
              </span>
            </div>
            <Markdown text={criterion.text} raw={raw} />
            {criterion.verified_by.length > 0 ? (
              <ul className="case-list" aria-label={`Test cases of ${criterion.id}`}>
                {criterion.verified_by.map((id) => {
                  const record = records.get(id);
                  const key = `${criterion.id}/${id}`;
                  return record ? (
                    <CaseEntry
                      key={id}
                      record={record}
                      ticket={ticket}
                      open={opened === key}
                      onToggle={() => setOpened(opened === key ? null : key)}
                    />
                  ) : (
                    <li key={id} data-testid="case-entry" data-id={id} data-state="unread">
                      <span className="mono">{id}</span>{" "}
                      <span className="mut small">
                        {read.status === "failed" ? "unreadable" : "reading…"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : criterion.method === "test" ? null : (
              <p className="crit-none">
                Proof is an evidence file, not a test case. It shows on the run page.
              </p>
            )}
            {warn ? (
              <p className="warn-box" role="note" data-testid="criterion-warning">
                <strong>Warning</strong> No integration or E2E case. This{" "}
                <span className="mono">method: test</span> criterion has{" "}
                {criterion.verified_by.length === 0 ? "no test case" : "only unit or missing cases"}
                .
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function SideCell({ side, name }: { side: SideEvidence; name: "base" | "head" }) {
  return (
    <td data-testid="evidence-side" data-side={name} data-result={side.result}>
      <span className={`pill ${resultClass(side.result)}`}>{side.result}</span>
      <br />
      <span className="mono small mut">{side.sha ?? "no commit"}</span>
    </td>
  );
}

function Log({ name, runs }: { name: "base" | "head"; runs: CommandRun[] }) {
  return (
    <div className="ev-run">
      <strong className="small">{name}</strong>
      {runs.map((run, index) => (
        <div key={index}>
          <pre className="term" tabIndex={0} aria-label={`${name} command and output`}>
            {`$ ${run.command}${run.output === "" ? "" : `\n${run.output}`}`}
          </pre>
          <span className={`pill ${run.exit === 0 ? "ok" : "bad"}`}>
            exit {run.exit ?? "unknown"}
          </span>
        </div>
      ))}
    </div>
  );
}

function AcLinks({ refs }: { refs: CaseRef[] }) {
  if (refs.length === 0) return <span className="mut">no AC</span>;
  return (
    <ul className="ev-acs">
      {refs.map((ref) => (
        <li key={`${ref.ticket}/${ref.criterion}`}>
          <a href={ticketHref(ref.ticket)}>{ref.ticket}</a>/
          <a href={ticketHref(ref.ticket)}>{ref.criterion}</a>
        </li>
      ))}
    </ul>
  );
}

function CaseRow({ entry, first }: { entry: PlanCaseEvidence; first: boolean }) {
  const logs = (["base", "head"] as const).filter((side) => entry[side].runs.length > 0);
  return (
    <tr data-testid="evidence-case" data-id={entry.id}>
      <td>
        <span className="mono strong">{entry.id}</span>
        {logs.length > 0 && first ? (
          <details data-testid="evidence-log">
            <summary>Suite output: command, output, exit code</summary>
            {logs.map((side) => (
              <Log key={side} name={side} runs={entry[side].runs} />
            ))}
          </details>
        ) : null}
      </td>
      <td>
        <span className="pill">{entry.action}</span>
      </td>
      <td>{entry.level}</td>
      <SideCell side={entry.base} name="base" />
      <SideCell side={entry.head} name="head" />
      <td>
        <AcLinks refs={entry.verifies} />
      </td>
    </tr>
  );
}

function Shot({
  run,
  label,
  side,
  path,
}: {
  run: string;
  label: string;
  side: "before" | "after";
  path: string | null;
}) {
  return (
    <figure>
      <figcaption className="small mut">{side}</figcaption>
      {path === null ? (
        <div className="noimg warn-box" role="note" data-testid="shot-missing">
          no {side} screenshot
        </div>
      ) : (
        <a href={imageUrl(run, path)} target="_blank" rel="noreferrer">
          <img
            src={imageUrl(run, path)}
            alt={`${label} ${side}`}
            data-testid="shot-image"
            data-side={side}
            decoding="async"
          />
        </a>
      )}
    </figure>
  );
}

function Shots({ run, cases }: { run: string; cases: PlanCaseEvidence[] }) {
  const withShots = cases.filter((entry) => entry.checkpoints.length > 0);
  if (withShots.length === 0) return null;
  return (
    <section className="panel" aria-labelledby="ev-shots-h" data-testid="screenshots-panel">
      <header>
        <h2 id="ev-shots-h">Before and after screenshots</h2>
        <span className="count">
          {withShots.reduce((sum, entry) => sum + entry.checkpoints.length, 0)}
        </span>
      </header>
      <div className="shots">
        {withShots.map((entry, caseIndex) => (
          <div key={entry.id}>
            <h3 className="case-h">
              <span className="mono strong">{entry.id}</span>{" "}
              <span className="mut small">
                {entry.level} · {entry.checkpoints.length}{" "}
                {entry.checkpoints.length === 1 ? "checkpoint" : "checkpoints"}
              </span>
            </h3>
            {entry.checkpoints.map((checkpoint, index) => {
              const label = `${entry.id} ${checkpoint.name}`;
              const heading = `cp-${caseIndex}-${index}`;
              return (
                <section
                  key={checkpoint.name}
                  className="pair"
                  aria-labelledby={heading}
                  data-testid="shot-pair"
                  data-name={checkpoint.name}
                >
                  <h4 id={heading} className="mono small">
                    {checkpoint.name}
                  </h4>
                  <div className="pair-grid">
                    <Shot run={run} label={label} side="before" path={checkpoint.before} />
                    <Shot run={run} label={label} side="after" path={checkpoint.after} />
                  </div>
                </section>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

function Section({
  run,
  ac,
  section,
  depth,
}: {
  run: string;
  ac: string;
  section: EvidenceSection;
  depth: number;
}) {
  const Heading = `h${Math.min(depth, 6)}` as "h4";
  return (
    <section className="ev-section" data-testid="evidence-section" data-title={section.title}>
      {section.title === "" ? null : <Heading>{section.title}</Heading>}
      {section.text === "" ? null : <Markdown text={section.text} />}
      {section.images.map((path) => (
        <figure key={path} className="ev-shot">
          <a href={imageUrl(run, path)} target="_blank" rel="noreferrer">
            <img
              src={imageUrl(run, path)}
              alt={`${ac} ${section.title}`}
              data-testid="shot-image"
              decoding="async"
            />
          </a>
        </figure>
      ))}
      {section.children.map((child, index) => (
        <Section key={index} run={run} ac={ac} section={child} depth={depth + 1} />
      ))}
    </section>
  );
}

function AcBlock({ run, entry }: { run: string; entry: AcEvidence }) {
  return (
    <article className="ev" data-testid="ac-evidence" data-id={entry.id} data-method={entry.method}>
      <h3 className="ev-head">
        <span className="mono strong">{entry.id}</span>
        <span className="pill">method: {entry.method}</span>
      </h3>
      {entry.sections === null ? (
        <>
          <p className="warn-box" role="note" data-testid="no-evidence">
            no evidence
          </p>
          <p className="small mut">
            <span className="mono">results/evidence/{entry.id}.md</span> is missing or has the wrong
            shape for its method.
          </p>
        </>
      ) : (
        entry.sections.map((section, index) => (
          <Section key={index} run={run} ac={entry.id} section={section} depth={4} />
        ))
      )}
    </article>
  );
}

/**
 * The test evidence of a run, read once on request (again when the run's phase changes): a row for
 * each plan test case with base and head, the screenshot pairs, and the evidence file of each AC
 * that no test proves.
 */
export function TestEvidence({ run, phase }: { run: string; phase: string }) {
  const read = useRead<RunTestEvidence>(
    `/api/run/${encodeURIComponent(run)}/evidence`,
    `${run}|${phase}`,
  );
  if (read.status !== "ok")
    return (
      <section className="panel" aria-labelledby="ev-table-h">
        <header>
          <h2 id="ev-table-h">Test evidence</h2>
        </header>
        <div className="body">
          <p className={read.status === "failed" ? "bad-text" : "mut"}>
            {read.status === "failed" ? "The hub could not read the test evidence." : "Reading…"}
          </p>
        </div>
      </section>
    );
  const { cases, criteria } = read.value;
  return (
    <div className="ev-stack" data-testid="evidence-panel">
      <section className="panel" aria-labelledby="ev-table-h">
        <header>
          <h2 id="ev-table-h">Test evidence</h2>
          <span className="count">{cases.length}</span>
          <span className="hint">base and head, one row per plan case</span>
        </header>
        <div className="body ev-scroll">
          {cases.length === 0 ? (
            <p className="mut">The plan has no test case.</p>
          ) : (
            <table className="ev-table">
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">Plan action</th>
                  <th scope="col">Level</th>
                  <th scope="col">Base</th>
                  <th scope="col">Head</th>
                  <th scope="col">ACs</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((entry, index) => (
                  <CaseRow
                    key={entry.id}
                    entry={entry}
                    first={
                      cases.findIndex(
                        (other) =>
                          JSON.stringify([other.base.runs, other.head.runs]) ===
                          JSON.stringify([entry.base.runs, entry.head.runs]),
                      ) === index
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      <Shots run={run} cases={cases} />
      {criteria.length > 0 ? (
        <section className="panel" aria-labelledby="ev-other-h">
          <header>
            <h2 id="ev-other-h">Evidence of other criteria</h2>
            <span className="count">{criteria.length}</span>
            <span className="hint">demonstration, inspection, analysis</span>
          </header>
          <div>
            {criteria.map((entry) => (
              <AcBlock key={entry.id} run={run} entry={entry} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
