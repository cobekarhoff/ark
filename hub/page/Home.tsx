// test ids: gate (data-gate), gate-link, run (data-run), agent (data-role), mr (data-state),
// ci (data-ci), cost, waiting (data-run, data-kind), run-age, stale-label (in the header, data-source)
import { Cost, Phase, Unknown, attentionOf, duration, known, type Attention } from "./format.tsx";
import { useAge, useLive } from "./store.tsx";
import type { Agent, Gate, MergeRequestView, RunView } from "../types.ts";

type Waiting = { run: RunView; item: Attention };

function NeedsMe({ gates, waiting }: { gates: Gate[] | "unknown"; waiting: Waiting[] }) {
  const count = known(gates) ? gates.length + waiting.length : null;
  return (
    <section aria-labelledby="needs-me" className={count === 0 ? "needs quiet" : "needs"}>
      <b id="needs-me">Needs me · {count ?? <Unknown />}</b>
      {count === 0 && <p className="mut">Nothing waits for you.</p>}
      {known(gates) && count! > 0 && (
        <table>
          <tbody>
            {gates.map((gate) => (
              <tr key={gate.id} data-testid="gate" data-gate={gate.id}>
                <td className="id nw">{gate.ticket}</td>
                <td className="wrap">{gate.question}</td>
                <td className="nw">
                  {gate.review_url ? (
                    <a
                      href={gate.review_url}
                      data-testid="gate-link"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Plannotator review ↗
                    </a>
                  ) : (
                    <span className="pill unk">no review</span>
                  )}
                </td>
              </tr>
            ))}
            {waiting.map(({ run, item }) => (
              <tr
                key={`${run.run}/${item.kind}/${item.step}/${item.reason}`}
                data-testid="waiting"
                data-run={run.run}
                data-kind={item.kind}
              >
                <td className="id nw">
                  <a href={`#/run/${encodeURIComponent(run.run)}`}>{run.ticket.id}</a>
                </td>
                <td className="wrap">
                  {item.step ? (
                    <>
                      Step <span className="mono">{item.step}</span>:{" "}
                    </>
                  ) : (
                    "Run: "
                  )}
                  {item.reason}
                </td>
                <td className="nw">
                  <span className="pill warn">{item.label}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** What Orca reports wins; the plan or `ark.yml` fills a gap and says so, and a difference shows both. */
function Field({
  reported,
  planned,
  source,
}: {
  reported: string | null;
  planned: string | undefined;
  source: "plan" | "configured";
}) {
  const label = source === "plan" ? "planned" : "configured";
  if (reported === null && planned === undefined)
    return (
      <span className="mut" title="Orca did not report it and no plan step names it">
        unknown
      </span>
    );
  if (reported === null)
    return (
      <>
        {planned} <span className="mut">({label})</span>
      </>
    );
  if (planned === undefined || planned === reported) return <>{reported}</>;
  return (
    <>
      {reported}{" "}
      <span className="mut">
        ({label} {planned})
      </span>
    </>
  );
}

function Agents({ agents }: { agents: Agent[] | "unknown" }) {
  if (!known(agents)) return <Unknown />;
  if (agents.length === 0) return <span className="mut">no live agent</span>;
  return agents.map((agent, index) => (
    <div key={index} data-testid="agent" data-role={agent.role}>
      <span className="pill">{agent.role}</span>{" "}
      <Field
        reported={agent.harness}
        planned={agent.planned?.harness}
        source={agent.planned?.source ?? "plan"}
      />{" "}
      ·{" "}
      <span className="mono">
        <Field
          reported={agent.model}
          planned={agent.planned?.model}
          source={agent.planned?.source ?? "plan"}
        />
      </span>
    </div>
  ));
}

const ciClass = { passing: "ok", failing: "bad", pending: "warn", unknown: "unk" } as const;

function MergeRequest({ request }: { request: MergeRequestView }) {
  return (
    <div data-testid="mr" data-state={request.state}>
      <a className="mono" href={request.url} target="_blank" rel="noreferrer">
        !{request.number}
      </a>{" "}
      <span data-testid="mr-state">{request.state}</span>{" "}
      <span className={`pill ${ciClass[request.ci]}`} data-testid="ci" data-ci={request.ci}>
        {request.ci}
      </span>
    </div>
  );
}

function Runs({ runs }: { runs: RunView[] }) {
  const age = useAge();
  return (
    <table>
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Title</th>
          <th>Phase</th>
          <th>Live agents (role · harness · model)</th>
          <th>MRs · CI</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.run} data-testid="run" data-run={run.run}>
            <td className="id nw">
              <a href={`#/run/${encodeURIComponent(run.run)}`}>{run.ticket.id}</a>
            </td>
            <td className="wrap">{run.ticket.title}</td>
            <td className="nw">
              <Phase phase={run.phase} />
              <div className="mut" data-testid="run-age">
                last event {duration(age(run.updated_at))} ago
              </div>
              {attentionOf(run, age)
                .filter((item) => item.kind === "idle")
                .slice(0, 1)
                .map((item) => (
                  <div className="mut" data-testid="run-idle" key={item.step}>
                    {item.label}
                  </div>
                ))}
            </td>
            <td className="wrap">
              <Agents agents={run.agents} />
            </td>
            <td className="nw">
              {run.merge_requests.length === 0 ? (
                <span className="mut">no MR</span>
              ) : (
                run.merge_requests.map((request) => (
                  <MergeRequest key={request.url} request={request} />
                ))
              )}
            </td>
            <td className="nw">
              <Cost usd={run.cost_usd} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Home() {
  const { snapshot } = useLive();
  const age = useAge();
  if (!snapshot)
    return (
      <>
        <h1>Home</h1>
        <p className="mut">
          <Unknown />
        </p>
      </>
    );
  const { runs, gates } = snapshot;
  const waiting = known(runs)
    ? runs.flatMap((run) =>
        // An idle step is a guess, not a gate: it shows in the run row and the DAG, never here.
        attentionOf(run, age)
          .filter((item) => item.kind === "waiting")
          .map((item) => ({ run, item })),
      )
    : [];
  return (
    <>
      <h1>Home</h1>
      <NeedsMe gates={gates} waiting={waiting} />
      <h2>Open runs · {known(runs) ? runs.length : <Unknown />}</h2>
      {!known(runs) ? (
        <Unknown />
      ) : runs.length === 0 ? (
        <p className="mut">No open runs.</p>
      ) : (
        <Runs runs={runs} />
      )}
    </>
  );
}
