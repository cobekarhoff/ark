import { Unknown, known } from "./format.tsx";
import { OpenInOrca } from "./OrcaButton.tsx";
import type { Agent } from "../types.ts";

/** What Orca or a session reports wins; the plan or `ark.yml` fills a gap and says so. */
function Field({
  reported,
  planned,
  source,
}: {
  reported: string | null;
  planned: string | undefined;
  source: "plan" | "configured";
}) {
  if (reported !== null) return <>{reported}</>;
  if (planned === undefined)
    return (
      <span className="mut" title="Orca did not report it and no plan step names it">
        unknown
      </span>
    );
  return (
    <>
      {planned} <span className="mut">({source === "plan" ? "planned" : "configured"})</span>
    </>
  );
}

export function Agents({ agents }: { agents: Agent[] | "unknown" }) {
  if (!known(agents)) return <Unknown />;
  if (agents.length === 0) return <span className="mut">no live agent</span>;
  return agents.map((agent, index) => (
    <div
      key={index}
      className="agentrow"
      data-testid="agent"
      data-role={agent.role}
      data-live={agent.live}
    >
      <div className="agent-main">
        <span className="pill">{agent.role}</span>
        {agent.step ? <span className="mono"> {agent.step}</span> : null}
        <div className="small agent-meta">
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
          </span>{" "}
          <span className="mut" data-testid="agent-activity" data-kind={agent.activity.kind}>
            · {agent.activity.text}
          </span>
        </div>
      </div>
      <OpenInOrca agent={agent} />
    </div>
  ));
}
