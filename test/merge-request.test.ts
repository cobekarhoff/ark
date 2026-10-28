import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { rechain } from "./ledger";
import { setKinds } from "./kinds";
import { OMP_CONFIG } from "./omp-config";
import { credentialFreeEnvironment } from "../cli/launch";
import { appendAskProof, mainSessionFile, spawnArk } from "./tty";

setDefaultTimeout(60_000);
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
// Git identity as config, passed only to ark itself (CI has no global git user).
const GIT_IDENTITY = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@t" };
const COMMAND_LINE_FILE = join(import.meta.dir, "..", "cli", "ark.ts");
const ORIGIN = "https://github.com/acme/demo.git"; // rewritten to the local bare repo by url.<bare>.insteadOf
const PULL_REQUEST_URL = "https://github.com/acme/demo/pull/7";
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
    printf '[{"url":"${PULL_REQUEST_URL}","number":7,"state":"OPEN","baseRefName":"%s","headRepositoryOwner":{"login":"%s"}}]\\n' "$base" "\${repo%%/*}" > "$GH_STATE"
    echo "${PULL_REQUEST_URL}" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;
const REPOSITORY_YAML = JSON.stringify({ suites: { unit: { format: "bun-test", level: "integration", run: 'bun test -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml', junit: "$ARK_OUT/bun.xml" } } });
const pullRequest = (number: number, options: { owner?: string; base?: string; state?: string } = {}) =>
  ({ url: `https://github.com/acme/demo/pull/${number}`, number: number, state: options.state ?? "OPEN", baseRefName: options.base ?? "main", headRepositoryOwner: { login: options.owner ?? "acme" } });

let home: string;
let root: string;
let projectDirectory: string;
let bare: string;
let binaryDirectory: string;

const git = (workingDirectory: string, ...argumentsList: string[]) => {
  const result = Bun.spawnSync(["git", ...argumentsList], { cwd: workingDirectory, env: process.env });
  if (result.exitCode !== 0) throw new Error(`git ${argumentsList.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};
const tryGit = (workingDirectory: string, ...argumentsList: string[]) => Bun.spawnSync(["git", ...argumentsList], { cwd: workingDirectory, env: process.env }).exitCode === 0;
const ark = (...argumentsList: string[]) => {
  const environment = {
    ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PATH: `${binaryDirectory}:${process.env.PATH}`,
    GH_LOG: join(root, "gh.log"), GH_STATE: join(root, "gh.state"), GH_BODY: join(root, "gh.body"),
  };
  const result = spawnArk(["bun", COMMAND_LINE_FILE, ...argumentsList], { cwd: projectDirectory, env: environment });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};
const run = () => readdirSync(join(home, "projects", "demo", "runs")).filter((result) => result !== ".locks")[0];
const runFile = (file: string) => join(home, "projects", "demo", "runs", run(), file);
const events = (type: string) =>
  readFileSync(runFile("ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === type);
const runState = () => JSON.parse(readFileSync(runFile("state.json"), "utf8"));
const worktree = () => runFile("worktrees/demo");
const branch = () => runState().repos[0].branch as string;
const ghLog = () => (existsSync(join(root, "gh.log")) ? readFileSync(join(root, "gh.log"), "utf8").trim().split("\n") : []);
const creates = () => ghLog().filter((line) => line.startsWith("pr create"));
const seedPullRequests = (...pullRequests: unknown[]) => writeFileSync(join(root, "gh.state"), JSON.stringify(pullRequests));
const onRemote = (ref: string, remote = bare) => (tryGit(remote, "rev-parse", "--verify", "-q", ref) ? git(remote, "rev-parse", ref) : null);
const ok = (result: { code: number; err: string }) => {
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
};

// A project whose origin looks like GitHub, a run with one implemented worktree commit, and evidence approved.
// `validatorCommit` adds a tagged test and command-owned validator proof above the implementer's head.
function atEvidenceApproved(arkYaml = "project: demo\n", validatorCommit = false, approve = true) {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  root = realpathSync(mkdtempSync(join(tmpdir(), "ark-fx-")));
  binaryDirectory = join(root, "bin");
  mkdirSync(binaryDirectory);
  writeFileSync(join(binaryDirectory, "gh"), FAKE_GH);
  chmodSync(join(binaryDirectory, "gh"), 0o755);

  projectDirectory = join(root, "demo");
  bare = join(root, "remote.git");
  mkdirSync(join(projectDirectory, ".ark"), { recursive: true });
  git(projectDirectory, "init", "-q", "-b", "main");
  writeFileSync(join(projectDirectory, "ark.yml"), arkYaml);
  mkdirSync(join(projectDirectory, ".omp"));
  writeFileSync(join(projectDirectory, ".omp", "config.yml"), OMP_CONFIG);
  writeFileSync(join(projectDirectory, ".ark", "repo.yml"), REPOSITORY_YAML);
  git(projectDirectory, "add", "-A");
  git(projectDirectory, "commit", "-qm", "base");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(projectDirectory, "config", `url.${bare}.insteadOf`, ORIGIN);
  git(projectDirectory, "remote", "add", "origin", ORIGIN);
  git(projectDirectory, "push", "-q", "origin", "main");
  git(projectDirectory, "remote", "set-head", "origin", "main");

  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  writeFileSync(join(home, "projects", "demo", "tickets", "DEMO-1.md"),
    `---\nid: DEMO-1\ntitle: "Add the feature"\nstatus: ready\nacceptance_criteria:\n  - id: DEMO-1-AC1\n    text: "criterion one"\n---\nBody.\n`);
  ok(ark("run", "start", "DEMO-1"));
  ok(ark("log", "route", run(), "ticket", "fixture"));
  ok(ark("advance", run(), "analysis.completed"));
  writeFileSync(runFile("plan.md"), "# Plan\n");
  setKinds(runFile(""));
  const planPacketHash = ark("gate", "packet", run(), "plan").out.trim();
  ok(ark("gate", "answer", run(), "plan", "approve", "--packet", planPacketHash));
  ok(ark("worktree", "create", run()));
  ok(ark("advance", run(), "build.started"));
  writeFileSync(join(worktree(), "feature.txt"), "feature\n");
  git(worktree(), "add", "-A");
  git(worktree(), "commit", "-qm", "feature");
  ok(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'));
  if (validatorCommit) {
    mkdirSync(join(worktree(), "test"));
    writeFileSync(join(worktree(), "test", "feature.test.ts"), `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("DEMO-1-AC1 the feature is delivered", () => {
  expect(readFileSync("feature.txt", "utf8")).toBe("feature\\n");
});
`);
    git(worktree(), "add", "-A");
    git(worktree(), "commit", "-qm", "validator test commit");
    ok(ark("test", run(), "--criteria", "DEMO-1-AC1", "--red-green", "--as", "validator"));
  }
  ok(ark("advance", run(), "build.completed"));
  writeFileSync(runFile("ac.yml"), `- id: DEMO-1-AC1\n  text: criterion one\n  level: ${validatorCommit ? "integration" : "manual"}\n  kind: new\n`);
  if (!validatorCommit) {
    mkdirSync(runFile("manual"));
    writeFileSync(runFile("manual/DEMO-1-AC1.md"), "signed-by: MR Tester\nat: 2026-10-22\n");
  }
  ok(ark("trace-check", run()));
  mkdirSync(runFile("artifacts"), { recursive: true });
  writeFileSync(runFile("artifacts/evidence.txt"), "evidence\n");
  const evidencePacketHash = ark("gate", "packet", run(), "evidence").out.trim();
  if (approve) ok(ark("gate", "answer", run(), "evidence", "approve", "--packet", evidencePacketHash));
  return evidencePacketHash;
}

describe("ARK-107-AC1", () => {
  beforeEach(() => atEvidenceApproved());

  test("ark merge-request open pushes the approved SHA past the disabled pushurl and opens a PR into main whose body carries the trace matrix and run-relative evidence paths", () => {
    const base = onRemote("refs/heads/main");
    const result = ark("merge-request", "open", run());
    ok(result);
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha);
    expect(onRemote("refs/heads/main")).toBe(base);

    const created = JSON.parse(readFileSync(join(root, "gh.state"), "utf8"))[0]; // what GitHub would now list, from the flags ark passed
    expect(created).toMatchObject({ baseRefName: "main", headRepositoryOwner: { login: "acme" } });
    expect(creates()[0]).toContain("--title DEMO-1: Add the feature");
    const body = readFileSync(join(root, "gh.body"), "utf8");
    expect(body).toContain(readFileSync(runFile("trace-matrix.md"), "utf8").trim());
    expect(body).toContain("- artifacts/evidence.txt");
    expect(body).toContain("DEMO-1-AC1: criterion one");

    expect(events("merge_request.opened").map((event) => event.data)).toEqual([{ repo: "demo", url: PULL_REQUEST_URL, number: 7 }]);
    expect(runState().state).toBe("merge_requests_open");
  });

  test("running ark merge-request open twice opens one PR and records one merge_request.opened", () => {
    ok(ark("merge-request", "open", run()));
    ok(ark("merge-request", "open", run()));
    expect(creates()).toHaveLength(1);
    expect(events("merge_request.opened")).toHaveLength(1);
  });

  test("a crash between pr create and the ledger is recovered by adopting the open PR from this repo into main, not a fork's or another base's", () => {
    seedPullRequests(pullRequest(3, { owner: "mallory" }), pullRequest(4, { base: "release" }), pullRequest(5));
    ok(ark("merge-request", "open", run()));
    expect(creates()).toEqual([]);
    expect(events("merge_request.opened").map((event) => event.data)).toEqual([{ repo: "demo", url: "https://github.com/acme/demo/pull/5", number: 5 }]);
  });

  test("a fork's PR with the same branch name is not adopted: a new PR is opened", () => {
    seedPullRequests(pullRequest(3, { owner: "mallory" }), pullRequest(4, { base: "release" }));
    ok(ark("merge-request", "open", run()));
    expect(creates()).toHaveLength(1);
    expect(events("merge_request.opened").map((event) => event.data.url)).toEqual([PULL_REQUEST_URL]);
  });

  test("a closed or merged PR of this repo for the branch is refused by name, not reused", () => {
    for (const state of ["CLOSED", "MERGED"]) {
      seedPullRequests(pullRequest(9, { state }));
      const result = ark("merge-request", "open", run());
      expect(result.code, state).toBe(1);
      expect(result.err).toContain(`${state.toLowerCase()} merge request https://github.com/acme/demo/pull/9`);
      expect(creates()).toEqual([]);
      expect(events("merge_request.opened")).toEqual([]);
    }
  });

  test("ark merge-request open outside merge_requests_open is refused before anything is pushed or called", () => {
    ok(ark("advance", run(), "abort"));
    const result = ark("merge-request", "open", run());
    expect(result.code).toBe(1);
    expect(result.err).toContain("merge_requests_open");
    expect(ghLog()).toEqual([]);
    expect(onRemote(`refs/heads/${branch()}`)).toBeNull();
  });

  test("commits made after evidence approval are not pushed", () => {
    writeFileSync(join(worktree(), "late.txt"), "late\n");
    git(worktree(), "add", "-A");
    git(worktree(), "commit", "-qm", "late");
    const result = ark("merge-request", "open", run());
    expect(result.code).toBe(1);
    expect(result.err).toContain("differs from the approved");
    expect(onRemote(`refs/heads/${branch()}`)).toBeNull();
    expect(ghLog()).toEqual([]);
  });

  test("a remote.origin.url the agent overrides in its worktree config does not redirect the push", () => {
    const evil = join(root, "evil.git");
    git(root, "init", "-q", "--bare", evil);
    git(worktree(), "config", "--worktree", "remote.origin.url", evil);
    ok(ark("merge-request", "open", run()));
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha);
    expect(onRemote(`refs/heads/${branch()}`, evil)).toBeNull();
  });

  test("a pre-push hook the agent sets up through its worktree config does not run during the credentialed push", () => {
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\ntouch ${join(root, "hook-ran")}\n`);
    chmodSync(join(hooks, "pre-push"), 0o755);
    git(worktree(), "config", "--worktree", "core.hooksPath", hooks);
    ok(ark("merge-request", "open", run()));
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha);
    expect(existsSync(join(root, "hook-ran"))).toBe(false);
  });

  test("repointing the worktree's .git file at another repository redirects neither the push nor its hooks", () => {
    // The attacker repo holds the approved commit, its own origin, and a hook that marks it ran.
    const evil = join(root, "evil");
    const evilRemote = join(root, "evil-remote.git");
    git(root, "clone", "-q", projectDirectory, evil);
    git(evil, "fetch", "-q", worktree(), `${runState().repos[0].head_sha}:refs/heads/stolen`);
    git(root, "init", "-q", "--bare", "-b", "main", evilRemote);
    git(evil, "remote", "set-url", "origin", evilRemote);
    writeFileSync(join(evil, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${join(root, "evil-hook-ran")}\n`);
    chmodSync(join(evil, ".git", "hooks", "pre-push"), 0o755);
    git(evil, "checkout", "-q", "stolen");
    writeFileSync(join(worktree(), ".git"), `gitdir: ${join(evil, ".git")}\n`);

    ok(ark("merge-request", "open", run()));
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha);
    expect(onRemote(`refs/heads/${branch()}`, evilRemote)).toBeNull();
    expect(existsSync(join(root, "evil-hook-ran"))).toBe(false);
  });

  test("a credential in the origin URL never reaches stderr or the ledger, for a failed push or a malformed URL", () => {
    for (const url of [`https://x-access-token:${SENTINEL}@127.0.0.1:1/acme/demo.git`, `https://user:${SENTINEL}@host`]) {
      git(projectDirectory, "remote", "set-url", "origin", url);
      const result = ark("merge-request", "open", run());
      expect(result.code, url).toBe(1);
      expect(result.err).toContain("***@");
      expect(result.err).not.toContain(SENTINEL);
      expect(result.out).not.toContain(SENTINEL);
      expect(readFileSync(runFile("ledger.ndjson"), "utf8")).not.toContain(SENTINEL);
    }
  });

  test("a branch outside ark/ in the ledger is refused and main on the remote does not move", () => {
    const ledger = readFileSync(runFile("ledger.ndjson"), "utf8");
    writeFileSync(runFile("ledger.ndjson"), ledger.replace(`"branch":"${branch()}"`, '"branch":"main"'));
    rechain(dirname(runFile("ledger.ndjson"))); // a chained ledger that carries the bad branch, so the merge-request guard (not the chain check) is what refuses
    const base = onRemote("refs/heads/main");
    const result = ark("merge-request", "open", run());
    expect(result.code).toBe(1);
    expect(result.err).toContain("not an ark/ branch");
    expect(onRemote("refs/heads/main")).toBe(base);
    expect(ghLog()).toEqual([]);
  });

  test("next_action in merge_requests_open is open_merge_requests for the orchestrator until every repo has an MR, then a human merges", () => {
    expect(runState().next_action).toMatchObject({ kind: "open_merge_requests", agent: "orchestrator" });
    expect(runState().status).toBe("active");
    ok(ark("merge-request", "open", run()));
    expect(runState().next_action).toMatchObject({ kind: "merge", agent: "human" });
    expect(runState().status).toBe("waiting_human");
  });
});

describe("ARK-145-AC1", () => {
  test("ark merge-request open pushes the head the evidence gate approved, a validator test commit above the implementer's head, not the implementer's head", () => {
    atEvidenceApproved("project: demo\n", true);
    const implementerHead = runState().repos[0].head_sha;
    const approvedHead = git(worktree(), "rev-parse", "HEAD");
    expect(approvedHead).not.toBe(implementerHead);

    ok(ark("merge-request", "open", run()));
    expect(onRemote(`refs/heads/${branch()}`)).toBe(approvedHead);
    expect(onRemote(`refs/heads/${branch()}`)).not.toBe(implementerHead);
    expect(events("merge_request.opened")).toHaveLength(1);
    expect(events("gate.answered").find((event) => event.data.gate === "evidence")?.data.approved_heads).toEqual({ demo: approvedHead });
  });

  test("evidence approval cannot authorize or push a concurrent commit made after proof checks", async () => {
    const packetHash = atEvidenceApproved("project: demo\n", true, false);
    const provenHead = git(worktree(), "rev-parse", "HEAD");
    const counterFile = join(root, "race-counter");
    git(worktree(), "config", "--worktree", "core.fsmonitor", join(import.meta.dir, "approval-race.ts"));
    const approval = Bun.spawn(["bun", COMMAND_LINE_FILE, "gate", "answer", run(), "evidence", "approve", "--packet", packetHash], {
      cwd: projectDirectory,
      env: { ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PI_SESSION_ID: "ark-main-session", PI_SESSION_FILE: mainSessionFile(home), ARK_RACE_COUNTER: counterFile, ARK_RACE_WORKTREE: worktree() },
      stdout: "pipe", stderr: "pipe",
    });
    const approvalCode = await approval.exited;
    const observedChecks = Number(readFileSync(counterFile, "utf8"));
    expect(observedChecks, await new Response(approval.stderr).text()).toBeGreaterThanOrEqual(3);
    const unprovenHead = git(worktree(), "rev-parse", "HEAD");
    expect(unprovenHead).not.toBe(provenHead);
    expect(events("test.red_green").at(-1)?.data.head_sha).toBe(provenHead);
    git(worktree(), "config", "--worktree", "--unset", "core.fsmonitor");
    const opened = ark("merge-request", "open", run());
    expect(onRemote(`refs/heads/${branch()}`)).toBeNull();
    expect(opened.code).toBe(1);
    expect(ghLog()).toEqual([]);
    if (approvalCode === 0) {
      expect(events("gate.answered").findLast((event) => event.data.gate === "evidence")?.data.approved_heads).toEqual({ demo: provenHead });
      expect(opened.err).toContain(`differs from the approved ${provenHead}`);
    } else {
      expect(events("gate.answered").filter((event) => event.data.gate === "evidence")).toEqual([]);
    }
  });
});

describe("ARK-145-AC2", () => {
  beforeEach(() => atEvidenceApproved("project: demo\n", true));

  test("a commit made after evidence approval is still refused and nothing is pushed, even when a validator test commit preceded approval", () => {
    writeFileSync(join(worktree(), "late.txt"), "late\n");
    git(worktree(), "add", "-A");
    git(worktree(), "commit", "-qm", "late");
    const result = ark("merge-request", "open", run());
    expect(result.code).toBe(1);
    expect(result.err).toContain("differs from the approved");
    expect(onRemote(`refs/heads/${branch()}`)).toBeNull();
    expect(ghLog()).toEqual([]);
    expect(events("merge_request.opened")).toEqual([]);
  });
});

describe("ARK-107-AC2", () => {
  beforeEach(() => atEvidenceApproved("project: demo\nmerge_requests: false\n"));

  test("with merge_requests: false the evidence approval itself ends the run at the ready branch, with no push and no gh call", () => {
    expect(events("run.closed").map((event) => event.data)).toEqual([{ outcome: "handed_off", reason: "merge requests disabled" }]);
    expect(runState().state).toBe("done");
    expect(ghLog()).toEqual([]);
    expect(onRemote(`refs/heads/${branch()}`)).toBeNull();
    expect(git(worktree(), "branch", "--show-current")).toBe(branch()); // the ready branch is still there
  });

  test("ark merge-request open on a closed merge_requests: false run says so, changes nothing and calls no gh", () => {
    const before = readFileSync(runFile("ledger.ndjson"), "utf8");
    const result = ark("merge-request", "open", run());
    ok(result);
    expect(result.out).toContain("merge requests are disabled");
    expect(readFileSync(runFile("ledger.ndjson"), "utf8")).toBe(before);
    expect(ghLog()).toEqual([]);
  });
});

describe("ARK-107-AC3", () => {
  test("ark merge-request open leaves the base branch on the remote where it was and never runs gh pr merge", () => {
    atEvidenceApproved();
    const base = onRemote("refs/heads/main");
    ok(ark("merge-request", "open", run()));
    ok(ark("merge-request", "open", run()));
    expect(onRemote("refs/heads/main")).toBe(base);
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha);
    expect(ghLog().length).toBeGreaterThan(0);
    for (const command of ghLog()) expect(command.split(" ")).not.toContain("merge");
  });

  test("ark advance refuses the events only ark merge-request open and ark worktree create may write, so none can be forged", () => {
    atEvidenceApproved();
    const before = readFileSync(runFile("ledger.ndjson"), "utf8");
    for (const [type, data, owner] of [
      ["merge_request.opened", { repo: "demo", url: PULL_REQUEST_URL, number: 7 }, "ark merge-request open"],
      ["run.closed", { outcome: "merged" }, "ark run close"],
      ["worktree.created", { repo: "demo2", branch: "main", base_sha: "0".repeat(40) }, "ark worktree create"],
    ] as const) {
      const result = ark("advance", run(), type, "--data", JSON.stringify(data));
      expect(result.code, type).toBe(1);
      expect(result.err).toContain(`written by '${owner}'`);
    }
    expect(readFileSync(runFile("ledger.ndjson"), "utf8")).toBe(before);
  });
});

// The typed ark_merge_request_open tool as an `ark launch` session runs it: the process is credential-free, and only this tool's child gets the human's values back.
const ARK_MERGE_REQUEST_DRIVER = `
const schemaBuilder: unknown = new Proxy(function () {}, { get: () => schemaBuilder, apply: () => schemaBuilder });
// Load the plugin inside the credential-free process that exercises its launch boundary.
const tools = (await import(${JSON.stringify(join(import.meta.dir, "..", "tools", "ark.ts"))})).default({ zod: schemaBuilder });
const result = await tools.find((tool) => tool.name === "ark_merge_request_open").execute("id", { run_id: process.argv[2] }, undefined, { sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } });
console.log(result.content[0].text);
`;
const arkMergeRequestTool = () => {
  const driver = join(root, "driver.ts");
  writeFileSync(driver, ARK_MERGE_REQUEST_DRIVER);
  const environment = {
    ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PATH: `${binaryDirectory}:${process.env.PATH}`,
    GH_LOG: join(root, "gh.log"), GH_STATE: join(root, "gh.state"), GH_BODY: join(root, "gh.body"),
  };
  const result = Bun.spawnSync(["bun", driver, run()], { cwd: projectDirectory, env: credentialFreeEnvironment(environment, join(root, "empty-gh"), projectDirectory) });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};

describe("ARK-118-AC2", () => {
  let mark: string;
  beforeEach(() => {
    atEvidenceApproved();
    // The human's login: a credential helper in the source repo's own config. `ark launch` resets it for the agents; the ark_merge_request_open tool gets it back.
    git(projectDirectory, "config", "credential.helper", "!f() { echo username=human; echo password=HUMAN_SECRET; }; f");
    mark = join(root, "hook-mark");
  });
  // A pre-push hook that, if it ever runs, asks git for the credential the push carries.
  const plant = (directory: string) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "pre-push"), `#!/bin/sh\nprintf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill > ${mark}\n`);
    chmodSync(join(directory, "pre-push"), 0o755);
  };
  const pushed = (result: { code: number; err: string; out: string }) => {
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain(PULL_REQUEST_URL);
    expect(onRemote(`refs/heads/${branch()}`)).toBe(runState().repos[0].head_sha); // the push itself went through
  };

  test("the ark_merge_request_open tool's push runs no pre-push hook from the source repository's hooks/", () => {
    plant(join(projectDirectory, ".git", "hooks"));
    pushed(arkMergeRequestTool());
    expect(existsSync(mark)).toBe(false); // otherwise it holds username=human password=HUMAN_SECRET
  });

  test("nor one behind a core.hooksPath in the source repository's config", () => {
    plant(join(root, "source-hooks"));
    git(projectDirectory, "config", "core.hooksPath", join(root, "source-hooks"));
    pushed(arkMergeRequestTool());
    expect(existsSync(mark)).toBe(false);
  });
});

// The close packet the human is shown: the opened MRs, which `ark merge-request open` prints as close_packet.
const closePacket = () => {
  const opened = events("merge_request.opened").map((event) => ({ repo: event.data.repo, url: event.data.url, number: event.data.number }));
  return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(opened)).digest("hex")}`;
};
const proveClose = (outcome: string) =>
  appendAskProof(mainSessionFile(home), { action: "run.closed", runId: run(), answer: outcome, packetHash: closePacket(), choices: ["merged", "abandoned"] });
// `ark run close` outside OMP, as a person: the ask answer in the main session, then the outcome typed on a terminal. typed = null is an agent's shell (no controlling terminal).
const closeTyped = (typed: string | null, outcome: string) =>
  spawnArk(["bun", COMMAND_LINE_FILE, "run", "close", run(), outcome], {
    cwd: projectDirectory,
    env: { ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PATH: `${binaryDirectory}:${process.env.PATH}`, GH_LOG: join(root, "gh.log"), GH_STATE: join(root, "gh.state"), GH_BODY: join(root, "gh.body"), PI_SESSION_ID: "", PI_SESSION_FILE: "" },
  }, typed);

describe("ARK-117-AC2", () => {
  test("with merge_requests: false the evidence approval ends the run as handed off", () => {
    atEvidenceApproved("project: demo\nmerge_requests: false\n");
    expect(runState()).toMatchObject({ state: "done", status: "done", outcome: "handed_off" });
  });

  test("a run with open MRs stays open until a human records merged", () => {
    atEvidenceApproved();
    const early = closeTyped("merged", "merged");
    expect(early.exitCode).toBe(1);
    expect(early.stderr.toString()).toContain("no merge request has been opened");

    ok(ark("merge-request", "open", run()));
    proveClose("merged");
    expect(runState()).toMatchObject({ state: "merge_requests_open", status: "waiting_human", outcome: null });
    const result = closeTyped("merged", "merged");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(runState()).toMatchObject({ state: "done", status: "done", outcome: "merged" });
    expect(events("run.closed")[0].data).toMatchObject({ outcome: "merged", channel: "tty", by: "t <t@t> (" + userInfo().username + ")" });
  });

  test("an MR closed unmerged after evidence is recorded as abandoned by a human", () => {
    atEvidenceApproved();
    ok(ark("merge-request", "open", run()));
    proveClose("abandoned");
    const result = closeTyped("abandoned", "abandoned");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(runState()).toMatchObject({ state: "done", outcome: "abandoned" });
  });

  test("ark run close needs the outcome typed on a terminal: without one, or with another word, nothing is recorded", () => {
    atEvidenceApproved();
    ok(ark("merge-request", "open", run()));
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
  test("merge_requests: false refuses to hand off a run that already opened an MR", () => {
    atEvidenceApproved();
    ok(ark("merge-request", "open", run()));
    writeFileSync(join(projectDirectory, "ark.yml"), "project: demo\nmerge_requests: false\n");
    const result = ark("merge-request", "open", run());
    expect(result.code).toBe(1);
    expect(result.err).toContain("already has an opened merge request");
    expect(runState()).toMatchObject({ state: "merge_requests_open", outcome: null });
  });

  test("before any MR exists a run can be aborted, but cannot be abandoned", () => {
    atEvidenceApproved();
    const before = readFileSync(runFile("ledger.ndjson"), "utf8");
    const abandoned = closeTyped("abandoned", "abandoned");
    expect(abandoned.exitCode).toBe(1);
    expect(abandoned.stderr.toString()).toContain("no merge request has been opened");
    expect(readFileSync(runFile("ledger.ndjson"), "utf8")).toBe(before);
    ok(ark("advance", run(), "abort"));
    expect(runState()).toMatchObject({ state: "aborted", outcome: "aborted" });
  });

  test("once an MR is open the run cannot be aborted: its outcome is a human's to record", () => {
    atEvidenceApproved();
    ok(ark("merge-request", "open", run()));
    const result = ark("advance", run(), "abort");
    expect(result.code).toBe(1);
    expect(result.err).toContain("cannot abort after a merge request was opened");
    expect(runState()).toMatchObject({ state: "merge_requests_open", outcome: null });
  });

  test("in OMP a close ask answers only the MR list it was shown; the matching one records its ask call id", () => {
    atEvidenceApproved();
    ok(ark("merge-request", "open", run()));
    appendAskProof(mainSessionFile(home), { action: "run.closed", runId: run(), answer: "merged", packetHash: `sha256:${"0".repeat(64)}`, choices: ["merged", "abandoned"] });
    const before = readFileSync(runFile("ledger.ndjson"), "utf8");
    expect(ark("run", "close", run(), "merged").code).toBe(1);
    expect(readFileSync(runFile("ledger.ndjson"), "utf8")).toBe(before);

    appendAskProof(mainSessionFile(home), { action: "run.closed", runId: run(), answer: "merged", packetHash: closePacket(), choices: ["merged", "abandoned"], toolCallId: "ask-close" });
    const result = ark("run", "close", run(), "merged");
    expect(result.code, result.err).toBe(0);
    expect(runState()).toMatchObject({ state: "done", outcome: "merged" });
    expect(events("run.closed")[0].data).toMatchObject({ outcome: "merged", channel: "omp", ask_call_id: "ask-close" });
  });
});

describe("ARK-120-AC2", () => {
  test("another close can acquire the ledger lock while the terminal confirmation is waiting", async () => {
    atEvidenceApproved();
    ok(ark("merge-request", "open", run()));
    proveClose("merged"); // the human answered the ask; the terminal confirmation is what the first close waits on
    const waiting = join(root, "close.waiting");
    const release = join(root, "close.release");
    const output = join(root, "close.out");
    const error = join(root, "close.err");
    const first = Bun.spawn(["bun", join(import.meta.dir, "pty.ts"), "merged", output, error, "bun", COMMAND_LINE_FILE, "run", "close", run(), "merged"], {
      cwd: projectDirectory,
      env: { ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PATH: `${binaryDirectory}:${process.env.PATH}`, PI_SESSION_ID: "", PI_SESSION_FILE: "", ARK_PTY_WAIT_FILE: waiting, ARK_PTY_RELEASE_FILE: release },
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

    const second = Bun.spawn(["bun", COMMAND_LINE_FILE, "run", "close", run(), "merged"], {
      cwd: projectDirectory,
      env: { ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PATH: `${binaryDirectory}:${process.env.PATH}`, PI_SESSION_ID: "ark-main-session", PI_SESSION_FILE: mainSessionFile(home) },
      stdin: "ignore",
    });
    const completed = await Promise.race([second.exited, Bun.sleep(10_000).then(() => -1)]);
    writeFileSync(release, "continue\n");
    expect(completed).not.toBe(-1);
    expect(completed).toBe(0);
    expect(await first.exited).toBe(1);
    expect(readFileSync(error, "utf8")).toContain("state 'done'");
    expect(runState()).toMatchObject({ state: "done", outcome: "merged" });
  });
});
