import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setKinds } from "./kinds";
import { OMP_CONFIG } from "./omp-config";
import { type AskProof, appendAskProof, appendEntry, askCall, askResult, activeLeaf, ensureTranscript, GATE_CHOICES, mainSessionFile, spawnArk } from "./tty";

const COMMAND_LINE_FILE = join(import.meta.dir, "..", "cli", "ark.ts");

let home: string;
let projectDirectory: string;
let gitConfigFile: string;
let id: string;
const runPath = (...pathSegments: string[]) => join(home, "projects", "demo", "runs", id, ...pathSegments);
const read = (file: string) => readFileSync(runPath(file), "utf8");
const ledger = () => read("ledger.ndjson").trim().split("\n").map((line) => JSON.parse(line));
const state = () => JSON.parse(read("state.json"));
const ark = (...argumentsList: string[]) => {
  const result = spawnArk(["bun", COMMAND_LINE_FILE, ...argumentsList], {
    cwd: projectDirectory,
    env: { ...process.env, ARK_HOME: home, GIT_CONFIG_GLOBAL: gitConfigFile, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};
const hash = (bytes: Uint8Array | string) => `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;

const startRun = (acceptanceCriteria: string[]) => {
  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  const list = acceptanceCriteria.length ? `acceptance_criteria:\n${acceptanceCriteria.map((criterionText, i) => `  - id: ARK-950-AC${i + 1}\n    text: "${criterionText}"`).join("\n")}` : "acceptance_criteria: []";
  writeFileSync(join(home, "projects", "demo", "tickets", "ARK-950.md"), `---\nid: ARK-950\ntitle: "Gate fixture"\nstatus: ready\n${list}\n---\nTicket body marker.\n`);
  expect(ark("run", "start", "ARK-950").code).toBe(0);
  id = readdirSync(join(home, "projects", "demo", "runs")).filter((result) => result !== ".locks")[0];
  expect(ark("log", "route", id, "ticket", "test fixture").code).toBe(0);
};
const advance = (event: string) => expect(ark("advance", id, event).code, event).toBe(0);
const packet = (gate: string) => ark("gate", "packet", id, gate);

// `answer` is the human in the main session: spawnArk appends the matching `ask` answer first. `asHuman` runs the same command with a transcript the test controls.
const asHuman = (environment: Record<string, string>, typed: string | null, ...argumentsList: string[]) => {
  const result = spawnArk(["bun", COMMAND_LINE_FILE, ...argumentsList], {
    cwd: projectDirectory,
    env: { ...process.env, ARK_HOME: home, GIT_CONFIG_GLOBAL: gitConfigFile, GIT_CONFIG_NOSYSTEM: "1", ...environment },
    noProof: true,
  }, typed);
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};
const answer = (gate: string, answerName: string, hash: string) => ark("gate", "answer", id, gate, answerName, "--packet", hash);
const hashOf = (result: { out: string }) => result.out.trim();

// The three places a run can wait, each reached through the real CLI. Return the packet hash.
const atCriteria = () => (startRun([]), hashOf(packet("criteria")));
const atPlan = () => {
  startRun(["First", "Second"]);
  advance("analysis.completed");
  writeFileSync(runPath("plan.md"), "# Plan marker\n");
  setKinds(runPath());
  return hashOf(packet("plan"));
};
const toJudging = () => {
  const packetHash = atPlan();
  expect(answer("plan", "approve", packetHash).code).toBe(0);
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
const atEvidence = () => {
  toJudging();
  signOff();
  return hashOf(packet("evidence"));
};
const reach = { criteria: atCriteria, plan: atPlan, evidence: atEvidence };

// Every file in the run folder with bytes and mtime, so "refused" can mean "changed nothing".
const snapshot = () =>
  (readdirSync(runPath(), { recursive: true }) as string[]).sort().filter((file) => statSync(runPath(file)).isFile())
    .map((file) => [file, read(file), statSync(runPath(file)).mtimeMs]);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  projectDirectory = mkdtempSync(join(tmpdir(), "ark-proj-"));
  gitConfigFile = join(mkdtempSync(join(tmpdir(), "ark-git-")), "config");
  writeFileSync(gitConfigFile, "[user]\n\tname = Gate Tester\n\temail = gate@example.test\n");
  writeFileSync(join(projectDirectory, "ark.yml"), "project: demo\n");
  mkdirSync(join(projectDirectory, ".omp"));
  writeFileSync(join(projectDirectory, ".omp", "config.yml"), OMP_CONFIG);
});

const packetFile = (gate: string, packetHash: string) => `gates/${gate}.${packetHash.slice("sha256:".length)}.packet.md`;

describe("ARK-104-AC1", () => {
  test("plan packet holds plan.md and ac.yml, its sha256 is printed and recorded, state moves to awaiting_plan", () => {
    const packetHash = atPlan();
    const file = read(packetFile("plan", packetHash));
    expect(packetHash).toBe(hash(file)); // the printed hash is the hash of the file on disk
    expect(file).toContain("# Plan marker");
    expect(file).toContain("ARK-950-AC2");
    expect(ledger().at(-1)).toMatchObject({ type: "gate.packet", data: { gate: "plan", path: packetFile("plan", packetHash), packet_sha256: packetHash } });
    expect(state()).toMatchObject({ state: "awaiting_plan", status: "waiting_human" });
  });

  test("the same artifacts give the same packet hash after a change round", () => {
    const packetHash = atPlan();
    expect(answer("plan", "change", packetHash).code).toBe(0);
    expect(hashOf(packet("plan"))).toBe(packetHash);
  });

  test("criteria packet holds the ticket, ac.yml and what is missing, and the run stays in awaiting_criteria", () => {
    const packetHash = atCriteria();
    const file = read(packetFile("criteria", packetHash));
    expect(packetHash).toBe(hash(file));
    expect(file).toContain("Ticket body marker.");
    expect(file).toContain("the ticket has none");
    expect(state().state).toBe("awaiting_criteria");
  });

  test("evidence packet holds the trace matrix and lists the test evidence files that exist, sorted", () => {
    toJudging();
    signOff();
    mkdirSync(runPath("artifacts", "logs"), { recursive: true });
    writeFileSync(runPath("artifacts", "logs", "red.txt"), "red");
    writeFileSync(runPath("artifacts", "junit.xml"), "<x/>");
    const packetHash = hashOf(packet("evidence"));
    expect(read(packetFile("evidence", packetHash))).toContain("| ARK-950-AC1 | new | manual | signed-by Gate Tester at 2026-10-21 |");
    expect(read(packetFile("evidence", packetHash))).toMatch(/- artifacts\/junit\.xml \(sha256:[0-9a-f]{64}\)\n- artifacts\/logs\/red\.txt \(sha256:[0-9a-f]{64}\)/);
    expect(state().state).toBe("awaiting_evidence");
  });

  test("a missing required artifact exits 1 naming it and changes nothing", () => {
    toJudging();
    const before = snapshot();
    const result = packet("evidence");
    expect(result.code).toBe(1);
    expect(result.err).toContain("trace-matrix.md");
    expect(snapshot()).toEqual(before);
  });

  test("a packet in the wrong state, or for an unknown gate, is refused", () => {
    startRun(["First"]);
    advance("analysis.completed");
    expect(packet("evidence").err).toContain("state 'analyzed'");
    expect(packet("G9").code).toBe(1);
    const noPlan = packet("plan");
    expect(noPlan.code).toBe(1);
    expect(noPlan.err).toContain("plan.md");
  });
});

describe("ARK-104-AC2", () => {
  test("answer records gate, answer, approver from OS and git identity, timestamp and packet hash in the ledger and state", () => {
    const packetHash = atPlan();
    const result = answer("plan", "approve", packetHash);
    expect(result.code, result.err).toBe(0);
    const event = ledger().at(-1);
    expect(event).toMatchObject({
      type: "gate.answered",
      data: {
        gate: "plan", answer: "approve", packet_sha256: packetHash,
        os_user: userInfo().username, git_name: "Gate Tester", git_email: "gate@example.test",
        by: `Gate Tester <gate@example.test> (${userInfo().username})`,
      },
    });
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(state().gates.plan).toEqual({ answer: "approve", by: event.data.by, at: event.ts, packet_sha256: packetHash });
    expect(ark("run", "replay", id, "--check").code).toBe(0);
  });

  // The fixed answer set per gate and where each answer sends the run (PRD "Gates and loop policy" and state table).
  const answers: [gate: "criteria" | "plan" | "evidence", answer: string, to: string][] = [
    ["criteria", "accept", "intake"], ["criteria", "edit", "awaiting_criteria"], ["criteria", "abort", "aborted"],
    ["plan", "approve", "approved"], ["plan", "change", "analyzed"], ["plan", "abort", "aborted"],
    ["evidence", "approve", "merge_requests_open"], ["evidence", "send_back", "building"], ["evidence", "abort", "aborted"],
  ];
  for (const [gate, answerName, to] of answers) {
    test(`${gate} ${answerName} moves the run to ${to}`, () => {
      const packetHash = reach[gate]();
      expect(answer(gate, answerName, packetHash).code).toBe(0);
      expect(state()).toMatchObject({ state: to, gates: { [gate]: { answer: answerName } } });
    });
  }

  test("an answer outside the gate's fixed set is refused and changes nothing", () => {
    const packetHash = atPlan();
    const before = snapshot();
    for (const bad of ["accept", "send_back", "bogus", ""]) {
      const result = answer("plan", bad, packetHash);
      expect(result.code, bad).toBe(1);
      expect(result.err).toContain("approve, change, abort");
    }
    expect(snapshot()).toEqual(before);
  });

  test("an answer without a git identity is refused", () => {
    const packetHash = atPlan();
    writeFileSync(gitConfigFile, "");
    const before = snapshot();
    const result = answer("plan", "approve", packetHash);
    expect(result.code).toBe(1);
    expect(result.err).toContain("user.name");
    expect(snapshot()).toEqual(before);
  });

  test("answering a gate that has no packet is refused", () => {
    startRun([]); // awaiting_criteria, never packeted
    const result = answer("criteria", "accept", `sha256:${"0".repeat(64)}`);
    expect(result.code).toBe(1);
    expect(result.err).toContain("no packet");
  });
});

describe("ARK-104-AC3", () => {
  const closedBefore = (run: () => void) => {
    const before = snapshot();
    run();
    expect(snapshot()).toEqual(before);
  };

  test("plan: no step after the gate runs until plan is approved; change keeps it closed, approve opens it", () => {
    const packetHash = atPlan();
    closedBefore(() => {
      const next = ark("advance", id, "build.started");
      expect(next.code).toBe(1);
      expect(next.err).toContain("plan has no approving answer");
      for (const forged of ["plan.approved", "gate.answered", "gate.packet"]) {
        expect(ark("advance", id, forged, "--data", '{"gate":"plan","answer":"approve"}').code, forged).toBe(1);
      }
    });
    expect(answer("plan", "change", packetHash).code).toBe(0);
    expect(ark("advance", id, "build.started").code).toBe(1); // changed is not approved
    const updatedPacketHash = hashOf(packet("plan"));
    expect(answer("plan", "approve", updatedPacketHash).code).toBe(0);
    expect(ark("advance", id, "build.started").code).toBe(0);
    expect(state().state).toBe("building");
  });

  test("evidence: no step after the gate runs until evidence is approved; send_back keeps it closed, approve opens it", () => {
    const packetHash = atEvidence();
    closedBefore(() => {
      expect(ark("run", "close", id, "merged").code).toBe(1);
      expect(ark("advance", id, "evidence.approved").code).toBe(1);
      expect(ark("advance", id, "gate.answered", "--data", '{"gate":"evidence","answer":"approve"}').code).toBe(1);
    });
    expect(answer("evidence", "send_back", packetHash).code).toBe(0);
    expect(ark("run", "close", id, "merged").code).toBe(1); // sent back to building: mrs never opened
    advance("build.completed");
    const updatedPacketHash = hashOf(packet("evidence"));
    expect(updatedPacketHash).toBe(packetHash);
    expect(answer("evidence", "approve", updatedPacketHash).code).toBe(0);
    expect(state()).toMatchObject({ state: "merge_requests_open", status: "waiting_human" });
  });
});

describe("ARK-104-AC4", () => {
  test("answering the same gate packet a second time is refused, whatever the answer, and changes nothing", () => {
    const packetHash = atPlan();
    expect(answer("plan", "approve", packetHash).code).toBe(0);
    const before = snapshot();
    for (const answerName of ["approve", "abort"]) {
      const result = answer("plan", answerName, packetHash);
      expect(result.code, answerName).toBe(1);
      expect(result.err).toContain("already answered");
    }
    expect(snapshot()).toEqual(before);
    expect(ledger().filter((event) => event.type === "gate.answered").length).toBe(1);
  });

  test("a hash that is not the current packet's is refused as stale", () => {
    atPlan();
    const before = snapshot();
    const result = answer("plan", "approve", `sha256:${"f".repeat(64)}`);
    expect(result.code).toBe(1);
    expect(result.err).toContain("stale");
    expect(snapshot()).toEqual(before);
  });

  test("the previous packet's hash is stale after the plan changed and a new packet was built", () => {
    const old = atPlan();
    expect(answer("plan", "change", old).code).toBe(0);
    writeFileSync(runPath("plan.md"), "# Revised plan\n");
    const fresh = hashOf(packet("plan"));
    expect(fresh).not.toBe(old);
    expect(answer("plan", "approve", old).err).toContain("stale");
    expect(answer("plan", "approve", fresh).code).toBe(0);
  });

  test("a packet file edited after it was hashed is refused", () => {
    const packetHash = atPlan();
    const file = packetFile("plan", packetHash);
    writeFileSync(runPath(file), `${read(file)}\nsneaked in\n`);
    const result = answer("plan", "approve", packetHash);
    expect(result.code).toBe(1);
    expect(result.err).toContain("changed since it was hashed");
    rmSync(runPath(file));
    expect(answer("plan", "approve", packetHash).code).toBe(1); // deleted is refused too
    expect(state().state).toBe("awaiting_plan");
  });
});

// What an agent's shell sees outside OMP: no session of its own, so the human's answer also has to be typed on a terminal.
const OUTSIDE_OMP = { PI_SESSION_ID: "", PI_SESSION_FILE: "" };
const prove = (gate: string, answerName: string, hash: string, extra: Partial<AskProof> = {}) =>
  appendAskProof(mainSessionFile(home), { action: `gate.answered:${gate}`, runId: id, answer: answerName, packetHash: hash, choices: GATE_CHOICES[gate], ...extra });
const refusedUnchanged = (message: string, run: () => { code: number; err: string }) => {
  const before = snapshot();
  const result = run();
  expect(result.code).toBe(1);
  expect(result.err).toContain(message);
  expect(snapshot()).toEqual(before);
};
const answerArguments = (gate: string, answerName: string, hash: string) => ["gate", "answer", id, gate, answerName, "--packet", hash];

describe("ARK-117-AC7", () => {
  test("outside OMP the ask answer is not enough: without a controlling terminal it is refused and nothing is recorded", () => {
    const packetHash = atPlan();
    prove("plan", "approve", packetHash);
    refusedUnchanged("no controlling terminal", () => asHuman(OUTSIDE_OMP, null, ...answerArguments("plan", "approve", packetHash)));
  });

  test("outside OMP, typing a different gate name is refused and nothing is recorded", () => {
    const packetHash = atPlan();
    prove("plan", "approve", packetHash);
    refusedUnchanged("expected 'approve'", () => asHuman(OUTSIDE_OMP, "evidence", ...answerArguments("plan", "approve", packetHash)));
  });
});

describe("ARK-120-AC1", () => {
  test("an answer with no ask result in the main session is refused, in OMP and as a terminal-only answer outside it", () => {
    const packetHash = atPlan();
    refusedUnchanged("no matching successful ask result", () => asHuman({}, null, ...answerArguments("plan", "approve", packetHash)));
    refusedUnchanged("no matching successful ask result", () => asHuman(OUTSIDE_OMP, "approve", ...answerArguments("plan", "approve", packetHash)));
  });

  test("a successful ask selection accepts recommended null but rejects recommended options", () => {
    const packetHash = atPlan();
    const choices = GATE_CHOICES.plan;
    const question = `Ark gate.answered:plan for run ${id}; packet ${packetHash}. Choose exactly one: ${choices.join(", ")}.`;
    for (const recommended of [0, 1, 2, null]) {
      const toolCallId = `ask-recommended-${recommended}`;
      const call = askCall(toolCallId, question, choices);
      Object.assign(call.message.content[0].arguments.questions[0], { recommended });
      const callEntryId = appendEntry(mainSessionFile(home), call);
      appendEntry(mainSessionFile(home), askResult(toolCallId, question, { answer: "approve", choices }), { parentId: callEntryId });
      if (recommended !== null) {
        refusedUnchanged("no matching successful ask result", () => asHuman({}, null, ...answerArguments("plan", "approve", packetHash)));
      } else {
        const result = asHuman({}, null, ...answerArguments("plan", "approve", packetHash));
        expect(result.code, result.err).toBe(0);
        expect(state().state).toBe("approved");
        expect(ledger().at(-1)).toMatchObject({ type: "gate.answered", data: { gate: "plan", answer: "approve", ask_call_id: toolCallId, packet_sha256: packetHash } });
      }
    }
  });

  test("an ask result OMP selected on timeout is not a human answer", () => {
    const packetHash = atPlan();
    prove("plan", "approve", packetHash, { timedOut: true });
    refusedUnchanged("no matching successful ask result", () => asHuman({}, null, ...answerArguments("plan", "approve", packetHash)));
  });

  test("an ask result with custom input is not the human choosing a listed answer", () => {
    const packetHash = atPlan();
    prove("plan", "approve", packetHash, { customInput: "approve, and also skip the checks" });
    refusedUnchanged("no matching successful ask result", () => asHuman({}, null, ...answerArguments("plan", "approve", packetHash)));
  });

  test("an ask result tied to a stale packet hash cannot answer the rebuilt packet", () => {
    const old = atPlan();
    expect(answer("plan", "change", old).code).toBe(0);
    writeFileSync(runPath("plan.md"), "# Revised plan\n");
    const current = hashOf(packet("plan"));
    expect(current).not.toBe(old);
    prove("plan", "approve", old);
    refusedUnchanged("no matching successful ask result", () => asHuman({}, null, ...answerArguments("plan", "approve", current)));
  });

  test("a session other than the bound main session cannot answer, even with a matching ask result of its own", () => {
    const packetHash = atPlan();
    const child = join(home, "child-session.jsonl");
    appendAskProof(child, { action: "gate.answered:plan", runId: id, answer: "approve", packetHash: packetHash, choices: GATE_CHOICES.plan, sessionId: "child-session" });
    refusedUnchanged("bound main Oh My Pi (OMP) session", () => asHuman({ PI_SESSION_ID: "child-session", PI_SESSION_FILE: child }, null, ...answerArguments("plan", "approve", packetHash)));
  });

  test("one ask result answers once: the same packet cannot be answered again from it", () => {
    const packetHash = atPlan();
    prove("plan", "change", packetHash);
    expect(asHuman({}, null, ...answerArguments("plan", "change", packetHash)).code).toBe(0);
    expect(hashOf(packet("plan"))).toBe(packetHash); // the same artifacts, so the same question
    refusedUnchanged("already used", () => asHuman({}, null, ...answerArguments("plan", "change", packetHash)));
  });

  test("an honest ask result records its session and call id, with the channel that carried it", () => {
    const packetHash = atPlan();
    prove("plan", "change", packetHash, { toolCallId: "ask-in-omp" });
    expect(asHuman({}, null, ...answerArguments("plan", "change", packetHash)).code).toBe(0);
    expect(ledger().at(-1).data).toMatchObject({ gate: "plan", answer: "change", channel: "omp", session_id: "ark-main-session", ask_call_id: "ask-in-omp" });

    const second = hashOf(packet("plan"));
    prove("plan", "approve", second, { toolCallId: "ask-outside-omp" });
    const typed = asHuman(OUTSIDE_OMP, "approve", ...answerArguments("plan", "approve", second));
    expect(typed.code, typed.err).toBe(0);
    expect(ledger().at(-1).data).toMatchObject({ gate: "plan", answer: "approve", channel: "tty", ask_call_id: "ask-outside-omp" });
  });
});

// The transcript is a tree: only the entries on the path from the active leaf to the root can be what the human answered (round 1 of PR 16).
describe("ARK-120-AC1 the active branch", () => {
  const transcript = () => mainSessionFile(home);
  const questionOf = (gate: string, hash: string) => `Ark gate.answered:${gate} for run ${id}; packet ${hash}. Choose exactly one: ${GATE_CHOICES[gate].join(", ")}.`;
  const base = () => appendEntry(transcript(), { type: "message", message: { role: "user", content: "go", timestamp: 0 } });

  test("a re-answered ask: the newer sibling result on the active branch decides, and the superseded answer never counts", () => {
    const packetHash = atPlan();
    const { call } = prove("plan", "approve", packetHash, { toolCallId: "ask-reanswered" });
    appendEntry(transcript(), askResult("ask-reanswered", questionOf("plan", packetHash), { answer: "abort", choices: GATE_CHOICES.plan }), { parentId: call });
    refusedUnchanged("no matching successful ask result", () => asHuman({}, null, ...answerArguments("plan", "approve", packetHash)));
    expect(asHuman({}, null, ...answerArguments("plan", "abort", packetHash)).code).toBe(0);
    expect(state().state).toBe("aborted");
  });

  test("an answer on a branch the human navigated away from is not an answer", () => {
    const packetHash = atPlan();
    const root = base();
    prove("plan", "approve", packetHash);
    appendEntry(transcript(), { type: "branch_summary", fromId: root, summary: "" }, { parentId: root }); // /tree back to before the ask
    refusedUnchanged("no matching successful ask result", () => asHuman({}, null, ...answerArguments("plan", "approve", packetHash)));
  });

  test("the newest answer to the same question decides: an older, unclaimed answer cannot outrank it", () => {
    const packetHash = atPlan();
    prove("plan", "approve", packetHash);
    prove("plan", "change", packetHash);
    refusedUnchanged("no matching successful ask result", () => asHuman({}, null, ...answerArguments("plan", "approve", packetHash)));
    expect(asHuman({}, null, ...answerArguments("plan", "change", packetHash)).code).toBe(0);
  });

  // The newest ask for the question is the human's latest word even when its result names no question: a cancelled ask is an error result (ToolAbortError) with no details,
  // a chat redirect carries `chatRedirect` and the question list, and a pending ask has no result yet. An older approve must not come back.
  const newestAsk = (toolCallId: string, packetHash: string) => appendEntry(transcript(), askCall(toolCallId, questionOf("plan", packetHash), GATE_CHOICES.plan));
  const result = (toolCallId: string, overrides: Record<string, unknown>) => ({ type: "message", message: { role: "toolResult", toolName: "ask", toolCallId, content: [{ type: "text", text: "x" }], ...overrides } });
  test.each([
    ["cancelled (error result, no details)", (packetHash: string) => ({ isError: true, details: {} })],
    ["redirected to chat", (packetHash: string) => ({ isError: false, details: { chatRedirect: true, questions: [questionOf("plan", packetHash)] } })],
    ["still pending", undefined],
  ])("a newer ask that was %s refuses, and the older unclaimed approve does not count", (_what, overrides) => {
    const packetHash = atPlan();
    prove("plan", "approve", packetHash);
    const call = newestAsk("ask-newest", packetHash);
    if (overrides) appendEntry(transcript(), result("ask-newest", overrides(packetHash)), { parentId: call });
    refusedUnchanged("no matching successful ask result", () => asHuman({}, null, ...answerArguments("plan", "approve", packetHash)));
  });

  test("an entry written off the active branch (late usage) restores the leaf it captured, as OMP replays it", () => {
    const packetHash = atPlan();
    const root = base();
    prove("plan", "approve", packetHash);
    appendEntry(transcript(), { type: "model_usage", activeLeafId: activeLeaf(transcript()) }, { parentId: root });
    expect(asHuman({}, null, ...answerArguments("plan", "approve", packetHash)).code).toBe(0);
  });
});

// `.main-session` follows the main session that starts or resumes the run; a subagent's transcript, which OMP marks with a session_init entry, never takes it.
describe("ARK-120-AC1 the bound main session", () => {
  const bound = () => JSON.parse(read(".main-session")).id;
  const asSession = (sessionId: string, file: string) => ({ PI_SESSION_ID: sessionId, PI_SESSION_FILE: file });

  test("a main session started after a restart takes over the binding and can answer; the earlier session no longer can", () => {
    const packetHash = atPlan();
    const next = join(home, "restarted.jsonl");
    const environment = asSession("restarted", next);
    ensureTranscript(next, "restarted"); // on disk by the time its tools run
    expect(asHuman(environment, null, "run", "start", "ARK-950").out).toContain("resumed");
    expect(bound()).toBe("restarted");
    prove("plan", "approve", packetHash);
    refusedUnchanged("bound main Oh My Pi (OMP) session", () => asHuman({}, null, ...answerArguments("plan", "approve", packetHash)));
    appendAskProof(next, { action: "gate.answered:plan", runId: id, answer: "approve", packetHash: packetHash, choices: GATE_CHOICES.plan, sessionId: "restarted" });
    expect(asHuman(environment, null, ...answerArguments("plan", "approve", packetHash)).code).toBe(0);
    expect(ledger().at(-1).data).toMatchObject({ gate: "plan", answer: "approve", session_id: "restarted" });
  });

  test("a subagent resuming the run does not become the main session, and its own ask result answers nothing", () => {
    const packetHash = atPlan();
    const child = join(home, "child.jsonl");
    appendEntry(child, { type: "session_init", systemPrompt: ["Implementer"], task: "t", tools: ["bash", "ask"], agent: "implementer", modelRole: "implement" }, { sessionId: "child" });
    appendAskProof(child, { action: "gate.answered:plan", runId: id, answer: "approve", packetHash: packetHash, choices: GATE_CHOICES.plan, sessionId: "child" });
    const environment = asSession("child", child);
    expect(asHuman(environment, null, "run", "start", "ARK-950").code).toBe(0);
    expect(bound()).toBe("ark-main-session");
    refusedUnchanged("bound main Oh My Pi (OMP) session", () => asHuman(environment, null, ...answerArguments("plan", "approve", packetHash)));
  });

  // OMP writes a transcript lazily, so `ark run start` may run before it exists: such a session cannot be classified, and binds only while nothing is bound.
  const startFrom = (sessionId: string, file: string) =>
    Bun.spawnSync(["bun", COMMAND_LINE_FILE, "run", "start", "ARK-950"], { cwd: projectDirectory, env: { ...process.env, ARK_HOME: home, GIT_CONFIG_GLOBAL: gitConfigFile, GIT_CONFIG_NOSYSTEM: "1", PI_SESSION_ID: sessionId, PI_SESSION_FILE: file } });

  test("a session whose transcript is not on disk yet cannot take over an existing binding", () => {
    atPlan();
    expect(startFrom("ghost", join(home, "not-written-yet.jsonl")).exitCode).toBe(0);
    expect(bound()).toBe("ark-main-session");
  });

  test("a subagent bound while its transcript was not on disk yet proves nothing once it is, and the main session's next run start takes the binding back", () => {
    mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
    writeFileSync(join(home, "projects", "demo", "tickets", "ARK-950.md"), `---\nid: ARK-950\ntitle: "Gate fixture"\nstatus: ready\nacceptance_criteria:\n  - id: ARK-950-AC1\n    text: "First"\n---\nBody.\n`);
    const child = join(home, "child.jsonl");
    expect(startFrom("child", child).exitCode).toBe(0);
    id = readdirSync(join(home, "projects", "demo", "runs")).filter((result) => result !== ".locks")[0];
    expect(bound()).toBe("child");
    expect(ark("log", "route", id, "ticket", "fixture").code).toBe(0);
    advance("analysis.completed");
    writeFileSync(runPath("plan.md"), "# Plan marker\n");
    setKinds(runPath());
    const packetHash = hashOf(packet("plan"));
    appendEntry(child, { type: "session_init", systemPrompt: ["Implementer"], task: "t", tools: ["bash", "ask"], agent: "implementer" }, { sessionId: "child" });
    appendAskProof(child, { action: "gate.answered:plan", runId: id, answer: "approve", packetHash: packetHash, choices: GATE_CHOICES.plan, sessionId: "child" });
    refusedUnchanged("no matching successful ask result", () => asHuman(asSession("child", child), null, ...answerArguments("plan", "approve", packetHash)));

    prove("plan", "approve", packetHash);
    expect(asHuman({}, null, "run", "start", "ARK-950").out).toContain("resumed"); // the main session's transcript exists by now
    expect(bound()).toBe("ark-main-session");
    expect(asHuman({}, null, ...answerArguments("plan", "approve", packetHash)).code).toBe(0);
  });

  test("an ask result answers once across sessions: a relaunched session replaying the same entries cannot spend it again", () => {
    const packetHash = atPlan();
    prove("plan", "change", packetHash, { toolCallId: "ask-shared" });
    expect(asHuman({}, null, ...answerArguments("plan", "change", packetHash)).code).toBe(0);
    expect(hashOf(packet("plan"))).toBe(packetHash); // the same artifacts, so the same question
    const next = join(home, "relaunched.jsonl");
    const environment = asSession("relaunched", next);
    ensureTranscript(next, "relaunched");
    expect(asHuman(environment, null, "run", "start", "ARK-950").code).toBe(0);
    appendAskProof(next, { action: "gate.answered:plan", runId: id, answer: "change", packetHash: packetHash, choices: GATE_CHOICES.plan, sessionId: "relaunched", toolCallId: "ask-shared" }); // same call id, same question
    refusedUnchanged("already used", () => asHuman(environment, null, ...answerArguments("plan", "change", packetHash)));
  });

  test("a subagent that starts the run binds nothing, and a fork (parentSession, no session_init) is a main session", () => {
    mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
    writeFileSync(join(home, "projects", "demo", "tickets", "ARK-950.md"), `---\nid: ARK-950\ntitle: "Gate fixture"\nstatus: ready\nacceptance_criteria: []\n---\nBody.\n`);
    const child = join(home, "child.jsonl");
    appendEntry(child, { type: "session_init", systemPrompt: ["Implementer"], task: "t", tools: ["bash"], agent: "implementer" }, { sessionId: "child" });
    expect(asHuman(asSession("child", child), null, "run", "start", "ARK-950").out).toContain("started");
    id = readdirSync(join(home, "projects", "demo", "runs")).filter((result) => result !== ".locks")[0];
    expect(() => read(".main-session")).toThrow();

    const fork = join(home, "fork.jsonl");
    writeFileSync(fork, `${JSON.stringify({ type: "session", version: 3, id: "fork", timestamp: new Date().toISOString(), cwd: projectDirectory, parentSession: join(home, "parent.jsonl") })}\n`);
    expect(asHuman(asSession("fork", fork), null, "run", "start", "ARK-950").code).toBe(0);
    expect(bound()).toBe("fork");
  });
});

describe("ARK-120-AC3", () => {
  test("a evidence send-back once the round budget is spent leads only to escalation: no round counted, no way back to evidence or building, and the escalation packet reads the true budget", () => {
    writeFileSync(join(projectDirectory, "ark.yml"), "project: demo\nloop:\n  max_rounds: 1\n");
    const packetHash = atEvidence();
    expect(answer("evidence", "send_back", packetHash).code).toBe(0);
    expect(state()).toMatchObject({ state: "building", round: 1 });
    advance("build.completed");
    expect(answer("evidence", "send_back", hashOf(packet("evidence"))).code).toBe(0);
    expect(state()).toMatchObject({ state: "escalating", round: 1, status: "active", next_action: { kind: "open_escalation", agent: "orchestrator" } });
    expect(ledger().at(-1)).toMatchObject({ type: "gate.answered", data: { gate: "evidence", answer: "send_back", escalated: true } });
    for (const refused of [packet("evidence"), ark("advance", id, "fix_round.started"), ark("advance", id, "build.completed"), ark("advance", id, "findings.recorded")]) expect(refused.code).toBe(1);
    expect(state().state).toBe("escalating");

    writeFileSync(runPath("premise.md"), "The same source premise remains.\n");
    const escalationPacket = packet("escalation");
    expect(escalationPacket.code).toBe(0);
    expect(state().state).toBe("awaiting_escalation");
    expect(read(packetFile("escalation", hashOf(escalationPacket)))).toContain("rounds used: 1 of 1");
  });

  test("the only other way out of an escalated send-back is abort", () => {
    writeFileSync(join(projectDirectory, "ark.yml"), "project: demo\nloop:\n  max_rounds: 0\n");
    expect(answer("evidence", "send_back", atEvidence()).code).toBe(0);
    expect(state()).toMatchObject({ state: "escalating", round: 0 });
    expect(ark("advance", id, "abort").code).toBe(0);
    expect(state().state).toBe("aborted");
  });
});

describe("ARK-117-AC8", () => {
  const ticketWith = (acceptanceCriteria: string[]) =>
    writeFileSync(join(home, "projects", "demo", "tickets", "ARK-950.md"), `---\nid: ARK-950\ntitle: "Gate fixture"\nstatus: ready\nacceptance_criteria:\n${acceptanceCriteria.map((criterionText, i) => `  - id: ARK-950-AC${i + 1}\n    text: "${criterionText}"`).join("\n")}\n---\nTicket body marker.\n`);

  test("criteria edit keeps the run at criteria: ark acceptance-criteria update re-reads the ticket's ACs, and nothing past criteria is legal until criteria accept", () => {
    const first = atCriteria();
    expect(answer("criteria", "edit", first).code).toBe(0);
    expect(state()).toMatchObject({ state: "awaiting_criteria", status: "waiting_human", acs: {} });
    expect(ark("advance", id, "analysis.completed").code).toBe(1);
    expect(ark("advance", id, "acceptance_criteria.updated", "--data", "{}").err).toContain("written by 'ark acceptance-criteria update'");

    ticketWith(["First", "Second"]); // the human adds the criteria to the ticket
    const result = ark("acceptance-criteria", "update", id);
    expect(result.code, result.err).toBe(0);
    expect(ledger().at(-1)).toMatchObject({ type: "acceptance_criteria.updated", data: { acs: ["ARK-950-AC1", "ARK-950-AC2"] } });
    expect(state()).toMatchObject({ state: "awaiting_criteria", acs: { "ARK-950-AC1": "pending", "ARK-950-AC2": "pending" } });
    expect(read("ac.yml")).toContain("ARK-950-AC2");
    expect(JSON.parse(read("ticket.json")).acceptance_criteria).toHaveLength(2);
    expect(ark("run", "replay", id, "--check").code).toBe(0);
    expect(ark("advance", id, "analysis.completed").code).toBe(1); // still not past criteria

    expect(answer("criteria", "accept", first).err).toContain("already answered"); // the packet that was edited cannot be accepted
    const second = hashOf(packet("criteria"));
    expect(second).not.toBe(first);
    expect(read(packetFile("criteria", second))).toContain("ARK-950-AC2");
    expect(answer("criteria", "accept", second).code).toBe(0);
    expect(ark("advance", id, "analysis.completed").code).toBe(0);
  });

  test("ark acceptance-criteria update is legal only while criteria is open for editing", () => {
    startRun(["First"]);
    const result = ark("acceptance-criteria", "update", id);
    expect(result.code).toBe(1);
    expect(result.err).toContain("illegal event 'acceptance_criteria.updated' in state 'intake'");
  });
});

describe("ARK-117-AC5", () => {
  test("plan cannot be approved while an AC has no kind; the packet says which, and approval works once every AC has one", () => {
    startRun(["First", "Second"]);
    advance("analysis.completed");
    writeFileSync(runPath("plan.md"), "# Plan marker\n");
    const packetHash = hashOf(packet("plan"));
    expect(read(packetFile("plan", packetHash))).toContain("- acceptance criterion (AC) kind (new or preserved, confirmed by your approval): ARK-950-AC1, ARK-950-AC2");
    const before = snapshot();
    const refused = answer("plan", "approve", packetHash);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("ARK-950-AC1, ARK-950-AC2 have no kind");
    expect(snapshot()).toEqual(before);

    expect(answer("plan", "change", packetHash).code).toBe(0);
    setKinds(runPath(), { "ARK-950-AC1": "new", "ARK-950-AC2": "preserved" });
    const updatedPacketHash = hashOf(packet("plan"));
    expect(answer("plan", "approve", updatedPacketHash).code).toBe(0);
    expect(state().state).toBe("approved");
  });
});

describe("ARK-117-AC3", () => {
  test("a evidence send-back is a round: state.round counts it", () => {
    const packetHash = atEvidence();
    expect(state().round).toBe(0);
    expect(answer("evidence", "send_back", packetHash).code).toBe(0);
    expect(state()).toMatchObject({ state: "building", round: 1 });
  });
});

describe("ARK-117-AC6", () => {
  const record = (list: unknown[]) => {
    writeFileSync(runPath("f.json"), JSON.stringify(list));
    return ark("findings", "record", id, runPath("f.json"));
  };
  const finding = (overrides: Record<string, unknown>) => ({ id: "F1", reviewer: "reviewer-x", model: "m", priority: "P1", file: "src/a.ts", line: 3, claim: "c", bucket: "act_on", reason: "r", ...overrides });

  test("a failing_test no ark test recorded as failing is refused; a traced_path is accepted and the evidence packet marks it as weaker evidence", () => {
    toJudging();
    const invented = record([finding({ evidence: { failing_test: "THIS TEST DOES NOT EXIST" } })]);
    expect(invented.code).toBe(1);
    expect(invented.err).toContain("not a test that the latest 'ark test' at the current head recorded as failing");

    expect(record([finding({ evidence: { traced_path: "src/a.ts:3 -> src/b.ts:9" } }), finding({ id: "F2", priority: "P3", bucket: "consider" })]).code).toBe(0);
    signOff();
    const packetHash = hashOf(packet("evidence"));
    expect(read(packetFile("evidence", packetHash))).toContain("- F1 P1 src/a.ts:3: traced path, weaker evidence (no test reaches it): src/a.ts:3 -> src/b.ts:9");
    expect(read(packetFile("evidence", packetHash))).not.toContain("F2 P3");
  });
});
