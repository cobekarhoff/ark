import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./repo";
import { check, locked, open, project, readLedger, record, type RunState, sha256, type LedgerEvent, unattributed } from "./run";

type TestRow = { test: string; acs: string[]; red?: string; green?: string };
type Ev = LedgerEvent & { data: { repo: string; head_sha: string; base_sha?: string; out: string; acs: Record<string, string>; tests: TestRow[]; unknown_tags?: string[] } };

const AC_KINDS = ["new", "preserved"]; // new needs red-green proof, preserved needs preservation proof; a manual AC needs a signed record either way
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "-";
// Locale-independent natural order: digit runs compare as integers, everything else by code unit, so AC2 < AC10 on every machine.
const cmp = (a: string, b: string): number => {
  const [x, y] = [a, b].map((s) => s.match(/\d+|\D+/g) ?? []);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = /^\d/.test(x[i]) && /^\d/.test(y[i]) ? Number(x[i]) - Number(y[i]) : x[i] < y[i] ? -1 : x[i] > y[i] ? 1 : 0;
    if (d) return d;
  }
  return x.length - y.length;
};
const uniq = (xs: string[]) => [...new Set(xs)].sort();
// ark test records "pass"|"fail"|"flaky"|"missing"|"inconclusive"; ark test --red-green records "proven"|"no-red"|"inconclusive"|"green-failed"|"missing";
// ark test --preservation records "preserved"|"not-preserved"|"inconclusive"|"green-failed"|"missing".
// A red-green or preservation verdict says whether the base side held up, not how green went, so the green outcome of such an event is read from its test rows.
function green(e: Ev, id: string): string {
  const v = e.data.acs[id];
  if (e.type === "test.result") return v;
  if (v === "green-failed") return "fail";
  const rows = e.data.tests.filter((t) => t.acs.includes(id) && t.green !== "missing");
  if (!rows.length) return "missing";
  if (rows.some((t) => t.green !== "pass" && t.green !== "skipped")) return "fail";
  return rows.some((t) => t.green === "pass") ? "pass" : "missing";
}

// The matrix and the reasons it fails, as a pure function of ac.yml, manual/<AC>.md, the ledger and the run worktrees' HEADs.
// `ark trace-check` writes it; `ark gate packet G2` recomputes it instead of trusting a stored verdict.
export function buildMatrix(dir: string, runId: string, state: RunState, events: LedgerEvent[]): { matrix: string; failures: string[] } {
  const acs = (Bun.YAML.parse(readFileSync(join(dir, "ac.yml"), "utf8")) ?? []) as { id: string; level?: string; kind?: string }[];
  check("ac", acs, "ac.yml");
  const failures: string[] = unattributed(dir, state, events); // changes no recorded implementer step vouches for
  const listed = new Set(acs.map((a) => a.id));
  for (const id of Object.keys(state.acs)) if (!listed.has(id)) failures.push(`${id}: in the run but missing from ac.yml`);
  for (const id of listed) if (!(id in state.acs)) failures.push(`${id}: in ac.yml but not an AC of this run`);

  // Evidence counts only for a repo of the run, at that repo's worktree HEAD, and red only from the repo's recorded base.
  // A worktree with tracked edits or untracked, non-ignored files is not the HEAD it was proven at, so it has no current HEAD.
  const dirty = new Set<string>();
  const heads = new Map(state.repos.map((r) => {
    const wt = join(dir, "ws", r.name);
    try {
      if (git(wt, "status", "--porcelain")) dirty.add(r.name);
      return [r.name, dirty.has(r.name) ? undefined : git(wt, "rev-parse", "HEAD")] as const;
    } catch { return [r.name, undefined] as const; }
  }));
  const bases = new Map(state.repos.map((r) => [r.name, r.base_sha]));
  const stale = new Set<string>(); // ACs that have evidence which does not count
  // latest[id][repo] = the newest counting result, red-green and preservation event that name the AC; the latest of them is the green evidence.
  const latest: Record<string, Record<string, { res?: Ev; rg?: Ev; pv?: Ev }>> = {};
  const unknown = new Set<string>();
  for (const e of events as Ev[]) {
    if (!["test.result", "test.red_green", "test.preservation"].includes(e.type)) continue;
    const counts = !!e.data.head_sha && heads.get(e.data.repo) === e.data.head_sha && (e.type === "test.result" || bases.get(e.data.repo) === e.data.base_sha);
    for (const id of Object.keys(e.data.acs)) {
      if (!counts) stale.add(id);
      else ((latest[id] ??= {})[e.data.repo] ??= {})[e.type === "test.result" ? "res" : e.type === "test.red_green" ? "rg" : "pv"] = e;
    }
    if (counts) for (const t of e.data.unknown_tags ?? []) unknown.add(t);
  }

  const rows = acs.map(({ id, level = "e2e", kind }) => {
    const row = (tests: string, red: string, grn: string, evidence: string, why?: string) => {
      const flaw = [!AC_KINDS.includes(kind as string) && "no kind (new or preserved) in ac.yml", why].filter(Boolean).join("; ");
      if (flaw) failures.push(`${id}: ${flaw}`);
      const shots = join(dir, "artifacts", "screenshots", id); // UI or system behavior: screenshots the validator saved per AC, listed, never counted as proof
      const screenshots = existsSync(shots) ? (readdirSync(shots, { recursive: true }) as string[]).filter((f) => statSync(join(shots, f)).isFile()).sort().map((f) => `artifacts/screenshots/${id}/${f}`) : [];
      return { id, line: `| ${[id, kind ?? "-", level, tests, red, grn, evidence, screenshots.join(", ")].map(cell).join(" | ")} | ${flaw ? "fail" : "pass"} |` };
    };
    if (level === "manual") {
      const file = `manual/${id}.md`;
      const text = existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : "";
      const by = text.match(/^signed-by:[ \t]*(\S.*)$/m)?.[1];
      const at = text.match(/^at:[ \t]*(\S.*)$/m)?.[1];
      return by && at ? row(`signed-by ${by} at ${at}`, "-", "-", file) : row("-", "-", "-", file, `manual AC has no signed record; ${file} needs 'signed-by:' and 'at:' lines`);
    }
    const tests: string[] = [], red: string[] = [], grn: string[] = [], evidence: string[] = [];
    const bad: string[] = [];
    let passing = 0;
    for (const [repo, { res, rg, pv }] of Object.entries(latest[id] ?? {}).sort(([a], [b]) => cmp(a, b))) {
      const g = [res, rg, pv].filter((x): x is Ev => !!x).sort((a, b) => a.seq - b.seq).at(-1)!;
      const outcome = green(g, id);
      const mine = g.data.tests.filter((t) => t.acs.includes(id));
      tests.push(...mine.map((t) => t.test));
      grn.push(`${g.data.head_sha.slice(0, 12)} ${outcome}`);
      evidence.push(g.data.out);
      const proof = kind === "preserved" ? pv : rg; // the base-side record the AC's kind asks for
      if (proof) {
        red.push(`${proof.data.base_sha?.slice(0, 12)} ${uniq(proof.data.tests.filter((t) => t.acs.includes(id)).map((t) => t.red ?? "missing")).join("/") || "missing"}`);
        evidence.push(proof.data.out);
      }
      if (outcome === "missing") continue; // the repo has no tagged test for this AC; another repo may
      if (outcome !== "pass") { bad.push(`${repo}: ${outcome}`); continue; }
      passing++;
      if (kind === "new" && rg?.data.acs[id] !== "proven") {
        bad.push(`${repo}: no red-green proof at ${g.data.head_sha.slice(0, 12)} (red must fail or error on base, green must pass on head)`);
      } else if (kind === "preserved" && pv?.data.acs[id] !== "preserved") {
        bad.push(`${repo}: no preservation proof at ${g.data.head_sha.slice(0, 12)} (the tagged tests must pass on base and on head)`);
      }
    }
    const none = `no passing tagged test${stale.has(id) ? " at the current HEAD" : bad.length ? "" : " recorded"}`;
    const dirtied = stale.has(id) ? [...dirty].sort(cmp).map((r) => `${r} has uncommitted changes`) : [];
    const why = !passing || bad.length ? [!passing && none, ...bad, ...dirtied].filter(Boolean).join("; ") : undefined;
    return row(uniq(tests).join("; "), uniq(red).join("; "), uniq(grn).join("; "), uniq(evidence).join(", "), why);
  });

  // Unknown tags: AC IDs of this ticket found in a test report that the run does not have (other tickets' IDs are not unknown).
  for (const tag of [...unknown].sort(cmp)) {
    failures.push(`${tag}: unknown AC tag, not an AC of this run`);
    rows.push({ id: tag, line: `| ${cell(tag)} | - | - | - | - | - | - | - | fail |` });
  }

  rows.sort((a, b) => cmp(a.id, b.id));
  const matrix = `# Trace matrix: ${runId}\n\n| AC | Kind | Level | Tests | Red (SHA, outcome) | Green (SHA, outcome) | Evidence | Screenshots | Status |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.map((r) => `${r.line}\n`).join("")}`;
  return { matrix, failures };
}

export function traceCheck(runId: string): string {
  const { dir } = open(runId, "trace.checked", "trace-check");
  return locked(dir, () => { // the matrix, its verdict and the event it is recorded in come from one ledger read
    const events = readLedger(dir);
    const state = project(events);
    const { matrix, failures } = buildMatrix(dir, runId, state, events);
    writeFileSync(join(dir, "trace-matrix.md"), matrix);
    const passed = failures.length === 0;
    record(dir, "trace.checked", { passed, failures, matrix_sha256: sha256(matrix) });
    if (!passed) throw new Error(`trace-check failed for ${runId}:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    return `trace-check passed: ${Object.keys(state.acs).length} ACs, ${sha256(matrix)}\n`;
  });
}
