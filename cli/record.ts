import Ajv2020 from "ajv/dist/2020";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import implementerSchema from "../schemas/implementer.schema.json";
import reviewerSchema from "../schemas/reviewer.schema.json";
import validatorSchema from "../schemas/validator.schema.json";
import { activeRunDir, locked, open, readLedger, record, runDir, sha256, summary } from "./run";

const PLAYBOOKS = ["setup", "ticket", "bugfix", "investigate", "review", "resume"];

// FR-02 AC1: the route and its reason are the first ledger event. `ark run start` writes run.started (and g0.opened for a ticket with no ACs); nothing else may precede this.
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
    const events = readLedger(dir);
    if (events.some((e) => e.type === "route.chosen")) throw new Error("the route is already logged for this run");
    if (events.some((e) => e.type !== "run.started" && e.type !== "g0.opened")) throw new Error("route.chosen must be the first event after run.started");
    return `routed ${summary(record(dir, "route.chosen", { playbook, reason: why.trim() }))}`;
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
  const out = nextFile(join(dir, "artifacts", agent));
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(out, bytes);
  return `${out.slice(dir.length + 1)} ${sha256(bytes)}\n`;
}

// FR-14: every finding is bucketed with a reason; an Act-on P0 or P1 goes back only with a failing test or a traced path.
const PRIORITY = ["P0", "P1", "P2", "P3"];
const BUCKET = ["act_on", "consider", "noted", "dismissed"];
const KEYS = ["id", "reviewer", "model", "priority", "file", "line", "claim", "bucket", "reason", "evidence"];
const text = (v: unknown) => typeof v === "string" && v.trim() !== "";

function checkFinding(f: unknown, at: string): string[] {
  if (typeof f !== "object" || f === null || Array.isArray(f)) return [`${at}: not an object`];
  const o = f as Record<string, unknown>;
  const bad = Object.keys(o).filter((k) => !KEYS.includes(k)).map((k) => `${at}: unknown key '${k}'`);
  for (const k of ["id", "reviewer", "model", "file", "claim", "reason"]) if (!text(o[k])) bad.push(`${at}: ${k} must be a non-empty string`);
  if (!PRIORITY.includes(o.priority as string)) bad.push(`${at}: priority must be one of ${PRIORITY.join(", ")}`);
  if (!Number.isInteger(o.line) || (o.line as number) < 1) bad.push(`${at}: line must be a positive integer`);
  if (!BUCKET.includes(o.bucket as string)) bad.push(`${at}: bucket must be one of ${BUCKET.join(", ")}`);
  const ev = o.evidence;
  const proof = typeof ev === "object" && ev !== null && !Array.isArray(ev) ? (ev as Record<string, unknown>) : undefined;
  if (ev !== undefined && (!proof || Object.keys(proof).some((k) => k !== "failing_test" && k !== "trace_path"))) bad.push(`${at}: evidence must be {failing_test} or {trace_path}`);
  const proven = text(proof?.failing_test) || text(proof?.trace_path);
  if (ev !== undefined && proof && !proven) bad.push(`${at}: evidence needs a non-empty failing_test or trace_path`);
  if (o.bucket === "act_on" && (o.priority === "P0" || o.priority === "P1") && !proven) bad.push(`${at}: act_on ${o.priority} goes back only with evidence {failing_test} or {trace_path}`);
  return bad;
}

export function findingsRecord(runId: string, file: string): string {
  const { dir } = open(runId, "findings.recorded", "findings record");
  return locked(dir, () => { // numbering the artifact and recording it are one step, or parallel records overwrite each other's file
    const list = readJson(file);
    if (!Array.isArray(list) || !list.length) throw new Error(`${file} must be a non-empty JSON array of findings`);
    const prior = readLedger(dir).filter((e) => e.type === "findings.recorded");
    const seen = new Set(prior.flatMap((e) => e.data.ids as string[]));
    const bad = list.flatMap((f, i) => {
      const id = (f as { id?: unknown })?.id;
      const dup = typeof id === "string" && seen.has(id) ? [`finding ${i + 1}: id '${id}' is already recorded in this run`] : [];
      if (typeof id === "string") seen.add(id);
      return [...checkFinding(f, `finding ${i + 1}`), ...dup];
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
