import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
// One test carrying two AC tags: selecting AC1 records AC4 as a tag on the test.
const SHARED = bunTest(`test("DEMO-1-AC1 and DEMO-1-AC4 share one test", () => { expect(feature()).toBe("new"); });`, `import { feature } from "../src/feature";`);

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
const acYml = (...acs: [id: string, level?: string][]) =>
  writeFileSync(runFile("ac.yml"), acs.map(([id, level]) => `- id: DEMO-1-${id}\n  text: t${level ? `\n  level: ${level}` : ""}\n`).join(""));
const sign = (id: string, body = "signed-by: Pat Reviewer\nat: 2026-10-21T10:00:00Z\n") => {
  mkdirSync(runFile("manual"), { recursive: true });
  writeFileSync(runFile(`manual/DEMO-1-${id}.md`), body);
};
const trace = () => ark("trace-check", run());

const ticket = `---
id: DEMO-1
title: "Add the feature"
status: ready
acceptance_criteria:
${[1, 2, 3, 4, 5].map((n) => `  - id: DEMO-1-AC${n}\n    text: "criterion ${n}"`).join("\n")}
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
  const suite = { format: "bun-test", level: "integration", run: 'bun test -t "{tags}" --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml', junit: "$ARK_OUT/bun.xml" };
  commitAll(proj, {
    "ark.yml": "project: demo\n",
    ".gitignore": "node_modules\n",
    ".ark/repo.yml": JSON.stringify({ suites: { unit: suite } }),
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

beforeEach(fixture);

describe("ARK-106-AC1", () => {
  test("writes trace-matrix.md from ac.yml, the red-green and test evidence, and the manual record, rows sorted by AC ID", () => {
    toBuilding();
    commitAll(wt(), HEAD_FILES);
    ok(ark("test", run(), "--acs", "DEMO-1-AC1,DEMO-1-AC4", "--red-green"));
    acYml(["AC4", "integration"], ["AC2", "manual"], ["AC1"]); // AC1 has no level: e2e by default
    sign("AC2");

    const r = trace();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const [rg] = events("test.red_green");
    const [base, head] = [rg.data.base_sha.slice(0, 12), rg.data.head_sha.slice(0, 12)];
    expect(matrix().split("\n").slice(4, 7)).toEqual([
      `| DEMO-1-AC1 | e2e | test/feature.test.ts > DEMO-1-AC1 new feature | ${base} failure | ${head} pass | artifacts/test/1 | pass |`,
      "| DEMO-1-AC2 | manual | signed-by Pat Reviewer at 2026-10-21T10:00:00Z | - | - | manual/DEMO-1-AC2.md | pass |",
      `| DEMO-1-AC4 | integration | test/added.test.ts > DEMO-1-AC4 added module answers | ${base} error | ${head} pass | artifacts/test/1 | pass |`,
    ]);
    expect(matrix().split("\n")[0]).toContain(run());
    expect(events("trace.checked")[0].data).toEqual({
      passed: true,
      failures: [],
      matrix_sha256: `sha256:${new Bun.CryptoHasher("sha256").update(readFileSync(runFile("trace-matrix.md"))).digest("hex")}`,
    });
    expect(ark("run", "replay", run(), "--check").code).toBe(0);
  });
});

describe("ARK-106-AC1 ordering", () => {
  test("rows sort by AC number, not text: AC2 comes before AC10", () => {
    toBuilding();
    acYml(["AC10", "manual"], ["AC2", "manual"]);
    sign("AC10");
    sign("AC2");
    ok(trace());
    expect(matrix().split("\n").slice(4, 6).map((l) => l.split(" | ")[0])).toEqual(["| DEMO-1-AC2", "| DEMO-1-AC10"]);
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

  test("a test that names an AC missing from ac.yml fails as an unknown tag, even though its own AC is proven", () => {
    toBuilding();
    commitAll(wt(), { "src/feature.ts": HEAD_FILES["src/feature.ts"], "test/shared.test.ts": SHARED });
    ok(ark("test", run(), "--acs", "DEMO-1-AC1", "--red-green"));
    acYml(["AC1"]);
    const r = trace();
    expect(r.code).toBe(1);
    expect(r.err).toContain("DEMO-1-AC4: unknown AC, not in ac.yml (tagged on: test/shared.test.ts > DEMO-1-AC1 and DEMO-1-AC4 share one test)");
    expect(row("DEMO-1-AC1")).toEndWith("| pass |");
    expect(row("DEMO-1-AC4")).toEndWith("| fail |");
  });

  test("new-behavior ACs need red-green proof: a green-only run fails, and so does a test that already passed on base", () => {
    toBuilding();
    commitAll(wt(), HEAD_FILES);
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
});

describe("ARK-106-AC3", () => {
  test("running it twice on the same inputs gives byte-identical output, and changing an input changes it", () => {
    toBuilding();
    commitAll(wt(), HEAD_FILES);
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
  test("G2 packet is refused with no trace-check, with a failed one, and after the matrix is edited or newer tests ran; a passing one builds it", () => {
    toJudging();
    acYml(["AC2", "manual"]);
    let r = ark("gate", "packet", run(), "G2");
    expect(r.code).toBe(1);
    expect(r.err).toContain("ark trace-check");

    expect(trace().code).toBe(1); // unsigned
    r = ark("gate", "packet", run(), "G2");
    expect(r.code).toBe(1);
    expect(r.err).toContain("DEMO-1-AC2: manual AC has no signed record");
    expect(() => readFileSync(runFile("gates/G2.packet.md"))).toThrow();

    sign("AC2");
    ok(trace());
    writeFileSync(runFile("trace-matrix.md"), `${matrix()}| tampered |\n`);
    expect(ark("gate", "packet", run(), "G2").err).toContain("changed since trace-check");

    ok(trace());
    ok(ark("test", run(), "--acs", "DEMO-1-AC2")); // newer evidence than the check
    expect(ark("gate", "packet", run(), "G2").err).toContain("tests ran after the last trace-check");

    ok(trace());
    r = ark("gate", "packet", run(), "G2");
    expect(r.err).toBe("");
    expect(r.out.trim()).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(slurp("gates/G2.packet.md")).toContain("| DEMO-1-AC2 | manual |");
    expect(JSON.parse(slurp("state.json")).state).toBe("awaiting_g2");
  });
});
