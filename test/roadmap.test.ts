import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readRoadmap, type Roadmap, type RoadmapTicket } from "../hub/roadmap.ts";

setDefaultTimeout(180_000);

const root = join(import.meta.dir, "..");
const ticket = (
  id: string,
  status: string,
  milestone: string | null = "M9",
  depends_on: string[] = [],
): RoadmapTicket => ({ id, title: `Title ${id}`, status, milestone, depends_on });

const roadmapOf = (markdown: string, tickets: RoadmapTicket[]): Roadmap => {
  const result = readRoadmap(markdown, tickets);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.roadmap;
};

const file = (milestones: string, lists: { now?: string[]; next?: string[]; later?: string[] }) =>
  [
    "## Vision",
    "",
    "One vision.",
    "",
    "## Milestones",
    "",
    "| id | name | outcome | state |",
    "| --- | --- | --- | --- |",
    milestones,
    ...(["now", "next", "later"] as const).flatMap((name) => [
      "",
      `## ${name[0].toUpperCase()}${name.slice(1)}`,
      "",
      ...(lists[name] ?? []).map((id) => `- ${id}`),
    ]),
  ].join("\n");

const m9 = "| M9 | See the work | Outcome nine. | active |";

test("ARK-290-AC1 docs/reference/roadmap.md describes the sections, the columns, the states and the rules", () => {
  const doc = readFileSync(join(root, "docs/reference/roadmap.md"), "utf8");
  for (const text of [
    "$ARK_HOME/projects/<project>/ROADMAP.md",
    "## Vision",
    "## Milestones",
    "## Now",
    "## Next",
    "## Later",
    "`id`, `name`, `outcome` and `state`",
    "`done`, `active` or `later`",
    "`- <ticket id>`",
    "Only the human changes a rank",
    "A finished ticket (`done` or `superseded`) can stay listed",
    "An open ticket in no list is Unranked",
  ])
    expect(doc).toContain(text);
});

test("ARK-290-AC2 readRoadmap returns the vision, counts, horizons, Unranked, Review and Shipped", () => {
  const tickets = [
    ticket("ARK-1", "ready"),
    ticket("ARK-2", "in_progress"),
    ticket("ARK-3", "proposed"),
    ticket("ARK-4", "done"),
    ticket("ARK-5", "superseded"),
    ticket("ARK-6", "proposed"),
    ticket("ARK-7", "ready"),
    ticket("ARK-8", "ready", "M1"),
  ];
  const roadmap = roadmapOf(
    file(`${m9}\n| M1 | Old | Done outcome. | done |`, {
      now: ["ARK-2", "ARK-4"],
      next: ["ARK-3", "ARK-1"],
      later: ["ARK-8"],
    }),
    tickets,
  );

  expect(roadmap.vision).toBe("One vision.");
  expect(
    roadmap.milestones.map(({ id, state, done, superseded, open }) => [
      id,
      state,
      done,
      superseded,
      open,
    ]),
  ).toEqual([
    ["M9", "active", 1, 1, 5],
    ["M1", "done", 0, 0, 1],
  ]);
  expect(roadmap.now.map((item) => item.id)).toEqual(["ARK-2"]);
  expect(roadmap.next.map((item) => item.id)).toEqual(["ARK-3", "ARK-1"]);
  expect(roadmap.next.map((item) => item.proposed)).toEqual([true, undefined]);
  expect(roadmap.later.map((item) => item.id)).toEqual(["ARK-8"]);
  expect(roadmap.unranked.map((item) => item.id)).toEqual(["ARK-7"]);
  expect(roadmap.review.map((item) => item.id)).toEqual(["ARK-3", "ARK-6"]);
  expect(roadmap.shipped).toEqual([
    {
      milestone: "M9",
      tickets: [
        expect.objectContaining({ id: "ARK-4", status: "done" }),
        expect.objectContaining({ id: "ARK-5", status: "superseded" }),
      ],
    },
  ]);
});

test("ARK-290-AC3 readRoadmap warns on a missing, unranked, finished or misordered ticket", () => {
  const warningsOf = (markdown: string, tickets: RoadmapTicket[]) =>
    roadmapOf(markdown, tickets).warnings.map(({ kind, ids }) => ({ kind, ids }));

  expect(warningsOf(file(m9, { now: ["ARK-9"] }), [ticket("ARK-1", "ready")])).toEqual([
    { kind: "missing_ticket", ids: ["ARK-9"] },
    { kind: "unranked", ids: ["ARK-1"] },
  ]);

  expect(
    warningsOf(file(m9, { now: ["ARK-1", "ARK-2"] }), [
      ticket("ARK-1", "done"),
      ticket("ARK-2", "superseded"),
    ]),
  ).toEqual([
    { kind: "finished_listed", ids: ["ARK-1"] },
    { kind: "finished_listed", ids: ["ARK-2"] },
  ]);

  // earlier horizon
  expect(
    warningsOf(file(m9, { now: ["ARK-2"], next: ["ARK-1"] }), [
      ticket("ARK-1", "ready"),
      ticket("ARK-2", "ready", "M9", ["ARK-1"]),
    ]),
  ).toEqual([{ kind: "rank_above_dependency", ids: ["ARK-2", "ARK-1"] }]);

  // earlier in the same list
  expect(
    warningsOf(file(m9, { next: ["ARK-2", "ARK-1"] }), [
      ticket("ARK-1", "in_progress"),
      ticket("ARK-2", "ready", "M9", ["ARK-1"]),
    ]),
  ).toEqual([{ kind: "rank_above_dependency", ids: ["ARK-2", "ARK-1"] }]);

  // no warning: dependency first, or dependency finished
  expect(
    warningsOf(file(m9, { now: ["ARK-1"], next: ["ARK-2", "ARK-3"] }), [
      ticket("ARK-1", "ready"),
      ticket("ARK-2", "ready", "M9", ["ARK-1"]),
      ticket("ARK-3", "ready", "M9", ["ARK-4"]),
      ticket("ARK-4", "done"),
    ]),
  ).toEqual([]);

  const noVision = readRoadmap(
    ["## Milestones", "", "| id | name | outcome | state |", "| --- | --- | --- | --- |", m9].join(
      "\n",
    ),
    [],
  );
  expect(noVision).toEqual({
    ok: false,
    errors: [{ line: 1, message: expect.stringContaining("Vision") }],
  });

  const badState = readRoadmap(file("| M9 | See the work | Outcome nine. | paused |", {}), []);
  expect(badState).toEqual({
    ok: false,
    errors: [{ line: 9, message: expect.stringContaining("paused") }],
  });
});

test("ARK-290-AC4 the roadmap structure holds the vision, milestones M1 to M9 and the ranks, with no missing or unranked warning", () => {
  const markdown = readFileSync(join(root, "test/fixtures/roadmap/ROADMAP.md"), "utf8");
  const now = ["ARK-290", "ARK-295"];
  const next = ["ARK-291", "ARK-296", "ARK-297", "ARK-293"];
  const later = ["ARK-299", "ARK-300", "ARK-202", "ARK-158", "ARK-159"];
  const roadmap = roadmapOf(
    markdown,
    [...now, ...next, ...later].map((id) => ticket(id, "ready")),
  );

  expect(roadmap.vision).toBe(
    "Ark takes a ticket to merge-ready changes in one repo or several, and you decide only at gates and at merge.",
  );
  expect(roadmap.milestones.map(({ id, state }) => `${id} ${state}`)).toEqual([
    "M1 done",
    "M1a done",
    "M2 done",
    "M3 done",
    "M4 done",
    "M5 active",
    "M6 later",
    "M7 later",
    "M8 later",
    "M9 active",
  ]);
  expect(roadmap.milestones.map((milestone) => milestone.name)).toContain("Reliable runs");
  expect(roadmap.now.map((item) => item.id)).toEqual(now);
  expect(roadmap.next.map((item) => item.id)).toEqual(next);
  expect(roadmap.later.map((item) => item.id)).toEqual(later);
  expect(
    roadmap.warnings.filter((w) => w.kind === "missing_ticket" || w.kind === "unranked"),
  ).toEqual([]);
});

test("ARK-290-AC6 the PRD links the roadmap and CONTEXT.md defines Roadmap, Milestone and Horizon", () => {
  const prd = readFileSync(join(root, "docs/prd.md"), "utf8");
  expect(prd).toContain("ROADMAP.md");
  expect(prd).toContain("(reference/roadmap.md)");
  expect(prd).not.toContain("## Milestones");
  expect(prd).not.toMatch(/^\| Ticket\s+\|/m);

  const context = readFileSync(join(root, "CONTEXT.md"), "utf8");
  for (const term of ["Roadmap", "Milestone", "Horizon"]) expect(context).toContain(`**${term}**:`);
});

test("ARK-290-AC7 typecheck, lint and format:check exit 0", async () => {
  for (const script of ["typecheck", "lint", "format:check"]) {
    const run = Bun.spawn(["bun", "run", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect({ script, code, output: code === 0 ? "" : out + err }).toEqual({
      script,
      code: 0,
      output: "",
    });
  }
});
