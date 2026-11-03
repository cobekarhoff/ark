import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

function writeConfig(ticketSource: string): void {
  writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: ticketSource,
    suites: [
      {
        name: "e2e",
        level: "e2e",
        repo: ".",
        command: "bun test",
        parser: "bun",
      },
    ],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
    },
  });
}

/** A ticket file with a status line between other front matter lines and a body that mentions status. */
function ticketWithStatus(ticketId: string, status: string): string {
  const file = writeTicket("demo", ticketId, [{ id: `${ticketId}-AC1`, text: "It works" }]);
  const text = readFileSync(file, "utf8").replace(
    `id: ${ticketId}\n`,
    `id: ${ticketId}\nstatus: ${status}\nmilestone: M1\n`,
  );
  writeFileSync(file, `${text}status: not a front matter line\n`);
  return file;
}

function startRun(ticketFile: string): { runId: string; directory: string } {
  const started = ark("run", "start", ticketFile, "--project", "demo");
  expect(started.err).toBe("");
  const runId = started.out.trim();
  return {
    runId,
    directory: join(process.env.ARK_HOME as string, "projects", "demo", "runs", runId),
  };
}

/** Puts a run past plan approval, which `merged` requires. */
function approvePlan(directory: string): void {
  writeFileSync(join(directory, "plan.yml"), "steps: []\n");
  recordEvaluation(directory);
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps: [],
  });
  appendEvent(directory, "gate.answered", { gate: "plan", answer: "approve" });
}

/** Opens a merge request on the run so `merged` is accepted; the plan gates are not needed for aborted. */
function allowMerged(directory: string): void {
  appendEvent(directory, "merge_request.opened", {
    repo: ".",
    url: "https://example.com/mr/1",
    number: 1,
  });
}

beforeEach(() => {
  tempArkHome();
  delete process.env.ARK_PROJECT;
  delete process.env.ARK_NOW;
  writeConfig("local");
});

afterEach(() => {
  delete process.env.ARK_NOW;
});

test("ARK-191-AC1 run start sets status in_progress on a local ticket and changes no other line", () => {
  const file = ticketWithStatus("ARK-910", "ready");
  const before = readFileSync(file, "utf8");
  startRun(file);
  expect(readFileSync(file, "utf8")).toBe(
    before.replace("status: ready\n", "status: in_progress\n"),
  );
});

test("ARK-191-AC1 a refused run start leaves the ticket file as it is", () => {
  const file = ticketWithStatus("ARK-911", "ready");
  const { runId } = startRun(file);
  // A second human edit between the two starts must survive the refusal.
  writeFileSync(file, readFileSync(file, "utf8").replace("in_progress", "blocked"));
  const before = readFileSync(file, "utf8");
  const again = ark("run", "start", file, "--project", "demo");
  expect(again.code).toBe(1);
  expect(again.err).toContain(runId);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("ARK-191-AC1 run start leaves the ticket file alone when ticket_source is not local", () => {
  writeConfig("github");
  const file = ticketWithStatus("ARK-912", "ready");
  const before = readFileSync(file, "utf8");
  startRun(file);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("ARK-191-AC2 run close sets done for merged and ready for aborted and abandoned", () => {
  const merged = ticketWithStatus("ARK-913", "ready");
  const mergedRun = startRun(merged);
  approvePlan(mergedRun.directory);
  allowMerged(mergedRun.directory);
  expect(ark("run", "close", mergedRun.runId, "merged").code).toBe(0);
  expect(readFileSync(merged, "utf8")).toContain("status: done\n");

  const aborted = ticketWithStatus("ARK-914", "ready");
  const abortedRun = startRun(aborted);
  expect(readFileSync(aborted, "utf8")).toContain("status: in_progress\n");
  expect(ark("run", "close", abortedRun.runId, "aborted").code).toBe(0);
  expect(readFileSync(aborted, "utf8")).toContain("status: ready\nmilestone: M1\n");

  const abandoned = ticketWithStatus("ARK-915", "ready");
  const abandonedRun = startRun(abandoned);
  approvePlan(abandonedRun.directory);
  allowMerged(abandonedRun.directory);
  expect(ark("run", "close", abandonedRun.runId, "abandoned").code).toBe(0);
  expect(readFileSync(abandoned, "utf8")).toContain("status: ready\nmilestone: M1\n");
});

test("ARK-191-AC2 run close with handed_off leaves the ticket file as it is", () => {
  const file = ticketWithStatus("ARK-916", "ready");
  const { runId, directory } = startRun(file);
  approvePlan(directory);
  appendEvent(directory, "test.completed", {
    passed: true,
    heads: {},
    suites: [],
    criteria: { "ARK-916-AC1": "passing" },
  });
  const before = readFileSync(file, "utf8");
  expect(ark("run", "close", runId, "handed_off").code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("ARK-191-AC2 run close still closes the run and warns when the ticket file is gone", () => {
  const file = ticketWithStatus("ARK-917", "ready");
  const { runId, directory } = startRun(file);
  rmSync(file);
  const closed = ark("run", "close", runId, "aborted");
  expect(closed.code).toBe(0);
  expect(closed.out).toContain(`${runId} closed: aborted`);
  expect(closed.err).toContain("warning");
  expect(existsSync(file)).toBe(false);
  expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8"))).toMatchObject({
    phase: "closed",
    outcome: "aborted",
  });
});

test("ARK-191-AC2 run close leaves the ticket file alone when ticket_source is not local", () => {
  writeConfig("github");
  const file = ticketWithStatus("ARK-918", "ready");
  const { runId } = startRun(file);
  const before = readFileSync(file, "utf8");
  expect(ark("run", "close", runId, "aborted").code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before);
});

/** Starts a run whose newest event is `minutesOld` hours before the frozen status time. */
function openRunAged(ticketId: string, minutesOld: number, statusTime: number): string {
  process.env.ARK_NOW = new Date(statusTime - minutesOld * 60_000).toISOString();
  const { runId } = startRun(writeTicket("demo", ticketId, [{ id: `${ticketId}-AC1`, text: "x" }]));
  return runId;
}

test("ARK-191-AC3 ark status shows each open run's age and marks only runs older than 24 hours stale", () => {
  const statusTime = Date.parse("2026-11-03T12:00:00Z");
  const fresh = openRunAged("ARK-920", 12, statusTime);
  const threeDays = openRunAged("ARK-921", 3 * 24 * 60, statusTime);
  const exactly24 = openRunAged("ARK-922", 24 * 60, statusTime);
  const hours25 = openRunAged("ARK-923", 25 * 60, statusTime);
  process.env.ARK_NOW = new Date(statusTime).toISOString();

  const lines = ark("status").out.trim().split("\n");
  expect(lines).toContain(`${fresh}  planning  -  12m`);
  expect(lines).toContain(`${threeDays}  planning  -  3d  stale`);
  expect(lines).toContain(`${exactly24}  planning  -  24h`);
  expect(lines).toContain(`${hours25}  planning  -  25h  stale`);
});

test("ARK-191-AC4 chief.md tells Master Chief to update the README Status cell at start and at close", () => {
  const chief = readFileSync(join(import.meta.dir, "../skills/ark/playbooks/chief.md"), "utf8");
  const start = chief.split("## 6. Start a run lead for each ready ticket")[1]?.split("\n## ")[0];
  const close = chief.split("## 8. Close the run")[1]?.split("\n## ")[0];
  expect(start).toMatch(/Status cell[^\n]*tickets\/README\.md[^\n]*`in_progress`/);
  expect(close).toMatch(/Status cell[^\n]*tickets\/README\.md[^\n]*`done`[^\n]*`ready`/);
});
