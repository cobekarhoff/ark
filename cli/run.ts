import Ajv2020 from "ajv/dist/2020";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import acSchema from "../schemas/ac.schema.json";
import frontmatterSchema from "../schemas/ticket-frontmatter.schema.json";
import ledgerSchema from "../schemas/ledger-event.schema.json";
import stateSchema from "../schemas/state.schema.json";
import ticketSchema from "../schemas/ticket.schema.json";
import { eventKey, nextActions, type State, transitions } from "./transitions";

type LedgerEvent = { seq: number; ts: string; type: string; data: Record<string, unknown> };
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
  repos: never[];
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
const check = (schema: string, value: unknown, what: string) => {
  const v = validators[schema];
  if (!v(value)) throw new Error(`${what} fails ${schema} schema: ${ajv.errorsText(v.errors)}`);
};

const TICKET_ID = /^[A-Z][A-Z0-9]*-[0-9]+$/;
export const sha256 = (bytes: string | Uint8Array) => `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

function projectRoot(): string {
  for (let d = process.cwd(); ; d = dirname(d)) {
    const f = join(d, "ark.yml");
    if (existsSync(f)) {
      const name = (Bun.YAML.parse(readFileSync(f, "utf8")) as { project?: unknown } | null)?.project;
      if (typeof name !== "string" || !name) throw new Error(`${f} has no 'project:' key`);
      return join(process.env.ARK_HOME ?? join(homedir(), ".ark"), "projects", name);
    }
    if (d === dirname(d)) throw new Error(`no ark.yml found from ${process.cwd()} upward`);
  }
}

export function runDir(runId: string): string {
  if (!/^\d{4}-\d{2}-\d{2}-[A-Z][A-Z0-9]*-[0-9]+$/.test(runId)) throw new Error(`invalid run id '${runId}'`);
  const dir = join(projectRoot(), "runs", runId);
  if (!existsSync(dir)) throw new Error(`no such run '${runId}'`);
  return dir;
}

// The projection: state.json is a pure function of the ledger.
export function project(events: LedgerEvent[]): RunState {
  const first = events[0];
  if (first?.type !== "run.started") throw new Error("ledger must begin with run.started");
  const { ticket, playbook, acs, artifacts } = first.data as RunStarted;
  let state: State = "intake";
  const gates: RunState["gates"] = {};
  for (const [i, e] of events.entries()) {
    if (e.seq !== i + 1) throw new Error(`ledger seq ${e.seq} at position ${i + 1}`);
    if (i === 0) continue;
    const next = (transitions[state] as Record<string, State>)[eventKey(e)];
    if (!next) throw new Error(`ledger event ${e.seq} '${e.type}' is illegal in '${state}'`);
    state = next;
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
    repos: [],
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

export function summary(s: RunState): string {
  const n = s.next_action;
  return `${s.run_id}\nstate: ${s.state}\nstatus: ${s.status}\nnext_action: ${n ? `${n.kind} (${n.agent})` : "none"}\n`;
}

export function start(id: string): string {
  if (!TICKET_ID.test(id ?? "")) throw new Error(`invalid ticket id '${id}'`);
  const root = projectRoot();
  const runs = join(root, "runs");
  const existing = existsSync(runs) && readdirSync(runs).find((r) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${id}$`).test(r));
  if (existing) return `resumed ${summary(JSON.parse(readFileSync(join(runs, existing, "state.json"), "utf8")))}`;

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
  return `started ${summary(commit(dir, events))}`;
}

export function advance(runId: string, type: string, rawData?: string): string {
  const dir = runDir(runId);
  let data: unknown = {};
  if (rawData !== undefined) {
    try { data = JSON.parse(rawData); } catch { throw new Error("--data is not valid JSON"); }
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("--data must be a JSON object");
  }
  const events = readLedger(dir);
  const state = project(events).state;
  if (type.startsWith("gate.")) throw new Error(`'${type}' is written by 'ark gate', not advance (state '${state}')`);
  const legal = Object.keys(transitions[state]).filter((e) => !e.startsWith("gate."));
  if (!legal.includes(type)) {
    const gate = state.match(/^awaiting_(g[012])$/)?.[1].toUpperCase();
    throw new Error(
      `illegal event '${type}' in state '${state}'; ${legal.length ? `legal: ${legal.join(", ")}` : "run is closed"}` +
        (gate ? `; ${gate} has no approving answer yet (ark gate answer)` : ""),
    );
  }
  return `advanced ${summary(commit(dir, append(dir, events, type, data as Record<string, unknown>)))}`;
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
