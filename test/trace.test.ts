import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rechain } from "./ledger";
import { setKinds } from "./kinds";
import { OMP_CONFIG } from "./omp-config";
import { spawnArk } from "./tty";

setDefaultTimeout(60_000);
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
// Git identity as config, passed only to ark itself so `ark gate answer` records an approver on CI machines without a global user.
const GIT_IDENTITY = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@t" };
const COMMAND_LINE_FILE = join(import.meta.dir, "..", "cli", "ark.ts");

// A tiny bun project, as in worktree-test: base has feature() = "old" and one green test; head adds the new behavior and its tests.
// AC1 fails on base (assertion), AC4 errors on base (module missing), AC2 passes on both, AC3 fails on its first run only, AC5 always fails.
const bunTest = (body: string, imports = "") => `import { describe, expect, test } from "bun:test";\n${imports}\n${body}\n`;
const HEAD_FILES = {
  "src/feature.ts": `export const feature = () => "new";\n`,
  "src/added.ts": `export const added = () => 42;\n`,
  "test/feature.test.ts": bunTest(`test("DEMO-1-AC1 new feature", () => { expect(feature()).toBe("new"); });`, `import { feature } from "../src/feature";`),
  // loaded inside the test: on base the failure is a JUnit record (a failing top-level import leaves none, and red then is inconclusive)
  "test/added.test.ts": bunTest(`test("DEMO-1-AC4 added module answers", async () => { const { added } = await import("../src/added"); expect(added()).toBe(42); });`),
};
const FLAKY = bunTest(
  `test("DEMO-1-AC3 fails on its first run only", () => { appendFileSync(process.env.FLAKY_COUNTER!, "x"); expect(readFileSync(process.env.FLAKY_COUNTER!, "utf8").length).toBeGreaterThan(1); });`,
  `import { appendFileSync, readFileSync } from "node:fs";`,
);
// One test carrying two AC tags; DEMO-1-AC9 is not an AC of the ticket.
const TYPO = bunTest(`test("DEMO-1-AC9 typo tag", () => { expect(1).toBe(1); });`);
const SHARED = bunTest(`test("DEMO-1-AC1 and DEMO-1-AC9 share one test", () => { expect(feature()).toBe("new"); });`, `import { feature } from "../src/feature";`);

// The suite's own environment: only PATH, HOME and the like of the caller's reach a suite.
const repositoryYaml = () => JSON.stringify({
  suites: { unit: { format: "bun-test", level: "integration", run: 'bun test -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml', junit: "$ARK_OUT/bun.xml", env: { vars: { FLAKY_COUNTER: counter } } } },
});

let home: string;
let projectDirectory: string;
let counter: string;

const git = (workingDirectory: string, ...argumentsList: string[]) => {
  const result = Bun.spawnSync(["git", ...argumentsList], { cwd: workingDirectory, env: process.env });
  if (result.exitCode !== 0) throw new Error(`git ${argumentsList.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};
const write = (directory: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
};
const commitAll = (directory: string, files: Record<string, string>) => {
  write(directory, files);
  git(directory, "add", "-A");
  git(directory, "commit", "-qm", "change");
};
// Every `ark test` in this file is the validator's step (it commits the tagged tests and then runs them), so it says so; a plain run is tested in integrity.test.ts.
const ark = (...argumentsList: string[]) => {
  const environment = { ...process.env, ...GIT_IDENTITY, ARK_HOME: home, FLAKY_COUNTER: counter };
  const result = spawnArk(["bun", COMMAND_LINE_FILE, ...(argumentsList[0] === "test" && !argumentsList.includes("--as") ? [...argumentsList, "--as", "validator"] : argumentsList)], { cwd: projectDirectory, env: environment });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};
const runsDirectory = () => join(home, "projects", "demo", "runs");
const run = () => readdirSync(runsDirectory()).filter((result) => result !== ".locks")[0];
const runFile = (file: string) => join(runsDirectory(), run(), file);
const slurp = (file: string) => readFileSync(runFile(file), "utf8");
const events = (type: string) => slurp("ledger.ndjson").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === type);
const worktree = () => runFile("worktrees/demo");
const matrix = () => slurp("trace-matrix.md");
const row = (id: string) => matrix().split("\n").find((line) => line.startsWith(`| ${id} |`))!;
const RUN_ACCEPTANCE_CRITERIA = ["AC1", "AC2", "AC3", "AC4", "AC5", "AC10"];
const sign = (id: string, body = "signed-by: Pat Reviewer\nat: 2026-10-21T10:00:00Z\n") => {
  mkdirSync(runFile("manual"), { recursive: true });
  writeFileSync(runFile(`manual/DEMO-1-${id}.md`), body);
};
const writeAcceptanceCriteria = (acceptanceCriteria: [id: string, level?: string, kind?: string][]) =>
  writeFileSync(runFile("ac.yml"), acceptanceCriteria.map(([id, level, kind = "new"]) => `- id: DEMO-1-${id}\n  text: t${level ? `\n  level: ${level}` : ""}\n  kind: ${kind}\n`).join(""));
// ac.yml must list exactly the run's ACs, so the ones a test does not care about are signed manual ACs.
const acceptanceCriteriaYaml = (...acceptanceCriteria: [id: string, level?: string, kind?: string][]) => {
  const old = Bun.YAML.parse(slurp("ac.yml")) as { id: string; kind?: string }[];
  const kinds = Object.fromEntries(old.map((acceptanceCriterion) => [acceptanceCriterion.id, acceptanceCriterion.kind]));
  const rest = RUN_ACCEPTANCE_CRITERIA.filter((id) => !acceptanceCriteria.some(([acceptanceCriterion]) => acceptanceCriterion === id));
  writeAcceptanceCriteria([
    ...acceptanceCriteria.map(([id, level, kind]) => [id, level, kind ?? kinds[`DEMO-1-${id}`]] as [string, string?, string?]),
    ...rest.map((id) => [id, "manual", kinds[`DEMO-1-${id}`]] as [string, string?, string?]),
  ]);
  for (const id of rest) sign(id);
};
// Rewrites the ledger line of the newest event of `type` (the tests' way to present evidence the CLI itself would never record).
const tamper = (type: string, edit: (data: Record<string, unknown>) => void) => {
  const lines = slurp("ledger.ndjson").trim().split("\n");
  const i = lines.findLastIndex((line) => JSON.parse(line).type === type);
  const event = JSON.parse(lines[i]);
  edit(event.data);
  lines[i] = JSON.stringify(event);
  writeFileSync(runFile("ledger.ndjson"), `${lines.join("\n")}\n`);
  rechain(dirname(runFile("ledger.ndjson"))); // the edit is the point, not a broken chain
};
const trace = () => ark("trace-check", run());

const ticket = `---
id: DEMO-1
title: "Add the feature"
status: ready
acceptance_criteria:
${[1, 2, 3, 4, 5, 10].map((number) => `  - id: DEMO-1-AC${number}\n    text: "criterion ${number}"`).join("\n")}
---
Body.
`;

// A project repo with a bun suite, a run started on it, and (via `to`) the lifecycle driven through the CLI up to that state.
function fixture() {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ark-fx-")));
  counter = join(root, "counter");
  projectDirectory = join(root, "demo");
  const bare = join(root, "remote.git");
  mkdirSync(projectDirectory);
  git(projectDirectory, "init", "-q", "-b", "main");
  commitAll(projectDirectory, {
    "ark.yml": "project: demo\n",
    ".omp/config.yml": OMP_CONFIG,
    ".gitignore": "node_modules\n",
    ".ark/repo.yml": repositoryYaml(),
    "src/feature.ts": `export const feature = () => "old";\n`,
    "test/stable.test.ts": bunTest(`test("DEMO-1-AC2 stays green", () => { expect(typeof feature()).toBe("string"); });`, `import { feature } from "../src/feature";`),
  });
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(projectDirectory, "remote", "add", "origin", bare);
  git(projectDirectory, "push", "-q", "origin", "main");
  git(projectDirectory, "remote", "set-head", "origin", "main");
  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  writeFileSync(join(home, "projects", "demo", "tickets", "DEMO-1.md"), ticket);
  ark("run", "start", "DEMO-1");
}
const ok = (result: { code: number; err: string }) => expect(result.err === "" ? result.code : result.err).toBe(0);
// start -> plan approved -> worktree create -> build.started
const toBuilding = (kinds: "new" | "preserved" | Record<string, "new" | "preserved"> = "new") => {
  ok(ark("log", "route", run(), "ticket", "fixture"));
  ok(ark("advance", run(), "analysis.completed"));
  writeFileSync(runFile("plan.md"), "# Plan\n");
  setKinds(runFile(""), kinds);
  const packetHash = ark("gate", "packet", run(), "plan").out.trim();
  ok(ark("gate", "answer", run(), "plan", "approve", "--packet", packetHash));
  ok(ark("worktree", "create", run()));
  ok(ark("advance", run(), "build.started"));
};
const toJudging = () => {
  toBuilding();
  ok(ark("advance", run(), "build.completed"));
};

// Product code belongs to the implementer; tagged tests are committed afterwards by the validator.
const implement = (files: Record<string, string>) => {
  const source = Object.fromEntries(Object.entries(files).filter(([file]) => !file.startsWith("test/")));
  const tests = Object.fromEntries(Object.entries(files).filter(([file]) => file.startsWith("test/")));
  if (Object.keys(source).length) commitAll(worktree(), source);
  ok(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'));
  if (Object.keys(tests).length) commitAll(worktree(), tests);
};
beforeEach(fixture);

// A second repo with a suite but no AC tags, added to the run as worktree 'other'.
const addOtherRepository = () => {
  const other = join(dirname(projectDirectory), "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  commitAll(other, { ".ark/repo.yml": repositoryYaml(), "test/untagged.test.ts": bunTest(`test("nothing tagged here", () => { expect(1).toBe(1); });`) });
  return other;
};

describe("ARK-106-AC1", () => {
  test("writes trace-matrix.md from ac.yml, the red-green and test evidence, and the manual record, rows sorted by AC number", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1,DEMO-1-AC4", "--red-green"));
    acceptanceCriteriaYaml(["AC4", "integration"], ["AC2", "manual"], ["AC1"]); // AC1 has no level: e2e by default
    sign("AC2");

    const result = trace();
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const [redGreenEvent] = events("test.red_green");
    const [base, head] = [redGreenEvent.data.base_sha.slice(0, 12), redGreenEvent.data.head_sha.slice(0, 12)];
    expect(row("DEMO-1-AC1")).toBe(`| DEMO-1-AC1 | new | e2e | test/feature.test.ts > DEMO-1-AC1 new feature | ${base} failure | ${head} pass | artifacts/test/1 | - | pass |`);
    expect(row("DEMO-1-AC2")).toBe("| DEMO-1-AC2 | new | manual | signed-by Pat Reviewer at 2026-10-21T10:00:00Z | - | - | manual/DEMO-1-AC2.md | - | pass |");
    expect(row("DEMO-1-AC4")).toBe(`| DEMO-1-AC4 | new | integration | test/added.test.ts > DEMO-1-AC4 added module answers | ${base} error | ${head} pass | artifacts/test/1 | - | pass |`);
    expect(matrix().split("\n").filter((line) => line.startsWith("| DEMO-1-AC")).map((line) => line.split(" | ")[0])).toEqual(["| DEMO-1-AC1", "| DEMO-1-AC2", "| DEMO-1-AC3", "| DEMO-1-AC4", "| DEMO-1-AC5", "| DEMO-1-AC10"]);
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
    acceptanceCriteriaYaml(["AC1"]);
    const result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toContain("DEMO-1-AC1: no passing tagged test");
    expect(row("DEMO-1-AC1")).toEndWith("| fail |");
    expect(events("trace.checked")[0].data).toMatchObject({ passed: false, failures: ["DEMO-1-AC1: no passing tagged test recorded"] });
  });

  test("a test tagged with an AC that is not the ticket's fails as an unknown tag, whether it also carries a real AC or only the typo", () => {
    toBuilding();
    implement({ "src/feature.ts": HEAD_FILES["src/feature.ts"], "test/shared.test.ts": SHARED, "test/typo.test.ts": TYPO });
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1", "--red-green"));
    acceptanceCriteriaYaml(["AC1"]);
    const result = trace();
    expect(result.code).toBe(1);
    expect(events("trace.checked")[0].data.failures).toEqual(["DEMO-1-AC9: unknown acceptance criterion (AC) tag, not an acceptance criterion (AC) of this run"]);
    expect(row("DEMO-1-AC1")).toEndWith("| pass |");
    expect(row("DEMO-1-AC9")).toEndWith("| fail |");
  });

  test("tags of other tickets' ACs are not unknown", () => {
    toBuilding();
    implement({ "src/feature.ts": HEAD_FILES["src/feature.ts"], "test/other.test.ts": bunTest(`test("OTHER-7-AC1 and DEMO-1-AC1 are tagged together", () => { expect(1).toBe(1); });`) });
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1"));
    acceptanceCriteriaYaml(["AC1", "manual"]);
    sign("AC1");
    expect(trace().code).toBe(0);
  });

  test("new-behavior ACs need red-green proof: a green-only run fails, and so does a test that already passed on base", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1"));
    expect(ark("test", run(), "--criteria", "DEMO-1-AC2", "--red-green").code).toBe(1); // no-red: passes on base too
    acceptanceCriteriaYaml(["AC1", "unit"], ["AC2", "integration"]);
    const result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/DEMO-1-AC1: demo: no red-green proof at \w{12}/);
    expect(result.err).toMatch(/DEMO-1-AC2: demo: no red-green proof at \w{12}/);
    expect(row("DEMO-1-AC2")).toContain(" pass |"); // green outcome is shown, status is not
    expect(row("DEMO-1-AC2")).toEndWith("| fail |");
  });

  test("a green run that passed shows as pass in the matrix even when its red was inconclusive", () => {
    toBuilding();
    implement({ ...HEAD_FILES, "test/static.test.ts": bunTest(`test("DEMO-1-AC5 static import", () => { expect(added()).toBe(42); });`, `import { added } from "../src/added";`) });
    expect(ark("test", run(), "--criteria", "DEMO-1-AC5", "--red-green").code).toBe(1); // base has no src/added: the file fails to load, no red record
    acceptanceCriteriaYaml(["AC5", "unit"]);
    const result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/DEMO-1-AC5: demo: no red-green proof at \w{12}/);
    expect(row("DEMO-1-AC5")).toMatch(/\| \w{12} pass \| artifacts/);
  });

  test("a flaky test is not a passing test", () => {
    toBuilding();
    commitAll(worktree(), { "test/flaky.test.ts": FLAKY });
    expect(ark("test", run(), "--criteria", "DEMO-1-AC3").code).toBe(1); // fail, rerun pass: flaky
    expect(events("test.result")[0].data.acs).toEqual({ "DEMO-1-AC3": "flaky" });
    acceptanceCriteriaYaml(["AC3", "integration"]);
    const result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toContain("DEMO-1-AC3: no passing tagged test; demo: flaky");
    expect(row("DEMO-1-AC3")).toContain("flaky");
  });

  test("the newest evidence for an AC wins, whether it is a result or a red-green run", () => {
    toBuilding();
    implement({ "test/flaky.test.ts": FLAKY });
    acceptanceCriteriaYaml(["AC3", "integration"]);
    writeFileSync(counter, "");
    expect(ark("test", run(), "--criteria", "DEMO-1-AC3").code).toBe(1); // flaky
    writeFileSync(counter, ""); // red sees one run (fails on its assertion), green sees two (passes)
    ok(ark("test", run(), "--criteria", "DEMO-1-AC3", "--red-green"));
    expect(trace().code).toBe(0); // the red-green run is newer than the flaky result

    writeFileSync(counter, "");
    expect(ark("test", run(), "--criteria", "DEMO-1-AC3").code).toBe(1); // flaky again, now newer than the proof
    expect(trace().err).toContain("DEMO-1-AC3: no passing tagged test; demo: flaky");
  });

  test("a repo with no tagged test for an AC does not fail an AC that another repo proves", () => {
    toBuilding();
    implement(HEAD_FILES);
    const other = addOtherRepository();
    ok(ark("worktree", "create", run(), "--repo", other));
    ok(ark("advance", run(), "implementer.completed", "--data", '{"repo":"other"}'));
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1", "--red-green", "--repo", "demo"));
    expect(ark("test", run(), "--criteria", "DEMO-1-AC1", "--repo", "other").code).toBe(1); // missing there
    expect(events("test.result").at(-1).data).toMatchObject({ repo: "other", acs: { "DEMO-1-AC1": "missing" } });
    acceptanceCriteriaYaml(["AC1"]);
    expect(trace().err).toBe("");
  });

  test("a manual AC needs a record with both signed-by: and at: lines", () => {
    toBuilding();
    acceptanceCriteriaYaml(["AC2", "manual"]);
    expect(trace().err).toContain("DEMO-1-AC2: manual acceptance criterion (AC) has no signed record");
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
    acceptanceCriteriaYaml();
    ok(trace());
    writeAcceptanceCriteria(RUN_ACCEPTANCE_CRITERIA.map((id) => [id, "E2E"])); // level outside the enum
    let result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toContain("level");

    writeFileSync(runFile("ac.yml"), "[]\n"); // every AC dropped
    result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toContain("DEMO-1-AC1: in the run but missing from ac.yml");

    acceptanceCriteriaYaml();
    writeFileSync(runFile("ac.yml"), `${slurp("ac.yml")}- id: DEMO-1-AC7\n  text: t\n  level: manual\n`);
    result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toContain("DEMO-1-AC7: in ac.yml but not an acceptance criterion (AC) of this run");
  });
});

describe("ARK-106-AC3", () => {
  test("running it twice on the same inputs gives byte-identical output, and changing an input changes it", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1,DEMO-1-AC4", "--red-green"));
    acceptanceCriteriaYaml(["AC4", "integration"], ["AC2", "manual"], ["AC1"]);
    sign("AC2");

    ok(trace());
    const first = readFileSync(runFile("trace-matrix.md"));
    writeFileSync(runFile("trace-matrix.md"), "stale\n"); // the output does not depend on the previous file either
    ok(trace());
    expect(readFileSync(runFile("trace-matrix.md")).equals(first)).toBe(true);
    const [firstTraceEvent, secondTraceEvent] = events("trace.checked");
    expect(firstTraceEvent.data.matrix_sha256).toBe(secondTraceEvent.data.matrix_sha256);

    sign("AC2", "signed-by: Someone Else\nat: 2026-10-22\n"); // changed manual record
    ok(trace());
    expect(readFileSync(runFile("trace-matrix.md")).equals(first)).toBe(false);
    expect(row("DEMO-1-AC2")).toContain("Someone Else");

    sign("AC2");
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1")); // changed evidence: a newer attempt
    ok(trace());
    expect(row("DEMO-1-AC1")).toContain("artifacts/test/1, artifacts/test/2");
  });
});

describe("ARK-106-AC4", () => {
  test("evidence packet recomputes the check: refused while it fails, when the matrix is stale or edited, or when any input changed after a pass", () => {
    toJudging();
    acceptanceCriteriaYaml(["AC2", "manual"]);
    let result = ark("gate", "packet", run(), "evidence");
    expect(result.code).toBe(1);
    expect(result.err).toContain("DEMO-1-AC2: manual acceptance criterion (AC) has no signed record"); // no trace-check was ever run

    expect(trace().code).toBe(1); // unsigned
    result = ark("gate", "packet", run(), "evidence");
    expect(result.code).toBe(1);
    expect(result.err).toContain("DEMO-1-AC2: manual acceptance criterion (AC) has no signed record");
    expect(readdirSync(runFile("gates")).filter((file) => file.startsWith("evidence."))).toEqual([]); // no evidence packet was written

    sign("AC2");
    expect(ark("gate", "packet", run(), "evidence").err).toContain("out of date"); // passes now, but the matrix on disk is the failing one
    ok(trace());
    const good = matrix();
    writeFileSync(runFile("trace-matrix.md"), `${good}| tampered |\n`);
    expect(ark("gate", "packet", run(), "evidence").err).toContain("out of date");
    writeFileSync(runFile("trace-matrix.md"), good);

    writeFileSync(runFile("manual/DEMO-1-AC2.md"), "nothing\n"); // a passing check's input is withdrawn afterwards
    expect(ark("gate", "packet", run(), "evidence").err).toContain("DEMO-1-AC2: manual acceptance criterion (AC) has no signed record");
    sign("AC2");
    writeFileSync(runFile("ac.yml"), "[]\n"); // and ac.yml emptied
    expect(ark("gate", "packet", run(), "evidence").err).toContain("in the run but missing from ac.yml");
    acceptanceCriteriaYaml(["AC2", "manual"]);
    sign("AC2");

    result = ark("gate", "packet", run(), "evidence");
    expect(result.err).toBe("");
    expect(result.out.trim()).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(slurp(`gates/evidence.${result.out.trim().slice("sha256:".length)}.packet.md`)).toContain("| DEMO-1-AC2 | new | manual |");
    expect(JSON.parse(slurp("state.json")).state).toBe("awaiting_evidence");
  });

  test("evidence counts only at the current HEAD: a proof from an older commit no longer passes once the code moved on", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1", "--red-green"));
    acceptanceCriteriaYaml(["AC1"]);
    expect(trace().code).toBe(0);
    commitAll(worktree(), { "src/feature.ts": `export const feature = () => "broken";\n` }); // AC1's test now fails, but nobody reran it
    const result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toContain("DEMO-1-AC1: no passing tagged test at the current HEAD");
    commitAll(worktree(), { "src/feature.ts": HEAD_FILES["src/feature.ts"] });
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1")); // green again at the newest head, but red was proven on an older one
    expect(trace().err).toMatch(/DEMO-1-AC1: demo: no red-green proof at \w{12}/);
  });

  test("a dirty worktree at the proven HEAD gives no current evidence, for tracked edits and untracked files alike, and evidence refuses", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1", "--red-green"));
    ok(ark("advance", run(), "build.completed"));
    acceptanceCriteriaYaml(["AC1"]);
    ok(trace());
    writeFileSync(join(worktree(), "src/feature.ts"), `export const feature = () => "edited after the proof";\n`); // tracked, uncommitted
    let result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toContain("DEMO-1-AC1: no passing tagged test at the current HEAD; demo has uncommitted changes");
    expect(ark("gate", "packet", run(), "evidence").err).toContain("demo has uncommitted changes");
    git(worktree(), "checkout", "--", "src/feature.ts");
    ok(trace());
    writeFileSync(join(worktree(), "src/untracked.ts"), "export {};\n");
    result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toContain("demo has uncommitted changes");
    git(worktree(), "clean", "-fdq");
    ok(trace());
    expect(ark("gate", "packet", run(), "evidence").err).toBe("");
  });

  test("evidence from a repo that is not in the run, or red proven on a base other than the run's, does not count", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1", "--red-green"));
    acceptanceCriteriaYaml(["AC1"]);
    ok(trace());
    tamper("test.red_green", (data) => { data.base_sha = "f".repeat(40); });
    expect(trace().err).toContain("DEMO-1-AC1: no passing tagged test at the current HEAD");
    tamper("test.red_green", (data) => { data.base_sha = events("worktree.created")[0].data.base_sha; data.repo = "ghost"; });
    expect(trace().err).toContain("DEMO-1-AC1: no passing tagged test at the current HEAD");
  });
});

describe("ARK-106 event ownership", () => {
  test("advance refuses events a dedicated command owns, so a trace receipt or test evidence cannot be forged, and evidence stays closed", () => {
    toJudging();
    acceptanceCriteriaYaml(["AC1"]); // automated AC with no evidence
    const forged: [event: string, data: object, owner: string][] = [
      ["trace.checked", { passed: true, failures: [], matrix_sha256: `sha256:${"0".repeat(64)}` }, "trace-check"],
      ["test.red_green", { repo: "demo", ok: true }, "test"],
      ["test.result", { repo: "demo" }, "test"],
      ["worktree.created", { repo: "x", branch: "b", base_sha: "a" }, "worktree create"],
      ["gate.answered", { gate: "evidence", answer: "approve" }, "gate"],
      ["gate.packet", { gate: "evidence" }, "gate"],
    ];
    const ledgerBefore = slurp("ledger.ndjson");
    for (const [event, data, owner] of forged) {
      const result = ark("advance", run(), event, "--data", JSON.stringify(data));
      expect(result.code, event).toBe(1);
      expect(result.err, event).toContain(`written by 'ark ${owner}'`);
    }
    expect(slurp("ledger.ndjson")).toBe(ledgerBefore);
    writeFileSync(runFile("trace-matrix.md"), "| AC | Level |\n");
    expect(ark("gate", "packet", run(), "evidence").code).toBe(1);
  });
});

describe("ARK-117-AC5", () => {
  test("a preserved AC needs preservation proof: a green run alone fails, and a passing preservation run (pass on base and on head) satisfies it", () => {
    toBuilding({ "DEMO-1-AC2": "preserved" });
    implement(HEAD_FILES);
    ok(ark("test", run(), "--criteria", "DEMO-1-AC2")); // AC2 passes on base and on head
    acceptanceCriteriaYaml(["AC2", "integration"]);
    const refused = trace();
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/DEMO-1-AC2: demo: no preservation proof at \w{12}/);

    ok(ark("test", run(), "--criteria", "DEMO-1-AC2", "--preservation"));
    expect(events("test.preservation")[0].data).toMatchObject({ acs: { "DEMO-1-AC2": "preserved" }, ok: true });
    const passed = trace();
    expect(passed.err).toBe("");
    const base = events("test.preservation")[0].data.base_sha.slice(0, 12);
    expect(row("DEMO-1-AC2")).toMatch(new RegExp(`^\\| DEMO-1-AC2 \\| preserved \\| integration \\| .*\\| ${base} pass \\| \\w{12} pass \\|.*\\| pass \\|$`));
  });

  test("a test that fails on the base is not preserved behavior, and a new AC is not satisfied by preservation proof", () => {
    toBuilding({ "DEMO-1-AC1": "preserved", "DEMO-1-AC2": "new" });
    implement(HEAD_FILES);
    const failing = ark("test", run(), "--criteria", "DEMO-1-AC1", "--preservation"); // AC1 fails on base
    expect(failing.code).toBe(1);
    expect(failing.out).toContain("DEMO-1-AC1: not-preserved");
    ok(ark("test", run(), "--criteria", "DEMO-1-AC2", "--preservation"));
    acceptanceCriteriaYaml(["AC1", "e2e"], ["AC2", "integration"]);
    const result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/DEMO-1-AC1: .*no preservation proof/);
    expect(result.err).toMatch(/DEMO-1-AC2: demo: no red-green proof/);
  });

  test("trace-check rejects an ac.yml kind changed after plan approved it", () => {
    toBuilding({ "DEMO-1-AC1": "preserved" });
    writeAcceptanceCriteria(RUN_ACCEPTANCE_CRITERIA.map((id): [string, string, string] => [id, "manual", "new"]));
    for (const id of RUN_ACCEPTANCE_CRITERIA) sign(id);
    const result = trace();
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/DEMO-1-AC1.*kind/i);
  });
});


describe("ARK-117-AC9", () => {
  test("screenshots saved under artifacts/screenshots/<AC-ID>/ are listed in that AC's row, and only there", () => {
    toBuilding();
    implement(HEAD_FILES);
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1,DEMO-1-AC4", "--red-green"));
    acceptanceCriteriaYaml(["AC1"], ["AC4", "integration"]);
    mkdirSync(runFile("artifacts/screenshots/DEMO-1-AC1"), { recursive: true });
    writeFileSync(runFile("artifacts/screenshots/DEMO-1-AC1/b-after.png"), "png");
    writeFileSync(runFile("artifacts/screenshots/DEMO-1-AC1/a-before.png"), "png");
    expect(trace().err).toBe("");
    expect(row("DEMO-1-AC1")).toContain("| artifacts/screenshots/DEMO-1-AC1/a-before.png, artifacts/screenshots/DEMO-1-AC1/b-after.png | pass |");
    expect(row("DEMO-1-AC4")).toEndWith("| artifacts/test/1 | - | pass |");
    expect(matrix()).toContain("| Screenshots | Status |");
  });
});
