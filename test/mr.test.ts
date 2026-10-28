import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { rechain } from "./ledger";
import { setKinds } from "./kinds";
import { OMP_CONFIG } from "./omp-config";
import { credentialFreeEnv } from "../cli/launch";
import { appendAskProof, mainSessionFile, spawnArk } from "./tty";

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
  const r = spawnArk(["bun", CLI, ...args], { cwd: proj, env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const run = () => readdirSync(join(home, "projects", "demo", "runs")).filter((r) => r !== ".locks")[0];
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
  mkdirSync(join(proj, ".omp"));
  writeFileSync(join(proj, ".omp", "config.yml"), OMP_CONFIG);
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
  ok(ark("log", "route", run(), "ticket", "fixture"));
  ok(ark("advance", run(), "analysis.completed"));
  writeFileSync(runFile("plan.md"), "# Plan\n");
  setKinds(runFile(""));
  const g1 = ark("gate", "packet", run(), "G1").out.trim();
  ok(ark("gate", "answer", run(), "G1", "approve", "--packet", g1));
  ok(ark("ws", "create", run()));
  ok(ark("advance", run(), "build.started"));
  writeFileSync(join(wt(), "feature.txt"), "feature\n");
  git(wt(), "add", "-A");
  git(wt(), "commit", "-qm", "feature");
  ok(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'));
  ok(ark("advance", run(), "build.completed"));
  writeFileSync(runFile("ac.yml"), "- id: DEMO-1-AC1\n  text: criterion one\n  level: manual\n  kind: new\n");
  mkdirSync(runFile("manual"));
  writeFileSync(runFile("manual/DEMO-1-AC1.md"), "signed-by: MR Tester\nat: 2026-10-22\n");
  ok(ark("trace-check", run()));
  mkdirSync(runFile("artifacts"), { recursive: true });
  writeFileSync(runFile("artifacts/evidence.txt"), "evidence\n");
  const g2 = ark("gate", "packet", run(), "G2").out.trim();
  ok(ark("gate", "answer", run(), "G2", "approve", "--packet", g2));
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
    expect(body).toContain(readFileSync(runFile("trace-matrix.md"), "utf8").trim());
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
      expect(r.err).toContain(`${state.toLowerCase()} MR https://github.com/acme/demo/pull/9`);
      expect(creates()).toEqual([]);
      expect(events("mr.opened")).toEqual([]);
    }
  });

  test("ark mr outside mrs_open is refused before anything is pushed or called", () => {
    ok(ark("advance", run(), "abort"));
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

  test("a pre-push hook the agent sets up through its worktree config does not run during the credentialed push", () => {
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\ntouch ${join(root, "hook-ran")}\n`);
    chmodSync(join(hooks, "pre-push"), 0o755);
    git(wt(), "config", "--worktree", "core.hooksPath", hooks);
    ok(ark("mr", run()));
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha);
    expect(existsSync(join(root, "hook-ran"))).toBe(false);
  });

  test("repointing the worktree's .git file at another repository redirects neither the push nor its hooks", () => {
    // The attacker repo holds the approved commit, its own origin, and a hook that marks it ran.
    const evil = join(root, "evil");
    const evilRemote = join(root, "evil-remote.git");
    git(root, "clone", "-q", proj, evil);
    git(evil, "fetch", "-q", wt(), `${runState().repos[0].head_sha}:refs/heads/stolen`);
    git(root, "init", "-q", "--bare", "-b", "main", evilRemote);
    git(evil, "remote", "set-url", "origin", evilRemote);
    writeFileSync(join(evil, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${join(root, "evil-hook-ran")}\n`);
    chmodSync(join(evil, ".git", "hooks", "pre-push"), 0o755);
    git(evil, "checkout", "-q", "stolen");
    writeFileSync(join(wt(), ".git"), `gitdir: ${join(evil, ".git")}\n`);

    ok(ark("mr", run()));
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha);
    expect(onRemote(`refs/heads/${branch()}`, evilRemote)).toBeNull();
    expect(existsSync(join(root, "evil-hook-ran"))).toBe(false);
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
    rechain(dirname(runFile("ledger.ndjson"))); // a chained ledger that carries the bad branch, so the mr guard (not the chain check) is what refuses
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
    expect(events("run.closed").map((e) => e.data)).toEqual([{ outcome: "handed_off", reason: "mr disabled" }]);
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
      ["run.closed", { outcome: "merged" }, "ark run close"],
      ["ws.created", { repo: "demo2", branch: "main", base_sha: "0".repeat(40) }, "ark ws"],
    ] as const) {
      const r = ark("advance", run(), type, "--data", JSON.stringify(data));
      expect(r.code, type).toBe(1);
      expect(r.err).toContain(`written by '${owner}'`);
    }
    expect(readFileSync(runFile("ledger.ndjson"), "utf8")).toBe(before);
  });
});

// The typed ark_mr tool as an `ark launch` session runs it: the process is credential-free, and only this tool's child gets the human's values back.
const ARK_MR_DRIVER = `
const z: any = new Proxy(function () {}, { get: () => z, apply: () => z });
const tools = (await import(${JSON.stringify(join(import.meta.dir, "..", "tools", "ark.ts"))})).default({ zod: z });
const res = await tools.find((t: any) => t.name === "ark_mr").execute("id", { run_id: process.argv[2] }, undefined, { agent: { kind: "main" }, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } });
console.log(res.content[0].text);
`;
const arkMrTool = () => {
  const driver = join(root, "driver.ts");
  writeFileSync(driver, ARK_MR_DRIVER);
  const env = {
    ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PATH: `${bin}:${process.env.PATH}`,
    GH_LOG: join(root, "gh.log"), GH_STATE: join(root, "gh.state"), GH_BODY: join(root, "gh.body"),
  };
  const r = Bun.spawnSync(["bun", driver, run()], { cwd: proj, env: credentialFreeEnv(env, join(root, "empty-gh"), proj) });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

describe("ARK-118-AC2", () => {
  let mark: string;
  beforeEach(() => {
    atG2Approved();
    // The human's login: a credential helper in the source repo's own config. `ark launch` resets it for the agents; the ark_mr tool gets it back.
    git(proj, "config", "credential.helper", "!f() { echo username=human; echo password=HUMAN_SECRET; }; f");
    mark = join(root, "hook-mark");
  });
  // A pre-push hook that, if it ever runs, asks git for the credential the push carries.
  const plant = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pre-push"), `#!/bin/sh\nprintf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill > ${mark}\n`);
    chmodSync(join(dir, "pre-push"), 0o755);
  };
  const pushed = (r: { code: number; err: string; out: string }) => {
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(PR_URL);
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha); // the push itself went through
  };

  test("the ark_mr tool's push runs no pre-push hook from the source repository's hooks/", () => {
    plant(join(proj, ".git", "hooks"));
    pushed(arkMrTool());
    expect(existsSync(mark)).toBe(false); // otherwise it holds username=human password=HUMAN_SECRET
  });

  test("nor one behind a core.hooksPath in the source repository's config", () => {
    plant(join(root, "source-hooks"));
    git(proj, "config", "core.hooksPath", join(root, "source-hooks"));
    pushed(arkMrTool());
    expect(existsSync(mark)).toBe(false);
  });
});

// The close packet the human is shown: the opened MRs, which `ark mr` prints as close_packet.
const closePacket = () => {
  const opened = events("mr.opened").map((e) => ({ repo: e.data.repo, url: e.data.url, number: e.data.number }));
  return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(opened)).digest("hex")}`;
};
const proveClose = (outcome: string) =>
  appendAskProof(mainSessionFile(home), { action: "run.closed", runId: run(), answer: outcome, packetHash: closePacket(), choices: ["merged", "abandoned"] });
// `ark run close` outside OMP, as a person: the ask answer in the main session, then the outcome typed on a terminal. typed = null is an agent's shell (no controlling terminal).
const closeTyped = (typed: string | null, outcome: string) =>
  spawnArk(["bun", CLI, "run", "close", run(), outcome], {
    cwd: proj,
    env: { ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PATH: `${bin}:${process.env.PATH}`, GH_LOG: join(root, "gh.log"), GH_STATE: join(root, "gh.state"), GH_BODY: join(root, "gh.body"), PI_SESSION_ID: "", PI_SESSION_FILE: "" },
  }, typed);

describe("ARK-117-AC2", () => {
  test("with mr: false the G2 approval ends the run as handed off", () => {
    atG2Approved("project: demo\nmr: false\n");
    expect(runState()).toMatchObject({ state: "done", status: "done", outcome: "handed_off" });
  });

  test("a run with open MRs stays open until a human records merged", () => {
    atG2Approved();
    const early = closeTyped("merged", "merged");
    expect(early.exitCode).toBe(1);
    expect(early.stderr.toString()).toContain("no MR has been opened");

    ok(ark("mr", run()));
    proveClose("merged");
    expect(runState()).toMatchObject({ state: "mrs_open", status: "waiting_human", outcome: null });
    const r = closeTyped("merged", "merged");
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(runState()).toMatchObject({ state: "done", status: "done", outcome: "merged" });
    expect(events("run.closed")[0].data).toMatchObject({ outcome: "merged", channel: "tty", by: "t <t@t> (" + userInfo().username + ")" });
  });

  test("an MR closed unmerged after G2 is recorded as abandoned by a human", () => {
    atG2Approved();
    ok(ark("mr", run()));
    proveClose("abandoned");
    const r = closeTyped("abandoned", "abandoned");
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(runState()).toMatchObject({ state: "done", outcome: "abandoned" });
  });

  test("ark run close needs the outcome typed on a terminal: without one, or with another word, nothing is recorded", () => {
    atG2Approved();
    ok(ark("mr", run()));
    proveClose("merged");
    const before = readFileSync(runFile("ledger.ndjson"), "utf8");
    const agent = closeTyped(null, "merged");
    expect(agent.exitCode).toBe(1);
    expect(agent.stderr.toString()).toContain("no controlling terminal");
    const wrong = closeTyped("abandoned", "merged");
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr.toString()).toContain("expected 'merged'");
    expect(readFileSync(runFile("ledger.ndjson"), "utf8")).toBe(before);
    expect(ark("run", "close", run(), "aborted").err).toContain("unknown outcome");
  });
});

describe("ARK-120-AC6", () => {
  test("mr: false refuses to hand off a run that already opened an MR", () => {
    atG2Approved();
    ok(ark("mr", run()));
    writeFileSync(join(proj, "ark.yml"), "project: demo\nmr: false\n");
    const r = ark("mr", run());
    expect(r.code).toBe(1);
    expect(r.err).toContain("already has an opened MR");
    expect(runState()).toMatchObject({ state: "mrs_open", outcome: null });
  });

  test("before any MR exists a run can be aborted, but cannot be abandoned", () => {
    atG2Approved();
    const before = readFileSync(runFile("ledger.ndjson"), "utf8");
    const abandoned = closeTyped("abandoned", "abandoned");
    expect(abandoned.exitCode).toBe(1);
    expect(abandoned.stderr.toString()).toContain("no MR has been opened");
    expect(readFileSync(runFile("ledger.ndjson"), "utf8")).toBe(before);
    ok(ark("advance", run(), "abort"));
    expect(runState()).toMatchObject({ state: "aborted", outcome: "aborted" });
  });

  test("once an MR is open the run cannot be aborted: its outcome is a human's to record", () => {
    atG2Approved();
    ok(ark("mr", run()));
    const r = ark("advance", run(), "abort");
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot abort after an MR was opened");
    expect(runState()).toMatchObject({ state: "mrs_open", outcome: null });
  });

  test("in OMP a close ask answers only the MR list it was shown; the matching one records its ask call id", () => {
    atG2Approved();
    ok(ark("mr", run()));
    appendAskProof(mainSessionFile(home), { action: "run.closed", runId: run(), answer: "merged", packetHash: `sha256:${"0".repeat(64)}`, choices: ["merged", "abandoned"] });
    const before = readFileSync(runFile("ledger.ndjson"), "utf8");
    expect(ark("run", "close", run(), "merged").code).toBe(1);
    expect(readFileSync(runFile("ledger.ndjson"), "utf8")).toBe(before);

    appendAskProof(mainSessionFile(home), { action: "run.closed", runId: run(), answer: "merged", packetHash: closePacket(), choices: ["merged", "abandoned"], toolCallId: "ask-close" });
    const r = ark("run", "close", run(), "merged");
    expect(r.code, r.err).toBe(0);
    expect(runState()).toMatchObject({ state: "done", outcome: "merged" });
    expect(events("run.closed")[0].data).toMatchObject({ outcome: "merged", channel: "omp", ask_call_id: "ask-close" });
  });
});

describe("ARK-120-AC2", () => {
  test("another close can acquire the ledger lock while the terminal confirmation is waiting", async () => {
    atG2Approved();
    ok(ark("mr", run()));
    proveClose("merged"); // the human answered the ask; the terminal confirmation is what the first close waits on
    const waiting = join(root, "close.waiting");
    const release = join(root, "close.release");
    const out = join(root, "close.out");
    const err = join(root, "close.err");
    const first = Bun.spawn(["bun", join(import.meta.dir, "pty.ts"), "merged", out, err, "bun", CLI, "run", "close", run(), "merged"], {
      cwd: proj,
      env: { ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PATH: `${bin}:${process.env.PATH}`, PI_SESSION_ID: "", PI_SESSION_FILE: "", ARK_PTY_WAIT_FILE: waiting, ARK_PTY_RELEASE_FILE: release },
    });
    const waitingSignal = Promise.withResolvers<boolean>();
    const watcher = watch(root, () => {
      if (existsSync(waiting)) {
        watcher.close();
        waitingSignal.resolve(true);
      }
    });
    if (existsSync(waiting)) {
      watcher.close();
      waitingSignal.resolve(true);
    }
    // The subprocess uses a real PTY and filesystem signals; fake timers cannot advance either.
    const signaled = await Promise.race([waitingSignal.promise, Bun.sleep(10_000).then(() => false)]);
    if (!signaled) writeFileSync(release, "continue\n");
    expect(signaled).toBe(true);

    const second = Bun.spawn(["bun", CLI, "run", "close", run(), "merged"], {
      cwd: proj,
      env: { ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PATH: `${bin}:${process.env.PATH}`, PI_SESSION_ID: "ark-main-session", PI_SESSION_FILE: mainSessionFile(home) },
      stdin: "ignore",
    });
    const completed = await Promise.race([second.exited, Bun.sleep(10_000).then(() => -1)]);
    writeFileSync(release, "continue\n");
    expect(completed).not.toBe(-1);
    expect(completed).toBe(0);
    expect(await first.exited).toBe(1);
    expect(readFileSync(err, "utf8")).toContain("state 'done'");
    expect(runState()).toMatchObject({ state: "done", outcome: "merged" });
  });
});
