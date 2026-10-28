import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rechain } from "./ledger";
import { setKinds } from "./kinds";
import { OMP_CONFIG } from "./omp-config";
import { spawnArk } from "./tty";

setDefaultTimeout(60_000); // run start preflights through a subprocess of OMP's resolver; the multi-run tests make several calls
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
let gitconfig: string; // the approver's git identity, via GIT_CONFIG_GLOBAL
const runsDir = () => join(home, "projects", "demo", "runs");
const writeTicket = (id: string, acs: string[]) => {
  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  writeFileSync(join(home, "projects", "demo", "tickets", `${id}.md`), ticketMd(id, acs));
};
const ark = (...args: string[]) => {
  const r = spawnArk(["bun", CLI, ...args], {
    cwd: proj,
    env: { ...process.env, ARK_HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const runFolders = () => readdirSync(runsDir()).filter((r) => r !== ".locks");
const runId = (id: string) => runFolders().find((r) => r.includes(`-${id}-`))!;
const runFile = (id: string, f: string) => readFileSync(join(runsDir(), runId(id), f), "utf8");
const state = (id: string) => JSON.parse(runFile(id, "state.json"));
// A run past its start: the route is logged first, as the playbook requires.
const begin = (ticket: string) => {
  expect(ark("run", "start", ticket).code).toBe(0);
  const id = runId(ticket);
  expect(ark("log", "route", id, "ticket", "fixture").code).toBe(0);
  return id;
};

// Gate events are written only by `ark gate`, so tests that walk the lifecycle drive them through it.
const gated: Record<string, [gate: string, answer?: string]> = {
  "g0.opened": ["G0"], "g0.answered": ["G0", "accept"],
  "g1.opened": ["G1"], "g1.approved": ["G1", "approve"], "g1.changed": ["G1", "change"],
  "g2.opened": ["G2"], "g2.approved": ["G2", "approve"], "g2.rejected": ["G2", "send_back"],
  "ge.opened": ["GE"], "ge.answered": ["GE", "one_more_round"],
};
// The hash `ark gate packet` recorded for the gate's newest packet (gates/<gate>.<hash>.packet.md).
const packetHash = (id: string, gate: string): string =>
  readFileSync(join(runsDir(), id, "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .findLast((e) => e.type === "gate.packet" && e.data.gate === gate).data.packet_sha256;
const go = (id: string, event: string, data?: string) => {
  const [gate, answer] = gated[event] ?? [];
  if (gate === "GE" && !answer) writeFileSync(join(runsDir(), id, "premise.md"), "# premise\n"); // the packet's required input
  if (!gate) return ark("advance", id, event, ...(data ? ["--data", data] : []));
  if (answer) return ark("gate", "answer", id, gate, answer, "--packet", packetHash(id, gate));
  if (gate === "G1") {
    if (!existsSync(join(runsDir(), id, "plan.md"))) writeFileSync(join(runsDir(), id, "plan.md"), "# plan.md\n");
    setKinds(join(runsDir(), id));
  }
  if (gate === "G2") { // every AC is manual and signed, so the real trace-check passes
    const dir = join(runsDir(), id);
    const ids = (Bun.YAML.parse(readFileSync(join(dir, "ac.yml"), "utf8")) as { id: string; text: string }[]).map((a) => a.id);
    writeFileSync(join(dir, "ac.yml"), ids.map((i) => `- id: ${i}\n  text: t\n  level: manual\n  kind: new\n`).join("") || "[]\n");
    mkdirSync(join(dir, "manual"), { recursive: true });
    for (const i of ids) writeFileSync(join(dir, "manual", `${i}.md`), "signed-by: Gate Tester\nat: 2026-10-21\n");
    const t = ark("trace-check", id);
    if (t.code !== 0) return t;
  }
  return ark("gate", "packet", id, gate);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  proj = mkdtempSync(join(tmpdir(), "ark-proj-"));
  gitconfig = join(mkdtempSync(join(tmpdir(), "ark-git-")), "config");
  writeFileSync(gitconfig, "[user]\n\tname = Gate Tester\n\temail = gate@example.test\n");
  writeFileSync(join(proj, "ark.yml"), "project: demo\n");
  mkdirSync(join(proj, ".omp"));
  writeFileSync(join(proj, ".omp", "config.yml"), OMP_CONFIG);
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
    expect(dir).toBe(`${ledger[0].ts.slice(0, 10)}-ARK-901-1`);
    expect(readdirSync(join(runsDir(), dir)).sort()).toEqual([".main-session", "ac.yml", "ledger.ndjson", "state.json", "ticket.json", "ticket.md"]);
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
    expect(runFolders()).toEqual([]);

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
    const id = runId("ARK-901");
    expect(ark("log", "route", id, "ticket", "empty ticket fixture").code).toBe(0);
    expect(state("ARK-901")).toMatchObject({
      state: "awaiting_g0",
      status: "waiting_human",
      next_action: { kind: "answer_g0", agent: "human" },
      acs: {},
    });
    expect(runFile("ARK-901", "ledger.ndjson").trim().split("\n").map((l) => JSON.parse(l).type)).toEqual(["run.started", "route.chosen", "g0.opened"]);
  });
});

describe("ARK-103-AC3", () => {
  const fixtures = readdirSync(FIXTURES);

  // Copy a fixture ledger into a run folder named after its first event; returns the run id.
  const place = (name: string) => {
    const ledger = readFileSync(join(FIXTURES, name, "ledger.ndjson"), "utf8");
    const first = JSON.parse(ledger.split("\n")[0]);
    const id = `${first.ts.slice(0, 10)}-${first.data.ticket}-${first.data.n}`;
    mkdirSync(join(runsDir(), id), { recursive: true });
    cpSync(join(FIXTURES, name, "ledger.ndjson"), join(runsDir(), id, "ledger.ndjson"));
    return id;
  };

  // Hand-reviewed expectations, so the recorded state.json files are not just the code's own output echoed back.
  // lifecycle ends closed; fix-round's first event is on the 21st UTC but later events are on the 22nd (run_id uses the first);
  // no-ac opens G0 atomically with the route.
  const expected: Record<string, object> = {
    lifecycle: {
      run_id: "2026-10-21-ARK-901-1", state: "done", status: "done", outcome: "merged", next_action: null, ledger_seq: 10,
      gates: { G1: { answer: "approve", at: "2026-10-21T20:41:07Z" }, G2: { answer: "approve", at: "2026-10-22T08:00:00Z" } },
    },
    "fix-round": { run_id: "2026-10-21-ARK-902-1", state: "building", status: "active", round: 2, next_action: { kind: "continue_build", agent: "orchestrator" }, ledger_seq: 11 },
    "no-ac": { run_id: "2026-10-21-ARK-903-1", state: "awaiting_g0", status: "waiting_human", next_action: { kind: "answer_g0", agent: "human" }, acs: {}, ledger_seq: 3 },
  };

  for (const name of fixtures) {
    test(`fixture ledger '${name}' replays to the recorded state.json byte for byte`, () => {
      const id = place(name);
      expect(JSON.parse(readFileSync(join(FIXTURES, name, "state.json"), "utf8"))).toMatchObject(expected[name]);
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
    const id = begin("ARK-901");
    for (const e of ["analysis.completed", "g1.opened", "g1.approved", "build.started", "build.completed", "fix_round.started"]) {
      expect(go(id, e, '{"n":1}').code).toBe(0);
    }
    const written = runFile("ARK-901", "state.json");
    expect(ark("run", "replay", id, "--check").code).toBe(0);
    expect(ark("run", "replay", id).code).toBe(0);
    expect(runFile("ARK-901", "state.json")).toBe(written);
    expect(state("ARK-901")).toMatchObject({ state: "building", ledger_seq: 8 });
  });

  test("a ledger with a gap in seq or an event illegal for its state is rejected by replay", () => {
    const id = place("lifecycle");
    const path = join(runsDir(), id, "ledger.ndjson");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${[lines[0], lines[2]].join("\n")}\n`); // seq jumps 1 -> 3
    expect(ark("run", "replay", id).code).toBe(1);
    writeFileSync(path, `${[lines[0], lines[4].replace('"seq":5', '"seq":2')].join("\n")}\n`); // build.started in intake
    rechain(join(runsDir(), id)); // a hand-built ledger whose chain holds, so replay reaches the state machine
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
    ["awaiting_ge", ["a"], [...toJudging, "fix_round.started", "build.completed", "fix_round.started", "build.completed", "ge.opened"], "g2.approved"], // escalation opens only once the two-round budget is spent
    ["escalating", ["a"], [...toJudging, "fix_round.started", "build.completed", "fix_round.started", "build.completed", "g2.opened", "g2.rejected"], "g2.opened"], // a send-back past the budget: only the GE packet or abort follows
    ["awaiting_g2", ["a"], toG2, "build.completed"],
    ["mrs_open", ["a"], [...toG2, "g2.approved"], "build.started"],
    ["aborted", ["a"], ["abort"], "abort"],
  ];

  // Every file in the run folder with its bytes and mtime.
  const snapshot = (dir: string) =>
    (readdirSync(dir, { recursive: true }) as string[]).sort().filter((f) => statSync(join(dir, f)).isFile())
      .map((f) => [f, readFileSync(join(dir, f), "utf8"), statSync(join(dir, f)).mtimeMs]);

  for (const [name, acs, path, illegal] of cases) {
    test(`${name}: '${illegal}' is refused with a reason and changes no file`, async () => {
      writeTicket("ARK-901", acs);
      const id = begin("ARK-901");
      for (const e of path) expect(go(id, e).code, e).toBe(0);
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

  for (const [name, acs, path] of cases.filter((c) => !["mrs_open", "aborted"].includes(c[0]))) { // aborted is the outcome before any MR exists: mrs_open has its own exit
    test(`${name}: abort is legal, closes the run, and a closed run accepts nothing`, () => {
      writeTicket("ARK-901", acs);
      const id = begin("ARK-901");
      for (const e of path) go(id, e);
      const out = ark("advance", id, "abort", "--data", '{"reason":"stop"}');
      expect(out.code, out.err).toBe(0);
      expect(state("ARK-901")).toMatchObject({ state: "aborted", status: "aborted", outcome: "aborted", next_action: null });
      expect(ark("advance", id, "analysis.completed").err).toContain("closed");
    });
  }

  test("every legal edge of the lifecycle is accepted", () => {
    writeTicket("ARK-901", ["a"]);
    const id = begin("ARK-901");
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
      ["fix_round.started", "building"],
      ["build.completed", "judging"],
      ["ge.opened", "awaiting_ge"],
      ["ge.answered", "building"],
      ["build.completed", "judging"],
      ["g2.opened", "awaiting_g2"],
      ["g2.rejected", "escalating"], // the budget is spent: a send-back leads only to escalation
      ["ge.opened", "awaiting_ge"],
      ["ge.answered", "building"],
      ["build.completed", "judging"],
      ["g2.opened", "awaiting_g2"],
      ["g2.approved", "mrs_open"],
    ];
    for (const [event, to] of walk) {
      expect(go(id, event).code, event).toBe(0);
      expect(state("ARK-901").state).toBe(to);
    }
  });
});

describe("ARK-103-AC5", () => {
  test("every state written carries a computed next_action naming who acts", () => {
    writeTicket("ARK-901", ["a"]);
    const id = begin("ARK-901");
    // [event, state reached, who acts per the PRD state table]
    const steps: [string, string, string][] = [
      ["g0.opened", "awaiting_g0", "human"],
      ["g0.answered", "intake", "orchestrator"],
      ["analysis.completed", "analyzed", "orchestrator"],
      ["g1.opened", "awaiting_g1", "human"],
      ["g1.approved", "approved", "orchestrator"],
      ["build.started", "building", "orchestrator"],
      ["build.completed", "judging", "orchestrator"],
      ["fix_round.started", "building", "orchestrator"],
      ["build.completed", "judging", "orchestrator"],
      ["fix_round.started", "building", "orchestrator"],
      ["build.completed", "judging", "orchestrator"],
      ["ge.opened", "awaiting_ge", "human"],
      ["ge.answered", "building", "orchestrator"],
      ["build.completed", "judging", "orchestrator"],
      ["g2.opened", "awaiting_g2", "human"],
      ["g2.approved", "mrs_open", "human"],
    ];
    expect(state("ARK-901").next_action).toMatchObject({ kind: expect.any(String), agent: "orchestrator" });
    for (const [event, to, who] of steps) {
      go(id, event);
      const s = state("ARK-901");
      expect(s.state).toBe(to);
      expect(s.next_action).toMatchObject({ kind: expect.stringMatching(/\S/), agent: who });
      expect(s.status).toBe(who === "human" ? "waiting_human" : "active");
    }
  });
});

describe("ARK-103-AC6", () => {
  test("starting a ticket that already has a run resumes it: no second run, nothing rewritten, current state shown", () => {
    writeTicket("ARK-901", ["a"]);
    const id = begin("ARK-901");
    ark("advance", id, "analysis.completed");
    const dir = join(runsDir(), id);
    const before = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]);

    const again = ark("run", "start", "ARK-901");
    expect(again.code).toBe(0);
    expect(again.out).toContain(`resumed ${id}`);
    expect(again.out).toContain("state: analyzed");
    expect(runFolders()).toEqual([id]);
    expect(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")])).toEqual(before);
  });

  test("a run for a different ticket does not count as an existing run", () => {
    writeTicket("ARK-901", ["a"]);
    writeTicket("ARK-91", ["a"]);
    ark("run", "start", "ARK-901");
    expect(ark("run", "start", "ARK-91").out).toStartWith("started ");
    expect(runFolders().length).toBe(2);
  });
});

describe("ARK-117-AC1", () => {
  const folders = () => runFolders().sort();

  test("run ids are <date>-<ticket>-<n>; start resumes the open run and starts run n+1 once every earlier run is closed", () => {
    writeTicket("ARK-901", ["a"]);
    expect(ark("run", "start", "ARK-901").out).toMatch(/^started \d{4}-\d{2}-\d{2}-ARK-901-1\n/);
    const [first] = folders();
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}-ARK-901-1$/);
    expect(state("ARK-901").run_id).toBe(first);

    expect(ark("run", "start", "ARK-901").out).toContain(`resumed ${first}`); // run 1 is open
    expect(folders()).toEqual([first]);

    expect(ark("log", "route", first, "ticket", "fixture").code).toBe(0);
    expect(ark("advance", first, "abort").code).toBe(0);
    const again = ark("run", "start", "ARK-901");
    expect(again.out).toMatch(/^started \d{4}-\d{2}-\d{2}-ARK-901-2\n/);
    const second = folders().find((f) => f !== first)!;
    expect(second).toEndWith("-ARK-901-2");
    expect(JSON.parse(readFileSync(join(runsDir(), second, "state.json"), "utf8"))).toMatchObject({ run_id: second, state: "intake" });
    expect(JSON.parse(readFileSync(join(runsDir(), first, "state.json"), "utf8"))).toMatchObject({ state: "aborted", outcome: "aborted" });

    expect(ark("run", "start", "ARK-901").out).toContain(`resumed ${second}`); // the newest run is the open one
    expect(folders().length).toBe(2);
  });

});

describe("ARK-120-AC8", () => {
  test("until a route is logged, nothing but route.chosen is legal: not a step, not an abort, not a packet", () => {
    writeTicket("ARK-901", ["a"]);
    ark("run", "start", "ARK-901");
    const id = runId("ARK-901");
    const before = runFile("ARK-901", "ledger.ndjson");
    for (const args of [["advance", id, "analysis.completed"], ["advance", id, "abort"], ["gate", "packet", id, "G0"]]) {
      const r = ark(...args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err, args.join(" ")).toContain("route.chosen");
    }
    expect(runFile("ARK-901", "ledger.ndjson")).toBe(before);
    expect(ark("log", "route", id, "ticket", "fixture").code).toBe(0);
    expect(ark("advance", id, "analysis.completed").code).toBe(0);
  });

  test("an empty-AC ticket opens G0 only once the route is logged", () => {
    writeTicket("ARK-902", []);
    ark("run", "start", "ARK-902");
    const id = runId("ARK-902");
    const before = runFile("ARK-902", "ledger.ndjson");
    for (const args of [["gate", "packet", id, "G0"], ["advance", id, "g0.opened"]]) {
      const r = ark(...args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err, args.join(" ")).toContain("route.chosen");
    }
    expect(runFile("ARK-902", "ledger.ndjson")).toBe(before);
    expect(ark("log", "route", id, "ticket", "fixture").code).toBe(0);
    expect(state("ARK-902")).toMatchObject({ state: "awaiting_g0", status: "waiting_human" });
    expect(ark("gate", "packet", id, "G0").code).toBe(0);
  });

  test("a ledger whose second event is not route.chosen is not a legal run", () => {
    writeTicket("ARK-901", ["a"]);
    ark("run", "start", "ARK-901");
    const id = runId("ARK-901");
    ark("log", "route", id, "ticket", "fixture");
    const path = join(runsDir(), id, "ledger.ndjson");
    const [started, route] = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${started}\n${route.replace("route.chosen", "analysis.completed")}\n`);
    rechain(join(runsDir(), id));
    const r = ark("run", "replay", id, "--check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("route.chosen");
  });
});

describe("ARK-120-AC11", () => {
  test("concurrent starts after a closed run allocate or resume one unique next number", async () => {
    writeTicket("ARK-901", ["a"]);
    const first = begin("ARK-901");
    expect(ark("advance", first, "abort").code).toBe(0);
    const start = () => Bun.spawn(["bun", CLI, "run", "start", "ARK-901"], {
      cwd: proj,
      env: { ...process.env, ARK_HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", PI_SESSION_ID: "ark-main-session", PI_SESSION_FILE: join(home, "test-main-session.jsonl") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const calls = [start(), start()];
    const outputs = await Promise.all(calls.map(async (proc) => {
      const [code, out, err] = await Promise.all([proc.exited, Bun.readableStreamToText(proc.stdout), Bun.readableStreamToText(proc.stderr)]);
      return { code, out, err };
    }));
    expect(outputs.map((r) => r.code)).toEqual([0, 0]);
    expect(outputs.map((r) => r.out).join("")).toMatch(/(?:started|resumed) \d{4}-\d{2}-\d{2}-ARK-901-2/);
    expect(runFolders().filter((dir) => dir.endsWith("-ARK-901-2"))).toHaveLength(1);
    expect(runFolders()).toHaveLength(2); // no run 3
  });
});

describe("ARK-117-AC10", () => {
  test("run start says whether the route is logged: route: none until ark log route, on a new run and on a resumed one", () => {
    writeTicket("ARK-901", ["a"]);
    const fresh = ark("run", "start", "ARK-901");
    const id = runId("ARK-901");
    expect(fresh.out).toContain(`route: none (log it: ark log route ${id} <playbook> "<why>")`);
    expect(ark("run", "start", "ARK-901").out).toContain("route: none"); // resumed before the route was logged

    expect(ark("log", "route", id, "ticket", "new behavior").code).toBe(0);
    const resumed = ark("run", "start", "ARK-901");
    expect(resumed.out).toContain("resumed ");
    expect(resumed.out).toContain("route: ticket");
    expect(resumed.out).not.toContain("route: none");
  });
});
