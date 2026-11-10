import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

setDefaultTimeout(60_000);

const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};
const header = `import { describe, test } from "bun:test";`;
const source = (...lines: string[]) => `${header}\n${lines.join("\n")}\n`;

type Row = {
  file: string;
  line: number;
  title: string;
  kind: string;
  id: string | null;
  acs: string[];
  durationMs: number | null;
  rows: number | null;
  modifier: string | null;
};

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commitAll(directory: string, files: Record<string, string | null>): string {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) git(directory, "rm", "-q", name);
    else {
      mkdirSync(dirname(join(directory, name)), { recursive: true });
      writeFileSync(join(directory, name), content);
    }
  }
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "change");
  return git(directory, "rev-parse", "HEAD");
}

/** A project `fx` whose workspace is a git repo with `files`, one bun suite on `test/*.test.ts`. */
function fixture(files: Record<string, string>, extraSuites: Record<string, unknown>[] = []) {
  const arkHome = tempArkHome();
  const workspace = tempGitRepo(files);
  writeProject("fx", {
    workspace,
    ticket_source: "local",
    suites: [
      {
        name: "unit",
        level: "unit",
        repo: ".",
        command: "true",
        parser: "bun",
        base_files: "test/*.test.ts",
        base_command: "true {files}",
      },
      ...extraSuites,
    ],
    roles,
  });
  return { arkHome, workspace };
}

function inventoryRows(...flags: string[]): Row[] {
  const result = ark("test-audit", "inventory", "--project", "fx", "--json", ...flags);
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out);
}

/** Every file of a tree with its size, mtime and content, sorted. */
function snapshot(directory: string): string[] {
  return (readdirSync(directory, { recursive: true, withFileTypes: true }) as any[])
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      const stat = statSync(path);
      return `${path} ${stat.size} ${stat.mtimeMs} ${readFileSync(path, "utf8")}`;
    })
    .sort();
}

function writeReport(arkHome: string, run: string, tests: [string, string, number][], at: number) {
  const file = join(arkHome, "projects", "fx", "runs", run, "results", "unit.report");
  mkdirSync(dirname(file), { recursive: true });
  const cases = tests
    .map(([path, name, time]) => `<testcase name="${name}" file="${path}" time="${time}"/>`)
    .join("");
  writeFileSync(file, `<testsuites><testsuite>${cases}</testsuite></testsuites>`);
  utimesSync(file, at, at);
}

const unitFile = source(
  `test("ARK-T1 case title", () => {});`,
  `test("ARK-9-AC2 old title", () => {});`,
  `test("plain title", () => {});`,
  `describe("ARK-T5 group", () => {`,
  `  test("child", () => {});`,
  `});`,
  `test("holds syntax", () => { const text = 'test("ARK-8-AC1 fake", () => {})'; });`,
  `test("ARK-T77 no case file", () => {});`,
  `test("in no report", () => {});`,
);
const unitPath = "test/a.test.ts";

/** The fixture of ARK-T203 and ARK-T204: ARK-T1 is verified by three criteria of two tickets, in the ticket store. */
function auditedFixture() {
  const built = fixture(
    { [unitPath]: unitFile, "test/pw/x.pw.ts": source(`test("ARK-T1 browser", () => {});`) },
    [
      {
        name: "overlap",
        level: "unit",
        repo: ".",
        command: "true",
        parser: "bun",
        base_files: "test/a.test.ts",
        base_command: "true {files}",
      },
      {
        name: "pw",
        level: "e2e",
        repo: ".",
        command: "true",
        parser: "pytest",
      },
    ],
  );
  writeTicket("fx", "ARK-900", [
    { id: "ARK-900/AC1", text: "one", verified_by: ["ARK-T1"] },
    { id: "ARK-900/AC2", text: "two", verified_by: ["ARK-T1"] },
  ]);
  writeTicket("fx", "ARK-901", [{ id: "ARK-901/AC1", text: "three", verified_by: ["ARK-T1"] }]);
  mkdirSync(join(built.workspace, "test/cases"), { recursive: true });
  writeFileSync(
    join(built.workspace, "test/cases/ARK-T1.md"),
    "---\nid: ARK-T1\ntitle: ARK-T1 fixture\nlevel: integration\n---\n",
  );
  return built;
}

const titles = (rows: Row[]) => rows.map((row) => row.title);

describe("ark test-audit inventory", () => {
  test("ARK-T203 ark test-audit inventory prints one row for each declaration with its file, line, title, id kind, the ACs of the case and the last duration", () => {
    const { arkHome } = auditedFixture();
    const key = "ARK-T1 case title";
    writeReport(arkHome, "r-old", [[unitPath, key, 9.9]], 1_000_000);
    writeReport(arkHome, "r-new", [[unitPath, key, 2.5]], 2_000_000);

    const rows = inventoryRows();
    const lineOf = (title: string) =>
      unitFile.split("\n").findIndex((line) => line.includes(`("${title}"`)) + 1;
    const byTitle = new Map(rows.map((row) => [row.title, row]));

    // every real declaration once: the string that holds test syntax and the second suite add nothing
    expect(rows.every((row) => row.file === unitPath)).toBe(true);
    expect(rows.map((row) => row.line)).toEqual(
      rows.map((row) => row.line).toSorted((a, b) => a - b),
    );
    expect(titles(rows).filter((title) => title === "holds syntax")).toHaveLength(1);
    expect(titles(rows).some((title) => title.includes("fake"))).toBe(false);
    for (const title of [
      key,
      "ARK-9-AC2 old title",
      "plain title",
      "child",
      "ARK-T77 no case file",
    ])
      expect(byTitle.get(title)?.line, title).toBe(lineOf(title));

    const caseRow = byTitle.get(key)!;
    expect([caseRow.kind, caseRow.id]).toEqual(["case", "ARK-T1"]);
    expect(caseRow.acs).toEqual(["ARK-900/AC1", "ARK-900/AC2", "ARK-901/AC1"]);
    expect(caseRow.durationMs).toBe(2500);

    const old = byTitle.get("ARK-9-AC2 old title")!;
    expect([old.kind, old.id, old.acs]).toEqual(["old", "ARK-9-AC2", []]);
    expect(byTitle.get("plain title")!.kind).toBe("none");
    const noFile = byTitle.get("ARK-T77 no case file")!;
    expect([noFile.kind, noFile.id, noFile.acs]).toEqual(["case", "ARK-T77", []]);
    expect([byTitle.get("child")!.kind, byTitle.get("child")!.id]).toEqual(["case", "ARK-T5"]);
    expect(byTitle.get("in no report")!.durationMs).toBeNull();
    expect(rows.filter((row) => row.durationMs !== null)).toHaveLength(1);

    // the table output names the same declarations
    const table = ark("test-audit", "inventory", "--project", "fx");
    expect(table.code).toBe(0);
    expect(table.out).toContain(
      `${unitPath}\t${caseRow.line}\t${key}\tcase\tARK-T1\tARK-900/AC1,ARK-900/AC2,ARK-901/AC1\t2.5s`,
    );
    expect(table.out).toContain("plain title\tnone\t-\t-\t-");
  });

  test("ARK-T203 a project with no report file prints every row and no duration", () => {
    fixture({ [unitPath]: unitFile });
    const rows = inventoryRows();
    expect(titles(rows)).toContain("plain title");
    expect(rows.every((row) => row.durationMs === null)).toBe(true);
  });

  test("ARK-T204 --json prints the inventory rows as JSON and --summary prints the counts by file and by id kind and the total test lines", () => {
    const { arkHome } = auditedFixture();
    writeReport(arkHome, "r1", [[unitPath, "ARK-T1 case title", 1.25]], 1_000_000);
    const rows = inventoryRows();
    const table = ark("test-audit", "inventory", "--project", "fx");
    const summary = ark("test-audit", "inventory", "--project", "fx", "--summary");
    expect([table.code, summary.code]).toEqual([0, 0]);

    // the table has the same rows, in the same order, with the same ids, ACs and durations
    const cells = table.out
      .trim()
      .split("\n")
      .slice(1, 1 + rows.length)
      .map((line) => line.split("\t"));
    expect(cells.map((cell) => cell.slice(0, 2))).toEqual(
      rows.map((row) => [row.file, String(row.line)]),
    );
    expect(cells.map((cell) => cell.slice(3))).toEqual(
      rows.map((row) => [
        row.kind,
        row.id ?? "-",
        row.acs.join(",") || "-",
        row.durationMs === null ? "-" : `${(row.durationMs / 1000).toFixed(1)}s`,
      ]),
    );
    expect(rows.find((row) => row.title === "ARK-T1 case title")!.acs).toEqual([
      "ARK-900/AC1",
      "ARK-900/AC2",
      "ARK-901/AC1",
    ]);
    expect(rows.find((row) => row.title === "plain title")!.durationMs).toBeNull();

    // the summary counts are the counts of the rows
    const count = (kind: string) => rows.filter((row) => row.kind === kind).length;
    for (const kind of ["case", "old", "none"])
      expect(summary.out).toMatch(new RegExp(`^  ${kind}\\s+${count(kind)}\\s`, "m"));
    expect(summary.out).toContain(`total declarations  ${rows.length}`);
    expect(summary.out).toContain(`total test lines    ${rows.length}`);
    expect(summary.out).toContain(
      `${unitPath}\t${count("case")}\t${count("old")}\t${count("none")}\t${rows.length}`,
    );
    expect(ark("test-audit", "inventory", "--project", "fx", "--json", "--summary").code).not.toBe(
      0,
    );
  });

  test("ARK-T205 a parameter table (test.each) is one row with its row count and the command changes no file", () => {
    const { arkHome, workspace } = fixture({
      "test/each.test.ts": source(
        `test.each([[1, 2], [3, 4], [5, 6]])("ARK-T1 adds %i", () => {});`,
        `test.each([`,
        `  [1],`,
        `  [2],`,
        `  [3],`,
        `  [4],`,
        `])(`,
        `  "ARK-T1 multi-line %i",`,
        `  () => {},`,
        `);`,
        `test.each([])("ARK-T1 empty", () => {});`,
        "test.each`",
        "  a    | b",
        "  ${1} | ${2}",
        "  ${3} | ${4}",
        '`("ARK-T1 tagged $a", () => {});',
      ),
    });
    const before = [snapshot(workspace), snapshot(arkHome)];
    const rows = inventoryRows();
    const table = ark("test-audit", "inventory", "--project", "fx");
    const summary = ark("test-audit", "inventory", "--project", "fx", "--summary");
    expect([table.code, summary.code]).toEqual([0, 0]);

    expect(rows.map((row) => [row.title, row.line, row.rows])).toEqual([
      ["ARK-T1 adds %i", 2, 3],
      ["ARK-T1 multi-line %i", 3, 4],
      ["ARK-T1 empty", 12, 0],
      ["ARK-T1 tagged $a", 13, 2],
    ]);
    expect(table.out).toContain("ARK-T1 adds %i [table x3]");
    expect(summary.out).toContain("total test lines    4");
    expect([snapshot(workspace), snapshot(arkHome)]).toEqual(before);
  });
});

describe("ark test-audit inventory --changed", () => {
  const base = {
    "test/each.test.ts": source(
      `test.each([`,
      `  [1],`,
      `  [2],`,
      `])(`,
      `  "ARK-9-AC1 table %i",`,
      `  () => {},`,
      `);`,
    ),
    "test/skip.test.ts": source(
      `test.skipIf(false)("ARK-9-AC2 skipped", () => {`,
      `  const x = 1;`,
      `});`,
    ),
    "test/nested.test.ts": source(
      `describe("outer", () => {`,
      `  describe("inner", () => {`,
      `    test("ARK-9-AC3 deep", () => {`,
      `      const x = 1;`,
      `    });`,
      `    test("ARK-9-AC4 untouched sibling", () => {});`,
      `  });`,
      `});`,
    ),
    "test/string.test.ts": source(
      `test("ARK-9-AC5 holds text", () => {`,
      `  const text = 'test("ARK-8-AC1 fake", () => { one })';`,
      `});`,
    ),
    "test/deleted.test.ts": source(`test("ARK-9-AC6 deleted", () => {});`),
    "test/before.test.ts": source(
      `test("ARK-9-AC7 renamed and edited", () => {`,
      `  const x = 1;`,
      `});`,
      `test("ARK-9-AC8 renamed untouched", () => {});`,
    ),
    "test/convert.test.ts": source(`test("ARK-9-AC9 to convert", () => {});`),
    "test/helper.test.ts": source(
      `function helper() {`,
      `  return 1;`,
      `}`,
      `test("ARK-9-AC10 helper only", () => {});`,
    ),
    "test/mixed.test.ts": source(`test("ARK-9-AC11 stays old", () => {});`),
  };

  test("ARK-T206 --changed <base> lists only the declarations that the diff changes, with their id kind, and prints old id touched for each old AC id title", () => {
    const { workspace } = fixture(base);
    const at = git(workspace, "rev-parse", "HEAD");
    const edit = (name: string, from: string, to: string) =>
      (base as Record<string, string>)[name].replace(from, to);
    commitAll(workspace, {
      "test/each.test.ts": edit("test/each.test.ts", "[2],", "[22],"),
      "test/skip.test.ts": edit("test/skip.test.ts", "const x = 1;", "const x = 2;"),
      "test/nested.test.ts": edit("test/nested.test.ts", "const x = 1;", "const x = 2;"),
      "test/string.test.ts": edit("test/string.test.ts", "{ one }", "{ two }"),
      "test/deleted.test.ts": null,
      "test/before.test.ts": null,
      "test/after.test.ts": edit("test/before.test.ts", "const x = 1;", "const x = 2;"),
      "test/convert.test.ts": edit("test/convert.test.ts", "ARK-9-AC9", "ARK-T1"),
      "test/helper.test.ts": edit("test/helper.test.ts", "return 1;", "return 2;"),
      "test/mixed.test.ts": `${base["test/mixed.test.ts"]}test("brand new", () => {});\n`,
    });
    // an uncommitted edit counts for nothing
    writeFileSync(join(workspace, "test/nested.test.ts"), "// dirty\n");

    const rows = inventoryRows("--changed", at);
    const listed = rows.map((row) => `${row.file} ${row.kind} ${row.title}`).toSorted();
    expect(listed).toEqual(
      [
        "test/after.test.ts old ARK-9-AC7 renamed and edited",
        "test/convert.test.ts case ARK-T1 to convert",
        "test/each.test.ts old ARK-9-AC1 table %i",
        "test/mixed.test.ts none brand new",
        "test/nested.test.ts old ARK-9-AC3 deep",
        "test/skip.test.ts old ARK-9-AC2 skipped",
        "test/string.test.ts old ARK-9-AC5 holds text",
      ].toSorted(),
    );
    expect(rows.find((row) => row.file === "test/each.test.ts")!.line).toBe(2);

    const out = ark("test-audit", "inventory", "--project", "fx", "--changed", at).out;
    const touched = out.split("\n").filter((line) => line.startsWith("old id touched: "));
    expect(touched.toSorted()).toEqual(
      [
        "old id touched: test/after.test.ts:2 ARK-9-AC7 renamed and edited",
        "old id touched: test/each.test.ts:2 ARK-9-AC1 table %i",
        "old id touched: test/nested.test.ts:4 ARK-9-AC3 deep",
        "old id touched: test/skip.test.ts:2 ARK-9-AC2 skipped",
        "old id touched: test/string.test.ts:2 ARK-9-AC5 holds text",
      ].toSorted(),
    );
    expect(out).toContain(`${rows.length} declarations changed since ${at}`);
  });

  test("ARK-T206 a diff that changes only a helper lists no declaration and no old-id line", () => {
    const { workspace } = fixture(base);
    const at = git(workspace, "rev-parse", "HEAD");
    commitAll(workspace, {
      "test/helper.test.ts": base["test/helper.test.ts"].replace("return 1;", "return 2;"),
    });
    const out = ark("test-audit", "inventory", "--project", "fx", "--changed", at);
    expect(out.code).toBe(0);
    expect(out.out).toContain(`0 declarations changed since ${at}`);
    expect(out.out).not.toContain("old id touched");
  });
});

describe("ark test old-id gate", () => {
  const junit = (file: string) => `bun test --reporter=junit --reporter-outfile={report} ./${file}`;
  const e2e = (...lines: string[]) => `import { test } from "bun:test";\n${lines.join("\n")}\n`;
  const baseSource = e2e(
    `// helper area`,
    `test("FAKE-1-AC1 proves the criterion", () => {});`,
    `test("ARK-9-AC2 target", () => {`,
    `  const x = 1;`,
    `});`,
    `test("ARK-9-AC3 untouched", () => {});`,
  );

  const pytestCommand = `printf '<testsuites><testsuite><testcase classname="x" name="t"/></testsuite></testsuites>' > {report}`;

  /** A building run on a repo whose base commit holds old-id tests; a bun suite and a pytest suite. */
  function run() {
    const arkHome = tempArkHome();
    const workspace = tempGitRepo({ "e2e.test.ts": baseSource });
    writeProject("fx", {
      workspace,
      ticket_source: "local",
      suites: [
        { name: "e2e", level: "e2e", repo: ".", command: junit("e2e.test.ts"), parser: "bun" },
        { name: "py", level: "unit", repo: ".", command: pytestCommand, parser: "pytest" },
      ],
      roles,
    });
    const ticket = writeTicket("fx", "FAKE-1", [{ id: "FAKE-1-AC1", text: "criterion" }]);
    const runId = ark("run", "start", ticket, "--project", "fx").out.match(
      /\d{4}-\d{2}-\d{2}-FAKE-1-\d+/,
    )![0];
    const runDirectory = join(arkHome, "projects", "fx", "runs", runId);
    recordEvaluation(runDirectory);
    writeFileSync(
      join(runDirectory, "plan.yml"),
      JSON.stringify({
        design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
        summary: {
          why: "Test the gate.",
          changes: [{ criterion: "FAKE-1-AC1", where: "tests", now: "a", fix: "b" }],
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
            id: "proves",
            criterion: "FAKE-1-AC1",
            level: "e2e",
            given: [],
            when: ["run it"],
            // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`
            then: ["it works"],
            expected: "it works",
          },
        ],
      }),
    );
    for (const args of [
      ["plan", "check", runId],
      ["gate", "record", runId, "plan", "approve"],
      ["worktree", "create", runId, "."],
    ])
      expect(ark(...args).code, args.join(" ")).toBe(0);
    const mirror = join(runDirectory, "workspace");
    return { runId, mirror, base: git(mirror, "rev-parse", "HEAD") };
  }

  test("ARK-T207 ark test fails a bun suite whose diff touches an old-id test, passes its converted form, a new test and a diff with no old-id declaration, and prints a skip line for another parser", () => {
    const { runId, mirror, base } = run();
    const heads: Record<string, string> = {
      body: baseSource.replace("const x = 1;", "const x = 2;"),
      converted: baseSource.replace("ARK-9-AC2 target", "ARK-T1 target"),
      added: `${baseSource}test("a new test", () => {});\n`,
      outside: baseSource.replace("// helper area", "// helper area, edited"),
    };
    const gate = (name: string) => {
      git(mirror, "reset", "-q", "--hard", base);
      commitAll(mirror, { "e2e.test.ts": heads[name] });
      return ark("test", runId);
    };

    const touched = gate("body");
    expect(touched.code).not.toBe(0);
    expect(touched.out).toContain("old id touched: e2e.test.ts:4 ARK-9-AC2 target");
    expect(touched.out).not.toContain("ARK-9-AC3");
    expect(touched.out).toMatch(/suite py \(pytest\)\s+skipped/);

    for (const name of ["converted", "added", "outside"]) {
      const result = gate(name);
      expect(result.out, name).not.toContain("old id touched");
      expect(result.out, name).toMatch(/suite e2e \(bun\)\s+passed/);
      expect(result.code, name + result.out + result.err).toBe(0);
    }
  });
});
