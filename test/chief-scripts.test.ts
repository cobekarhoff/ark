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
  installFakeOrca();
});

/** Two repos (PR 11 CLEAN, PR 12 DIRTY) with retro.md, ticket.md id ARK-900 and a ready ticket file; one auto-merger pass. */
function runCleanPullRequestScenario() {
  const workspace = tempGitRepo();
  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true {report}", parser: "bun" }],
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

  return runScript("auto-merger.sh", [workspace, "1", "--once"], { ARK_PROJECT: "demo" });
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

test("ARK-T295 auto-merger --once merges the CLEAN PR only, reports the conflict and exits", () => {
  expectCleanPullRequestOnlyMerged(runCleanPullRequestScenario());
});

test("ARK-T295 auto-merger --once with retro.md and a ready ticket file merges the CLEAN PR only, reports the conflict and holds nothing", () => {
  const result = runCleanPullRequestScenario();
  expectCleanPullRequestOnlyMerged(result);
  expect(result.err).not.toContain("HELD:");
});

test("ARK-T190 temp-cleaner removes only ark-* directories older than 180 minutes with no owner file and prunes the worktree one held", () => {
  const workspace = tempGitRepo();
  const scratch = mkdtempSync(join(tmpdir(), "ark-scratch-tmp-"));
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const old = minutesAgo(200);
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
  const noOwnerThirtyMinutes = made("ark-thirty", minutesAgo(30));
  const newArk = made("ark-new");
  const oldOther = made("unrelated-old", old);

  const result = runScript("temp-cleaner.sh", [workspace, "1", "--once"], { TMPDIR: scratch });

  expect(result.code).toBe(0);
  expect(existsSync(oldArk)).toBe(false);
  expect(existsSync(noOwnerThirtyMinutes)).toBe(true);
  expect(existsSync(newArk)).toBe(true);
  expect(existsSync(oldOther)).toBe(true);
  expect(existsSync(oldWorktree)).toBe(false);
  const worktrees = Bun.spawnSync(["git", "-C", workspace, "worktree", "list", "--porcelain"]);
  expect(worktrees.stdout.toString()).not.toContain("ark-base-old");
});

// --- ARK-404: the cleaner keeps a folder whose owner file names a live process ---

/** A scratch TMPDIR for the cleaner, and a maker of folders with an owner file aged to `minutes`. */
function cleanerScratch() {
  const workspace = tempGitRepo();
  const scratch = mkdtempSync(join(tmpdir(), "ark-scratch-tmp-"));
  const age = (directory: string, minutes: number) => {
    const when = new Date(Date.now() - minutes * 60_000);
    utimesSync(directory, when, when);
  };
  // Writing the owner file changes the folder mtime, so the age is set last.
  const made = (name: string, minutes: number, owner?: string) => {
    const directory = join(scratch, name);
    mkdirSync(directory);
    if (owner !== undefined) writeFileSync(join(directory, "ark-owner.pid"), owner);
    age(directory, minutes);
    return directory;
  };
  const clean = () => runScript("temp-cleaner.sh", [workspace, "1", "--once"], { TMPDIR: scratch });
  return { scratch, age, made, clean };
}

/** A pid that was alive and has ended, so `kill -0` fails. */
async function endedPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

// One folder per temp root kind of ARK-T189, plus plannotator-data-*.
const rootKinds = [
  "ark-base-a",
  "ark-evidence-a",
  "ark-suite-a",
  "bun-test-a",
  "ark-home-a",
  "ark-repo-a",
  "plannotator-data-a",
];

test("ARK-T190 temp-cleaner keeps every folder with a live owner at any age and removes it after the owner ends", async () => {
  const { age, made, clean } = cleanerScratch();
  const owner = Bun.spawn(["sleep", "300"]);
  try {
    const live = rootKinds.map((name) => made(name, 60, `${owner.pid}\n`));
    const unrelated = made("unrelated-old", 1000);

    expect(clean().code).toBe(0);
    for (const directory of live) expect(existsSync(directory), directory).toBe(true);
    expect(existsSync(unrelated)).toBe(true);

    age(live[0]!, 1000);
    expect(clean().code).toBe(0);
    expect(existsSync(live[0]!)).toBe(true);

    owner.kill();
    await owner.exited;
    expect(clean().code).toBe(0);
    for (const directory of live) expect(existsSync(directory), directory).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  } finally {
    owner.kill();
  }
});

test("ARK-T190 temp-cleaner removes an ended-owner folder after 12 minutes and a no-owner folder after 180 minutes", async () => {
  const { made, clean } = cleanerScratch();
  const ended = `${await endedPid()}\n`;
  const endedYoung = made("ark-ended-11", 11, ended);
  const endedOld = made("ark-ended-13", 13, ended);
  const noOwnerYoung = made("ark-none-179", 179);
  const noOwnerYoungBun = made("bun-test-none-179", 179);
  const noOwnerOld = made("ark-none-181", 181);
  const noOwnerOldBun = made("bun-test-none-181", 181);

  expect(clean().code).toBe(0);
  expect(existsSync(endedYoung)).toBe(true);
  expect(existsSync(endedOld)).toBe(false);
  expect(existsSync(noOwnerYoung)).toBe(true);
  expect(existsSync(noOwnerYoungBun)).toBe(true);
  expect(existsSync(noOwnerOld)).toBe(false);
  expect(existsSync(noOwnerOldBun)).toBe(false);
});

test("ARK-T193 temp-cleaner treats an empty, non-numeric or unreadable owner file as no owner file and a pid of another user as alive", async () => {
  const { age, made, clean } = cleanerScratch();
  const owner = Bun.spawn(["sleep", "300"]);
  try {
    const invalid = {
      empty: made("ark-empty", 60, ""),
      text: made("ark-text", 60, "abc\n"),
      zero: made("ark-zero", 60, "0\n"),
      negative: made("ark-negative", 60, "-5\n"),
    } as Record<string, string>;
    // Pid 1 is alive and belongs to another user: kill -0 gives EPERM.
    const otherUser = made("ark-pid-one", 60, "1\n");
    const unreadable = made("ark-unreadable", 60, `${owner.pid}\n`);
    const unreadableFile = join(unreadable, "ark-owner.pid");
    chmodSync(unreadableFile, 0o000);
    let canReadIt = true;
    try {
      readFileSync(unreadableFile);
    } catch {
      canReadIt = false;
    }
    if (canReadIt) {
      // Running as root: the fixture is not valid, so it is skipped, not passed.
      console.warn("ARK-T193: unreadable owner file skipped, the suite can read mode 000 files");
      rmSync(unreadable, { recursive: true, force: true });
    } else invalid.unreadable = unreadable;

    expect(clean().code).toBe(0);
    for (const directory of [...Object.values(invalid), otherUser])
      expect(existsSync(directory), directory).toBe(true);

    for (const directory of Object.values(invalid)) age(directory, 200);
    expect(clean().code).toBe(0);
    for (const directory of Object.values(invalid))
      expect(existsSync(directory), directory).toBe(false);
    expect(existsSync(otherUser)).toBe(true);
  } finally {
    owner.kill();
  }
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
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true {report}", parser: "bun" }],
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

test("ARK-T295 auto-merger merges only the run with retro.md, and the other in a later pass once retro.md exists", () => {
  const { workspace, directories } = setUpMergerRuns([
    { name: "2026-11-02-ARK-21-1", pr: 21, retro: true },
    { name: "2026-11-02-ARK-22-1", pr: 22, retro: false },
  ]);

  // Pass 1 merges #21 and exits on that change; #22 has no pr merge call.
  const first = runScript("auto-merger.sh", [workspace, "1", "--once"], { ARK_PROJECT: "demo" });
  expect(first.code).toBe(0);
  expect(mergeCalls()).toEqual(["pr merge https://github.com/org/app/pull/21 --merge"]);
  expect(first.out).not.toContain("#22");

  // retro.md appears after 2 held passes: the PR merges in pass 3.
  writeFileSync(
    join(bin, "hook.sh"),
    `[ "$1" = 2 ] && echo "# Retro" > "${join(directories["2026-11-02-ARK-22-1"]!, "retro.md")}"\nexit 0\n`,
  );
  fakeSleep(3);
  // #21 is merged in the fake only: remove its retro so that it stays out of this second script run.
  rmSync(join(directories["2026-11-02-ARK-21-1"]!, "retro.md"));
  const second = runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });
  expect(readFileSync(join(bin, "sleep.count"), "utf8").trim()).toBe("3");
  expect(mergeCalls()).toEqual([
    "pr merge https://github.com/org/app/pull/21 --merge",
    "pr merge https://github.com/org/app/pull/22 --merge",
  ]);
  expect(second.out).toContain("2026-11-02-ARK-22-1 #22 merged");
});

test("ARK-T295 auto-merger --once skips superseded and done tickets, merges ready and missing ticket files", () => {
  const runs: MergerRun[] = [
    { name: "2026-11-02-ARK-31-1", pr: 31, retro: true, ticket: "superseded" },
    { name: "2026-11-02-ARK-32-1", pr: 32, retro: true, ticket: "done" },
    { name: "2026-11-02-ARK-33-1", pr: 33, retro: true, ticket: "ready" },
    { name: "2026-11-02-ARK-34-1", pr: 34, retro: true },
  ];
  const { workspace } = setUpMergerRuns(runs);

  const result = runScript("auto-merger.sh", [workspace, "1", "--once"], { ARK_PROJECT: "demo" });

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

// --- ARK-358: the loops send Orca messages. A fake orca, df and sleep stand in for the real ones. ---

const masterChiefRun = { id: "run_chief", objective: "Master Chief: demo tickets" };
const decoyRun = { id: "run_decoy", objective: "Master Chief: other tickets" };

/**
 * Fake orca in the bin folder. State files live next to it: `runs.ndjson` (run-list, one row per page: the page
 * size is 1, so the Run on row 2 needs the cursor), `workers-<run id>.json` and `workers-<run id>.after.json`
 * (worker-list: the `after` file answers from the second call on), `terminals.json`. `fail-send` makes `send`
 * exit 1 and leaves no record; `fail-close-<handle>` makes that terminal's close exit 1 (still recorded as an
 * attempt); a close removes the terminal from the list. Every other call is appended to orca.log: arguments
 * joined by \x1f, calls ended by \x1e.
 */
function installFakeOrca() {
  writeFileSync(
    join(bin, "runs.ndjson"),
    [decoyRun, masterChiefRun].map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  executable(
    "orca",
    `d=$(dirname "$0")
[ "$2" = send ] && [ -e "$d/fail-send" ] && { echo "orca is not answering" >&2; exit 1; }
printf '%s' "$(printf '%s\\037' "$@"; printf '\\036')" >> "$d/orca.log"
case "$1 $2" in
  "orchestration run-list")
    offset=0
    while [ $# -gt 0 ]; do [ "$1" = --cursor ] && offset=\${2#c}; shift; done
    total=$(wc -l < "$d/runs.ndjson")
    row=$(sed -n "$((offset + 1))p" "$d/runs.ndjson")
    if [ $((offset + 1)) -lt "$total" ]; then next="\\"c$((offset + 1))\\""; else next=null; fi
    printf '{"result":{"runs":[%s],"nextCursor":%s}}\\n' "$row" "$next" ;;
  "orchestration send") echo '{"ok":true}' ;;
  "orchestration worker-list")
    while [ $# -gt 0 ]; do [ "$1" = --run ] && run=$2; shift; done
    calls=$(($(cat "$d/worker-calls-$run" 2>/dev/null || echo 0) + 1)); echo $calls > "$d/worker-calls-$run"
    file="$d/workers-$run.json"
    [ -e "$file" ] || { echo '{"result":{"workers":[],"nextCursor":null}}'; exit 0; }
    [ $calls -gt 1 ] && [ -e "$d/workers-$run.after.json" ] && file="$d/workers-$run.after.json"
    cat "$file" ;;
  "terminal list") cat "$d/terminals.json" ;;
  "terminal close")
    while [ $# -gt 0 ]; do [ "$1" = --terminal ] && handle=$2; shift; done
    [ -e "$d/fail-close-$handle" ] && { echo "close refused" >&2; exit 1; }
    jq -c --arg handle "$handle" '.result.terminals |= map(select(.handle != $handle))' "$d/terminals.json" > "$d/terminals.tmp" &&
      mv "$d/terminals.tmp" "$d/terminals.json"
    echo '{"ok":true}' ;;
  *) exit 2 ;;
esac
`,
  );
}

const orcaCalls = (): string[][] =>
  existsSync(join(bin, "orca.log"))
    ? readFileSync(join(bin, "orca.log"), "utf8")
        .split("\x1e")
        .filter(Boolean)
        .map((call) => call.split("\x1f").slice(0, -1))
    : [];
const orcaSends = () =>
  orcaCalls().filter((call) => call[0] === "orchestration" && call[1] === "send");
const flagValue = (call: string[], flag: string) => call[call.indexOf(flag) + 1];
const orcaCloses = () =>
  orcaCalls()
    .filter((call) => call[0] === "terminal" && call[1] === "close")
    .map((call) => flagValue(call, "--terminal"));

/** Starts a new launchd-style process: the pass counter restarts, the state folder stays. */
function resetPasses(stopAfter: number) {
  rmSync(join(bin, "sleep.count"), { force: true });
  fakeSleep(stopAfter);
}

test("ARK-T295 auto-merger sends one 'Merged: <run> !<number>' to the Master Chief Run on page 2, keeps looping, and repeats nothing after a restart", () => {
  const first = "2026-11-02-ARK-61-1";
  const second = "2026-11-02-ARK-62-1";
  const { workspace, directories } = setUpMergerRuns([
    { name: first, pr: 61, retro: true },
    { name: second, pr: 62, retro: false },
  ]);

  // 1-3. Three passes: alive after the merge (only the fake sleep ends it), one send, to the right Run.
  fakeSleep(3);
  runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });
  expect(readFileSync(join(bin, "sleep.count"), "utf8").trim()).toBe("3");
  expect(mergeCalls()).toEqual(["pr merge https://github.com/org/app/pull/61 --merge"]);
  expect(orcaSends()).toHaveLength(1);
  const [message] = orcaSends();
  expect(flagValue(message!, "--to")).toBe("run:run_chief");
  expect(flagValue(message!, "--type")).toBe("status");
  expect(flagValue(message!, "--subject")).toBe(`Merged: ${first} !61`);

  // 4. A launchd restart with the same state and the same merged run: nothing new.
  resetPasses(2);
  runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });
  expect(mergeCalls()).toHaveLength(1);
  expect(orcaSends()).toHaveLength(1);

  // 5. The second MR becomes mergeable: one more send with its number.
  writeFileSync(join(directories[second]!, "retro.md"), "# Retro\n");
  resetPasses(2);
  runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });
  expect(orcaSends().map((call) => flagValue(call, "--subject"))).toEqual([
    `Merged: ${first} !61`,
    `Merged: ${second} !62`,
  ]);
});

test("ARK-T295 auto-merger logs the notice and keeps merging when there is no Master Chief Run, and sends it once orca answers", () => {
  const name = "2026-11-02-ARK-63-1";
  const { workspace } = setUpMergerRuns([{ name, pr: 63, retro: true }]);
  writeFileSync(join(bin, "runs.ndjson"), `${JSON.stringify(decoyRun)}\n`);
  fakeSleep(2);

  const result = runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });

  expect(readFileSync(join(bin, "sleep.count"), "utf8").trim()).toBe("2");
  expect(mergeCalls()).toHaveLength(1);
  expect(orcaSends()).toEqual([]);
  expect(result.err).toContain(
    `no Orca Run "Master Chief: demo tickets", not sent: Merged: ${name} !63`,
  );

  // orca is not answering: the message stays pending and goes out on a later pass.
  const retry = "2026-11-02-ARK-64-1";
  const second = setUpMergerRuns([{ name: retry, pr: 64, retro: true }]);
  writeFileSync(
    join(bin, "runs.ndjson"),
    [decoyRun, masterChiefRun].map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  writeFileSync(join(bin, "fail-send"), "");
  resetPasses(1);
  const failed = runScript("auto-merger.sh", [second.workspace, "1"], { ARK_PROJECT: "demo" });
  expect(failed.err).toContain("orca send failed, will retry");
  expect(orcaSends()).toEqual([]);
  rmSync(join(bin, "fail-send"));
  resetPasses(1);
  runScript("auto-merger.sh", [second.workspace, "1"], { ARK_PROJECT: "demo" });
  expect(orcaSends().map((call) => flagValue(call, "--subject"))).toEqual([`Merged: ${retry} !64`]);
});

test("ARK-T295 auto-merger prints a conflict and a failed merge once over four passes and sends neither", () => {
  const { workspace } = setUpMergerRuns([
    { name: "2026-11-02-ARK-71-1", pr: 71, retro: true },
    { name: "2026-11-02-ARK-72-1", pr: 72, retro: true },
  ]);
  // PR 71 is CLEAN but refuses to merge; PR 72 is DIRTY.
  executable(
    "gh",
    `echo "$*" >> "${ghLog}"
case "$*" in
  "pr merge"*) exit 1 ;;
  *mergeStateStatus*) case "$3" in */72) echo DIRTY ;; *) echo CLEAN ;; esac ;;
  *) echo '{"state":"OPEN","statusCheckRollup":[]}' ;;
esac
`,
  );
  fakeSleep(4);

  const result = runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });

  expect(readFileSync(join(bin, "sleep.count"), "utf8").trim()).toBe("4");
  expect(result.out.match(/#71 merge failed/g)).toHaveLength(1);
  expect(result.out.match(/#72 conflicting/g)).toHaveLength(1);
  expect(orcaSends()).toEqual([]);
});

// --- ARK-T296: the cleaner's disk message ---

/** Free GB of `df -k /` for each pass of one cleaner process; the last value repeats. The limit is the script's own 15. */
function cleanerPasses(freeGigabytes: number[]) {
  const scratch = mkdtempSync(join(tmpdir(), "ark-scratch-tmp-"));
  writeFileSync(join(bin, "df.values"), freeGigabytes.join("\n") + "\n");
  rmSync(join(bin, "df.count"), { force: true });
  executable(
    "df",
    `count=$(($(cat "${join(bin, "df.count")}" 2>/dev/null || echo 0) + 1))
echo $count > "${join(bin, "df.count")}"
total=$(wc -l < "${join(bin, "df.values")}")
[ $count -gt $total ] && count=$total
gigabytes=$(sed -n "$count"p "${join(bin, "df.values")}")
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "/dev/fake 1 1 $((gigabytes * 1048576)) 1% /"
`,
  );
  resetPasses(freeGigabytes.length);
  const result = runScript("temp-cleaner.sh", [cleanerWorkspace, "1"], {
    TMPDIR: scratch,
    ARK_PROJECT: "demo",
  });
  expect(readFileSync(join(bin, "sleep.count"), "utf8").trim()).toBe(`${freeGigabytes.length}`);
  return result;
}
let cleanerWorkspace = "";
const diskSubjects = () => orcaSends().map((call) => flagValue(call, "--subject"));

test("ARK-T296 temp-cleaner sends one 'Disk low: <n> GB free' per drop below the limit and again only after free disk rose above it", () => {
  cleanerWorkspace = tempGitRepo();

  // 1-4. Above, drop (three passes low), above, drop: two sends in one process that never exits.
  const first = cleanerPasses([20, 20, 14, 14, 14, 16, 16, 12, 12, 12]);
  expect(first.out.match(/LOW DISK/g)).toHaveLength(2);
  expect(diskSubjects()).toEqual(["Disk low: 14 GB free", "Disk low: 12 GB free"]);
  expect(flagValue(orcaSends()[0]!, "--to")).toBe("run:run_chief");
  expect(flagValue(orcaSends()[0]!, "--type")).toBe("status");

  // 5. A restart while still low: the state survives it.
  cleanerPasses([12, 12]);
  expect(diskSubjects()).toHaveLength(2);

  // 6-7. Exactly the limit is not below it and does not count as recovery.
  cleanerPasses([15, 15]);
  cleanerPasses([14, 14, 14]);
  expect(diskSubjects()).toHaveLength(2);

  // 8-9. Above the limit resets; the next drop is the third send.
  cleanerPasses([16, 16]);
  expect(diskSubjects()).toHaveLength(2);
  cleanerPasses([13, 13, 13]);
  expect(diskSubjects()).toEqual([
    "Disk low: 14 GB free",
    "Disk low: 12 GB free",
    "Disk low: 13 GB free",
  ]);
});

test("ARK-T296 temp-cleaner keeps sweeping and sends the disk message on the next pass when orca is not answering", () => {
  cleanerWorkspace = tempGitRepo();
  writeFileSync(join(bin, "fail-send"), "");

  const failed = cleanerPasses([10, 10]);
  expect(failed.err.match(/orca send failed, will retry/g)).toHaveLength(2);
  expect(orcaSends()).toEqual([]);

  rmSync(join(bin, "fail-send"));
  cleanerPasses([10, 10]);
  expect(diskSubjects()).toEqual(["Disk low: 10 GB free"]);
});

// --- ARK-T299: the sweep ---

test("ARK-T299 sweep closes only the terminals of settled dispatches that still run, lists terminals idle over a day, and never touches a live dispatch or Master Chief", () => {
  const runName = "2026-11-02-ARK-900-1";
  const runsRoot = join(process.env.ARK_HOME!, "projects", "demo", "runs");
  mkdirSync(join(runsRoot, runName), { recursive: true });
  const workspace = tempGitRepo();
  const row = (dispatchId: string, state: string, terminalState: string) => ({
    dispatchId,
    state,
    terminalState,
    terminal: `term_${dispatchId}`,
  });
  const writeWorkers = (name: string, workers: unknown[]) =>
    writeFileSync(join(bin, name), JSON.stringify({ result: { workers, nextCursor: null } }));
  const rows = [
    row("released", "succeeded", "released"),
    row("closed", "failed", "active"),
    row("live", "running", "active"),
    row("retained", "succeeded", "retained"),
    row("gone", "succeeded", "released"),
  ];
  writeFileSync(
    join(bin, "runs.ndjson"),
    [
      decoyRun,
      masterChiefRun,
      { id: "run_ark", objective: `Ark run ${runName}` },
      { id: "run_other", objective: "Ark run 2026-11-02-ARK-5-1" },
    ]
      .map((run) => `${JSON.stringify(run)}\n`)
      .join(""),
  );
  writeWorkers("workers-run_ark.json", rows);
  // A settled, connected dispatch of project `other`: its run folder is not under this project.
  writeWorkers("workers-run_other.json", [row("other", "succeeded", "released")]);
  writeWorkers("workers-run_chief.json", [row("lead", "running", "active")]);
  const hour = 3_600_000;
  const terminal = (handle: string, worktreePath: string, idleHours = 0) => ({
    handle,
    worktreePath,
    connected: true,
    title: handle,
    lastOutputAt: Date.now() - idleHours * hour,
  });
  const inRun = join(runsRoot, runName, "workspace");
  const writeTerminals = () =>
    writeFileSync(
      join(bin, "terminals.json"),
      JSON.stringify({
        result: {
          terminals: [
            ...["released", "closed", "live", "retained"].map((id) =>
              terminal(`term_${id}`, inRun),
            ),
            terminal(
              "term_other",
              join(process.env.ARK_HOME!, "projects", "other", "runs", "x", "workspace"),
            ),
            terminal("term_chief", workspace),
            terminal("term_lead", inRun),
            terminal("term_idle25", inRun, 25),
            terminal("term_idle23", inRun, 23),
          ],
        },
      }),
    );
  const sweep = () => runScript("sweep.sh", [workspace, "1", "--once"], { ARK_PROJECT: "demo" });
  writeTerminals();

  // 1-2. Only the first two are closed; one message names them and the 25 h terminal.
  const first = sweep();
  expect(first.code).toBe(0);
  expect(orcaCloses()).toEqual(["term_released", "term_closed"]);
  expect(orcaSends()).toHaveLength(1);
  expect(flagValue(orcaSends()[0]!, "--to")).toBe("run:run_chief");
  expect(flagValue(orcaSends()[0]!, "--type")).toBe("status");
  expect(flagValue(orcaSends()[0]!, "--subject")).toBe("Sweep: closed 2, idle 1");
  const body = flagValue(orcaSends()[0]!, "--body");
  expect(body).toContain("closed term_released (released)");
  expect(body).toContain("closed term_closed (closed)");
  expect(body).toContain("term_idle25");
  expect(body).not.toContain("term_idle23");
  // The idle terminal is listed, never closed.
  expect(orcaCloses()).not.toContain("term_idle25");

  // 4. Again, the closed terminals are gone: no close, no repeated message.
  sweep();
  expect(orcaCloses()).toEqual(["term_released", "term_closed"]);
  expect(orcaSends()).toHaveLength(1);
});

test("ARK-T299 sweep does not close a dispatch that restarted before the close, and logs a failed close and goes on", () => {
  const runName = "2026-11-02-ARK-900-1";
  const runsRoot = join(process.env.ARK_HOME!, "projects", "demo", "runs");
  mkdirSync(join(runsRoot, runName), { recursive: true });
  const workspace = tempGitRepo();
  const inRun = join(runsRoot, runName, "workspace");
  const row = (dispatchId: string, state: string) => ({
    dispatchId,
    state,
    terminalState: "active",
    terminal: `term_${dispatchId}`,
  });
  const writeWorkers = (name: string, workers: unknown[]) =>
    writeFileSync(join(bin, name), JSON.stringify({ result: { workers, nextCursor: null } }));
  writeFileSync(
    join(bin, "runs.ndjson"),
    [masterChiefRun, { id: "run_ark", objective: `Ark run ${runName}` }]
      .map((run) => `${JSON.stringify(run)}\n`)
      .join(""),
  );
  writeFileSync(
    join(bin, "terminals.json"),
    JSON.stringify({
      result: {
        terminals: ["first", "second"].map((id) => ({
          handle: `term_${id}`,
          worktreePath: inRun,
          connected: true,
          title: id,
          lastOutputAt: Date.now(),
        })),
      },
    }),
  );
  const sweep = () => runScript("sweep.sh", [workspace, "1", "--once"], { ARK_PROJECT: "demo" });

  // The second dispatch restarts between the first list and the fresh one that precedes its close.
  writeWorkers("workers-run_ark.json", [row("first", "succeeded"), row("second", "succeeded")]);
  writeWorkers("workers-run_ark.after.json", [row("first", "succeeded"), row("second", "running")]);
  sweep();
  expect(orcaCloses()).toEqual(["term_first"]);

  // A close that fails is logged and the next terminal is still closed.
  rmSync(join(bin, "orca.log"));
  rmSync(join(bin, "workers-run_ark.after.json"));
  rmSync(join(bin, "worker-calls-run_ark"));
  writeWorkers("workers-run_ark.json", [row("first", "succeeded"), row("second", "succeeded")]);
  writeFileSync(
    join(bin, "terminals.json"),
    JSON.stringify({
      result: {
        terminals: ["first", "second"].map((id) => ({
          handle: `term_${id}`,
          worktreePath: inRun,
          connected: true,
          title: id,
          lastOutputAt: Date.now(),
        })),
      },
    }),
  );
  writeFileSync(join(bin, "fail-close-term_first"), "");
  const failed = sweep();
  expect(failed.code).toBe(0);
  expect(failed.err).toContain("closing term_first (first) failed");
  // Both were tried; only the second left the terminal list.
  expect(orcaCloses()).toEqual(["term_first", "term_second"]);
  expect(
    JSON.parse(readFileSync(join(bin, "terminals.json"), "utf8")).result.terminals.map(
      (entry: { handle: string }) => entry.handle,
    ),
  ).toEqual(["term_first"]);
});

test("ARK-T299 sweep does not close a terminal that a live dispatch of another Run reuses, and lists an idle terminal in the project workspace", () => {
  const runName = "2026-11-02-ARK-900-1";
  const runsRoot = join(process.env.ARK_HOME!, "projects", "demo", "runs");
  mkdirSync(join(runsRoot, runName), { recursive: true });
  const workspace = tempGitRepo();
  const writeWorkers = (name: string, workers: unknown[]) =>
    writeFileSync(join(bin, name), JSON.stringify({ result: { workers, nextCursor: null } }));
  writeFileSync(
    join(bin, "runs.ndjson"),
    [masterChiefRun, { id: "run_ark", objective: `Ark run ${runName}` }, decoyRun]
      .map((run) => `${JSON.stringify(run)}\n`)
      .join(""),
  );
  const settled = {
    dispatchId: "old",
    state: "succeeded",
    terminalState: "released",
    terminal: "term_shared",
  };
  writeWorkers("workers-run_ark.json", [settled]);
  writeWorkers(`workers-${decoyRun.id}.json`, [
    { dispatchId: "new", state: "running", terminalState: "active", terminal: "term_shared" },
  ]);
  const terminal = (handle: string, worktreePath: string, idleHours: number) => ({
    handle,
    worktreePath,
    connected: true,
    title: handle,
    lastOutputAt: Date.now() - idleHours * 3_600_000,
  });
  writeFileSync(
    join(bin, "terminals.json"),
    JSON.stringify({
      result: {
        terminals: [
          terminal("term_shared", join(runsRoot, runName, "workspace"), 0),
          terminal("term_ws_idle", workspace, 25),
          terminal("term_ws_sibling", `${workspace}-other`, 25),
        ],
      },
    }),
  );

  const result = runScript("sweep.sh", [workspace, "1", "--once"], { ARK_PROJECT: "demo" });

  expect(result.code).toBe(0);
  expect(orcaCloses()).toEqual([]);
  expect(result.err).toContain("term_shared is used by a live dispatch");
  expect(orcaSends()).toHaveLength(1);
  const body = flagValue(orcaSends()[0]!, "--body");
  expect(body).toContain("term_ws_idle");
  expect(body).not.toContain("term_ws_sibling");
});
