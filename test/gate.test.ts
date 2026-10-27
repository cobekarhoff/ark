import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setKinds } from "./kinds";
import { OMP_CONFIG } from "./omp-config";
import { spawnArk } from "./tty";

const CLI = join(import.meta.dir, "..", "cli", "ark.ts");

let home: string;
let proj: string;
let gitconfig: string;
let id: string;
const runPath = (...p: string[]) => join(home, "projects", "demo", "runs", id, ...p);
const read = (f: string) => readFileSync(runPath(f), "utf8");
const ledger = () => read("ledger.ndjson").trim().split("\n").map((l) => JSON.parse(l));
const state = () => JSON.parse(read("state.json"));
const ark = (...args: string[]) => {
  const r = spawnArk(["bun", CLI, ...args], {
    cwd: proj,
    env: { ...process.env, ARK_HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const sha = (bytes: Uint8Array | string) => `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;

const startRun = (acs: string[]) => {
  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  const list = acs.length ? `acceptance_criteria:\n${acs.map((t, i) => `  - id: ARK-950-AC${i + 1}\n    text: "${t}"`).join("\n")}` : "acceptance_criteria: []";
  writeFileSync(join(home, "projects", "demo", "tickets", "ARK-950.md"), `---\nid: ARK-950\ntitle: "Gate fixture"\nstatus: ready\n${list}\n---\nTicket body marker.\n`);
  expect(ark("run", "start", "ARK-950").code).toBe(0);
  id = readdirSync(join(home, "projects", "demo", "runs"))[0];
};
const advance = (event: string) => expect(ark("advance", id, event).code, event).toBe(0);
const packet = (gate: string) => ark("gate", "packet", id, gate);
const answer = (gate: string, a: string, hash: string) => ark("gate", "answer", id, gate, a, "--packet", hash);
const hashOf = (r: { out: string }) => r.out.trim();

// The three places a run can wait, each reached through the real CLI. Return the packet hash.
const atG0 = () => (startRun([]), hashOf(packet("G0")));
const atG1 = () => {
  startRun(["First", "Second"]);
  advance("analysis.completed");
  writeFileSync(runPath("plan.md"), "# Plan marker\n");
  setKinds(runPath());
  return hashOf(packet("G1"));
};
const toJudging = () => {
  const h = atG1();
  expect(answer("G1", "approve", h).code).toBe(0);
  advance("build.started");
  advance("build.completed");
};
// Both ACs manual and signed, so the real trace-check passes without a worktree.
const signOff = () => {
  const ids = ["ARK-950-AC1", "ARK-950-AC2"];
  writeFileSync(runPath("ac.yml"), ids.map((i) => `- id: ${i}\n  text: t\n  level: manual\n  kind: new\n`).join(""));
  mkdirSync(runPath("manual"), { recursive: true });
  for (const i of ids) writeFileSync(runPath("manual", `${i}.md`), "signed-by: Gate Tester\nat: 2026-10-21\n");
  expect(ark("trace-check", id).code).toBe(0);
};
const atG2 = () => {
  toJudging();
  signOff();
  return hashOf(packet("G2"));
};
const reach = { G0: atG0, G1: atG1, G2: atG2 };

// Every file in the run folder with bytes and mtime, so "refused" can mean "changed nothing".
const snapshot = () =>
  (readdirSync(runPath(), { recursive: true }) as string[]).sort().filter((f) => statSync(runPath(f)).isFile())
    .map((f) => [f, read(f), statSync(runPath(f)).mtimeMs]);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  proj = mkdtempSync(join(tmpdir(), "ark-proj-"));
  gitconfig = join(mkdtempSync(join(tmpdir(), "ark-git-")), "config");
  writeFileSync(gitconfig, "[user]\n\tname = Gate Tester\n\temail = gate@example.test\n");
  writeFileSync(join(proj, "ark.yml"), "project: demo\n");
  mkdirSync(join(proj, ".omp"));
  writeFileSync(join(proj, ".omp", "config.yml"), OMP_CONFIG);
});

const packetFile = (gate: string, h: string) => `gates/${gate}.${h.slice("sha256:".length)}.packet.md`;

describe("ARK-104-AC1", () => {
  test("G1 packet holds plan.md and ac.yml, its sha256 is printed and recorded, state moves to awaiting_g1", () => {
    const h = atG1();
    const file = read(packetFile("G1", h));
    expect(h).toBe(sha(file)); // the printed hash is the hash of the file on disk
    expect(file).toContain("# Plan marker");
    expect(file).toContain("ARK-950-AC2");
    expect(ledger().at(-1)).toMatchObject({ type: "gate.packet", data: { gate: "G1", path: packetFile("G1", h), packet_sha256: h } });
    expect(state()).toMatchObject({ state: "awaiting_g1", status: "waiting_human" });
  });

  test("the same artifacts give the same packet hash after a change round", () => {
    const h = atG1();
    expect(answer("G1", "change", h).code).toBe(0);
    expect(hashOf(packet("G1"))).toBe(h);
  });

  test("G0 packet holds the ticket, ac.yml and what is missing, and the run stays in awaiting_g0", () => {
    const h = atG0();
    const file = read(packetFile("G0", h));
    expect(h).toBe(sha(file));
    expect(file).toContain("Ticket body marker.");
    expect(file).toContain("the ticket has none");
    expect(state().state).toBe("awaiting_g0");
  });

  test("G2 packet holds the trace matrix and lists the test evidence files that exist, sorted", () => {
    toJudging();
    signOff();
    mkdirSync(runPath("artifacts", "logs"), { recursive: true });
    writeFileSync(runPath("artifacts", "logs", "red.txt"), "red");
    writeFileSync(runPath("artifacts", "junit.xml"), "<x/>");
    const h = hashOf(packet("G2"));
    expect(read(packetFile("G2", h))).toContain("| ARK-950-AC1 | new | manual | signed-by Gate Tester at 2026-10-21 |");
    expect(read(packetFile("G2", h))).toMatch(/- artifacts\/junit\.xml \(sha256:[0-9a-f]{64}\)\n- artifacts\/logs\/red\.txt \(sha256:[0-9a-f]{64}\)/);
    expect(state().state).toBe("awaiting_g2");
  });

  test("a missing required artifact exits 1 naming it and changes nothing", () => {
    toJudging();
    const before = snapshot();
    const r = packet("G2");
    expect(r.code).toBe(1);
    expect(r.err).toContain("trace-matrix.md");
    expect(snapshot()).toEqual(before);
  });

  test("a packet in the wrong state, or for an unknown gate, is refused", () => {
    startRun(["First"]);
    advance("analysis.completed");
    expect(packet("G2").err).toContain("state 'analyzed'");
    expect(packet("G9").code).toBe(1);
    const noPlan = packet("G1");
    expect(noPlan.code).toBe(1);
    expect(noPlan.err).toContain("plan.md");
  });
});

describe("ARK-104-AC2", () => {
  test("answer records gate, answer, approver from OS and git identity, timestamp and packet hash in the ledger and state", () => {
    const h = atG1();
    const r = answer("G1", "approve", h);
    expect(r.code, r.err).toBe(0);
    const e = ledger().at(-1);
    expect(e).toMatchObject({
      type: "gate.answered",
      data: {
        gate: "G1", answer: "approve", packet_sha256: h,
        os_user: userInfo().username, git_name: "Gate Tester", git_email: "gate@example.test",
        by: `Gate Tester <gate@example.test> (${userInfo().username})`,
      },
    });
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(state().gates.G1).toEqual({ answer: "approve", by: e.data.by, at: e.ts, packet_sha256: h });
    expect(ark("run", "replay", id, "--check").code).toBe(0);
  });

  // The fixed answer set per gate and where each answer sends the run (PRD "Gates and loop policy" and state table).
  const answers: [gate: "G0" | "G1" | "G2", answer: string, to: string][] = [
    ["G0", "accept", "intake"], ["G0", "edit", "awaiting_g0"], ["G0", "abort", "aborted"],
    ["G1", "approve", "approved"], ["G1", "change", "analyzed"], ["G1", "abort", "aborted"],
    ["G2", "approve", "mrs_open"], ["G2", "send_back", "building"], ["G2", "abort", "aborted"],
  ];
  for (const [gate, a, to] of answers) {
    test(`${gate} ${a} moves the run to ${to}`, () => {
      const h = reach[gate]();
      expect(answer(gate, a, h).code).toBe(0);
      expect(state()).toMatchObject({ state: to, gates: { [gate]: { answer: a } } });
    });
  }

  test("an answer outside the gate's fixed set is refused and changes nothing", () => {
    const h = atG1();
    const before = snapshot();
    for (const bad of ["accept", "send_back", "bogus", ""]) {
      const r = answer("G1", bad, h);
      expect(r.code, bad).toBe(1);
      expect(r.err).toContain("approve, change, abort");
    }
    expect(snapshot()).toEqual(before);
  });

  test("an answer without a git identity is refused", () => {
    const h = atG1();
    writeFileSync(gitconfig, "");
    const before = snapshot();
    const r = answer("G1", "approve", h);
    expect(r.code).toBe(1);
    expect(r.err).toContain("user.name");
    expect(snapshot()).toEqual(before);
  });

  test("answering a gate that has no packet is refused", () => {
    startRun([]); // awaiting_g0, never packeted
    const r = answer("G0", "accept", `sha256:${"0".repeat(64)}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no packet");
  });
});

describe("ARK-104-AC3", () => {
  const closedBefore = (run: () => void) => {
    const before = snapshot();
    run();
    expect(snapshot()).toEqual(before);
  };

  test("G1: no step after the gate runs until G1 is approved; change keeps it closed, approve opens it", () => {
    const h = atG1();
    closedBefore(() => {
      const next = ark("advance", id, "build.started");
      expect(next.code).toBe(1);
      expect(next.err).toContain("G1 has no approving answer");
      for (const forged of ["g1.approved", "gate.answered", "gate.packet"]) {
        expect(ark("advance", id, forged, "--data", '{"gate":"G1","answer":"approve"}').code, forged).toBe(1);
      }
    });
    expect(answer("G1", "change", h).code).toBe(0);
    expect(ark("advance", id, "build.started").code).toBe(1); // changed is not approved
    const h2 = hashOf(packet("G1"));
    expect(answer("G1", "approve", h2).code).toBe(0);
    expect(ark("advance", id, "build.started").code).toBe(0);
    expect(state().state).toBe("building");
  });

  test("G2: no step after the gate runs until G2 is approved; send_back keeps it closed, approve opens it", () => {
    const h = atG2();
    closedBefore(() => {
      expect(ark("run", "close", id, "merged").code).toBe(1);
      expect(ark("advance", id, "g2.approved").code).toBe(1);
      expect(ark("advance", id, "gate.answered", "--data", '{"gate":"G2","answer":"approve"}').code).toBe(1);
    });
    expect(answer("G2", "send_back", h).code).toBe(0);
    expect(ark("run", "close", id, "merged").code).toBe(1); // sent back to building: mrs never opened
    advance("build.completed");
    const h2 = hashOf(packet("G2"));
    expect(h2).toBe(h);
    expect(answer("G2", "approve", h2).code).toBe(0);
    expect(ark("run", "close", id, "merged").code).toBe(0);
    expect(state()).toMatchObject({ state: "done", status: "done", outcome: "merged" });
  });
});

describe("ARK-104-AC4", () => {
  test("answering the same gate packet a second time is refused, whatever the answer, and changes nothing", () => {
    const h = atG1();
    expect(answer("G1", "approve", h).code).toBe(0);
    const before = snapshot();
    for (const a of ["approve", "abort"]) {
      const r = answer("G1", a, h);
      expect(r.code, a).toBe(1);
      expect(r.err).toContain("already answered");
    }
    expect(snapshot()).toEqual(before);
    expect(ledger().filter((e) => e.type === "gate.answered").length).toBe(1);
  });

  test("a hash that is not the current packet's is refused as stale", () => {
    atG1();
    const before = snapshot();
    const r = answer("G1", "approve", `sha256:${"f".repeat(64)}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("stale");
    expect(snapshot()).toEqual(before);
  });

  test("the previous packet's hash is stale after the plan changed and a new packet was built", () => {
    const old = atG1();
    expect(answer("G1", "change", old).code).toBe(0);
    writeFileSync(runPath("plan.md"), "# Revised plan\n");
    const fresh = hashOf(packet("G1"));
    expect(fresh).not.toBe(old);
    expect(answer("G1", "approve", old).err).toContain("stale");
    expect(answer("G1", "approve", fresh).code).toBe(0);
  });

  test("a packet file edited after it was hashed is refused", () => {
    const h = atG1();
    const file = packetFile("G1", h);
    writeFileSync(runPath(file), `${read(file)}\nsneaked in\n`);
    const r = answer("G1", "approve", h);
    expect(r.code).toBe(1);
    expect(r.err).toContain("changed since it was hashed");
    rmSync(runPath(file));
    expect(answer("G1", "approve", h).code).toBe(1); // deleted is refused too
    expect(state().state).toBe("awaiting_g1");
  });
});

const typedAnswer = (typed: string | null, gate: string, a: string, hash: string) =>
  spawnArk(["bun", CLI, "gate", "answer", id, gate, a, "--packet", hash], { cwd: proj, env: { ...process.env, ARK_HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" } }, typed);

describe("ARK-117-AC7", () => {
  test("without a controlling terminal an answer is refused and nothing is recorded", () => {
    const h = atG1();
    const before = snapshot();
    const r = typedAnswer(null, "G1", "approve", h); // a session of its own, the way an agent's shell runs
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("no controlling terminal");
    expect(snapshot()).toEqual(before);
  });

  test("typing a different gate name is refused and nothing is recorded", () => {
    const h = atG1();
    const before = snapshot();
    const r = typedAnswer("G2", "G1", "approve", h);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("expected 'G1'");
    expect(snapshot()).toEqual(before);
  });

  test("the gate name typed on the terminal records the answer with its channel", () => {
    const h = atG1();
    const r = typedAnswer("G1", "G1", "approve", h);
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(ledger().at(-1)).toMatchObject({ type: "gate.answered", data: { gate: "G1", answer: "approve", channel: "tty" } });
  });
});

describe("ARK-117-AC8", () => {
  const ticketWith = (acs: string[]) =>
    writeFileSync(join(home, "projects", "demo", "tickets", "ARK-950.md"), `---\nid: ARK-950\ntitle: "Gate fixture"\nstatus: ready\nacceptance_criteria:\n${acs.map((t, i) => `  - id: ARK-950-AC${i + 1}\n    text: "${t}"`).join("\n")}\n---\nTicket body marker.\n`);

  test("G0 edit keeps the run at G0: ark ac update re-reads the ticket's ACs, and nothing past G0 is legal until G0 accept", () => {
    const first = atG0();
    expect(answer("G0", "edit", first).code).toBe(0);
    expect(state()).toMatchObject({ state: "awaiting_g0", status: "waiting_human", acs: {} });
    expect(ark("advance", id, "analysis.completed").code).toBe(1);
    expect(ark("advance", id, "ac.updated", "--data", "{}").err).toContain("written by 'ark ac update'");

    ticketWith(["First", "Second"]); // the human adds the criteria to the ticket
    const r = ark("ac", "update", id);
    expect(r.code, r.err).toBe(0);
    expect(ledger().at(-1)).toMatchObject({ type: "ac.updated", data: { acs: ["ARK-950-AC1", "ARK-950-AC2"] } });
    expect(state()).toMatchObject({ state: "awaiting_g0", acs: { "ARK-950-AC1": "pending", "ARK-950-AC2": "pending" } });
    expect(read("ac.yml")).toContain("ARK-950-AC2");
    expect(JSON.parse(read("ticket.json")).acceptance_criteria).toHaveLength(2);
    expect(ark("run", "replay", id, "--check").code).toBe(0);
    expect(ark("advance", id, "analysis.completed").code).toBe(1); // still not past G0

    expect(answer("G0", "accept", first).err).toContain("already answered"); // the packet that was edited cannot be accepted
    const second = hashOf(packet("G0"));
    expect(second).not.toBe(first);
    expect(read(packetFile("G0", second))).toContain("ARK-950-AC2");
    expect(answer("G0", "accept", second).code).toBe(0);
    expect(ark("advance", id, "analysis.completed").code).toBe(0);
  });

  test("ark ac update is legal only while G0 is open for editing", () => {
    startRun(["First"]);
    const r = ark("ac", "update", id);
    expect(r.code).toBe(1);
    expect(r.err).toContain("illegal event 'ac.updated' in state 'intake'");
  });
});

describe("ARK-117-AC5", () => {
  test("G1 cannot be approved while an AC has no kind; the packet says which, and approval works once every AC has one", () => {
    startRun(["First", "Second"]);
    advance("analysis.completed");
    writeFileSync(runPath("plan.md"), "# Plan marker\n");
    const h = hashOf(packet("G1"));
    expect(read(packetFile("G1", h))).toContain("- AC kind (new or preserved, confirmed by your approval): ARK-950-AC1, ARK-950-AC2");
    const before = snapshot();
    const refused = answer("G1", "approve", h);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("ARK-950-AC1, ARK-950-AC2 have no kind");
    expect(snapshot()).toEqual(before);

    expect(answer("G1", "change", h).code).toBe(0);
    setKinds(runPath(), { "ARK-950-AC1": "new", "ARK-950-AC2": "preserved" });
    const h2 = hashOf(packet("G1"));
    expect(read(packetFile("G1", h2))).toContain("- nothing detected by the CLI");
    expect(answer("G1", "approve", h2).code).toBe(0);
    expect(state().state).toBe("approved");
  });
});

describe("ARK-117-AC3", () => {
  test("a G2 send-back is a round: state.round counts it", () => {
    const h = atG2();
    expect(state().round).toBe(0);
    expect(answer("G2", "send_back", h).code).toBe(0);
    expect(state()).toMatchObject({ state: "building", round: 1 });
  });
});

describe("ARK-117-AC6", () => {
  const record = (list: unknown[]) => {
    writeFileSync(runPath("f.json"), JSON.stringify(list));
    return ark("findings", "record", id, runPath("f.json"));
  };
  const finding = (over: Record<string, unknown>) => ({ id: "F1", reviewer: "reviewer-x", model: "m", priority: "P1", file: "src/a.ts", line: 3, claim: "c", bucket: "act_on", reason: "r", ...over });

  test("a failing_test no ark test recorded as failing is refused; a traced_path is accepted and the G2 packet marks it as weaker evidence", () => {
    toJudging();
    const invented = record([finding({ evidence: { failing_test: "THIS TEST DOES NOT EXIST" } })]);
    expect(invented.code).toBe(1);
    expect(invented.err).toContain("not a test that the latest 'ark test' at the current head recorded as failing");

    expect(record([finding({ evidence: { traced_path: "src/a.ts:3 -> src/b.ts:9" } }), finding({ id: "F2", priority: "P3", bucket: "consider" })]).code).toBe(0);
    signOff();
    const h = hashOf(packet("G2"));
    expect(read(packetFile("G2", h))).toContain("- F1 P1 src/a.ts:3: traced path, weaker evidence (no test reaches it): src/a.ts:3 -> src/b.ts:9");
    expect(read(packetFile("G2", h))).not.toContain("F2 P3");
  });
});
