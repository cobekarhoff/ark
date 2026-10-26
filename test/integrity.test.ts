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
  suites: { unit: { format: "bun-test", level: "integration", run: 'bun test -t "{tags}" --reporter=junit --reporter-outfile=$ARK_OUT/bun.xml', junit: "$ARK_OUT/bun.xml" } },
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
const env = () => ({ ...process.env, ...GIT_IDENTITY, ARK_HOME: home });
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
    commitAll(wt(), { "test/a.test.ts": tagged("DEMO-1-AC1") });
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
});

describe("ARK-115-AC5", () => {
  beforeEach(toBuilding);

  test("tests the validator committed in an earlier round do not block a source-only fix; touching one in the step still does", () => {
    step({ "src/f.ts": "export const f = 1;\n" });
    commitAll(wt(), { "test/f.test.ts": tagged("DEMO-1-AC1") }); // validator
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
    commitAll(wt(), { "test/f.test.ts": tagged("DEMO-1-AC1") }); // validator
    const h = toG2Packet();
    ok(ark("gate", "answer", run(), "G2", "send_back", "--packet", h));
    step({ "src/f.ts": "export const f = 2;\n" });
  });

  test("a tagged test whose name git would quote is still caught", () => {
    commitAll(wt(), { "test/über.test.ts": tagged("DEMO-1-AC2") });
    const r = ark("advance", run(), "implementer.completed", "--data", '{"repo":"demo"}');
    expect(r.code).toBe(1);
    expect(r.err).toContain("test/über.test.ts");
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
    ["a review-s chain that leaves the implementer's provider", base, `retry:\n  fallbackChains:\n    review-s: [anthropic/claude-opus-5-5]\n`, "review-s (anthropic/claude-opus-5-5) is not on"],
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
