import Ajv2020 from "ajv/dist/2020";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import implementerSchema from "../schemas/implementer.schema.json";
import reviewerSchema from "../schemas/reviewer.schema.json";
import validatorSchema from "../schemas/validator.schema.json";
import { git } from "./repo";
import { activeRunDir, append, commit, type LedgerEvent, locked, open, project, readLedger, record, runDir, type RunState, sha256, summary } from "./run";

const PLAYBOOKS = ["setup", "ticket", "bugfix", "investigate", "review", "resume"];

// FR-02 AC1: route and reason are the first ledger event. Empty-AC runs open G0 only after routing.
// With no run_id the active run (see cli/hook.ts) is used, matching the router's `ark log route <playbook> "<why>"`.
export function logRoute(args: string[]): string {
  const active = activeRunDir();
  const runId = args.length === 3 ? args[0] : active && basename(active);
  const [playbook, why] = args.slice(-2);
  if (!runId) throw new Error("no active run; pass the run id: ark log route <run_id> <playbook> \"<why>\"");
  if (!PLAYBOOKS.includes(playbook)) throw new Error(`unknown playbook '${playbook}'; expected ${PLAYBOOKS.join(", ")}`);
  if (!why?.trim()) throw new Error("route needs a reason");
  const { dir } = open(runId, "route.chosen", "log route");
  return locked(dir, () => {
    let events = readLedger(dir);
    if (events.some((e) => e.type === "route.chosen")) throw new Error("the route is already logged for this run");
    if (events.some((e) => e.type !== "run.started" && e.type !== "g0.opened")) throw new Error("route.chosen must be the first event after run.started");
    events = append(dir, events, "route.chosen", { playbook, reason: why.trim() });
    if (!Object.keys(project(events).acs).length) events = append(dir, events, "g0.opened", {});
    const state = commit(dir, events);
    return `routed ${summary(state)}`;
  });
}

// AC3: an agent's typed output is checked against its schema before it is kept under artifacts/<agent>/<n>.json.
const ajv = new Ajv2020();
const agentSchemas = { implementer: implementerSchema, validator: validatorSchema, reviewer: reviewerSchema };
const nextFile = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  return join(dir, `${Math.max(0, ...readdirSync(dir).map((f) => parseInt(f)).filter(Number.isInteger)) + 1}.json`);
};
const readJson = (file: string) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`${file}: ${(e as Error).message}`); }
};

export function artifactRecord(runId: string, agent: string, file: string): string {
  const schema = agentSchemas[agent as keyof typeof agentSchemas];
  if (!schema) throw new Error(`unknown agent '${agent}'; expected ${Object.keys(agentSchemas).join(", ")}`);
  const dir = runDir(runId);
  const value = readJson(file);
  const check = ajv.compile(schema);
  if (!check(value)) throw new Error(`${file} fails the ${agent} schema: ${ajv.errorsText(check.errors)}`);
  return locked(dir, () => { // reading the ledger first refuses a broken chain; the lock keeps the artifact numbering unique
    readLedger(dir);
    const out = nextFile(join(dir, "artifacts", agent));
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(out, bytes);
    return `${out.slice(dir.length + 1)} ${sha256(bytes)}\n`;
  });
}

// FR-14: every finding is bucketed with a reason. Only a verified finding sends work back (CONTEXT.md): an act-on P0 or P1 backed by a tagged test that the latest
// `ark test` at the current head recorded as failing, or, where no test can reach it, by a traced path, which the G2 packet marks as weaker evidence.
const PRIORITY = ["P0", "P1", "P2", "P3"];
const BUCKET = ["act_on", "consider", "noted", "dismissed"];
const KEYS = ["id", "reviewer", "model", "priority", "file", "line", "claim", "bucket", "reason", "evidence"];
const text = (v: unknown) => typeof v === "string" && v.trim() !== "";

// The latest recorded green-side outcome for each test at the repo's current HEAD wins across ark test modes.
function failingAtHead(dir: string, repos: RunState["repos"], events: LedgerEvent[]): string[] {
  return repos.flatMap((r) => {
    let head: string;
    try { head = git(join(dir, "ws", r.name), "rev-parse", "HEAD"); } catch { return []; }
    const status = new Map<string, { test: string; outcome: string }>();
    for (const e of events) {
      if (!["test.result", "test.red_green", "test.preservation"].includes(e.type) || e.data.repo !== r.name || e.data.head_sha !== head) continue;
      for (const t of e.data.tests as { suite?: string; test: string; status?: string; green?: string }[]) {
        const outcome = e.type === "test.result" ? t.status : t.green;
        if (typeof outcome === "string" && outcome !== "missing") status.set(`${t.suite ?? ""}\0${t.test}`, { test: t.test, outcome });
      }
    }
    return [...status.values()].filter(({ outcome }) => outcome === "failure" || outcome === "error").map(({ test }) => test);
  });
}

function checkFinding(f: unknown, at: string, failing: string[]): string[] {
  if (typeof f !== "object" || f === null || Array.isArray(f)) return [`${at}: not an object`];
  const o = f as Record<string, unknown>;
  const bad = Object.keys(o).filter((k) => !KEYS.includes(k)).map((k) => `${at}: unknown key '${k}'`);
  for (const k of ["id", "reviewer", "model", "file", "claim", "reason"]) if (!text(o[k])) bad.push(`${at}: ${k} must be a non-empty string`);
  if (!PRIORITY.includes(o.priority as string)) bad.push(`${at}: priority must be one of ${PRIORITY.join(", ")}`);
  if (!Number.isInteger(o.line) || (o.line as number) < 1) bad.push(`${at}: line must be a positive integer`);
  if (!BUCKET.includes(o.bucket as string)) bad.push(`${at}: bucket must be one of ${BUCKET.join(", ")}`);
  const ev = o.evidence;
  const proof = typeof ev === "object" && ev !== null && !Array.isArray(ev) ? (ev as Record<string, unknown>) : undefined;
  const fields = ["failing_test", "traced_path"];
  if (ev !== undefined && (!proof || !Object.keys(proof).length || Object.keys(proof).some((k) => !fields.includes(k)))) bad.push(`${at}: evidence must be {failing_test} or {traced_path}`);
  for (const field of fields) if (proof && field in proof && !text(proof[field])) bad.push(`${at}: evidence.${field} must be a non-empty string`);
  const named = proof?.failing_test;
  const validTest = text(named) && failing.some((t) => t === named || t.endsWith(` > ${named}`));
  const validPath = text(proof?.traced_path);
  if (text(named) && !validTest) {
    bad.push(`${at}: failing_test '${named}' is not a test that the latest 'ark test' at the current head recorded as failing (${failing.length ? `failing now: ${failing.join("; ")}` : "none failing now"}); run it with 'ark test', or give {traced_path} (weaker evidence)`);
  }
  if (o.bucket === "act_on" && (o.priority === "P0" || o.priority === "P1") && !validTest && !validPath) {
    bad.push(`${at}: act_on ${o.priority} goes back only with evidence {failing_test} or {traced_path}`);
  }
  return bad;
}

export function findingsRecord(runId: string, file: string): string {
  const { dir, state } = open(runId, "findings.recorded", "findings record");
  return locked(dir, () => { // numbering the artifact and recording it are one step, or parallel records overwrite each other's file
    const list = readJson(file);
    const events = readLedger(dir);
    const failing = failingAtHead(dir, state.repos, events);
    if (!Array.isArray(list) || !list.length) throw new Error(`${file} must be a non-empty JSON array of findings`);
    const prior = events.filter((e) => e.type === "findings.recorded");
    const seen = new Set(prior.flatMap((e) => e.data.ids as string[]));
    const bad = list.flatMap((f, i) => {
      const id = (f as { id?: unknown })?.id;
      const dup = typeof id === "string" && seen.has(id) ? [`finding ${i + 1}: id '${id}' is already recorded in this run`] : [];
      if (typeof id === "string") seen.add(id);
      return [...checkFinding(f, `finding ${i + 1}`, failing), ...dup];
    });
    if (bad.length) throw new Error(`${file} refused:\n${bad.map((b) => `  - ${b}`).join("\n")}`);

    const bytes = `${JSON.stringify(list, null, 2)}\n`;
    const out = nextFile(join(dir, "artifacts", "findings"));
    writeFileSync(out, bytes);
    const count = (b: string) => list.filter((f) => f.bucket === b).length;
    const blocking = list.filter((f) => f.bucket === "act_on" && (f.priority === "P0" || f.priority === "P1")).length;
    record(dir, "findings.recorded", {
      path: out.slice(dir.length + 1), sha256: sha256(bytes), ids: list.map((f) => f.id),
      buckets: Object.fromEntries(BUCKET.map((b) => [b, count(b)])), blocking,
    });
    return `recorded ${list.length} findings (${BUCKET.map((b) => `${b} ${count(b)}`).join(", ")}); open act_on P0/P1: ${blocking}\n`;
  });
}
