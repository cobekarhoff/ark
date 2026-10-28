import Ajv2020 from "ajv/dist/2020";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import acceptanceCriteriaSchema from "../schemas/ac.schema.json";
import frontmatterSchema from "../schemas/ticket-frontmatter.schema.json";
import ledgerSchema from "../schemas/ledger-event.schema.json";
import stateSchema from "../schemas/state.schema.json";
import ticketSchema from "../schemas/ticket.schema.json";
import { bindSession, claimHumanAsk } from "./binding";
import { confirmHuman, verifyHumanProof } from "./human";
import { preflight } from "./preflight";
import { diffFiles, dirtyFiles, git, isTestFile, loadRepo, touchedTaggedTests } from "./repo";
import { eventKey, nextActions, ownerOf, type State, transitions } from "./transitions";

export type LedgerEvent = { seq: number; ts: string; type: string; data: Record<string, unknown>; prev: string };
type AcceptanceCriterion = { id: string; text: string };
type Frontmatter = { id: string; title: string; status: string; milestone?: string; traces?: string[]; depends_on?: string[]; acceptance_criteria?: AcceptanceCriterion[] };
type RunStarted = { ticket: string; n: number; playbook: string; acs: string[]; artifacts: Record<string, string> };
type AcceptanceCriteriaUpdated = { acs: string[]; artifacts: Record<string, string> };
export type Outcome = "merged" | "abandoned" | "aborted" | "handed_off";

export interface RunState {
  schema: 1;
  run_id: string;
  ticket: string;
  playbook: string;
  state: State;
  status: "active" | "waiting_human" | "done" | "aborted";
  outcome: Outcome | null; // how a closed run ended; null while it is open
  tier: null;
  round: number; // returns to implementation so far: fix rounds, evidence send-backs, escalations that granted one more round
  implementer: "agent" | "human"; // a human takes over at an escalation, and stays the implementer until one more round is granted
  next_action: { kind: string; agent: "orchestrator" | "human"; repo?: string } | null;
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
  Object.entries({ ac: acceptanceCriteriaSchema, frontmatter: frontmatterSchema, ledger: ledgerSchema, state: stateSchema, ticket: ticketSchema })
    .map(([name, schema]) => [name, ajv.compile(schema)]),
);
export const check = (schema: string, value: unknown, what: string) => {
  const validator = validators[schema];
  if (!validator(value)) throw new Error(`${what} fails ${schema} schema: ${ajv.errorsText(validator.errors)}`);
};

const TICKET_ID = /^[A-Z][A-Z0-9]*-[0-9]+$/;
export const sha256 = (bytes: string | Uint8Array) => `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// The directory holding the nearest ark.yml (the project's root repo).
export function projectDirectory(): string {
  for (let directory = process.cwd(); ; directory = dirname(directory)) {
    if (existsSync(join(directory, "ark.yml"))) return directory;
    if (directory === dirname(directory)) throw new Error(`no ark.yml found from ${process.cwd()} upward`);
  }
}

export function projectRoot(): string {
  const file = join(projectDirectory(), "ark.yml");
  const name = (Bun.YAML.parse(readFileSync(file, "utf8")) as { project?: unknown } | null)?.project;
  if (typeof name !== "string" || !name) throw new Error(`${file} has no 'project:' key`);
  return join(process.env.ARK_HOME ?? join(homedir(), ".ark"), "projects", name);
}
// <date>-<ticket>-<n>: the nth run of a ticket.
const RUN_ID = /^(\d{4}-\d{2}-\d{2})-([A-Z][A-Z0-9]*-[0-9]+)-([1-9][0-9]*)$/;
const runNumber = (runId: string) => Number(runId.match(RUN_ID)![3]);
export function runDirectory(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id '${runId}'`);
  const directory = join(projectRoot(), "runs", runId);
  if (!existsSync(directory)) throw new Error(`no such run '${runId}'`);
  return directory;
}

// Active run = the run id in <project>/active-run, written by `ark run start`; a done or aborted run no longer binds the session (ARK-108 hook).
export function setActive(runId: string) {
  writeFileSync(join(projectRoot(), "active-run"), `${runId}\n`);
  bindSession(join(projectRoot(), "runs", runId)); // the session that starts or resumes a run is bound to it (ARK-115 AC10)
}

export function activeRunDirectory(): string | undefined {
  let root: string;
  try { root = projectRoot(); } catch { return undefined; } // no ark.yml: not an Ark project
  const activeRunFile = join(root, "active-run");
  if (!existsSync(activeRunFile)) return undefined;
  const directory = join(root, "runs", readFileSync(activeRunFile, "utf8").trim());
  if (!existsSync(directory)) return undefined;
  // The ledger decides whether the run is open, not the cached state.json: editing state.json must not lift the hook's protection.
  // A ledger that cannot be replayed (broken chain, bad line) keeps the run guarded.
  let status = "active";
  try { status = project(readLedger(directory)).status; } catch { /* guarded */ }
  return status === "done" || status === "aborted" ? undefined : directory;
}

// The projection: state.json is a pure function of the ledger.
export function project(events: LedgerEvent[]): RunState {
  const first = events[0];
  if (first?.type !== "run.started") throw new Error("ledger must begin with run.started");
  const { ticket, n: runNumber, playbook, acs: runCriteria, artifacts: runArtifacts } = first.data as RunStarted;
  if (!Number.isInteger(runNumber) || runNumber < 1) throw new Error("run.started needs a positive numbered run n");
  let acceptanceCriteria = runCriteria;
  let artifacts = runArtifacts;
  let state: State = "intake";
  const repositories: RunState["repos"] = [];
  const gates: RunState["gates"] = {};
  let round = 0;
  let implementer: RunState["implementer"] = "agent";
  let outcome: Outcome | null = null;
  let roundStart = 0; // seq of the newest event that sent the run back to building; a human implementer has a step to record per repo after it
  const stepAt: Record<string, number> = {};
  let routeChosen = false;
  let mergeRequestOpened = false;
  for (const [i, event] of events.entries()) {
    if (event.seq !== i + 1) throw new Error(`ledger seq ${event.seq} at position ${i + 1}`);
    if (i === 0) continue;
    if (!routeChosen && event.type !== "route.chosen") throw new Error(`ledger event ${event.seq} '${event.type}' is illegal before route.chosen`);
    if (event.type === "route.chosen" && routeChosen) throw new Error(`ledger event ${event.seq} duplicates route.chosen`);
    if (state === "merge_requests_open" && event.type === "abort" && mergeRequestOpened) {
      throw new Error(`ledger event ${event.seq} 'abort' is illegal after a merge request was opened; close the run as merged or abandoned`);
    }
    const row = transitions[state] as Record<string, State>;
    const next = Object.hasOwn(row, eventKey(event)) ? row[eventKey(event)] : undefined;
    if (!next) throw new Error(`ledger event ${event.seq} '${event.type}' is illegal in '${state}'`);
    state = next;
    if (event.type === "route.chosen") routeChosen = true;
    if (event.type === "merge_request.opened") mergeRequestOpened = true;
    const eventData = event.data as { repo: string; branch: string; base_sha: string; head_sha: string };
    if (event.type === "worktree.created") repositories.push({ name: eventData.repo, order: repositories.length + 1, branch: eventData.branch, base_sha: eventData.base_sha, head_sha: null, step: "pending" });
    if (event.type === "implementer.completed") {
      const repository = repositories.find((repository) => repository.name === eventData.repo);
      if (!repository) throw new Error(`ledger event ${event.seq} names unknown repo '${eventData.repo}'`);
      Object.assign(repository, { head_sha: eventData.head_sha, step: "implemented" });
      stepAt[eventData.repo] = event.seq;
    }
    if (event.type === "fix_round.started") {
      round++;
      roundStart = event.seq;
    }
    if (event.type === "acceptance_criteria.updated") ({ acs: acceptanceCriteria, artifacts } = event.data as AcceptanceCriteriaUpdated);
    if (event.type === "run.closed") {
      outcome = (event.data as { outcome: Outcome }).outcome;
      if (!["merged", "abandoned", "handed_off"].includes(outcome)) throw new Error(`ledger event ${event.seq} 'run.closed' needs an outcome of merged, abandoned or handed_off`);
      if (outcome === "abandoned" && !mergeRequestOpened) throw new Error(`ledger event ${event.seq} cannot abandon a run before any merge request was opened`);
    }
    if (event.type === "gate.answered") {
      const { gate, answer, by, packet_sha256 } = event.data as Record<string, string>;
      gates[gate] = { answer, by, at: event.ts, packet_sha256 };
      // An escalated evidence send-back (round budget spent) leads only to the escalation packet: it is not a return to implementation, so it is no round.
      const sendsBack = (gate === "evidence" && answer === "send_back" && event.data.escalated !== true) || (gate === "escalation" && answer === "one_more_round");
      if (sendsBack || (gate === "escalation" && answer === "take_over")) round++;
      if (sendsBack || (gate === "escalation" && answer === "take_over")) roundStart = event.seq;
      if (gate === "escalation" && answer !== "abort") implementer = answer === "take_over" ? "human" : "agent";
    }
  }
  if (state === "aborted") outcome = "aborted";
  // In merge_requests_open the orchestrator has to open the merge requests (ark merge-request open) until every repo has one; only then does a human merge.
  const mergeRequestsPending = state === "merge_requests_open" && !repositories.every((repository) => events.some((event) => event.type === "merge_request.opened" && event.data.repo === repository.name));
  const taken = state === "building" && implementer === "human" ? repositories.find((repository) => (stepAt[repository.name] ?? 0) < roundStart) : undefined; // the human implements until every repo has a recorded step
  const next_action = mergeRequestsPending ? { kind: "open_merge_requests", agent: "orchestrator" as const } : taken ? { kind: "implement", agent: "human" as const, repo: taken.name } : nextActions[state];
  return {
    schema: 1,
    run_id: `${first.ts.slice(0, 10)}-${ticket}-${runNumber}`,
    ticket,
    playbook,
    state,
    status: next_action === null ? (state as "done" | "aborted") : next_action.agent === "human" ? "waiting_human" : "active",
    outcome,
    tier: null,
    round,
    implementer,
    next_action,
    gates,
    repos: repositories,
    acs: Object.fromEntries(acceptanceCriteria.map((id) => [id, "pending"])),
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
const line = (event: LedgerEvent) => JSON.stringify(event);
function chainHash(event?: LedgerEvent) {
  return sha256(event ? line(event) : "");
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
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
function lockOwner(file: string): { pid: number; started: string; token: string } | undefined {
  try {
    const owner = JSON.parse(readFileSync(file, "utf8"));
    return typeof owner?.pid === "number" && typeof owner.token === "string" ? owner : undefined;
  } catch { return undefined; }
}
function abandoned(lock: string): boolean {
  const owner = lockOwner(lock);
  if (owner) return !alive(owner.pid);
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

export function locked<T>(directory: string, operation: () => T): T {
  if (held.has(directory)) return operation();
  const lock = join(directory, "ledger.lock");
  const token = crypto.randomUUID();
  const startedAt = Date.now();
  for (;;) {
    try { writeFileSync(lock, JSON.stringify({ pid: process.pid, started, token }), { flag: "wx" }); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (abandoned(lock)) { reap(lock); continue; }
    if (Date.now() - startedAt > LOCK_WAIT_MS) {
      const owner = lockOwner(lock);
      throw new Error(`${lock} is held by ${owner ? `pid ${owner.pid} (started ${owner.started})` : "another ark process"}; delete it if that process is not running`);
    }
    Bun.sleepSync(5);
  }
  held.add(directory);
  try { return operation(); } finally { held.delete(directory); if (lockOwner(lock)?.token === token) rmSync(lock, { force: true }); }
}

const anchor = (directory: string): { ledger_seq?: unknown; ledger_head?: unknown } => {
  try { return JSON.parse(readFileSync(join(directory, "state.json"), "utf8")); } catch { return {}; } // missing or unreadable: nothing to anchor to
};

export const readLedger = (directory: string): LedgerEvent[] =>
  locked(directory, () => {
    const lines = readFileSync(join(directory, "ledger.ndjson"), "utf8").split("\n");
    const tail = lines.pop(); // "" after the final newline
    const events: LedgerEvent[] = [];
    for (const [i, ledgerLine] of lines.entries()) {
      const at = i + 1;
      let event: LedgerEvent;
      try { event = JSON.parse(ledgerLine); } catch { throw broken(at, "the line is not valid JavaScript Object Notation (JSON)"); }
      check("ledger", event, `ledger seq ${at}`);
      if (event.seq !== at) throw broken(at, `found seq ${event.seq} where seq ${at} belongs (a line was removed, added or reordered)`);
      if (line(event) !== ledgerLine) throw broken(at, "the line is not in the form the CLI writes");
      if (event.prev !== chainHash(events.at(-1))) throw broken(Math.max(1, at - 1), `seq ${at} records a different hash for it, so it was edited or removed`);
      events.push(event);
    }
    if (tail) throw broken(lines.length + 1, "the final line is cut off");
    const { ledger_seq: recordedEventCount, ledger_head: head } = anchor(directory);
    if (typeof recordedEventCount === "number" && typeof head === "string") {
      if (recordedEventCount > events.length) throw broken(events.length + 1, `state.json records ${recordedEventCount} events but the ledger ends at seq ${events.length}; the tail was removed`);
      if (recordedEventCount > 0 && chainHash(events[recordedEventCount - 1]) !== head) throw broken(recordedEventCount, "it no longer matches the hash state.json recorded");
    }
    return events;
  });

// Validates the event and the state it projects to before anything is written, so a failure leaves the ledger untouched.
// The caller holds the lock and read `events` under it (record, or locked around a read and this).
export function append(directory: string, events: LedgerEvent[], type: string, data: Record<string, unknown>, timestamp = new Date().toISOString()): LedgerEvent[] {
  if (!held.has(directory)) throw new Error("append needs the ledger lock");
  const event: LedgerEvent = { seq: events.length + 1, ts: timestamp, type, data, prev: chainHash(events.at(-1)) };
  check("ledger", event, `event '${type}'`);
  const next = [...events, event];
  render(next);
  appendFileSync(join(directory, "ledger.ndjson"), `${line(event)}\n`);
  return next;
}

const render = (events: LedgerEvent[]) => {
  const state = project(events);
  check("state", state, "state");
  return { state, bytes: json(state) };
};

// Written beside and renamed over, so a reader (the hook) never sees half a state.json.
const writeState = (directory: string, bytes: string) => {
  const temporaryFile = join(directory, "state.json.tmp");
  writeFileSync(temporaryFile, bytes);
  renameSync(temporaryFile, join(directory, "state.json"));
};

export function commit(directory: string, events: LedgerEvent[]) {
  const { state, bytes } = render(events);
  writeState(directory, bytes);
  return state;
}

const arkYml = () => (Bun.YAML.parse(readFileSync(join(projectDirectory(), "ark.yml"), "utf8")) ?? {}) as { merge_requests?: unknown; loop?: { max_rounds?: unknown } };

// ark.yml `merge_requests:` (default true); false ends the run at evidence approval with ready branches, handed off.
export function mergeRequestsEnabled(): boolean {
  const { merge_requests: mergeRequests } = arkYml();
  if (mergeRequests !== undefined && typeof mergeRequests !== "boolean") throw new Error("ark.yml: merge_requests must be true or false");
  return mergeRequests !== false;
}

// ark.yml `loop.max_rounds` (default 2): the round budget. Once state.round reaches it, the next failure opens escalation.
export function maxRounds(): number {
  const roundLimit = arkYml().loop?.max_rounds;
  if (roundLimit === undefined) return 2;
  if (typeof roundLimit !== "number" || !Number.isInteger(roundLimit) || roundLimit < 0) throw new Error("ark.yml: loop.max_rounds must be a whole number, 0 or more");
  return roundLimit;
}

// The run folder and state, refusing (before anything is written) an event type that is illegal in the current state,
// or that another command owns: `via` is the owning command calling for its own event, `ark advance` passes none.
export function open(runId: string, type: string, via?: string) {
  const directory = runDirectory(runId);
  const events = readLedger(directory);
  const state = project(events);
  if (!events.some((event) => event.type === "route.chosen") && type !== "route.chosen") throw new Error(`illegal event '${type}' before route.chosen`);
  if (events.some((event) => event.type === "route.chosen") && type === "route.chosen") throw new Error("the route is already logged for this run");
  if (state.state === "merge_requests_open" && type === "abort" && events.some((event) => event.type === "merge_request.opened")) {
    throw new Error("cannot abort after a merge request was opened; close the run as merged or abandoned");
  }
  const owner = ownerOf(type);
  if (owner && owner !== via) throw new Error(`'${type}' is written by 'ark ${owner}', not advance (state '${state.state}')`);
  const types = Object.keys(transitions[state.state]).map((key) => key.split(":")[0]);
  const legal = [...new Set(types.filter((eventType) => !ownerOf(eventType)))];
  if (!types.includes(type)) {
    const gate = state.state.match(/^awaiting_(criteria|plan|evidence)$/)?.[1];
    throw new Error(
      `illegal event '${type}' in state '${state.state}'; ${legal.length ? `legal: ${legal.join(", ")}` : "run is closed"}` +
        (gate ? `; ${gate} has no approving answer yet (ark gate answer)` : ""),
    );
  }
  return { directory, state };
}

// Read, append and project under one lock, so parallel writers cannot share a seq.
export const record = (directory: string, type: string, data: Record<string, unknown>) =>
  locked(directory, () => commit(directory, append(directory, readLedger(directory), type, data)));

// AC4: product changes count only through recorded implementer steps. Per repo, from `implementationHead` (the last implementer head, or the heads a round start recorded; base_sha before any):
// - a non-test file changed in implementationHead..HEAD is unattributed, whatever ran since (an `ark test` run records a head but never vouches for product code);
// - an AC-tagged test changed after the newest recorded head is unattributed. The validator's tagged tests count once a validator step (`ark test --as validator`) ran on them:
//   that run records its head `test` and its role, and is accepted as a start for tagged tests only when implementationHead..validatorHead changed test files alone. A plain `ark test` run vouches for nothing;
// - HEAD must descend from the newest recorded head (history rewritten, a reset that drops recorded work), and the worktree must hold no uncommitted file.
// Untagged test files are free.
export function unattributed(directory: string, state: RunState, events: LedgerEvent[]): string[] {
  return state.repos.flatMap((repository) => {
    const worktree = join(directory, "worktrees", repository.name);
    const { implementationHead, validatorHead } = stepPoints(events, repository);
    const descends = (from: string) => Bun.spawnSync(["git", "--no-replace-objects", "-C", worktree, "merge-base", "--is-ancestor", from, "HEAD"]).exitCode === 0;
    try {
      const out: string[] = [];
      const newest = validatorHead ?? implementationHead;
      if (!descends(newest)) {
        out.push(`${repository.name}: HEAD is not a descendant of the recorded ${newest.slice(0, 12)}; history was rewritten after a recorded step`);
      } else {
        const repoConfig = loadRepo(worktree, repository.base_sha);
        const files = diffFiles(worktree, `${implementationHead}..HEAD`).filter((file) => !isTestFile(repoConfig, file));
        if (files.length) out.push(`${repository.name}: commits after ${implementationHead.slice(0, 12)} changed ${files.join(", ")}, which no implementer step recorded`);
        const testsOnly = validatorHead !== undefined && diffFiles(worktree, `${implementationHead}..${validatorHead}`).every((file) => isTestFile(repoConfig, file));
        const tests = touchedTaggedTests(worktree, testsOnly ? validatorHead : implementationHead, repoConfig);
        if (tests.length) out.push(`${repository.name}: commits after ${(testsOnly ? validatorHead : implementationHead).slice(0, 12)} changed acceptance criterion (AC)-tagged tests ${tests.join(", ")}, which neither an implementer step nor a validator step ('ark test --as validator') recorded`);
      }
      const dirty = dirtyFiles(worktree);
      if (dirty.length) out.push(`${repository.name}: uncommitted files ${dirty.join(", ")}, which no implementer step recorded`);
      return out;
    } catch (error) {
      return [`${repository.name}: cannot check for unrecorded changes: ${(error as Error).message}`];
    }
  });
}

// The HEAD of every worktree, recorded in the event that starts a round (fix_round.started, an evidence send-back, an escalation answer that grants a round): the next implementer
// step is measured from it, so tests the validator committed in the round before are not the implementer's. Only the CLI writes it (advance refuses --data heads).
export const worktreeHeads = (directory: string, state: RunState): Record<string, string> =>
  Object.fromEntries(state.repos.map((repository) => [repository.name, git(join(directory, "worktrees", repository.name), "rev-parse", "HEAD")]));

// `implementationHead`: where the implementer step in progress began (the newest implementer head or round-start head).
// A refused tagged-test step blocks validator attribution until a later accepted implementer step.
function stepPoints(events: LedgerEvent[], repository: RunState["repos"][number]): { implementationHead: string; validatorHead?: string } {
  let validatorHead: string | undefined;
  let validatorBlocked = false;
  for (const event of events.toReversed()) {
    const heads = event.type === "fix_round.started" || event.type === "gate.answered" ? (event.data.heads as Record<string, string> | undefined) : undefined;
    const mine = event.data.repo === repository.name;
    if (mine && event.type === "implementer.refused") {
      validatorBlocked = true;
      validatorHead = undefined;
    }
    if (mine && event.type.startsWith("test.") && event.data.role === "validator" && typeof event.data.head_sha === "string" && !validatorBlocked && validatorHead === undefined) {
      validatorHead = event.data.head_sha;
    }
    const implementationHead = mine && event.type === "implementer.completed" ? event.data.head_sha : heads?.[repository.name];
    if (typeof implementationHead === "string") return { implementationHead, validatorHead };
  }
  return { implementationHead: repository.base_sha, validatorHead };
}

export function summary(state: RunState): string {
  const nextAction = state.next_action;
  return `${state.run_id}\nstate: ${state.state}\nstatus: ${state.status}\n${state.outcome ? `outcome: ${state.outcome}\n` : ""}next_action: ${nextAction ? `${nextAction.kind} (${nextAction.agent})` : "none"}\n`;
}

export interface TicketFiles { source: string; raw: string; acs: AcceptanceCriterion[]; ticketJson: string }

// The ticket as `ark run start` and `ark acceptance-criteria update` read it from the project's tickets folder.
export function readTicket(id: string): TicketFiles {
  const source = join(projectRoot(), "tickets", `${id}.md`);
  if (!existsSync(source)) throw new Error(`no ticket file ${source}`);
  const raw = readFileSync(source, "utf8");
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontmatterMatch) throw new Error(`${source} has no frontmatter`);
  const frontmatter = Bun.YAML.parse(frontmatterMatch[1]) as Frontmatter; // validated on the next line
  check("frontmatter", frontmatter, source);
  if (frontmatter.id !== id) throw new Error(`${source} has id '${frontmatter.id}', expected '${id}'`);

  const acceptanceCriteria = frontmatter.acceptance_criteria ?? [];
  const ticket = {
    id: frontmatter.id, title: frontmatter.title, source: "local", status: frontmatter.status, milestone: frontmatter.milestone,
    traces: frontmatter.traces, depends_on: frontmatter.depends_on, acceptance_criteria: acceptanceCriteria, body: frontmatterMatch[2],
  };
  check("ticket", ticket, "ticket.json");
  check("ac", acceptanceCriteria, "ac.yml");
  return { source, raw, acs: acceptanceCriteria, ticketJson: json(ticket) };
}

export const acceptanceCriteriaYaml = (acceptanceCriteria: unknown[]) => (acceptanceCriteria.length ? Bun.YAML.stringify(acceptanceCriteria, null, 2) : "[]\n");

export function start(id: string): string {
  if (!TICKET_ID.test(id ?? "")) throw new Error(`invalid ticket id '${id}'`);
  preflight();
  const runs = join(projectRoot(), "runs");
  mkdirSync(runs, { recursive: true });
  const ticketLock = join(runs, ".locks", id);
  mkdirSync(ticketLock, { recursive: true });
  return locked(ticketLock, () => {
    // A ticket has many runs and at most one is open: resume it, or start run n+1 when every earlier run is closed.
    const mine = readdirSync(runs).filter((runId) => RUN_ID.exec(runId)?.[2] === id).sort((criterion, b) => runNumber(b) - runNumber(criterion));
    for (const runId of mine) {
      const state = refresh(join(runs, runId));
      if (state.status === "done" || state.status === "aborted") continue;
      setActive(runId);
      return `resumed ${summary(state)}${routeLine(join(runs, runId), state.run_id)}`;
    }
    const { source, raw, acs: acceptanceCriteria, ticketJson } = readTicket(id);
    const acceptanceCriteriaYml = acceptanceCriteriaYaml(acceptanceCriteria);
    const artifacts = { "ticket.md": sha256(raw), "ticket.json": sha256(ticketJson), "ac.yml": sha256(acceptanceCriteriaYml) };
    const timestamp = new Date().toISOString();
    const nextRunNumber = mine.length ? runNumber(mine[0]) + 1 : 1;
    const directory = join(runs, `${timestamp.slice(0, 10)}-${id}-${nextRunNumber}`);
    mkdirSync(directory);
    copyFileSync(source, join(directory, "ticket.md"));
    writeFileSync(join(directory, "ticket.json"), ticketJson);
    writeFileSync(join(directory, "ac.yml"), acceptanceCriteriaYml);
    writeFileSync(join(directory, "ledger.ndjson"), "");
    const state = locked(directory, () => commit(directory, append(directory, [], "run.started", { ticket: id, n: nextRunNumber, playbook: "ticket", acs: acceptanceCriteria.map((criterion) => criterion.id), artifacts }, timestamp)));
    setActive(basename(directory));
    return `started ${summary(state)}${routeLine(directory, state.run_id)}`;
  });
}

// The route is the first event after run.started; a run interrupted before it was logged still lacks it when resumed.
function routeLine(directory: string, runId: string): string {
  const route = readLedger(directory).find((event) => event.type === "route.chosen");
  return route ? `route: ${route.data.playbook}\n` : `route: none (log it: ark log route ${runId} <playbook> "<why>")\n`;
}

export function advance(runId: string, type: string, rawData?: string): string {
  const { directory, state } = open(runId, type);
  let data: Record<string, unknown> = {};
  if (rawData !== undefined) {
    try { data = JSON.parse(rawData); } catch { throw new Error("--data is not valid JavaScript Object Notation (JSON)"); }
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("--data must be a JavaScript Object Notation (JSON) object");
    if (Object.hasOwn(data, "heads")) throw new Error("--data may not set 'heads': the CLI records the worktree heads itself when a round starts");
  }
  if (type === "fix_round.started" && state.round >= maxRounds()) {
    throw new Error(`round budget spent (${state.round} of ${maxRounds()} rounds used): the next failure opens escalation; run 'ark gate packet ${runId} escalation'`);
  }
  if (type === "build.completed" || type === "fix_round.started") { // AC4: nothing leaves building, or opens a round, that no recorded step vouches for
    const bad = unattributed(directory, state, readLedger(directory));
    if (bad.length) throw new Error(`${type} refused:\n${bad.map((b) => `  - ${b}`).join("\n")}`);
    if (type === "fix_round.started") data = { ...data, heads: worktreeHeads(directory, state) };
  }
  if (type === "implementer.completed") {
    const repository = state.repos.find((repository) => repository.name === data.repo);
    if (!repository) throw new Error(`implementer.completed needs --data '{"repo":"<name>"}' naming a worktree of this run`);
    const worktree = join(directory, "worktrees", repository.name);
    const head = git(worktree, "rev-parse", "HEAD");
    const action = `implementer.completed:${repository.name}`;
    const packet = sha256(head);
    try {
      const identity = state.implementer === "human" ? confirmHuman(directory, runId, action, "confirm", packet, ["confirm", "abort"]) : undefined;
      return locked(directory, () => {
        const events = readLedger(directory);
        const current = project(events);
        if (current.state !== "building" || current.implementer !== state.implementer) throw new Error("implementer step refused: run state or implementer changed during confirmation");
        if (git(worktree, "rev-parse", "HEAD") !== head) throw new Error(`${worktree} HEAD changed during human confirmation; confirm the current step again`);
        const dirty = dirtyFiles(worktree);
        if (dirty.length) throw new Error(`${worktree} has uncommitted changes (${dirty.join(", ")}); commit them so the check sees the whole step`);
        const from = stepPoints(events, repository).implementationHead;
        if (Bun.spawnSync(["git", "--no-replace-objects", "-C", worktree, "merge-base", "--is-ancestor", from, head]).exitCode !== 0) throw new Error(`${worktree} HEAD is not a descendant of the recorded ${from}; history was rewritten`);
        if (identity && !verifyHumanProof(directory, runId, action, "confirm", packet, ["confirm", "abort"], identity)) {
          throw new Error("human confirmation proof is no longer valid for this implementer step");
        }
        if (identity && (!identity.question || !identity.ask_call_id || !claimHumanAsk(identity.question, identity.ask_call_id))) {
          throw new Error("human confirmation was already used for a ledger event");
        }
        const hit = touchedTaggedTests(worktree, from, loadRepo(worktree, repository.base_sha));
        if (hit.length) throw new Error(`implementer step touches acceptance criterion (AC)-tagged test files: ${hit.join(", ")}`);
        const recorded = append(directory, events, type, { repo: repository.name, head_sha: head, packet_sha256: packet, action, ...(identity ?? { by: "agent" }) });
        return `advanced ${summary(commit(directory, recorded))}`;
      });
    } catch (error) {
      // A refused step stays on the ledger: stepPoints keeps the validator attribution barrier up until a later accepted step (AC10), whatever the refusal was.
      locked(directory, () => {
        const events = readLedger(directory);
        if (project(events).state === "building") commit(directory, append(directory, events, "implementer.refused", { repo: repository.name, head_sha: head, packet_sha256: packet, action, reason: (error as Error).message }));
      });
      throw error;
    }
  }
  return `advanced ${summary(record(directory, type, data))}`;
}

// state.json recomputed from the ledger and rewritten when it differs: a crash between the append and the state write leaves it missing or stale.
function refresh(directory: string): RunState {
  return locked(directory, () => {
    const { state, bytes } = render(readLedger(directory));
    const file = join(directory, "state.json");
    if (!existsSync(file) || readFileSync(file, "utf8") !== bytes) writeState(directory, bytes);
    return state;
  });
}

export function replay(runId: string, checkOnly: boolean): string {
  const directory = runDirectory(runId);
  if (!checkOnly) {
    refresh(directory);
    return `replayed ${runId}\n`;
  }
  const { bytes } = render(readLedger(directory));
  const file = join(directory, "state.json");
  if (!existsSync(file) || readFileSync(file, "utf8") !== bytes) throw new Error(`state.json differs from ledger replay for ${runId}`);
  return `ok ${runId}\n`;
}
