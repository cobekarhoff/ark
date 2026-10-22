import { beforeEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cli", "ark.ts");
const FIXTURES = join(import.meta.dir, "fixtures", "ledgers");
const schema = (name: string) => Bun.file(join(import.meta.dir, "..", "schemas", `${name}.schema.json`)).json();

const TRICKY = 'Quote "this": colons, # hash and \'apples\' stay verbatim';
const ticketMd = (id: string, acs: string[]) => `---
id: ${id}
title: "Fixture ticket"
status: ready
milestone: M1a
traces: [FR-01]
depends_on: [ARK-102]
${acs.length ? `acceptance_criteria:\n${acs.map((t, i) => `  - id: ${id}-AC${i + 1}\n    text: ${JSON.stringify(t)}`).join("\n")}` : "acceptance_criteria: []"}
---
Body line one.

Body line two.
`;

let home: string;
let proj: string; // cwd: a project directory holding ark.yml
const runsDir = () => join(home, "projects", "demo", "runs");
const writeTicket = (id: string, acs: string[]) => {
  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  writeFileSync(join(home, "projects", "demo", "tickets", `${id}.md`), ticketMd(id, acs));
};
const ark = (...args: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: proj, env: { ...process.env, ARK_HOME: home } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const runId = (id: string) => readdirSync(runsDir()).find((r) => r.endsWith(`-${id}`))!;
const runFile = (id: string, f: string) => readFileSync(join(runsDir(), runId(id), f), "utf8");
const state = (id: string) => JSON.parse(runFile(id, "state.json"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  proj = mkdtempSync(join(tmpdir(), "ark-proj-"));
  writeFileSync(join(proj, "ark.yml"), "project: demo\n");
  mkdirSync(join(proj, "sub", "deeper"), { recursive: true });
});

describe("ARK-103-AC1", () => {
  test("run start stores the ticket unchanged and writes ticket.json, ac.yml, ledger.ndjson, state.json under the project's runs folder", async () => {
    writeTicket("ARK-901", ["First", "Second"]);
    // nested cwd: project is found by walking up to the nearest ark.yml
    proj = join(proj, "sub", "deeper");
    const r = ark("run", "start", "ARK-901");
    expect(r.code).toBe(0);

    const dir = runId("ARK-901");
    const ledger = runFile("ARK-901", "ledger.ndjson").trim().split("\n").map((l) => JSON.parse(l));
    expect(dir).toBe(`${ledger[0].ts.slice(0, 10)}-ARK-901`);
    expect(readdirSync(join(runsDir(), dir)).sort()).toEqual(["ac.yml", "ledger.ndjson", "state.json", "ticket.json", "ticket.md"]);
    expect(runFile("ARK-901", "ticket.md")).toBe(ticketMd("ARK-901", ["First", "Second"]));
    expect(JSON.parse(runFile("ARK-901", "ticket.json"))).toEqual({
      id: "ARK-901",
      title: "Fixture ticket",
      source: "local",
      status: "ready",
      milestone: "M1a",
      traces: ["FR-01"],
      depends_on: ["ARK-102"],
      acceptance_criteria: [
        { id: "ARK-901-AC1", text: "First" },
        { id: "ARK-901-AC2", text: "Second" },
      ],
      body: "Body line one.\n\nBody line two.\n",
    });

    const ajv = new Ajv2020();
    expect(ajv.validate(await schema("ticket"), JSON.parse(runFile("ARK-901", "ticket.json"))), ajv.errorsText()).toBe(true);
    expect(ajv.validate(await schema("ac"), Bun.YAML.parse(runFile("ARK-901", "ac.yml"))), ajv.errorsText()).toBe(true);
    expect(ajv.validate(await schema("state"), state("ARK-901")), ajv.errorsText()).toBe(true);
    for (const e of ledger) expect(ajv.validate(await schema("ledger-event"), e), ajv.errorsText()).toBe(true);
    expect(ledger.map((e) => e.seq)).toEqual([1]);
    expect(ledger[0].type).toBe("run.started");
    expect(state("ARK-901")).toMatchObject({ run_id: dir, ticket: "ARK-901", state: "intake", ledger_seq: 1 });
  });

  test("a missing ticket, a malformed ticket, or no ark.yml fails with exit 1 and creates no run", () => {
    expect(ark("run", "start", "ARK-404").code).toBe(1);
    mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
    writeFileSync(join(home, "projects", "demo", "tickets", "ARK-902.md"), "---\nid: ARK-902\n---\n");
    const bad = ark("run", "start", "ARK-902");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("frontmatter");
    expect(readdirSync(join(home, "projects", "demo")).sort()).toEqual(["tickets"]);

    const lost = mkdtempSync(join(tmpdir(), "ark-noyml-"));
    proj = lost;
    const r = ark("run", "start", "ARK-902");
    expect(r.code).toBe(1);
    expect(r.err).toContain("ark.yml");
  });
});

describe("ARK-103-AC2", () => {
  test("every AC keeps its ID and verbatim text in ticket.json and ac.yml", () => {
    writeTicket("ARK-901", [TRICKY, "second: one"]);
    ark("run", "start", "ARK-901");
    const expected = [
      { id: "ARK-901-AC1", text: TRICKY },
      { id: "ARK-901-AC2", text: "second: one" },
    ];
    expect(Bun.YAML.parse(runFile("ARK-901", "ac.yml"))).toEqual(expected);
    expect(JSON.parse(runFile("ARK-901", "ticket.json")).acceptance_criteria).toEqual(expected);
    expect(Object.keys(state("ARK-901").acs)).toEqual(["ARK-901-AC1", "ARK-901-AC2"]);
  });

  test("a ticket with no acceptance criteria makes the run open G0 and wait for a human", () => {
    writeTicket("ARK-901", []);
    const r = ark("run", "start", "ARK-901");
    expect(r.code).toBe(0);
    expect(state("ARK-901")).toMatchObject({
      state: "awaiting_g0",
      status: "waiting_human",
      next_action: { kind: "answer_g0", agent: "human" },
      acs: {},
    });
    expect(runFile("ARK-901", "ledger.ndjson").trim().split("\n").map((l) => JSON.parse(l).type)).toEqual(["run.started", "g0.opened"]);
  });
});

describe("ARK-103-AC3", () => {
  const fixtures = readdirSync(FIXTURES);

  // Copy a fixture ledger into a run folder named after its first event; returns the run id.
  const place = (name: string) => {
    const ledger = readFileSync(join(FIXTURES, name, "ledger.ndjson"), "utf8");
    const first = JSON.parse(ledger.split("\n")[0]);
    const id = `${first.ts.slice(0, 10)}-${first.data.ticket}`;
    mkdirSync(join(runsDir(), id), { recursive: true });
    cpSync(join(FIXTURES, name, "ledger.ndjson"), join(runsDir(), id, "ledger.ndjson"));
    return id;
  };

  for (const name of fixtures) {
    test(`fixture ledger '${name}' replays to the recorded state.json byte for byte`, () => {
      const id = place(name);
      const target = join(runsDir(), id, "state.json");
      expect(ark("run", "replay", id).code).toBe(0);
      expect(readFileSync(target)).toEqual(readFileSync(join(FIXTURES, name, "state.json")));
      expect(ark("run", "replay", id, "--check").code).toBe(0);
    });

    test(`fixture ledger '${name}': --check exits 1 when state.json is stale or missing, and does not rewrite it`, () => {
      const id = place(name);
      const target = join(runsDir(), id, "state.json");
      expect(ark("run", "replay", id, "--check").code).toBe(1); // missing
      writeFileSync(target, readFileSync(join(FIXTURES, name, "state.json"), "utf8").replace("ledger_seq", "ledger_seqq"));
      const before = readFileSync(target);
      expect(ark("run", "replay", id, "--check").code).toBe(1);
      expect(readFileSync(target)).toEqual(before);
    });
  }

  test("a run driven through the CLI has a state.json identical to its replay", () => {
    writeTicket("ARK-901", ["First"]);
    ark("run", "start", "ARK-901");
    const id = runId("ARK-901");
    for (const e of ["analysis.completed", "g1.opened", "g1.approved", "build.started", "build.completed", "fix_round.started"]) {
      expect(ark("advance", id, e, "--data", '{"n":1}').code).toBe(0);
    }
    const written = runFile("ARK-901", "state.json");
    expect(ark("run", "replay", id, "--check").code).toBe(0);
    expect(ark("run", "replay", id).code).toBe(0);
    expect(runFile("ARK-901", "state.json")).toBe(written);
    expect(state("ARK-901")).toMatchObject({ state: "building", ledger_seq: 7 });
  });

  test("a ledger with a gap in seq or an event illegal for its state is rejected by replay", () => {
    const id = place("lifecycle");
    const path = join(runsDir(), id, "ledger.ndjson");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${[lines[0], lines[2]].join("\n")}\n`); // seq jumps 1 -> 3
    expect(ark("run", "replay", id).code).toBe(1);
    writeFileSync(path, `${[lines[0], lines[4].replace('"seq":5', '"seq":2')].join("\n")}\n`); // build.started in intake
    const r = ark("run", "replay", id);
    expect(r.code).toBe(1);
    expect(r.err).toContain("illegal");
  });
});

describe("ARK-103-AC4", () => {
  // Hand-written path to each state and one event that is illegal there (from the PRD lifecycle, not from the code under test).
  const toBuilding = ["analysis.completed", "g1.opened", "g1.approved", "build.started"];
  const toJudging = [...toBuilding, "build.completed"];
  const toG2 = [...toJudging, "g2.opened"];
  const cases: [state: string, acs: string[], path: string[], illegal: string][] = [
    ["intake", ["a"], [], "build.started"],
    ["awaiting_g0", [], [], "g1.approved"],
    ["analyzed", ["a"], ["analysis.completed"], "g1.approved"],
    ["awaiting_g1", ["a"], ["analysis.completed", "g1.opened"], "build.started"],
    ["approved", ["a"], ["analysis.completed", "g1.opened", "g1.approved"], "g1.approved"],
    ["building", ["a"], toBuilding, "build.started"],
    ["judging", ["a"], toJudging, "build.completed"],
    ["awaiting_ge", ["a"], [...toJudging, "ge.opened"], "g2.approved"],
    ["awaiting_g2", ["a"], toG2, "ge.answered"],
    ["mrs_open", ["a"], [...toG2, "g2.approved"], "build.started"],
    ["done", ["a"], [...toG2, "g2.approved", "run.completed"], "abort"],
    ["aborted", ["a"], ["abort"], "abort"],
  ];

  // Every file in the run folder with its bytes and mtime.
  const snapshot = (dir: string) =>
    readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), "utf8"), statSync(join(dir, f)).mtimeMs]);

  for (const [name, acs, path, illegal] of cases) {
    test(`${name}: '${illegal}' is refused with a reason and changes no file`, async () => {
      writeTicket("ARK-901", acs);
      ark("run", "start", "ARK-901");
      const id = runId("ARK-901");
      for (const e of path) expect(ark("advance", id, e).code, e).toBe(0);
      expect(state("ARK-901").state).toBe(name);

      const before = snapshot(join(runsDir(), id));
      await Bun.sleep(20); // real clock on purpose: mtime is filesystem state a fake timer cannot move
      for (const bad of [illegal, "no.such.event"]) {
        const r = ark("advance", id, bad);
        expect(r.code).toBe(1);
        expect(r.err).toContain(`'${bad}'`);
        expect(r.err).toContain(`'${name}'`);
      }
      expect(ark("advance", id, "g1.approved", "--data", "{oops").code).toBe(1);
      expect(snapshot(join(runsDir(), id))).toEqual(before);
    });
  }

  for (const [name, acs, path] of cases.filter((c) => !["done", "aborted"].includes(c[0]))) {
    test(`${name}: abort is legal, closes the run, and a closed run accepts nothing`, () => {
      writeTicket("ARK-901", acs);
      ark("run", "start", "ARK-901");
      const id = runId("ARK-901");
      for (const e of path) ark("advance", id, e);
      const out = ark("advance", id, "abort", "--data", '{"reason":"stop"}');
      expect(out.code, out.err).toBe(0);
      expect(state("ARK-901")).toMatchObject({ state: "aborted", status: "aborted", next_action: null });
      expect(ark("advance", id, "analysis.completed").err).toContain("closed");
    });
  }

  test("every legal edge of the lifecycle is accepted", () => {
    writeTicket("ARK-901", ["a"]);
    ark("run", "start", "ARK-901");
    const id = runId("ARK-901");
    const walk: [string, string][] = [
      ["g0.opened", "awaiting_g0"],
      ["g0.answered", "intake"],
      ["analysis.completed", "analyzed"],
      ["g1.opened", "awaiting_g1"],
      ["g1.changed", "analyzed"],
      ["g1.opened", "awaiting_g1"],
      ["g1.approved", "approved"],
      ["build.started", "building"],
      ["build.completed", "judging"],
      ["fix_round.started", "building"],
      ["build.completed", "judging"],
      ["ge.opened", "awaiting_ge"],
      ["ge.answered", "building"],
      ["build.completed", "judging"],
      ["g2.opened", "awaiting_g2"],
      ["g2.rejected", "building"],
      ["build.completed", "judging"],
      ["g2.opened", "awaiting_g2"],
      ["g2.approved", "mrs_open"],
      ["run.completed", "done"],
    ];
    for (const [event, to] of walk) {
      expect(ark("advance", id, event).code, event).toBe(0);
      expect(state("ARK-901").state).toBe(to);
    }
  });
});

describe("ARK-103-AC5", () => {
  test("every state written carries a computed next_action naming who acts, null only when closed", () => {
    writeTicket("ARK-901", ["a"]);
    ark("run", "start", "ARK-901");
    const id = runId("ARK-901");
    // [event, state reached, who acts per the PRD state table]
    const steps: [string, string, string | null][] = [
      ["g0.opened", "awaiting_g0", "human"],
      ["g0.answered", "intake", "orchestrator"],
      ["analysis.completed", "analyzed", "orchestrator"],
      ["g1.opened", "awaiting_g1", "human"],
      ["g1.approved", "approved", "orchestrator"],
      ["build.started", "building", "orchestrator"],
      ["build.completed", "judging", "orchestrator"],
      ["ge.opened", "awaiting_ge", "human"],
      ["ge.answered", "building", "orchestrator"],
      ["build.completed", "judging", "orchestrator"],
      ["g2.opened", "awaiting_g2", "human"],
      ["g2.approved", "mrs_open", "human"],
      ["run.completed", "done", null],
    ];
    expect(state("ARK-901").next_action).toMatchObject({ kind: expect.any(String), agent: "orchestrator" });
    for (const [event, to, who] of steps) {
      ark("advance", id, event);
      const s = state("ARK-901");
      expect(s.state).toBe(to);
      if (who === null) expect(s.next_action).toBeNull();
      else expect(s.next_action).toMatchObject({ kind: expect.stringMatching(/\S/), agent: who });
      expect(s.status).toBe(who === "human" ? "waiting_human" : who === null ? "done" : "active");
    }
  });
});

describe("ARK-103-AC6", () => {
  test("starting a ticket that already has a run resumes it: no second run, nothing rewritten, current state shown", () => {
    writeTicket("ARK-901", ["a"]);
    expect(ark("run", "start", "ARK-901").out).toStartWith("started ");
    const id = runId("ARK-901");
    ark("advance", id, "analysis.completed");
    const dir = join(runsDir(), id);
    const before = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]);

    const again = ark("run", "start", "ARK-901");
    expect(again.code).toBe(0);
    expect(again.out).toContain(`resumed ${id}`);
    expect(again.out).toContain("state: analyzed");
    expect(readdirSync(runsDir())).toEqual([id]);
    expect(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")])).toEqual(before);
  });

  test("a run for a different ticket does not count as an existing run", () => {
    writeTicket("ARK-901", ["a"]);
    writeTicket("ARK-91", ["a"]);
    ark("run", "start", "ARK-901");
    expect(ark("run", "start", "ARK-91").out).toStartWith("started ");
    expect(readdirSync(runsDir()).length).toBe(2);
  });
});
