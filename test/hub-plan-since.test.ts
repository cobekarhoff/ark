import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveState, readEvents } from "../cli/events.ts";
import { arkItems } from "../cli/hub/ark.ts";

type EventRow = [time: string, type: string, data: Record<string, unknown>];

const checked = { valid: true, problems: [], plan_hash: "hash", steps: [] };
const preamble: EventRow[] = [
  [
    "2026-11-01T09:00:00.000Z",
    "run.started",
    {
      run: "2026-11-01-ARK-900-1",
      project: "demo",
      ticket: { id: "ARK-900", title: "Plan wait" },
      criteria: ["ARK-900-AC1"],
      round_budget: 2,
    },
  ],
  ["2026-11-01T09:01:00.000Z", "evaluation.recorded", { blockers: [], risks: [], surfaces: ["none"] }],
  [
    "2026-11-01T09:02:00.000Z",
    "strategy.recorded",
    { count: 1, recommended: "S1", cards: ["S1"], reason: "only", card_text: { S1: "Only" } },
  ],
];

/** Writes fixed-time events and returns the hub's plan gate item, as the hub builds it from the run folder. */
function planGateItem(rows: EventRow[]) {
  const directory = mkdtempSync(join(tmpdir(), "ark-hub-since-"));
  const lines = [...preamble, ...rows].map(([time, type, data], index) =>
    JSON.stringify({ seq: index + 1, time, type, data }),
  );
  writeFileSync(join(directory, "events.ndjson"), `${lines.join("\n")}\n`);
  const events = readEvents(directory);
  const items = arkItems([{ directory, state: deriveState(events), events }], null, () => null);
  return items.find((item) => item.kind === "gate" && item.title.startsWith("plan gate"));
}

test("ARK-227-AC1 hub plan gate since is the first valid check after a second check", () => {
  const item = planGateItem([
    ["2026-11-01T10:00:00.000Z", "plan.checked", checked],
    ["2026-11-01T11:00:00.000Z", "plan.checked", checked],
  ]);
  expect(item?.since).toBe("2026-11-01T10:00:00.000Z");
});

test("ARK-227-AC2 hub plan gate since is the new check after a change answer", () => {
  const item = planGateItem([
    ["2026-11-01T10:00:00.000Z", "plan.checked", checked],
    ["2026-11-01T10:01:00.000Z", "gate.answered", { gate: "plan", answer: "change" }],
    ["2026-11-01T10:30:00.000Z", "plan.checked", checked],
  ]);
  expect(item?.since).toBe("2026-11-01T10:30:00.000Z");
});
