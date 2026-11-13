import { expect, test } from "bun:test";
import type { ConversationMessage, RunConversation } from "../hub/conversation.ts";
import {
  buildAxis,
  buildBeads,
  clusterBeads,
  filterProject,
  noFilter,
  nowAt,
  projectRange,
  projectRuns,
  runAtPlayhead,
  waitingBands,
} from "../hub/page/conversation-model.ts";

const at = (hm: string) => `2026-11-12T${hm}:00Z`;
const ms = (hm: string) => Date.parse(at(hm));
const msg = (id: string, run: string, hm: string | null, type: string, subject: string) =>
  ({
    id,
    type,
    from_handle: null,
    to_handle: null,
    subject,
    thread_id: null,
    run_id: null,
    created_at: hm && at(hm),
    delivered_at: hm && at(hm),
    from: type === "answer" ? "chief" : `lead:${run}`,
    to: type === "answer" ? `lead:${run}` : "chief",
  }) as ConversationMessage;
const q = (id: string, sent: string, delivered: string | null, answered: string | null) => ({
  id,
  sent: at(sent),
  delivered: delivered && at(delivered),
  answered: answered && at(answered),
  pickup_seconds: 0,
});
const conv = (run: string, project: string, p: Partial<RunConversation>): RunConversation => ({
  run,
  project,
  agents: [],
  spans: [],
  answers: [],
  questions: [],
  messages: [],
  ...p,
});
const span = (step: string, start: string, end: string | null) => ({
  step,
  role: "implementer",
  group: null,
  agent: null,
  start: at(start),
  end: end && at(end),
});

// The shared fixture of ARK-T355 to ARK-T357.
const A = conv("A", "p", {
  spans: [span("A1", "08:00", "09:00")],
  messages: [
    msg("m1", "A", "08:02", "status", "alder"),
    msg("m3", "A", "08:09", "question", "cedar"),
    msg("m4", "A", "08:25", "answer", "dogwood"),
  ],
  questions: [q("m3", "08:09", "08:10", "08:25")],
  answers: [{ time: at("08:25"), gate: "g", answer: "ok" }],
});
const B = conv("B", "p", {
  spans: [span("B1", "08:30", "11:30")],
  messages: [
    msg("m5", "B", "08:40", "question", "elm"),
    msg("m7", "B", "10:50", "question", "ginkgo"),
  ],
  questions: [
    q("m5", "08:40", "08:40", null),
    { ...q("m7", "10:50", null, null), delivered: null },
  ],
});
const C = conv("C", "p", {
  spans: [span("C1", "08:05", "08:50"), span("C2", "10:30", null)],
  messages: [
    msg("m2", "C", "08:05", "status", "birch"),
    msg("m6", "C", "10:40", "status", "fir"),
    msg("m8", "C", "11:00", "status", "hazel"),
    msg("m9", "C", null, "status", "juniper"),
  ],
});
const D = conv("D", "other", {
  spans: [span("D1", "08:00", "09:00")],
  messages: [msg("m10", "D", "08:20", "status", "kite")],
});

const open = new Map([["C", at("08:05")]]);
const runs = projectRuns([D, C, B, A], "p", open);

test("project runs: scoped, A and B close, C stays open, window ends at B's close", () => {
  expect(runs.map((r) => [r.run, r.start, r.close])).toEqual([
    ["A", ms("08:00"), ms("09:00")],
    ["C", ms("08:05"), null],
    ["B", ms("08:30"), ms("11:30")],
  ]);
  expect(projectRange(runs, [])).toEqual({ start: ms("08:00"), end: ms("11:30") });
});

test("bands: delivery or sent to answer, unanswered to the window end or playhead", () => {
  const end = ms("11:30");
  expect(waitingBands(runs, end).map((b) => [b.question, b.start, b.end, b.open])).toEqual([
    ["m3", ms("08:10"), ms("08:25"), false],
    ["m5", ms("08:40"), end, true],
    ["m7", ms("10:50"), end, true],
  ]);
  expect(waitingBands(runs, ms("08:20")).map((b) => [b.question, b.end, b.open])).toEqual([
    ["m3", ms("08:20"), true],
  ]);
});

test("beads: 8 timed messages, m9 has no position, 3 spurs", () => {
  const beads = buildBeads(runs, []);
  expect(beads).toHaveLength(8);
  expect(beads.filter((b) => b.spur).map((b) => b.id)).toEqual(["m3", "m5", "m7"]);
  const axis = buildAxis(runs, []);
  expect(axis.at(ms("08:00"))).toBe(0);
  expect(clusterBeads(beads, axis, true, 10)).toHaveLength(8);
  expect(clusterBeads(beads, axis, false, 10).flat()).toHaveLength(8);
});

test("now at the scrubber time: between steps counts live, m9 never counts", () => {
  const n = nowAt(runs, [], ms("09:30"));
  expect(n.live).toEqual([
    { run: "C", step: null },
    { run: "B", step: "B1" },
  ]);
  expect([n.messages, n.answers, n.latest.map((m) => m.id)]).toEqual([
    5,
    1,
    ["m5", "m4", "m3", "m2", "m1"],
  ]);
  expect(nowAt(runs, [], ms("11:00")).messages).toBe(8);
  expect(nowAt(runs, [], ms("08:01")).live.map((l) => l.run)).toEqual(["A"]);
});

test("filter: chip, run and subject search act on the messages; the cut is reused until something crosses", () => {
  const types = filterProject(runs, [], { ...noFilter, types: new Set(["question"]) });
  expect(types.runs.flatMap((r) => r.conversation.messages.map((m) => m.id))).toEqual([
    "m3",
    "m5",
    "m7",
  ]);
  expect(filterProject(runs, [], { ...noFilter, run: "B" }).runs.map((r) => r.run)).toEqual(["B"]);
  const elm = filterProject(runs, [], { ...noFilter, search: "elm" });
  expect(elm.runs.flatMap((r) => r.conversation.messages.map((m) => m.id))).toEqual(["m5"]);
  expect(
    filterProject(runs, [], { ...noFilter, search: "plover" }).runs.flatMap(
      (r) => r.conversation.messages,
    ),
  ).toEqual([]);
  const a = runAtPlayhead(A, ms("08:03"));
  expect(runAtPlayhead(A, ms("08:04"))).toBe(a);
  expect(runAtPlayhead(A, ms("08:10"))).not.toBe(a);
});
