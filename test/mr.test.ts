import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(60_000);
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
// Git identity as config, passed only to ark itself (CI has no global git user).
const GIT_IDENTITY = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@t" };
const CLI = join(import.meta.dir, "..", "cli", "ark.ts");
const ORIGIN = "https://github.com/acme/demo.git"; // rewritten to the local bare repo by url.<bare>.insteadOf
const PR_URL = "https://github.com/acme/demo/pull/7";
const SENTINEL = "ARK_SENTINEL_TOKEN";

// A fake gh. `pr list` answers from the state file; `pr create` records the PR in it the way GitHub would list it
// (base and head owner taken from the flags it received) and saves the body file. Any other subcommand fails, and is logged first.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr list") cat "$GH_STATE" 2>/dev/null || echo '[]' ;;
  "pr create")
    while [ $# -gt 0 ]; do
      case "$1" in --body-file) cp "$2" "$GH_BODY" ;; --repo) repo="$2" ;; --base) base="$2" ;; esac
      shift
    done
    printf '[{"url":"${PR_URL}","number":7,"state":"OPEN","baseRefName":"%s","headRepositoryOwner":{"login":"%s"}}]\\n' "$base" "\${repo%%/*}" > "$GH_STATE"
    echo "${PR_URL}" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;
const MATRIX = "| AC | Level | Tests | Red (SHA, outcome) | Green (SHA, outcome) | Evidence | Status |\n| DEMO-1-AC1 | integration | t | r | g | artifacts/evidence.txt | pass |\n";
const REPO_YML = JSON.stringify({ suites: { unit: { format: "bun-test", level: "integration", run: 'bun test -t "{tags}"', junit: "$ARK_OUT/bun.xml" } } });
const pr = (n: number, o: { owner?: string; base?: string; state?: string } = {}) =>
  ({ url: `https://github.com/acme/demo/pull/${n}`, number: n, state: o.state ?? "OPEN", baseRefName: o.base ?? "main", headRepositoryOwner: { login: o.owner ?? "acme" } });

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
const tryGit = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: process.env }).exitCode === 0;
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
const runState = () => JSON.parse(readFileSync(runFile("state.json"), "utf8"));
const wt = () => runFile("ws/demo");
const branch = () => runState().repos[0].branch as string;
const ghLog = () => (existsSync(join(root, "gh.log")) ? readFileSync(join(root, "gh.log"), "utf8").trim().split("\n") : []);
const creates = () => ghLog().filter((l) => l.startsWith("pr create"));
const seedPrs = (...prs: unknown[]) => writeFileSync(join(root, "gh.state"), JSON.stringify(prs));
const onRemote = (ref: string, remote = bare) => (tryGit(remote, "rev-parse", "--verify", "-q", ref) ? git(remote, "rev-parse", ref) : null);
const ok = (r: { code: number; err: string }) => {
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
};

// A project whose origin looks like GitHub, a run with one implemented worktree commit, and G2 approved.
function atG2Approved(arkYml = "project: demo\n") {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  root = realpathSync(mkdtempSync(join(tmpdir(), "ark-fx-")));
  bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);

  proj = join(root, "demo");
  bare = join(root, "remote.git");
  mkdirSync(join(proj, ".ark"), { recursive: true });
  git(proj, "init", "-q", "-b", "main");
  writeFileSync(join(proj, "ark.yml"), arkYml);
  writeFileSync(join(proj, ".ark", "repo.yml"), REPO_YML);
  git(proj, "add", "-A");
  git(proj, "commit", "-qm", "base");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(proj, "config", `url.${bare}.insteadOf`, ORIGIN);
  git(proj, "remote", "add", "origin", ORIGIN);
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
  writeFileSync(join(wt(), "feature.txt"), "feature\n");
  git(wt(), "add", "-A");
  git(wt(), "commit", "-qm", "feature");
  ok(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'));
  ok(ark("advance", run(), "build.completed"));
  writeFileSync(runFile("trace-matrix.md"), MATRIX);
  mkdirSync(runFile("artifacts"));
  writeFileSync(runFile("artifacts/evidence.txt"), "evidence\n");
  ok(ark("gate", "answer", run(), "G2", "approve", "--packet", ark("gate", "packet", run(), "G2").out.trim()));
}

describe("ARK-107-AC1", () => {
  beforeEach(() => atG2Approved());

  test("ark mr pushes the approved SHA past the disabled pushurl and opens a PR into main whose body carries the trace matrix and run-relative evidence paths", () => {
    const base = onRemote("refs/heads/main");
    const r = ark("mr", run());
    ok(r);
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha);
    expect(onRemote("refs/heads/main")).toBe(base);

    const created = JSON.parse(readFileSync(join(root, "gh.state"), "utf8"))[0]; // what GitHub would now list, from the flags ark passed
    expect(created).toMatchObject({ baseRefName: "main", headRepositoryOwner: { login: "acme" } });
    expect(creates()[0]).toContain("--title DEMO-1: Add the feature");
    const body = readFileSync(join(root, "gh.body"), "utf8");
    expect(body).toContain(MATRIX.trim());
    expect(body).toContain("- artifacts/evidence.txt");
    expect(body).toContain("DEMO-1-AC1: criterion one");

    expect(events("mr.opened").map((e) => e.data)).toEqual([{ repo: "demo", url: PR_URL, number: 7 }]);
    expect(runState().state).toBe("mrs_open");
  });

  test("running ark mr twice opens one PR and records one mr.opened", () => {
    ok(ark("mr", run()));
    ok(ark("mr", run()));
    expect(creates()).toHaveLength(1);
    expect(events("mr.opened")).toHaveLength(1);
  });

  test("a crash between pr create and the ledger is recovered by adopting the open PR from this repo into main, not a fork's or another base's", () => {
    seedPrs(pr(3, { owner: "mallory" }), pr(4, { base: "release" }), pr(5));
    ok(ark("mr", run()));
    expect(creates()).toEqual([]);
    expect(events("mr.opened").map((e) => e.data)).toEqual([{ repo: "demo", url: "https://github.com/acme/demo/pull/5", number: 5 }]);
  });

  test("a fork's PR with the same branch name is not adopted: a new PR is opened", () => {
    seedPrs(pr(3, { owner: "mallory" }), pr(4, { base: "release" }));
    ok(ark("mr", run()));
    expect(creates()).toHaveLength(1);
    expect(events("mr.opened").map((e) => e.data.url)).toEqual([PR_URL]);
  });

  test("a closed or merged PR of this repo for the branch is refused by name, not reused", () => {
    for (const state of ["CLOSED", "MERGED"]) {
      seedPrs(pr(9, { state }));
      const r = ark("mr", run());
      expect(r.code, state).toBe(1);
      expect(r.err).toContain(`${state.toLowerCase()} PR https://github.com/acme/demo/pull/9`);
      expect(creates()).toEqual([]);
      expect(events("mr.opened")).toEqual([]);
    }
  });

  test("ark mr outside mrs_open is refused before anything is pushed or called", () => {
    ok(ark("advance", run(), "run.completed"));
    const r = ark("mr", run());
    expect(r.code).toBe(1);
    expect(r.err).toContain("mrs_open");
    expect(ghLog()).toEqual([]);
    expect(onRemote(`refs/heads/${branch()}`)).toBeNull();
  });

  test("commits made after G2 approval are not pushed", () => {
    writeFileSync(join(wt(), "late.txt"), "late\n");
    git(wt(), "add", "-A");
    git(wt(), "commit", "-qm", "late");
    const r = ark("mr", run());
    expect(r.code).toBe(1);
    expect(r.err).toContain("differs from the approved");
    expect(onRemote(`refs/heads/${branch()}`)).toBeNull();
    expect(ghLog()).toEqual([]);
  });

  test("a remote.origin.url the agent overrides in its worktree config does not redirect the push", () => {
    const evil = join(root, "evil.git");
    git(root, "init", "-q", "--bare", evil);
    git(wt(), "config", "--worktree", "remote.origin.url", evil);
    ok(ark("mr", run()));
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha);
    expect(onRemote(`refs/heads/${branch()}`, evil)).toBeNull();
  });

  test("a credential in the origin URL never reaches stderr or the ledger, for a failed push or a malformed URL", () => {
    for (const url of [`https://x-access-token:${SENTINEL}@127.0.0.1:1/acme/demo.git`, `https://user:${SENTINEL}@host`]) {
      git(proj, "remote", "set-url", "origin", url);
      const r = ark("mr", run());
      expect(r.code, url).toBe(1);
      expect(r.err).toContain("***@");
      expect(r.err).not.toContain(SENTINEL);
      expect(r.out).not.toContain(SENTINEL);
      expect(readFileSync(runFile("ledger.ndjson"), "utf8")).not.toContain(SENTINEL);
    }
  });

  test("a branch outside ark/ in the ledger is refused and main on the remote does not move", () => {
    const ledger = readFileSync(runFile("ledger.ndjson"), "utf8");
    writeFileSync(runFile("ledger.ndjson"), ledger.replace(`"branch":"${branch()}"`, '"branch":"main"'));
    const base = onRemote("refs/heads/main");
    const r = ark("mr", run());
    expect(r.code).toBe(1);
    expect(r.err).toContain("not an ark/ branch");
    expect(onRemote("refs/heads/main")).toBe(base);
    expect(ghLog()).toEqual([]);
  });

  test("next_action in mrs_open is open_mrs for the orchestrator until every repo has an MR, then a human merges", () => {
    expect(runState().next_action).toMatchObject({ kind: "open_mrs", agent: "orchestrator" });
    expect(runState().status).toBe("active");
    ok(ark("mr", run()));
    expect(runState().next_action).toMatchObject({ kind: "merge", agent: "human" });
    expect(runState().status).toBe("waiting_human");
  });
});

describe("ARK-107-AC2", () => {
  beforeEach(() => atG2Approved("project: demo\nmr: false\n"));

  test("with mr: false the G2 approval itself ends the run at the ready branch, with no push and no gh call", () => {
    expect(events("run.closed").map((e) => e.data)).toEqual([{ reason: "mr disabled" }]);
    expect(runState().state).toBe("done");
    expect(ghLog()).toEqual([]);
    expect(onRemote(`refs/heads/${branch()}`)).toBeNull();
    expect(git(wt(), "branch", "--show-current")).toBe(branch()); // the ready branch is still there
  });

  test("ark mr on a closed mr: false run says so, changes nothing and calls no gh", () => {
    const before = readFileSync(runFile("ledger.ndjson"), "utf8");
    const r = ark("mr", run());
    ok(r);
    expect(r.out).toContain("MRs are disabled");
    expect(readFileSync(runFile("ledger.ndjson"), "utf8")).toBe(before);
    expect(ghLog()).toEqual([]);
  });
});

describe("ARK-107-AC3", () => {
  test("ark mr leaves the base branch on the remote where it was and never runs gh pr merge", () => {
    atG2Approved();
    const base = onRemote("refs/heads/main");
    ok(ark("mr", run()));
    ok(ark("mr", run()));
    expect(onRemote("refs/heads/main")).toBe(base);
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha);
    expect(ghLog().length).toBeGreaterThan(0);
    for (const c of ghLog()) expect(c.split(" ")).not.toContain("merge");
  });

  test("ark advance refuses the events only ark mr and ark ws create may write, so none can be forged", () => {
    atG2Approved();
    const before = readFileSync(runFile("ledger.ndjson"), "utf8");
    for (const [type, data, owner] of [
      ["mr.opened", { repo: "demo", url: PR_URL, number: 7 }, "ark mr"],
      ["run.closed", { reason: "mr disabled" }, "ark mr"],
      ["ws.created", { repo: "demo2", branch: "main", base_sha: "0".repeat(40) }, "ark ws create"],
    ] as const) {
      const r = ark("advance", run(), type, "--data", JSON.stringify(data));
      expect(r.code, type).toBe(1);
      expect(r.err).toContain(`written by '${owner}'`);
    }
    expect(readFileSync(runFile("ledger.ndjson"), "utf8")).toBe(before);
  });
});
