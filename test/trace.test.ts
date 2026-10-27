import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rechain } from "./ledger";
import { OMP_CONFIG } from "./omp-config";

setDefaultTimeout(60_000);
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
// Git identity as config, passed only to ark itself so `ark gate answer` records an approver on CI machines without a global user.
const GIT_IDENTITY = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@t" };
const CLI = join(import.meta.dir, "..", "cli", "ark.ts");

// A tiny bun project, as in ws-test: base has feature() = "old" and one green test; head adds the new behavior and its tests.
// AC1 fails on base (assertion), AC4 errors on base (module missing), AC2 passes on both, AC3 fails on its first run only, AC5 always fails.
const bunTest = (body: string, imports = "") => `import { describe, expect, test } from "bun:test";\n${imports}\n${body}\n`;
const HEAD_FILES = {
  "src/feature.ts": `export const feature = () => "new";\n`,
  "src/added.ts": `export const added = () => 42;\n`,
  "test/feature.test.ts": bunTest(`test("DEMO-1-AC1 new feature", () => { expect(feature()).toBe("new"); });`, `import { feature } from "../src/feature";`),
  "test/added.test.ts": bunTest(`test("DEMO-1-AC4 added module answers", () => { expect(added()).toBe(42); });`, `import { added } from "../src/added";`),
};
const FLAKY = bunTest(
  `test("DEMO-1-AC3 fails on its first run only", () => { appendFileSync(process.env.FLAKY_COUNTER!, "x"); expect(readFileSync(process.env.FLAKY_COUNTER!, "utf8").length).toBeGreaterThan(1); });`,
  `import { appendFileSync, readFileSync } from "node:fs";`,
);
// One test carrying two AC tags; DEMO-1-AC9 is not an AC of the ticket.
const TYPO = bunTest(`test("DEMO-1-AC9 typo tag", () => { expect(1).toBe(1); });`);
const SHARED = bunTest(`test("DEMO-1-AC1 and DEMO-1-AC9 share one test", () => { expect(feature()).toBe("new"); });`, `import { feature } from "../src/feature";`);

const REPO_YML = JSON.stringify({
  suites: { unit: { format: "bun-test", level: "integration", run: 'bun test -t "{tags}" --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml', junit: "$ARK_OUT/bun.xml" } },
});

let home: string;
let proj: string;
let counter: string;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const write = (dir: string, files: Record<string, string>) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
};
const commitAll = (dir: string, files: Record<string, string>) => {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "change");
};
const ark = (...args: string[]) => {
  const env = { ...process.env, ...GIT_IDENTITY, ARK_HOME: home, FLAKY_COUNTER: counter };
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: proj, env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const runsDir = () => join(home, "projects", "demo", "runs");
const run = () => readdirSync(runsDir())[0];
const runFile = (f: string) => join(runsDir(), run(), f);
const slurp = (f: string) => readFileSync(runFile(f), "utf8");
const events = (type: string) => slurp("ledger.ndjson").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === type);
const wt = () => runFile("ws/demo");
const matrix = () => slurp("trace-matrix.md");
const row = (id: string) => matrix().split("\n").find((l) => l.startsWith(`| ${id} |`))!;
const RUN_ACS = ["AC1", "AC2", "AC3", "AC4", "AC5", "AC10"];
const sign = (id: string, body = "signed-by: Pat Reviewer\nat: 2026-10-21T10:00:00Z\n") => {
  mkdirSync(runFile("manual"), { recursive: true });
  writeFileSync(runFile(`manual/DEMO-1-${id}.md`), body);
};
const writeAcs = (acs: [id: string, level?: string][]) =>
  writeFileSync(runFile("ac.yml"), acs.map(([id, level]) => `- id: DEMO-1-${id}\n  text: t${level ? `\n  level: ${level}` : ""}\n`).join(""));
// ac.yml must list exactly the run's ACs, so the ones a test does not care about are signed manual ACs.
const acYml = (...acs: [id: string, level?: string][]) => {
  const rest = RUN_ACS.filter((id) => !acs.some(([a]) => a === id));
  writeAcs([...acs, ...rest.map((id): [string, string] => [id, "manual"])]);
  for (const id of rest) sign(id);
};
// Rewrites the ledger line of the newest event of `type` (the tests' way to present evidence the CLI itself would never record).
const tamper = (type: string, edit: (data: Record<string, unknown>) => void) => {
  const lines = slurp("ledger.ndjson").trim().split("\n");
  const i = lines.findLastIndex((l) => JSON.parse(l).type === type);
  const e = JSON.parse(lines[i]);
  edit(e.data);
  lines[i] = JSON.stringify(e);
  writeFileSync(runFile("ledger.ndjson"), `${lines.join("\n")}\n`);
  rechain(dirname(runFile("ledger.ndjson"))); // the edit is the point, not a broken chain
};
const trace = () => ark("trace-check", run());

const ticket = `---
id: DEMO-1
title: "Add the feature"
status: ready
acceptance_criteria:
${[1, 2, 3, 4, 5, 10].map((n) => `  - id: DEMO-1-AC${n}\n    text: "criterion ${n}"`).join("\n")}
---
Body.
`;

// A project repo with a bun suite, a run started on it, and (via `to`) the lifecycle driven through the CLI up to that state.
function fixture() {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ark-fx-")));
  counter = join(root, "counter");
  proj = join(root, "demo");
  const bare = join(root, "remote.git");
  mkdirSync(proj);
  git(proj, "init", "-q", "-b", "main");
  commitAll(proj, {
    "ark.yml": "project: demo\n",
    ".omp/config.yml": OMP_CONFIG,
    ".gitignore": "node_modules\n",
    ".ark/repo.yml": REPO_YML,
    "src/feature.ts": `export const feature = () => "old";\n`,
    "test/stable.test.ts": bunTest(`test("DEMO-1-AC2 stays green", () => { expect(typeof feature()).toBe("string"); });`, `import { feature } from "../src/feature";`),
  });
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(proj, "remote", "add", "origin", bare);
  git(proj, "push", "-q", "origin", "main");
  git(proj, "remote", "set-head", "origin", "main");
  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  writeFileSync(join(home, "projects", "demo", "tickets", "DEMO-1.md"), ticket);
  ark("run", "start", "DEMO-1");
}
const ok = (r: { code: number; err: string }) => expect(r.err === "" ? r.code : r.err).toBe(0);
// start -> G1 approved -> ws create -> build.started
const toBuilding = () => {
  ok(ark("advance", run(), "analysis.completed"));
  writeFileSync(runFile("plan.md"), "# Plan\n");
  const h = ark("gate", "packet", run(), "G1").out.trim();
  ok(ark("gate", "answer", run(), "G1", "approve", "--packet", h));
  ok(ark("ws", "create", run()));
  ok(ark("advance", run(), "build.started"));
};
const toJudging = () => {
  toBuilding();
  ok(ark("advance", run(), "build.completed"));
};

// Product code belongs to the implementer; tagged tests are committed afterwards by the validator.
const implement = (files: Record<string, string>) => {
  const source = Object.fromEntries(Object.entries(files).filter(([f]) => !f.startsWith("test/")));
  const tests = Object.fromEntries(Object.entries(files).filter(([f]) => f.startsWith("test/")));
  if (Object.keys(source).length) commitAll(wt(), source);
  ok(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'));
  if (Object.keys(tests).length) commitAll(wt(), tests);
};
beforeEach(fixture);

// A second repo with a suite but no AC tags, added to the run as worktree 'other'.
const addOtherRepo = () => {
  const other = join(dirname(proj), "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  commitAll(other, { ".ark/repo.yml": REPO_YML, "test/untagged.test.ts": bunTest(`test("nothing tagged here", () => { expect(1).toBe(1); });`) });
  return other;
};

describe("ARK-106-AC1", () => {
  test("writes trace-matrix.md from ac.yml, the red-green and test evidence, and the manual record, rows sorted by AC number", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--acs", "DEMO-1-AC1,DEMO-1-AC4", "--red-green"));
    acYml(["AC4", "integration"], ["AC2", "manual"], ["AC1"]); // AC1 has no level: e2e by default
    sign("AC2");

    const r = trace();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const [rg] = events("test.red_green");
    const [base, head] = [rg.data.base_sha.slice(0, 12), rg.data.head_sha.slice(0, 12)];
    expect(row("DEMO-1-AC1")).toBe(`| DEMO-1-AC1 | e2e | test/feature.test.ts > DEMO-1-AC1 new feature | ${base} failure | ${head} pass | artifacts/test/1 | pass |`);
    expect(row("DEMO-1-AC2")).toBe("| DEMO-1-AC2 | manual | signed-by Pat Reviewer at 2026-10-21T10:00:00Z | - | - | manual/DEMO-1-AC2.md | pass |");
    expect(row("DEMO-1-AC4")).toBe(`| DEMO-1-AC4 | integration | test/added.test.ts > DEMO-1-AC4 added module answers | ${base} error | ${head} pass | artifacts/test/1 | pass |`);
    expect(matrix().split("\n").slice(4, -1).map((l) => l.split(" | ")[0])).toEqual(["| DEMO-1-AC1", "| DEMO-1-AC2", "| DEMO-1-AC3", "| DEMO-1-AC4", "| DEMO-1-AC5", "| DEMO-1-AC10"]);
    expect(matrix().split("\n")[0]).toContain(run());
    expect(events("trace.checked")[0].data).toEqual({
      passed: true,
      failures: [],
      matrix_sha256: `sha256:${new Bun.CryptoHasher("sha256").update(readFileSync(runFile("trace-matrix.md"))).digest("hex")}`,
    });
    expect(ark("run", "replay", run(), "--check").code).toBe(0);
  });
});

describe("ARK-106-AC2", () => {
  test("an AC with no recorded test fails, naming it, and the failing matrix and trace.checked are still written", () => {
    toBuilding();
    acYml(["AC1"]);
    const r = trace();
    expect(r.code).toBe(1);
    expect(r.err).toContain("DEMO-1-AC1: no passing tagged test");
    expect(row("DEMO-1-AC1")).toEndWith("| fail |");
    expect(events("trace.checked")[0].data).toMatchObject({ passed: false, failures: ["DEMO-1-AC1: no passing tagged test recorded"] });
  });

  test("a test tagged with an AC that is not the ticket's fails as an unknown tag, whether it also carries a real AC or only the typo", () => {
    toBuilding();
    implement({ "src/feature.ts": HEAD_FILES["src/feature.ts"], "test/shared.test.ts": SHARED, "test/typo.test.ts": TYPO });
    ok(ark("test", run(), "--acs", "DEMO-1-AC1", "--red-green"));
    acYml(["AC1"]);
    const r = trace();
    expect(r.code).toBe(1);
    expect(events("trace.checked")[0].data.failures).toEqual(["DEMO-1-AC9: unknown AC tag, not an AC of this run"]);
    expect(row("DEMO-1-AC1")).toEndWith("| pass |");
    expect(row("DEMO-1-AC9")).toEndWith("| fail |");
  });

  test("tags of other tickets' ACs are not unknown", () => {
    toBuilding();
    implement({ "src/feature.ts": HEAD_FILES["src/feature.ts"], "test/other.test.ts": bunTest(`test("OTHER-7-AC1 and DEMO-1-AC1 are tagged together", () => { expect(1).toBe(1); });`) });
    ok(ark("test", run(), "--acs", "DEMO-1-AC1"));
    acYml(["AC1", "manual"]);
    sign("AC1");
    expect(trace().code).toBe(0);
  });

  test("new-behavior ACs need red-green proof: a green-only run fails, and so does a test that already passed on base", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--acs", "DEMO-1-AC1"));
    expect(ark("test", run(), "--acs", "DEMO-1-AC2", "--red-green").code).toBe(1); // no-red: passes on base too
    acYml(["AC1", "unit"], ["AC2", "integration"]);
    const r = trace();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/DEMO-1-AC1: demo: no red-green proof at \w{12}/);
    expect(r.err).toMatch(/DEMO-1-AC2: demo: no red-green proof at \w{12}/);
    expect(row("DEMO-1-AC2")).toContain(" pass |"); // green outcome is shown, status is not
    expect(row("DEMO-1-AC2")).toEndWith("| fail |");
  });

  test("a flaky test is not a passing test", () => {
    toBuilding();
    commitAll(wt(), { "test/flaky.test.ts": FLAKY });
    expect(ark("test", run(), "--acs", "DEMO-1-AC3").code).toBe(1); // fail, rerun pass: flaky
    expect(events("test.result")[0].data.acs).toEqual({ "DEMO-1-AC3": "flaky" });
    acYml(["AC3", "integration"]);
    const r = trace();
    expect(r.code).toBe(1);
    expect(r.err).toContain("DEMO-1-AC3: no passing tagged test; demo: flaky");
    expect(row("DEMO-1-AC3")).toContain("flaky");
  });

  test("the newest evidence for an AC wins, whether it is a result or a red-green run", () => {
    toBuilding();
    implement({ "test/flaky.test.ts": FLAKY });
    acYml(["AC3", "integration"]);
    writeFileSync(counter, "");
    expect(ark("test", run(), "--acs", "DEMO-1-AC3").code).toBe(1); // flaky
    writeFileSync(counter, ""); // red sees one run (fails on its assertion), green sees two (passes)
    ok(ark("test", run(), "--acs", "DEMO-1-AC3", "--red-green"));
    expect(trace().code).toBe(0); // the red-green run is newer than the flaky result

    writeFileSync(counter, "");
    expect(ark("test", run(), "--acs", "DEMO-1-AC3").code).toBe(1); // flaky again, now newer than the proof
    expect(trace().err).toContain("DEMO-1-AC3: no passing tagged test; demo: flaky");
  });

  test("a repo with no tagged test for an AC does not fail an AC that another repo proves", () => {
    toBuilding();
    implement(HEAD_FILES);
    const other = addOtherRepo();
    ok(ark("ws", "create", run(), "--repo", other));
    ok(ark("advance", run(), "implementer.completed", "--data", '{"repo":"other"}'));
    ok(ark("test", run(), "--acs", "DEMO-1-AC1", "--red-green", "--repo", "demo"));
    expect(ark("test", run(), "--acs", "DEMO-1-AC1", "--repo", "other").code).toBe(1); // missing there
    expect(events("test.result").at(-1).data).toMatchObject({ repo: "other", acs: { "DEMO-1-AC1": "missing" } });
    acYml(["AC1"]);
    expect(trace().err).toBe("");
  });

  test("a manual AC needs a record with both signed-by: and at: lines", () => {
    toBuilding();
    acYml(["AC2", "manual"]);
    expect(trace().err).toContain("DEMO-1-AC2: manual AC has no signed record");
    sign("AC2", "signed-by: Pat Reviewer\n");
    expect(trace().code).toBe(1);
    sign("AC2", "at: 2026-10-21\n");
    expect(trace().code).toBe(1);
    sign("AC2", "- signed-by: Pat\nat: 2026-10-21\n"); // a bullet is not a signature line
    expect(trace().code).toBe(1);
    sign("AC2");
    expect(trace().code).toBe(0);
  });

  test("ac.yml must be schema-valid and list exactly the run's ACs", () => {
    toBuilding();
    acYml();
    ok(trace());
    writeAcs(RUN_ACS.map((id) => [id, "E2E"])); // level outside the enum
    let r = trace();
    expect(r.code).toBe(1);
    expect(r.err).toContain("level");

    writeFileSync(runFile("ac.yml"), "[]\n"); // every AC dropped
    r = trace();
    expect(r.code).toBe(1);
    expect(r.err).toContain("DEMO-1-AC1: in the run but missing from ac.yml");

    acYml();
    writeFileSync(runFile("ac.yml"), `${slurp("ac.yml")}- id: DEMO-1-AC7\n  text: t\n  level: manual\n`);
    r = trace();
    expect(r.code).toBe(1);
    expect(r.err).toContain("DEMO-1-AC7: in ac.yml but not an AC of this run");
  });
});

describe("ARK-106-AC3", () => {
  test("running it twice on the same inputs gives byte-identical output, and changing an input changes it", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--acs", "DEMO-1-AC1,DEMO-1-AC4", "--red-green"));
    acYml(["AC4", "integration"], ["AC2", "manual"], ["AC1"]);
    sign("AC2");

    ok(trace());
    const first = readFileSync(runFile("trace-matrix.md"));
    writeFileSync(runFile("trace-matrix.md"), "stale\n"); // the output does not depend on the previous file either
    ok(trace());
    expect(readFileSync(runFile("trace-matrix.md")).equals(first)).toBe(true);
    const [a, b] = events("trace.checked");
    expect(a.data.matrix_sha256).toBe(b.data.matrix_sha256);

    sign("AC2", "signed-by: Someone Else\nat: 2026-10-22\n"); // changed manual record
    ok(trace());
    expect(readFileSync(runFile("trace-matrix.md")).equals(first)).toBe(false);
    expect(row("DEMO-1-AC2")).toContain("Someone Else");

    sign("AC2");
    ok(ark("test", run(), "--acs", "DEMO-1-AC1")); // changed evidence: a newer attempt
    ok(trace());
    expect(row("DEMO-1-AC1")).toContain("artifacts/test/1, artifacts/test/2");
  });
});

describe("ARK-106-AC4", () => {
  test("G2 packet recomputes the check: refused while it fails, when the matrix is stale or edited, or when any input changed after a pass", () => {
    toJudging();
    acYml(["AC2", "manual"]);
    let r = ark("gate", "packet", run(), "G2");
    expect(r.code).toBe(1);
    expect(r.err).toContain("DEMO-1-AC2: manual AC has no signed record"); // no trace-check was ever run

    expect(trace().code).toBe(1); // unsigned
    r = ark("gate", "packet", run(), "G2");
    expect(r.code).toBe(1);
    expect(r.err).toContain("DEMO-1-AC2: manual AC has no signed record");
    expect(readdirSync(runFile("gates")).filter((f) => f.startsWith("G2."))).toEqual([]); // no G2 packet was written

    sign("AC2");
    expect(ark("gate", "packet", run(), "G2").err).toContain("out of date"); // passes now, but the matrix on disk is the failing one
    ok(trace());
    const good = matrix();
    writeFileSync(runFile("trace-matrix.md"), `${good}| tampered |\n`);
    expect(ark("gate", "packet", run(), "G2").err).toContain("out of date");
    writeFileSync(runFile("trace-matrix.md"), good);

    writeFileSync(runFile("manual/DEMO-1-AC2.md"), "nothing\n"); // a passing check's input is withdrawn afterwards
    expect(ark("gate", "packet", run(), "G2").err).toContain("DEMO-1-AC2: manual AC has no signed record");
    sign("AC2");
    writeFileSync(runFile("ac.yml"), "[]\n"); // and ac.yml emptied
    expect(ark("gate", "packet", run(), "G2").err).toContain("in the run but missing from ac.yml");
    acYml(["AC2", "manual"]);
    sign("AC2");

    r = ark("gate", "packet", run(), "G2");
    expect(r.err).toBe("");
    expect(r.out.trim()).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(slurp(`gates/G2.${r.out.trim().slice("sha256:".length)}.packet.md`)).toContain("| DEMO-1-AC2 | manual |");
    expect(JSON.parse(slurp("state.json")).state).toBe("awaiting_g2");
  });

  test("evidence counts only at the current HEAD: a proof from an older commit no longer passes once the code moved on", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--acs", "DEMO-1-AC1", "--red-green"));
    acYml(["AC1"]);
    expect(trace().code).toBe(0);
    commitAll(wt(), { "src/feature.ts": `export const feature = () => "broken";\n` }); // AC1's test now fails, but nobody reran it
    const r = trace();
    expect(r.code).toBe(1);
    expect(r.err).toContain("DEMO-1-AC1: no passing tagged test at the current HEAD");
    commitAll(wt(), { "src/feature.ts": HEAD_FILES["src/feature.ts"] });
    ok(ark("test", run(), "--acs", "DEMO-1-AC1")); // green again at the newest head, but red was proven on an older one
    expect(trace().err).toMatch(/DEMO-1-AC1: demo: no red-green proof at \w{12}/);
  });

  test("a dirty worktree at the proven HEAD gives no current evidence, for tracked edits and untracked files alike, and G2 refuses", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--acs", "DEMO-1-AC1", "--red-green"));
    ok(ark("advance", run(), "build.completed"));
    acYml(["AC1"]);
    ok(trace());
    writeFileSync(join(wt(), "src/feature.ts"), `export const feature = () => "edited after the proof";\n`); // tracked, uncommitted
    let r = trace();
    expect(r.code).toBe(1);
    expect(r.err).toContain("DEMO-1-AC1: no passing tagged test at the current HEAD; demo has uncommitted changes");
    expect(ark("gate", "packet", run(), "G2").err).toContain("demo has uncommitted changes");
    git(wt(), "checkout", "--", "src/feature.ts");
    ok(trace());
    writeFileSync(join(wt(), "src/untracked.ts"), "export {};\n");
    r = trace();
    expect(r.code).toBe(1);
    expect(r.err).toContain("demo has uncommitted changes");
    git(wt(), "clean", "-fdq");
    ok(trace());
    expect(ark("gate", "packet", run(), "G2").err).toBe("");
  });

  test("evidence from a repo that is not in the run, or red proven on a base other than the run's, does not count", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--acs", "DEMO-1-AC1", "--red-green"));
    acYml(["AC1"]);
    ok(trace());
    tamper("test.red_green", (d) => { d.base_sha = "f".repeat(40); });
    expect(trace().err).toContain("DEMO-1-AC1: no passing tagged test at the current HEAD");
    tamper("test.red_green", (d) => { d.base_sha = events("ws.created")[0].data.base_sha; d.repo = "ghost"; });
    expect(trace().err).toContain("DEMO-1-AC1: no passing tagged test at the current HEAD");
  });
});

describe("ARK-106 event ownership", () => {
  test("advance refuses events a dedicated command owns, so a trace receipt or test evidence cannot be forged, and G2 stays closed", () => {
    toJudging();
    acYml(["AC1"]); // automated AC with no evidence
    const forged: [event: string, data: object, owner: string][] = [
      ["trace.checked", { passed: true, failures: [], matrix_sha256: `sha256:${"0".repeat(64)}` }, "trace-check"],
      ["test.red_green", { repo: "demo", ok: true }, "test"],
      ["test.result", { repo: "demo" }, "test"],
      ["ws.created", { repo: "x", branch: "b", base_sha: "a" }, "ws"],
      ["gate.answered", { gate: "G2", answer: "approve" }, "gate"],
      ["gate.packet", { gate: "G2" }, "gate"],
    ];
    const ledgerBefore = slurp("ledger.ndjson");
    for (const [event, data, owner] of forged) {
      const r = ark("advance", run(), event, "--data", JSON.stringify(data));
      expect(r.code, event).toBe(1);
      expect(r.err, event).toContain(`written by 'ark ${owner}'`);
    }
    expect(slurp("ledger.ndjson")).toBe(ledgerBefore);
    writeFileSync(runFile("trace-matrix.md"), "| AC | Level |\n");
    expect(ark("gate", "packet", run(), "G2").code).toBe(1);
  });
});
