import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};
const markerTest = `import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
test("FAKE-1-AC1 suite finds the marker written by setup", () => { expect(existsSync("marker")).toBe(true); });
`;
const bunSuite = {
  name: "e2e",
  level: "e2e",
  repo: ".",
  command: "bun test --reporter=junit --reporter-outfile={report} ./marker.test.ts",
  parser: "bun",
};

function git(directory: string, ...args: string[]): string {
  return Bun.spawnSync(["git", "-C", directory, ...args])
    .stdout.toString()
    .trim();
}

/** A run with an approved plan, ready for `ark worktree create`. */
function approvedRun(config: Record<string, unknown>): {
  runId: string;
  runDirectory: string;
  workspace: string;
} {
  const arkHome = tempArkHome();
  const workspace = tempGitRepo({ "marker.test.ts": markerTest });
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [bunSuite],
    roles,
    ...config,
  });
  const ticket = writeTicket("demo", "FAKE-1", [{ id: "FAKE-1-AC1", text: "criterion" }]);
  const runId = ark("run", "start", ticket, "--project", "demo").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-1-\d+/,
  )![0];
  const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
  recordEvaluation(runDirectory);
  const plan = {
    design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
    summary: {
      why: "Check setup.",
      changes: [{ criterion: "FAKE-1-AC1", where: "tests", now: "none", fix: "setup runs" }],
    },
    steps: [
      {
        id: "build",
        role: "implementer",
        repo: ".",
        harness: "claude",
        model: "claude-sonnet",
        needs: [],
        criteria: ["FAKE-1-AC1"],
      },
    ],
    test_cases: [
      {
        id: "setup",
        criterion: "FAKE-1-AC1",
        level: "e2e",
        given: [],
        when: ["run it"],
        // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
        then: ["it works"],
        expected: "it works",
      },
    ],
  };
  writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify(plan));
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
  }
  return { runId, runDirectory, workspace };
}

describe("ARK-198 ark.yml setup", () => {
  test("ARK-198-AC1 a config without setup stays valid and an empty setup is refused by name", () => {
    const withoutSetup = approvedRun({});
    expect(ark("worktree", "create", withoutSetup.runId, ".").code).toBe(0);

    writeProject("demo", {
      workspace: tempGitRepo({ "marker.test.ts": markerTest }),
      ticket_source: "local",
      suites: [bunSuite],
      roles,
      setup: "",
    });
    const ticket = writeTicket("demo", "FAKE-2", [{ id: "FAKE-2-AC1", text: "criterion" }]);
    const refused = ark("run", "start", ticket, "--project", "demo");
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("setup");
  });

  test("ARK-198-AC2 setup runs through a shell in the new worktree and ark test then passes with no other step", () => {
    const { runId, runDirectory } = approvedRun({
      setup: "echo ready > marker && echo ok >> marker",
    });
    const created = ark("worktree", "create", runId, ".");
    expect(created.code).toBe(0);

    const worktree = join(runDirectory, "workspace");
    expect(readFileSync(join(worktree, "marker"), "utf8")).toBe("ready\nok\n");
    const tested = ark("test", runId);
    expect(tested.code, tested.out + tested.err).toBe(0);
    expect(tested.out).toContain("FAKE-1-AC1");
    expect(tested.out).not.toContain("failing");
  });

  test("ARK-198-AC3 a failing setup exits 1, names the repo and exit code, and leaves no worktree or branch", () => {
    const { runId, runDirectory, workspace } = approvedRun({
      setup: "echo install-broke >&2; exit 3",
    });
    const result = ark("worktree", "create", runId, ".");

    expect(result.code).toBe(1);
    expect(result.err).toContain('repo "."');
    expect(result.err).toContain("exited 3");
    expect(result.err).toContain("install-broke");
    expect(existsSync(join(runDirectory, "workspace"))).toBe(false);
    expect(git(workspace, "branch", "--list", "ark/*")).toBe("");
    expect(readFileSync(join(runDirectory, "events.ndjson"), "utf8")).not.toContain(
      "worktree.created",
    );
  });

  test("ARK-198-AC3 running again after a failure runs setup again and succeeds once the cause is fixed", () => {
    const { runId, runDirectory } = approvedRun({
      setup: 'test -f "$ARK_198_FIXED"',
    });
    expect(ark("worktree", "create", runId, ".").code).toBe(1);

    const flag = join(runDirectory, "fixed");
    writeFileSync(flag, "");
    process.env.ARK_198_FIXED = flag;
    try {
      const retried = ark("worktree", "create", runId, ".");
      expect(retried.code).toBe(0);
      expect(retried.out).toContain("setup    .");
    } finally {
      delete process.env.ARK_198_FIXED;
    }
    expect(existsSync(join(runDirectory, "workspace", ".git"))).toBe(true);
  });

  test("ARK-242-AC1 a setup that fails with empty stderr shows the end of its stdout", () => {
    const { runId } = approvedRun({ setup: "echo cause-on-stdout; exit 1" });
    const result = ark("worktree", "create", runId, ".");

    expect(result.code).toBe(1);
    expect(result.err).toContain("exited 1");
    expect(result.err).toContain("cause-on-stdout");
  });

  test("ARK-242-AC1 a setup that fails with only stdout output shows at most its last 10 lines", () => {
    const { runId } = approvedRun({ setup: "seq -f 'row%02g' 1 15; exit 1" });
    const result = ark("worktree", "create", runId, ".");

    expect(result.code).toBe(1);
    expect(result.err).toContain("row15");
    expect(result.err).toContain("row06");
    expect(result.err).not.toContain("row05");
  });

  test("ARK-242-AC2 when removing the failed worktree also fails, the output names the leftover worktree and branch", () => {
    const { runId, runDirectory, workspace } = approvedRun({
      setup: "git worktree lock . ; exit 1",
    });
    const result = ark("worktree", "create", runId, ".");

    expect(result.code).toBe(1);
    const branch = git(workspace, "branch", "--list", "ark/*", "--format=%(refname:short)");
    expect(branch).not.toBe("");
    expect(result.err).toContain(`left behind  worktree  ${join(runDirectory, "workspace")}`);
    expect(result.err).toContain(`left behind  branch    ${branch}`);
  });

  test("ARK-242-AC2 the next create after a failed cleanup removes the leftover, runs setup and records the worktree", () => {
    const { runId, runDirectory } = approvedRun({
      setup: 'test -f "$ARK_242_FIXED" || { git worktree lock . ; exit 1; }',
    });
    expect(ark("worktree", "create", runId, ".").code).toBe(1);

    const flag = join(runDirectory, "fixed");
    writeFileSync(flag, "");
    process.env.ARK_242_FIXED = flag;
    try {
      const retried = ark("worktree", "create", runId, ".");
      expect(retried.code, retried.err).toBe(0);
      expect(retried.out).toContain("setup    .");
    } finally {
      delete process.env.ARK_242_FIXED;
    }
    expect(readFileSync(join(runDirectory, "events.ndjson"), "utf8")).toContain("worktree.created");
  });
});
