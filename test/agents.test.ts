import { beforeEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKinds } from "./kinds";
import { OMP_CONFIG } from "./omp-config";
import { spawnArk } from "./tty";

const ROOT = join(import.meta.dir, "..");
const COMMAND_LINE_FILE = join(ROOT, "cli", "ark.ts");
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
let projectDirectory: string;
const ark = (argumentsList: string[], stdin?: string) => {
  const result = spawnArk(["bun", COMMAND_LINE_FILE, ...argumentsList], { cwd: projectDirectory, env: { ...process.env, ...GIT_IDENTITY, ARK_HOME: home }, stdin: stdin === undefined ? undefined : Buffer.from(stdin) });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};
const runsDirectory = () => join(home, "projects", "demo", "runs");
const run = () => readdirSync(runsDirectory()).filter((result) => result !== ".locks")[0];
const directory = () => join(runsDirectory(), run());
const ledger = () => readFileSync(join(directory(), "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const startRun = () => {
  expect(ark(["run", "start", "DEMO-7"]).code).toBe(0);
  expect(ark(["log", "route", run(), "ticket", "fixture"]).code).toBe(0);
};
const setConfig = (text: string) => writeFileSync(join(projectDirectory, ".omp", "config.yml"), text);
const temporaryPath = (name: string, value: unknown) => {
  const file = join(projectDirectory, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  projectDirectory = mkdtempSync(join(tmpdir(), "ark-proj-"));
  writeFileSync(join(projectDirectory, "ark.yml"), "project: demo\n");
  mkdirSync(join(projectDirectory, ".omp"));
  setConfig(OMP_CONFIG);
  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  writeFileSync(join(home, "projects", "demo", "tickets", "DEMO-7.md"), ticket);
});

const toJudging = () => {
  startRun();
  expect(ark(["advance", run(), "analysis.completed"]).code).toBe(0);
  writeFileSync(join(directory(), "plan.md"), "# Plan\n");
  setKinds(directory());
  const packetHash = ark(["gate", "packet", run(), "plan"]).out.trim();
  expect(ark(["gate", "answer", run(), "plan", "approve", "--packet", packetHash]).err).toBe("");
  expect(ark(["advance", run(), "build.started"]).code).toBe(0);
  expect(ark(["advance", run(), "build.completed"]).code).toBe(0);
};

describe("ARK-108-AC1", () => {
  test("log route records route.chosen with its reason as the event right after run.started, once", () => {
    ark(["run", "start", "DEMO-7"]);
    const result = ark(["log", "route", run(), "ticket", "new behavior with ACs"]);
    expect(result.code).toBe(0);
    expect(ledger().slice(0, 2).map((event) => event.type)).toEqual(["run.started", "route.chosen"]);
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
    const before = readFileSync(join(directory(), "ledger.ndjson"), "utf8");
    const result = ark(["advance", run(), "analysis.completed"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("route");
    expect(readFileSync(join(directory(), "ledger.ndjson"), "utf8")).toBe(before);
    expect(ark(["log", "route", run(), "ticket", "late"]).code).toBe(0);
  });
});

describe("ARK-108-AC2", () => {
  const agents = ["implementer", "validator", "reviewer-x"];
  const frontmatter = (name: string) => Bun.YAML.parse(readFileSync(join(ROOT, "agents", `${name}.md`), "utf8").split("\n---\n")[0].slice(4)) as Record<string, any>;

  test("each agent binds a role alias, has a narrow tool list without task, and the project config defines every alias", () => {
    const roles = (Bun.YAML.parse(readFileSync(join(ROOT, ".omp", "config.yml"), "utf8")) as { modelRoles: Record<string, string> }).modelRoles;
    const alias = { implementer: "@implement", validator: "@validate", "reviewer-x": "@review-x" };
    for (const agentName of agents) {
      const frontmatterFields = frontmatter(agentName);
      expect(frontmatterFields.model).toBe(alias[agentName as keyof typeof alias]);
      expect(roles[frontmatterFields.model.slice(1)]).toBeTruthy();
      expect(frontmatterFields.tools).not.toContain("task");
      expect(frontmatterFields.tools.length).toBeLessThanOrEqual(6);
      expect(frontmatterFields.spawns).toBeUndefined();
    }
    expect(frontmatter("reviewer-x").tools).not.toContain("write");
    expect(frontmatter("reviewer-x").tools).not.toContain("edit");
  });

});

describe("ARK-108-AC3", () => {
  const implementerResult = { repo: "demo", branch: "ark/DEMO-7-x", head_sha: "abc123", ac_addressed: ["DEMO-7-AC1"], status: "done" };

  test("a schema-valid agent result is kept under artifacts/<agent>/<n>.json and numbered per attempt", () => {
    startRun();
    const first = ark(["artifact", "record", run(), "implementer", temporaryPath("i.json", implementerResult)]);
    expect(first.code).toBe(0);
    expect(first.out).toStartWith("artifacts/implementer/1.json sha256:");
    ark(["artifact", "record", run(), "implementer", temporaryPath("i.json", implementerResult)]);
    expect(JSON.parse(readFileSync(join(directory(), "artifacts", "implementer", "2.json"), "utf8"))).toEqual(implementerResult);
  });

  test("a result that violates its schema is refused and nothing is kept", () => {
    startRun();
    const result = ark(["artifact", "record", run(), "implementer", temporaryPath("bad.json", { ...implementerResult, status: "maybe", extra: 1 })]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("fails the implementer schema");
    expect(existsSync(join(directory(), "artifacts", "implementer"))).toBe(false);
  });
});

describe("ARK-108-AC4", () => {
  const roles = (result: Record<string, string>) => `modelRoles:\n${Object.entries(result).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`).join("")}`;
  const ok = { implement: "openai-codex/gpt-6.1-sol:high", validate: "anthropic/claude-sonnet-5-5:high", "review-x": "anthropic/claude-opus-5-5:high", "review-s": "openai-codex/gpt-6-sol" };

  test("preflight accepts implement on one provider, validate and review-x on another, review-s on the implementer's", () => {
    const result = ark(["preflight"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("review-s: openai-codex/gpt-6.1-sol");
  });

  test.each([
    ["validate shares the implementer's provider", { ...ok, validate: "openai-codex/gpt-6-sol" }, "validate (openai-codex/gpt-6-sol) shares"],
    ["review-x shares the implementer's provider", { ...ok, "review-x": "openai-codex/gpt-6-luna" }, "review-x (openai-codex/gpt-6-luna) shares"],
    ["review-s is on another provider", { ...ok, "review-s": "anthropic/claude-opus-5-5" }, "review-s (anthropic/claude-opus-5-5) is not on"],
    ["an alias resolves to the implementer's provider", { ...ok, validate: "@implement" }, "validate (openai-codex/gpt-6.1-sol) shares"],
  ])("preflight refuses when %s, and run start creates no run", (_n, result, message) => {
    setConfig(roles(result));
    const preflightResult = ark(["preflight"]);
    expect(preflightResult.code).toBe(1);
    expect(preflightResult.err).toContain(message);
    expect(ark(["run", "start", "DEMO-7"]).code).toBe(1);
    expect(existsSync(runsDirectory())).toBe(false);
  });

  test("a missing role or config file is refused", () => {
    setConfig(roles({ implement: ok.implement }));
    expect(ark(["preflight"]).err).toContain("modelRoles.validate is not set");
    Bun.spawnSync(["rm", join(projectDirectory, ".omp", "config.yml")]);
    expect(ark(["preflight"]).err).toContain("no ");
  });
});

describe("ARK-108-AC5", () => {
  const finding = (overrides: Record<string, unknown> = {}) => ({
    id: "F1", reviewer: "reviewer-x", model: "anthropic/claude-opus-5-5", priority: "P2", file: "src/a.ts", line: 3,
    claim: "c", bucket: "consider", reason: "r", ...overrides,
  });

  test("every bucket is recorded with its reason; the ledger event and artifact carry the counts", () => {
    toJudging();
    const list = [finding(), finding({ id: "F2", bucket: "noted" }), finding({ id: "F3", bucket: "dismissed", reason: "false positive" }), finding({ id: "F4", priority: "P1", bucket: "act_on", evidence: { traced_path: "src/a.ts:3 -> src/b.ts:9" } })];
    const result = ark(["findings", "record", run(), temporaryPath("f.json", list)]);
    expect(result.code).toBe(0);
    const event = ledger().at(-1);
    expect(event.type).toBe("findings.recorded");
    expect(event.data).toMatchObject({ path: "artifacts/findings/1.json", ids: ["F1", "F2", "F3", "F4"], buckets: { act_on: 1, consider: 1, noted: 1, dismissed: 1 }, blocking: 1 });
    expect(JSON.parse(readFileSync(join(directory(), event.data.path), "utf8"))).toEqual(list);
    expect(JSON.parse(readFileSync(join(directory(), "state.json"), "utf8")).state).toBe("judging");
  });

  test.each([
    ["act_on P0 without evidence", { priority: "P0", bucket: "act_on" }, "act_on P0 goes back only with evidence"],
    ["act_on P1 with empty evidence", { priority: "P1", bucket: "act_on", evidence: { traced_path: " " } }, "evidence.traced_path"],
    ["evidence of another shape", { priority: "P1", bucket: "act_on", evidence: { note: "x" } }, "evidence must be"],
    ["an unknown bucket", { bucket: "maybe" }, "bucket must be one of"],
    ["a missing reason", { reason: "" }, "reason must be a non-empty string"],
    ["priority P5", { priority: "P5" }, "priority must be one of"],
  ])("a list with %s is refused and records nothing", (_n, overrides, message) => {
    toJudging();
    const before = ledger().length;
    const result = ark(["findings", "record", run(), temporaryPath("f.json", [finding(), finding({ id: "F2", ...overrides })])]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(message);
    expect(ledger().length).toBe(before);
    expect(existsSync(join(directory(), "artifacts", "findings"))).toBe(false);
  });

  test("act_on P0 and P1 are accepted with a traced path; act_on P2 needs no evidence; ids are unique across records", () => {
    toJudging();
    expect(ark(["findings", "record", run(), temporaryPath("f.json", [finding({ priority: "P0", bucket: "act_on", evidence: { traced_path: "a.ts:3 -> b.ts:9" } }), finding({ id: "F2", priority: "P2", bucket: "act_on" })])]).code).toBe(0);
    const dup = ark(["findings", "record", run(), temporaryPath("g.json", [finding()])]);
    expect(dup.err).toContain("id 'F1' is already recorded");
  });

  test("findings can be recorded only while judging", () => {
    startRun();
    expect(ark(["findings", "record", run(), temporaryPath("f.json", [finding()])]).err).toContain("illegal event 'findings.recorded' in state 'intake'");
  });
});

describe("ARK-108-AC6", () => {
  const call = (tool: string, input: Record<string, unknown>, workingDirectory = projectDirectory) => ark(["hook", "tool_call"], JSON.stringify({ tool, input, cwd: workingDirectory }));
  const inRun = (file: string) => join(directory(), file);

  test("writes inside the run folder pass; writes outside it, and to state.json or ledger.ndjson, are blocked", () => {
    startRun();
    expect(call("write", { path: inRun("plan.md") }).code).toBe(0);
    expect(call("edit", { path: inRun("inbox/x.json") }).code).toBe(0);
    expect(call("edit", { paths: [inRun("plan.md"), join(projectDirectory, "src.ts")] }).err).toContain("outside the active run folder");
    expect(call("write", { path: join(projectDirectory, "src.ts") }).err).toContain("outside the active run folder");
    expect(call("write", { path: "../x.ts" }, directory()).err).toContain("outside the active run folder");
    expect(call("write", { path: inRun("ledger.ndjson") }).err).toContain("ledger.ndjson is written only by the ark CLI");
    expect(call("edit", { path: "state.json" }, directory()).err).toContain("state.json is written only by the ark CLI");
    expect(call("write", { path: inRun("sub/../state.json") }).code).toBe(1);
  });

  test("worktrees under worktrees/ are blocked, and an edit or write that names no checkable path fails closed", () => {
    startRun();
    expect(call("write", { path: inRun("worktrees/demo/src/a.ts") }).err).toContain("worktrees belong to the implementer");
    expect(call("edit", { paths: [inRun("plan.md"), inRun("worktrees")] }).code).toBe(1);
    expect(call("write", { path: inRun("worktreesx.md") }).code).toBe(0);
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
    expect(call("read", { path: join(projectDirectory, "src.ts") }).code).toBe(0);
  });

  test("with no run, a finished run, or no ark.yml the session is not restricted", () => {
    expect(call("write", { path: join(projectDirectory, "src.ts") }).code).toBe(0);
    toJudging();
    expect(call("write", { path: join(projectDirectory, "src.ts") }).code).toBe(1);
    ark(["advance", run(), "abort"]);
    expect(call("write", { path: join(projectDirectory, "src.ts") }).code).toBe(0);
    const lost = mkdtempSync(join(tmpdir(), "ark-none-"));
    expect(call("write", { path: join(lost, "x") }, lost).code).toBe(0);
  });
});

describe("ARK-108-AC7", () => {
  const validate = new Ajv2020().compile(JSON.parse(readFileSync(join(ROOT, "schemas", "validator.schema.json"), "utf8")));
  const hash = "a41e";
  const output = (audit: unknown) => ({ repo: "r", head_sha: hash, verdicts: [{ ac: "DEMO-7-AC1", verdict: "blocked" }], test_audit: audit });
  const entry = { test: "t.test.ts > DEMO-7-AC1 x", ac: "DEMO-7-AC1", verdict: "pass", asserts_ac_behavior: true, mock_supplies_assertion: false, expected_from_subject: false };

  test("the validator output needs a per-test audit, and a pass verdict needs all three gate checks clean", () => {
    expect(validate(output([entry]))).toBe(true);
    expect(validate({ repo: "r", head_sha: hash, verdicts: [] })).toBe(false);
    expect(validate(output([{ ...entry, mock_supplies_assertion: true }]))).toBe(false);
    expect(validate(output([{ ...entry, expected_from_subject: true }]))).toBe(false);
    expect(validate(output([{ ...entry, asserts_ac_behavior: false }]))).toBe(false);
    expect(validate(output([{ ...entry, verdict: "fail", mock_supplies_assertion: true }]))).toBe(true);
  });
});
