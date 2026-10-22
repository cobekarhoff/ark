import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

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
  const r = Bun.spawnSync(["bun", CLI, ...args], {
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
  return hashOf(packet("G1"));
};
const toJudging = () => {
  const h = atG1();
  expect(answer("G1", "approve", h).code).toBe(0);
  advance("build.started");
  advance("build.completed");
};
const atG2 = () => {
  toJudging();
  writeFileSync(runPath("trace-matrix.md"), "| AC | test |\n| ARK-950-AC1 | t |\n");
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
});

describe("ARK-104-AC1", () => {
  test("G1 packet holds plan.md and ac.yml, its sha256 is printed and recorded, state moves to awaiting_g1", () => {
    const h = atG1();
    const file = read("gates/G1.packet.md");
    expect(h).toBe(sha(file)); // the printed hash is the hash of the file on disk
    expect(file).toContain("# Plan marker");
    expect(file).toContain("ARK-950-AC2");
    expect(ledger().at(-1)).toMatchObject({ type: "gate.packet", data: { gate: "G1", path: "gates/G1.packet.md", packet_sha256: h } });
    expect(state()).toMatchObject({ state: "awaiting_g1", status: "waiting_human" });
  });

  test("the same artifacts give the same packet hash after a change round", () => {
    const h = atG1();
    expect(answer("G1", "change", h).code).toBe(0);
    expect(hashOf(packet("G1"))).toBe(h);
  });

  test("G0 packet holds the ticket, ac.yml and what is missing, and the run stays in awaiting_g0", () => {
    const h = atG0();
    const file = read("gates/G0.packet.md");
    expect(h).toBe(sha(file));
    expect(file).toContain("Ticket body marker.");
    expect(file).toContain("the ticket has none");
    expect(state().state).toBe("awaiting_g0");
  });

  test("G2 packet holds the trace matrix and lists the test evidence files that exist, sorted", () => {
    toJudging();
    writeFileSync(runPath("trace-matrix.md"), "matrix marker\n");
    mkdirSync(runPath("artifacts", "logs"), { recursive: true });
    writeFileSync(runPath("artifacts", "logs", "red.txt"), "red");
    writeFileSync(runPath("artifacts", "junit.xml"), "<x/>");
    expect(packet("G2").code).toBe(0);
    expect(read("gates/G2.packet.md")).toContain("matrix marker");
    expect(read("gates/G2.packet.md")).toContain("- artifacts/junit.xml\n- artifacts/logs/red.txt");
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
    ["G0", "accept", "intake"], ["G0", "edit", "intake"], ["G0", "abort", "aborted"],
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
      expect(ark("advance", id, "run.completed").code).toBe(1);
      expect(ark("advance", id, "g2.approved").code).toBe(1);
      expect(ark("advance", id, "gate.answered", "--data", '{"gate":"G2","answer":"approve"}').code).toBe(1);
    });
    expect(answer("G2", "send_back", h).code).toBe(0);
    expect(ark("advance", id, "run.completed").code).toBe(1); // sent back to building: mrs never opened
    advance("build.completed");
    const h2 = hashOf(packet("G2"));
    expect(h2).toBe(h);
    expect(answer("G2", "approve", h2).code).toBe(0);
    expect(ark("advance", id, "run.completed").code).toBe(0);
    expect(state()).toMatchObject({ state: "done", status: "done" });
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
    writeFileSync(runPath("gates/G1.packet.md"), `${read("gates/G1.packet.md")}\nsneaked in\n`);
    const r = answer("G1", "approve", h);
    expect(r.code).toBe(1);
    expect(r.err).toContain("changed since it was hashed");
    rmSync(runPath("gates/G1.packet.md"));
    expect(answer("G1", "approve", h).code).toBe(1); // deleted is refused too
    expect(state().state).toBe("awaiting_g1");
  });
});
