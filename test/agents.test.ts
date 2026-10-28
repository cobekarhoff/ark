import { beforeEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKinds } from "./kinds";
import { OMP_CONFIG } from "./omp-config";
import { spawnArk } from "./tty";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "cli", "ark.ts");
const GIT_IDENTITY = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@t" };
const ticket = `---
id: DEMO-7
title: "Fixture"
status: ready
acceptance_criteria:
  - id: DEMO-7-AC1
    text: "one"
  - id: DEMO-7-AC2
    text: "two"
---
Body.
`;

let home: string;
let proj: string;
const ark = (args: string[], stdin?: string) => {
  const r = spawnArk(["bun", CLI, ...args], { cwd: proj, env: { ...process.env, ...GIT_IDENTITY, ARK_HOME: home }, stdin: stdin === undefined ? undefined : Buffer.from(stdin) });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const runsDir = () => join(home, "projects", "demo", "runs");
const run = () => readdirSync(runsDir()).filter((r) => r !== ".locks")[0];
const dir = () => join(runsDir(), run());
const ledger = () => readFileSync(join(dir(), "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const startRun = () => {
  expect(ark(["run", "start", "DEMO-7"]).code).toBe(0);
  expect(ark(["log", "route", run(), "ticket", "fixture"]).code).toBe(0);
};
const setConfig = (text: string) => writeFileSync(join(proj, ".omp", "config.yml"), text);
const tmp = (name: string, value: unknown) => {
  const f = join(proj, name);
  writeFileSync(f, typeof value === "string" ? value : JSON.stringify(value));
  return f;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  proj = mkdtempSync(join(tmpdir(), "ark-proj-"));
  writeFileSync(join(proj, "ark.yml"), "project: demo\n");
  mkdirSync(join(proj, ".omp"));
  setConfig(OMP_CONFIG);
  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  writeFileSync(join(home, "projects", "demo", "tickets", "DEMO-7.md"), ticket);
});

const toJudging = () => {
  startRun();
  expect(ark(["advance", run(), "analysis.completed"]).code).toBe(0);
  writeFileSync(join(dir(), "plan.md"), "# Plan\n");
  setKinds(dir());
  const h = ark(["gate", "packet", run(), "G1"]).out.trim();
  expect(ark(["gate", "answer", run(), "G1", "approve", "--packet", h]).err).toBe("");
  expect(ark(["advance", run(), "build.started"]).code).toBe(0);
  expect(ark(["advance", run(), "build.completed"]).code).toBe(0);
};

describe("ARK-108-AC1", () => {
  test("log route records route.chosen with its reason as the event right after run.started, once", () => {
    ark(["run", "start", "DEMO-7"]);
    const r = ark(["log", "route", run(), "ticket", "new behavior with ACs"]);
    expect(r.code).toBe(0);
    expect(ledger().slice(0, 2).map((e) => e.type)).toEqual(["run.started", "route.chosen"]);
    expect(ledger()[1].data).toEqual({ playbook: "ticket", reason: "new behavior with ACs" });
    expect(ark(["log", "route", run(), "ticket", "again"]).err).toContain("already logged");
    expect(ark(["run", "replay", run(), "--check"]).code).toBe(0);
  });

  test("with no run_id the route goes to the active run; an unknown playbook is refused", () => {
    ark(["run", "start", "DEMO-7"]);
    expect(ark(["log", "route", "nonsense", "why"]).err).toContain("unknown playbook");
    expect(ark(["log", "route", "ticket", "why"]).code).toBe(0);
    expect(ledger()[1].type).toBe("route.chosen");
  });

  test("no event after run.started is legal until route.chosen is logged", () => {
    ark(["run", "start", "DEMO-7"]);
    const before = readFileSync(join(dir(), "ledger.ndjson"), "utf8");
    const r = ark(["advance", run(), "analysis.completed"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("route");
    expect(readFileSync(join(dir(), "ledger.ndjson"), "utf8")).toBe(before);
    expect(ark(["log", "route", run(), "ticket", "late"]).code).toBe(0);
  });
});

describe("ARK-108-AC2", () => {
  const agents = ["implementer", "validator", "reviewer-x"];
  const schemaOf: Record<string, string> = { implementer: "implementer", validator: "validator", "reviewer-x": "reviewer" };
  const frontmatter = (name: string) => Bun.YAML.parse(readFileSync(join(ROOT, "agents", `${name}.md`), "utf8").split("\n---\n")[0].slice(4)) as Record<string, any>;

  test("each agent binds a role alias, has a narrow tool list without task, and the project config defines every alias", () => {
    const roles = (Bun.YAML.parse(readFileSync(join(ROOT, ".omp", "config.yml"), "utf8")) as { modelRoles: Record<string, string> }).modelRoles;
    const alias = { implementer: "@implement", validator: "@validate", "reviewer-x": "@review-x" };
    for (const a of agents) {
      const fm = frontmatter(a);
      expect(fm.model).toBe(alias[a as keyof typeof alias]);
      expect(roles[fm.model.slice(1)]).toBeTruthy();
      expect(fm.tools).not.toContain("task");
      expect(fm.tools.length).toBeLessThanOrEqual(6);
      expect(fm.spawns).toBeUndefined();
    }
    expect(frontmatter("reviewer-x").tools).not.toContain("write");
    expect(frontmatter("reviewer-x").tools).not.toContain("edit");
  });

  test("the frontmatter output schema of each agent is its schemas/*.schema.json", () => {
    for (const a of agents) {
      const { $schema, $id, title, ...schema } = JSON.parse(readFileSync(join(ROOT, "schemas", `${schemaOf[a]}.schema.json`), "utf8"));
      expect(frontmatter(a).output).toEqual(schema);
      expect(frontmatter(a).structured).toBe(true);
    }
  });
});

describe("ARK-108-AC3", () => {
  const impl = { repo: "demo", branch: "ark/DEMO-7-x", head_sha: "abc123", ac_addressed: ["DEMO-7-AC1"], status: "done" };

  test("a schema-valid agent result is kept under artifacts/<agent>/<n>.json and numbered per attempt", () => {
    startRun();
    const first = ark(["artifact", "record", run(), "implementer", tmp("i.json", impl)]);
    expect(first.code).toBe(0);
    expect(first.out).toStartWith("artifacts/implementer/1.json sha256:");
    ark(["artifact", "record", run(), "implementer", tmp("i.json", impl)]);
    expect(JSON.parse(readFileSync(join(dir(), "artifacts", "implementer", "2.json"), "utf8"))).toEqual(impl);
  });

  test("a result that violates its schema is refused and nothing is kept", () => {
    startRun();
    const r = ark(["artifact", "record", run(), "implementer", tmp("bad.json", { ...impl, status: "maybe", extra: 1 })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("fails the implementer schema");
    expect(existsSync(join(dir(), "artifacts", "implementer"))).toBe(false);
  });
});

describe("ARK-108-AC4", () => {
  const roles = (r: Record<string, string>) => `modelRoles:\n${Object.entries(r).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}\n`).join("")}`;
  const ok = { implement: "openai-codex/gpt-6.1-sol:high", validate: "anthropic/claude-sonnet-5-5:high", "review-x": "anthropic/claude-opus-5-5:high", "review-s": "openai-codex/gpt-6-sol" };

  test("preflight accepts implement on one provider, validate and review-x on another, review-s on the implementer's", () => {
    const r = ark(["preflight"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("review-s: openai-codex/gpt-6.1-sol");
  });

  test.each([
    ["validate shares the implementer's provider", { ...ok, validate: "openai-codex/gpt-6-sol" }, "validate (openai-codex/gpt-6-sol) shares"],
    ["review-x shares the implementer's provider", { ...ok, "review-x": "openai-codex/gpt-6-luna" }, "review-x (openai-codex/gpt-6-luna) shares"],
    ["review-s is on another provider", { ...ok, "review-s": "anthropic/claude-opus-5-5" }, "review-s (anthropic/claude-opus-5-5) is not on"],
    ["an alias resolves to the implementer's provider", { ...ok, validate: "@implement" }, "validate (openai-codex/gpt-6.1-sol) shares"],
  ])("preflight refuses when %s, and run start creates no run", (_n, r, msg) => {
    setConfig(roles(r));
    const p = ark(["preflight"]);
    expect(p.code).toBe(1);
    expect(p.err).toContain(msg);
    expect(ark(["run", "start", "DEMO-7"]).code).toBe(1);
    expect(existsSync(runsDir())).toBe(false);
  });

  test("a missing role or config file is refused", () => {
    setConfig(roles({ implement: ok.implement }));
    expect(ark(["preflight"]).err).toContain("modelRoles.validate is not set");
    Bun.spawnSync(["rm", join(proj, ".omp", "config.yml")]);
    expect(ark(["preflight"]).err).toContain("no ");
  });
});

describe("ARK-108-AC5", () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    id: "F1", reviewer: "reviewer-x", model: "anthropic/claude-opus-5-5", priority: "P2", file: "src/a.ts", line: 3,
    claim: "c", bucket: "consider", reason: "r", ...over,
  });

  test("every bucket is recorded with its reason; the ledger event and artifact carry the counts", () => {
    toJudging();
    const list = [finding(), finding({ id: "F2", bucket: "noted" }), finding({ id: "F3", bucket: "dismissed", reason: "false positive" }), finding({ id: "F4", priority: "P1", bucket: "act_on", evidence: { traced_path: "src/a.ts:3 -> src/b.ts:9" } })];
    const r = ark(["findings", "record", run(), tmp("f.json", list)]);
    expect(r.code).toBe(0);
    const ev = ledger().at(-1);
    expect(ev.type).toBe("findings.recorded");
    expect(ev.data).toMatchObject({ path: "artifacts/findings/1.json", ids: ["F1", "F2", "F3", "F4"], buckets: { act_on: 1, consider: 1, noted: 1, dismissed: 1 }, blocking: 1 });
    expect(JSON.parse(readFileSync(join(dir(), ev.data.path), "utf8"))).toEqual(list);
    expect(JSON.parse(readFileSync(join(dir(), "state.json"), "utf8")).state).toBe("judging");
  });

  test.each([
    ["act_on P0 without evidence", { priority: "P0", bucket: "act_on" }, "act_on P0 goes back only with evidence"],
    ["act_on P1 with empty evidence", { priority: "P1", bucket: "act_on", evidence: { traced_path: " " } }, "evidence.traced_path"],
    ["evidence of another shape", { priority: "P1", bucket: "act_on", evidence: { note: "x" } }, "evidence must be"],
    ["an unknown bucket", { bucket: "maybe" }, "bucket must be one of"],
    ["a missing reason", { reason: "" }, "reason must be a non-empty string"],
    ["priority P5", { priority: "P5" }, "priority must be one of"],
  ])("a list with %s is refused and records nothing", (_n, over, msg) => {
    toJudging();
    const before = ledger().length;
    const r = ark(["findings", "record", run(), tmp("f.json", [finding(), finding({ id: "F2", ...over })])]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(msg);
    expect(ledger().length).toBe(before);
    expect(existsSync(join(dir(), "artifacts", "findings"))).toBe(false);
  });

  test("act_on P0 and P1 are accepted with a traced path; act_on P2 needs no evidence; ids are unique across records", () => {
    toJudging();
    expect(ark(["findings", "record", run(), tmp("f.json", [finding({ priority: "P0", bucket: "act_on", evidence: { traced_path: "a.ts:3 -> b.ts:9" } }), finding({ id: "F2", priority: "P2", bucket: "act_on" })])]).code).toBe(0);
    const dup = ark(["findings", "record", run(), tmp("g.json", [finding()])]);
    expect(dup.err).toContain("id 'F1' is already recorded");
  });

  test("findings can be recorded only while judging", () => {
    startRun();
    expect(ark(["findings", "record", run(), tmp("f.json", [finding()])]).err).toContain("illegal event 'findings.recorded' in state 'intake'");
  });
});

describe("ARK-108-AC6", () => {
  const call = (tool: string, input: Record<string, unknown>, cwd = proj) => ark(["hook", "tool_call"], JSON.stringify({ tool, input, cwd }));
  const inRun = (f: string) => join(dir(), f);

  test("writes inside the run folder pass; writes outside it, and to state.json or ledger.ndjson, are blocked", () => {
    startRun();
    expect(call("write", { path: inRun("plan.md") }).code).toBe(0);
    expect(call("edit", { path: inRun("inbox/x.json") }).code).toBe(0);
    expect(call("edit", { paths: [inRun("plan.md"), join(proj, "src.ts")] }).err).toContain("outside the active run folder");
    expect(call("write", { path: join(proj, "src.ts") }).err).toContain("outside the active run folder");
    expect(call("write", { path: "../x.ts" }, dir()).err).toContain("outside the active run folder");
    expect(call("write", { path: inRun("ledger.ndjson") }).err).toContain("ledger.ndjson is written only by the ark CLI");
    expect(call("edit", { path: "state.json" }, dir()).err).toContain("state.json is written only by the ark CLI");
    expect(call("write", { path: inRun("sub/../state.json") }).code).toBe(1);
  });

  test("worktrees under ws/ are blocked, and an edit or write that names no checkable path fails closed", () => {
    startRun();
    expect(call("write", { path: inRun("ws/demo/src/a.ts") }).err).toContain("worktrees belong to the implementer");
    expect(call("edit", { paths: [inRun("plan.md"), inRun("ws")] }).code).toBe(1);
    expect(call("write", { path: inRun("wsx.md") }).code).toBe(0);
    expect(call("edit", { input: "unparsable patch" }).err).toContain("names no path");
    expect(call("write", {}).code).toBe(1);
    expect(call("write", { path: "" }).code).toBe(1);
  });

  test("bash redirects onto state.json or ledger.ndjson are blocked; reads and ark calls are not", () => {
    startRun();
    expect(call("bash", { command: `echo x >> ${inRun("ledger.ndjson")}` }).code).toBe(1);
    expect(call("bash", { command: "sed -i s/a/b/ state.json" }).code).toBe(1);
    expect(call("bash", { command: `cat ${inRun("ledger.ndjson")} | head` }).code).toBe(0);
    expect(call("bash", { command: "ark advance r analysis.completed" }).code).toBe(0);
    expect(call("write", { path: "xd://ast_edit" }).code).toBe(1);
    expect(call("read", { path: join(proj, "src.ts") }).code).toBe(0);
  });

  test("with no run, a finished run, or no ark.yml the session is not restricted", () => {
    expect(call("write", { path: join(proj, "src.ts") }).code).toBe(0);
    toJudging();
    expect(call("write", { path: join(proj, "src.ts") }).code).toBe(1);
    ark(["advance", run(), "abort"]);
    expect(call("write", { path: join(proj, "src.ts") }).code).toBe(0);
    const lost = mkdtempSync(join(tmpdir(), "ark-none-"));
    expect(call("write", { path: join(lost, "x") }, lost).code).toBe(0);
  });
});

describe("ARK-108-AC7", () => {
  const validate = new Ajv2020().compile(JSON.parse(readFileSync(join(ROOT, "schemas", "validator.schema.json"), "utf8")));
  const sha = "a41e";
  const out = (audit: unknown) => ({ repo: "r", head_sha: sha, verdicts: [{ ac: "DEMO-7-AC1", verdict: "blocked" }], test_audit: audit });
  const entry = { test: "t.test.ts > DEMO-7-AC1 x", ac: "DEMO-7-AC1", verdict: "pass", asserts_ac_behavior: true, mock_supplies_assertion: false, expected_from_subject: false };

  test("the validator output needs a per-test audit, and a pass verdict needs all three gate checks clean", () => {
    expect(validate(out([entry]))).toBe(true);
    expect(validate({ repo: "r", head_sha: sha, verdicts: [] })).toBe(false);
    expect(validate(out([{ ...entry, mock_supplies_assertion: true }]))).toBe(false);
    expect(validate(out([{ ...entry, expected_from_subject: true }]))).toBe(false);
    expect(validate(out([{ ...entry, asserts_ac_behavior: false }]))).toBe(false);
    expect(validate(out([{ ...entry, verdict: "fail", mock_supplies_assertion: true }]))).toBe(true);
  });
});
