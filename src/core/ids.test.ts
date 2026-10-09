import test from "node:test";
import assert from "node:assert/strict";
import type { RunId, SlotId, StageId, TicketId } from "./ids.ts";
import { effectDirName, effectKey, effectKeyParts } from "./ids.ts";

const parts = { ticket: "PROJ-1" as TicketId, run: "r_01" as RunId, stage: "review" as StageId, visit: 2, slot: "fan:1" as SlotId, n: 3 };

test("effect keys are deterministic functions of their parts and round-trip", () => {
  assert.equal(effectKey(parts), effectKey({ ...parts }));
  assert.notEqual(effectKey(parts), effectKey({ ...parts, n: 4 }));
  assert.deepEqual(effectKeyParts(effectKey(parts)), parts);
});

test("directory names are filesystem-safe and reversible", () => {
  const dir = effectDirName(effectKey(parts));
  assert.ok(!dir.includes("/") && !dir.includes(":"));
  assert.equal(decodeURIComponent(dir), effectKey(parts));
});

test("a part containing the separator is refused", () => {
  assert.throws(() => effectKey({ ...parts, stage: "a/b" as StageId }), /contains/);
});
