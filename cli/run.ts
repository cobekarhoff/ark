import Ajv2020 from "ajv/dist/2020";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import acSchema from "../schemas/ac.schema.json";
import frontmatterSchema from "../schemas/ticket-frontmatter.schema.json";
import ledgerSchema from "../schemas/ledger-event.schema.json";
import stateSchema from "../schemas/state.schema.json";
import ticketSchema from "../schemas/ticket.schema.json";
import { bindSession } from "./binding";
import { preflight } from "./preflight";
import { diffFiles, dirtyFiles, git, isTestFile, loadRepo, touchedTaggedTests } from "./repo";
import { eventKey, nextActions, ownerOf, type State, transitions } from "./transitions";

export type LedgerEvent = { seq: number; ts: string; type: string; data: Record<string, unknown>; prev: string };
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
  ledger_head: string;
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
export function setActive(runId: string) {
  writeFileSync(join(projectRoot(), "active-run"), `${runId}\n`);
  bindSession(join(projectRoot(), "runs", runId)); // the session that starts or resumes a run is bound to it (ARK-115 AC10)
}

export function activeRunDir(): string | undefined {
  let root: string;
  try { root = projectRoot(); } catch { return undefined; } // no ark.yml: not an Ark project
  const ptr = join(root, "active-run");
  if (!existsSync(ptr)) return undefined;
  const dir = join(root, "runs", readFileSync(ptr, "utf8").trim());
  if (!existsSync(dir)) return undefined;
  // The ledger decides whether the run is open, not the cached state.json: editing state.json must not lift the hook's protection.
  // A ledger that cannot be replayed (broken chain, bad line) keeps the run guarded.
  let status = "active";
  try { status = project(readLedger(dir)).status; } catch { /* guarded */ }
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
    const row = transitions[state] as Record<string, State>;
    const next = Object.hasOwn(row, eventKey(e)) ? row[eventKey(e)] : undefined;
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
  // In mrs_open the orchestrator has to open the MRs (ark mr) until every repo has one; only then does a human merge.
  const mrsPending = state === "mrs_open" && !repos.every((r) => events.some((e) => e.type === "mr.opened" && e.data.repo === r.name));
  const next_action = mrsPending ? { kind: "open_mrs", agent: "orchestrator" as const } : nextActions[state];
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
    ledger_head: chainHash(events.at(-1)),
  };
}

// The ledger is a hash chain: every line is the canonical JSON of its event, and `prev` is the sha256 of the previous line ("" before the first),
// so an edited, removed, reordered or cut-off line breaks it. The newest line and a removed tail are anchored by state.json (`ledger_seq`, `ledger_head`),
// which is always at most one event behind the ledger.
// What this is: a detector of accidental corruption and truncation (a crash mid-write, a bad merge, an editor, a half-run script), relative to the cached head.
// What it is not: protection against deliberate tampering. A process running as the same user can recompute every `prev`, rewrite state.json and pass the check.
// v1 accepts same-user trust; see docs/adr/0003-same-user-trust-for-v1.md for the decision and what would close it (an anchor outside the user's reach).
const line = (e: LedgerEvent) => JSON.stringify(e);
function chainHash(e?: LedgerEvent) {
  return sha256(e ? line(e) : "");
}
const broken = (seq: number, why: string) => new Error(`ledger chain broken at seq ${seq}: ${why}`);

// An O_EXCL lock file is the mutex: one process at a time reads and appends. The file names its owner ({ pid, started, token }).
// A lock is taken over only when its owner is gone (the pid no longer exists), never because it is old: a holder may legitimately be slow.
// Takeover runs under a second O_EXCL guard, so two waiters cannot both delete a lock and one of them then delete the other's fresh one,
// and a holder deletes its own lock only if the file still carries its token.
// ponytail: a pid reused by an unrelated process keeps a crashed holder's lock alive; the wait error names the pid and says to delete the file.
const LOCK_WAIT_MS = Number(process.env.ARK_LOCK_WAIT_MS) || 60_000;
const LOCK_UNWRITTEN_MS = 5_000; // a lock file with no owner in it is a holder that died between creating and writing it
const held = new Set<string>();
const started = new Date(Date.now() - process.uptime() * 1000).toISOString();

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
function lockOwner(file: string): { pid: number; started: string; token: string } | undefined {
  try {
    const o = JSON.parse(readFileSync(file, "utf8"));
    return typeof o?.pid === "number" && typeof o.token === "string" ? o : undefined;
  } catch { return undefined; }
}
function abandoned(lock: string): boolean {
  const o = lockOwner(lock);
  if (o) return !alive(o.pid);
  try { return Date.now() - statSync(lock).mtimeMs > LOCK_UNWRITTEN_MS; } catch { return false; }
}
function reap(lock: string) {
  const guard = `${lock}.reap`;
  try { writeFileSync(guard, "", { flag: "wx" }); } catch {
    try { if (Date.now() - statSync(guard).mtimeMs > 10_000) rmSync(guard, { force: true }); } catch { /* gone */ }
    Bun.sleepSync(2);
    return;
  }
  try { if (abandoned(lock)) rmSync(lock, { force: true }); } finally { rmSync(guard, { force: true }); } // re-checked under the guard
}

export function locked<T>(dir: string, fn: () => T): T {
  if (held.has(dir)) return fn();
  const lock = join(dir, "ledger.lock");
  const token = crypto.randomUUID();
  const t0 = Date.now();
  for (;;) {
    try { writeFileSync(lock, JSON.stringify({ pid: process.pid, started, token }), { flag: "wx" }); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    if (abandoned(lock)) { reap(lock); continue; }
    if (Date.now() - t0 > LOCK_WAIT_MS) {
      const o = lockOwner(lock);
      throw new Error(`${lock} is held by ${o ? `pid ${o.pid} (started ${o.started})` : "another ark process"}; delete it if that process is not running`);
    }
    Bun.sleepSync(5);
  }
  held.add(dir);
  try { return fn(); } finally { held.delete(dir); if (lockOwner(lock)?.token === token) rmSync(lock, { force: true }); }
}

const anchor = (dir: string): { ledger_seq?: unknown; ledger_head?: unknown } => {
  try { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); } catch { return {}; } // missing or unreadable: nothing to anchor to
};

export const readLedger = (dir: string): LedgerEvent[] =>
  locked(dir, () => {
    const lines = readFileSync(join(dir, "ledger.ndjson"), "utf8").split("\n");
    const tail = lines.pop(); // "" after the final newline
    const events: LedgerEvent[] = [];
    for (const [i, l] of lines.entries()) {
      const at = i + 1;
      let e: LedgerEvent;
      try { e = JSON.parse(l); } catch { throw broken(at, "the line is not valid JSON"); }
      check("ledger", e, `ledger seq ${at}`);
      if (e.seq !== at) throw broken(at, `found seq ${e.seq} where seq ${at} belongs (a line was removed, added or reordered)`);
      if (line(e) !== l) throw broken(at, "the line is not in the form the CLI writes");
      if (e.prev !== chainHash(events.at(-1))) throw broken(Math.max(1, at - 1), `seq ${at} records a different hash for it, so it was edited or removed`);
      events.push(e);
    }
    if (tail) throw broken(lines.length + 1, "the final line is cut off");
    const { ledger_seq: n, ledger_head: head } = anchor(dir);
    if (typeof n === "number" && typeof head === "string") {
      if (n > events.length) throw broken(events.length + 1, `state.json records ${n} events but the ledger ends at seq ${events.length}; the tail was removed`);
      if (n > 0 && chainHash(events[n - 1]) !== head) throw broken(n, "it no longer matches the hash state.json recorded");
    }
    return events;
  });

// Validates the event and the state it projects to before anything is written, so a failure leaves the ledger untouched.
// The caller holds the lock and read `events` under it (record, or locked around a read and this).
export function append(dir: string, events: LedgerEvent[], type: string, data: Record<string, unknown>, ts = new Date().toISOString()): LedgerEvent[] {
  if (!held.has(dir)) throw new Error("append needs the ledger lock");
  const e: LedgerEvent = { seq: events.length + 1, ts, type, data, prev: chainHash(events.at(-1)) };
  check("ledger", e, `event '${type}'`);
  const next = [...events, e];
  render(next);
  appendFileSync(join(dir, "ledger.ndjson"), `${line(e)}\n`);
  return next;
}

const render = (events: LedgerEvent[]) => {
  const state = project(events);
  check("state", state, "state");
  return { state, bytes: json(state) };
};

// Written beside and renamed over, so a reader (the hook) never sees half a state.json.
const writeState = (dir: string, bytes: string) => {
  const tmp = join(dir, "state.json.tmp");
  writeFileSync(tmp, bytes);
  renameSync(tmp, join(dir, "state.json"));
};

export function commit(dir: string, events: LedgerEvent[]) {
  const { state, bytes } = render(events);
  writeState(dir, bytes);
  return state;
}

// ark.yml `mr:` (default true); false ends the run at G2 approval with ready branches.
export function mrEnabled(): boolean {
  const mr = (Bun.YAML.parse(readFileSync(join(projectDir(), "ark.yml"), "utf8")) as { mr?: unknown } | null)?.mr;
  if (mr !== undefined && typeof mr !== "boolean") throw new Error("ark.yml: mr must be true or false");
  return mr !== false;
}

// The run folder and state, refusing (before anything is written) an event type that is illegal in the current state,
// or that another command owns: `via` is the owning command calling for its own event, `ark advance` passes none.
export function open(runId: string, type: string, via?: string) {
  const dir = runDir(runId);
  const state = project(readLedger(dir));
  const own = ownerOf(type);
  if (own && own !== via) throw new Error(`'${type}' is written by 'ark ${own}', not advance (state '${state.state}')`);
  const types = Object.keys(transitions[state.state]).map((k) => k.split(":")[0]);
  const legal = [...new Set(types.filter((t) => !ownerOf(t)))];
  if (!types.includes(type)) {
    const gate = state.state.match(/^awaiting_(g[012])$/)?.[1].toUpperCase();
    throw new Error(
      `illegal event '${type}' in state '${state.state}'; ${legal.length ? `legal: ${legal.join(", ")}` : "run is closed"}` +
        (gate ? `; ${gate} has no approving answer yet (ark gate answer)` : ""),
    );
  }
  return { dir, state };
}

// Read, append and project under one lock, so parallel writers cannot share a seq.
export const record = (dir: string, type: string, data: Record<string, unknown>) =>
  locked(dir, () => commit(dir, append(dir, readLedger(dir), type, data)));

// AC4: product changes count only through recorded implementer steps. Per repo, from `impl` (the last implementer head, or the heads a round start recorded; base_sha before any):
// - a non-test file changed in impl..HEAD is unattributed, whatever ran since (an `ark test` run records a head but never vouches for product code);
// - an AC-tagged test changed after the newest recorded head is unattributed. The validator's tagged tests count once `ark test` ran on them: that run records its head `test`,
//   accepted as a start for tagged tests only when impl..test changed test files alone;
// - HEAD must descend from the newest recorded head (history rewritten, a reset that drops recorded work), and the worktree must hold no uncommitted file.
// Untagged test files are free.
export function unattributed(dir: string, state: RunState, events: LedgerEvent[]): string[] {
  return state.repos.flatMap((r) => {
    const wt = join(dir, "ws", r.name);
    const { impl, test } = stepPoints(events, r);
    const descends = (from: string) => Bun.spawnSync(["git", "--no-replace-objects", "-C", wt, "merge-base", "--is-ancestor", from, "HEAD"]).exitCode === 0;
    try {
      const out: string[] = [];
      const newest = test ?? impl;
      if (!descends(newest)) {
        out.push(`${r.name}: HEAD is not a descendant of the recorded ${newest.slice(0, 12)}; history was rewritten after a recorded step`);
      } else {
        const cfg = loadRepo(wt, r.base_sha);
        const files = diffFiles(wt, `${impl}..HEAD`).filter((f) => !isTestFile(cfg, f));
        if (files.length) out.push(`${r.name}: commits after ${impl.slice(0, 12)} changed ${files.join(", ")}, which no implementer step recorded`);
        const testsOnly = test !== undefined && diffFiles(wt, `${impl}..${test}`).every((f) => isTestFile(cfg, f));
        const tests = touchedTaggedTests(wt, testsOnly ? test : impl, cfg);
        if (tests.length) out.push(`${r.name}: commits after ${(testsOnly ? test : impl).slice(0, 12)} changed AC-tagged tests ${tests.join(", ")}, which neither an implementer step nor an 'ark test' run recorded`);
      }
      const dirty = dirtyFiles(wt);
      if (dirty.length) out.push(`${r.name}: uncommitted files ${dirty.join(", ")}, which no implementer step recorded`);
      return out;
    } catch (e) {
      return [`${r.name}: cannot check for unrecorded changes: ${(e as Error).message}`];
    }
  });
}

// The HEAD of every worktree, recorded in the event that starts a round (fix_round.started, a G2 send-back, a GE answer that grants a round): the next implementer
// step is measured from it, so tests the validator committed in the round before are not the implementer's. Only the CLI writes it (advance refuses --data heads).
export const worktreeHeads = (dir: string, state: RunState): Record<string, string> =>
  Object.fromEntries(state.repos.map((r) => [r.name, git(join(dir, "ws", r.name), "rev-parse", "HEAD")]));

// `impl`: where the implementer step in progress began (the newest `implementer.completed` head or round-start head; base_sha before both).
// `test`: the newest head an `ark test` / red-green run recorded since then, if any. The implementer guard measures from `impl` alone.
function stepPoints(events: LedgerEvent[], repo: RunState["repos"][number]): { impl: string; test?: string } {
  let test: string | undefined;
  for (const e of events.toReversed()) {
    const heads = e.type === "fix_round.started" || e.type === "gate.answered" ? (e.data.heads as Record<string, string> | undefined) : undefined; // written by worktreeHeads
    const mine = e.data.repo === repo.name;
    if (mine && (e.type === "test.result" || e.type === "test.red_green") && typeof e.data.head_sha === "string") test ??= e.data.head_sha;
    const impl = mine && e.type === "implementer.completed" ? e.data.head_sha : heads?.[repo.name];
    if (typeof impl === "string") return { impl, test };
  }
  return { impl: repo.base_sha, test };
}

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
    return `resumed ${summary(refresh(join(runs, existing)))}`;
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

  const ts = new Date().toISOString();
  const dir = join(runs, `${ts.slice(0, 10)}-${id}`);
  mkdirSync(runs, { recursive: true });
  mkdirSync(dir); // not recursive: a concurrent start of the same ticket fails here
  copyFileSync(src, join(dir, "ticket.md"));
  writeFileSync(join(dir, "ticket.json"), ticketJson);
  writeFileSync(join(dir, "ac.yml"), acYml);
  writeFileSync(join(dir, "ledger.ndjson"), "");
  const state = locked(dir, () => {
    let events = append(dir, [], "run.started", { ticket: id, playbook: "ticket", acs: acs.map((a) => a.id), artifacts }, ts); // same ts as the folder name, so run_id matches it
    if (!acs.length) events = append(dir, events, "g0.opened", { reason: "ticket has no acceptance criteria" });
    return commit(dir, events);
  });
  setActive(basename(dir));
  return `started ${summary(state)}`;
}

export function advance(runId: string, type: string, rawData?: string): string {
  const { dir, state } = open(runId, type);
  let data: Record<string, unknown> = {};
  if (rawData !== undefined) {
    try { data = JSON.parse(rawData); } catch { throw new Error("--data is not valid JSON"); }
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("--data must be a JSON object");
    if (Object.hasOwn(data, "heads")) throw new Error("--data may not set 'heads': the CLI records the worktree heads itself when a round starts");
  }
  if (type === "build.completed" || type === "fix_round.started") { // AC4: nothing leaves building, or opens a round, that no recorded step vouches for
    const bad = unattributed(dir, state, readLedger(dir));
    if (bad.length) throw new Error(`${type} refused:\n${bad.map((b) => `  - ${b}`).join("\n")}`);
    if (type === "fix_round.started") data = { ...data, heads: worktreeHeads(dir, state) };
  }
  if (type === "implementer.completed") { // AC7: implementers never edit AC-tagged tests
    const repo = state.repos.find((r) => r.name === data.repo);
    if (!repo) throw new Error(`implementer.completed needs --data '{"repo":"<name>"}' naming a worktree of this run`);
    const wt = join(dir, "ws", repo.name);
    const dirty = dirtyFiles(wt);
    if (dirty.length) throw new Error(`${wt} has uncommitted changes (${dirty.join(", ")}); commit them so the check sees the whole step`);
    const from = stepPoints(readLedger(dir), repo).impl;
    if (Bun.spawnSync(["git", "--no-replace-objects", "-C", wt, "merge-base", "--is-ancestor", from, "HEAD"]).exitCode !== 0) throw new Error(`${wt} HEAD is not a descendant of the recorded ${from}; history was rewritten`);
    const hit = touchedTaggedTests(wt, from, loadRepo(wt, repo.base_sha)); // base config: the implementer cannot widen its own exemptions
    if (hit.length) throw new Error(`implementer step touches AC-tagged test files: ${hit.join(", ")}`);
    data = { repo: repo.name, head_sha: git(wt, "rev-parse", "HEAD") };
  }
  return `advanced ${summary(record(dir, type, data))}`;
}

// state.json recomputed from the ledger and rewritten when it differs: a crash between the append and the state write leaves it missing or stale.
function refresh(dir: string): RunState {
  return locked(dir, () => {
    const { state, bytes } = render(readLedger(dir));
    const file = join(dir, "state.json");
    if (!existsSync(file) || readFileSync(file, "utf8") !== bytes) writeState(dir, bytes);
    return state;
  });
}

export function replay(runId: string, checkOnly: boolean): string {
  const dir = runDir(runId);
  if (!checkOnly) {
    refresh(dir);
    return `replayed ${runId}\n`;
  }
  const { bytes } = render(readLedger(dir));
  const file = join(dir, "state.json");
  if (!existsSync(file) || readFileSync(file, "utf8") !== bytes) throw new Error(`state.json differs from ledger replay for ${runId}`);
  return `ok ${runId}\n`;
}
