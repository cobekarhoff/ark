import Ajv2020 from "ajv/dist/2020";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import acSchema from "../schemas/ac.schema.json";
import frontmatterSchema from "../schemas/ticket-frontmatter.schema.json";
import ledgerSchema from "../schemas/ledger-event.schema.json";
import stateSchema from "../schemas/state.schema.json";
import ticketSchema from "../schemas/ticket.schema.json";
import { preflight } from "./preflight";
import { git, loadRepo, touchedTaggedTests } from "./repo";
import { eventKey, nextActions, owner, type State, transitions } from "./transitions";

export type LedgerEvent = { seq: number; ts: string; type: string; data: Record<string, unknown> };
type Ac = { id: string; text: string };
type Frontmatter = { id: string; title: string; status: string; milestone?: string; traces?: string[]; depends_on?: string[]; acceptance_criteria?: Ac[] };
type RunStarted = { ticket: string; playbook: string; acs: string[]; artifacts: Record<string, string> };

export interface RunState {
  schema: 1;
  run_id: string;
  ticket: string;
  playbook: string;
  state: State;
  status: "active" | "waiting_human" | "done" | "aborted";
  tier: null;
  round: number;
  next_action: (typeof nextActions)[State];
  gates: Record<string, { answer: string; by: string; at: string; packet_sha256: string }>;
  repos: { name: string; order: number; branch: string; base_sha: string; head_sha: string | null; step: string }[];
  acs: Record<string, string>;
  artifacts: Record<string, string>;
  sessions: never[];
  lock: null;
  ledger_seq: number;
}

const ajv = new Ajv2020();
const validators = Object.fromEntries(
  Object.entries({ ac: acSchema, frontmatter: frontmatterSchema, ledger: ledgerSchema, state: stateSchema, ticket: ticketSchema })
    .map(([k, s]) => [k, ajv.compile(s)]),
);
export const check = (schema: string, value: unknown, what: string) => {
  const v = validators[schema];
  if (!v(value)) throw new Error(`${what} fails ${schema} schema: ${ajv.errorsText(v.errors)}`);
};

const TICKET_ID = /^[A-Z][A-Z0-9]*-[0-9]+$/;
export const sha256 = (bytes: string | Uint8Array) => `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

// The directory holding the nearest ark.yml (the project's root repo).
export function projectDir(): string {
  for (let d = process.cwd(); ; d = dirname(d)) {
    if (existsSync(join(d, "ark.yml"))) return d;
    if (d === dirname(d)) throw new Error(`no ark.yml found from ${process.cwd()} upward`);
  }
}

export function projectRoot(): string {
  const f = join(projectDir(), "ark.yml");
  const name = (Bun.YAML.parse(readFileSync(f, "utf8")) as { project?: unknown } | null)?.project;
  if (typeof name !== "string" || !name) throw new Error(`${f} has no 'project:' key`);
  return join(process.env.ARK_HOME ?? join(homedir(), ".ark"), "projects", name);
}
export function runDir(runId: string): string {
  if (!/^\d{4}-\d{2}-\d{2}-[A-Z][A-Z0-9]*-[0-9]+$/.test(runId)) throw new Error(`invalid run id '${runId}'`);
  const dir = join(projectRoot(), "runs", runId);
  if (!existsSync(dir)) throw new Error(`no such run '${runId}'`);
  return dir;
}

// Active run = the run id in <project>/active-run, written by `ark run start`; a done or aborted run no longer binds the session (ARK-108 hook).
export const setActive = (runId: string) => writeFileSync(join(projectRoot(), "active-run"), `${runId}\n`);

export function activeRunDir(): string | undefined {
  let root: string;
  try { root = projectRoot(); } catch { return undefined; } // no ark.yml: not an Ark project
  const ptr = join(root, "active-run");
  if (!existsSync(ptr)) return undefined;
  const dir = join(root, "runs", readFileSync(ptr, "utf8").trim());
  if (!existsSync(dir)) return undefined;
  const st = join(dir, "state.json");
  const status = existsSync(st) ? (JSON.parse(readFileSync(st, "utf8")) as { status: string }).status : "active";
  return status === "done" || status === "aborted" ? undefined : dir;
}

// The projection: state.json is a pure function of the ledger.
export function project(events: LedgerEvent[]): RunState {
  const first = events[0];
  if (first?.type !== "run.started") throw new Error("ledger must begin with run.started");
  const { ticket, playbook, acs, artifacts } = first.data as RunStarted;
  let state: State = "intake";
  const repos: RunState["repos"] = [];
  const gates: RunState["gates"] = {};
  for (const [i, e] of events.entries()) {
    if (e.seq !== i + 1) throw new Error(`ledger seq ${e.seq} at position ${i + 1}`);
    if (i === 0) continue;
    const next = (transitions[state] as Record<string, State>)[eventKey(e)];
    if (!next) throw new Error(`ledger event ${e.seq} '${e.type}' is illegal in '${state}'`);
    state = next;
    const d = e.data as { repo: string; branch: string; base_sha: string; head_sha: string };
    if (e.type === "ws.created") repos.push({ name: d.repo, order: repos.length + 1, branch: d.branch, base_sha: d.base_sha, head_sha: null, step: "pending" });
    if (e.type === "implementer.completed") {
      const r = repos.find((r) => r.name === d.repo);
      if (!r) throw new Error(`ledger event ${e.seq} names unknown repo '${d.repo}'`);
      Object.assign(r, { head_sha: d.head_sha, step: "implemented" });
    }
    if (e.type === "gate.answered") {
      const { gate, answer, by, packet_sha256 } = e.data as Record<string, string>;
      gates[gate] = { answer, by, at: e.ts, packet_sha256 };
    }
  }
  const next_action = nextActions[state];
  return {
    schema: 1,
    run_id: `${first.ts.slice(0, 10)}-${ticket}`,
    ticket,
    playbook,
    state,
    status: next_action === null ? (state as "done" | "aborted") : next_action.agent === "human" ? "waiting_human" : "active",
    tier: null,
    round: 0,
    next_action,
    gates,
    repos,
    acs: Object.fromEntries(acs.map((id) => [id, "pending"])),
    artifacts,
    sessions: [],
    lock: null,
    ledger_seq: events.length,
  };
}

export function readLedger(dir: string): LedgerEvent[] {
  const lines = readFileSync(join(dir, "ledger.ndjson"), "utf8").split("\n").filter(Boolean);
  return lines.map((l, i) => {
    const e = JSON.parse(l);
    check("ledger", e, `ledger line ${i + 1}`);
    return e;
  });
}

// Validates the event and the state it projects to before anything is written, so a failure leaves the ledger untouched.
export function append(dir: string, events: LedgerEvent[], type: string, data: Record<string, unknown>, ts = new Date().toISOString()): LedgerEvent[] {
  const e = { seq: events.length + 1, ts, type, data };
  check("ledger", e, `event '${type}'`);
  const next = [...events, e];
  render(next);
  appendFileSync(join(dir, "ledger.ndjson"), `${JSON.stringify(e)}\n`);
  return next;
}

const render = (events: LedgerEvent[]) => {
  const state = project(events);
  check("state", state, "state");
  return { state, bytes: json(state) };
};

export function commit(dir: string, events: LedgerEvent[]) {
  const { state, bytes } = render(events);
  writeFileSync(join(dir, "state.json"), bytes);
  return state;
}

// The run folder and state, refusing (before anything is written) an event type that is illegal in the current state,
// or that another command owns: `via` is the owning command calling for its own event, `ark advance` passes none.
export function open(runId: string, type: string, via?: string) {
  const dir = runDir(runId);
  const state = project(readLedger(dir));
  if (owner[type] && owner[type] !== via) throw new Error(`'${type}' is written by 'ark ${owner[type]}', not advance (state '${state.state}')`);
  const types = Object.keys(transitions[state.state]).map((k) => k.split(":")[0]);
  const legal = [...new Set(types.filter((t) => !owner[t]))];
  if (!types.includes(type)) {
    const gate = state.state.match(/^awaiting_(g[012])$/)?.[1].toUpperCase();
    throw new Error(
      `illegal event '${type}' in state '${state.state}'; ${legal.length ? `legal: ${legal.join(", ")}` : "run is closed"}` +
        (gate ? `; ${gate} has no approving answer yet (ark gate answer)` : ""),
    );
  }
  return { dir, state };
}

export const record = (dir: string, type: string, data: Record<string, unknown>) =>
  commit(dir, append(dir, readLedger(dir), type, data));

export function summary(s: RunState): string {
  const n = s.next_action;
  return `${s.run_id}\nstate: ${s.state}\nstatus: ${s.status}\nnext_action: ${n ? `${n.kind} (${n.agent})` : "none"}\n`;
}

export function start(id: string): string {
  if (!TICKET_ID.test(id ?? "")) throw new Error(`invalid ticket id '${id}'`);
  preflight();
  const root = projectRoot();
  const runs = join(root, "runs");
  const existing = existsSync(runs) && readdirSync(runs).find((r) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${id}$`).test(r));
  if (existing) {
    setActive(existing);
    return `resumed ${summary(JSON.parse(readFileSync(join(runs, existing, "state.json"), "utf8")))}`;
  }

  const src = join(root, "tickets", `${id}.md`);
  if (!existsSync(src)) throw new Error(`no ticket file ${src}`);
  const raw = readFileSync(src, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${src} has no frontmatter`);
  const fm = Bun.YAML.parse(m[1]) as Frontmatter; // validated on the next line
  check("frontmatter", fm, src);
  if (fm.id !== id) throw new Error(`${src} has id '${fm.id}', expected '${id}'`);

  const acs = fm.acceptance_criteria ?? [];
  const ticket = {
    id: fm.id, title: fm.title, source: "local", status: fm.status, milestone: fm.milestone,
    traces: fm.traces, depends_on: fm.depends_on, acceptance_criteria: acs, body: m[2],
  };
  check("ticket", ticket, "ticket.json");
  check("ac", acs, "ac.yml");

  const ticketJson = json(ticket);
  const acYml = acs.length ? Bun.YAML.stringify(acs, null, 2) : "[]\n";
  const artifacts = { "ticket.md": sha256(raw), "ticket.json": sha256(ticketJson), "ac.yml": sha256(acYml) };

  let events: LedgerEvent[] = [];
  const ts = new Date().toISOString();
  const dir = join(runs, `${ts.slice(0, 10)}-${id}`);
  mkdirSync(runs, { recursive: true });
  mkdirSync(dir); // not recursive: a concurrent start of the same ticket fails here
  copyFileSync(src, join(dir, "ticket.md"));
  writeFileSync(join(dir, "ticket.json"), ticketJson);
  writeFileSync(join(dir, "ac.yml"), acYml);
  writeFileSync(join(dir, "ledger.ndjson"), "");
  events = append(dir, events, "run.started", { ticket: id, playbook: "ticket", acs: acs.map((a) => a.id), artifacts }, ts); // same ts as the folder name, so run_id matches it
  if (!acs.length) events = append(dir, events, "g0.opened", { reason: "ticket has no acceptance criteria" });
  setActive(basename(dir));
  return `started ${summary(commit(dir, events))}`;
}

export function advance(runId: string, type: string, rawData?: string): string {
  const { dir, state } = open(runId, type);
  let data: Record<string, unknown> = {};
  if (rawData !== undefined) {
    try { data = JSON.parse(rawData); } catch { throw new Error("--data is not valid JSON"); }
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("--data must be a JSON object");
  }
  if (type === "implementer.completed") { // AC7: implementers never edit AC-tagged tests
    const repo = state.repos.find((r) => r.name === data.repo);
    if (!repo) throw new Error(`implementer.completed needs --data '{"repo":"<name>"}' naming a worktree of this run`);
    const wt = join(dir, "ws", repo.name);
    if (git(wt, "status", "--porcelain", "--untracked-files=no")) throw new Error(`${wt} has uncommitted changes; commit them so the check sees the whole step`);
    const hit = touchedTaggedTests(wt, repo.base_sha, loadRepo(wt, repo.base_sha)); // base config: the implementer cannot widen its own exemptions
    if (hit.length) throw new Error(`implementer step touches AC-tagged test files: ${hit.join(", ")}`);
    data = { repo: repo.name, head_sha: git(wt, "rev-parse", "HEAD") };
  }
  return `advanced ${summary(record(dir, type, data))}`;
}

export function replay(runId: string, checkOnly: boolean): string {
  const dir = runDir(runId);
  const { bytes } = render(readLedger(dir));
  const file = join(dir, "state.json");
  if (checkOnly) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== bytes) throw new Error(`state.json differs from ledger replay for ${runId}`);
    return `ok ${runId}\n`;
  }
  writeFileSync(file, bytes);
  return `replayed ${runId}\n`;
}
