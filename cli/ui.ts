import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveState, readEvents, type RunState } from "./events.ts";
import { listProjects, runsDirectory } from "./paths.ts";
import { waitingGate } from "./run.ts";

// Only the fields this page reads. Orca output is local and trusted, so it is cast, not parsed.
type OrcaRun = { id: string; objective?: string; coordinator_handle: string | null };
type OrcaTask = { id: string; task_title: string };
type OrcaWorker = {
  dispatchId: string;
  taskId: string;
  agentTerminalHandle: string;
  projection?: {
    provider?: { model?: string };
    stage?: { activity?: string };
    outcome?: string;
    liveness?: { verdict?: string };
  };
};
type OrcaResult = { runs?: OrcaRun[]; tasks?: OrcaTask[]; workers?: OrcaWorker[] };

type Agent = {
  role: string;
  title: string;
  model: string | null;
  liveness: string;
  activity: string;
  terminal: string | null;
  command: string | null;
};

/** Runs `orca orchestration <args> --json`. A missing or failing orca gives no agents, never an error. */
function orca(...args: string[]): OrcaResult {
  try {
    const result = Bun.spawnSync(["orca", "orchestration", ...args, "--json"]);
    if (result.exitCode !== 0) return {};
    const output: { result?: OrcaResult } = JSON.parse(result.stdout.toString()); // trusted local orca output
    return output.result ?? {};
  } catch {
    return {};
  }
}

/** Run lead liveness and harness from `orca terminal show`. A failing call gives `unknown`. */
function runLeadTerminal(handle: string | null): { liveness: string; model: string | null } {
  if (!handle) return { liveness: "unknown", model: null };
  try {
    const result = Bun.spawnSync(["orca", "terminal", "show", "--terminal", handle, "--json"]);
    if (result.exitCode !== 0) return { liveness: "unknown", model: null };
    const terminal: { connected?: boolean; agentIdentity?: string } = JSON.parse(
      result.stdout.toString(),
    ).result.terminal; // trusted local orca output
    return {
      liveness: terminal.connected ? "live" : "exited",
      model: terminal.agentIdentity ?? null,
    };
  } catch {
    return { liveness: "unknown", model: null };
  }
}

function agentsOf(orcaRun: OrcaRun): Agent[] {
  const titles = new Map<string, string>();
  for (const task of orca("task-list", "--run", orcaRun.id).tasks ?? [])
    titles.set(task.id, task.task_title);
  const runLead: Agent = {
    role: "run lead",
    title: orcaRun.objective ?? orcaRun.id,
    ...runLeadTerminal(orcaRun.coordinator_handle),
    activity: "unknown",
    terminal: orcaRun.coordinator_handle,
    command: orcaRun.coordinator_handle
      ? `orca terminal switch --terminal ${orcaRun.coordinator_handle}`
      : null,
  };
  const workers = (orca("worker-list", "--run", orcaRun.id, "--include-remote").workers ?? []).map(
    (worker): Agent => ({
      role: "worker",
      title: titles.get(worker.taskId) ?? worker.taskId,
      model: worker.projection?.provider?.model ?? null,
      liveness: worker.projection?.liveness?.verdict ?? "unknown",
      activity: worker.projection?.stage?.activity ?? "unknown",
      terminal: worker.agentTerminalHandle ?? null,
      command: worker.agentTerminalHandle
        ? `orca terminal switch --terminal ${worker.agentTerminalHandle}`
        : null,
    }),
  );
  return [runLead, ...workers];
}

function gateOf(runId: string, directory: string, state: RunState) {
  const name = waitingGate(state);
  if (name === "none") return null;
  const command = name === "plan" ? `plannotator annotate ${join(directory, "plan.md")}` : null;
  return {
    name,
    command,
    hint: command
      ? null
      : `Answer the ${name} gate in the Master Chief terminal (ark gate record ${runId} ${name} <answer>).`,
  };
}

function snapshot() {
  const orcaRuns = orca("run-list").runs ?? [];
  const runLeadRuns = new Map(
    orcaRuns
      .filter((orcaRun) => orcaRun.objective?.startsWith("Ark run "))
      .map((orcaRun) => [orcaRun.objective!.slice("Ark run ".length), orcaRun]),
  );
  const runs = [];
  for (const project of listProjects()) {
    const runsRoot = runsDirectory(project);
    if (!existsSync(runsRoot)) continue;
    for (const name of readdirSync(runsRoot)) {
      const directory = join(runsRoot, name);
      const events = readEvents(directory);
      if (events.length === 0) continue;
      const state = deriveState(events);
      const orcaRun = runLeadRuns.get(name);
      runs.push({
        ...state,
        open: state.phase !== "closed",
        gate: gateOf(name, directory, state),
        agents: state.phase !== "closed" && orcaRun ? agentsOf(orcaRun) : [],
      });
    }
  }
  runs.sort((left, right) => right.run.localeCompare(left.run));
  return { at: new Date().toISOString(), runs };
}

const page = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><title>Ark control center</title>
<style>
  :root { color-scheme: light dark; --muted: #8888; }
  body { font: 14px/1.4 ui-sans-serif, system-ui; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; } .at { color: GrayText; margin-bottom: 16px; }
  .card { border: 1px solid var(--muted); border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
  .card.closed { opacity: .55; } .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
  .pill { border-radius: 99px; padding: 1px 9px; font-size: 12px; border: 1px solid var(--muted); }
  .live, .working, .running, .succeeded, .passed { background: #2a7a3a33; border-color: #2a7a3a; }
  .failed, .dead { background: #b0303033; border-color: #b03030; }
  .waiting, .idle { background: #c08a0033; border-color: #c08a00; }
  .agents { margin: 6px 0 0 18px; border-left: 2px solid var(--muted); padding-left: 12px; }
  code { font-size: 12px; } button { font-size: 11px; }
</style></head><body>
<h1>Ark control center</h1><div class="at" id="at"></div>
<div id="root">Loading…</div>
<script>
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const pill = (text) => '<span class="pill ' + esc(text) + '">' + esc(text) + '</span>';
const copyable = (command) => '<code>' + esc(command) + '</code> <button data-copy="' + esc(command) + '">copy</button>';
const agent = (a) => '<div class="row">' + pill(a.liveness) + pill(a.activity) + '<b>' + esc(a.role) + '</b> ' + esc(a.title) +
  (a.model ? '<code>' + esc(a.model) + '</code>' : '') + (a.command ? copyable(a.command) : '') + '</div>';
function render(data) {
  document.getElementById('at').textContent = 'Updated ' + new Date(data.at).toLocaleTimeString() + ' · refreshes every 3s';
  document.getElementById('root').innerHTML = data.runs.map((run) => {
    const steps = run.steps.map((s) => pill(s.id + ' · ' + s.role + ' · ' + s.status)).join(' ');
    const requests = run.merge_requests.map((m) => '<a href="' + esc(m.url) + '" target="_blank">' + esc(m.repo) + ' #' + m.number + '</a>').join(' ');
    const gate = run.gate ? '<div class="row">' + pill('waiting') + 'gate <b>' + esc(run.gate.name) + '</b> ' + (run.gate.command ? copyable(run.gate.command) : esc(run.gate.hint)) + '</div>' : '';
    return '<div class="card ' + (run.open ? '' : 'closed') + '"><div class="row">' + pill(run.outcome || run.phase) + '<b>' + esc(run.ticket.id) + '</b> ' + esc(run.ticket.title) +
      '<code>' + esc(run.run) + '</code><span>round ' + run.round + '/' + run.round_budget + '</span>' +
      '<span>last test: ' + (run.last_test ? pill(run.last_test.passed ? 'passed' : 'failed') : 'none') + '</span></div>' +
      '<div class="row">' + (steps || '<i>no steps</i>') + '</div>' + gate +
      '<div class="row">MRs: ' + (requests || 'none') + '</div>' +
      (run.agents.length ? '<div class="agents">' + run.agents.map(agent).join('') + '</div>' : '') + '</div>';
  }).join('') || 'No runs.';
}
document.addEventListener('click', (e) => { const text = e.target.dataset && e.target.dataset.copy; if (text) navigator.clipboard.writeText(text); });
async function tick() { try { render(await (await fetch('/api')).json()); } catch (err) { document.getElementById('at').textContent = 'Error: ' + err; } }
tick(); setInterval(tick, 3000);
</script></body></html>`;

/** Serves the read-only overview. Port 0 picks a free port. Runs until the process ends. */
export function ui(port: number): void {
  // ponytail: shells out to orca on every poll (3s per page); cache or a push feed if many tabs are open.
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/api") return Response.json(snapshot());
      return new Response(page, { headers: { "content-type": "text/html" } });
    },
  });
  console.log(`Ark control center on http://127.0.0.1:${server.port}`);
}
