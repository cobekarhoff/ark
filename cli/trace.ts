import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { open, readLedger, record, sha256, type LedgerEvent } from "./run";

type TestRow = { test: string; acs: string[]; red?: string };
type Ev = LedgerEvent & { data: { repo: string; head_sha: string; base_sha?: string; out: string; acs: Record<string, string>; tests: TestRow[] } };

const NEW_BEHAVIOR = ["e2e", "integration", "unit"]; // red-green proof applies to these; manual ACs need a signed record instead
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "-";
const uniq = (xs: string[]) => [...new Set(xs)].sort();
// ark test records "pass"|"fail"|"flaky"|"missing"; ark test --red-green records "proven"|"no-red" (green passed) or "green-failed"|"missing".
const green = (v: string) => (v === "proven" || v === "no-red" ? "pass" : v === "green-failed" ? "fail" : v);

// Rebuilds trace-matrix.md from ac.yml, the latest test evidence per (AC, repo) and manual/<AC>.md. Output depends only on those inputs.
export function traceCheck(runId: string): string {
  const { dir } = open(runId, "trace.checked");
  const acs = (Bun.YAML.parse(readFileSync(join(dir, "ac.yml"), "utf8")) ?? []) as { id: string; level?: string }[];
  const known = new Set(acs.map((a) => a.id));

  // latest[id][repo] = the newest result event and the newest red-green event that name the AC; the later of the two is the green evidence.
  const latest: Record<string, Record<string, { res?: Ev; rg?: Ev }>> = {};
  for (const e of readLedger(dir) as Ev[]) {
    if (e.type !== "test.result" && e.type !== "test.red_green") continue;
    for (const id of Object.keys(e.data.acs)) {
      ((latest[id] ??= {})[e.data.repo] ??= {})[e.type === "test.result" ? "res" : "rg"] = e;
    }
  }

  const failures: string[] = [];
  const rows = acs.map(({ id, level = "e2e" }) => {
    const row = (tests: string, red: string, grn: string, evidence: string, why?: string) => {
      if (why) failures.push(`${id}: ${why}`);
      return { id, line: `| ${[id, level, tests, red, grn, evidence].map(cell).join(" | ")} | ${why ? "fail" : "pass"} |` };
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
    for (const [repo, { res, rg }] of Object.entries(latest[id] ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const g = !res || (rg && rg.seq > res.seq) ? rg! : res;
      const outcome = green(g.data.acs[id]);
      const mine = g.data.tests.filter((t) => t.acs.includes(id));
      tests.push(...mine.map((t) => t.test));
      grn.push(`${g.data.head_sha.slice(0, 12)} ${outcome}`);
      evidence.push(g.data.out);
      if (rg) {
        red.push(`${rg.data.base_sha?.slice(0, 12)} ${uniq(rg.data.tests.filter((t) => t.acs.includes(id)).map((t) => t.red ?? "missing")).join("/") || "missing"}`);
        evidence.push(rg.data.out);
      }
      if (outcome === "missing") continue; // the repo has no tagged test for this AC; another repo may
      if (outcome !== "pass") { bad.push(`${repo}: ${outcome}`); continue; }
      passing++;
      if (NEW_BEHAVIOR.includes(level) && !(rg?.data.acs[id] === "proven" && rg.data.head_sha === g.data.head_sha)) {
        bad.push(`${repo}: no red-green proof at ${g.data.head_sha.slice(0, 12)} (red must fail or error on base, green must pass on head)`);
      }
    }
    const why = !passing || bad.length ? [!passing && `no passing tagged test${bad.length ? "" : " recorded"}`, ...bad].filter(Boolean).join("; ") : undefined;
    return row(uniq(tests).join("; "), uniq(red).join("; "), uniq(grn).join("; "), uniq(evidence).join(", "), why);
  });

  // Unknown tags: AC IDs on recorded tests (or recorded for) that ac.yml does not list.
  const unknown = new Map<string, string[]>();
  for (const [id, byRepo] of Object.entries(latest)) {
    for (const { res, rg } of Object.values(byRepo)) {
      for (const e of [res, rg]) {
        if (!e) continue;
        for (const t of e.data.tests) for (const tag of t.acs) if (!known.has(tag)) unknown.set(tag, [...(unknown.get(tag) ?? []), t.test]);
      }
    }
    if (!known.has(id) && !unknown.has(id)) unknown.set(id, []);
  }
  for (const [tag, ts] of [...unknown].sort(([a], [b]) => a.localeCompare(b))) {
    failures.push(`${tag}: unknown AC, not in ac.yml${ts.length ? ` (tagged on: ${uniq(ts).join("; ")})` : ""}`);
    rows.push({ id: tag, line: `| ${cell(tag)} | - | ${cell(uniq(ts).join("; "))} | - | - | - | fail |` });
  }

  rows.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const matrix = `# Trace matrix: ${runId}\n\n| AC | Level | Tests | Red (SHA, outcome) | Green (SHA, outcome) | Evidence | Status |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.map((r) => `${r.line}\n`).join("")}`;
  writeFileSync(join(dir, "trace-matrix.md"), matrix);
  const passed = failures.length === 0;
  record(dir, "trace.checked", { passed, failures, matrix_sha256: sha256(matrix) });
  if (!passed) throw new Error(`trace-check failed for ${runId}:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  return `trace-check passed: ${rows.length} ACs, ${sha256(matrix)}\n`;
}
