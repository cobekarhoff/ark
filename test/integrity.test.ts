import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OMP_CONFIG } from "./omp-config";

setDefaultTimeout(120_000);
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const GIT_IDENTITY = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@t" };
const CLI = join(import.meta.dir, "..", "cli", "ark.ts");

const REPO_YML = JSON.stringify({
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
const tagged = (ac: string, body = "expect(1).toBe(1)") => `import { expect, test } from "bun:test";\ntest("${ac} fixture", () => { ${body}; });\n`;

let home: string;
let proj: string;
let agentDir: string; // the global OMP config dir (PI_CODING_AGENT_DIR); empty unless a test writes a config.yml into it
const env = (extra: Record<string, string> = {}) => ({ ...process.env, ...GIT_IDENTITY, ARK_HOME: home, PI_CODING_AGENT_DIR: agentDir, ...extra });
const ark = (...args: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: proj, env: env() });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const write = (dir: string, files: Record<string, string>) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
};
const commitAll = (dir: string, files: Record<string, string>) => {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "change");
};
const runsDir = () => join(home, "projects", "demo", "runs");
const run = () => readdirSync(runsDir())[0];
const runFile = (f: string) => join(runsDir(), run(), f);
const slurp = (f: string) => readFileSync(runFile(f), "utf8");
const lines = () => slurp("ledger.ndjson").trim().split("\n");
const events = () => lines().map((l) => JSON.parse(l));
const wt = () => runFile("ws/demo");
const sha = (s: string) => `sha256:${new Bun.CryptoHasher("sha256").update(s).digest("hex")}`;
const ok = (r: { code: number; err: string }) => expect(r.err === "" ? r.code : r.err).toBe(0);

function fixture() {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  agentDir = mkdtempSync(join(tmpdir(), "ark-omp-agent-"));
  proj = join(realpathSync(mkdtempSync(join(tmpdir(), "ark-fx-"))), "demo");
  mkdirSync(proj);
  git(proj, "init", "-q", "-b", "main");
  commitAll(proj, {
    "ark.yml": "project: demo\n",
    ".omp/config.yml": OMP_CONFIG,
    ".ark/repo.yml": REPO_YML,
    "src/base.ts": "export const base = 1;\n",
  });
  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  writeFileSync(join(home, "projects", "demo", "tickets", "DEMO-1.md"), TICKET);
  ok(ark("run", "start", "DEMO-1"));
}
// start -> G1 approved -> ws create -> build.started
const toBuilding = () => {
  ok(ark("advance", run(), "analysis.completed"));
  writeFileSync(runFile("plan.md"), "# Plan\n");
  const h = ark("gate", "packet", run(), "G1").out.trim();
  ok(ark("gate", "answer", run(), "G1", "approve", "--packet", h));
  ok(ark("ws", "create", run()));
  ok(ark("advance", run(), "build.started"));
};
const step = (files: Record<string, string>) => {
  commitAll(wt(), files);
  ok(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'));
};
// The validator's work: commit tagged tests, then record the head through `ark test` (the exit code is the test verdict, not what is under test here).
const validate = (files: Record<string, string>, ac = "DEMO-1-AC1") => {
  commitAll(wt(), files);
  expect(ark("test", run(), "--acs", ac).err).toBe("");
};

beforeEach(fixture);

describe("ARK-115-AC1", () => {
  // [event type, the command that owns it]
  const owned: [string, string][] = [
    ["ws.created", "ws"], ["test.result", "test"], ["test.red_green", "test"], ["trace.checked", "trace-check"],
    ["gate.packet", "gate"], ["gate.answered", "gate"], ["mr.opened", "mr"], ["run.closed", "mr"],
    ["route.chosen", "log route"], ["findings.recorded", "findings record"], ["artifact.recorded", "artifact record"],
    ["ac.updated", "ac update"], ["ge.opened", "gate"], ["ge.answered", "gate"],
  ];
  test.each(owned)("ark advance refuses %s and names 'ark %s', writing nothing", (type, cmd) => {
    const before = slurp("ledger.ndjson");
    const r = ark("advance", run(), type, "--data", "{}");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`'${type}' is written by 'ark ${cmd}', not advance`);
    expect(slurp("ledger.ndjson")).toBe(before);
  });

  test("the owning commands still write their events", () => {
    ok(ark("log", "route", run(), "ticket", "because"));
    expect(events().map((e) => e.type)).toEqual(["run.started", "route.chosen"]);
  });

  test("escalation goes through ark gate: a GE packet from premise.md and the latest findings, answered by a human answer", () => {
    toBuilding();
    ok(ark("advance", run(), "build.completed"));
    expect(ark("gate", "packet", run(), "GE").err).toContain("premise.md"); // the packet needs the shared premise
    writeFileSync(runFile("premise.md"), "Both fixes assumed the cache is cold.\n");
    const h = ark("gate", "packet", run(), "GE").out.trim();
    expect(slurp(`gates/GE.${h.slice("sha256:".length)}.packet.md`)).toContain(sha("Both fixes assumed the cache is cold.\n"));
    expect(slurp("state.json")).toContain('"state": "awaiting_ge"');
    expect(ark("gate", "answer", run(), "GE", "guess", "--packet", h).err).toContain("unknown answer");
    ok(ark("gate", "answer", run(), "GE", "one_more_round", "--packet", h));
    expect(slurp("state.json")).toContain('"state": "building"');
    expect(events().at(-1)).toMatchObject({ type: "gate.answered", data: { gate: "GE", answer: "one_more_round" } });
  });
});

describe("ARK-115-AC2", () => {
  const advance3 = () => {
    ok(ark("advance", run(), "analysis.completed"));
    writeFileSync(runFile("plan.md"), "# Plan\n");
    ok(ark("gate", "packet", run(), "G1"));
    ok(ark("advance", run(), "abort"));
  };

  test("every line records the sha256 of the previous raw line, the first that of the empty string", () => {
    advance3();
    const ls = lines();
    expect(ls.length).toBe(4);
    ls.forEach((l, i) => expect(JSON.parse(l).prev).toBe(sha(i === 0 ? "" : ls[i - 1])));
  });

  const setLines = (ls: string[]) => writeFileSync(runFile("ledger.ndjson"), ls.length ? `${ls.join("\n")}\n` : "");
  // A schema-valid change (the year of ts moves back one), so only the hash chain can notice it.
  const edited = (ls: string[], i: number) => ls.map((l, j) => (j === i ? l.replace(/"ts":"(\d{4})/, (_, y) => `"ts":"${Number(y) - 1}`) : l));
  // [what was done to a 4-line ledger, the seq the refusal names]
  const damage: [string, (ls: string[]) => string[], number][] = [
    ["an edited middle line", (ls) => edited(ls, 1), 2],
    ["an edited last line", (ls) => edited(ls, 3), 4],
    ["a removed middle line", (ls) => ls.filter((_, i) => i !== 1), 2],
    ["a truncated tail", (ls) => ls.slice(0, 2), 3],
    ["a reordered pair", (ls) => [ls[0], ls[2], ls[1], ls[3]], 2],
  ];
  for (const [what, hit, seq] of damage) {
    test(`${what} is refused by replay, naming seq ${seq}`, () => {
      advance3();
      setLines(hit(lines()));
      const r = ark("run", "replay", run());
      expect(r.code).toBe(1);
      expect(r.err).toContain(`seq ${seq}`);
    });
  }

  test.each([
    ["advance", () => ark("advance", run(), "abort")],
    ["run replay --check", () => ark("run", "replay", run(), "--check")],
    ["run start", () => ark("run", "start", "DEMO-1")],
    ["trace-check", () => ark("trace-check", run())],
    ["gate packet", () => ark("gate", "packet", run(), "G1")],
    ["log route", () => ark("log", "route", run(), "ticket", "why")],
  ])("%s refuses a broken chain and writes nothing", (_c, cmd) => {
    advance3();
    setLines(edited(lines(), 1));
    const before = slurp("ledger.ndjson");
    const r = cmd();
    expect(r.code).toBe(1);
    expect(r.err).toContain("seq 2");
    expect(slurp("ledger.ndjson")).toBe(before);
  });

  test("artifact record reads the ledger first: a broken chain refuses it and keeps no artifact", () => {
    advance3();
    setLines(edited(lines(), 1));
    const file = join(dirname(proj), "impl.json");
    writeFileSync(file, JSON.stringify({ repo: "demo", branch: "ark/DEMO-1-x", head_sha: "abc123", ac_addressed: ["DEMO-1-AC1"], status: "done" }));
    const r = ark("artifact", "record", run(), "implementer", file);
    expect(r.code).toBe(1);
    expect(r.err).toContain("seq 2");
    expect(existsSync(runFile("artifacts/implementer"))).toBe(false);
  });
});

// Every AC manual and signed, so trace-check passes without a test run; returns the G2 packet hash. Needs building state.
const toG2Packet = () => {
  ok(ark("advance", run(), "build.completed"));
  writeFileSync(runFile("ac.yml"), "- id: DEMO-1-AC1\n  text: t\n  level: manual\n- id: DEMO-1-AC2\n  text: t\n  level: manual\n");
  mkdirSync(runFile("manual"), { recursive: true });
  for (const id of ["DEMO-1-AC1", "DEMO-1-AC2"]) writeFileSync(runFile(`manual/${id}.md`), "signed-by: P\nat: 2026-10-26\n");
  mkdirSync(runFile("artifacts"), { recursive: true });
  writeFileSync(runFile("artifacts/junit.xml"), "<testsuite/>");
  ok(ark("trace-check", run()));
  return ark("gate", "packet", run(), "G2").out.trim();
};

describe("ARK-115-AC3", () => {
  const finding = (n: number) => [{ id: `F${n}`, reviewer: "r", model: "anthropic/claude-opus-5-5", priority: "P2", file: "src/a.ts", line: 1, claim: "c", bucket: "consider", reason: "r" }];

  test("40 parallel advances leave a replayable chain with unique seq values", async () => {
    toBuilding();
    const procs = Array.from({ length: 40 }, () => Bun.spawn(["bun", CLI, "advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'], { cwd: proj, env: env(), stderr: "pipe", stdout: "pipe" }));
    const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
    expect(results.filter((r) => r.code !== 0)).toEqual([]);

    const seqs = events().map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(events().filter((e) => e.type === "implementer.completed").length).toBe(40);
    ok(ark("run", "replay", run(), "--check"));
  });

  test("40 parallel findings records leave a replayable chain with unique seq values and 40 distinct artifacts", async () => {
    toBuilding();
    ok(ark("advance", run(), "build.completed"));
    const files = Array.from({ length: 40 }, (_, n) => {
      const f = join(dirname(proj), `f${n}.json`);
      writeFileSync(f, JSON.stringify(finding(n)));
      return f;
    });
    const procs = files.map((f) => Bun.spawn(["bun", CLI, "findings", "record", run(), f], { cwd: proj, env: env(), stderr: "pipe", stdout: "pipe" }));
    const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
    expect(results.filter((r) => r.code !== 0)).toEqual([]);

    const seqs = events().map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(events().filter((e) => e.type === "findings.recorded").length).toBe(40);
    expect(readdirSync(runFile("artifacts/findings")).length).toBe(40);
    ok(ark("run", "replay", run(), "--check"));
    expect(existsSync(runFile("ledger.lock"))).toBe(false);
  });

  test("a live lock holds a writer until it is released; a stale lock does not", async () => {
    const lock = runFile("ledger.lock");
    writeFileSync(lock, "held");
    const t0 = Date.now();
    const p = Bun.spawn(["bun", CLI, "advance", run(), "analysis.completed"], { cwd: proj, env: env(), stderr: "pipe" });
    await Bun.sleep(1500); // real clock on purpose: the lock wait is a real-process, real-filesystem behavior no fake timer reaches
    expect(events().length).toBe(1); // still waiting
    rmSync(lock);
    expect(await p.exited).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
    expect(events().length).toBe(2);

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
    const r = Bun.spawnSync(["bun", CLI, "advance", run(), "analysis.completed"], { cwd: proj, env: env({ ARK_LOCK_WAIT_MS: "1500" }) });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`pid ${process.pid}`);
    expect(readFileSync(lock, "utf8")).toBe(mine); // not rewritten, not deleted
    expect(events().length).toBe(1);
  });

  test("a lock whose owner died is taken over at once, even when it is fresh", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const lock = runFile("ledger.lock");
    writeFileSync(lock, lockOf(dead.pid));
    const t0 = Date.now();
    const r = Bun.spawnSync(["bun", CLI, "advance", run(), "analysis.completed"], { cwd: proj, env: env({ ARK_LOCK_WAIT_MS: "3000" }) });
    expect(r.stderr.toString()).toBe("");
    expect(Date.now() - t0).toBeLessThan(10_000); // taken over at once, not after an age timeout
    expect(events().length).toBe(2);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("ARK-115-AC4", () => {
  beforeEach(toBuilding);
  const refused = (r: { code: number; err: string }, ...named: string[]) => {
    expect(r.code).toBe(1);
    for (const n of named) expect(r.err).toContain(n);
  };

  test("a worktree commit no implementer step recorded blocks build.completed, naming the file", () => {
    commitAll(wt(), { "src/sneaky.ts": "export const s = 1;\n" });
    refused(ark("advance", run(), "build.completed"), "src/sneaky.ts");
    expect(slurp("state.json")).toContain('"state": "building"');
  });

  test("a dirty file blocks build.completed, naming it", () => {
    write(wt(), { "scratch.txt": "x" });
    refused(ark("advance", run(), "build.completed"), "scratch.txt");
  });

  test("recorded implementer steps and validator test commits do not block", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    validate({ "test/a.test.ts": tagged("DEMO-1-AC1") });
    ok(ark("advance", run(), "build.completed"));
  });

  test("an unrecorded commit after build.completed blocks trace-check and the G2 packet, naming the file", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    ok(ark("advance", run(), "build.completed"));
    commitAll(wt(), { "src/late.ts": "export const l = 1;\n" });
    refused(ark("trace-check", run()), "src/late.ts");
    refused(ark("gate", "packet", run(), "G2"), "src/late.ts");
  });

  test("a G2 approval or send-back refuses an unrecorded commit; an abort vouches for nothing and goes through", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    const h = toG2Packet();
    commitAll(wt(), { "src/late.ts": "export const l = 1;\n" });
    refused(ark("gate", "answer", run(), "G2", "approve", "--packet", h), "src/late.ts");
    refused(ark("gate", "answer", run(), "G2", "send_back", "--packet", h), "src/late.ts");
    expect(slurp("state.json")).toContain('"state": "awaiting_g2"');
    ok(ark("gate", "answer", run(), "G2", "abort", "--packet", h)); // an abort vouches for nothing
  });

  test("fix_round.started refuses an unrecorded commit", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    ok(ark("advance", run(), "build.completed"));
    commitAll(wt(), { "src/late.ts": "export const l = 1;\n" });
    refused(ark("advance", run(), "fix_round.started"), "src/late.ts");
  });

  test("an unrecorded dirty file blocks trace-check, naming it", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    ok(ark("advance", run(), "build.completed"));
    write(wt(), { "src/dirty.ts": "export const d = 1;\n" });
    refused(ark("trace-check", run()), "src/dirty.ts");
  });

  test("an AC-tagged test changed after the newest recorded head blocks build.completed and fix_round.started, naming it", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    commitAll(wt(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(1)") }); // no step, no ark test: nobody vouches for it
    refused(ark("advance", run(), "build.completed"), "test/f.test.ts");
    expect(slurp("state.json")).toContain('"state": "building"');

    expect(ark("test", run(), "--acs", "DEMO-1-AC1").err).toBe(""); // the validator's run records the head, and with it the commit
    ok(ark("advance", run(), "build.completed"));
    commitAll(wt(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(2)") }); // an edit after the newest recorded head
    refused(ark("advance", run(), "fix_round.started"), "test/f.test.ts");
  });

  test("an ark test run records a head but does not vouch for product code committed before it", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1") });
    commitAll(wt(), { "src/sneaky.ts": "export const s = 1;\n" }); // no implementer step
    expect(ark("test", run(), "--acs", "DEMO-1-AC1").err).toBe(""); // the validator runs the tests on that head
    refused(ark("advance", run(), "build.completed"), "src/sneaky.ts");
    refused(ark("trace-check", run()), "src/sneaky.ts");
  });

  test("an ark test run does not hide an unrecorded tagged-test edit from the next implementer step", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    commitAll(wt(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(1)") }); // an edit nobody recorded
    expect(ark("test", run(), "--acs", "DEMO-1-AC1").err).toBe("");
    commitAll(wt(), { "src/b.ts": "export const b = 1;\n" });
    refused(ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}'), "test/f.test.ts");
  });

  test("a reset that drops the validator's tests is refused, not read as a clean step", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    const implemented = git(wt(), "rev-parse", "HEAD");
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1") });
    ok(ark("advance", run(), "build.completed"));
    ok(ark("advance", run(), "fix_round.started"));
    git(wt(), "reset", "-q", "--hard", implemented);
    refused(ark("advance", run(), "build.completed"), "not a descendant");
  });

  test("a tracked file hidden with assume-unchanged or skip-worktree still counts as dirty", () => {
    step({ "src/a.ts": "export const a = 1;\n" });
    write(wt(), { "src/a.ts": "export const a = 999;\n" });
    git(wt(), "update-index", "--assume-unchanged", "src/a.ts");
    expect(git(wt(), "status", "--porcelain")).toBe(""); // git itself reports clean
    refused(ark("advance", run(), "build.completed"), "src/a.ts");
    git(wt(), "update-index", "--no-assume-unchanged", "src/a.ts");
    git(wt(), "update-index", "--skip-worktree", "src/a.ts");
    refused(ark("advance", run(), "build.completed"), "src/a.ts");
  });

  test("a replace ref cannot make an unrecorded commit look like the recorded SHA", () => {
    step({ "src/a.ts": "export const a = 2;\n" });
    const recorded = git(wt(), "rev-parse", "HEAD");
    commitAll(wt(), { "src/a.ts": "export const a = 999;\n" });
    const unrecorded = git(wt(), "rev-parse", "HEAD");
    git(wt(), "reset", "-q", "--hard", recorded);
    git(wt(), "replace", recorded, unrecorded);
    git(wt(), "reset", "-q", "--hard", recorded); // HEAD names the recorded SHA, the files are the unrecorded commit's
    expect(readFileSync(join(wt(), "src/a.ts"), "utf8")).toContain("999");
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

    commitAll(wt(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(2)") });
    const r = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    expect(r.code).toBe(1);
    expect(r.err).toContain("test/f.test.ts");
  });

  test("a G2 send-back starts the next step the same way", () => {
    step({ "src/f.ts": "export const f = 1;\n" });
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1") });
    const h = toG2Packet();
    ok(ark("gate", "answer", run(), "G2", "send_back", "--packet", h));
    step({ "src/f.ts": "export const f = 2;\n" });
  });

  test("moving a tagged test out of the test globs is still a touched tagged test", () => {
    step({ "src/f.ts": "export const f = 1;\n" });
    validate({ "test/f.test.ts": tagged("DEMO-1-AC1") });
    ok(ark("advance", run(), "build.completed"));
    ok(ark("advance", run(), "fix_round.started"));
    mkdirSync(join(wt(), "notes"));
    git(wt(), "mv", "test/f.test.ts", "notes/f.txt");
    git(wt(), "commit", "-qm", "move");
    const r = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    expect(r.code).toBe(1);
    expect(r.err).toContain("test/f.test.ts");
  });

  test("a tagged test whose name git would quote is still caught", () => {
    commitAll(wt(), { "test/über.test.ts": tagged("DEMO-1-AC2") });
    const r = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    expect(r.code).toBe(1);
    expect(r.err).toContain("test/über.test.ts");
  });
});

describe("ARK-115-AC5 forged step start", () => {
  test("--data heads is refused on any event, so a tagged-test edit made before build.started still reaches the guard", () => {
    ok(ark("advance", run(), "analysis.completed"));
    writeFileSync(runFile("plan.md"), "# Plan\n");
    ok(ark("gate", "answer", run(), "G1", "approve", "--packet", ark("gate", "packet", run(), "G1").out.trim()));
    ok(ark("ws", "create", run()));
    commitAll(wt(), { "test/f.test.ts": tagged("DEMO-1-AC1", "expect(1).toBe(2)") }); // a tagged test the step will have to answer for
    const forged = JSON.stringify({ heads: { demo: git(wt(), "rev-parse", "HEAD") } });
    const r = ark("advance", run(), "build.started", "--data", forged);
    expect(r.code).toBe(1);
    expect(r.err).toContain("heads");
    ok(ark("advance", run(), "build.started"));
    const done = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    expect(done.code).toBe(1);
    expect(done.err).toContain("test/f.test.ts");
  });
});

describe("ARK-115-AC8", () => {
  const packetFiles = () => readdirSync(runFile("gates")).sort();

  test("a G1 packet embeds each source's sha256, is stored by hash, and an answer after a source changed is refused", () => {
    ok(ark("advance", run(), "analysis.completed"));
    writeFileSync(runFile("plan.md"), "# Plan v1\n");
    const h = ark("gate", "packet", run(), "G1").out.trim();
    const body = slurp(`gates/G1.${h.slice("sha256:".length)}.packet.md`);
    expect(body).toContain(sha("# Plan v1\n"));
    expect(body).toContain(sha(slurp("ac.yml")));
    expect(sha(body)).toBe(h);

    writeFileSync(runFile("plan.md"), "# Plan v2\n");
    const r = ark("gate", "answer", run(), "G1", "approve", "--packet", h);
    expect(r.code).toBe(1);
    expect(r.err).toContain("plan.md");
    expect(slurp("state.json")).toContain('"state": "awaiting_g1"');

    ok(ark("gate", "answer", run(), "G1", "change", "--packet", h)); // the way out of a changed source: answer, then rebuild
    const h2 = ark("gate", "packet", run(), "G1").out.trim(); // rebuilding keeps the first packet on disk
    expect(h2).not.toBe(h);
    expect(packetFiles()).toEqual([`G1.${h.slice(7)}.packet.md`, `G1.${h2.slice(7)}.packet.md`].sort());
    ok(ark("gate", "answer", run(), "G1", "approve", "--packet", h2));
  });

  test("a G2 packet covers the evidence files: changing one after the packet refuses the answer", () => {
    toBuilding();
    const h = toG2Packet();
    expect(slurp(`gates/G2.${h.slice(7)}.packet.md`)).toContain(sha("<testsuite/>"));

    writeFileSync(runFile("artifacts/junit.xml"), "<testsuite failures='1'/>");
    const r = ark("gate", "answer", run(), "G2", "approve", "--packet", h);
    expect(r.code).toBe(1);
    expect(r.err).toContain("artifacts/junit.xml");
  });

  test("a G2 packet binds ac.yml and the signed manual records: changing either after the packet refuses the approval", () => {
    toBuilding();
    const h = toG2Packet();
    const body = slurp(`gates/G2.${h.slice(7)}.packet.md`);
    expect(body).toContain(`manual/DEMO-1-AC1.md (${sha("signed-by: P\nat: 2026-10-26\n")})`);
    expect(body).toContain(`ac.yml (${sha(slurp("ac.yml"))})`);

    writeFileSync(runFile("manual/DEMO-1-AC1.md"), "unsigned, withdrawn\n");
    const withdrawn = ark("gate", "answer", run(), "G2", "approve", "--packet", h);
    expect(withdrawn.code).toBe(1);
    expect(withdrawn.err).toContain("manual/DEMO-1-AC1.md");
    writeFileSync(runFile("manual/DEMO-1-AC1.md"), "signed-by: P\nat: 2026-10-26\n");

    writeFileSync(runFile("ac.yml"), "[]\n");
    const emptied = ark("gate", "answer", run(), "G2", "approve", "--packet", h);
    expect(emptied.code).toBe(1);
    expect(emptied.err).toContain("ac.yml");
    expect(slurp("state.json")).toContain('"state": "awaiting_g2"');
  });
});

describe("ARK-115-AC9", () => {
  const config = (roles: Record<string, string>, extra = "") =>
    writeFileSync(join(proj, ".omp", "config.yml"), `modelRoles:\n${Object.entries(roles).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}\n`).join("")}${extra}`);
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
  ])("preflight refuses %s", (_n, roles, extra, msg) => {
    config(roles, extra);
    const p = ark("preflight");
    expect(p.code).toBe(1);
    expect(p.err).toContain(msg);
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
  const globalConfig = (yml: string) => writeFileSync(join(agentDir, "config.yml"), yml);

  test("a fallback chain that only the global OMP config defines is checked", () => {
    globalConfig(`retry:\n  fallbackChains:\n    anthropic/claude-sonnet-5-5: [${CODEX}]\n`);
    config(base);
    const p = ark("preflight");
    expect(p.code).toBe(1);
    expect(p.err).toContain(`validate (${CODEX}) shares`);
    expect(p.err).toContain(`via retry.fallbackChains.anthropic/claude-sonnet-5-5 (global config ${join(agentDir, "config.yml")})`);
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
    const p = ark("preflight");
    expect(p.code).toBe(1);
    expect(p.err).toContain(`validate (${CODEX}) shares`);
  });

  test("an exact-model chain beats the role chain, so an exact empty chain means no fallback (omp://settings.md:579,587)", () => {
    config(base, `retry:\n  fallbackChains:\n    validate: [${CODEX}]\n    anthropic/claude-sonnet-5-5: []\n`);
    ok(ark("preflight"));
  });

  test("refusals say vendor, the glossary's word, not provider", () => {
    config({ ...base, validate: CODEX });
    const p = ark("preflight");
    expect(p.err).toContain("vendor 'openai-codex'");
    expect(p.err).not.toContain("provider");
  });

  // The three selector shapes OMP resolves that a text comparison missed (panel re-review of PR #12).
  test.each([
    ["a fuzzy primary selector is resolved to its concrete model before its chain is looked up", { ...base, validate: "anthropic/sonnet-5-5" }, `retry:\n  fallbackChains:\n    anthropic/claude-sonnet-5-5: [${CODEX}]\n`],
    ["a wildcard entry keeps a nested id prefix, so the exact model it names is found", { ...base, validate: "openrouter/anthropic/claude-sonnet-5.5" }, `retry:\n  fallbackChains:\n    openrouter/anthropic/claude-sonnet-5.5: ["vercel-ai-gateway/*"]\n    vercel-ai-gateway/anthropic/claude-sonnet-5.5: [${CODEX}]\n`],
    ["an effort-specific chain key is not hidden by dropping the thinking suffix", { ...base, validate: "anthropic/claude-sonnet-5-5:high" }, `retry:\n  fallbackChains:\n    "anthropic/claude-sonnet-5-5:high": [${CODEX}]\n`],
    ["a role that shares the implementer's model owns the implementer's fallback (OMP matches role chains by assigned model)", base, `retry:\n  fallbackChains:\n    review-s: [anthropic/claude-opus-5-5]\n`],
  ])("preflight refuses: %s", (_n, roles, extra) => {
    config(roles, extra);
    const p = ark("preflight");
    expect(p.code).toBe(1);
    expect(p.err).toMatch(/shares the implementer's vendor/);
  });

  // OMP runs a role against the models it has credentials for, not the whole catalog: `gpt-5` is openai/gpt-5 with no Copilot login and
  // github-copilot/gpt-5 with one (an isolated agent dir, credentials from the environment, no network).
  const copilotLogin = { ANTHROPIC_API_KEY: "x", COPILOT_GITHUB_TOKEN: "y" };
  const preflightWith = (login: Record<string, string>) => {
    const r = Bun.spawnSync(["bun", CLI, "preflight"], { cwd: proj, env: env(login) });
    return { code: r.exitCode, err: r.stderr.toString(), out: r.stdout.toString() };
  };
  const onCopilot = { implement: "github-copilot/gpt-5", validate: "anthropic/claude-sonnet-5-5", "review-x": "anthropic/claude-opus-5-5", "review-s": "github-copilot/gpt-5" };

  test.each([
    ["a bare primary selector", "gpt-5"],
    ["a bare selector in a comma list", "anthropic/claude-sonnet-5-5,gpt-5"],
  ])("%s runs on the available provider and shares the implementer's vendor with it", (_n, validate) => {
    config({ ...onCopilot, validate });
    const p = preflightWith(copilotLogin);
    expect(p.code).toBe(1);
    expect(p.err).toContain("validate (github-copilot/gpt-5) shares the implementer's vendor 'github-copilot'");
  });

  test("without a Copilot login the same bare selector is openai/gpt-5, and preflight accepts", () => {
    config({ ...onCopilot, validate: "gpt-5" });
    const p = preflightWith({ ANTHROPIC_API_KEY: "x" });
    expect(p.err).toBe("");
    expect(p.out).toContain("validate: openai/gpt-5");
  });

  test.each([
    ["implement", { ...base, implement: "zzz-no-such-model" }, ""],
    ["validate", { ...base, validate: "anthropic/claude-sonnet-5-5,zzz-no-such-model" }, ""],
  ])("a %s selector OMP cannot resolve is refused by name, not skipped", (role, roles, extra) => {
    config(roles, extra);
    const p = ark("preflight");
    expect(p.code).toBe(1);
    expect(p.err).toContain(`${role} names no model OMP knows: 'zzz-no-such-model'`);
  });

  test("when OMP cannot be loaded, preflight refuses instead of guessing", () => {
    config(base);
    const r = Bun.spawnSync(["bun", CLI, "preflight"], { cwd: proj, env: env({ ARK_OMP_PACKAGE: join(agentDir, "no-such-omp") }) });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("preflight refused: OMP's model resolver failed");
  });
});

describe("ARK-115-AC11", () => {
  test("run start recovers a missing state.json from the ledger", () => {
    ok(ark("advance", run(), "analysis.completed"));
    rmSync(runFile("state.json"));
    const r = ark("run", "start", "DEMO-1");
    expect(r.err).toBe("");
    expect(r.out).toContain("state: analyzed");
    ok(ark("run", "replay", run(), "--check"));
  });

  test("run start rewrites a stale state.json instead of trusting it", () => {
    const stale = slurp("state.json");
    ok(ark("advance", run(), "analysis.completed"));
    writeFileSync(runFile("state.json"), stale);
    const r = ark("run", "start", "DEMO-1");
    expect(r.out).toContain("state: analyzed");
    ok(ark("run", "replay", run(), "--check"));
  });

  test.each([["packet", () => ark("gate", "packet", run(), "toString")], ["answer", () => ark("gate", "answer", run(), "toString", "approve", "--packet", "x")]])(
    "gate %s refuses an inherited property name as a gate",
    (_n, cmd) => {
      const r = cmd();
      expect(r.code).toBe(1);
      expect(r.err).toContain("unknown gate 'toString'");
    },
  );
});

describe("ARK-115-AC2 the ledger, not state.json, says whether a run is open", () => {
  const hook = (path: string) =>
    Bun.spawnSync(["bun", CLI, "hook", "tool_call"], { cwd: proj, env: env(), stdin: Buffer.from(JSON.stringify({ tool: "write", input: { path }, cwd: proj })) });

  test("a state.json edited to 'aborted' does not lift the product-write block of a run whose ledger is open", () => {
    const product = join(proj, "src", "x.ts");
    expect(hook(product).exitCode).toBe(1); // the run is open: the orchestrator may not write product code
    const state = JSON.parse(slurp("state.json"));
    writeFileSync(runFile("state.json"), JSON.stringify({ ...state, status: "aborted" }));
    expect(hook(product).exitCode).toBe(1);
  });

  test("a run the ledger closed no longer blocks", () => {
    ok(ark("advance", run(), "abort"));
    expect(hook(join(proj, "src", "x.ts")).exitCode).toBe(0);
  });
});

describe("ARK-115-AC1 user-facing wording follows CONTEXT.md", () => {
  test("help and gate errors say escalation for GE", () => {
    expect(ark("--help").out).toContain("GE is the escalation gate");
    expect(ark("gate", "packet", run(), "G9").err).toContain("GE (escalation)");
  });
});
