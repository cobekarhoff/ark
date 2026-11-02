import { beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempArkHome, tempGitRepo, writeProject } from "./helpers";

const repositoryRoot = join(import.meta.dir, "..");
const run = "2026-11-02-ARK-900-1";

let bin = "";
let ghLog = "";
let notificationLog = "";

function executable(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
  chmodSync(join(bin, name), 0o755);
}

/** Runs a script with the fakes first on PATH. A scratch TMPDIR keeps the real one out of reach. */
function runScript(script: string, args: string[], environment: Record<string, string> = {}) {
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
  // Fake gh: PR 11 is CLEAN, every other PR is DIRTY. `pr view <url> --json state,...` is the open check.
  executable(
    "gh",
    `echo "$*" >> "${ghLog}"
case "$*" in
  "pr merge"*) exit 0 ;;
  *mergeStateStatus*) case "$3" in */11) true ;; *) false ;; esac && echo CLEAN || echo DIRTY ;;
  *) echo '{"state":"OPEN","statusCheckRollup":[]}' ;;
esac
`,
  );
  // No notification may fire on the human's desktop.
  executable("osascript", `echo "$*" >> "${notificationLog}"\n`);
  executable("ark", `exec bun "${join(repositoryRoot, "cli", "ark.ts")}" "$@"\n`);
});

test("ARK-244-AC3 auto-merger merges the CLEAN PR only, reports the conflict and exits", () => {
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
  // Written directly: appendEvent would refuse these events without the whole earlier flow.
  writeFileSync(
    join(runDirectory, "events.ndjson"),
    events
      .map((event, i) => JSON.stringify({ seq: i + 1, time: "2026-11-02T00:00:00.000Z", ...event }))
      .join("\n") + "\n",
  );

  const result = runScript("auto-merger.sh", [workspace, "1"], { ARK_PROJECT: "demo" });

  expect(result.code).toBe(0);
  const calls = readFileSync(ghLog, "utf8").split("\n");
  expect(calls).toContain("pr merge https://github.com/org/app/pull/11 --merge");
  expect(calls.filter((call) => call.startsWith("pr merge"))).toEqual([
    "pr merge https://github.com/org/app/pull/11 --merge",
  ]);
  const change = result.out.split("\n").find((line) => line.startsWith("CHANGE:"));
  expect(change).toBeDefined();
  expect(change).toContain(`${run} #11 merged`);
  expect(change).toContain(`${run} #12 conflicting`);
});

test("ARK-244-AC3 temp-cleaner removes only old ark-* directories", () => {
  const workspace = tempGitRepo();
  const scratch = mkdtempSync(join(tmpdir(), "ark-scratch-tmp-"));
  const old = new Date(Date.now() - 30 * 60_000);
  const made = (name: string, when?: Date) => {
    const directory = join(scratch, name);
    mkdirSync(directory);
    if (when) utimesSync(directory, when, when);
    return directory;
  };
  const oldArk = made("ark-old", old);
  const newArk = made("ark-new");
  const oldOther = made("unrelated-old", old);

  const result = runScript("temp-cleaner.sh", [workspace, "1", "--once"], { TMPDIR: scratch });

  expect(result.code).toBe(0);
  expect(existsSync(oldArk)).toBe(false);
  expect(existsSync(newArk)).toBe(true);
  expect(existsSync(oldOther)).toBe(true);
});
