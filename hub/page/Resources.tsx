import { useEffect, useState } from "react";
import { Unknown, known, duration } from "./format.tsx";
import { Stale, useLive } from "./store.tsx";
import { runHref } from "./RunDetail.tsx";
import { Field } from "./Agents.tsx";
import type { Agent, HostLevel, ResourceProcess, ResourcesHistory } from "../types.ts";

const refreshMilliseconds = 30_000;

/** The history route, read once and again every 30 s: it is not part of the snapshot. Null until the first answer. */
function useHistory(): ResourcesHistory | null {
  const [history, setHistory] = useState<ResourcesHistory | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      void fetch("/api/resources/history", { signal: controller.signal })
        .then(async (response) => (response.ok ? await response.json() : null))
        .then((value: ResourcesHistory | null) => {
          if (value !== null && !controller.signal.aborted) setHistory(value);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, refreshMilliseconds);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  return history;
}

const width = 120;
const height = 28;

/** A line from the first point to the last, from 0 to the largest value, with no axis: the figure beside it is the exact value. */
function Sparkline({ points, label }: { points: { ts: string; value: number }[]; label: string }) {
  if (points.length < 2)
    return (
      <span className="mut small" data-testid="sparkline-empty">
        no history yet
      </span>
    );
  const first = Date.parse(points[0]!.ts);
  const span = Math.max(1, Date.parse(points.at(-1)!.ts) - first);
  const top = Math.max(1, ...points.map((point) => point.value));
  const line = points
    .map(
      (point) =>
        `${(((Date.parse(point.ts) - first) / span) * width).toFixed(1)},${(height - (point.value / top) * (height - 2) - 1).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}, last 24 hours, ${points.length} points`}
      data-testid="sparkline"
    >
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

const levelWords: Record<HostLevel, string> = {
  normal: "normal",
  amber: "amber",
  red: "red",
  unchecked: "unchecked",
};

const megabytes = (value: number) => `${value} MB`;
const percent = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 10) / 10}%`;

function ageText(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  return days >= 1 ? `${days}\u00a0d` : duration(seconds * 1000);
}

function CopyKill({ pid }: { pid: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      data-testid="copy-kill"
      onClick={() => {
        // The hub only shows the command: nothing here changes a process.
        void navigator.clipboard.writeText(`kill ${pid}`).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : `Copy kill ${pid}`}
    </button>
  );
}

function ProcessRows({ processes }: { processes: ResourceProcess[] }) {
  return processes.map((process) => (
    <tr key={process.pid} data-testid="process" data-pid={process.pid} data-kind={process.kind}>
      <td className="mono">{process.kind}</td>
      <td className="mono mut">{process.pid}</td>
      <td className="mono wrap">{process.command}</td>
      <td className="mono num">{percent(process.cpu_percent)}</td>
      <td className="mono num">{megabytes(process.memory_mb)}</td>
    </tr>
  ));
}

function ProcessTable({ processes }: { processes: ResourceProcess[] }) {
  return processes.length === 0 ? (
    <p className="mut small">no processes</p>
  ) : (
    <table className="res-table">
      <thead>
        <tr>
          <th>Kind</th>
          <th>pid</th>
          <th>Command</th>
          <th className="num">CPU</th>
          <th className="num">Memory</th>
        </tr>
      </thead>
      <tbody>
        <ProcessRows processes={processes} />
      </tbody>
    </table>
  );
}

const sum = (processes: ResourceProcess[], field: "memory_mb" | "cpu_percent") =>
  processes.reduce((total, process) => total + (process[field] ?? 0), 0);

export function Resources() {
  const { snapshot } = useLive();
  const history = useHistory();
  if (!snapshot) return <p className="mut">Connecting…</p>;
  const { resources } = snapshot;
  if (!known(resources))
    return (
      <>
        <h1>Resources</h1>
        <Unknown />
        <Stale name="resources" />
      </>
    );
  const runs = known(snapshot.runs) ? snapshot.runs : [];
  // A handle that Orca lists for more than one run (Master Chief) is shown once, under the first.
  const shown = new Set<string>();
  const leftovers = resources.processes.filter((process) => process.owner.kind === "leftover");
  const others = resources.processes.filter((process) => process.owner.kind === "other");
  const signals = [
    ["cpu", "CPU", resources.host.cpu.level],
    ["pressure", "Memory pressure", resources.host.pressure.level],
    ["swap", "Swap used", resources.host.swap.level],
    ["disk", "Disk free", resources.host.disk.level],
    ["load", "Load (5 min)", resources.host.load.level],
  ] as const;
  return (
    <>
      <h1>
        Resources <Stale name="resources" />
      </h1>
      {resources.degraded ? (
        <p className="amber small" role="status">
          lsof failed: only the Orca handle and the ark test admission give a process an owner.
        </p>
      ) : null}
      <section className="res-signals" aria-label="Host signals, last 24 hours">
        {signals.map(([key, label, level]) => (
          <div key={key} className={`sig lv ${level} res-signal`} data-testid={`signal-${key}`}>
            <span className="mark" aria-hidden="true" />
            <span className="k">{label}</span>
            <span className="tag">{levelWords[level]}</span>
            {history === null ? null : <Sparkline points={history[key]} label={label} />}
          </div>
        ))}
      </section>

      <h2>Open runs</h2>
      {runs.length === 0 ? <p className="mut">no open run</p> : null}
      {runs.map((run) => {
        const agents: Agent[] = known(run.agents) ? run.agents : [];
        const own = resources.processes.filter(
          (process) =>
            (process.owner.kind === "run" || process.owner.kind === "admission") &&
            process.owner.run === run.run,
        );
        return (
          <section
            key={run.run}
            className="panel res-run"
            data-testid="resource-run"
            data-run={run.run}
          >
            <header>
              <h2>
                <a href={runHref(run.run)} className="mono">
                  {run.run}
                </a>
              </h2>
              <span className="hint">{run.ticket.id}</span>
            </header>
            <div className="body">
              {agents.map((agent, index) => {
                const handle = agent.terminal;
                const first = handle !== null && !shown.has(handle);
                if (handle !== null) shown.add(handle);
                const processes = first
                  ? resources.processes.filter(
                      (process) =>
                        process.owner.kind === "agent" && process.owner.handle === handle,
                    )
                  : [];
                return (
                  <div
                    key={index}
                    className="res-agent"
                    data-testid="resource-agent"
                    data-handle={handle ?? ""}
                  >
                    <div>
                      <span className="pill">{agent.role}</span>
                      {agent.step ? <span className="mono"> {agent.step}</span> : null}{" "}
                      <span className="mut small">
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
                        {agent.presence === "ended" ? " · ended" : ""}
                      </span>
                      <span className="mono small mut">
                        {" "}
                        · {megabytes(sum(processes, "memory_mb"))} ·{" "}
                        {percent(sum(processes, "cpu_percent"))}
                      </span>
                    </div>
                    <ProcessTable processes={processes} />
                  </div>
                );
              })}
              {own.length > 0 ? (
                <div className="res-agent" data-testid="resource-run-processes">
                  <div className="mut small">
                    Run processes (in the run folder, or held by ark test)
                  </div>
                  <ProcessTable processes={own} />
                </div>
              ) : null}
            </div>
          </section>
        );
      })}

      <h2>Leftover from closed runs</h2>
      <section className="panel" data-testid="leftover">
        {leftovers.length === 0 ? (
          <p className="mut body">none</p>
        ) : (
          <table className="res-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Age</th>
                <th>Command</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {leftovers.map((process) => (
                <tr key={process.pid} data-testid="leftover-row" data-pid={process.pid}>
                  <td className="mono">
                    {process.owner.kind === "leftover" ? process.owner.run : ""}
                  </td>
                  <td className="mono nw">{ageText(process.age_seconds)}</td>
                  <td className="mono wrap">{process.command}</td>
                  <td>
                    <CopyKill pid={process.pid} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <h2>Other</h2>
      <section className="panel" data-testid="other">
        {others.length === 0 ? (
          <p className="mut body">none</p>
        ) : (
          <ProcessTable
            processes={others.toSorted((left, right) => right.memory_mb - left.memory_mb)}
          />
        )}
      </section>
    </>
  );
}
