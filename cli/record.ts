import Ajv2020 from "ajv/dist/2020";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import implementerSchema from "../schemas/implementer.schema.json";
import reviewerSchema from "../schemas/reviewer.schema.json";
import validatorSchema from "../schemas/validator.schema.json";
import { git } from "./repo";
import { activeRunDirectory, append, commit, type LedgerEvent, locked, open, project, readLedger, record, runDirectory, type RunState, sha256, summary } from "./run";

const PLAYBOOKS = ["setup", "ticket", "bugfix", "investigate", "review", "resume"];

// FR-02 AC1: route and reason are the first ledger event. Empty-AC runs open criteria only after routing.
// With no run_id the active run (see cli/hook.ts) is used, matching the router's `ark log route <playbook> "<why>"`.
export function logRoute(argumentsList: string[]): string {
  const active = activeRunDirectory();
  const runId = argumentsList.length === 3 ? argumentsList[0] : active && basename(active);
  const [playbook, why] = argumentsList.slice(-2);
  if (!runId) throw new Error("no active run; pass the run id: ark log route <run_id> <playbook> \"<why>\"");
  if (!PLAYBOOKS.includes(playbook)) throw new Error(`unknown playbook '${playbook}'; expected ${PLAYBOOKS.join(", ")}`);
  if (!why?.trim()) throw new Error("route needs a reason");
  const { directory } = open(runId, "route.chosen", "log route");
  return locked(directory, () => {
    let events = readLedger(directory);
    if (events.some((event) => event.type === "route.chosen")) throw new Error("the route is already logged for this run");
    if (events.some((event) => event.type !== "run.started" && event.type !== "criteria.opened")) throw new Error("route.chosen must be the first event after run.started");
    events = append(directory, events, "route.chosen", { playbook, reason: why.trim() });
    if (!Object.keys(project(events).acs).length) events = append(directory, events, "criteria.opened", {});
    const state = commit(directory, events);
    return `routed ${summary(state)}`;
  });
}

// AC3: an agent's typed output is checked against its schema before it is kept under artifacts/<agent>/<n>.json.
const ajv = new Ajv2020();
const agentSchemas = { implementer: implementerSchema, validator: validatorSchema, reviewer: reviewerSchema };
const nextFile = (directory: string) => {
  mkdirSync(directory, { recursive: true });
  return join(directory, `${Math.max(0, ...readdirSync(directory).map((file) => parseInt(file)).filter(Number.isInteger)) + 1}.json`);
};
const readJson = (file: string) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new Error(`${file}: ${(error as Error).message}`); }
};

export function artifactRecord(runId: string, agent: string, file: string): string {
  const schema = agentSchemas[agent as keyof typeof agentSchemas];
  if (!schema) throw new Error(`unknown agent '${agent}'; expected ${Object.keys(agentSchemas).join(", ")}`);
  const directory = runDirectory(runId);
  const value = readJson(file);
  const check = ajv.compile(schema);
  if (!check(value)) throw new Error(`${file} fails the ${agent} schema: ${ajv.errorsText(check.errors)}`);
  return locked(directory, () => { // reading the ledger first refuses a broken chain; the lock keeps the artifact numbering unique
    readLedger(directory);
    const out = nextFile(join(directory, "artifacts", agent));
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(out, bytes);
    return `${out.slice(directory.length + 1)} ${sha256(bytes)}\n`;
  });
}

// FR-14: every finding is bucketed with a reason. Only a verified finding sends work back (CONTEXT.md): an act-on P0 or P1 backed by a tagged test that the latest
// `ark test` at the current head recorded as failing, or, where no test can reach it, by a traced path, which the evidence packet marks as weaker evidence.
const PRIORITY = ["P0", "P1", "P2", "P3"];
const BUCKET = ["act_on", "consider", "noted", "dismissed"];
const KEYS = ["id", "reviewer", "model", "priority", "file", "line", "claim", "bucket", "reason", "evidence"];
const text = (value: unknown) => typeof value === "string" && value.trim() !== "";

// The latest recorded green-side outcome for each test at the repo's current HEAD wins across ark test modes.
function failingAtHead(directory: string, repositories: RunState["repos"], events: LedgerEvent[]): string[] {
  return repositories.flatMap((repository) => {
    let head: string;
    try { head = git(join(directory, "worktrees", repository.name), "rev-parse", "HEAD"); } catch { return []; }
    const status = new Map<string, { test: string; outcome: string }>();
    for (const event of events) {
      if (!["test.result", "test.red_green", "test.preservation"].includes(event.type) || event.data.repo !== repository.name || event.data.head_sha !== head) continue;
      for (const testRecord of event.data.tests as { suite?: string; test: string; status?: string; green?: string }[]) {
        const outcome = event.type === "test.result" ? testRecord.status : testRecord.green;
        if (typeof outcome === "string" && outcome !== "missing") status.set(`${testRecord.suite ?? ""}\0${testRecord.test}`, { test: testRecord.test, outcome });
      }
    }
    return [...status.values()].filter(({ outcome }) => outcome === "failure" || outcome === "error").map(({ test }) => test);
  });
}

function checkFinding(finding: unknown, at: string, failing: string[]): string[] {
  if (typeof finding !== "object" || finding === null || Array.isArray(finding)) return [`${at}: not an object`];
  const findingFields = finding as Record<string, unknown>;
  const bad = Object.keys(findingFields).filter((key) => !KEYS.includes(key)).map((key) => `${at}: unknown key '${key}'`);
  for (const key of ["id", "reviewer", "model", "file", "claim", "reason"]) if (!text(findingFields[key])) bad.push(`${at}: ${key} must be a non-empty string`);
  if (!PRIORITY.includes(findingFields.priority as string)) bad.push(`${at}: priority must be one of ${PRIORITY.join(", ")}`);
  if (!Number.isInteger(findingFields.line) || (findingFields.line as number) < 1) bad.push(`${at}: line must be a positive integer`);
  if (!BUCKET.includes(findingFields.bucket as string)) bad.push(`${at}: bucket must be one of ${BUCKET.join(", ")}`);
  const evidence = findingFields.evidence;
  const proof = typeof evidence === "object" && evidence !== null && !Array.isArray(evidence) ? (evidence as Record<string, unknown>) : undefined;
  const fields = ["failing_test", "traced_path"];
  if (evidence !== undefined && (!proof || !Object.keys(proof).length || Object.keys(proof).some((key) => !fields.includes(key)))) bad.push(`${at}: evidence must be {failing_test} or {traced_path}`);
  for (const field of fields) if (proof && field in proof && !text(proof[field])) bad.push(`${at}: evidence.${field} must be a non-empty string`);
  const named = proof?.failing_test;
  const validTest = text(named) && failing.some((testName) => testName === named || testName.endsWith(` > ${named}`));
  const validPath = text(proof?.traced_path);
  if (text(named) && !validTest) {
    bad.push(`${at}: failing_test '${named}' is not a test that the latest 'ark test' at the current head recorded as failing (${failing.length ? `failing now: ${failing.join("; ")}` : "none failing now"}); run it with 'ark test', or give {traced_path} (weaker evidence)`);
  }
  if (findingFields.bucket === "act_on" && (findingFields.priority === "P0" || findingFields.priority === "P1") && !validTest && !validPath) {
    bad.push(`${at}: act_on ${findingFields.priority} goes back only with evidence {failing_test} or {traced_path}`);
  }
  return bad;
}

export function findingsRecord(runId: string, file: string): string {
  const { directory, state } = open(runId, "findings.recorded", "findings record");
  return locked(directory, () => { // numbering the artifact and recording it are one step, or parallel records overwrite each other's file
    const list = readJson(file);
    const events = readLedger(directory);
    const failing = failingAtHead(directory, state.repos, events);
    if (!Array.isArray(list) || !list.length) throw new Error(`${file} must be a non-empty JSON array of findings`);
    const prior = events.filter((event) => event.type === "findings.recorded");
    const seen = new Set(prior.flatMap((event) => event.data.ids as string[]));
    const bad = list.flatMap((finding, i) => {
      const id = (finding as { id?: unknown })?.id;
      const duplicate = typeof id === "string" && seen.has(id) ? [`finding ${i + 1}: id '${id}' is already recorded in this run`] : [];
      if (typeof id === "string") seen.add(id);
      return [...checkFinding(finding, `finding ${i + 1}`, failing), ...duplicate];
    });
    if (bad.length) throw new Error(`${file} refused:\n${bad.map((bucket) => `  - ${bucket}`).join("\n")}`);

    const bytes = `${JSON.stringify(list, null, 2)}\n`;
    const out = nextFile(join(directory, "artifacts", "findings"));
    writeFileSync(out, bytes);
    const count = (bucket: string) => list.filter((finding) => finding.bucket === bucket).length;
    const blocking = list.filter((finding) => finding.bucket === "act_on" && (finding.priority === "P0" || finding.priority === "P1")).length;
    record(directory, "findings.recorded", {
      path: out.slice(directory.length + 1), sha256: sha256(bytes), ids: list.map((finding) => finding.id),
      buckets: Object.fromEntries(BUCKET.map((bucket) => [bucket, count(bucket)])), blocking,
    });
    return `recorded ${list.length} findings (${BUCKET.map((bucket) => `${bucket} ${count(bucket)}`).join(", ")}); open act_on P0/P1: ${blocking}\n`;
  });
}
