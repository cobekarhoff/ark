import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./repo";
import { check, locked, open, project, readLedger, record, type RunState, sha256, type LedgerEvent, unattributed } from "./run";

type TestRow = { test: string; acs: string[]; red?: string; green?: string };
type TestEvent = LedgerEvent & { data: { repo: string; head_sha: string; base_sha?: string; out: string; acs: Record<string, string>; tests: TestRow[]; unknown_tags?: string[] } };

const ACCEPTANCE_CRITERIA_KINDS = ["new", "preserved"]; // new needs red-green proof, preserved needs preservation proof; a manual AC needs a signed record either way
const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "-";
// Locale-independent natural order: digit runs compare as integers, everything else by code unit, so AC2 < AC10 on every machine.
const compare = (left: string, right: string): number => {
  const [leftChunks, rightChunks] = [left, right].map((value) => value.match(/\d+|\D+/g) ?? []);
  for (let i = 0; i < Math.min(leftChunks.length, rightChunks.length); i++) {
    const difference = /^\d/.test(leftChunks[i]) && /^\d/.test(rightChunks[i]) ? Number(leftChunks[i]) - Number(rightChunks[i]) : leftChunks[i] < rightChunks[i] ? -1 : leftChunks[i] > rightChunks[i] ? 1 : 0;
    if (difference) return difference;
  }
  return leftChunks.length - rightChunks.length;
};
const unique = (values: string[]) => [...new Set(values)].sort();
// ark test records "pass"|"fail"|"flaky"|"missing"|"inconclusive"; ark test --red-green records "proven"|"no-red"|"inconclusive"|"green-failed"|"missing";
// ark test --preservation records "preserved"|"not-preserved"|"inconclusive"|"green-failed"|"missing".
// A red-green or preservation verdict says whether the base side held up, not how green went, so the green outcome of such an event is read from its test rows.
function green(event: TestEvent, id: string): string {
  const outcome = event.data.acs[id];
  if (event.type === "test.result") return outcome;
  if (outcome === "green-failed") return "fail";
  const rows = event.data.tests.filter((testRecord) => testRecord.acs.includes(id) && testRecord.green !== "missing");
  if (!rows.length) return "missing";
  if (rows.some((testRecord) => testRecord.green !== "pass" && testRecord.green !== "skipped")) return "fail";
  return rows.some((testRecord) => testRecord.green === "pass") ? "pass" : "missing";
}

// The matrix and the reasons it fails, as a pure function of ac.yml, manual/<AC>.md, the ledger and the run worktrees' HEADs.
// `ark trace-check` writes it; `ark gate packet evidence` recomputes it instead of trusting a stored verdict.
export function buildMatrix(directory: string, runId: string, state: RunState, events: LedgerEvent[]): { matrix: string; failures: string[] } {
  const acceptanceCriteria = (Bun.YAML.parse(readFileSync(join(directory, "ac.yml"), "utf8")) ?? []) as { id: string; level?: string; kind?: string }[];
  check("ac", acceptanceCriteria, "ac.yml");
  const failures: string[] = unattributed(directory, state, events); // changes no recorded implementer step vouches for
  const listed = new Set(acceptanceCriteria.map((criterion) => criterion.id));
  for (const id of Object.keys(state.acs)) if (!listed.has(id)) failures.push(`${id}: in the run but missing from ac.yml`);
  for (const id of listed) if (!(id in state.acs)) failures.push(`${id}: in ac.yml but not an acceptance criterion (AC) of this run`);

  const approved = events.findLast((event) => event.type === "gate.answered" && event.data.gate === "plan" && event.data.answer === "approve");
  const approvedKinds = approved?.data.ac_kinds;
  const currentKinds = Object.fromEntries(acceptanceCriteria.map(({ id, kind }) => [id, kind]));
  if (!approved || typeof approvedKinds !== "object" || approvedKinds === null || Array.isArray(approvedKinds)) {
    failures.push("ac.yml kinds do not match an approved plan packet");
  } else {
    const bound = approvedKinds as Record<string, unknown>;
    for (const id of new Set([...Object.keys(bound), ...Object.keys(currentKinds)])) {
      if (!(id in bound)) failures.push(`${id}: kind is missing from approved plan packet`);
      else if (!(id in currentKinds)) failures.push(`${id}: kind is extra in approved plan packet`);
      else if (bound[id] !== currentKinds[id]) failures.push(`${id}: kind changed since plan approval (approved ${String(bound[id])}, current ${String(currentKinds[id])})`);
    }
  }
  // A worktree with tracked edits or untracked, non-ignored files is not the HEAD it was proven at, so it has no current HEAD.
  const dirty = new Set<string>();
  const heads = new Map(state.repos.map((repository) => {
    const worktree = join(directory, "worktrees", repository.name);
    try {
      if (git(worktree, "status", "--porcelain")) dirty.add(repository.name);
      return [repository.name, dirty.has(repository.name) ? undefined : git(worktree, "rev-parse", "HEAD")] as const;
    } catch { return [repository.name, undefined] as const; }
  }));
  const bases = new Map(state.repos.map((repository) => [repository.name, repository.base_sha]));
  const stale = new Set<string>(); // ACs that have evidence which does not count
  // latest[id][repo] = the newest counting result, red-green and preservation event that name the AC; the latest of them is the green evidence.
  const latest: Record<string, Record<string, { result?: TestEvent; redGreen?: TestEvent; preservation?: TestEvent }>> = {};
  const unknown = new Set<string>();
  for (const event of events as TestEvent[]) {
    if (!["test.result", "test.red_green", "test.preservation"].includes(event.type)) continue;
    const counts = !!event.data.head_sha && heads.get(event.data.repo) === event.data.head_sha && (event.type === "test.result" || bases.get(event.data.repo) === event.data.base_sha);
    for (const id of Object.keys(event.data.acs)) {
      if (!counts) stale.add(id);
      else ((latest[id] ??= {})[event.data.repo] ??= {})[event.type === "test.result" ? "result" : event.type === "test.red_green" ? "redGreen" : "preservation"] = event;
    }
    if (counts) for (const testRecord of event.data.unknown_tags ?? []) unknown.add(testRecord);
  }

  const rows = acceptanceCriteria.map(({ id, level = "e2e", kind }) => {
    const row = (tests: string, red: string, greenOutcomes: string, evidence: string, why?: string) => {
      const flaw = [!ACCEPTANCE_CRITERIA_KINDS.includes(kind as string) && "no kind (new or preserved) in ac.yml", why].filter(Boolean).join("; ");
      if (flaw) failures.push(`${id}: ${flaw}`);
      const screenshotsDirectory = join(directory, "artifacts", "screenshots", id); // UI or system behavior: screenshots the validator saved per AC, listed, never counted as proof
      const screenshots = existsSync(screenshotsDirectory) ? (readdirSync(screenshotsDirectory, { recursive: true }) as string[]).filter((f) => statSync(join(screenshotsDirectory, f)).isFile()).sort().map((f) => `artifacts/screenshots/${id}/${f}`) : [];
      return { id, line: `| ${[id, kind ?? "-", level, tests, red, greenOutcomes, evidence, screenshots.join(", ")].map(cell).join(" | ")} | ${flaw ? "fail" : "pass"} |` };
    };
    if (level === "manual") {
      const file = `manual/${id}.md`;
      const text = existsSync(join(directory, file)) ? readFileSync(join(directory, file), "utf8") : "";
      const by = text.match(/^signed-by:[ \t]*(\S.*)$/m)?.[1];
      const at = text.match(/^at:[ \t]*(\S.*)$/m)?.[1];
      return by && at ? row(`signed-by ${by} at ${at}`, "-", "-", file) : row("-", "-", "-", file, `manual acceptance criterion (AC) has no signed record; ${file} needs 'signed-by:' and 'at:' lines`);
    }
    const tests: string[] = [], red: string[] = [], greenOutcomes: string[] = [], evidence: string[] = [];
    const bad: string[] = [];
    let passing = 0;
    for (const [repositoryName, { result, redGreen, preservation }] of Object.entries(latest[id] ?? {}).sort(([a], [b]) => compare(a, b))) {
      const latestEvidence = [result, redGreen, preservation].filter((testEvent): testEvent is TestEvent => !!testEvent).sort((leftEvent, rightEvent) => leftEvent.seq - rightEvent.seq).at(-1)!;
      const outcome = green(latestEvidence, id);
      const mine = latestEvidence.data.tests.filter((testRecord) => testRecord.acs.includes(id));
      tests.push(...mine.map((testRecord) => testRecord.test));
      greenOutcomes.push(`${latestEvidence.data.head_sha.slice(0, 12)} ${outcome}`);
      evidence.push(latestEvidence.data.out);
      const proof = kind === "preserved" ? preservation : redGreen; // the base-side record the AC's kind asks for
      if (proof) {
        red.push(`${proof.data.base_sha?.slice(0, 12)} ${unique(proof.data.tests.filter((testRecord) => testRecord.acs.includes(id)).map((testRecord) => testRecord.red ?? "missing")).join("/") || "missing"}`);
        evidence.push(proof.data.out);
      }
      if (outcome === "missing") continue; // the repo has no tagged test for this AC; another repo may
      if (outcome !== "pass") { bad.push(`${repositoryName}: ${outcome}`); continue; }
      passing++;
      if (kind === "new" && redGreen?.data.acs[id] !== "proven") {
        bad.push(`${repositoryName}: no red-green proof at ${latestEvidence.data.head_sha.slice(0, 12)} (red must fail or error on base, green must pass on head)`);
      } else if (kind === "preserved" && preservation?.data.acs[id] !== "preserved") {
        bad.push(`${repositoryName}: no preservation proof at ${latestEvidence.data.head_sha.slice(0, 12)} (the tagged tests must pass on base and on head)`);
      }
    }
    const none = `no passing tagged test${stale.has(id) ? " at the current HEAD" : bad.length ? "" : " recorded"}`;
    const dirtied = stale.has(id) ? [...dirty].sort(compare).map((repositoryName) => `${repositoryName} has uncommitted changes`) : [];
    const why = !passing || bad.length ? [!passing && none, ...bad, ...dirtied].filter(Boolean).join("; ") : undefined;
    return row(unique(tests).join("; "), unique(red).join("; "), unique(greenOutcomes).join("; "), unique(evidence).join(", "), why);
  });

  // Unknown tags: AC IDs of this ticket found in a test report that the run does not have (other tickets' IDs are not unknown).
  for (const tag of [...unknown].sort(compare)) {
    failures.push(`${tag}: unknown acceptance criterion (AC) tag, not an acceptance criterion (AC) of this run`);
    rows.push({ id: tag, line: `| ${cell(tag)} | - | - | - | - | - | - | - | fail |` });
  }

  rows.sort((leftRow, rightRow) => compare(leftRow.id, rightRow.id));
  const matrix = `# Trace matrix: ${runId}\n\nAcceptance criterion (AC) evidence, with commit hashes for each test run.\n\n| AC | Kind | Level | Tests | Red (commit, outcome) | Green (commit, outcome) | Evidence | Screenshots | Status |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.map((row) => `${row.line}\n`).join("")}`;
  return { matrix, failures };
}

export function traceCheck(runId: string): string {
  const { directory } = open(runId, "trace.checked", "trace-check");
  return locked(directory, () => { // the matrix, its verdict and the event it is recorded in come from one ledger read
    const events = readLedger(directory);
    const state = project(events);
    const { matrix, failures } = buildMatrix(directory, runId, state, events);
    writeFileSync(join(directory, "trace-matrix.md"), matrix);
    const passed = failures.length === 0;
    record(directory, "trace.checked", { passed, failures, matrix_sha256: sha256(matrix) });
    if (!passed) throw new Error(`trace-check failed for ${runId}:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
    return `trace-check passed: ${Object.keys(state.acs).length} acceptance criteria, ${sha256(matrix)}\n`;
  });
}
