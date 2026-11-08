import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempArkHome, tempGitRepo, writeProject } from "./helpers";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const repositoryRoot = join(import.meta.dir, "..");
const run = "2026-11-02-ARK-900-1";

let bin = "";
let ghLog = "";
let notificationLog = "";

/** Written directly: appendEvent would refuse these events without the whole earlier flow. */
function writeEvents(
  runDirectory: string,
  events: { type: string; data: Record<string, unknown> }[],
) {
  writeFileSync(
    join(runDirectory, "events.ndjson"),
    events
      .map((event, i) => JSON.stringify({ seq: i + 1, time: "2026-11-02T00:00:00.000Z", ...event }))
      .join("\n") + "\n",
  );
}

function executable(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
  chmodSync(join(bin, name), 0o755);
}

interface ScriptResult {
  code: number;
  out: string;
  err: string;
}

/** Runs a script with the fakes first on PATH. A scratch TMPDIR keeps the real one out of reach. */
function runScript(
  script: string,
  args: string[],
  environment: Record<string, string> = {},
): ScriptResult {
  const result = Bun.spawnSync(["bash", join(repositoryRoot, "scripts", script), ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...environment },
    timeout: 30_000,
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

beforeEach(() => {
  tempArkHome();
  bin = mkdtempSync(join(tmpdir(), "ark-fake-bin-"));
  ghLog = join(bin, "gh.log");
  notificationLog = join(bin, "osascript.log");
  // Fake gh: PR 12 is DIRTY, every other PR is CLEAN. `pr view <url> --json state,...` is the open check.
  executable(
    "gh",
    `echo "$*" >> "${ghLog}"
case "$*" in
  "pr merge"*) exit 0 ;;
  *mergeStateStatus*) case "$3" in */12) echo DIRTY ;; *) echo CLEAN ;; esac ;;
  *) echo '{"state":"OPEN","statusCheckRollup":[]}' ;;
esac
`,
  );
  // No notification may fire on the human's desktop.
  executable("osascript", `echo "$*" >> "${notificationLog}"\n`);
  executable("ark", `exec bun "${join(repositoryRoot, "cli", "ark.ts")}" "$@"\n`);
});

/** Two repos (PR 11 CLEAN, PR 12 DIRTY) with retro.md, ticket.md id ARK-900 and a ready ticket file; one auto-merger pass. */
function runCleanPullRequestScenario() {
  const workspace = tempGitRepo();
  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
    },
  });
  const runDirectory = join(projectDirectory, "runs", run);
  mkdirSync(runDirectory, { recursive: true });
  const events: { type: string; data: Record<string, unknown> }[] = [
    {
      type: "run.started",
      data: {
        run,
        project: "demo",
        round_budget: 2,
        ticket: { id: "ARK-900", title: "Two repos" },
        criteria: [],
      },
    },
  ];
  for (const [repo, number] of [
    ["app", 11],
    ["core", 12],
  ] as const) {
    const path = mkdtempSync(join(tmpdir(), `ark-worktree-${repo}-`));
    events.push(
      { type: "worktree.created", data: { repo, path, branch: `ark/${run}`, base: "main" } },
      {
        type: "merge_request.opened",
        data: { repo, url: `https://github.com/org/${repo}/pull/${number}`, number },
      },
    );
  }
  writeEvents(runDirectory, events);
  writeFileSync(join(runDirectory, "retro.md"), "# Retro\n");
  writeFileSync(join(runDirectory, "ticket.md"), "---\nid: ARK-900\n---\n");
  mkdirSync(join(projectDirectory, "tickets"), { recursive: true });
  writeFileSync(
    join(projectDirectory, "tickets", "ARK-900.md"),
    "---\nid: ARK-900\nstatus: ready\n---\n",
  );

  return runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });
}

function expectCleanPullRequestOnlyMerged(result: ScriptResult) {
  expect(result.code).toBe(0);
  const calls = readFileSync(ghLog, "utf8").split("\n");
  expect(calls.filter((call) => call.startsWith("pr merge"))).toEqual([
    "pr merge https://github.com/org/app/pull/11 --merge",
  ]);
  const change = result.out.split("\n").find((line) => line.startsWith("CHANGE:"));
  expect(change).toBeDefined();
  expect(change).toContain(`${run} #11 merged`);
  expect(change).toContain(`${run} #12 conflicting`);
}

test("ARK-244-AC3 auto-merger merges the CLEAN PR only, reports the conflict and exits", () => {
  expectCleanPullRequestOnlyMerged(runCleanPullRequestScenario());
});

test("ARK-281-AC6 auto-merger with retro.md and a ready ticket file merges the CLEAN PR only, reports the conflict and holds nothing", () => {
  const result = runCleanPullRequestScenario();
  expectCleanPullRequestOnlyMerged(result);
  expect(result.err).not.toContain("HELD:");
});

test("ARK-244-AC3 temp-cleaner removes only old ark-* directories and prunes the worktree one held", () => {
  const workspace = tempGitRepo();
  const scratch = mkdtempSync(join(tmpdir(), "ark-scratch-tmp-"));
  const old = new Date(Date.now() - 30 * 60_000);
  const made = (name: string, when?: Date) => {
    const directory = join(scratch, name);
    mkdirSync(directory);
    if (when) utimesSync(directory, when, when);
    return directory;
  };
  const oldWorktree = join(scratch, "ark-base-old");
  Bun.spawnSync(["git", "-C", workspace, "worktree", "add", "-q", "--detach", oldWorktree]);
  utimesSync(oldWorktree, old, old);
  const oldArk = made("ark-old", old);
  const newArk = made("ark-new");
  const oldOther = made("unrelated-old", old);

  const result = runScript("temp-cleaner.sh", [workspace, "1", "--once"], { TMPDIR: scratch });

  expect(result.code).toBe(0);
  expect(existsSync(oldArk)).toBe(false);
  expect(existsSync(newArk)).toBe(true);
  expect(existsSync(oldOther)).toBe(true);
  expect(existsSync(oldWorktree)).toBe(false);
  const worktrees = Bun.spawnSync(["git", "-C", workspace, "worktree", "list", "--porcelain"]);
  expect(worktrees.stdout.toString()).not.toContain("ark-base-old");
});

// --- ARK-281: the auto-merger waits for retro.md and skips a PR whose ticket is not live ---

interface MergerRun {
  name: string;
  pr: number;
  retro: boolean;
  /** Ticket file status; undefined = no ticket file. */
  ticket?: string;
}

/** Creates the project and, for each run, its events, ticket.md (id ARK-9<pr>), retro.md and ticket file. */
function setUpMergerRuns(runs: MergerRun[]) {
  const workspace = tempGitRepo();
  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
    },
  });
  const directories: Record<string, string> = {};
  for (const { name, pr, retro, ticket } of runs) {
    const runDirectory = join(projectDirectory, "runs", name);
    directories[name] = runDirectory;
    mkdirSync(runDirectory, { recursive: true });
    const path = mkdtempSync(join(tmpdir(), "ark-worktree-app-"));
    writeEvents(runDirectory, [
      {
        type: "run.started",
        data: {
          run: name,
          project: "demo",
          round_budget: 2,
          ticket: { id: `ARK-${pr}`, title: "T" },
          criteria: [],
        },
      },
      {
        type: "worktree.created",
        data: { repo: "app", path, branch: `ark/${name}`, base: "main" },
      },
      {
        type: "merge_request.opened",
        data: { repo: "app", url: `https://github.com/org/app/pull/${pr}`, number: pr },
      },
    ]);
    writeFileSync(join(runDirectory, "ticket.md"), `---\nid: ARK-${pr}\n---\n`);
    if (retro) writeFileSync(join(runDirectory, "retro.md"), "# Retro\n");
    if (ticket) {
      mkdirSync(join(projectDirectory, "tickets"), { recursive: true });
      writeFileSync(
        join(projectDirectory, "tickets", `ARK-${pr}.md`),
        `---\nid: ARK-${pr}\nstatus: ${ticket}\n---\n`,
      );
    }
  }
  return { workspace, directories };
}

/** Fake sleep: counts passes in a file, runs `hook.sh <pass>` if present, kills the script after `stopAfter` passes. */
function fakeSleep(stopAfter: number) {
  const counter = join(bin, "sleep.count");
  executable(
    "sleep",
    `n=$(($(cat "${counter}" 2>/dev/null || echo 0) + 1))
echo $n > "${counter}"
[ -f "${join(bin, "hook.sh")}" ] && sh "${join(bin, "hook.sh")}" $n
[ $n -ge ${stopAfter} ] && kill $PPID
exit 0
`,
  );
}

const mergeCalls = () =>
  readFileSync(ghLog, "utf8")
    .split("\n")
    .filter((call) => call.startsWith("pr merge"));

test("ARK-281-AC1 auto-merger merges only the run with retro.md, and the other in a later pass once retro.md exists", () => {
  const { workspace, directories } = setUpMergerRuns([
    { name: "2026-11-02-ARK-21-1", pr: 21, retro: true },
    { name: "2026-11-02-ARK-22-1", pr: 22, retro: false },
  ]);

  // Pass 1 merges #21 and exits on that change; #22 has no pr merge call.
  const first = runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });
  expect(first.code).toBe(0);
  expect(mergeCalls()).toEqual(["pr merge https://github.com/org/app/pull/21 --merge"]);
  expect(first.out).not.toContain("#22");

  // retro.md appears after 2 held passes: the PR merges in pass 3.
  writeFileSync(
    join(bin, "hook.sh"),
    `[ "$1" = 2 ] && echo "# Retro" > "${join(directories["2026-11-02-ARK-22-1"]!, "retro.md")}"\nexit 0\n`,
  );
  fakeSleep(10);
  // #21 is merged in the fake only: remove its retro so that it stays out of this second script run.
  rmSync(join(directories["2026-11-02-ARK-21-1"]!, "retro.md"));
  const second = runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });
  expect(second.code).toBe(0);
  expect(readFileSync(join(bin, "sleep.count"), "utf8").trim()).toBe("2");
  expect(mergeCalls()).toEqual([
    "pr merge https://github.com/org/app/pull/21 --merge",
    "pr merge https://github.com/org/app/pull/22 --merge",
  ]);
  expect(second.out).toContain("2026-11-02-ARK-22-1 #22 merged");
});

test("ARK-281-AC2 auto-merger skips superseded and done tickets, merges ready and missing ticket files", () => {
  const runs: MergerRun[] = [
    { name: "2026-11-02-ARK-31-1", pr: 31, retro: true, ticket: "superseded" },
    { name: "2026-11-02-ARK-32-1", pr: 32, retro: true, ticket: "done" },
    { name: "2026-11-02-ARK-33-1", pr: 33, retro: true, ticket: "ready" },
    { name: "2026-11-02-ARK-34-1", pr: 34, retro: true },
  ];
  const { workspace } = setUpMergerRuns(runs);

  const result = runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });

  expect(result.code).toBe(0);
  expect(mergeCalls().sort()).toEqual([
    "pr merge https://github.com/org/app/pull/33 --merge",
    "pr merge https://github.com/org/app/pull/34 --merge",
  ]);
  expect(result.err).toContain("HELD: 2026-11-02-ARK-31-1 #31 ticket superseded");
  expect(result.err).toContain("HELD: 2026-11-02-ARK-32-1 #32 ticket done");
  expect(result.err).not.toMatch(/HELD: \S+ #3[34]/);
});

test("ARK-281-AC3 auto-merger does not merge a run that is closed when ark status is read again", () => {
  const name = "2026-11-02-ARK-41-1";
  const { workspace } = setUpMergerRuns([{ name, pr: 41, retro: true, ticket: "ready" }]);
  // List call: merge_requests_open. Per-run call: closed. merge-request status stays real.
  executable(
    "ark",
    `case "$*" in
  *merge-request*) exec bun "${join(repositoryRoot, "cli", "ark.ts")}" "$@" ;;
  *${name}) echo "phase: closed" ;;
  *status*) echo "${name} merge_requests_open" ;;
esac
`,
  );
  fakeSleep(2);

  const result = runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });

  expect(readFileSync(join(bin, "sleep.count"), "utf8").trim()).toBe("2");
  expect(mergeCalls()).toEqual([]);
  expect(result.out).not.toContain("CHANGE:");
});

test("ARK-281-AC4 a held PR prints one HELD line over 3 passes, no CHANGE line, and the script keeps running", () => {
  const name = "2026-11-02-ARK-51-1";
  const { workspace } = setUpMergerRuns([{ name, pr: 51, retro: false }]);
  fakeSleep(3);

  const result = runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });

  // Only the fake sleep ends it: after the third pass, never by the script itself.
  expect(readFileSync(join(bin, "sleep.count"), "utf8").trim()).toBe("3");
  expect(result.err.split("\n").filter((line) => line.startsWith("HELD:"))).toEqual([
    `HELD: ${name} #51 no final report`,
  ]);
  expect(result.out).not.toContain("CHANGE:");
  expect(mergeCalls()).toEqual([]);
});

test("ARK-281-AC4 a PR held for a superseded ticket prints HELD with the reason once over 2 passes", () => {
  const name = "2026-11-02-ARK-52-1";
  const { workspace } = setUpMergerRuns([{ name, pr: 52, retro: true, ticket: "superseded" }]);
  fakeSleep(2);

  const result = runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });

  expect(result.err.split("\n").filter((line) => line.startsWith("HELD:"))).toEqual([
    `HELD: ${name} #52 ticket superseded`,
  ]);
  expect(result.out).not.toContain("CHANGE:");
});
