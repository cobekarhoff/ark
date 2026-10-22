import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

setDefaultTimeout(60_000);
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

const CLI = join(import.meta.dir, "..", "cli", "ark.ts");
const DOCKER_ARGS = "compose-args: compose images --format json";

// Fixture sources: a tiny bun project. AC1 fails on base (assertion), AC4 errors on base (module missing), AC2 passes on both,
// AC3 fails on its first run only (counter file), AC5 always fails.
const bunTest = (body: string, imports = "") => `import { describe, expect, test } from "bun:test";\n${imports}\n${body}\n`;
const FEATURE_TEST = bunTest(
  `describe("DEMO-1-AC1 new feature", () => { describe("nested", () => { test("returns the new value", () => { expect(feature()).toBe("new"); }); }); });`,
  `import { feature } from "../src/feature";`,
);
const ADDED_TEST = bunTest(`test("DEMO-1-AC4 added module answers", () => { expect(added()).toBe(42); });`, `import { added } from "../src/added";`);
const FLAKY_TEST = bunTest(
  `test("DEMO-1-AC3 fails on its first run only", () => { appendFileSync(process.env.FLAKY_COUNTER!, "x"); expect(readFileSync(process.env.FLAKY_COUNTER!, "utf8").length).toBeGreaterThan(1); });`,
  `import { appendFileSync, readFileSync } from "node:fs";`,
);
const BROKEN_TEST = bunTest(`test("DEMO-1-AC5 never passes", () => { expect(1).toBe(2); });`);
const HEAD_FILES = {
  "src/feature.ts": `export const feature = () => "new";\n`,
  "src/added.ts": `export const added = () => 42;\n`,
  "test/feature.test.ts": FEATURE_TEST,
  "test/added.test.ts": ADDED_TEST,
};

let home: string;
let root: string;
let proj: string; // the project repo: holds ark.yml, has an origin
let bare: string;
let bin: string; // PATH shim for docker
let counter: string;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env }); // explicit: spawnSync would otherwise ignore the identity set above
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const write = (dir: string, files: Record<string, string>) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
};
const commitAll = (dir: string, files: Record<string, string>, msg = "change") => {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg);
};
const ark = (...args: string[]) => {
  const env = { ...process.env, ARK_HOME: home, FLAKY_COUNTER: counter, PATH: `${bin}:${process.env.PATH}` };
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: proj, env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const runsDir = () => join(home, "projects", "demo", "runs");
const run = () => readdirSync(runsDir())[0];
const runFile = (f: string) => join(runsDir(), run(), f);
const state = () => JSON.parse(readFileSync(runFile("state.json"), "utf8"));
const events = (type: string) =>
  readFileSync(runFile("ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === type);
const wt = () => runFile("ws/demo");
const slurp = (p: string) => readFileSync(p, "utf8");

const ticket = `---
id: DEMO-1
title: "Add the feature, with a Long Title!"
status: ready
milestone: M1a
traces: [FR-01]
depends_on: []
acceptance_criteria:
${[1, 2, 3, 4, 5].map((n) => `  - id: DEMO-1-AC${n}\n    text: "criterion ${n}"`).join("\n")}
---
Body.
`;

// A project repo with an origin, a unit suite and (optionally) env.up/env.down that log their order.
function fixture(up = "echo up >> $ARK_OUT/order") {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  root = realpathSync(mkdtempSync(join(tmpdir(), "ark-fx-")));
  bin = join(root, "bin");
  counter = join(root, "counter");
  write(root, { "bin/docker": `#!/bin/sh\necho "compose-args: $*"\n` });
  chmodSync(join(bin, "docker"), 0o755);

  proj = join(root, "demo");
  bare = join(root, "remote.git");
  mkdirSync(proj);
  git(proj, "init", "-q", "-b", "main");
  const suite = {
    format: "bun-test",
    level: "integration",
    run: 'echo run >> $ARK_OUT/order; bun test -t "{tags}" --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml',
    junit: "$ARK_OUT/bun.xml",
    env: { up, down: "echo down >> $ARK_OUT/order" },
  };
  commitAll(proj, {
    "ark.yml": "project: demo\n",
    ".gitignore": "node_modules\n",
    ".ark/repo.yml": JSON.stringify({ suites: { unit: suite } }),
    "src/feature.ts": `export const feature = () => "old";\n`,
    "test/stable.test.ts": bunTest(`test("DEMO-1-AC2 stays green", () => { expect(typeof feature()).toBe("string"); });`, `import { feature } from "../src/feature";`),
    "test/plain.test.ts": bunTest(`test("untagged helper check", () => { expect(1).toBe(1); });`),
  }, "base");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(proj, "remote", "add", "origin", bare);
  git(proj, "push", "-q", "origin", "main");
  git(proj, "remote", "set-head", "origin", "main");

  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  writeFileSync(join(home, "projects", "demo", "tickets", "DEMO-1.md"), ticket);
  ark("run", "start", "DEMO-1");
}
const toApproved = () => {
  for (const e of ["analysis.completed", "g1.opened", "g1.approved"]) expect(ark("advance", run(), e).code).toBe(0);
};
const toBuilding = (...extra: string[]) => {
  toApproved();
  const ws = ark("ws", "create", run(), ...extra);
  expect(ws.err).toBe("");
  expect(ark("advance", run(), "build.started").code).toBe(0);
};

beforeEach(() => fixture());

describe("ARK-105-AC1", () => {
  test("ws create makes <run>/ws/<repo> on ark/<ticket>-<slug> from origin's default branch, and git push from it fails", () => {
    toApproved();
    const r = ark("ws", "create", run());
    expect(r.code).toBe(0);
    const base = git(proj, "rev-parse", "origin/main");
    expect(git(wt(), "branch", "--show-current")).toBe("ark/DEMO-1-add-the-feature-with-a-long-title");
    expect(git(wt(), "rev-parse", "HEAD")).toBe(base);
    expect(state().repos).toEqual([
      { name: "demo", order: 1, branch: "ark/DEMO-1-add-the-feature-with-a-long-title", base_sha: base, head_sha: null, step: "pending" },
    ]);

    commitAll(wt(), { "x.txt": "x" });
    const push = Bun.spawnSync(["git", "push", "origin", "HEAD"], { cwd: wt() });
    expect(push.exitCode).not.toBe(0);
    expect(git(bare, "branch", "--list").includes("ark/")).toBe(false);
    // the main checkout shares the repo but keeps its push URL
    git(proj, "push", "-q", "origin", "HEAD:refs/heads/probe");
    expect(git(bare, "branch", "--list", "probe")).toContain("probe");
  });

  test("ws create is refused before the run is approved, and twice for the same repo", () => {
    const early = ark("ws", "create", run());
    expect(early.code).toBe(1);
    expect(early.err).toContain("illegal event 'ws.created' in state 'intake'");
    toApproved();
    expect(ark("ws", "create", run()).code).toBe(0);
    expect(ark("ws", "create", run()).err).toContain("already has a worktree");
  });

  test("--repo makes a worktree for another repo, named after that repo", () => {
    const lib = join(root, "lib");
    mkdirSync(lib);
    git(lib, "init", "-q", "-b", "main");
    commitAll(lib, { "a.txt": "a" });
    toApproved();
    expect(ark("ws", "create", run(), "--repo", lib).code).toBe(0);
    expect(state().repos.map((r: { name: string }) => r.name)).toEqual(["lib"]);
    expect(existsSync(runFile("ws/lib/a.txt"))).toBe(true);
  });
});

describe("ARK-105-AC2", () => {
  test("runs the suite for the selected ACs around env.up and env.down, and saves JUnit, logs and a fingerprint", () => {
    toBuilding();
    commitAll(wt(), HEAD_FILES);
    const r = ark("test", run(), "--acs", "DEMO-1-AC1,DEMO-1-AC2");
    expect(r.code).toBe(0);
    const out = runFile("artifacts/test/1");
    expect(slurp(join(out, "order"))).toBe("up\nrun\ndown\n");
    expect(readdirSync(out).sort()).toEqual(["bun.xml", "fingerprint.json", "order", "unit.env-down.stderr.log", "unit.env-down.stdout.log", "unit.env-up.stderr.log", "unit.env-up.stdout.log", "unit.stderr.log", "unit.stdout.log"]);
    expect(slurp(join(out, "bun.xml"))).toContain("DEMO-1-AC1");
    expect(slurp(join(out, "unit.stderr.log"))).toContain("pass");
    expect(JSON.parse(slurp(join(out, "fingerprint.json")))).toMatchObject({
      git_sha: git(wt(), "rev-parse", "HEAD"),
      bun: Bun.version,
      os: expect.stringContaining(process.platform),
      images: [{ suite: "unit", exit: 0, output: DOCKER_ARGS }],
    });

    const [ev] = events("test.result");
    expect(ev.data).toMatchObject({ repo: "demo", head_sha: git(wt(), "rev-parse", "HEAD"), attempt: 1, out: "artifacts/test/1", acs: { "DEMO-1-AC1": "pass", "DEMO-1-AC2": "pass" } });
    expect(ark("run", "replay", run(), "--check").code).toBe(0);
    expect(ark("test", run(), "--acs", "DEMO-1-AC2").code).toBe(0);
    expect(readdirSync(runFile("artifacts/test")).sort()).toEqual(["1", "2"]);
  });

  test("env.down still runs when the tests fail, and when env.up fails; no environment means no docker call", () => {
    toBuilding();
    commitAll(wt(), { "test/broken.test.ts": BROKEN_TEST });
    expect(ark("test", run(), "--acs", "DEMO-1-AC5").code).toBe(1);
    expect(slurp(runFile("artifacts/test/1/order"))).toBe("up\nrun\ndown\n");
    expect(slurp(runFile("artifacts/test/1/rerun/order"))).toBe("run\n"); // the failing test was rerun once

    commitAll(wt(), { ".ark/repo.yml": JSON.stringify({ suites: { unit: { format: "bun-test", level: "unit", run: 'bun test -t "{tags}" --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml', junit: "$ARK_OUT/bun.xml" } } }) });
    expect(ark("test", run(), "--acs", "DEMO-1-AC2").code).toBe(0);
    expect(JSON.parse(slurp(runFile("artifacts/test/2/fingerprint.json"))).images).toEqual([]);
  });

  test("a failing env.up fails the run with a message and still runs env.down", () => {
    fixture("echo up >> $ARK_OUT/order; exit 3");
    toBuilding();
    const r = ark("test", run(), "--acs", "DEMO-1-AC2");
    expect(r.code).toBe(1);
    expect(r.err).toContain("env.up failed");
    expect(slurp(runFile("artifacts/test/1/order"))).toBe("up\ndown\n");
    expect(events("test.result")).toEqual([]);
  });

  test("refuses unknown ACs, a dirty worktree, and a state that cannot test", () => {
    toApproved();
    ark("ws", "create", run());
    expect(ark("test", run(), "--acs", "DEMO-1-AC2").err).toContain("illegal event 'test.result' in state 'approved'");
    ark("advance", run(), "build.started");
    expect(ark("test", run(), "--acs", "DEMO-1-AC9").err).toContain("unknown: DEMO-1-AC9");
    writeFileSync(join(wt(), "src/feature.ts"), "// dirty\n");
    expect(ark("test", run(), "--acs", "DEMO-1-AC2").err).toContain("uncommitted changes");
  });
});

describe("ARK-105-AC3", () => {
  test("red runs the head test files on the base source and each tagged test fails or errors, recording which; green passes on head", () => {
    toBuilding();
    commitAll(wt(), HEAD_FILES);
    const r = ark("test", run(), "--acs", "DEMO-1-AC1,DEMO-1-AC4", "--red-green");
    expect(r.code).toBe(0);
    const [ev] = events("test.red_green");
    expect(ev.data).toMatchObject({
      repo: "demo",
      base_sha: git(proj, "rev-parse", "origin/main"),
      head_sha: git(wt(), "rev-parse", "HEAD"),
      overlay: ["test/added.test.ts", "test/feature.test.ts"],
      acs: { "DEMO-1-AC1": "proven", "DEMO-1-AC4": "proven" },
      ok: true,
    });
    const byAc = Object.fromEntries(ev.data.tests.map((t: { acs: string[] }) => [t.acs[0], t]));
    expect(byAc["DEMO-1-AC1"]).toMatchObject({ red: "failure", green: "pass" }); // wrong value: assertion failure
    expect(byAc["DEMO-1-AC4"]).toMatchObject({ red: "error", green: "pass" }); // src/added.ts missing: the file fails to load
    expect(slurp(runFile("artifacts/test/1/red/order"))).toBe("up\nrun\ndown\n");
    expect(slurp(runFile("artifacts/test/1/green/order"))).toBe("up\nrun\ndown\n");
    expect(JSON.parse(slurp(runFile("artifacts/test/1/fingerprint.json")))).toMatchObject({ base_sha: ev.data.base_sha, git_sha: ev.data.head_sha });
    expect(git(proj, "worktree", "list").split("\n")).toHaveLength(2); // the temporary base worktree is gone
    expect(ark("run", "replay", run(), "--check").code).toBe(0);
  });
});

describe("ARK-105-AC4", () => {
  test("a tagged test that passes on the red run fails the check, and the other ACs still report", () => {
    toBuilding();
    commitAll(wt(), HEAD_FILES);
    const r = ark("test", run(), "--acs", "DEMO-1-AC1,DEMO-1-AC2", "--red-green");
    expect(r.code).toBe(1);
    expect(r.out).toContain("DEMO-1-AC2: no-red");
    const [ev] = events("test.red_green");
    expect(ev.data.ok).toBe(false);
    expect(ev.data.acs).toEqual({ "DEMO-1-AC1": "proven", "DEMO-1-AC2": "no-red" });
    expect(ev.data.tests.find((t: { acs: string[] }) => t.acs[0] === "DEMO-1-AC2")).toMatchObject({ red: "pass", green: "pass" });
  });
});

describe("ARK-105-AC5", () => {
  test("a failing tagged test is rerun once: fail then pass is flaky and not green, fail then fail is a fail", () => {
    toBuilding();
    commitAll(wt(), { "test/flaky.test.ts": FLAKY_TEST, "test/broken.test.ts": BROKEN_TEST });
    const r = ark("test", run(), "--acs", "DEMO-1-AC3,DEMO-1-AC5");
    expect(r.code).toBe(1);
    const [ev] = events("test.result");
    expect(ev.data.acs).toEqual({ "DEMO-1-AC3": "flaky", "DEMO-1-AC5": "fail" });
    expect(ev.data.tests.map((t: { status: string }) => t.status).sort()).toEqual(["failure", "flaky"]);
    expect(slurp(counter)).toBe("xx"); // exactly one rerun
  });
});

describe("ARK-105-AC6", () => {
  test("AC IDs in describe names (any depth) and test names map to results; untagged tests and longer IDs are not confused", () => {
    toBuilding();
    commitAll(wt(), {
      "test/mix.test.ts": bunTest(`
describe("DEMO-1-AC1 outer", () => { describe("inner", () => { test("plain name", () => { expect(1).toBe(1); }); }); });
test("DEMO-1-AC3 and DEMO-1-AC4 share one test", () => { expect(1).toBe(1); });
test("DEMO-1-AC10 is another criterion", () => { expect(1).toBe(2); });
test("DEMO-1-AC5 fails", () => { expect(1).toBe(2); });
test("untagged tests are ignored", () => { expect(1).toBe(2); });`),
    });
    const r = ark("test", run(), "--acs", "DEMO-1-AC1,DEMO-1-AC3,DEMO-1-AC4,DEMO-1-AC5");
    expect(r.code).toBe(1);
    const [ev] = events("test.result");
    expect(ev.data.acs).toEqual({ "DEMO-1-AC1": "pass", "DEMO-1-AC3": "pass", "DEMO-1-AC4": "pass", "DEMO-1-AC5": "fail" });
    expect(ev.data.tests).toEqual([
      { suite: "unit", test: "test/mix.test.ts > inner > DEMO-1-AC1 outer > plain name", acs: ["DEMO-1-AC1"], status: "pass" },
      { suite: "unit", test: "test/mix.test.ts > DEMO-1-AC3 and DEMO-1-AC4 share one test", acs: ["DEMO-1-AC3", "DEMO-1-AC4"], status: "pass" },
      { suite: "unit", test: "test/mix.test.ts > DEMO-1-AC5 fails", acs: ["DEMO-1-AC5"], status: "failure" },
    ]);
  });

  test("an AC with no tagged test is reported missing", () => {
    toBuilding();
    const r = ark("test", run(), "--acs", "DEMO-1-AC2,DEMO-1-AC4");
    expect(r.code).toBe(1);
    expect(events("test.result")[0].data.acs).toEqual({ "DEMO-1-AC2": "pass", "DEMO-1-AC4": "missing" });
  });
});

describe("ARK-105-AC7", () => {
  test("advance refuses an implementer step whose diff touches an AC-tagged test, and records the head SHA when it does not", () => {
    toBuilding();
    const before = state().ledger_seq;
    const done = () => ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');

    commitAll(wt(), { "src/feature.ts": `export const feature = () => "new";\n`, "test/stable.test.ts": "// edited\n" });
    const edit = done();
    expect(edit.code).toBe(1);
    expect(edit.err).toContain("touches AC-tagged test files: test/stable.test.ts");
    git(wt(), "reset", "-q", "--hard", "HEAD~1");

    commitAll(wt(), { "test/new.test.ts": FEATURE_TEST });
    expect(done().err).toContain("test/new.test.ts"); // a new tagged test counts too
    git(wt(), "reset", "-q", "--hard", "HEAD~1");
    expect(state().ledger_seq).toBe(before);

    commitAll(wt(), { "src/feature.ts": `export const feature = () => "new";\n`, "test/plain.test.ts": bunTest(`test("untagged helper check", () => { expect(2).toBe(2); });`) });
    expect(done().code).toBe(0);
    expect(state().repos[0]).toMatchObject({ head_sha: git(wt(), "rev-parse", "HEAD"), step: "implemented" });
    expect(ark("run", "replay", run(), "--check").code).toBe(0);
  });

  test("implementer.completed must name a worktree of the run", () => {
    toBuilding();
    expect(ark("advance", run(), "implementer.completed").err).toContain("naming a worktree");
  });
});
