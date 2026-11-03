// test ids: gate (data-gate), gate-link, run (data-run), agent (data-role), mr (data-state),
// ci (data-ci), cost, stale-label (in the header, data-source)
import { Cost, Phase, Unknown, known } from "./format.tsx";
import { useLive } from "./store.tsx";
import type { Agent, Gate, MergeRequestView, RunView } from "../types.ts";

function NeedsMe({ gates }: { gates: Gate[] | "unknown" }) {
  return (
    <section
      aria-labelledby="needs-me"
      className={known(gates) && gates.length === 0 ? "needs quiet" : "needs"}
    >
      <b id="needs-me">Needs me · {known(gates) ? gates.length : <Unknown />}</b>
      {known(gates) && gates.length === 0 && <p className="mut">Nothing waits for you.</p>}
      {known(gates) && gates.length > 0 && (
        <table>
          <tbody>
            {gates.map((gate) => (
              <tr key={gate.id} data-testid="gate" data-gate={gate.id}>
                <td className="id">{gate.ticket}</td>
                <td>{gate.question}</td>
                <td>
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
          </tbody>
        </table>
      )}
    </section>
  );
}

function Agents({ agents }: { agents: Agent[] | "unknown" }) {
  if (!known(agents)) return <Unknown />;
  if (agents.length === 0) return <span className="mut">no live agent</span>;
  return agents.map((agent, index) => (
    <div key={index} data-testid="agent" data-role={agent.role}>
      <span className="pill">{agent.role}</span> {agent.harness ?? "unknown"} ·{" "}
      <span className="mono">{agent.model ?? "unknown"}</span>
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
            <td className="id">
              <a href={`#/run/${encodeURIComponent(run.run)}`}>{run.ticket.id}</a>
            </td>
            <td>{run.ticket.title}</td>
            <td>
              <Phase phase={run.phase} />
            </td>
            <td>
              <Agents agents={run.agents} />
            </td>
            <td>
              {run.merge_requests.length === 0 ? (
                <span className="mut">no MR</span>
              ) : (
                run.merge_requests.map((request) => (
                  <MergeRequest key={request.url} request={request} />
                ))
              )}
            </td>
            <td>
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
  return (
    <>
      <h1>Home</h1>
      <NeedsMe gates={gates} />
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
