import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
