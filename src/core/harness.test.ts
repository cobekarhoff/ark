import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AbsPath, ModelId } from "./ids.ts";
import type { Signal, Usage } from "./effects.ts";
import { HARNESSES } from "./harness.ts";

// Recorded S1 streams (sanitized); `npm test` runs from the repo root.
const fixture = (name: string): string[] => readFileSync(`test/fixtures/harness/${name}.jsonl`, "utf8").split("\n").filter(Boolean);
const signals = (id: string, transcript: readonly string[]): Signal[] => transcript.flatMap((l) => HARNESSES[id]!.parseLine(l));
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const lifecycle = (ss: readonly Signal[], phase: string) => ss.filter((s) => s.kind === "lifecycle" && s.phase === phase);
const toolNames = (ss: readonly Signal[]) => ss.flatMap((s) => (s.kind === "tool_call" ? [s.name] : []));

const model = (m: string) => m as ModelId;
const input = (m: string, prompt = "do the thing") => ({ prompt, model: model(m), workdir: "/home/dev/work" as AbsPath });

test("claude-code success: session, model, tool calls, run-total usage, one done", () => {
  const t = fixture("claude-code/success");
  const ss = signals("claude-code", t);
  assert.deepEqual(lifecycle(ss, "started"), [{ kind: "lifecycle", phase: "started", msg: "session 562761f5-44de-4096-977a-13c8557f4f4c model claude-sonnet-5" }]);
  assert.deepEqual(toolNames(ss), ["Write", "Bash"]);
  const usage: Usage = { inputTokens: 4, outputTokens: 179, costUsd: 0.1440014, basis: "reported" };
  assert.deepEqual(ss.filter((s) => s.kind === "usage"), [{ kind: "usage", usage }]);
  assert.deepEqual(HARNESSES["claude-code"]!.usage(t), usage);
  assert.equal(lifecycle(ss, "done").length, 1);
  assert.equal(lifecycle(ss, "failed").length, 0);
});

test("claude-code cancelled: no done, no usage (no result event)", () => {
  const t = fixture("claude-code/cancelled");
  const ss = signals("claude-code", t);
  assert.equal(lifecycle(ss, "done").length, 0);
  assert.deepEqual(toolNames(ss), ["Bash"]);
  assert.equal(HARNESSES["claude-code"]!.usage(t), null);
});

test("claude-code error result is failed, not done", () => {
  const line = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2 } });
  const ss = HARNESSES["claude-code"]!.parseLine(line);
  assert.deepEqual(lifecycle(ss, "failed"), [{ kind: "lifecycle", phase: "failed", msg: "error_max_turns" }]);
  assert.equal(lifecycle(ss, "done").length, 0);
});

test("omp success: session, model, tool calls, usage summed per assistant message_end only, one done", () => {
  const t = fixture("omp/success");
  const ss = signals("omp", t);
  assert.deepEqual(lifecycle(ss, "started"), [{ kind: "lifecycle", phase: "started", msg: "session 01a11dc3-8fbe-7711-a7e1-a0c476ac8c2d" }]);
  assert.deepEqual(lifecycle(ss, "progress").map((s) => s.kind === "lifecycle" && s.msg), ["model claude-opus-5-5", "model claude-opus-5-5"]);
  assert.deepEqual(toolNames(ss), ["write", "bash"]);
  // two assistant messages; message_start / turn_end copies of them must not be counted again
  assert.equal(ss.filter((s) => s.kind === "usage").length, 2);
  const u = HARNESSES["omp"]!.usage(t)!;
  assert.equal(u.inputTokens, 6); //   4 + 2
  assert.equal(u.outputTokens, 184); // 180 + 4
  near(u.costUsd, 0.133304 + 0.0055702);
  assert.equal(u.basis, "reported");
  assert.equal(lifecycle(ss, "done").length, 1);
});

test("omp cancelled: agent_end after abort is failed, never done; usage still summed", () => {
  const t = fixture("omp/cancelled");
  const ss = signals("omp", t);
  assert.equal(lifecycle(ss, "done").length, 0);
  assert.deepEqual(lifecycle(ss, "failed"), [{ kind: "lifecycle", phase: "failed", msg: "Request was aborted" }]);
  assert.deepEqual(toolNames(ss), ["bash"]);
  const u = HARNESSES["omp"]!.usage(t)!;
  assert.equal(u.inputTokens, 4);
  assert.equal(u.outputTokens, 114);
  near(u.costUsd, 0.0055344);
});

test("usage is null when a transcript has no usage at all", () => {
  assert.equal(HARNESSES["omp"]!.usage([]), null);
  assert.equal(HARNESSES["claude-code"]!.usage([]), null);
  assert.equal(HARNESSES["omp"]!.usage(fixture("omp/success").slice(0, 5)), null); // before the first assistant message ends
});

test("omp: a field missing from any counted message makes that total unknown, not a partial sum", () => {
  const end = (usage: object) => JSON.stringify({ type: "message_end", message: { role: "assistant", usage } });
  const u = HARNESSES["omp"]!.usage([end({ input: 1, output: 2, cost: { total: 0.5 } }), end({ input: 3, output: 4 })])!;
  assert.deepEqual(u, { inputTokens: 4, outputTokens: 6, costUsd: null, basis: "reported" });
});

for (const id of ["claude-code", "omp"]) {
  const h = HARNESSES[id]!;
  const flagsOf = (argv: readonly string[]) => argv.slice(3); // [bin, "-p", prompt, ...flags]

  test(`${id}: invocation passes the prompt and pins --model explicitly`, () => {
    const { argv, env } = h.invocation(input("model-a", "hello"));
    assert.equal(argv[1], "-p");
    assert.equal(argv[2], "hello");
    assert.equal(argv[argv.indexOf("--model") + 1], "model-a");
    assert.deepEqual(env, {});
  });

  test(`${id}: configFingerprint tracks the model and the exact flags, not the prompt or workdir`, () => {
    const a = h.invocation(input("model-a"));
    assert.notEqual(a.configFingerprint, h.invocation(input("model-b")).configFingerprint);
    assert.equal(a.configFingerprint, h.invocation({ ...input("model-a", "another prompt"), workdir: "/elsewhere" as AbsPath }).configFingerprint);
    const fp = JSON.parse(a.configFingerprint) as { harness: string; flags: string[] };
    assert.equal(fp.harness, id);
    assert.deepEqual(fp.flags, flagsOf(a.argv)); // whatever is passed is what is recorded
  });
}

test("omp: config isolation flags (S1 finding 2) are pinned", () => {
  const { argv } = HARNESSES["omp"]!.invocation(input("m"));
  for (const f of ["--no-extensions", "--no-skills", "--no-rules", "--mode", "json"]) assert.ok(argv.includes(f), f);
});

test("claude-code: config isolation and headless flags are pinned (isolation flags unverified, see harness.ts)", () => {
  const { argv } = HARNESSES["claude-code"]!.invocation(input("m"));
  for (const f of ["--strict-mcp-config", "--setting-sources", "--disable-slash-commands", "--verbose"]) assert.ok(argv.includes(f), f);
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
});

test("parseLine never throws and ignores unknown events and malformed input", () => {
  const junk = ["", "   ", "not json", "{", "null", "42", '"str"', "[]", "{}", '{"type":"brand_new_event","x":1}', '{"type":"assistant"}',
    '{"type":"assistant","message":{"content":[null,1,{"type":"tool_use"}]}}', '{"type":"message_end","message":"x"}',
    '{"type":"agent_end","messages":"x"}', '{"type":"agent_end"}', '{"type":"result"}'];
  for (const id of ["claude-code", "omp"]) for (const l of junk) HARNESSES[id]!.parseLine(l); // a throw fails the test
  for (const id of ["claude-code", "omp"]) for (const l of junk.slice(0, 12)) assert.deepEqual(HARNESSES[id]!.parseLine(l), [], `${id}: ${l}`);
  assert.deepEqual(HARNESSES["omp"]!.parseLine('{"type":"agent_end","messages":[]}'), []);
  assert.deepEqual(HARNESSES["claude-code"]!.usage(["garbage", "{}"]), null);
});

test("every fixture line is accepted without throwing", () => {
  for (const [id, names] of [["claude-code", ["claude-code/success", "claude-code/cancelled"]], ["omp", ["omp/success", "omp/cancelled"]]] as const) {
    for (const n of names) signals(id, fixture(n));
  }
});
