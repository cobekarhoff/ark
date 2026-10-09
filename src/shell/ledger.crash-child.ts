/**
 * Child process of ledger.test.ts: opens a ledger with a crash point, commits batches of two events, and leaves
 * `<marker>/<n>` after each commit RETURNS (i.e. after the work the engine would do next: dispatch, cache, reply).
 * argv: <db> <markerDir> <crashCommit> <before|after> <commits>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { AbsPath, StreamId } from "../core/ids.ts";
import type { Draft, AuthoritativeEvent } from "../core/events.ts";
import { openLedger } from "./ledger.ts";

const [db, markers, crashCommit, when, commits] = process.argv.slice(2) as [string, string, string, "before" | "after", string];
const stream = "ticket:PROJ-1" as StreamId;
const ledger = openLedger(db as AbsPath, { crash: { commit: Number(crashCommit), when } });

const draft = (id: string): Draft<AuthoritativeEvent> =>
  ({ id, v: 1, ts: "2026-01-01T00:00:00Z", stream, type: "run.requested", authority: "authoritative", source: "human", data: { ticket: "PROJ-1" } }) as unknown as Draft<AuthoritativeEvent>;

let last = 0;
for (let n = 1; n <= Number(commits); n++) {
  const stored = ledger.commit({ stream, expectLastSeq: last, events: [draft(`c${n}.a`), draft(`c${n}.b`)] });
  last = stored[stored.length - 1]!.seq;
  writeFileSync(join(markers, String(n)), "");
}
ledger.close();
