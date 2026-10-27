import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setKinds } from "./kinds";
import { OMP_CONFIG } from "./omp-config";
import { spawnArk } from "./tty";
setDefaultTimeout(60_000);
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
// Git identity as config, passed only to ark itself so `ark gate answer` records an approver on CI machines without a global user.
const GIT_IDENTITY = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@t" };

const CLI = join(import.meta.dir, "..", "cli", "ark.ts");
const DOCKER_ARGS = "compose-args: compose images --format json";

// Fixture sources: a tiny bun project. AC1 fails on base (assertion), AC4 errors on base (module missing), AC2 passes on both,
// AC3 fails on its first run only (counter file), AC5 always fails.
const bunTest = (body: string, imports = "") => `import { describe, expect, test } from "bun:test";\n${imports}\n${body}\n`;
const FEATURE_TEST = bunTest(
  `describe("DEMO-1-AC1 new feature", () => { describe("nested", () => { test("returns the new value", () => { expect(feature()).toBe("new"); }); }); });`,
  `import { feature } from "../src/feature";`,
);
// The module is loaded inside the test, so on base the failure is a JUnit record (a top-level import that fails leaves no record at all).
const ADDED_TEST = bunTest(`test("DEMO-1-AC4 added module answers", async () => { const { added } = await import("../src/added"); expect(added()).toBe(42); });`);
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
  // Observed: with the bare `{ cwd }` CI failed "empty ident name" although the identity is set above; passing env explicitly fixed it.
  // Not reproducible on a dev machine, where git falls back to the OS user name.
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
const commitAll = (dir: string, files: Record<string, string>, msg = "change") => {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg);
};
// Every `ark test` in this file is the validator's step, so it says so; a plain run is tested in integrity.test.ts.
const arkWith = (extra: Record<string, string>, ...args: string[]) => {
  const env = { ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PATH: `${bin}:${process.env.PATH}`, ...extra };
  const r = spawnArk(["bun", CLI, ...(args[0] === "test" && !args.includes("--as") ? [...args, "--as", "validator"] : args)], { cwd: proj, env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const ark = (...args: string[]) => arkWith({}, ...args);
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
// `suiteOver` replaces keys of the base suite (`env: undefined` drops the environment).
// `more`: further suites and base files (a second suite that matches none of the selected tests).
function fixture(up = "echo up >> $ARK_OUT/order", suiteOver: Record<string, unknown> = {}, more: { suites?: Record<string, unknown>; files?: Record<string, string> } = {}) {
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
    run: 'echo run >> $ARK_OUT/order; bun test -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml',
    junit: "$ARK_OUT/bun.xml",
    env: { up, down: "echo down >> $ARK_OUT/order", vars: { FLAKY_COUNTER: counter } }, // the suite's own environment: nothing else of the caller's reaches it
    ...suiteOver,
  };
  commitAll(proj, {
    "ark.yml": "project: demo\n",
    ".omp/config.yml": OMP_CONFIG,
    ".gitignore": "node_modules\n",
    ".ark/repo.yml": JSON.stringify({ suites: { unit: suite, ...more.suites } }),
    ...more.files,
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
  expect(ark("advance", run(), "analysis.completed").code).toBe(0);
  writeFileSync(join(home, "projects", "demo", "runs", run(), "plan.md"), "# Plan\n");
  setKinds(join(home, "projects", "demo", "runs", run()));
  const h = ark("gate", "packet", run(), "G1").out.trim();
  expect(ark("gate", "answer", run(), "G1", "approve", "--packet", h).err).toBe("");
};
const toBuilding = (...extra: string[]) => {
  toApproved();
  const ws = ark("ws", "create", run(), ...extra);
  expect(ws.err).toBe("");
  expect(ark("advance", run(), "build.started").code).toBe(0);
};
// What the validator's red-green needs first: src committed and implementer.completed recorded, then the tagged tests committed on top.
const implemented = () => {
  commitAll(wt(), Object.fromEntries(Object.entries(HEAD_FILES).filter(([f]) => f.startsWith("src/"))));
  expect(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}').err).toBe("");
  commitAll(wt(), Object.fromEntries(Object.entries(HEAD_FILES).filter(([f]) => f.startsWith("test/"))));
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
    const push = Bun.spawnSync(["git", "push", "origin", "HEAD:refs/heads/ark/probe"], { cwd: wt() });
    expect(push.exitCode).not.toBe(0);
    expect(push.stderr.toString()).toContain("DISABLED"); // it is the push URL that stopped it
    expect(git(bare, "branch", "--list").includes("ark/")).toBe(false);
    // the main checkout shares the repo but keeps its push URL
    git(proj, "push", "-q", "origin", "HEAD:refs/heads/probe");
    expect(git(bare, "branch", "--list", "probe")).toContain("probe");
  });

  test("git push from the worktree fails before anything is sent, to the remote name and to an explicit URL, even when the main checkout already has a pushurl", () => {
    git(proj, "config", "remote.origin.pushurl", bare); // Git appends the worktree's DISABLED to this one: the real URL is tried first
    toApproved();
    expect(ark("ws", "create", run()).err).toBe("");
    commitAll(wt(), { "x.txt": "x" });
    for (const target of ["origin", bare]) {
      const push = Bun.spawnSync(["git", "push", target, "HEAD:refs/heads/ark/probe"], { cwd: wt() });
      expect(push.exitCode).not.toBe(0);
      expect(push.stderr.toString()).toContain("agents never push; ark mr pushes for you");
      expect(git(bare, "branch", "--list")).not.toContain("ark/");
    }
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

    fixture(undefined, { env: undefined }); // a suite with no environment
    toBuilding();
    expect(ark("test", run(), "--acs", "DEMO-1-AC2").code).toBe(0);
    expect(JSON.parse(slurp(runFile("artifacts/test/1/fingerprint.json"))).images).toEqual([]);
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
    implemented();
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
    implemented();
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
    expect(slurp(runFile("artifacts/test/1/bun.xml"))).toMatch(/DEMO-1-AC10[^>]*>\s*<skipped/); // AC1 did not select AC10
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

  test("the guard uses the base .ark/repo.yml and a clean worktree, so neither a config edit nor an uncommitted edit gets past it", () => {
    toBuilding();
    const done = () => ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    const cfg = JSON.parse(slurp(join(wt(), ".ark/repo.yml")));
    cfg.suites.unit.tests = ["nothing/**"]; // narrows the suite's test globs so stable.test.ts looks like a plain file
    commitAll(wt(), { ".ark/repo.yml": JSON.stringify(cfg), "test/stable.test.ts": "// edited\n" });
    expect(done().err).toContain("touches AC-tagged test files: test/stable.test.ts");
    git(wt(), "reset", "-q", "--hard", "HEAD~1");

    writeFileSync(join(wt(), "test/stable.test.ts"), "// uncommitted\n");
    expect(done().err).toContain("uncommitted changes");
    expect(events("implementer.completed")).toEqual([]);
  });

  test("implementer.completed must name a worktree of the run", () => {
    toBuilding();
    expect(ark("advance", run(), "implementer.completed").err).toContain("naming a worktree");
  });
});

describe("ARK-108-AC3 (ARK-105 gap)", () => {
  test("red-green is refused until implementer.completed is recorded for every repo, and records nothing", () => {
    toBuilding();
    commitAll(wt(), HEAD_FILES);
    const r = ark("test", run(), "--acs", "DEMO-1-AC1,DEMO-1-AC4", "--red-green");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no implementer.completed yet for: demo");
    expect(events("test.red_green")).toEqual([]);
    expect(existsSync(runFile("artifacts/test"))).toBe(false);
  });
});

// ARK-115: proof that survives a hostile worktree and an unreliable runner.
// The validator's usual step: the implementer's `src` is committed and recorded, then `tests` go on top.
const withSrc = (src: Record<string, string>, tests: Record<string, string>) => {
  commitAll(wt(), src);
  expect(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}').err).toBe("");
  commitAll(wt(), tests);
};
const NEW_FEATURE = { "src/feature.ts": `export const feature = () => "new";\n` };
const redGreen = (...acs: string[]) => ark("test", run(), "--acs", acs.join(","), "--red-green");
const acsOf = (type: string) => events(type).at(-1).data.acs;

describe("ARK-115-AC6", () => {
  test("green runs in a clean checkout of the head SHA: a source file that is only untracked in the worktree proves nothing", () => {
    toBuilding();
    commitAll(wt(), { "test/g.test.ts": bunTest(`test("DEMO-1-AC1 uses g", () => { expect(g()).toBe(1); });`, `import { g } from "../src/g";`) });
    write(wt(), { "src/g.ts": "export const g = () => 1;\n" }); // never committed
    const r = ark("test", run(), "--acs", "DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(acsOf("test.result")["DEMO-1-AC1"]).not.toBe("pass");
    expect(git(proj, "worktree", "list").split("\n")).toHaveLength(2); // the temporary checkout is gone
  });

  test("suite commands come from .ark/repo.yml at base_sha: a config edit on the branch cannot make a failing test pass", () => {
    toBuilding();
    const fake = { format: "bun-test", level: "unit", run: "cp fake.xml $ARK_OUT/bun.xml # {tags}", junit: "$ARK_OUT/bun.xml" };
    commitAll(wt(), {
      "test/c.test.ts": bunTest(`test("DEMO-1-AC1 fails", () => { expect(1).toBe(2); });`),
      "fake.xml": `<testsuites><testsuite><testcase name="DEMO-1-AC1 fails" classname="" file="test/c.test.ts"/></testsuite></testsuites>`,
      ".ark/repo.yml": JSON.stringify({ suites: { unit: fake } }),
    });
    expect(ark("test", run(), "--acs", "DEMO-1-AC1").code).toBe(1);
    expect(acsOf("test.result")["DEMO-1-AC1"]).toBe("fail");
  });

  test("without `tests` globs the default is bun's discovery, so .spec.ts and .test.js files outside test/ are overlaid on red", () => {
    toBuilding();
    withSrc(NEW_FEATURE, {
      "src/feature.spec.ts": bunTest(`test("DEMO-1-AC1 spec file", () => { expect(feature()).toBe("new"); });`, `import { feature } from "./feature";`),
      "src/added.test.js": `import { expect, test } from "bun:test";\nimport { feature } from "./feature";\ntest("DEMO-1-AC4 js file", () => { expect(feature()).toBe("new"); });\n`,
    });
    const r = redGreen("DEMO-1-AC1", "DEMO-1-AC4");
    expect(r.err).toBe("");
    expect(events("test.red_green")[0].data).toMatchObject({ overlay: ["src/added.test.js", "src/feature.spec.ts"], acs: { "DEMO-1-AC1": "proven", "DEMO-1-AC4": "proven" } });
  });

  test("changed paths are read with -z: a test file whose name git would quote is still overlaid", () => {
    toBuilding();
    withSrc(NEW_FEATURE, { "test/über.test.ts": FEATURE_TEST });
    expect(redGreen("DEMO-1-AC1").code).toBe(0);
    expect(events("test.red_green")[0].data.overlay).toEqual(["test/über.test.ts"]);
  });

  test("a one-letter project prefix is an AC tag", () => {
    writeFileSync(join(home, "projects", "demo", "tickets", "X-1.md"), ticket.replaceAll("DEMO-1", "X-1"));
    expect(ark("run", "start", "X-1").err).toBe("");
    const rid = readdirSync(runsDir()).find((r) => r.includes("-X-1-"))!;
    expect(ark("advance", rid, "analysis.completed").code).toBe(0);
    writeFileSync(join(runsDir(), rid, "plan.md"), "# Plan\n");
    setKinds(join(runsDir(), rid));
    const h = ark("gate", "packet", rid, "G1").out.trim();
    expect(ark("gate", "answer", rid, "G1", "approve", "--packet", h).err).toBe("");
    expect(ark("ws", "create", rid).err).toBe("");
    expect(ark("advance", rid, "build.started").code).toBe(0);
    // BX-1-AC1 is another ticket's tag and X-1-AC10 another AC: neither may be selected by X-1-AC1 (both fail if run)
    commitAll(join(runsDir(), rid, "ws", "demo"), { "test/x.test.ts": bunTest(`test("X-1-AC1 one-letter prefix", () => { expect(1).toBe(1); });
test("BX-1-AC1 another ticket", () => { expect(1).toBe(2); });
test("X-1-AC10 another criterion", () => { expect(1).toBe(2); });`) });
    const r = ark("test", rid, "--acs", "X-1-AC1");
    expect(r.err).toBe("");
    expect(JSON.parse(slurp(join(runsDir(), rid, "state.json"))).acs).toHaveProperty("X-1-AC1");
    expect(r.out).toContain("X-1-AC1: pass");
    expect(r.code).toBe(0);
  });
});

describe("ARK-115-AC7", () => {
  test("a test file that fails to load on base leaves no JUnit record, so its red is inconclusive, not an error", () => {
    toBuilding();
    withSrc({ ...NEW_FEATURE, "src/added.ts": HEAD_FILES["src/added.ts"] }, { "test/loads.test.ts": bunTest(`test("DEMO-1-AC4 needs the module", () => { expect(added()).toBe(42); });`, `import { added } from "../src/added";`) });
    const r = redGreen("DEMO-1-AC4");
    expect(r.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC4"]).toBe("inconclusive");
    expect(events("test.red_green")[0].data.tests[0]).toMatchObject({ red: "missing", green: "pass" });
  });

  test("a runner that did not start on base is inconclusive", () => {
    const run = 'if [ -f runner.txt ]; then bun test -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml; else echo runner missing >&2; exit 127; fi';
    fixture(undefined, { run, env: undefined });
    toBuilding();
    withSrc({ ...NEW_FEATURE, "runner.txt": "x\n" }, { "test/vacuous.test.ts": bunTest(`test("DEMO-1-AC1 asserts nothing", () => { expect(1).toBe(1); });`) });
    const r = redGreen("DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC1"]).toBe("inconclusive");
    expect(slurp(runFile("artifacts/test/1/red/unit.stderr.log"))).toContain("runner missing");
  });

  test("a test skipped on base is inconclusive even when an unrelated file errors there", () => {
    toBuilding();
    withSrc({ ...NEW_FEATURE, "src/extra.ts": `export const extra = 1;\n` }, { // the unrelated file loads on head and fails to load only on base
      "test/never-red.test.ts": bunTest(`(feature() === "old" ? test.skip : test)("DEMO-1-AC1 never red", () => { expect(true).toBe(true); });`, `import { feature } from "../src/feature";`),
      "test/unrelated.test.ts": bunTest(`test("untagged", () => { expect(extra).toBe(1); });`, `import { extra } from "../src/extra";`),
    });
    const r = redGreen("DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC1"]).toBe("inconclusive");
  });

  test("a selected test that passes on base fails the check even when it is skipped on head", () => {
    toBuilding();
    withSrc(NEW_FEATURE, {
      "test/baseline.test.ts": bunTest(`(feature() === "new" ? test.skip : test)("DEMO-1-AC1 baseline", () => { expect(true).toBe(true); });`, `import { feature } from "../src/feature";`),
      "test/feature.test.ts": FEATURE_TEST,
    });
    const r = redGreen("DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC1"]).toBe("no-red");
    expect(events("test.red_green")[0].data.tests.find((t: { test: string }) => t.test.includes("baseline"))).toMatchObject({ red: "pass", green: "skipped" });
  });

  test("a green suite that exits non-zero fails the run, for ark test and for red-green", () => {
    toBuilding();
    withSrc(NEW_FEATURE, { "test/feature.test.ts": FEATURE_TEST, "test/broken-import.test.ts": bunTest(`test("untagged", () => { expect(nope).toBe(1); });`, `import { nope } from "../src/nope";`) });
    const plain = ark("test", run(), "--acs", "DEMO-1-AC1");
    expect(plain.code).toBe(1);
    expect(acsOf("test.result")["DEMO-1-AC1"]).toBe("fail");
    expect(plain.out).toContain("suite 'unit' exited");
    const rg = redGreen("DEMO-1-AC1");
    expect(rg.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC1"]).toBe("green-failed");
  });
});

describe("ARK-115-AC6 (checkout and environment fidelity)", () => {
  test("a suite with no test for the selected AC passes via --pass-with-no-tests, so it cannot fail the run", () => {
    const e2e = { format: "bun-test", level: "e2e", tests: ["e2e/**"], run: 'bun test ./e2e -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/e2e.xml', junit: "$ARK_OUT/e2e.xml" };
    fixture(undefined, { tests: ["test/**"] }, { suites: { e2e }, files: { "e2e/e.test.ts": bunTest(`test("DEMO-1-AC2 only in e2e", () => { expect(1).toBe(1); });`) } });
    toBuilding();
    commitAll(wt(), { "test/ok.test.ts": bunTest(`test("DEMO-1-AC1 in unit only", () => { expect(1).toBe(1); });`) });
    const r = ark("test", run(), "--acs", "DEMO-1-AC1");
    expect(r.out).toContain("DEMO-1-AC1: pass");
    expect(r.code).toBe(0);
    expect(slurp(runFile("artifacts/test/1/e2e.stderr.log"))).toContain("matched 0 tests"); // it did run, selected nothing and exited 0
  });

  test("every suite must exit 0: a selected file that fails to load, or an empty report with exit 127, fails the run", () => {
    const other = { format: "bun-test", level: "e2e", tests: ["other/**"], run: 'bun test ./other -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/other.xml', junit: "$ARK_OUT/other.xml" };
    const files = {
      "other/ok.test.ts": bunTest(`test("DEMO-1-AC2 fine", () => { expect(1).toBe(1); });`),
      "other/bad.test.ts": bunTest(`test("DEMO-1-AC1 never loads", () => { expect(missing).toBe(1); });`, `import { missing } from "./not-there";`),
    };
    fixture(undefined, { tests: ["test/**"], run: 'bun test ./test -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml' }, { suites: { other }, files }); // the unit suite stays out of other/
    toBuilding();
    commitAll(wt(), { "test/ok.test.ts": bunTest(`test("DEMO-1-AC1 fine", () => { expect(1).toBe(1); });`) });
    const load = ark("test", run(), "--acs", "DEMO-1-AC1");
    expect(load.code).toBe(1);
    expect(acsOf("test.result")["DEMO-1-AC1"]).toBe("fail");
    expect(load.out).toContain("suite 'other' exited 1");

    const empty = { format: "bun-test", level: "e2e", run: "touch $ARK_OUT/empty.xml; exit 127 # --pass-with-no-tests {tags}", junit: "$ARK_OUT/empty.xml" };
    fixture(undefined, {}, { suites: { empty } });
    toBuilding();
    commitAll(wt(), { "test/ok.test.ts": bunTest(`test("DEMO-1-AC1 fine", () => { expect(1).toBe(1); });`) });
    const r = ark("test", run(), "--acs", "DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(acsOf("test.result")["DEMO-1-AC1"]).toBe("fail");
    expect(r.out).toContain("suite 'empty' exited 127");
  });

  test("a suite fails the run when its command exits non-zero, even after bun's no-match: there is no output signature to excuse a failing step", () => {
    // The suite's files carry DEMO-1-AC2, but its command runs a directory without it (bun: no-match, exit 1), then a post-step that exits 1 as well.
    const e2e = { format: "bun-test", level: "e2e", tests: ["e2e/**"], run: 'bun test ./e2e/runme -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/e2e.xml; test -f missing.json', junit: "$ARK_OUT/e2e.xml" };
    fixture(undefined, { tests: ["test/**"] }, { suites: { e2e }, files: {
      "e2e/e.test.ts": bunTest(`test("DEMO-1-AC2 outside the run directory", () => { expect(1).toBe(1); });`),
      "e2e/runme/x.test.ts": bunTest(`test("DEMO-1-AC9 elsewhere", () => { expect(1).toBe(1); });`),
    } });
    toBuilding();
    const r = ark("test", run(), "--acs", "DEMO-1-AC2");
    expect(r.code).toBe(1);
    expect(r.out).toContain("suite 'e2e' exited 1");
    expect(acsOf("test.result")["DEMO-1-AC2"]).toBe("fail");
  });

  test("a suite that holds tagged tests for a selected AC but reports none (a command that runs nothing) fails green and makes red inconclusive", () => {
    const silent = { format: "bun-test", level: "e2e", run: "true # --pass-with-no-tests {tags}", junit: "$ARK_OUT/silent.xml" };
    fixture(undefined, {}, { suites: { silent } });
    toBuilding();
    commitAll(wt(), { "test/ok.test.ts": bunTest(`test("DEMO-1-AC1 fine", () => { expect(1).toBe(1); });`) });
    const g = ark("test", run(), "--acs", "DEMO-1-AC1");
    expect(g.code).toBe(1);
    expect(acsOf("test.result")["DEMO-1-AC1"]).toBe("fail");
    expect(g.out).toContain("suite 'silent' holds tagged tests for DEMO-1-AC1 but reported none");

    // the second suite does its job on head only: on base it runs nothing
    const late = { format: "bun-test", level: "e2e", run: 'if [ -f late.txt ]; then bun test -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/late.xml; fi', junit: "$ARK_OUT/late.xml" };
    fixture(undefined, {}, { suites: { late } });
    toBuilding();
    withSrc({ ...NEW_FEATURE, "late.txt": "x\n" }, { "test/feature.test.ts": FEATURE_TEST });
    const rg = redGreen("DEMO-1-AC1");
    expect(rg.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC1"]).toBe("inconclusive");
    expect(rg.out).toContain("suite 'late' holds tagged tests for DEMO-1-AC1 but reported none");
  });

  test("a mistyped tag in a file of a suite that holds no selected AC still reaches unknown_tags", () => {
    const e2e = { format: "bun-test", level: "e2e", tests: ["e2e/**"], run: 'bun test ./e2e -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/e2e.xml', junit: "$ARK_OUT/e2e.xml" };
    fixture(undefined, { tests: ["test/**"], run: 'bun test ./test -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml' }, { suites: { e2e }, files: { "e2e/typo.test.ts": bunTest(`test("DEMO-1-AC11 typo", () => { expect(1).toBe(1); });`) } });
    toBuilding();
    commitAll(wt(), { "test/ok.test.ts": bunTest(`test("DEMO-1-AC1 fine", () => { expect(1).toBe(1); });`) });
    expect(ark("test", run(), "--acs", "DEMO-1-AC1").code).toBe(0);
    expect(events("test.result")[0].data.unknown_tags).toEqual(["DEMO-1-AC11"]);
  });

  test("a recorded tree with a submodule (gitlink) cannot be proven: the run is inconclusive, naming the path", () => {
    toBuilding();
    commitAll(wt(), { "test/ok.test.ts": bunTest(`test("DEMO-1-AC1 fine", () => { expect(1).toBe(1); });`) });
    const lib = join(root, "lib-sub"); // a local repository holding a failing tagged test that bun would run from inside the worktree
    mkdirSync(lib);
    git(lib, "init", "-q", "-b", "main");
    commitAll(lib, { "bad.test.ts": bunTest(`test("DEMO-1-AC1 fails inside the submodule", () => { expect(1).toBe(2); });`) });
    git(wt(), "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    git(wt(), "commit", "-qm", "submodule");
    const g = ark("test", run(), "--acs", "DEMO-1-AC1");
    expect(g.err).toBe("");
    expect(g.code).toBe(1);
    expect(acsOf("test.result")["DEMO-1-AC1"]).toBe("inconclusive");
    expect(g.out).toContain("submodules are not supported by ark test yet: vendor/lib");
  });

  test("every suite runs, so a selected test whose name is built at run time still counts: its failure fails the run", () => {
    const gen = { format: "bun-test", level: "e2e", tests: ["gen/**"], run: 'bun test ./gen -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/gen.xml', junit: "$ARK_OUT/gen.xml" };
    const files = { "gen/g.test.ts": bunTest("const ticket = \"DEMO-1\";\ntest(`${ticket}-AC1 name built at run time`, () => { expect(1).toBe(2); });") };
    fixture(undefined, { tests: ["test/**"], run: 'bun test ./test -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml' }, { suites: { gen }, files });
    toBuilding();
    commitAll(wt(), { "test/ok.test.ts": bunTest(`test("DEMO-1-AC1 fine", () => { expect(1).toBe(1); });`) });
    const r = ark("test", run(), "--acs", "DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(acsOf("test.result")["DEMO-1-AC1"]).toBe("fail");
  });

  test("a bun-test suite whose run lacks --pass-with-no-tests is refused before anything runs, naming the suite", () => {
    fixture(undefined, { run: 'bun test -t "{tags}" --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml' });
    toBuilding();
    commitAll(wt(), { "test/ok.test.ts": bunTest(`test("DEMO-1-AC1 fine", () => { expect(1).toBe(1); });`) });
    const r = ark("test", run(), "--acs", "DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("suite 'unit': bun-test suites must pass --pass-with-no-tests so a suite without the selected ACs exits 0");
    expect(events("test.result")).toEqual([]);
    expect(existsSync(runFile("artifacts/test"))).toBe(false);
  });

  test("a second suite that produces no JUnit and exits non-zero fails the run, on green; on red it makes the AC inconclusive", () => {
    const ghost = { format: "bun-test", level: "e2e", run: 'test -f ghost.txt && bun test -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/ghost.xml', junit: "$ARK_OUT/ghost.xml" }; // exits 1 without a report until ghost.txt exists
    fixture(undefined, {}, { suites: { ghost } });
    toBuilding();
    commitAll(wt(), { "test/ok.test.ts": bunTest(`test("DEMO-1-AC1 fine", () => { expect(1).toBe(1); });`) });
    const g = ark("test", run(), "--acs", "DEMO-1-AC1");
    expect(g.code).toBe(1);
    expect(acsOf("test.result")["DEMO-1-AC1"]).toBe("fail");
    expect(g.out).toContain("suite 'ghost' exited 1");

    fixture(undefined, {}, { suites: { ghost } });
    toBuilding();
    withSrc({ ...NEW_FEATURE, "ghost.txt": "x\n" }, { "test/feature.test.ts": FEATURE_TEST }); // the suite runs on head, not on base
    const rg = redGreen("DEMO-1-AC1");
    expect(rg.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC1"]).toBe("inconclusive");
    expect(rg.out).toContain("suite 'ghost' exited 1");
  });

  test("files under test/, tests/ and __tests__/ that are not themselves tests (helpers) are overlaid on red, so a test importing one still gets a red record", () => {
    toBuilding();
    withSrc(NEW_FEATURE, {
      "test/helpers.ts": `export const expected = () => "new";\n`,
      "tests/more.ts": `export const x = 1;\n`,
      "src/__tests__/util.ts": `export const y = 1;\n`, // colocated, Jest-style
      "test/h.test.ts": bunTest(`test("DEMO-1-AC1 uses a helper", () => { expect(feature()).toBe(expected()); });`, `import { feature } from "../src/feature";\nimport { expected } from "./helpers";`),
    });
    const r = redGreen("DEMO-1-AC1");
    expect(r.err).toBe("");
    expect(events("test.red_green")[0].data).toMatchObject({ overlay: ["src/__tests__/util.ts", "test/h.test.ts", "test/helpers.ts", "tests/more.ts"], acs: { "DEMO-1-AC1": "proven" } });
  });

  test("the other extensions bun discovers (.mts, .mjs, .cts, .cjs) count as test files", () => {
    toBuilding();
    withSrc(NEW_FEATURE, {
      "src/m.test.mts": bunTest(`test("DEMO-1-AC1 mts", () => { expect(feature()).toBe("new"); });`, `import { feature } from "./feature";`),
      "src/j.spec.mjs": `import { expect, test } from "bun:test";\nimport { feature } from "./feature.ts";\ntest("DEMO-1-AC4 mjs", () => { expect(feature()).toBe("new"); });\n`,
    });
    expect(redGreen("DEMO-1-AC1", "DEMO-1-AC4").err).toBe("");
    expect(events("test.red_green")[0].data.overlay).toEqual(["src/j.spec.mjs", "src/m.test.mts"]);
  });

  test("a committed symlink whose target is outside the checkout makes the run inconclusive, in red-green and in a plain run; links inside the checkout are fine", () => {
    toBuilding();
    const outside = join(root, "outside-feature.ts");
    writeFileSync(outside, `export const feature = () => "new";\n`); // never committed
    rmSync(join(wt(), "src/feature.ts"));
    symlinkSync(outside, join(wt(), "src/feature.ts"));
    git(wt(), "add", "-A");
    git(wt(), "commit", "-qm", "link");
    expect(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}').err).toBe("");
    commitAll(wt(), { "test/feature.test.ts": FEATURE_TEST });
    const r = redGreen("DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC1"]).toBe("inconclusive");
    expect(events("test.red_green")[0].data.reason).toContain("src/feature.ts");
    const g = ark("test", run(), "--acs", "DEMO-1-AC1");
    expect(g.code).toBe(1);
    expect(acsOf("test.result")["DEMO-1-AC1"]).toBe("inconclusive");
  });

  test("a symlink that stays inside the checkout is kept", () => {
    toBuilding();
    commitAll(wt(), { "src/real.ts": `export const feature = () => "new";\n` });
    symlinkSync("real.ts", join(wt(), "src/feature.ts.link"));
    git(wt(), "add", "-A");
    git(wt(), "commit", "-qm", "inner link");
    commitAll(wt(), { "test/link.test.ts": bunTest(`test("DEMO-1-AC1 through an inner link", () => { expect(feature()).toBe("new"); });`, `import { feature } from "../src/feature.ts.link";`) });
    expect(ark("test", run(), "--acs", "DEMO-1-AC1").out).toContain("DEMO-1-AC1: pass");
  });

  test("clean filters, smudge filters and hooks cannot change what the checkout holds: the tests see the committed blob", () => {
    git(proj, "config", "filter.panel.smudge", "sed s/old/new/");
    git(proj, "config", "filter.panel.clean", "cat");
    toBuilding();
    withSrc({ ".gitattributes": "src/feature.ts filter=panel\n" }, { "test/feature.test.ts": FEATURE_TEST });
    const r = redGreen("DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC1"]).toBe("green-failed"); // the committed source is still "old"
  });

  test("suites get an allowlisted environment: a variable only the caller has reaches no suite, one declared in the suite's env.vars does", () => {
    const FROM_ENV = { "src/feature.ts": `export const feature = () => process.env.FEATURE_MODE ?? "old";\n` };
    toBuilding();
    commitAll(wt(), { ...FROM_ENV, "test/feature.test.ts": FEATURE_TEST });
    const leaked = arkWith({ FEATURE_MODE: "new" }, "test", run(), "--acs", "DEMO-1-AC1");
    expect(leaked.code).toBe(1);
    expect(acsOf("test.result")["DEMO-1-AC1"]).toBe("fail");

    fixture(undefined, { env: { vars: { FEATURE_MODE: "new" } } });
    toBuilding();
    commitAll(wt(), { ...FROM_ENV, "test/feature.test.ts": FEATURE_TEST });
    expect(ark("test", run(), "--acs", "DEMO-1-AC1").out).toContain("DEMO-1-AC1: pass");
  });
});

describe("ARK-115-AC7 (per selected test)", () => {
  test("two testcases with one file, describe path, name and line (a loop) are an ambiguous identity: inconclusive, never proven", () => {
    toBuilding();
    withSrc(NEW_FEATURE, {
      "test/loop.test.ts": bunTest(`for (const i of [0, 1]) {
  (feature() === "old" && i === 0 ? test.skip : test)("DEMO-1-AC1 duplicate", () => { expect(i === 0 ? "new" : feature()).toBe("new"); });
}`, `import { feature } from "../src/feature";`),
    });
    const r = redGreen("DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC1"]).toBe("inconclusive");
    expect(r.out).toContain("ambiguous duplicate test identity");
  });

  test("a second selected test that is skipped on both sides makes the AC inconclusive, not proven", () => {
    toBuilding();
    withSrc(NEW_FEATURE, {
      "test/feature.test.ts": FEATURE_TEST,
      "test/skipped.test.ts": bunTest(`test.skip("DEMO-1-AC1 never runs", () => { expect(1).toBe(2); });`),
    });
    const r = redGreen("DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC1"]).toBe("inconclusive");
  });

  test("same-named tests in one file are told apart by line: one test's red failure is not another's", () => {
    toBuilding();
    withSrc(NEW_FEATURE, {
      "test/dup.test.ts": bunTest(`test("DEMO-1-AC1 dup", () => { expect(feature()).toBe("new"); });
(feature() === "old" ? test.skip : test)("DEMO-1-AC1 dup", () => { expect(1).toBe(1); });`, `import { feature } from "../src/feature";`),
    });
    const r = redGreen("DEMO-1-AC1");
    expect(r.code).toBe(1);
    expect(acsOf("test.red_green")["DEMO-1-AC1"]).toBe("inconclusive");
    expect(events("test.red_green")[0].data.tests.map((t: { red: string }) => t.red).sort()).toEqual(["failure", "skipped"]);
  });
});
