import { useEffect, useState } from "react";
import type { MapGraph, MapNode } from "../cli/hub/map.ts";
import type { Action, Item } from "../cli/hub/types.ts";
import { agentKey, type HubState, type Selection } from "./model.ts";
import { Kbd, stateTone, ViewBar, clock, type View } from "./views.tsx";

const column = { project: 0, chief: 1, run: 2, step: 3, agent: 4, mr: 4 };
const columnTitles = ["Project", "Master Chief", "Runs", "Steps", "Agents · CI"];
const nodeWidth = 170;
const nodeHeight = 50;
const columnGap = 192;
const rowGap = 64;

const nodeTone = (node: MapNode) =>
  node.kind === "mr" && node.state === "pending" ? "waiting" : stateTone(node.state);

/** The run or project an item or node id belongs to: `gate:<run>:<gate>`, `run:<run>`, `ticket:<project>:<id>`. */
const ownerOf = (id: string) => id.split(":")[1] ?? "";

/** Every node above and below `id` along the edges: the path the Map lights. */
function pathOf(id: string, edges: [string, string][]): Set<string> {
  const lit = new Set([id]);
  for (const direction of [0, 1]) {
    const queue = [id];
    for (let next = queue.pop(); next !== undefined; next = queue.pop())
      for (const edge of edges)
        if (edge[1 - direction] === next && !lit.has(edge[direction])) {
          lit.add(edge[direction]);
          queue.push(edge[direction]);
        }
  }
  return lit;
}

/** The Needs-me items a node carries, mirroring the needs-you count of the API. */
const itemsOf = (node: MapNode, needs: Item[]) =>
  needs.filter((item) => {
    const kind = item.id.split(":")[0];
    if (node.kind === "agent") return item.id === node.id;
    if (node.kind === "run")
      return (
        ["gate", "mr", "retro", "agent"].includes(kind) && ownerOf(item.id) === ownerOf(node.id)
      );
    if (node.kind === "project") return kind === "ticket" && ownerOf(item.id) === ownerOf(node.id);
    return false;
  });

const pathD = (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const start = from.x + nodeWidth;
  const middle = (start + to.x) / 2;
  const fromY = from.y + nodeHeight / 2;
  const toY = to.y + nodeHeight / 2;
  return `M${start} ${fromY}C${middle} ${fromY} ${middle} ${toY} ${to.x} ${toY}`;
};

type Props = {
  hub: HubState;
  selection: Selection;
  setSelection: (selection: Selection) => void;
  perform: (action: Action | null) => Promise<void>;
  view: View;
  setView: (view: View) => void;
  /** False while the palette or the shortcut sheet is open. */
  active: boolean;
};

export function MapView({ hub, selection, setSelection, perform, view, setView, active }: Props) {
  const [live, setLive] = useState<MapGraph | null>(null);
  const [past, setPast] = useState<MapGraph | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [dim, setDim] = useState(true);
  // The node the human clicked. It holds only while the shared selection is the one it set.
  const [picked, setPicked] = useState<{ node: string; selection: Selection } | null>(null);

  useEffect(() => {
    let stale = false;
    fetch("/api/map")
      .then((response) => response.json() as Promise<MapGraph>)
      .then((graph) => {
        if (stale) return;
        setLive(graph);
        setFailed(false);
      })
      .catch(() => !stale && setFailed(true));
    return () => {
      stale = true;
    };
  }, [hub]);
  useEffect(() => {
    if (at === null) return setPast(null);
    let stale = false;
    fetch(`/api/map?at=${encodeURIComponent(at)}`)
      .then((response) => response.json() as Promise<MapGraph>)
      .then((graph) => !stale && setPast(graph))
      .catch(() => !stale && setFailed(true));
    return () => {
      stale = true;
    };
  }, [at]);

  const graph = (at === null ? live : (past ?? live)) ?? null;
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];

  const selectionOf = (node: MapNode): Selection | undefined => {
    if (node.kind === "run" || node.kind === "step") return { type: "run", id: ownerOf(node.id) };
    if (node.kind !== "agent") return undefined;
    const agent = hub.agents.find(
      (candidate) => candidate.run === ownerOf(node.id) && candidate.title === node.label,
    );
    return agent ? { type: "agent", id: agentKey(agent) } : undefined;
  };
  const fromSelection = (): string | null => {
    if (selection === null) return null;
    if (selection.type === "run") return `run:${selection.id}`;
    if (selection.type === "agent") {
      const agent = hub.agents.find((candidate) => agentKey(candidate) === selection.id);
      return nodes.find((node) => node.kind === "agent" && node.label === agent?.title)?.id ?? null;
    }
    const direct = nodes.find((node) => node.id === selection.id)?.id;
    if (direct) return direct;
    const owner = ownerOf(selection.id);
    return (
      nodes.find((node) => node.id === `run:${owner}` || node.id === `project:${owner}`)?.id ?? null
    );
  };

  const current = picked !== null && picked.selection === selection ? picked.node : fromSelection();
  const litNode = current?.startsWith("badge:") ? current.slice(6) : current;
  const node = nodes.find((candidate) => candidate.id === litNode);

  function pick(id: string) {
    const target = nodes.find((candidate) => candidate.id === id.replace("badge:", ""));
    if (!target) return;
    const items = id.startsWith("badge:") && at === null ? itemsOf(target, hub.needs_me) : [];
    const next: Selection =
      items.length > 0 ? { type: "need", id: items[0].id } : (selectionOf(target) ?? selection);
    setSelection(next);
    setPicked({ node: id, selection: next });
  }

  const times = (graph?.replay.events ?? live?.replay.events ?? []).map((event) =>
    Date.parse(event.time),
  );
  const replay = live?.replay;
  const from = replay?.from ? Date.parse(replay.from) : null;
  const end = replay ? Date.parse(replay.to) : null;
  const moment = at === null ? end : Date.parse(at);
  const toIso = (milliseconds: number) => new Date(milliseconds).toISOString();

  useEffect(() => {
    if (!active || view !== "map") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        (target instanceof HTMLInputElement && target.type !== "range") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (event.key === "j" || event.key === "k") {
        if (nodes.length === 0) return;
        const index = nodes.findIndex((candidate) => candidate.id === litNode);
        const step = event.key === "j" ? 1 : -1;
        pick(nodes[(index + step + nodes.length) % nodes.length].id);
      } else if (event.key === "v") setDim(!dim);
      else if (event.key === "l") setAt(null);
      else if (event.key === "[" && from !== null && moment !== null) {
        const earlier = times.filter((time) => time < moment);
        setAt(toIso(earlier.length ? Math.max(...earlier) : from));
      } else if (event.key === "]" && moment !== null) {
        const later = times.filter((time) => time > moment);
        setAt(later.length ? toIso(Math.min(...later)) : null);
      } else if (event.key === "Escape") {
        setPicked(null);
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Column layout: each kind stacks down its column in API order.
  const rows = [0, 0, 0, 0, 0];
  const place = new Map(
    nodes.map((item) => {
      const index = column[item.kind];
      return [item.id, { x: 10 + index * columnGap, y: 26 + rows[index]++ * rowGap }] as const;
    }),
  );
  const height = 26 + Math.max(1, ...rows) * rowGap;
  const lit = litNode ? pathOf(litNode, edges) : null;
  const unavailable = nodes.filter((item) => item.state === "unavailable").length;
  const replaying = at !== null;

  const items = node && !replaying ? itemsOf(node, hub.needs_me) : [];
  return (
    <>
      <main className="center">
        <header className="top">
          <h1>Ark hub</h1>
          <ViewBar view={view} setView={setView} />
          <span className="spacer" />
          {replaying && <span className="vchip warn">Replay, read only</span>}
        </header>
        <div className="scroll map-view">
          <section className="panel" aria-label="Operations graph">
            <p className="gcap" aria-live="polite">
              {node ? (
                <>
                  <b>{node.label}</b> lit with {Math.max(0, (lit?.size ?? 1) - 1)} linked.
                </>
              ) : (
                <>
                  Click a node or press <Kbd>j</Kbd> <Kbd>k</Kbd> to light its path. <Kbd>v</Kbd>{" "}
                  toggles dimming.
                </>
              )}
            </p>
            {failed && (
              <p className="hint">The Map could not be read. The hub may be restarting.</p>
            )}
            <svg
              className={`graph ${lit ? "focus" : ""} ${dim ? "dim" : ""}`}
              viewBox={`0 0 ${10 + 5 * columnGap} ${height}`}
              role="group"
              aria-label="Operations graph"
            >
              <defs>
                <pattern
                  id="hatch"
                  width="7"
                  height="7"
                  patternTransform="rotate(45)"
                  patternUnits="userSpaceOnUse"
                >
                  <rect width="7" height="7" fill="var(--bg)" />
                  <line x1="0" y1="0" x2="0" y2="7" stroke="var(--muted)" strokeWidth="1.6" />
                </pattern>
              </defs>
              {columnTitles.map((title, index) => (
                <text key={title} className="col" x={10 + index * columnGap} y="14">
                  {title}
                </text>
              ))}
              {edges.map(([source, target]) => {
                const from = place.get(source);
                const to = place.get(target);
                if (!from || !to) return null;
                const on = lit?.has(source) && lit.has(target);
                const flowing =
                  nodes.find((item) => item.id === target)?.state === "working" ||
                  nodes.find((item) => item.id === target)?.state === "live";
                return (
                  <path
                    key={`${source}>${target}`}
                    className={`edge ${flowing && !replaying ? "flow" : ""} ${on ? "rel" : ""}`}
                    data-lit={lit ? String(Boolean(on)) : undefined}
                    d={pathD(from, to)}
                  />
                );
              })}
              {nodes.map((item) => {
                const spot = place.get(item.id)!;
                const tone = nodeTone(item);
                const on = lit?.has(item.id);
                return (
                  <g
                    key={item.id}
                    className={`node s-${tone} ${on ? "rel" : ""} ${litNode === item.id ? "cursor" : ""}`}
                    data-node={item.id}
                    data-state={item.state}
                    data-lit={lit ? String(Boolean(on)) : undefined}
                    transform={`translate(${spot.x} ${spot.y})`}
                    tabIndex={0}
                    role="button"
                    aria-label={`${item.label}, ${item.state.replaceAll("_", " ")}`}
                    onClick={() => pick(item.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      pick(item.id);
                    }}
                  >
                    {tone === "working" && (
                      <rect className="ping" width={nodeWidth} height={nodeHeight} rx="10" />
                    )}
                    <rect className="bd" width={nodeWidth} height={nodeHeight} rx="10" />
                    <text className="b m" x="10" y="21">
                      {item.label.length > 21 ? `${item.label.slice(0, 20)}…` : item.label}
                    </text>
                    <text className="sub" x="10" y="38">
                      {item.state === "unavailable"
                        ? "UNAVAILABLE (no history)"
                        : `${item.state.replaceAll("_", " ")} · ${item.kind}`}
                    </text>
                  </g>
                );
              })}
              {nodes
                .filter((item) => item.needs_you > 0)
                .map((item) => {
                  const spot = place.get(item.id)!;
                  return (
                    <g
                      key={`badge:${item.id}`}
                      className={`mapbadge ${current === `badge:${item.id}` ? "cursor" : ""}`}
                      data-badge={item.id}
                      transform={`translate(${spot.x + nodeWidth - 4} ${spot.y - 2})`}
                      tabIndex={0}
                      role="button"
                      aria-label={`${item.label}: ${item.needs_you} needs you`}
                      onClick={() => pick(`badge:${item.id}`)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        pick(`badge:${item.id}`);
                      }}
                    >
                      <circle r="11" />
                      <text y="4">{item.needs_you}</text>
                    </g>
                  );
                })}
            </svg>
          </section>

          <section className="panel replay" aria-label="Replay scrubber">
            <div className="rp-head">
              <h2>Replay</h2>
              <span className="vchip" data-testid="asof">
                {replaying ? `replay ${clock(at)}` : "live"}
              </span>
              <span className="hint">
                <Kbd>[</Kbd> <Kbd>]</Kbd> step to previous / next event <Kbd>l</Kbd> back to live
              </span>
            </div>
            {from === null || end === null || moment === null ? (
              <p className="hint">
                No last visit is saved, so there is no replay window. The Map shows live state.
              </p>
            ) : (
              <>
                <p className="readout" aria-live="polite">
                  As of <b>{replaying ? clock(at) : "now"}</b> · {replaying ? "replay" : "live"}
                  {unavailable > 0 && (
                    <>
                      {" "}
                      · <b>{unavailable}</b> of {nodes.length} nodes UNAVAILABLE: liveness and CI
                      were not collected at this time.
                    </>
                  )}
                </p>
                <div className="rp-track">
                  {times.map((time) => (
                    <i
                      key={time}
                      className="ev"
                      style={{ left: `${((time - from) / Math.max(1, end - from)) * 100}%` }}
                    />
                  ))}
                  <input
                    type="range"
                    min={from}
                    max={end}
                    step={1000}
                    value={moment}
                    aria-label={`Replay time, from ${clock(from)} to now`}
                    onChange={(event) =>
                      setAt(
                        Number(event.target.value) >= end
                          ? null
                          : toIso(Number(event.target.value)),
                      )
                    }
                  />
                </div>
                <div className="rp-ticks">
                  <span>{clock(from)}</span>
                  <span>now</span>
                </div>
              </>
            )}
          </section>
        </div>
      </main>

      <aside className="detail" aria-label="Detail">
        {node ? (
          <div className="d-head">
            <div className="d-id">
              <span className="pill">{node.kind}</span>
            </div>
            <h2>{node.label}</h2>
            <dl className="kv">
              <dt>State</dt>
              <dd>
                <span className={`sw s-${nodeTone(node)}`} />{" "}
                {node.state === "unavailable" ? "UNAVAILABLE" : node.state.replaceAll("_", " ")}
              </dd>
              <dt>As of</dt>
              <dd className="mono">{graph ? clock(graph.at) : "now"}</dd>
              <dt>Source</dt>
              <dd className="mono">
                {["chief", "agent", "mr"].includes(node.kind)
                  ? "hub/history.ndjson"
                  : "events.ndjson"}
              </dd>
              <dt>Needs you</dt>
              <dd>{node.needs_you}</dd>
            </dl>
            {node.state === "unavailable" && (
              <p className="hint">
                The hub was not collecting then, so Ark shows no state rather than a guess.
              </p>
            )}
            {items.map((item) => (
              <button
                key={item.id}
                className="btn primary"
                disabled={item.action === null}
                onClick={() => void perform(item.action)}
              >
                {item.action?.label ?? item.title}
              </button>
            ))}
          </div>
        ) : (
          <div className="d-empty">
            Select a node to see it here.
            <br />
            <span className="hint">Map selection is shared with Home, not with the Timeline.</span>
          </div>
        )}
      </aside>
    </>
  );
}
