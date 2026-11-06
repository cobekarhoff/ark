import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const arkEntry = join(import.meta.dir, "..", "cli", "ark.ts");

describe("ark test-case new", () => {
  test("ARK-311-AC6 eight concurrent processes print eight different consecutive ids and write eight entries", async () => {
    // Eight `ark test-case new ARK` processes at once in one repo.
    const repo = tempGitRepo();
    // An existing entry sets the floor: the next id is one above the highest, not one above the count.
    mkdirSync(join(repo, "test", "cases"), { recursive: true });
    writeFileSync(join(repo, "test", "cases", "ARK-T3.md"), "existing\n");
    writeFileSync(join(repo, "test", "cases", "OTHER-T40.md"), "another key\n");

    const processes = Array.from({ length: 8 }, () =>
      Bun.spawn(["bun", arkEntry, "test-case", "new", "ARK"], {
        cwd: repo,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const outputs = await Promise.all(
      processes.map(async (child) => {
        const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        return { code, id: out.trim() };
      }),
    );

    expect(outputs.map((output) => output.code)).toEqual(Array(8).fill(0));
    expect(outputs.map((output) => output.id).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `ARK-T${i + 4}`).sort(),
    );
    const written = readdirSync(join(repo, "test", "cases")).filter((name) =>
      /^ARK-T\d+\.md$/.test(name),
    );
    expect(written.sort()).toEqual(
      ["ARK-T3.md", ...Array.from({ length: 8 }, (_, i) => `ARK-T${i + 4}.md`)].sort(),
    );
    const entry = readFileSync(join(repo, "test", "cases", "ARK-T4.md"), "utf8");
    expect(entry).toContain("id: ARK-T4\n");
    expect(entry).toContain("status: active\n");
    for (const section of [
      "Objective",
      "Preconditions",
      "Steps",
      "Expected results",
      "Screenshot checkpoints",
    ])
      expect(entry).toContain(`## ${section}`);
    // The lock lives in the git dir: git status shows only the new entries.
    const status = Bun.spawnSync(["git", "status", "--porcelain", "-uall"], { cwd: repo })
      .stdout.toString()
      .trim()
      .split("\n");
    expect(status.filter((line) => !line.startsWith("?? test/cases/"))).toEqual([]);
    expect(status.filter((line) => line.includes("lock"))).toEqual([]);
  });
});

describe("test case entry format", () => {
  const sections = [
    "Objective",
    "Preconditions",
    "Steps",
    "Expected results",
    "Screenshot checkpoints",
  ];
  const entryText = (front: Record<string, string | undefined>, omitSections: string[] = []) =>
    [
      "---",
      ...Object.entries(front)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${value}`),
      "---",
      "",
      ...sections
        .filter((s) => !omitSections.includes(s))
        .flatMap((s) => [`## ${s}`, "", "text", ""]),
    ].join("\n");
  const validFront = (id: string): Record<string, string | undefined> => ({
    id,
    title: `${id} the system keeps the format`,
    level: "integration",
    technique: "boundary values",
    priority: "high",
    risk: "a malformed entry slips in",
    status: "active",
    changed_by: "ARK-311",
  });

  let runId: string;
  let runDirectory: string;
  let workspace: string;

  /** A run of an old-scheme ticket whose valid plan passes `ark plan check`, over a workspace holding `files`. */
  function startRun(files: Record<string, string>, config: Record<string, unknown> = {}) {
    workspace = tempGitRepo({ "README.md": "# test\n", ...files });
    const projectDirectory = writeProject("demo", {
      workspace,
      ticket_source: "local",
      suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
      roles: {
        implementer: { harness: "claude", model: "claude-sonnet" },
        validator: { harness: "codex", model: "gpt-codex" },
        reviewer: { harness: "codex", model: "gpt-codex" },
      },
      ...config,
    });
    const started = ark(
      "run",
      "start",
      writeTicket("demo", "ARK-920", [{ id: "ARK-920-AC1", text: "first" }]),
    );
    if (started.code !== 0) return started;
    runId = readdirSync(join(projectDirectory, "runs"))[0];
    runDirectory = join(projectDirectory, "runs", runId);
    recordEvaluation(runDirectory);
    writeFileSync(
      join(runDirectory, "plan.yml"),
      JSON.stringify({
        design: { interfaces: [{ name: "fixture", callers: ["ark plan check"] }] },
        summary: {
          why: "Check the entries.",
          changes: [{ criterion: "ARK-920-AC1", where: "cli", now: "none", fix: "check" }],
        },
        steps: [
          {
            id: "build",
            role: "implementer",
            repo: ".",
            harness: "claude",
            model: "claude-sonnet",
            needs: [],
            criteria: ["ARK-920-AC1"],
          },
        ],
        test_cases: [
          {
            id: "proves-it",
            criterion: "ARK-920-AC1",
            level: "e2e",
            given: [],
            when: ["act"],
            // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
            then: ["ok"],
            expected: "ok",
          },
        ],
      }),
    );
    return started;
  }

  const problemsOfCheck = () => {
    const result = ark("plan", "check", runId);
    const checked = readFileSync(join(runDirectory, "events.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .findLast((event) => event.type === "plan.checked");
    return { code: result.code, problems: checked.data.problems.join("\n") as string };
  };

  beforeEach(() => {
    tempArkHome();
  });

  test("ARK-311-AC7 a valid entry passes ark plan check, and so does a workspace with no test/cases/ folder", () => {
    startRun({ "test/cases/ARK-T1.md": entryText(validFront("ARK-T1")) });
    expect(problemsOfCheck()).toEqual({ code: 0, problems: "" });
    tempArkHome();
    startRun({});
    expect(existsSync(join(workspace, "test", "cases"))).toBe(false);
    expect(problemsOfCheck()).toEqual({ code: 0, problems: "" });
  });

  const invalid: [string, string, string][] = [
    [
      "a missing field",
      entryText({ ...validFront("ARK-T1"), risk: undefined }),
      'test/cases/ARK-T1.md lacks the field "risk"',
    ],
    [
      "a missing section",
      entryText(validFront("ARK-T1"), ["Steps"]),
      'test/cases/ARK-T1.md lacks the section "Steps"',
    ],
    [
      "an unknown level",
      entryText({ ...validFront("ARK-T1"), level: "smoke" }),
      'test/cases/ARK-T1.md has level "smoke"',
    ],
    [
      "an unknown status",
      entryText({ ...validFront("ARK-T1"), status: "draft" }),
      'test/cases/ARK-T1.md has status "draft"',
    ],
    [
      "a retired entry with no reason",
      entryText({ ...validFront("ARK-T1"), status: "retired" }),
      'test/cases/ARK-T1.md lacks the field "retired_reason"',
    ],
    [
      "a title that does not start with its id",
      entryText({ ...validFront("ARK-T1"), title: "something else" }),
      "test/cases/ARK-T1.md has a title that does not start with its id ARK-T1",
    ],
    [
      "a file name that differs from its id",
      entryText(validFront("ARK-T2")),
      "test/cases/ARK-T1.md has the id ARK-T2: the file name must be ARK-T2.md",
    ],
  ];
  for (const [name, content, message] of invalid) {
    test(`ARK-311-AC7 ark plan check refuses ${name} and names the file`, () => {
      startRun({ "test/cases/ARK-T1.md": content });
      const result = problemsOfCheck();
      expect(result.code).toBe(1);
      expect(result.problems).toContain(message);
    });
  }

  test("ARK-311-AC7 ark test refuses a bad entry in the worktree before it runs a suite, and names the file", () => {
    startRun({ "test/cases/ARK-T1.md": entryText(validFront("ARK-T1")) });
    for (const args of [
      ["plan", "check", runId],
      ["gate", "record", runId, "plan", "approve"],
      ["worktree", "create", runId, "."],
    ])
      expect(ark(...args).code).toBe(0);
    expect(ark("test", runId).err).not.toContain("test case entry");

    writeFileSync(
      join(runDirectory, "workspace", "test", "cases", "ARK-T1.md"),
      entryText({ ...validFront("ARK-T1"), status: "draft" }),
    );
    const refused = ark("test", runId);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('test case entry test/cases/ARK-T1.md has status "draft"');
  });

  test("ARK-311-AC7 test_case_source accepts local and the default, and refuses any other value with a message that lists local", () => {
    expect(startRun({}, { test_case_source: "local" }).code).toBe(0);
    tempArkHome();
    expect(startRun({}).code).toBe(0);
    tempArkHome();
    const refused = startRun({}, { test_case_source: "zephyr" });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("test_case_source");
    expect(refused.err).toContain("zephyr");
    expect(refused.err).toContain("local");
  });
});

/** Runs git in `directory`, throws on failure, returns trimmed stdout. */
function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A repo whose origin is a bare repo and whose origin/HEAD names main. */
function repoWithOrigin(files: Record<string, string> = { "README.md": "# test\n" }): string {
  const repo = tempGitRepo(files);
  const bare = mkdtempSync(join(tmpdir(), "ark-case-origin-"));
  git(bare, "init", "--bare", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  return repo;
}

/** Commits `files` to main of the origin of `repo` through a throwaway clone, then fetches into `repo`. */
function advanceOrigin(repo: string, files: Record<string, string>): void {
  const clone = mkdtempSync(join(tmpdir(), "ark-case-clone-"));
  git(clone, "clone", "-q", git(repo, "remote", "get-url", "origin"), ".");
  git(clone, "config", "user.name", "Ark Test");
  git(clone, "config", "user.email", "ark@example.com");
  mkdirSync(join(clone, "test", "cases"), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(clone, name), content);
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "advance main");
  git(clone, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
}

function addWorktree(repo: string, branch: string): string {
  const path = mkdtempSync(join(tmpdir(), "ark-case-worktree-"));
  git(repo, "worktree", "add", "-q", "-b", branch, join(path, "tree"));
  return join(path, "tree");
}

async function newCaseIds(directory: string, count: number): Promise<string[]> {
  const children = Array.from({ length: count }, () =>
    Bun.spawn(["bun", arkEntry, "test-case", "new", "ARK"], {
      cwd: directory,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  return Promise.all(
    children.map(async (child) => {
      const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(code).toBe(0);
      return out.trim();
    }),
  );
}

describe("test case ids across worktrees (ARK-319)", () => {
  test("ARK-T16 parallel test-case new in two worktrees gives unique ids", async () => {
    const repo = repoWithOrigin();
    const first = addWorktree(repo, "run-a");
    const second = addWorktree(repo, "run-b");

    const parallel = (await Promise.all([newCaseIds(first, 4), newCaseIds(second, 4)])).flat();
    expect(parallel.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `ARK-T${i + 1}`).sort());

    // Neither worktree holds the other's entries, yet the counter makes each later call new.
    expect(await newCaseIds(first, 1)).toEqual(["ARK-T9"]);
    expect(await newCaseIds(second, 1)).toEqual(["ARK-T10"]);

    // A higher entry in the current worktree wins over the counter: one above it.
    mkdirSync(join(first, "test", "cases"), { recursive: true });
    writeFileSync(join(first, "test", "cases", "ARK-T20.md"), "local\n");
    expect(await newCaseIds(first, 1)).toEqual(["ARK-T21"]);

    // A higher entry at the fetched target head wins over the counter and both worktrees.
    advanceOrigin(repo, { "test/cases/ARK-T30.md": "target\n" });
    expect(await newCaseIds(second, 1)).toEqual(["ARK-T31"]);
  });

  test("ARK-T17 first call without counter reads the target branch", async () => {
    const repo = repoWithOrigin();
    // The worktree starts before main gains entries up to ARK-T12, so its own test/cases/ lacks them.
    const worktree = addWorktree(repo, "run-a");
    advanceOrigin(repo, {
      "test/cases/ARK-T3.md": "three\n",
      "test/cases/ARK-T12.md": "twelve\n",
      "test/cases/OTHER-T40.md": "another key\n",
    });

    expect(await newCaseIds(worktree, 1)).toEqual(["ARK-T13"]);
  });

  test("ARK-T18 worktree sync refuses an id the target already holds", () => {
    tempArkHome();
    const renamedBody = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
    const workspace = repoWithOrigin({
      "test/cases/ARK-T3.md": "three\n",
      "test/cases/ARK-T1.md": `${renamedBody}\n`,
    });
    const projectDirectory = writeProject("demo", {
      workspace,
      ticket_source: "local",
      suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
      roles: {
        implementer: { harness: "claude", model: "claude-sonnet" },
        validator: { harness: "codex", model: "gpt-codex" },
        reviewer: { harness: "codex", model: "gpt-codex" },
      },
    });
    const started = ark(
      "run",
      "start",
      writeTicket("demo", "ARK-920", [{ id: "ARK-920-AC1", text: "first" }]),
      "--project",
      "demo",
    );
    expect(started.code).toBe(0);
    const runId = started.out.trim();
    const runDirectory = join(projectDirectory, "runs", runId);
    recordEvaluation(runDirectory);
    const steps = [
      { id: "build", role: "implementer", repo: ".", needs: [], criteria: ["ARK-920-AC1"] },
    ];
    writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify({ steps }));
    appendEvent(runDirectory, "plan.checked", {
      valid: true,
      problems: [],
      plan_hash: planHash(runDirectory),
      steps,
    });
    expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    const worktree = join(runDirectory, "workspace", ".");

    // The run adds T5 by renaming T1 (git reports a rename, not an add), T6 (main will take both
    // with other content), T7 (main never takes it) and T8 (main takes it with the same content).
    git(worktree, "mv", "test/cases/ARK-T1.md", "test/cases/ARK-T5.md");
    writeFileSync(join(worktree, "test", "cases", "ARK-T5.md"), `${renamedBody}\nrun five\n`);
    for (const [id, content] of [
      ["ARK-T6", "run six\n"],
      ["ARK-T7", "run seven\n"],
      ["ARK-T8", "same eight\n"],
    ])
      writeFileSync(join(worktree, "test", "cases", `${id}.md`), content);
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "run cases");
    const before = git(worktree, "rev-parse", "HEAD");

    // Another run merged first: main took T5 and T6 with other content, T8 with the same content,
    // and changed T3, which the run did not touch.
    advanceOrigin(workspace, {
      "test/cases/ARK-T5.md": "main five\n",
      "test/cases/ARK-T6.md": "main six\n",
      "test/cases/ARK-T8.md": "same eight\n",
      "test/cases/ARK-T3.md": "three, edited on main\n",
    });

    const result = ark("worktree", "sync", runId);
    expect(result.code).toBe(1);
    expect(result.err).toContain("test case id taken on the target branch: ARK-T5");
    expect(result.err).toContain("test case id taken on the target branch: ARK-T6");
    for (const untouched of ["ARK-T3", "ARK-T7", "ARK-T8"])
      expect(result.err).not.toContain(`target branch: ${untouched}`);
    // Refused before the merge: nothing merged, nothing half-done.
    expect(git(worktree, "rev-parse", "HEAD")).toBe(before);
    expect(git(worktree, "status", "--porcelain")).toBe("");

    // The run drops its colliding ids: what remains is identical content (T8), an id the run
    // never touched (T3, edited on main) and an id main lacks (T7). Sync must merge it.
    git(worktree, "rm", "-q", "test/cases/ARK-T5.md", "test/cases/ARK-T6.md");
    git(worktree, "commit", "-q", "-m", "drop colliding cases");
    const allowed = ark("worktree", "sync", runId);
    expect(allowed.code).toBe(0);
    const cases = join(worktree, "test", "cases");
    expect(readFileSync(join(cases, "ARK-T3.md"), "utf8")).toBe("three, edited on main\n");
    expect(readFileSync(join(cases, "ARK-T5.md"), "utf8")).toBe("main five\n");
    expect(readFileSync(join(cases, "ARK-T7.md"), "utf8")).toBe("run seven\n");
    expect(git(worktree, "status", "--porcelain")).toBe("");
  });
});
