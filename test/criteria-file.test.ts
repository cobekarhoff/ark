import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frontmatter, parseCriteria } from "../cli/ticket.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// The `ark gate record ... criteria accept --criteria <file>` cases, through the `ark` process (ARK-488).
setDefaultTimeout(30_000);

let projectDirectory: string;
let ticketFile: string;
let runId: string;
let runDirectory: string;

beforeEach(() => {
  tempArkHome();
  projectDirectory = writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true {report}", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
    },
  });
  // A ticket with no criteria waits in awaiting_criteria after its evaluation, as at a real criteria gate.
  ticketFile = writeTicket("demo", "ARK-901", []);
  expect(ark("run", "start", ticketFile).code).toBe(0);
  runId = readdirSync(join(projectDirectory, "runs"))[0];
  runDirectory = join(projectDirectory, "runs", runId);
  recordEvaluation(runDirectory);
  // The lead's cwd: <run folder>/workspace, which is not the run folder.
  mkdirSync(join(runDirectory, "workspace"), { recursive: true });
});

/** Runs ark from the lead's cwd, `<run folder>/workspace`. */
function arkFromWorkspace(...args: string[]) {
  const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", "cli", "ark.ts"), ...args], {
    cwd: join(runDirectory, "workspace"),
    env: process.env,
  });
  return {
    code: result.exitCode ?? 1,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

const read = (file: string) => readFileSync(file, "utf8");
const eventLines = () => read(join(runDirectory, "events.ndjson")).trim().split("\n");
const stateOf = () => JSON.parse(read(join(runDirectory, "state.json")));

const frontmatterTop = [
  "---",
  "id: ARK-901",
  'title: "Ticket ARK-901"',
  "status: ready",
  "source: cortana",
];
const bodyOf = [
  "---",
  "## Why",
  "",
  "Old body line.",
  "",
  "## Acceptance criteria",
  "",
  "| ID | Criterion |",
  "| --- | --- |",
  "| AC1 | old text |",
  "",
];

/** A ticket file made of three pieces: what comes before the criteria block, the old block, and what follows it in the frontmatter. */
function ticketOf(head: string[], oldBlock: string[], tail: string[]): string {
  return [...head, ...oldBlock, ...tail, ...bodyOf].join("\n");
}

const criteriaFile = [
  "acceptance_criteria:",
  "  - id: AC1",
  "    method: test",
  "    verified_by: [ARK-T10, ARK-T11]",
  '    text: "The export writes the unit."',
  "  - id: ARK-901-AC2",
  "    method: inspection",
  '    text: "The skill says: use \\"--criteria\\" # not the ticket."',
  "  - id: ARK-901/AC3",
  "    method: demonstration",
  "    verified_by: []",
  '    text: "The human sees it."',
  "",
].join("\n");

const expectedIds = ["ARK-901/AC1", "ARK-901/AC2", "ARK-901/AC3"];

describe("ARK-T677 criteria accept --criteria writes the ticket", () => {
  // Each form of the block the ticket file holds before the write; the ticket text outside the block must stay.
  const forms: Record<string, { old: string[]; tail: string[] }> = {
    "an empty list": { old: ["acceptance_criteria: []"], tail: [] },
    "no acceptance_criteria key": { old: [], tail: [] },
    "a block list with a comment and a flow verified_by": {
      old: [
        "acceptance_criteria:",
        "  - id: AC1 # old comment",
        '    text: "old text"',
        "    method: test",
        "    verified_by: [ARK-T1]",
      ],
      tail: [],
    },
    "a block list followed by another key": {
      old: [
        "acceptance_criteria:",
        "  - id: AC1",
        '    text: "old text"',
        "    method: inspection",
      ],
      tail: ["milestone: M5"],
    },
  };

  for (const [name, form] of Object.entries(forms)) {
    test(`ARK-T677 replaces ${name}, keeps every other line, copies the ticket and records the gate`, () => {
      const head = frontmatterTop;
      const before = ticketOf(head, form.old, form.tail);
      writeFileSync(ticketFile, before);
      writeFileSync(join(runDirectory, "criteria.yml"), criteriaFile);
      const eventsBefore = eventLines().length;
      const runFilesBefore = readdirSync(runDirectory).sort();

      const accepted = arkFromWorkspace(
        "gate",
        "record",
        runId,
        "criteria",
        "accept",
        "--criteria",
        "criteria.yml",
        "--note",
        "looks right",
      );
      expect(accepted.err).toBe("");
      expect(accepted.code).toBe(0);

      const after = read(ticketFile);
      const prefix = head.join("\n") + "\n";
      const suffix = [...form.tail, ...bodyOf].join("\n");
      expect(after.startsWith(prefix)).toBe(true);
      expect(after.endsWith(suffix)).toBe(true);
      const block = after.slice(prefix.length, after.length - suffix.length);
      expect(block.match(/^acceptance_criteria:/gm)).toHaveLength(1);
      expect(block).not.toContain("old");
      expect(block).not.toContain("acceptance_criteria: []");

      const parsed = parseCriteria(frontmatter(after).fields ?? {}, ticketFile);
      expect(
        parsed.map((criterion) => [criterion.id, criterion.method, criterion.verified_by]),
      ).toEqual([
        ["ARK-901/AC1", "test", ["ARK-T10", "ARK-T11"]],
        ["ARK-901/AC2", "inspection", []],
        ["ARK-901/AC3", "demonstration", []],
      ]);
      const written = frontmatter(after).fields as { acceptance_criteria: { text: string }[] };
      const texts = written.acceptance_criteria.map((criterion) => criterion.text);
      expect(texts[1]).toBe('The skill says: use "--criteria" # not the ticket.');

      expect(read(join(runDirectory, "ticket.md"))).toBe(after);
      expect(read(join(runDirectory, "criteria.yml"))).toBe(criteriaFile);
      expect(readdirSync(runDirectory).sort()).toEqual(runFilesBefore);
      expect(readdirSync(join(ticketFile, ".."))).toEqual(["ARK-901.md"]);

      const events = eventLines().map((line) => JSON.parse(line));
      expect(events).toHaveLength(eventsBefore + 2);
      expect(events.at(-2).type).toBe("criteria.updated");
      expect(events.at(-2).data.criteria).toEqual(expectedIds);
      expect(events.at(-1).type).toBe("gate.answered");
      expect(events.at(-1).data).toEqual({
        gate: "criteria",
        answer: "accept",
        by: "human",
        note: "looks right",
      });
      expect(stateOf().phase).toBe("planning");
      expect(stateOf().gates.criteria).toBe("accept");
    });
  }

  test("ARK-T677 reads an absolute path", () => {
    writeFileSync(ticketFile, ticketOf(frontmatterTop, [], []));
    const absolute = join(runDirectory, "criteria.yml");
    writeFileSync(absolute, criteriaFile);
    const accepted = arkFromWorkspace(
      "gate",
      "record",
      runId,
      "criteria",
      "accept",
      "--criteria",
      absolute,
    );
    expect(accepted.err).toBe("");
    expect(accepted.code).toBe(0);
    expect(read(join(runDirectory, "ticket.md"))).toBe(read(ticketFile));
    expect(stateOf().criteria.map((criterion: { id: string }) => criterion.id)).toEqual(
      expectedIds,
    );
  });
});

/** Everything a refused command must leave as it was. */
type Snapshot = {
  ticket: string;
  copy: string;
  events: string;
  runFiles: string[];
  ticketFiles: string[];
};

describe("ARK-T678 criteria accept --criteria refuses and writes nothing", () => {
  const valid = [
    "  - id: AC1",
    '    text: "new-first"',
    "    method: test",
    "    verified_by: [ARK-T2]",
  ];
  // The second entry is the only defect of each file; the first entry is valid, so a writer that writes before it checks leaves "new-first" in the ticket.
  const withSecond = (...entry: string[]) =>
    ["acceptance_criteria:", ...valid, ...entry, ""].join("\n");
  const second = (...extra: string[]) => [
    "  - id: AC2",
    '    text: "second"',
    "    method: inspection",
    ...extra,
  ];
  const refusals: Record<string, { file: string; error: string }> = {
    "an unknown key in a criterion": {
      file: withSecond(...second("    owner: me")),
      error: "owner",
    },
    "an unknown key at the top": { file: withSecond(...second()) + "note: x\n", error: "note" },
    "the old manual key": { file: withSecond(...second("    manual: true")), error: "manual" },
    "the same id in two forms": {
      file: withSecond("  - id: ARK-901-AC1", '    text: "again"', "    method: inspection"),
      error: "duplicate criterion id ARK-901/AC1",
    },
    "the same id twice": {
      file: withSecond("  - id: AC1", '    text: "again"', "    method: inspection"),
      error: "duplicate criterion id ARK-901/AC1",
    },
    "an unknown method": {
      file: withSecond("  - id: AC2", '    text: "second"', "    method: review"),
      error: "review",
    },
    "an entry without text": {
      file: withSecond("  - id: AC2", "    method: inspection"),
      error: "needs id and text",
    },
    "verified_by that is not a list": {
      file: withSecond(...second("    verified_by: ARK-T1")),
      error: "verified_by must be a list",
    },
    "a test criterion without verified_by": {
      file: withSecond("  - id: AC2", '    text: "second"', "    method: test"),
      error: 'AC2 has method "test" and an empty verified_by',
    },
    "a test criterion with an empty verified_by": {
      file: withSecond(
        "  - id: AC2",
        '    text: "second"',
        "    method: test",
        "    verified_by: []",
      ),
      error: 'AC2 has method "test" and an empty verified_by',
    },
    "an empty list": { file: "acceptance_criteria: []\n", error: "at least one criterion" },
    "a mapping without the key": { file: "{}\n", error: "at least one criterion" },
    "an empty file": { file: "", error: "expected a mapping" },
    "a bare list": { file: valid.join("\n") + "\n", error: "expected a mapping" },
    "text that is not YAML": {
      file: "acceptance_criteria: [a\n  - b: : :\n",
      error: "not valid YAML",
    },
  };

  /** The bytes and file lists a refusal must not change. */
  function snapshot(): Snapshot {
    return {
      ticket: read(ticketFile),
      copy: read(join(runDirectory, "ticket.md")),
      events: read(join(runDirectory, "events.ndjson")),
      runFiles: readdirSync(runDirectory).sort(),
      ticketFiles: readdirSync(join(ticketFile, "..")).sort(),
    };
  }

  const oldTicket = ticketOf(
    frontmatterTop,
    [
      "acceptance_criteria:",
      "  - id: AC1",
      '    text: "old"',
      "    method: test",
      "    verified_by: [ARK-T1]",
    ],
    [],
  );

  function expectRefused(
    result: { code: number; out: string; err: string },
    error: string,
    before: Snapshot,
  ) {
    expect(result.code).toBe(1);
    expect(result.err.trim().split("\n")).toHaveLength(1);
    expect(result.err).toStartWith("ark: ");
    expect(result.err).toContain(error);
    expect(result.out).toBe("");
    expect(snapshot()).toEqual(before);
  }

  beforeEach(() => {
    writeFileSync(ticketFile, oldTicket);
  });

  for (const [name, refusal] of Object.entries(refusals)) {
    test(`ARK-T678 refuses ${name}`, () => {
      writeFileSync(join(runDirectory, "criteria.yml"), refusal.file);
      const before = snapshot();
      const result = arkFromWorkspace(
        "gate",
        "record",
        runId,
        "criteria",
        "accept",
        "--criteria",
        "criteria.yml",
      );
      expectRefused(result, refusal.error, before);
      expect(stateOf().phase).toBe("awaiting_criteria");
    });
  }

  test("ARK-T678 refuses a file that does not exist, and one that exists only in the cwd", () => {
    writeFileSync(join(runDirectory, "workspace", "cwd-only.yml"), criteriaFile);
    const before = snapshot();
    expectRefused(
      arkFromWorkspace(
        "gate",
        "record",
        runId,
        "criteria",
        "accept",
        "--criteria",
        "does-not-exist.yml",
      ),
      "does-not-exist.yml: not found",
      before,
    );
    expectRefused(
      arkFromWorkspace("gate", "record", runId, "criteria", "accept", "--criteria", "cwd-only.yml"),
      "cwd-only.yml: not found",
      before,
    );
  });

  test("ARK-T678 refuses --criteria with edit, abort or another gate, and the run keeps waiting", () => {
    writeFileSync(join(runDirectory, "criteria.yml"), criteriaFile);
    const before = snapshot();
    for (const answer of [
      ["criteria", "edit"],
      ["criteria", "abort"],
      ["plan", "approve"],
    ])
      expectRefused(
        arkFromWorkspace("gate", "record", runId, ...answer, "--criteria", "criteria.yml"),
        "--criteria works only with: ark gate record <run> criteria accept",
        before,
      );
    expect(stateOf().phase).toBe("awaiting_criteria");
  });

  test("ARK-T678 refuses --criteria once the run has left awaiting_criteria", () => {
    expect(ark("gate", "record", runId, "criteria", "accept").code).toBe(0);
    expect(stateOf().phase).toBe("planning");
    writeFileSync(join(runDirectory, "criteria.yml"), criteriaFile);
    const before = snapshot();
    expectRefused(
      arkFromWorkspace("gate", "record", runId, "criteria", "accept", "--criteria", "criteria.yml"),
      "the run is in planning",
      before,
    );
  });
});

describe("ARK-T679 criteria accept without --criteria", () => {
  test("ARK-T679 re-reads the hand-edited ticket, accepts manual: true and an unknown key, and writes nothing to it", () => {
    const edited = ticketOf(
      frontmatterTop,
      [
        "acceptance_criteria:",
        "  - id: ARK-901-AC1",
        '    text: "first"',
        "    method: test",
        "    verified_by: [ARK-T1]",
        "  - id: ARK-901-AC2",
        '    text: "second"',
        "    manual: true",
        "  - id: ARK-901-AC3",
        '    text: "third"',
        "    method: inspection",
        "    owner: me",
      ],
      [],
    );
    writeFileSync(ticketFile, edited);
    writeFileSync(
      join(runDirectory, "criteria.yml"),
      criteriaFile.replace("The human sees it.", "from-file-only"),
    );

    const accepted = ark("gate", "record", runId, "criteria", "accept", "--note", "ok");
    expect(accepted.err).toBe("");
    expect(accepted.code).toBe(0);

    expect(read(ticketFile)).toBe(edited);
    expect(read(join(runDirectory, "ticket.md"))).toBe(edited);
    expect(read(join(runDirectory, "ticket.md"))).not.toContain("from-file-only");
    const events = eventLines().map((line) => JSON.parse(line));
    expect(events.at(-2).type).toBe("criteria.updated");
    expect(events.at(-2).data.criteria).toEqual(expectedIds);
    expect(events.at(-1).data).toEqual({
      gate: "criteria",
      answer: "accept",
      by: "human",
      note: "ok",
    });
    expect(stateOf().phase).toBe("planning");
    const methods = parseCriteria(
      frontmatter(read(join(runDirectory, "ticket.md"))).fields ?? {},
      "ticket.md",
    ).map((criterion) => criterion.method);
    expect(methods).toEqual(["test", "demonstration", "inspection"]);
  });
});
