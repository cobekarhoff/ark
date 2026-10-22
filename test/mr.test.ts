import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

setDefaultTimeout(60_000);
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
// Git identity as config, passed only to ark itself (CI has no global git user).
const GIT_IDENTITY = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@t" };
const CLI = join(import.meta.dir, "..", "cli", "ark.ts");
const PR_URL = "https://github.com/acme/demo/pull/7";

// A fake gh: logs argv, answers `pr list` from the state file, and `pr create` records the PR in it and saves the body file.
// Any other subcommand (merge included) fails, and is logged first.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr list") cat "$GH_STATE" 2>/dev/null || echo '[]' ;;
  "pr create")
    while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$GH_BODY"; shift; done
    echo '[{"url":"${PR_URL}","number":7}]' > "$GH_STATE"
    echo "${PR_URL}" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;
const MATRIX = "| AC | Level | Tests | Red (SHA, outcome) | Green (SHA, outcome) | Evidence | Status |\n| DEMO-1-AC1 | integration | t | r | g | artifacts/evidence.txt | pass |\n";

let home: string;
let root: string;
let proj: string;
let bare: string;
let bin: string;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const ark = (...args: string[]) => {
  const env = {
    ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PATH: `${bin}:${process.env.PATH}`,
    GH_LOG: join(root, "gh.log"), GH_STATE: join(root, "gh.state"), GH_BODY: join(root, "gh.body"),
  };
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: proj, env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const run = () => readdirSync(join(home, "projects", "demo", "runs"))[0];
const runFile = (f: string) => join(home, "projects", "demo", "runs", run(), f);
const events = (type: string) =>
  readFileSync(runFile("ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === type);
const state = () => JSON.parse(readFileSync(runFile("state.json"), "utf8")).state;
const ghLog = () => (existsSync(join(root, "gh.log")) ? readFileSync(join(root, "gh.log"), "utf8").trim().split("\n") : []);
const ok = (r: { code: number; err: string }) => {
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
};

// A project with an origin, a run with one worktree commit, and G2 approved: the run waits in mrs_open.
function atMrsOpen(arkYml = "project: demo\n") {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  root = realpathSync(mkdtempSync(join(tmpdir(), "ark-fx-")));
  bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);

  proj = join(root, "demo");
  bare = join(root, "remote.git");
  mkdirSync(proj);
  git(proj, "init", "-q", "-b", "main");
  writeFileSync(join(proj, "ark.yml"), arkYml);
  git(proj, "add", "-A");
  git(proj, "commit", "-qm", "base");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(proj, "remote", "add", "origin", bare);
  git(proj, "push", "-q", "origin", "main");
  git(proj, "remote", "set-head", "origin", "main");

  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  writeFileSync(join(home, "projects", "demo", "tickets", "DEMO-1.md"),
    `---\nid: DEMO-1\ntitle: "Add the feature"\nstatus: ready\nacceptance_criteria:\n  - id: DEMO-1-AC1\n    text: "criterion one"\n---\nBody.\n`);
  ok(ark("run", "start", "DEMO-1"));
  ok(ark("advance", run(), "analysis.completed"));
  writeFileSync(runFile("plan.md"), "# Plan\n");
  ok(ark("gate", "answer", run(), "G1", "approve", "--packet", ark("gate", "packet", run(), "G1").out.trim()));
  ok(ark("ws", "create", run()));
  ok(ark("advance", run(), "build.started"));
  writeFileSync(join(runFile("ws/demo"), "feature.txt"), "feature\n");
  git(runFile("ws/demo"), "add", "-A");
  git(runFile("ws/demo"), "commit", "-qm", "feature");
  ok(ark("advance", run(), "build.completed"));
  writeFileSync(runFile("trace-matrix.md"), MATRIX);
  mkdirSync(runFile("artifacts"));
  writeFileSync(runFile("artifacts/evidence.txt"), "evidence\n");
  ok(ark("gate", "answer", run(), "G2", "approve", "--packet", ark("gate", "packet", run(), "G2").out.trim()));
}
const branch = () => JSON.parse(readFileSync(runFile("state.json"), "utf8")).repos[0].branch as string;

describe("ARK-107-AC1", () => {
  beforeEach(() => atMrsOpen());

  test("ark mr pushes the run branch past the disabled pushurl and opens a PR whose body carries the trace matrix and run-relative evidence paths", () => {
    const r = ark("mr", run());
    ok(r);
    expect(r.out).toContain(PR_URL);
    expect(git(bare, "rev-parse", `refs/heads/${branch()}`)).toBe(git(runFile("ws/demo"), "rev-parse", "HEAD"));

    const slug = `${basename(root)}/remote`; // owner/repo as read from the local remote URL
    const create = ghLog().filter((l) => l.startsWith("pr create"));
    expect(create).toEqual([`pr create --repo ${slug} --head ${branch()} --base main --title DEMO-1: Add the feature --body-file ${runFile("mr/demo.md")}`]);
    const body = readFileSync(join(root, "gh.body"), "utf8");
    expect(body).toContain(MATRIX.trim());
    expect(body).toContain("- artifacts/evidence.txt");
    expect(body).toContain("DEMO-1-AC1: criterion one");

    expect(events("mr.opened").map((e) => e.data)).toEqual([{ repo: "demo", url: PR_URL, number: 7 }]);
    expect(state()).toBe("mrs_open");
  });

  test("running ark mr twice opens one PR and records one mr.opened", () => {
    ok(ark("mr", run()));
    const again = ark("mr", run());
    ok(again);
    expect(again.out).toContain(PR_URL);
    expect(ghLog().filter((l) => l.startsWith("pr create"))).toHaveLength(1);
    expect(events("mr.opened")).toHaveLength(1);
  });

  test("ark mr outside mrs_open is refused before anything is pushed or called", () => {
    ok(ark("advance", run(), "run.completed"));
    const r = ark("mr", run());
    expect(r.code).toBe(1);
    expect(r.err).toContain("mrs_open");
    expect(ghLog()).toEqual([]);
    expect(Bun.spawnSync(["git", "-C", bare, "rev-parse", "--verify", `refs/heads/${branch()}`]).exitCode).not.toBe(0);
  });
});

describe("ARK-107-AC1 and AC2: only ark mr writes mr events", () => {
  test("ark advance refuses mr.opened and run.closed, leaving the run in mrs_open", () => {
    atMrsOpen();
    for (const [type, data] of [["mr.opened", { repo: "demo", url: PR_URL, number: 7 }], ["run.closed", { reason: "mr disabled" }]] as const) {
      const r = ark("advance", run(), type, "--data", JSON.stringify(data));
      expect(r.code, type).toBe(1);
      expect(r.err).toContain("written by 'ark mr'");
    }
    expect(state()).toBe("mrs_open");
    expect(events("mr.opened")).toEqual([]);
  });
});

describe("ARK-107-AC2", () => {
  beforeEach(() => atMrsOpen("project: demo\nmr: false\n"));

  test("with mr: false ark mr closes the run at the ready branch, pushing nothing and calling no gh", () => {
    const r = ark("mr", run());
    ok(r);
    expect(r.out).toContain("MRs are disabled");
    expect(events("run.closed").map((e) => e.data)).toEqual([{ reason: "mr disabled" }]);
    expect(state()).toBe("done");
    expect(ghLog()).toEqual([]);
    expect(Bun.spawnSync(["git", "-C", bare, "rev-parse", "--verify", `refs/heads/${branch()}`]).exitCode).not.toBe(0);
    expect(git(runFile("ws/demo"), "branch", "--show-current")).toBe(branch()); // the ready branch is still there
  });
});

describe("ARK-107-AC3", () => {
  test("ark mr never calls gh pr merge", () => {
    atMrsOpen();
    ok(ark("mr", run()));
    ok(ark("mr", run()));
    const calls = ghLog();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.split(" ")).not.toContain("merge");
  });
});
