import { expect, setDefaultTimeout, test } from "bun:test";
import type { ArkEvent } from "../cli/events.ts";
import { gateSince } from "../hub/snapshot.ts";

setDefaultTimeout(30_000);

const log = (...rows: [number, string, Record<string, unknown>][]): ArkEvent[] =>
  rows.map(([minute, type, data], index) => ({
    seq: index + 1,
    time: new Date(Date.UTC(2026, 10, 12, 10, minute)).toISOString(),
    type,
    data: data as ArkEvent["data"],
  }));
const at = (minute: number): string => new Date(Date.UTC(2026, 10, 12, 10, minute)).toISOString();

const start: [number, string, Record<string, unknown>][] = [
  [0, "run.started", { criteria: ["A-AC1"], round_budget: 1, ticket: { id: "A", title: "t" } }],
  [1, "plan.checked", { valid: true, plan_hash: "h", steps: [{ id: "s", role: "implementer" }] }],
  [2, "gate.answered", { gate: "plan", answer: "approve" }],
  [3, "step.started", { step: "s", role: "implementer", repo: ".", round: 1 }],
  [4, "step.finished", { step: "s", outcome: "succeeded" }],
  [5, "test.completed", { passed: false, criteria: { "A-AC1": "failing" } }],
];
const later: [number, string, Record<string, unknown>][] = [
  [15, "step.started", { step: "s", role: "implementer", repo: ".", round: 1 }],
  [25, "step.finished", { step: "s", outcome: "failed" }],
  [35, "test.completed", { passed: false, criteria: { "A-AC1": "failing" } }],
];

test("ARK-T311 an escalation by a spent budget keeps the age of the test that spent it", () => {
  expect(gateSince(log(...start), "escalation")).toBe(at(5));
  expect(gateSince(log(...start, ...later), "escalation")).toBe(at(5));
});

test("ARK-T311 an escalation request starts the age, and a second escalation does not inherit it", () => {
  const first = log(...start, [6, "escalation.requested", {}], ...later);
  expect(gateSince(first, "escalation")).toBe(at(6));
  const second = log(
    ...start,
    [6, "escalation.requested", {}],
    [7, "gate.answered", { gate: "escalation", answer: "one_more_round" }],
    [8, "step.started", { step: "s", role: "implementer", repo: ".", round: 2 }],
    [9, "step.finished", { step: "s", outcome: "succeeded" }],
    [10, "test.completed", { passed: false, criteria: { "A-AC1": "failing" } }],
    ...later,
  );
  expect(gateSince(second, "escalation")).toBe(at(10));
});

test("ARK-T311 the plan gate keeps the age of its check under later events", () => {
  const events = log(...start.slice(0, 2), [30, "step.started", { step: "s" }]);
  expect(gateSince(events, "plan")).toBe(at(1));
});
