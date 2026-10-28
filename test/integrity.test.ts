import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setKinds } from "./kinds";
import { OMP_CONFIG } from "./omp-config";
import { appendAskProof, spawnArk } from "./tty";

setDefaultTimeout(120_000);
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const GIT_IDENTITY = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@t" };
const COMMAND_LINE_FILE = join(import.meta.dir, "..", "cli", "ark.ts");

const REPOSITORY_YAML = JSON.stringify({
  suites: { unit: { format: "bun-test", level: "integration", run: 'bun test -t "{tags}" --pass-with-no-tests --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml', junit: "$ARK_OUT/bun.xml" } },
});
const TICKET = `---
id: DEMO-1
title: "Integrity fixture"
status: ready
acceptance_criteria:
  - id: DEMO-1-AC1
    text: "one"
  - id: DEMO-1-AC2
    text: "two"
---
Body.
`;
const tagged = (acceptanceCriterion: string, body = "expect(1).toBe(1)") => `import { expect, test } from "bun:test";\ntest("${acceptanceCriterion} fixture", () => { ${body}; });\n`;

let home: string;
let projectDirectory: string;
let agentDirectory: string; // the global OMP config dir (PI_CODING_AGENT_DIR); empty unless a test writes a config.yml into it
const environment = (extra: Record<string, string> = {}) => ({ ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PI_CODING_AGENT_DIR: agentDirectory, ...extra });
const ark = (...argumentsList: string[]) => {
  const result = spawnArk(["bun", COMMAND_LINE_FILE, ...argumentsList], { cwd: projectDirectory, env: environment() });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};
const git = (workingDirectory: string, ...argumentsList: string[]) => {
  const result = Bun.spawnSync(["git", ...argumentsList], { cwd: workingDirectory, env: process.env });
  if (result.exitCode !== 0) throw new Error(`git ${argumentsList.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};
const write = (directory: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), text);
  }
};
const commitAll = (directory: string, files: Record<string, string>) => {
  write(directory, files);
  git(directory, "add", "-A");
  git(directory, "commit", "-qm", "change");
};
const runsDirectory = () => join(home, "projects", "demo", "runs");
const run = () => readdirSync(runsDirectory()).filter((result) => result !== ".locks")[0];
const runFile = (file: string) => join(runsDirectory(), run(), file);
const slurp = (file: string) => readFileSync(runFile(file), "utf8");
const lines = () => slurp("ledger.ndjson").trim().split("\n");
const events = () => lines().map((line) => JSON.parse(line));
const worktree = () => runFile("worktrees/demo");
const hash = (text: string) => `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;
const ok = (result: { code: number; err: string }) => expect(result.err === "" ? result.code : result.err).toBe(0);
const answerGate = (gate: string, answer: string, packetHash: string) =>
  ark("gate", "answer", run(), gate, answer, "--packet", packetHash);

function fixture() {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  agentDirectory = mkdtempSync(join(tmpdir(), "ark-omp-agent-"));
  projectDirectory = join(realpathSync(mkdtempSync(join(tmpdir(), "ark-fx-"))), "demo");
  mkdirSync(projectDirectory);
  git(projectDirectory, "init", "-q", "-b", "main");
  commitAll(projectDirectory, {
    "ark.yml": "project: demo\n",
    ".omp/config.yml": OMP_CONFIG,
    ".ark/repo.yml": REPOSITORY_YAML,
    "src/base.ts": "export const base = 1;\n",
  });
  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  writeFileSync(join(home, "projects", "demo", "tickets", "DEMO-1.md"), TICKET);
  ok(ark("run", "start", "DEMO-1"));
  ok(ark("log", "route", run(), "ticket", "fixture")); // route first: nothing else is legal before it
}
// start -> plan approved -> worktree create -> build.started
const toBuilding = () => {
  ok(ark("advance", run(), "analysis.completed"));
  writeFileSync(runFile("plan.md"), "# Plan\n");
  setKinds(runFile(""));
  const packetHash = ark("gate", "packet", run(), "plan").out.trim();
  ok(answerGate("plan", "approve", packetHash));
  ok(ark("worktree", "create", run()));
  ok(ark("advance", run(), "build.started"));
};
const confirmHumanImplementerStep = () => {
  const head = git(worktree(), "rev-parse", "HEAD");
  appendAskProof(join(home, "test-main-session.jsonl"), { action: "implementer.completed:demo", runId: run(), answer: "confirm", packetHash: hash(head), choices: ["confirm", "abort"] });
};
const step = (files: Record<string, string>) => {
  commitAll(worktree(), files);
  if (stateNow().implementer === "human") confirmHumanImplementerStep();
  ok(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'));
};
// The validator's work: commit tagged tests, then record the head through `ark test --as validator` (the exit code is the test verdict, not what is under test here).
const validate = (files: Record<string, string>, acceptanceCriterion = "DEMO-1-AC1") => {
  commitAll(worktree(), files);
  expect(ark("test", run(), "--criteria", acceptanceCriterion, "--as", "validator").err).toBe("");
};

beforeEach(fixture);

describe("ARK-115-AC1", () => {
  // [event type, the command that owns it]
  const owned: [string, string][] = [
    ["worktree.created", "worktree create"], ["test.result", "test"], ["test.red_green", "test"], ["trace.checked", "trace-check"],
    ["gate.packet", "gate"], ["gate.answered", "gate"], ["merge_request.opened", "merge-request open"], ["run.closed", "run close"], ["test.preservation", "test"],
    ["findings.recorded", "findings record"], ["artifact.recorded", "artifact record"],
    ["acceptance_criteria.updated", "acceptance-criteria update"], ["implementer.refused", "advance implementer.completed"],
  ];
  test.each(owned)("ark advance refuses %s and names 'ark %s', writing nothing", (type, command) => {
    const before = slurp("ledger.ndjson");
    const result = ark("advance", run(), type, "--data", "{}");
    expect(result.code).toBe(1);
    expect(result.err).toContain(`'${type}' is written by 'ark ${command}', not advance`);
    expect(slurp("ledger.ndjson")).toBe(before);
  });

  test("escalation goes through ark gate: an escalation packet from premise.md and the latest findings, answered by a human answer", () => {
    toBuilding();
    ok(ark("advance", run(), "build.completed"));
    expect(ark("gate", "packet", run(), "escalation").err).toContain("0 of 2 rounds used"); // escalation opens only once the round budget is spent
    spendRounds(2);
    expect(ark("gate", "packet", run(), "escalation").err).toContain("premise.md"); // the packet needs the shared premise
    writeFileSync(runFile("premise.md"), "Both fixes assumed the cache is cold.\n");
    const packetHash = ark("gate", "packet", run(), "escalation").out.trim();
    expect(slurp(`gates/escalation.${packetHash.slice("sha256:".length)}.packet.md`)).toContain(hash("Both fixes assumed the cache is cold.\n"));
    expect(slurp("state.json")).toContain('"state": "awaiting_escalation"');
    expect(ark("gate", "answer", run(), "escalation", "guess", "--packet", packetHash).err).toContain("unknown answer");
    ok(answerGate("escalation", "one_more_round", packetHash));
    expect(slurp("state.json")).toContain('"state": "building"');
    expect(events().at(-1)).toMatchObject({ type: "gate.answered", data: { gate: "escalation", answer: "one_more_round" } });
  });
});

describe("ARK-115-AC2", () => {
  const advance3 = () => {
    ok(ark("advance", run(), "analysis.completed"));
    writeFileSync(runFile("plan.md"), "# Plan\n");
    ok(ark("gate", "packet", run(), "plan"));
    ok(ark("advance", run(), "abort"));
  };

  test("every line records the sha256 of the previous raw line, the first that of the empty string", () => {
    advance3();
    const ledgerLines = lines();
    expect(ledgerLines.length).toBe(5);
    ledgerLines.forEach((line, i) => expect(JSON.parse(line).prev).toBe(hash(i === 0 ? "" : ledgerLines[i - 1])));
  });

  const setLines = (ledgerLines: string[]) => writeFileSync(runFile("ledger.ndjson"), ledgerLines.length ? `${ledgerLines.join("\n")}\n` : "");
  // A schema-valid change (the year of ts moves back one), so only the hash chain can notice it.
  const edited = (ledgerLines: string[], i: number) => ledgerLines.map((line, j) => (j === i ? line.replace(/"ts":"(\d{4})/, (_, year) => `"ts":"${Number(year) - 1}`) : line));
  // [what was done to a 5-line ledger, the seq the refusal names]
  const damage: [string, (ledgerLines: string[]) => string[], number][] = [
    ["an edited middle line", (ledgerLines) => edited(ledgerLines, 1), 2],
    ["an edited last line", (ledgerLines) => edited(ledgerLines, 4), 5],
    ["a removed middle line", (ledgerLines) => ledgerLines.filter((_, i) => i !== 1), 2],
    ["a truncated tail", (ledgerLines) => ledgerLines.slice(0, 2), 3],
    ["a reordered pair", (ledgerLines) => [ledgerLines[0], ledgerLines[2], ledgerLines[1], ledgerLines[3], ledgerLines[4]], 2],
  ];
  for (const [what, hit, sequence] of damage) {
    test(`${what} is refused by replay, naming seq ${sequence}`, () => {
      advance3();
      setLines(hit(lines()));
      const result = ark("run", "replay", run());
      expect(result.code).toBe(1);
      expect(result.err).toContain(`seq ${sequence}`);
    });
  }

  test.each([
    ["advance", () => ark("advance", run(), "abort")],
    ["run replay --check", () => ark("run", "replay", run(), "--check")],
    ["run start", () => ark("run", "start", "DEMO-1")],
    ["trace-check", () => ark("trace-check", run())],
    ["gate packet", () => ark("gate", "packet", run(), "plan")],
    ["log route", () => ark("log", "route", run(), "ticket", "why")],
  ])("%s refuses a broken chain and writes nothing", (_c, command) => {
    advance3();
    setLines(edited(lines(), 1));
    const before = slurp("ledger.ndjson");
    const result = command();
    expect(result.code).toBe(1);
    expect(result.err).toContain("seq 2");
    expect(slurp("ledger.ndjson")).toBe(before);
  });

  test("artifact record reads the ledger first: a broken chain refuses it and keeps no artifact", () => {
    advance3();
    setLines(edited(lines(), 1));
    const file = join(dirname(projectDirectory), "impl.json");
    writeFileSync(file, JSON.stringify({ repo: "demo", branch: "ark/DEMO-1-x", head_sha: "abc123", ac_addressed: ["DEMO-1-AC1"], status: "done" }));
    const result = ark("artifact", "record", run(), "implementer", file);
    expect(result.code).toBe(1);
    expect(result.err).toContain("seq 2");
    expect(existsSync(runFile("artifacts/implementer"))).toBe(false);
  });
});

// Every AC manual and signed, so trace-check passes without a test run; returns the evidence packet hash. Needs building or judging state.
const toEvidencePacket = () => {
  if (JSON.parse(slurp("state.json")).state === "building") ok(ark("advance", run(), "build.completed"));
  writeFileSync(runFile("ac.yml"), "- id: DEMO-1-AC1\n  text: t\n  level: manual\n  kind: new\n- id: DEMO-1-AC2\n  text: t\n  level: manual\n  kind: new\n");
  mkdirSync(runFile("manual"), { recursive: true });
  for (const id of ["DEMO-1-AC1", "DEMO-1-AC2"]) writeFileSync(runFile(`manual/${id}.md`), "signed-by: P\nat: 2026-10-26\n");
  mkdirSync(runFile("artifacts"), { recursive: true });
  writeFileSync(runFile("artifacts/junit.xml"), "<testsuite/>");
  ok(ark("trace-check", run()));
  return ark("gate", "packet", run(), "evidence").out.trim();
};

describe("ARK-115-AC3", () => {
  const finding = (number: number) => [{ id: `F${number}`, reviewer: "r", model: "anthropic/claude-opus-5-5", priority: "P2", file: "src/a.ts", line: 1, claim: "c", bucket: "consider", reason: "r" }];

  test("40 parallel advances leave a replayable chain with unique seq values", async () => {
    toBuilding();
    const processes = Array.from({ length: 40 }, () => Bun.spawn(["bun", COMMAND_LINE_FILE, "advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'], { cwd: projectDirectory, env: environment(), stderr: "pipe", stdout: "pipe" }));
    const results = await Promise.all(processes.map(async (commandResult) => ({ code: await commandResult.exited, err: await new Response(commandResult.stderr).text() })));
    expect(results.filter((result) => result.code !== 0)).toEqual([]);

    const sequences = events().map((event) => event.seq);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => i + 1));
    expect(events().filter((event) => event.type === "implementer.completed").length).toBe(40);
    ok(ark("run", "replay", run(), "--check"));
  });

  test("40 parallel findings records leave a replayable chain with unique seq values and 40 distinct artifacts", async () => {
    toBuilding();
    ok(ark("advance", run(), "build.completed"));
    const files = Array.from({ length: 40 }, (_, number) => {
      const file = join(dirname(projectDirectory), `f${number}.json`);
      writeFileSync(file, JSON.stringify(finding(number)));
      return file;
    });
    const processes = files.map((file) => Bun.spawn(["bun", COMMAND_LINE_FILE, "findings", "record", run(), file], { cwd: projectDirectory, env: environment(), stderr: "pipe", stdout: "pipe" }));
    const results = await Promise.all(processes.map(async (commandResult) => ({ code: await commandResult.exited, err: await new Response(commandResult.stderr).text() })));
    expect(results.filter((result) => result.code !== 0)).toEqual([]);

    const sequences = events().map((event) => event.seq);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => i + 1));
    expect(events().filter((event) => event.type === "findings.recorded").length).toBe(40);
    expect(readdirSync(runFile("artifacts/findings")).length).toBe(40);
    ok(ark("run", "replay", run(), "--check"));
    expect(existsSync(runFile("ledger.lock"))).toBe(false);
  });

  test("a live lock holds a writer until it is released; a stale lock does not", async () => {
    const lock = runFile("ledger.lock");
    writeFileSync(lock, "held");
    const startedAt = Date.now();
    const commandResult = Bun.spawn(["bun", COMMAND_LINE_FILE, "advance", run(), "analysis.completed"], { cwd: projectDirectory, env: environment(), stderr: "pipe" });
    await Bun.sleep(1500); // real clock on purpose: the lock wait is a real-process, real-filesystem behavior no fake timer reaches
    expect(events().length).toBe(2); // still waiting
    rmSync(lock);
    expect(await commandResult.exited).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1500);
    expect(events().length).toBe(3);

    writeFileSync(lock, "crashed");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    ok(ark("advance", run(), "abort"));
    expect(existsSync(lock)).toBe(false);
  });

  // A lock names its owner: { pid, started, token }.
  const lockOf = (pid: number) => JSON.stringify({ pid, started: new Date().toISOString(), token: "someone-else" });
  const aged = (file: string) => utimesSync(file, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));

  test("a lock whose owner is still running is never taken over, however old, and is left untouched", () => {
    const lock = runFile("ledger.lock");
    const mine = lockOf(process.pid); // this test process is alive
    writeFileSync(lock, mine);
    aged(lock);
    const result = Bun.spawnSync(["bun", COMMAND_LINE_FILE, "advance", run(), "analysis.completed"], { cwd: projectDirectory, env: environment({ ARK_LOCK_WAIT_MS: "1500" }) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`pid ${process.pid}`);
    expect(readFileSync(lock, "utf8")).toBe(mine); // not rewritten, not deleted
    expect(events().length).toBe(2);
  });

  test("a lock whose owner died is taken over at once, even when it is fresh", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const lock = runFile("ledger.lock");
    writeFileSync(lock, lockOf(dead.pid));
    const startedAt = Date.now();
    const result = Bun.spawnSync(["bun", COMMAND_LINE_FILE, "advance", run(), "analysis.completed"], { cwd: projectDirectory, env: environment({ ARK_LOCK_WAIT_MS: "3000" }) });
    expect(result.stderr.toString()).toBe("");
    expect(Date.now() - startedAt).toBeLessThan(10_000); // taken over at once, not after an age timeout
    expect(events().length).toBe(3);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("ARK-115-AC4", () => {
  beforeEach(toBuilding);
  const refused = (result: { code: number; err: string }, ...named: string[]) => {
    expect(result.code).toBe(1);
    for (const number of named) expect(result.err).toContain(number);
  };

  test("a worktree commit no implementer step recorded blocks build.completed, naming the file", () => {
    commitAll(worktree(), { "src/sneaky.ts": "export const s = 1;\n" });
    refused(ark("advance", run(), "build.completed"), "src/sneaky.ts");
    expect(slurp("state.json")).toContain('"state": "building"');
  });

  test("a dirty file blocks build.completed, naming it", () => {
    write(worktree(), { "scratch.txt": "x" });
    refused(ark("advance", run(), "build.completed"), "scratch.txt");
  });

  test("recorded implementer steps and validator test commits do not block", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    validate({ "test/a.test.ts": tagged("DEMO-1-AC1") });
    ok(ark("advance", run(), "build.completed"));
  });

  test("an unrecorded commit after build.completed blocks trace-check and the evidence packet, naming the file", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    ok(ark("advance", run(), "build.completed"));
    commitAll(worktree(), { "src/late.ts": "export const l = 1;\n" });
    refused(ark("trace-check", run()), "src/late.ts");
    refused(ark("gate", "packet", run(), "evidence"), "src/late.ts");
  });

  test("a evidence approval or send-back refuses an unrecorded commit; an abort vouches for nothing and goes through", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    const packetHash = toEvidencePacket();
    commitAll(worktree(), { "src/late.ts": "export const l = 1;\n" });
    refused(ark("gate", "answer", run(), "evidence", "approve", "--packet", packetHash), "src/late.ts");
    refused(ark("gate", "answer", run(), "evidence", "send_back", "--packet", packetHash), "src/late.ts");
    expect(slurp("state.json")).toContain('"state": "awaiting_evidence"');
    ok(ark("gate", "answer", run(), "evidence", "abort", "--packet", packetHash)); // an abort vouches for nothing
  });

  test("fix_round.started refuses an unrecorded commit", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    ok(ark("advance", run(), "build.completed"));
    commitAll(worktree(), { "src/late.ts": "export const l = 1;\n" });
    refused(ark("advance", run(), "fix_round.started"), "src/late.ts");
  });

  test("an unrecorded dirty file blocks trace-check, naming it", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    ok(ark("advance", run(), "build.completed"));
    write(worktree(), { "src/dirty.ts": "export const d = 1;\n" });
    refused(ark("trace-check", run()), "src/dirty.ts");
  });

  test("an AC-tagged test changed after the newest recorded head blocks build.completed and fix_round.started, naming it", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    commitAll(worktree(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(1)") }); // no step, no ark test: nobody vouches for it
    refused(ark("advance", run(), "build.completed"), "test/f.test.ts");
    expect(slurp("state.json")).toContain('"state": "building"');

    expect(ark("test", run(), "--criteria", "DEMO-1-AC1", "--as", "validator").err).toBe(""); // the validator step records the head, and with it the commit
    ok(ark("advance", run(), "build.completed"));
    commitAll(worktree(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(2)") }); // an edit after the newest recorded head
    refused(ark("advance", run(), "fix_round.started"), "test/f.test.ts");
  });

  test("an ark test run records a head but does not vouch for product code committed before it", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1") });
    commitAll(worktree(), { "src/sneaky.ts": "export const s = 1;\n" }); // no implementer step
    expect(ark("test", run(), "--criteria", "DEMO-1-AC1").err).toBe(""); // the validator runs the tests on that head
    refused(ark("advance", run(), "build.completed"), "src/sneaky.ts");
    refused(ark("trace-check", run()), "src/sneaky.ts");
  });

  test("an ark test run does not hide an unrecorded tagged-test edit from the next implementer step", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    commitAll(worktree(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(1)") }); // an edit nobody recorded
    expect(ark("test", run(), "--criteria", "DEMO-1-AC1").err).toBe("");
    commitAll(worktree(), { "src/b.ts": "export const b = 1;\n" });
    refused(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'), "test/f.test.ts");
  });

  test("a reset that drops the validator's tests is refused, not read as a clean step", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    const implemented = git(worktree(), "rev-parse", "HEAD");
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1") });
    ok(ark("advance", run(), "build.completed"));
    ok(ark("advance", run(), "fix_round.started"));
    git(worktree(), "reset", "-q", "--hard", implemented);
    refused(ark("advance", run(), "build.completed"), "not a descendant");
  });

  test("a tracked file hidden with assume-unchanged or skip-worktree still counts as dirty", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    write(worktree(), { "src/a.ts": "export const a = 999;\n" });
    git(worktree(), "update-index", "--assume-unchanged", "src/a.ts");
    expect(git(worktree(), "status", "--porcelain")).toBe(""); // git itself reports clean
    refused(ark("advance", run(), "build.completed"), "src/a.ts");
    git(worktree(), "update-index", "--no-assume-unchanged", "src/a.ts");
    git(worktree(), "update-index", "--skip-worktree", "src/a.ts");
    refused(ark("advance", run(), "build.completed"), "src/a.ts");
  });

  test("a replace ref cannot make an unrecorded commit look like the recorded SHA", () => {
    step({ "src/a.ts": "export const a = 2;\n" });
    const recorded = git(worktree(), "rev-parse", "HEAD");
    commitAll(worktree(), { "src/a.ts": "export const a = 999;\n" });
    const unrecorded = git(worktree(), "rev-parse", "HEAD");
    git(worktree(), "reset", "-q", "--hard", recorded);
    git(worktree(), "replace", recorded, unrecorded);
    git(worktree(), "reset", "-q", "--hard", recorded); // HEAD names the recorded SHA, the files are the unrecorded commit's
    expect(readFileSync(join(worktree(), "src/a.ts"), "utf8")).toContain("999");
    refused(ark("advance", run(), "build.completed"), "src/a.ts");
  });
});

describe("ARK-115-AC5", () => {
  beforeEach(toBuilding);

  test("tests the validator committed in an earlier round do not block a source-only fix; touching one in the step still does", () => {
    step({ "src/f.ts": "export const f = 1;\n" });
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1") });
    ok(ark("advance", run(), "build.completed"));
    ok(ark("advance", run(), "fix_round.started"));
    step({ "src/f.ts": "export const f = 2;\n" });

    commitAll(worktree(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(2)") });
    const result = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    expect(result.code).toBe(1);
    expect(result.err).toContain("test/f.test.ts");
  });

  test("a evidence send-back starts the next step the same way", () => {
    step({ "src/f.ts": "export const f = 1;\n" });
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1") });
    const packetHash = toEvidencePacket();
    ok(ark("gate", "answer", run(), "evidence", "send_back", "--packet", packetHash));
    step({ "src/f.ts": "export const f = 2;\n" });
  });

  test("moving a tagged test out of the test globs is still a touched tagged test", () => {
    step({ "src/f.ts": "export const f = 1;\n" });
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1") });
    ok(ark("advance", run(), "build.completed"));
    ok(ark("advance", run(), "fix_round.started"));
    mkdirSync(join(worktree(), "notes"));
    git(worktree(), "mv", "test/f.test.ts", "notes/f.txt");
    git(worktree(), "commit", "-qm", "move");
    const result = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    expect(result.code).toBe(1);
    expect(result.err).toContain("test/f.test.ts");
  });

  test("a tagged test whose name git would quote is still caught", () => {
    commitAll(worktree(), { "test/über.test.ts": tagged("DEMO-1-AC2") });
    const result = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    expect(result.code).toBe(1);
    expect(result.err).toContain("test/über.test.ts");
  });
});

describe("ARK-115-AC5 forged step start", () => {
  test("--data heads is refused on any event, so a tagged-test edit made before build.started still reaches the guard", () => {
    ok(ark("advance", run(), "analysis.completed"));
    writeFileSync(runFile("plan.md"), "# Plan\n");
    setKinds(runFile(""));
    ok(ark("gate", "answer", run(), "plan", "approve", "--packet", ark("gate", "packet", run(), "plan").out.trim()));
    ok(ark("worktree", "create", run()));
    commitAll(worktree(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(2)") }); // a tagged test the step will have to answer for
    const forged = JSON.stringify({ heads: { demo: git(worktree(), "rev-parse", "HEAD") } });
    const result = ark("advance", run(), "build.started", "--data", forged);
    expect(result.code).toBe(1);
    expect(result.err).toContain("heads");
    ok(ark("advance", run(), "build.started"));
    const done = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    expect(done.code).toBe(1);
    expect(done.err).toContain("test/f.test.ts");
  });
});

describe("ARK-115-AC8", () => {
  const packetFiles = () => readdirSync(runFile("gates")).sort();

  test("a plan packet embeds each source's sha256, is stored by hash, and an answer after a source changed is refused", () => {
    ok(ark("advance", run(), "analysis.completed"));
    writeFileSync(runFile("plan.md"), "# Plan v1\n");
    setKinds(runFile(""));
    const packetHash = ark("gate", "packet", run(), "plan").out.trim();
    const body = slurp(`gates/plan.${packetHash.slice("sha256:".length)}.packet.md`);
    expect(body).toContain(hash("# Plan v1\n"));
    expect(body).toContain(hash(slurp("ac.yml")));
    expect(hash(body)).toBe(packetHash);

    writeFileSync(runFile("plan.md"), "# Plan v2\n");
    const result = ark("gate", "answer", run(), "plan", "approve", "--packet", packetHash);
    expect(result.code).toBe(1);
    expect(result.err).toContain("plan.md");
    expect(slurp("state.json")).toContain('"state": "awaiting_plan"');

    ok(ark("gate", "answer", run(), "plan", "change", "--packet", packetHash)); // the way out of a changed source: answer, then rebuild
    const updatedPacketHash = ark("gate", "packet", run(), "plan").out.trim(); // rebuilding keeps the first packet on disk
    expect(updatedPacketHash).not.toBe(packetHash);
    expect(packetFiles()).toEqual([`plan.${packetHash.slice(7)}.packet.md`, `plan.${updatedPacketHash.slice(7)}.packet.md`].sort());
    ok(ark("gate", "answer", run(), "plan", "approve", "--packet", updatedPacketHash));
  });

  test("a evidence packet covers the evidence files: changing one after the packet refuses the answer", () => {
    toBuilding();
    const packetHash = toEvidencePacket();
    expect(slurp(`gates/evidence.${packetHash.slice(7)}.packet.md`)).toContain(hash("<testsuite/>"));

    writeFileSync(runFile("artifacts/junit.xml"), "<testsuite failures='1'/>");
    const result = ark("gate", "answer", run(), "evidence", "approve", "--packet", packetHash);
    expect(result.code).toBe(1);
    expect(result.err).toContain("artifacts/junit.xml");
  });

  test("a evidence packet binds ac.yml and the signed manual records: changing either after the packet refuses the approval", () => {
    toBuilding();
    const packetHash = toEvidencePacket();
    const body = slurp(`gates/evidence.${packetHash.slice(7)}.packet.md`);
    expect(body).toContain(`manual/DEMO-1-AC1.md (${hash("signed-by: P\nat: 2026-10-26\n")})`);
    expect(body).toContain(`ac.yml (${hash(slurp("ac.yml"))})`);

    writeFileSync(runFile("manual/DEMO-1-AC1.md"), "unsigned, withdrawn\n");
    const withdrawn = ark("gate", "answer", run(), "evidence", "approve", "--packet", packetHash);
    expect(withdrawn.code).toBe(1);
    expect(withdrawn.err).toContain("manual/DEMO-1-AC1.md");
    writeFileSync(runFile("manual/DEMO-1-AC1.md"), "signed-by: P\nat: 2026-10-26\n");

    writeFileSync(runFile("ac.yml"), "[]\n");
    const emptied = ark("gate", "answer", run(), "evidence", "approve", "--packet", packetHash);
    expect(emptied.code).toBe(1);
    expect(emptied.err).toContain("ac.yml");
    expect(slurp("state.json")).toContain('"state": "awaiting_evidence"');
  });
});

describe("ARK-115-AC9", () => {
  const config = (roles: Record<string, string>, extra = "") =>
    writeFileSync(join(projectDirectory, ".omp", "config.yml"), `modelRoles:\n${Object.entries(roles).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`).join("")}${extra}`);
  const CODEX = "openai-codex/gpt-6.1-sol";
  const base = { implement: CODEX, validate: "anthropic/claude-sonnet-5-5:high", "review-x": "anthropic/claude-opus-5-5:high", "review-s": CODEX };

  test.each([
    ["a comma candidate on the implementer's provider", { ...base, validate: `anthropic/DOES-NOT-EXIST,${CODEX}` }, "", `validate (${CODEX}) shares`],
    ["an alias inside a comma list", { ...base, "review-x": "anthropic/claude-opus-5-5,@implement" }, "", `review-x (${CODEX}) shares`],
    ["a role fallback chain", base, `retry:\n  fallbackChains:\n    validate: [${CODEX}]\n`, `validate (${CODEX}) shares`],
    ["the default chain, which roles without their own chain inherit", base, `retry:\n  fallbackChains:\n    default: [${CODEX}]\n`, `review-x (${CODEX}) shares`],
    ["an exact-model chain", base, `retry:\n  fallbackChains:\n    anthropic/claude-sonnet-5-5: [${CODEX}:low]\n`, `validate (${CODEX}) shares`],
    ["a provider wildcard chain", base, `retry:\n  fallbackChains:\n    "anthropic/*": [${CODEX}]\n`, `validate (${CODEX}) shares`],
    ["a chain reached through another chain", base, `retry:\n  fallbackChains:\n    validate: [anthropic/claude-haiku-5]\n    anthropic/claude-haiku-5: [${CODEX}]\n`, `validate (${CODEX}) shares`],
    ["an implementer chain that lands on the validator's provider", base, `retry:\n  fallbackChains:\n    implement: [anthropic/claude-sonnet-5-5]\n`, "validate (anthropic/claude-sonnet-5-5) shares"],
    ["a review-s chain that leaves the implementer's provider", { ...base, "review-s": "openai-codex/gpt-6-sol" }, `retry:\n  fallbackChains:\n    review-s: [anthropic/claude-opus-5-5]\n`, "review-s (anthropic/claude-opus-5-5) is not on"],
  ])("preflight refuses %s", (_n, roles, extra, message) => {
    config(roles, extra);
    const commandResult = ark("preflight");
    expect(commandResult.code).toBe(1);
    expect(commandResult.err).toContain(message);
    expect(ark("run", "start", "DEMO-1").code).toBe(1); // run start preflights before it resumes
  });

  test.each([
    ["chains that stay on the right providers", `retry:\n  fallbackChains:\n    validate: [anthropic/claude-opus-5-5]\n    review-s: [${CODEX}:low]\n    "anthropic/*": [anthropic/claude-haiku-5]\n`],
    ["a cross-vendor chain with fallback switched off", `retry:\n  modelFallback: false\n  fallbackChains:\n    validate: [${CODEX}]\n`],
  ])("preflight accepts %s", (_n, extra) => {
    config(base, extra);
    ok(ark("preflight"));
  });

  // The effective OMP config is the global config.yml merged with the project's (omp://settings.md, "Precedence"): preflight must read what OMP will run.
  const globalConfig = (yml: string) => writeFileSync(join(agentDirectory, "config.yml"), yml);

  test("a fallback chain that only the global OMP config defines is checked", () => {
    globalConfig(`retry:\n  fallbackChains:\n    anthropic/claude-sonnet-5-5: [${CODEX}]\n`);
    config(base);
    const commandResult = ark("preflight");
    expect(commandResult.code).toBe(1);
    expect(commandResult.err).toContain(`validate (${CODEX}) shares`);
    expect(commandResult.err).toContain(`via retry.fallbackChains.anthropic/claude-sonnet-5-5 (global config ${join(agentDirectory, "config.yml")})`);
  });

  test("a chain the project defines is named as the project's", () => {
    config(base, `retry:\n  fallbackChains:\n    validate: [${CODEX}]\n`);
    expect(ark("preflight").err).toContain("via retry.fallbackChains.validate (project config");
  });

  test("a role only the global OMP config defines counts, and the project's roles win over it", () => {
    globalConfig(`modelRoles:\n  review-s: ${CODEX}\n  validate: ${CODEX}\n`);
    config({ implement: CODEX, validate: "anthropic/claude-sonnet-5-5", "review-x": "anthropic/claude-opus-5-5" });
    ok(ark("preflight")); // review-s from the global file, validate from the project file
  });

  test("a wildcard fallback entry keeps the failing model's id, and that exact model's own chain is followed (omp://settings.md:587-589)", () => {
    config({ ...base, validate: "google-antigravity/gemini-3-pro" }, `retry:\n  fallbackChains:\n    google-antigravity/gemini-3-pro: ["google/*"]\n    google/gemini-3-pro: [${CODEX}]\n`);
    const commandResult = ark("preflight");
    expect(commandResult.code).toBe(1);
    expect(commandResult.err).toContain(`validate (${CODEX}) shares`);
  });

  test("an exact-model chain beats the role chain, so an exact empty chain means no fallback (omp://settings.md:579,587)", () => {
    config(base, `retry:\n  fallbackChains:\n    validate: [${CODEX}]\n    anthropic/claude-sonnet-5-5: []\n`);
    ok(ark("preflight"));
  });

  test("refusals say vendor, the glossary's word, not provider", () => {
    config({ ...base, validate: CODEX });
    const commandResult = ark("preflight");
    expect(commandResult.err).toContain("vendor 'openai-codex'");
    expect(commandResult.err).not.toContain("provider");
  });

  // The three selector shapes OMP resolves that a text comparison missed (panel re-review of PR #12).
  test.each([
    ["a fuzzy primary selector is resolved to its concrete model before its chain is looked up", { ...base, validate: "anthropic/sonnet-5-5" }, `retry:\n  fallbackChains:\n    anthropic/claude-sonnet-5-5: [${CODEX}]\n`],
    ["a wildcard entry keeps a nested id prefix, so the exact model it names is found", { ...base, validate: "openrouter/anthropic/claude-sonnet-5.5" }, `retry:\n  fallbackChains:\n    openrouter/anthropic/claude-sonnet-5.5: ["vercel-ai-gateway/*"]\n    vercel-ai-gateway/anthropic/claude-sonnet-5.5: [${CODEX}]\n`],
    ["an effort-specific chain key is not hidden by dropping the thinking suffix", { ...base, validate: "anthropic/claude-sonnet-5-5:high" }, `retry:\n  fallbackChains:\n    "anthropic/claude-sonnet-5-5:high": [${CODEX}]\n`],
    ["a role that shares the implementer's model owns the implementer's fallback (OMP matches role chains by assigned model)", base, `retry:\n  fallbackChains:\n    review-s: [anthropic/claude-opus-5-5]\n`],
  ])("preflight refuses: %s", (_n, roles, extra) => {
    config(roles, extra);
    const commandResult = ark("preflight");
    expect(commandResult.code).toBe(1);
    expect(commandResult.err).toMatch(/shares the implementer's vendor/);
  });

  // OMP runs a role against the models it has credentials for, not the whole catalog: `gpt-5` is openai/gpt-5 with no Copilot login and
  // github-copilot/gpt-5 with one (an isolated agent dir, credentials from the environment, no network).
  const copilotLogin = { ANTHROPIC_API_KEY: "x", COPILOT_GITHUB_TOKEN: "y" };
  const preflightWith = (login: Record<string, string>) => {
    const result = Bun.spawnSync(["bun", COMMAND_LINE_FILE, "preflight"], { cwd: projectDirectory, env: environment(login) });
    return { code: result.exitCode, err: result.stderr.toString(), out: result.stdout.toString() };
  };
  const onCopilot = { implement: "github-copilot/gpt-5", validate: "anthropic/claude-sonnet-5-5", "review-x": "anthropic/claude-opus-5-5", "review-s": "github-copilot/gpt-5" };

  test.each([
    ["a bare primary selector", "gpt-5"],
    ["a bare selector in a comma list", "anthropic/claude-sonnet-5-5,gpt-5"],
  ])("%s runs on the available provider and shares the implementer's vendor with it", (_n, validate) => {
    config({ ...onCopilot, validate });
    const commandResult = preflightWith(copilotLogin);
    expect(commandResult.code).toBe(1);
    expect(commandResult.err).toContain("validate (github-copilot/gpt-5) shares the implementer's vendor 'github-copilot'");
  });

  test("without a Copilot login the same bare selector is openai/gpt-5, and preflight accepts", () => {
    config({ ...onCopilot, validate: "gpt-5" });
    const commandResult = preflightWith({ ANTHROPIC_API_KEY: "x" });
    expect(commandResult.err).toBe("");
    expect(commandResult.out).toContain("validate: openai/gpt-5");
  });

  test.each([
    ["implement", { ...base, implement: "zzz-no-such-model" }, ""],
    ["validate", { ...base, validate: "anthropic/claude-sonnet-5-5,zzz-no-such-model" }, ""],
  ])("a %s selector OMP cannot resolve is refused by name, not skipped", (role, roles, extra) => {
    config(roles, extra);
    const commandResult = ark("preflight");
    expect(commandResult.code).toBe(1);
    expect(commandResult.err).toContain(`${role} names no model Oh My Pi (OMP) knows: 'zzz-no-such-model'`);
  });

  // A subagent whose role has no working credential runs on the parent session's model (OMP's resolveModelOverrideWithAuthFallback), whatever retry.modelFallback says.
  // Ark's parent is the orchestrator, i.e. the `default` role. Isolated repro: anthropic has a key command that yields nothing, default is on the implementer's vendor.
  const noAnthropicKey = () => writeFileSync(join(agentDirectory, "models.yml"), `providers:\n  anthropic:\n    apiKey: "!true"\n`);

  test.each([
    ["validate", { ...base, default: CODEX }],
    ["review-x", { ...base, default: CODEX }],
  ])("a default role on the implementer's vendor is reachable by %s through the parent fallback, and refused", (role, roles) => {
    noAnthropicKey();
    config(roles);
    const commandResult = ark("preflight");
    expect(commandResult.code).toBe(1);
    expect(commandResult.err).toContain(`${role} (${CODEX}) shares the implementer's vendor 'openai-codex' via the parent session model (the default role)`);
  });

  test("the default role's own fallback chain is part of what the parent fallback reaches", () => {
    config({ ...base, default: "anthropic/claude-opus-5-5" }, `retry:\n  fallbackChains:\n    default: [${CODEX}]\n    validate: []\n    review-x: []\n`); // the roles' own empty chains keep them off the default chain
    const commandResult = ark("preflight");
    expect(commandResult.code).toBe(1);
    expect(commandResult.err).toContain(`via the parent session model`);
  });

  test("the PRD default (default on the validator's vendor, implement on the implementer's) stays valid", () => {
    config({ ...base, default: "anthropic/claude-opus-5-5" });
    ok(ark("preflight"));
  });

  test("when OMP cannot be loaded, preflight refuses instead of guessing", () => {
    config(base);
    const result = Bun.spawnSync(["bun", COMMAND_LINE_FILE, "preflight"], { cwd: projectDirectory, env: environment({ ARK_OMP_PACKAGE: join(agentDirectory, "no-such-omp") }) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("preflight refused: Oh My Pi (OMP)'s model resolver failed");
  });
});

describe("ARK-115-AC11", () => {
  test("run start recovers a missing state.json from the ledger", () => {
    ok(ark("advance", run(), "analysis.completed"));
    rmSync(runFile("state.json"));
    const result = ark("run", "start", "DEMO-1");
    expect(result.err).toBe("");
    expect(result.out).toContain("state: analyzed");
    ok(ark("run", "replay", run(), "--check"));
  });

  test("run start rewrites a stale state.json instead of trusting it", () => {
    const stale = slurp("state.json");
    ok(ark("advance", run(), "analysis.completed"));
    writeFileSync(runFile("state.json"), stale);
    const result = ark("run", "start", "DEMO-1");
    expect(result.out).toContain("state: analyzed");
    ok(ark("run", "replay", run(), "--check"));
  });

  test.each([["packet", () => ark("gate", "packet", run(), "toString")], ["answer", () => ark("gate", "answer", run(), "toString", "approve", "--packet", "x")]])(
    "gate %s refuses an inherited property name as a gate",
    (_n, command) => {
      const result = command();
      expect(result.code).toBe(1);
      expect(result.err).toContain("unknown gate 'toString'");
    },
  );
});

describe("ARK-115-AC2 the ledger, not state.json, says whether a run is open", () => {
  const hook = (path: string) =>
    Bun.spawnSync(["bun", COMMAND_LINE_FILE, "hook", "tool_call"], { cwd: projectDirectory, env: environment(), stdin: Buffer.from(JSON.stringify({ tool: "write", input: { path }, cwd: projectDirectory })) });

  test("a state.json edited to 'aborted' does not lift the product-write block of a run whose ledger is open", () => {
    const product = join(projectDirectory, "src", "x.ts");
    expect(hook(product).exitCode).toBe(1); // the run is open: the orchestrator may not write product code
    const state = JSON.parse(slurp("state.json"));
    writeFileSync(runFile("state.json"), JSON.stringify({ ...state, status: "aborted" }));
    expect(hook(product).exitCode).toBe(1);
  });

  test("a run the ledger closed no longer blocks", () => {
    ok(ark("advance", run(), "abort"));
    expect(hook(join(projectDirectory, "src", "x.ts")).exitCode).toBe(0);
  });
});

describe("ARK-119-AC2", () => {
  test("retired gate names are rejected without changing the run", () => {
    const before = slurp("ledger.ndjson");
    for (const gate of ["G0", "GS", "G1", "G2", "GE"]) {
      const result = ark("gate", "packet", run(), gate);
      expect(result.code, gate).toBe(1);
      expect(result.err).toContain(`unknown gate '${gate}'`);
      expect(result.err).toContain("expected criteria, plan, evidence or escalation");
    }
    expect(slurp("ledger.ndjson")).toBe(before);
  });
});

// Round-budget fixtures: one round is a recorded step's worth of failure sent back (fix_round.started), then the build is closed again.
const spendRounds = (number: number) => {
  for (let i = 0; i < number; i++) {
    ok(ark("advance", run(), "fix_round.started"));
    ok(ark("advance", run(), "build.completed"));
  }
};
const escalate = (answer: string) => {
  writeFileSync(runFile("premise.md"), "Every round assumed the cache is cold.\n");
  const packetHash = ark("gate", "packet", run(), "escalation").out.trim();
  return answerGate("escalation", answer, packetHash);
};
const stateNow = () => JSON.parse(slurp("state.json"));

describe("ARK-117-AC3", () => {
  beforeEach(toBuilding);

  test("every return to implementation increments state.round; with the default budget of two, the third failure is refused and escalation opens", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    ok(ark("advance", run(), "build.completed"));
    expect(stateNow().round).toBe(0);
    spendRounds(1);
    expect(stateNow().round).toBe(1);
    spendRounds(1);
    expect(stateNow().round).toBe(2);
    const third = ark("advance", run(), "fix_round.started");
    expect(third.code).toBe(1);
    expect(third.err).toContain("round budget spent (2 of 2 rounds used)");
    expect(stateNow()).toMatchObject({ state: "judging", round: 2 });
    expect(ark("gate", "packet", run(), "escalation").err).toContain("premise.md"); // escalation is open: only the premise is missing
  });

  test("ark.yml loop.max_rounds sets the budget", () => {
    writeFileSync(join(projectDirectory, "ark.yml"), "project: demo\nloop:\n  max_rounds: 1\n");
    step({ "src/a.ts": "export const a = 1;\n" });
    ok(ark("advance", run(), "build.completed"));
    spendRounds(1);
    expect(ark("advance", run(), "fix_round.started").err).toContain("round budget spent (1 of 1 rounds used)");
    writeFileSync(join(projectDirectory, "ark.yml"), "project: demo\nloop:\n  max_rounds: many\n");
    expect(ark("advance", run(), "fix_round.started").err).toContain("loop.max_rounds must be a whole number");
  });
});

describe("ARK-117-AC4", () => {
  beforeEach(() => {
    toBuilding();
    step({ "src/a.ts": "export const a = 1;\n" });
    ok(ark("advance", run(), "build.completed"));
    spendRounds(2);
  });


  test.each(["one_more_round", "take_over"])("%s is refused when an escalation source changed after its packet was built", (answer) => {
    writeFileSync(runFile("premise.md"), "Every round assumed the cache is cold.\n");
    const packetHash = ark("gate", "packet", run(), "escalation").out.trim();
    writeFileSync(runFile("premise.md"), "A changed premise.\n");
    const refused = ark("gate", "answer", run(), "escalation", answer, "--packet", packetHash);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("premise.md");
    expect(stateNow()).toMatchObject({ state: "awaiting_escalation", round: 2 });
  });
  test("abort aborts the run", () => {
    ok(escalate("abort"));
    expect(stateNow()).toMatchObject({ state: "aborted", status: "aborted", outcome: "aborted", round: 2 });
  });

  test("one_more_round grants exactly one round: the next failure escalates again", () => {
    ok(escalate("one_more_round"));
    expect(stateNow()).toMatchObject({ state: "building", round: 3, implementer: "agent" });
    step({ "src/a.ts": "export const a = 2;\n" });
    ok(ark("advance", run(), "build.completed"));
    expect(ark("advance", run(), "fix_round.started").err).toContain("round budget spent (3 of 2 rounds used)");
    ok(escalate("abort"));
  });

  test("take_over records the human as the implementer; the run continues through validation to judging, where the budget is still spent", () => {
    ok(escalate("take_over"));
    expect(stateNow()).toMatchObject({ state: "building", round: 3, implementer: "human", next_action: { kind: "implement", agent: "human", repo: "demo" } }); // the take-over is a round, like one_more_round
    step({ "src/a.ts": "export const a = 3;\n" }); // the human commits, then the step is recorded
    expect(events().findLast((event) => event.type === "implementer.completed").data.by).toMatch(/^t <t@t> \(/); // the identity of the human who answered, not "agent"
    expect(stateNow().next_action).toMatchObject({ kind: "continue_build", agent: "orchestrator" });
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1") });
    ok(ark("advance", run(), "build.completed"));
    expect(stateNow()).toMatchObject({ state: "judging", implementer: "human", round: 3 });
    expect(ark("advance", run(), "fix_round.started").code).toBe(1); // still escalates, not a free round
  });
  test("an agent-recorded implementer step after take_over is refused", () => {
    ok(escalate("take_over"));
    commitAll(worktree(), { "src/a.ts": "export const a = 9;\n" });
    const before = events().filter((event) => event.type === "implementer.completed").length;
    const result = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    expect(result.code).toBe(1);
    expect(result.err).toContain("no matching successful ask result for implementer.completed:demo");
    expect(events().filter((event) => event.type === "implementer.completed")).toHaveLength(before);
    expect(stateNow()).toMatchObject({ state: "building", implementer: "human" });
  });

  test("a human-implementer step refused for missing proof is recorded, so a validator cannot then vouch for the tagged test committed after it", () => {
    ok(escalate("take_over"));
    commitAll(worktree(), { "test/f.test.ts": tagged("DEMO-1-AC1") });
    const refused = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'); // no confirmation from the human
    expect(refused.err).toContain("no matching successful ask result");
    expect(events().at(-1)).toMatchObject({ type: "implementer.refused", data: { repo: "demo", head_sha: git(worktree(), "rev-parse", "HEAD") } });
    commitAll(worktree(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(1); expect(2).toBe(2)") }); // weakened after the refusal
    expect(ark("test", run(), "--criteria", "DEMO-1-AC1", "--as", "validator").err).toBe("");
    const built = ark("advance", run(), "build.completed");
    expect(built.code).toBe(1);
    expect(built.err).toContain("test/f.test.ts");
  });

  test("an agent-implementer step refused for a dirty worktree is recorded the same way", () => {
    ok(escalate("one_more_round"));
    commitAll(worktree(), { "test/f.test.ts": tagged("DEMO-1-AC1") });
    writeFileSync(join(worktree(), "src/scratch.ts"), "export const scratch = 1;\n");
    expect(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}').err).toContain("uncommitted changes");
    expect(events().at(-1).type).toBe("implementer.refused");
    commitAll(worktree(), {});
    expect(ark("test", run(), "--criteria", "DEMO-1-AC1", "--as", "validator").err).toBe("");
    expect(ark("advance", run(), "build.completed").err).toContain("test/f.test.ts");
  });


  test("the human implementer is held to the same guard: touching an AC-tagged test is refused", () => {
    ok(escalate("take_over"));
    commitAll(worktree(), { "test/f.test.ts": tagged("DEMO-1-AC1") });
    confirmHumanImplementerStep();
    expect(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}').err).toContain("acceptance criterion (AC)-tagged test");
  });
});

describe("ARK-117-AC11", () => {
  beforeEach(toBuilding);
  const weakenAfterRefusal = () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    ok(ark("advance", run(), "build.completed"));
    ok(ark("advance", run(), "fix_round.started"));
    commitAll(worktree(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(1)") }); // the implementer weakens a tagged test
    const refused = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("test/f.test.ts");
  };

  test("after a refused implementer step, a plain ark test run does not vouch for the tagged-test commit", () => {
    weakenAfterRefusal();
    expect(ark("test", run(), "--criteria", "DEMO-1-AC1").err).toBe("");
    const result = ark("advance", run(), "build.completed");
    expect(result.code).toBe(1);
    expect(result.err).toContain("test/f.test.ts");
    expect(ark("trace-check", run()).err).toContain("test/f.test.ts");
  });

  test("a validator cannot vouch for a tagged-test commit after a refused implementer step", () => {
    weakenAfterRefusal();
    expect(events().findLast((event) => event.type === "implementer.refused")).toMatchObject({
      data: { repo: "demo", head_sha: git(worktree(), "rev-parse", "HEAD") },
    });
    expect(ark("test", run(), "--criteria", "DEMO-1-AC1", "--as", "validator").err).toBe("");
    expect(events().findLast((event) => event.type === "test.result").data.role).toBe("validator");
    const result = ark("advance", run(), "build.completed");
    expect(result.code).toBe(1);
    expect(result.err).toContain("test/f.test.ts");
    expect(ark("trace-check", run()).err).toContain("test/f.test.ts");
  });

  test("--as takes only 'validator'", () => {
    expect(ark("test", run(), "--criteria", "DEMO-1-AC1", "--as", "implementer").err).toContain("--as takes 'validator'");
  });
});

describe("ARK-117-AC6 failing tests", () => {
  beforeEach(toBuilding);
  const finding = (test: string) => ({ id: "F1", reviewer: "reviewer-x", model: "m", priority: "P1", file: "src/a.ts", line: 3, claim: "c", bucket: "act_on", reason: "r", evidence: { failing_test: test } });
  const record = (list: unknown[]) => {
    const file = join(dirname(projectDirectory), "findings.json");
    writeFileSync(file, JSON.stringify(list));
    return ark("findings", "record", run(), file);
  };

  test("a failing_test is verified only while the latest ark test at the current head recorded it as failing", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(2)") }); // fails
    ok(ark("advance", run(), "build.completed"));
    ok(record([finding("DEMO-1-AC1 fixture")]));

    const rerun = JSON.parse(JSON.stringify([finding("DEMO-1-AC1 fixture")]));

    rerun[0].id = "F2";
    commitAll(worktree(), { "test/other.test.ts": tagged("DEMO-1-AC2") }); // a new head the test was not run at
    const stale = record(rerun);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("none failing now");
  });
});
describe("ARK-120-AC5 evidence types", () => {
  beforeEach(toBuilding);
  const finding = (evidence: unknown) => ({ id: "F1", reviewer: "reviewer-x", model: "m", priority: "P1", file: "src/a.ts", line: 3, claim: "c", bucket: "act_on", reason: "r", evidence });
  const record = (value: unknown) => {
    const file = join(dirname(projectDirectory), "findings.json");
    writeFileSync(file, JSON.stringify([value]));
    return ark("findings", "record", run(), file);
  };
  // The validator commits a tagged test and records the head through the given 'ark test' mode; the build is then closed so findings can be recorded.
  const validated = (body: string, ...flags: string[]) => {
    step({ "src/a.ts": "export const a = 1;\n" });
    commitAll(worktree(), { "test/f.test.ts": tagged("DEMO-1-AC1", body) });
    ark("test", run(), "--criteria", "DEMO-1-AC1", "--as", "validator", ...flags);
  };

  test.each([
    ["plain", [] as string[], "test.result"],
    ["red-green", ["--red-green"], "test.red_green"],
    ["preservation", ["--preservation"], "test.preservation"],
  ])("a test failing at the current head in %s mode is accepted as failing_test evidence", (_mode, flags, type) => {
    validated("expect(1).toBe(2)", ...flags);
    expect(events().findLast((event) => event.type === type)).toBeDefined();
    ok(ark("advance", run(), "build.completed"));
    expect(record(finding({ failing_test: "DEMO-1-AC1 fixture" })).code).toBe(0);
  });

  test("a test that passes at the current head, or whose failure a later pass superseded, is not failing_test evidence", () => {
    validated("expect(1).toBe(1)");
    ok(ark("advance", run(), "build.completed"));
    expect(record(finding({ failing_test: "DEMO-1-AC1 fixture" })).code).toBe(1);

    ok(ark("advance", run(), "fix_round.started"));
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(2)") });
    ok(ark("advance", run(), "build.completed"));
    expect(record({ ...finding({ failing_test: "DEMO-1-AC1 fixture" }), id: "F2" }).code, "an open failure counts").toBe(0);
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1") });
    const superseded = record({ ...finding({ failing_test: "DEMO-1-AC1 fixture" }), id: "F3" });
    expect(superseded.code).toBe(1);
    expect(superseded.err).toContain("failing_test");
  });

  test("the evidence packet labels each finding's evidence by the field that verified it", () => {
    validated("expect(1).toBe(2)");
    ok(ark("advance", run(), "build.completed"));
    const file = join(dirname(projectDirectory), "findings.json");
    writeFileSync(file, JSON.stringify([
      finding({ failing_test: "DEMO-1-AC1 fixture" }),
      { ...finding({ traced_path: "src/a.ts:3 -> src/b.ts:9" }), id: "F2" },
    ]));
    ok(ark("findings", "record", run(), file));
    const packet = slurp(`gates/evidence.${toEvidencePacket().slice("sha256:".length)}.packet.md`);
    expect(packet).toContain("F1 P1 src/a.ts:3: failing test 'DEMO-1-AC1 fixture'");
    expect(packet).toContain("F2 P1 src/a.ts:3: traced path, weaker evidence (no test reaches it): src/a.ts:3 -> src/b.ts:9");
  });

  test.each([
    ["a non-string failing_test, even beside a valid traced_path", { failing_test: 42, traced_path: "src/a.ts:3 -> src/b.ts:9" }],
    ["a non-string traced_path", { traced_path: 42 }],
    ["an empty failing_test", { failing_test: "" }],
    ["an evidence key nobody defined", { traced_path: "src/a.ts:3 -> src/b.ts:9", mystery: true }],
  ])("%s is refused and nothing is recorded", (_what, evidence) => {
    validated("expect(1).toBe(2)");
    const before = slurp("ledger.ndjson");
    expect(record(finding(evidence)).code).toBe(1);
    expect(slurp("ledger.ndjson")).toBe(before);
  });
});
