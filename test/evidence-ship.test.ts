import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import { evidenceProblem } from "../cli/ticket.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(60_000);

const fixtures = resolve(import.meta.dir, "fixtures/merge-request");
const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${directory}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

// The fake `gh` of the merge-request tests records its calls here.
beforeEach(() => {
  process.env.FAKE_LOG = join(mkdtempSync(join(tmpdir(), "fixture-log-")), "calls.ndjson");
  process.env.PATH = `${fixtures}:${(process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry !== fixtures)
    .join(":")}`;
});

// --- Evidence files of each method -----------------------------------------------------------------------------------

const demonstrationSections = {
  did: "## What the human did\n\nOpened the page.\n",
  saw: "## What the human saw\n\nThe feature.\n",
  before: "## Before\n\n- results/screenshots/before.png\n",
  after: "## After\n\n- results/screenshots/after.png\n",
};

/** A demonstration file. `without` drops a section, `override` replaces one, `tail` is what follows the sections. */
function demonstration(
  options: {
    without?: keyof typeof demonstrationSections;
    override?: Partial<typeof demonstrationSections>;
    tail?: string;
  } = {},
): string {
  const sections = { ...demonstrationSections, ...options.override };
  const kept = Object.entries(sections)
    .filter(([name]) => name !== options.without)
    .map(([, text]) => text);
  return `${kept.join("\n")}\n${options.tail ?? "human: ok\n"}`;
}

const inspectionSections = {
  files: "## Files\n\n- cli/a.ts:1-10\n",
  checked: "## Checked against\n\nThe AC text.\n",
};

function inspection(verdictLine: string | undefined, files = inspectionSections.files): string {
  return `${files}\n${inspectionSections.checked}\n## Verdict\n\nThe code does it.\n${verdictLine === undefined ? "" : `\n${verdictLine}\n`}`;
}

/** An analysis file. `omit` drops the Base or Head sub-section of one section. */
function analysis(omit?: { section: string; label: "Base" | "Head" }): string {
  return ["Command", "Output", "Threshold", "Result"]
    .map((section) => {
      const labels = (["Base", "Head"] as const).filter(
        (label) => !(omit?.section === section && omit.label === label),
      );
      return `## ${section}\n\n${labels.map((label) => `### ${label}\n\nvalue of ${label}\n`).join("\n")}`;
    })
    .join("\n");
}

const wellFormed: [string, "demonstration" | "inspection" | "analysis", string][] = [
  ["demonstration", "demonstration", demonstration()],
  ["inspection with reviewer: pass", "inspection", inspection("reviewer: pass")],
  ["inspection with reviewer: fail", "inspection", inspection("reviewer: fail")],
  ["analysis", "analysis", analysis()],
];

// [name, method, text, text the reason names]
const malformed: [string, "demonstration" | "inspection" | "analysis", string, string][] = [
  [
    "a demonstration without What the human saw",
    "demonstration",
    demonstration({ without: "saw" }),
    "What the human saw",
  ],
  [
    "a demonstration with no screenshot path under Before",
    "demonstration",
    demonstration({ override: { before: "## Before\n\n(screenshot to come)\n" } }),
    "Before",
  ],
  [
    "a demonstration with no screenshot path under After",
    "demonstration",
    demonstration({ override: { after: "## After\n\n(screenshot to come)\n" } }),
    "After",
  ],
  ["a demonstration without human: ok", "demonstration", demonstration({ tail: "" }), "human: ok"],
  [
    "a demonstration with a line after human: ok",
    "demonstration",
    demonstration({ tail: "human: ok\nThanks.\n" }),
    "human: ok",
  ],
  ["an inspection without a reviewer line", "inspection", inspection(undefined), "reviewer"],
  ["an inspection with reviewer: maybe", "inspection", inspection("reviewer: maybe"), "reviewer"],
  [
    "an inspection whose Files entry has no line range",
    "inspection",
    inspection("reviewer: pass", "## Files\n\n- src/a.ts\n"),
    "Files",
  ],
  [
    "an analysis without Head under Output",
    "analysis",
    analysis({ section: "Output", label: "Head" }),
    "Output",
  ],
  ...["Command", "Threshold", "Result"].map((section): [string, "analysis", string, string] => [
    `an analysis without Base under ${section}`,
    "analysis",
    analysis({ section, label: "Base" }),
    section,
  ]),
];

describe("evidence file shape", () => {
  test.each(wellFormed)("ARK-T6 accepts a well-formed %s file", (_name, method, text) => {
    expect(evidenceProblem(method, text)).toBeUndefined();
  });

  test.each(malformed)("ARK-T6 rejects %s and names %s", (_name, method, text, named) => {
    expect(evidenceProblem(method, text)).toContain(named);
  });
});

// --- ark gate record manual ... ok ------------------------------------------------------------------------------------

type Method = "demonstration" | "inspection" | "analysis";

/** A building run whose manual ACs are AC1 to AC6; the gate tests write their evidence files. */
function gateRun() {
  const arkHome = tempArkHome();
  const workspace = tempGitRepo();
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
    roles,
  });
  const methods: Method[] = [
    "demonstration",
    "inspection",
    "analysis",
    "demonstration",
    "demonstration",
    "demonstration",
  ];
  const criteria = methods.map((method, index) => ({
    id: `AC${index + 1}`,
    text: `Criterion ${index + 1}`,
    method,
  }));
  const ticket = writeTicket("demo", "FAKE-6", criteria, "Ticket FAKE-6");
  const runId = ark("run", "start", ticket, "--project", "demo").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-6-\d+/,
  )![0];
  const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
  recordEvaluation(runDirectory);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark gate record"] }] },
      summary: {
        why: "Record manual answers.",
        changes: criteria.map(({ id }) => ({
          criterion: `FAKE-6/${id}`,
          where: "evidence",
          now: "None.",
          fix: "A file.",
        })),
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: ".",
          harness: "claude",
          model: "claude-sonnet",
          needs: [],
          criteria: criteria.map(({ id }) => `FAKE-6/${id}`),
        },
      ],
      test_cases: [],
    }),
  );
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
  }
  const evidenceFile = (id: string) => join(runDirectory, "results", "evidence", `${id}.md`);
  return {
    runId,
    evidenceFile,
    write(id: string, text: string) {
      mkdirSync(dirname(evidenceFile(id)), { recursive: true });
      writeFileSync(evidenceFile(id), text);
    },
  };
}

const humanOkLines = (text: string) => text.split("\n").filter((line) => line === "human: ok");

describe("manual gate and evidence files", () => {
  test("ARK-T6 a manual ok leaves human: ok once as the last line of a demonstration file, also after problem and a second ok", () => {
    const run = gateRun();
    run.write("AC1", demonstration({ tail: "" }));
    expect(ark("gate", "record", run.runId, "manual", "AC1", "ok").code).toBe(0);
    const first = readFileSync(run.evidenceFile("AC1"), "utf8");
    expect(humanOkLines(first)).toHaveLength(1);
    expect(first.trimEnd().split("\n").at(-1)).toBe("human: ok");
    expect(evidenceProblem("demonstration", first)).toBeUndefined();

    run.write("AC4", demonstration({ tail: "" }));
    for (const answer of ["problem", "ok", "ok"])
      expect(ark("gate", "record", run.runId, "manual", "AC4", answer).code, answer).toBe(0);
    const repeated = readFileSync(run.evidenceFile("AC4"), "utf8");
    expect(humanOkLines(repeated)).toHaveLength(1);
    expect(repeated.endsWith("human: ok\n")).toBe(true);
  });

  test("ARK-T6 a manual problem appends no human: ok", () => {
    const run = gateRun();
    const text = demonstration({ tail: "" });
    run.write("AC5", text);
    expect(ark("gate", "record", run.runId, "manual", "AC5", "problem").code).toBe(0);
    expect(readFileSync(run.evidenceFile("AC5"), "utf8")).toBe(text);
  });

  test("ARK-T6 a manual ok leaves an inspection and an analysis file byte for byte as it was", () => {
    const run = gateRun();
    const inspected = inspection("reviewer: pass");
    const analysed = analysis();
    run.write("AC2", inspected);
    run.write("AC3", analysed);
    expect(ark("gate", "record", run.runId, "manual", "AC2", "ok").code).toBe(0);
    expect(ark("gate", "record", run.runId, "manual", "AC3", "ok").code).toBe(0);
    expect(readFileSync(run.evidenceFile("AC2"), "utf8")).toBe(inspected);
    expect(readFileSync(run.evidenceFile("AC3"), "utf8")).toBe(analysed);
  });

  test("ARK-T6 a manual ok with no evidence file writes no file", () => {
    const run = gateRun();
    expect(ark("gate", "record", run.runId, "manual", "AC6", "ok").code).toBe(0);
    expect(existsSync(run.evidenceFile("AC6"))).toBe(false);
  });
});

// --- ark merge-request open and ark run close handed_off ---------------------------------------------------------------

const runId = "2026-11-06-ARK-900-1";

type ShipCriterion = {
  id: string;
  text: string;
  method?: string;
  verified_by?: string[];
  manual?: boolean;
};

/**
 * A building run in one repo (`repos/core`) with a commit on its branch, a bare remote and a last test that
 * passed at the current head. Every non-test AC in `proven` has its manual answer.
 */
function shipRun(criteria: ShipCriterion[], proven: string[]) {
  tempArkHome();
  const workspace = mkdtempSync(join(tmpdir(), "fixture-workspace-"));
  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
    roles,
  });
  const ticketFile = writeTicket("demo", "ARK-900", criteria, "Show units");
  const directory = join(projectDirectory, "runs", runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "ticket.md"), readFileSync(ticketFile));
  const ids = criteria.map((criterion) => `ARK-900/${criterion.id}`);

  const steps = [
    {
      id: "core-impl",
      role: "implementer",
      repo: "repos/core",
      harness: "claude",
      model: "claude-sonnet",
      needs: [],
      criteria: ids,
    },
  ];
  writeFileSync(join(directory, "plan.yml"), JSON.stringify({ steps, test_cases: [] }));

  const source = join(workspace, "repos", "core");
  mkdirSync(dirname(source), { recursive: true });
  renameSync(tempGitRepo(), source);
  const base = git(source, "branch", "--show-current");
  const bare = mkdtempSync(join(tmpdir(), "fixture-bare-"));
  git(bare, "init", "--bare", "-q");
  git(source, "remote", "add", "origin", "https://github.com/org/core.git");
  git(source, "config", "remote.origin.pushurl", bare);
  const worktree = join(mkdtempSync(join(tmpdir(), "fixture-worktree-")), "core");
  git(source, "worktree", "add", "-q", "-b", `ark/${runId}`, worktree, base);
  writeFileSync(join(worktree, "core.txt"), "core");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "core");

  const otherHead = git(source, "rev-parse", "HEAD");
  const testCompleted = () => ({
    passed: true,
    // repos/docs is untouched by the run: its head is the project clone's, which differs from the run's checkout of repos/core
    heads: { "repos/core": git(worktree, "rev-parse", "HEAD"), "repos/docs": otherHead },
    suites: [{ name: "e2e", level: "e2e", passed: true }],
    criteria: Object.fromEntries(
      criteria
        .filter(
          (criterion) =>
            (criterion.method ?? (criterion.manual ? "demonstration" : "test")) === "test",
        )
        .map((criterion) => [`ARK-900/${criterion.id}`, "passing"]),
    ),
  });
  const events: { type: string; data: Record<string, unknown> }[] = [
    {
      type: "run.started",
      data: {
        run: runId,
        project: "demo",
        round_budget: 2,
        ticket: { id: "ARK-900", title: "Show units" },
        criteria: ids,
        ticket_file: ticketFile,
      },
    },
    { type: "plan.checked", data: { valid: true, problems: [], plan_hash: "hash", steps } },
    { type: "gate.answered", data: { gate: "plan", answer: "approve" } },
    {
      type: "worktree.created",
      data: { repo: "repos/core", path: worktree, branch: `ark/${runId}`, base },
    },
    ...proven.map((id) => ({
      type: "gate.answered",
      data: { gate: "manual", criterion: `ARK-900/${id}`, answer: "ok", by: "human" },
    })),
    { type: "test.completed", data: testCompleted() },
  ];
  writeFileSync(
    join(directory, "events.ndjson"),
    `${events
      .map((event, i) => JSON.stringify({ seq: i + 1, time: "2026-11-06T00:00:00.000Z", ...event }))
      .join("\n")}\n`,
  );
  return {
    directory,
    source,
    worktree,
    bare,
    write(id: string, text: string) {
      mkdirSync(join(directory, "results", "evidence"), { recursive: true });
      writeFileSync(join(directory, "results", "evidence", `${id}.md`), text);
    },
    /** A test result at the head as it is now, as `ark test` would append. */
    retest: () => appendEvent(directory, "test.completed", testCompleted()),
    snapshot: () => ({
      refs: git(bare, "for-each-ref"),
      events: readFileSync(join(directory, "events.ndjson"), "utf8").split("\n").filter(Boolean)
        .length,
      phase: deriveState(readEvents(directory)).phase,
    }),
  };
}

type ShipRun = ReturnType<typeof shipRun>;

const commands: [string, (run: ShipRun) => string[]][] = [
  ["merge-request open", () => ["merge-request", "open", runId]],
  ["run close handed_off", () => ["run", "close", runId, "handed_off"]],
];

/** The command refused: it exited 1 and pushed nothing, appended no event and left the phase. */
function expectRefused(run: ShipRun, args: string[]): string {
  const before = run.snapshot();
  const result = ark(...args);
  expect(result.code, result.err).toBe(1);
  expect(run.snapshot()).toEqual(before);
  return result.err;
}

/** The command went through: a merge-request push, or the run.closed event. */
function expectProceeded(run: ShipRun, args: string[]): void {
  const before = run.snapshot();
  const result = ark(...args);
  expect(result.code, result.err).toBe(0);
  expect(result.err).not.toContain("evidence");
  const after = run.snapshot();
  if (args[0] === "merge-request") expect(after.refs).toContain(`refs/heads/ark/${runId}`);
  else expect(after.phase).toBe("closed");
  expect(after.events).toBeGreaterThan(before.events);
}

const nonTestCriteria: ShipCriterion[] = [
  { id: "AC1", text: "A person sees it", method: "demonstration" },
  { id: "AC2", text: "A reviewer reads it", method: "inspection" },
  { id: "AC3", text: "A command measures it", method: "analysis" },
  { id: "AC4", text: "A person sees it again", method: "demonstration" },
];
const allProven = ["AC1", "AC2", "AC3", "AC4"];

describe.each(commands)("ark %s evidence for ACs with no test", (_name, argsFor) => {
  test("ARK-T7 refuses every AC with no evidence file, a legacy manual AC included, before any push and event", () => {
    const run = shipRun(
      [...nonTestCriteria, { id: "AC5", text: "A person checked it", manual: true }],
      [...allProven, "AC5"],
    );
    const message = expectRefused(run, argsFor(run));
    for (const line of [
      "evidence missing: AC1 (demonstration)",
      "evidence missing: AC2 (inspection)",
      "evidence missing: AC3 (analysis)",
      "evidence missing: AC4 (demonstration)",
      "evidence missing: AC5 (demonstration)",
    ])
      expect(message).toContain(line);
  });

  test("ARK-T7 names a missing and each malformed file and not the well-formed one", () => {
    const run = shipRun(nonTestCriteria, allProven);
    run.write("AC2", inspection(undefined).replace(/## Verdict[\s\S]*/, ""));
    run.write("AC3", analysis({ section: "Result", label: "Head" }));
    run.write("AC4", demonstration());
    const message = expectRefused(run, argsFor(run));
    expect(message).toContain("evidence missing: AC1 (demonstration)");
    expect(message).toMatch(/evidence malformed: AC2: .*Verdict/);
    expect(message).toMatch(/evidence malformed: AC3: .*Result/);
    expect(message).not.toContain("AC4");
  });

  test("ARK-T7 keeps the manual-gate refusal, which comes before the evidence check", () => {
    const run = shipRun(nonTestCriteria, ["AC1", "AC2", "AC3"]);
    const message = expectRefused(run, argsFor(run));
    expect(message).toContain("manual criterion without ok: ARK-900/AC4");
    expect(message).not.toContain("evidence");
  });

  test("ARK-T7 passes the evidence check when every non-test AC has a well-formed file", () => {
    const run = shipRun(nonTestCriteria, allProven);
    run.write("AC1", demonstration());
    run.write("AC2", inspection("reviewer: pass"));
    run.write("AC3", analysis());
    run.write("AC4", demonstration());
    expectProceeded(run, argsFor(run));
  });
});

// --- test evidence of the verified_by cases -----------------------------------------------------------------------------

const testCriteria: ShipCriterion[] = [
  { id: "AC1", text: "A test proves it", method: "test", verified_by: ["FAKE-T1", "FAKE-T2"] },
  { id: "AC2", text: "A test proves it too", method: "test" },
];

/** `head`: "current" is the run's checkout head, a literal is a SHA, undefined writes no folder. */
type CaseEvidence = { base?: string; head?: string };

function writeCaseEvidence(run: ShipRun, id: string, evidence: CaseEvidence): void {
  const currentHead = git(run.worktree, "rev-parse", "HEAD");
  const shas = {
    base: evidence.base,
    head: evidence.head === "current" ? currentHead : evidence.head,
  };
  for (const side of ["base", "head"] as const) {
    if (shas[side] === undefined) continue;
    const folder = join(run.directory, "results", "evidence", id, side);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "result.json"),
      JSON.stringify({
        case: id,
        name: `${id} case`,
        status: "passed",
        sha: shas[side],
        repo: "repos/core",
      }),
    );
  }
}

const valid: CaseEvidence = { base: "arbitrary-base-sha", head: "current" };

const refusals: {
  name: string;
  first: CaseEvidence;
  second: CaseEvidence;
  lines: string[];
}[] = [
  {
    name: "(1) no folder for the first case",
    first: {},
    second: valid,
    lines: [
      "test evidence missing: AC1 FAKE-T1 (base)",
      "test evidence missing: AC1 FAKE-T1 (head)",
    ],
  },
  {
    name: "(2) only head for the first case",
    first: { head: "current" },
    second: valid,
    lines: ["test evidence missing: AC1 FAKE-T1 (base)"],
  },
  {
    name: "(3) only base for the first case",
    first: { base: "arbitrary-base-sha" },
    second: valid,
    lines: ["test evidence missing: AC1 FAKE-T1 (head)"],
  },
  {
    name: "(4) a head SHA that is not the repo head",
    first: { base: "arbitrary-base-sha", head: "deadbeef" },
    second: valid,
    lines: ["test evidence stale: AC1 FAKE-T1"],
  },
  {
    name: "(7) the second case has no folder",
    first: valid,
    second: {},
    lines: [
      "test evidence missing: AC1 FAKE-T2 (base)",
      "test evidence missing: AC1 FAKE-T2 (head)",
    ],
  },
];

describe.each(commands)("ark %s evidence for verified_by cases", (_name, argsFor) => {
  test.each(refusals)(
    "ARK-T8 refuses $name and names only that case",
    ({ first, second, lines }) => {
      const run = shipRun(testCriteria, []);
      writeCaseEvidence(run, "FAKE-T1", first);
      writeCaseEvidence(run, "FAKE-T2", second);
      const message = expectRefused(run, argsFor(run));
      expect(
        message
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("test evidence")),
      ).toEqual(lines);
      expect(message).not.toContain("AC2");
    },
  );

  test("ARK-T8 refuses a head SHA that is the project clone's head, not the run checkout's", () => {
    const run = shipRun(testCriteria, []);
    expect(git(run.source, "rev-parse", "HEAD")).not.toBe(git(run.worktree, "rev-parse", "HEAD"));
    writeCaseEvidence(run, "FAKE-T1", { base: "x", head: git(run.source, "rev-parse", "HEAD") });
    writeCaseEvidence(run, "FAKE-T2", valid);
    expect(expectRefused(run, argsFor(run))).toContain("test evidence stale: AC1 FAKE-T1");
  });

  test("ARK-T8 refuses a head SHA that is the current head of another repo of the run", () => {
    const run = shipRun(testCriteria, []);
    const docsHead = git(run.source, "rev-parse", "HEAD");
    const heads = JSON.parse(
      readFileSync(join(run.directory, "events.ndjson"), "utf8").trim().split("\n").at(-1)!,
    ).data.heads;
    expect(Object.values(heads)).toContain(docsHead);
    writeCaseEvidence(run, "FAKE-T1", { base: "x", head: docsHead });
    writeCaseEvidence(run, "FAKE-T2", valid);
    const lines = expectRefused(run, argsFor(run))
      .split("\n")
      .filter((line) => line.includes("test evidence"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("test evidence stale: AC1 FAKE-T1");
  });

  test.each([
    ["an unknown repo and no sha", { case: "FAKE-T1", repo: "repos/nowhere" }],
    ["a known repo and no sha", { case: "FAKE-T1", repo: "repos/core" }],
    ["no repo and no sha (an old file)", { case: "FAKE-T1" }],
  ])("ARK-T8 refuses head evidence with %s", (_case, body) => {
    const run = shipRun(testCriteria, []);
    writeCaseEvidence(run, "FAKE-T1", valid);
    writeCaseEvidence(run, "FAKE-T2", valid);
    writeFileSync(
      join(run.directory, "results", "evidence", "FAKE-T1", "head", "result.json"),
      JSON.stringify(body),
    );
    const lines = expectRefused(run, argsFor(run))
      .split("\n")
      .filter((line) => line.includes("test evidence"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("test evidence stale: AC1 FAKE-T1");
  });

  test.each([
    ["(5) both folders, head SHA current", { base: "arbitrary-base-sha", head: "current" }],
    ["(6) both folders, base SHA is any value", { base: "0000", head: "current" }],
  ])(
    "ARK-T8 passes with %s, and an AC with no verified_by needs no test evidence",
    (_case, first) => {
      const run = shipRun(testCriteria, []);
      writeCaseEvidence(run, "FAKE-T1", first);
      writeCaseEvidence(run, "FAKE-T2", valid);
      expectProceeded(run, argsFor(run));
    },
  );

  test("ARK-T8 refuses every case as stale after a commit moves the head", () => {
    const run = shipRun(testCriteria, []);
    writeCaseEvidence(run, "FAKE-T1", valid);
    writeCaseEvidence(run, "FAKE-T2", valid);
    const before = git(run.worktree, "rev-parse", "HEAD");
    writeFileSync(join(run.worktree, "late.txt"), "late");
    git(run.worktree, "add", "-A");
    git(run.worktree, "commit", "-q", "-m", "late");
    expect(git(run.worktree, "rev-parse", "HEAD")).not.toBe(before);
    run.retest();
    const message = expectRefused(run, argsFor(run));
    expect(message).toContain("test evidence stale: AC1 FAKE-T1");
    expect(message).toContain("test evidence stale: AC1 FAKE-T2");
  });
});
