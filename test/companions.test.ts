// ARK-480 companions, CLI level: the ark.yml loader (ARK-T655), the sync (ARK-T656), the wakes
// (ARK-T657), ask and answer (ARK-T658), advise and propose (ARK-T659). Every test runs the real
// `ark` process on a temporary ARK_HOME against the fake orca and gh of test/fake-companion-tools.ts,
// with the test clock (ARK_NOW). Nothing here touches the real ~/.ark or a real Orca.
import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTicket } from "../cli/ticket.ts";
import { runDirectoryOf, writeRun } from "./hub-fixtures.ts";
import { writeTicket } from "./helpers.ts";
import {
  advance,
  appendRaw,
  arkP,
  briefOf,
  dispatchOf,
  entry,
  expectRefusal,
  isoNow,
  mergedRows,
  project,
  rawRun,
  readCursor,
  runId,
  scenario,
  sectionOf,
  startedData,
  useCompanionTestEnvironment,
} from "./companions-fixtures.ts";

// A sync or a chief state starts the fake orca (a bun process) several times: allow for it.
setDefaultTimeout(90_000);
useCompanionTestEnvironment();

const allTriggers = ["run.merged", "run.started", "criteria.opened", "escalation", "ci.failed"];

// ------------------------------------------------------------------ ARK-T655

test("ARK-T655 a project with no companions key or an empty list loads and makes no Orca call", () => {
  for (const list of [undefined, []]) {
    const { fake } = scenario(list);
    const result = arkP("companions", "sync");
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toBe("");
    expect(fake.calls()).toEqual([]);
  }
});

test("ARK-T655 a valid entry passes the loader and ark status loads a config with companions", () => {
  const { fake } = scenario([{ ...entry("docs", allTriggers), harness: "claude", model: "opus" }]);
  fake.configure({ failAll: true });
  const sync = arkP("companions", "sync");
  // The loader accepted the entry: the command fails later, on the Orca read.
  expect(sync.err).toMatch(/^ark: orca orchestration run-list failed/);
  expect(sync.err).not.toContain("is not a key");
  expect(sync.code).toBe(1);
  const status = arkP("status");
  expect(status.err).toBe("");
  expect(status.code).toBe(0);
});

test("ARK-T655 each bad entry stops the command with one ark: line that names the entry and the field", () => {
  const { folder, save, raw } = scenario(undefined);
  save([entry("docs", allTriggers)]);
  writeFileSync(join(folder, "..", "outside.md"), "outside the project folder\n");
  const valid = entry("docs", allTriggers);
  const without = (key: string) => {
    const { [key]: _removed, ...rest } = valid as Record<string, unknown>;
    return rest;
  };
  const bad: [label: string, companions: unknown, fragments: string[]][] = [
    ["unknown trigger", [{ ...valid, on: ["run.merge"] }], ["docs", "run.merge"]],
    ["one good, one unknown trigger", [{ ...valid, on: ["run.merged", "nope"] }], ["docs", "nope"]],
    ["trigger that is not a string", [{ ...valid, on: [5] }], ["docs", "5"]],
    ["empty on list", [{ ...valid, on: [] }], ["docs", ".on"]],
    ["on as a string", [{ ...valid, on: "run.merged" }], ["docs", ".on"]],
    ["no on key", [without("on")], ["docs", ".on"]],
    [
      "instructions file absent",
      [{ ...valid, instructions: "companions/missing.md" }],
      ["docs", "companions/missing.md"],
    ],
    [
      "instructions file outside the project folder",
      [{ ...valid, instructions: "../outside.md" }],
      ["docs", "../outside.md"],
    ],
    [
      "absolute instructions path",
      [{ ...valid, instructions: "/etc/hosts" }],
      ["docs", "/etc/hosts"],
    ],
    ["duplicate name", [valid, valid], ["docs", "duplicates"]],
    ["name with a slash", [{ ...valid, name: "a/b" }], ["companions[0]", "a/b"]],
    ["name that is ..", [{ ...valid, name: ".." }], ["companions[0]", ".."]],
    ["name with a space", [{ ...valid, name: "has space" }], ["companions[0]", "has space"]],
    ["empty name", [{ ...valid, name: "" }], ["companions[0]", ".name"]],
    ["no harness", [without("harness")], ["companions[0]", ".harness"]],
    ["no model", [without("model")], ["companions[0]", ".model"]],
    ["no instructions", [without("instructions")], ["companions[0]", ".instructions"]],
    ["no name", [without("name")], ["companions[0]", ".name"]],
  ];
  for (const [label, companions, fragments] of bad) {
    raw(companions);
    try {
      expectRefusal(arkP("companions", "sync"), ...fragments);
    } catch (error) {
      throw new Error(`${label}: ${(error as Error).message}`);
    }
  }
  // No refusal created a folder under companions/.
  expect(readdirSync(join(folder, "companions"))).toEqual(["docs.md"]);
});

// ------------------------------------------------------------------ ARK-T656

const alphaAndBeta = () => [entry("alpha", ["run.merged"]), entry("beta", ["run.merged"])];

test("ARK-T656 sync starts each listed companion, keeps live ones, restarts a closed one and stops a removed one", () => {
  const { folder, workspace, fake, save } = scenario(alphaAndBeta());

  const first = arkP("companions", "sync");
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  expect(first.out.trim().split("\n")).toEqual(["alpha: started", "beta: started"]);
  const started = fake.started();
  expect(started.map((worker) => worker.title)).toEqual(["Companion: alpha", "Companion: beta"]);
  for (const worker of started) {
    const name = worker.title.replace("Companion: ", "");
    // Kept open past its first turn, in Master Chief's Run, in a worktree Orca knows (the fake
    // refuses any other path), with the harness and model of its entry.
    expect(worker.keepOpen).toBe(true);
    expect(worker.run).toBe("run_chief");
    expect(worker.worktree).toBe(workspace);
    expect([worker.agent, worker.model]).toEqual(["omp", "test-model"]);
    expect(worker.spec).toContain(briefOf(name));
    expect(worker.spec).toContain(folder);
    expect(worker.spec).toContain(`companions/${name}`);
  }
  const alpha = dispatchOf(folder, "alpha");
  const beta = dispatchOf(folder, "beta");
  expect(new Set([alpha, beta]).size).toBe(2);
  expect(fake.live().toSorted()).toEqual([alpha, beta].toSorted());

  // Both workers sent worker_done and sit idle: Orca lists them live and retained, and they still run.
  fake.retain(alpha);
  fake.retain(beta);
  // A second sync keeps both.
  const second = arkP("companions", "sync");
  expect(second.out.trim().split("\n")).toEqual(["alpha: running", "beta: running"]);
  expect(fake.started()).toHaveLength(2);

  // The worker of beta closed: the next sync starts a new one.
  fake.close(beta);
  const third = arkP("companions", "sync");
  expect(third.out.trim().split("\n")).toEqual(["alpha: running", "beta: started"]);
  expect(dispatchOf(folder, "beta")).not.toBe(beta);
  expect(fake.started()).toHaveLength(3);

  // alpha leaves ark.yml: its worker is stopped and its folder keeps its ideas.
  writeFileSync(join(folder, "companions", "alpha", "ideas.md"), "- split the e2e suite\n");
  save([entry("beta", ["run.merged"])]);
  const fourth = arkP("companions", "sync");
  expect(fourth.err).toBe("");
  expect(fourth.out.trim().split("\n").toSorted()).toEqual(["alpha: stopped", "beta: running"]);
  // worker-stop leaves a kept-open worker live and retained; only worker-release ends it.
  const removal = fake
    .calls()
    .filter((args) => args[1] === "worker-stop" || args[1] === "worker-release")
    .map((args) => [args[1], args[args.indexOf("--dispatch") + 1]]);
  expect(removal).toEqual([
    ["worker-stop", alpha],
    ["worker-release", alpha],
  ]);
  const alphaRow = fake.rows().find((row) => row.dispatchId === alpha)!;
  expect([alphaRow.liveness, alphaRow.terminalState]).toEqual(["exited", "released"]);
  expect(fake.live()).not.toContain(alpha);
  expect(readFileSync(join(folder, "companions", "alpha", "ideas.md"), "utf8")).toBe(
    "- split the e2e suite\n",
  );
});

test("ARK-T656 sync with no Master Chief Run starts nothing and records nothing", () => {
  const { folder, fake } = scenario(alphaAndBeta());
  fake.configure({ runs: [] });
  expectRefusal(arkP("companions", "sync"), "Master Chief");
  expect(fake.verbs()).not.toContain("worker-start");
  expect(existsSync(join(folder, "companions", "alpha", "worker.json"))).toBe(false);
  expect(existsSync(join(folder, "companions", "beta", "worker.json"))).toBe(false);
});

test("ARK-T656 a failed worker-start is not recorded as running, and the next sync starts that companion again", () => {
  const { folder, fake } = scenario(alphaAndBeta());
  fake.configure({ failStartFor: ["alpha"] });
  const result = arkP("companions", "sync");
  expect(result.err.trim().split("\n")).toHaveLength(1);
  expect(result.err).toMatch(/^ark: .*alpha/);
  expect(result.code).toBe(1);
  // beta is still handled; alpha has no dispatch id on record.
  expect(result.out.trim().split("\n")).toEqual(["beta: started"]);
  expect(existsSync(join(folder, "companions", "alpha", "worker.json"))).toBe(false);
  expect(existsSync(join(folder, "companions", "beta", "worker.json"))).toBe(true);

  fake.configure({ failStartFor: [] });
  const retry = arkP("companions", "sync");
  expect(retry.err).toBe("");
  expect(retry.out.trim().split("\n")).toEqual(["alpha: started", "beta: running"]);
});

test("ARK-T656 a failed worker-stop keeps the record of the removed companion, so the next sync stops it again", () => {
  const { folder, fake, save } = scenario(alphaAndBeta());
  expect(arkP("companions", "sync").code).toBe(0);
  const alpha = dispatchOf(folder, "alpha");
  save([entry("beta", ["run.merged"])]);
  fake.configure({ failVerbs: ["worker-stop"] });
  const failed = arkP("companions", "sync");
  expect(failed.err.trim().split("\n")).toHaveLength(1);
  expect(failed.err).toMatch(/^ark: .*alpha/);
  expect(failed.code).toBe(1);
  expect(failed.out).not.toContain("alpha: stopped");
  expect(dispatchOf(folder, "alpha")).toBe(alpha);

  fake.configure({ failVerbs: [] });
  const retry = arkP("companions", "sync");
  expect(retry.err).toBe("");
  expect(retry.out).toContain("alpha: stopped");
  const verbs = fake.calls().map((args) => args[1]);
  expect(verbs.filter((verb) => verb === "worker-stop" || verb === "worker-release")).toEqual([
    "worker-stop",
    "worker-stop",
    "worker-release",
  ]);
  expect(fake.live()).not.toContain(alpha);
});

test("ARK-T656 a release that fails with dispatch_inactive after the stop is fine, and any other release failure is named", () => {
  const { folder, fake, save } = scenario(alphaAndBeta());
  expect(arkP("companions", "sync").code).toBe(0);
  save([entry("beta", ["run.merged"])]);
  fake.configure({ releaseError: "dispatch_inactive" });
  const inactive = arkP("companions", "sync");
  expect(inactive.err).toBe("");
  expect(inactive.code).toBe(0);
  expect(inactive.out).toContain("alpha: stopped");

  // Another removal, with a release that really fails.
  save([]);
  fake.configure({ releaseError: "boom" });
  const failed = arkP("companions", "sync");
  expect(failed.err.trim().split("\n")).toHaveLength(1);
  expect(failed.err).toMatch(/^ark: .*beta/);
  expect(failed.code).toBe(1);
  expect(failed.out).not.toContain("beta: stopped");
  expect(dispatchOf(folder, "beta")).toBeDefined();
});

test("ARK-T656 with Orca down the sync names the Orca error and never says running or stopped", () => {
  const { fake } = scenario(alphaAndBeta());
  fake.configure({ failAll: true });
  const result = arkP("companions", "sync");
  expectRefusal(result, "orca");
  expect(result.out).not.toMatch(/running|stopped|started/);
});

test("ARK-T656 with no companion listed or recorded, sync makes no Orca call and chief state makes only the calls it made before companions", () => {
  const { fake } = scenario(undefined);
  const sync = arkP("companions", "sync");
  expect(sync.err).toBe("");
  expect(sync.code).toBe(0);
  expect(sync.out).toBe("");
  expect(fake.calls()).toEqual([]);

  const state = arkP("chief", "state");
  expect(state.err).toBe("");
  expect(state.code).toBe(0);
  // Master Chief's Run list, its worker list, and the two task lists of the queue.
  expect(fake.verbs().toSorted()).toEqual(["run-list", "task-list", "task-list", "worker-list"]);
  expect(state.out).not.toContain("## Companions");
  expect(sectionOf(state.out, "Run leads")).toMatch(/^Run leads\s+none\s*$/);
});

test("ARK-T656 chief state runs the same sync in its own Companions section and leaves its other sections as they were", () => {
  const { folder, fake } = scenario(alphaAndBeta());
  expect(arkP("companions", "sync").code).toBe(0);
  fake.clearCalls();

  const state = arkP("chief", "state");
  expect(state.err).toBe("");
  expect(state.code).toBe(0);
  const companions = sectionOf(state.out, "Companions");
  expect(companions).toContain("alpha: running");
  expect(companions).toContain("beta: running");
  // A companion worker is no run lead, and the sections around it read as they do with no companion.
  expect(sectionOf(state.out, "Run leads")).toMatch(/^Run leads\s+none\s*$/);
  expect(sectionOf(state.out, "Red on main")).toMatch(/^Red on main\s+none\s*$/);
  expect(sectionOf(state.out, "Host")).toMatch(/free disk: \d+ GB/);
  const verbs = fake.verbs();
  for (const verb of ["worker-start", "worker-stop", "send"]) expect(verbs).not.toContain(verb);

  // A closed worker is started again by chief state itself.
  fake.close(dispatchOf(folder, "beta"));
  const restarted = arkP("chief", "state");
  expect(sectionOf(restarted.out, "Companions")).toContain("beta: started");
});

test("ARK-T656 chief state says unavailable in the Companions section when Orca is down and still exits 0", () => {
  const { fake } = scenario(alphaAndBeta());
  fake.configure({ failAll: true });
  const state = arkP("chief", "state");
  expect(state.code).toBe(0);
  const companions = sectionOf(state.out, "Companions");
  expect(companions).toContain("unavailable");
  expect(companions).not.toMatch(/stopped|running/);
  expect(sectionOf(state.out, "Host")).toMatch(/free disk: \d+ GB/);
});

// ------------------------------------------------------------------ ARK-T657

const mergerAndStarter = () => [
  entry("merger", ["run.merged", "escalation"]),
  entry("starter", ["run.started", "criteria.opened", "ci.failed"]),
];
const pullRequest = "https://github.com/example/app/pull/7";

/** The bodies of the wake messages delivered to the live worker of `name`. */
const wakesTo = (sent: { to: string; body: string }[], folder: string, name: string): string[] =>
  sent
    .filter((message) => message.to === `dispatch:${dispatchOf(folder, name)}`)
    .map((m) => m.body);

/** An open run in `merge_requests_open` whose MR is `pullRequest`, with its worktree at `workspace`. */
function openMergeRequestRun(run: string, workspace: string): void {
  writeRun({
    project,
    run,
    ticket: { id: run.slice(11, -2), title: `Ticket of ${run}` },
    phase: "merge_requests_open",
    mergeRequests: [{ repo: ".", url: pullRequest, number: 7 }],
    worktrees: [{ repo: ".", path: workspace, branch: "ark/test" }],
  });
}

test("ARK-T657 the first sync sends no wake for older events, records a cursor from the test clock, names an unreadable run and a repeat sync sends nothing", () => {
  const { folder, workspace, fake } = scenario(mergerAndStarter());
  const [r1, r2, r3, r5] = [runId(901), runId(902), runId(903), runId(905)];
  rawRun(r1, [
    ["run.started", startedData(r1)],
    ["evaluation.recorded", { blockers: ["scope"], risks: [], surfaces: ["none"] }],
    ["escalation.requested", { reason: "stuck" }],
    ["run.closed", { outcome: "merged" }],
  ]);
  openMergeRequestRun(r2, workspace);
  mkdirSync(runDirectoryOf(project, r3), { recursive: true });
  writeFileSync(join(runDirectoryOf(project, r3), "events.ndjson"), "this is not json\n");
  writeRun({ project, run: r5, ticket: { id: "ARK-905", title: "Building" }, phase: "building" });

  const first = arkP("companions", "sync");
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  expect(fake.sent()).toEqual([]);
  expect(first.out).toMatch(new RegExp(`${r3}.*cannot be read`));
  for (const name of ["merger", "starter"]) {
    const cursor = readCursor(folder, name);
    expect(cursor.updated).toBe(isoNow());
    expect(Object.keys(cursor.runs).toSorted()).toEqual([r1, r2, r5]);
  }

  advance(60);
  const second = arkP("companions", "sync");
  expect(second.code).toBe(0);
  expect(fake.sent()).toEqual([]);
});

test("ARK-T657 each new event of a subscribed trigger wakes its companion once: merged, started, criteria opened, escalation, and nothing for an aborted run", () => {
  const { folder, workspace, fake } = scenario(mergerAndStarter());
  const [r2, r4, r5, r6] = [runId(902), runId(904), runId(905), runId(906)];
  openMergeRequestRun(r2, workspace);
  writeRun({ project, run: r5, ticket: { id: "ARK-905", title: "Building" }, phase: "building" });
  expect(arkP("companions", "sync").code).toBe(0);

  // R5 merges, R4 starts: one wake each, to the companion that subscribes to it.
  advance(60);
  appendRaw(r5, "run.closed", { outcome: "merged" });
  rawRun(r4, [["run.started", startedData(r4)]]);
  const third = arkP("companions", "sync");
  expect(third.err).toBe("");
  const mergerWakes = wakesTo(fake.sent(), folder, "merger");
  const starterWakes = wakesTo(fake.sent(), folder, "starter");
  expect(mergerWakes).toHaveLength(1);
  expect(mergerWakes[0]).toContain("trigger: run.merged");
  expect(mergerWakes[0]).toContain(`run: ${r5}`);
  expect(starterWakes).toHaveLength(1);
  expect(starterWakes[0]).toContain("trigger: run.started");
  expect(starterWakes[0]).toContain(`run: ${r4}`);
  // A start with criteria_gate true is no gate opening; R5 has no MR, so no CI read for it.
  expect(
    fake
      .sent()
      .map((message) => message.body)
      .join("\n"),
  ).not.toMatch(/criteria\.opened|ci\.failed/);
  expect(fake.ghCalls().every((args) => args.includes(pullRequest))).toBe(true);
  // Cursor and wake log carry the test clock's time.
  expect(readCursor(folder, "merger").updated).toBe(isoNow());
  const wakeLog = readFileSync(join(folder, "companions", "merger", "wake.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(wakeLog.map((line) => [line.trigger, line.run, line.time])).toEqual([
    ["run.merged", r5, isoNow()],
  ]);

  // The evaluation of R4 names a blocker: the gate opens, once.
  advance(60);
  appendRaw(r4, "evaluation.recorded", { blockers: ["scope"], risks: [], surfaces: ["none"] });
  const sentBefore = fake.sent().length;
  expect(arkP("companions", "sync").code).toBe(0);
  const opened = fake.sent().slice(sentBefore);
  expect(opened).toHaveLength(1);
  expect(opened[0].to).toBe(`dispatch:${dispatchOf(folder, "starter")}`);
  expect(opened[0].body).toContain("trigger: criteria.opened");
  expect(opened[0].body).toContain(`run: ${r4}`);
  expect(arkP("companions", "sync").code).toBe(0);
  expect(fake.sent()).toHaveLength(sentBefore + 1);

  // R6 starts and its evaluation has no blocker: only the start wakes.
  advance(60);
  rawRun(r6, [
    ["run.started", startedData(r6)],
    ["evaluation.recorded", { blockers: [], risks: [], surfaces: ["none"] }],
  ]);
  expect(arkP("companions", "sync").code).toBe(0);
  const fromR6 = fake.sent().slice(sentBefore + 1);
  expect(fromR6).toHaveLength(1);
  expect(fromR6[0].body).toContain("trigger: run.started");
  expect(fromR6[0].body).toContain(`run: ${r6}`);

  // An escalation of R2 wakes merger only, once.
  advance(60);
  appendRaw(r2, "escalation.requested", { reason: "need a decision" });
  const beforeEscalation = fake.sent().length;
  expect(arkP("companions", "sync").code).toBe(0);
  const escalated = fake.sent().slice(beforeEscalation);
  expect(escalated).toHaveLength(1);
  expect(escalated[0].to).toBe(`dispatch:${dispatchOf(folder, "merger")}`);
  expect(escalated[0].body).toContain("trigger: escalation");
  expect(escalated[0].body).toContain(`run: ${r2}`);
  expect(arkP("companions", "sync").code).toBe(0);
  expect(fake.sent()).toHaveLength(beforeEscalation + 1);

  // An aborted run is not run.merged.
  advance(60);
  appendRaw(r6, "run.closed", { outcome: "aborted" });
  expect(arkP("companions", "sync").code).toBe(0);
  expect(fake.sent()).toHaveLength(beforeEscalation + 1);
});

test("ARK-T657 a failed check of an open merge request wakes ci.failed once for each new failure, and an unreadable CI sends nothing and forgets nothing", () => {
  const { folder, workspace, fake } = scenario(mergerAndStarter());
  const r2 = runId(902);
  openMergeRequestRun(r2, workspace);
  expect(arkP("companions", "sync").code).toBe(0);
  expect(fake.sent()).toEqual([]);
  const ciWakes = () =>
    wakesTo(fake.sent(), folder, "starter").filter((body) => body.includes("trigger: ci.failed"));

  fake.setCi("fail", ["unit"]);
  advance(60);
  expect(arkP("companions", "sync").code).toBe(0);
  expect(ciWakes()).toHaveLength(1);
  expect(ciWakes()[0]).toContain(`run: ${r2}`);
  expect(ciWakes()[0]).toContain("unit");

  expect(arkP("companions", "sync").code).toBe(0);
  expect(ciWakes()).toHaveLength(1);

  fake.setCi("fail", ["unit", "lint"]);
  expect(arkP("companions", "sync").code).toBe(0);
  expect(ciWakes()).toHaveLength(2);
  expect(ciWakes()[1]).toContain("lint");
  expect(ciWakes()[1]).not.toContain("unit");

  // The host cannot be read: a line says so, the sync still exits 0, and nothing is sent.
  fake.setCi("error");
  const unreadable = arkP("companions", "sync");
  expect(unreadable.code).toBe(0);
  expect(unreadable.out).toMatch(new RegExp(`CI of ${r2}.*could not be read`));
  expect(ciWakes()).toHaveLength(2);

  // The failures are back after the outage: the same checks are not sent again.
  fake.setCi("fail", ["unit", "lint"]);
  expect(arkP("companions", "sync").code).toBe(0);
  expect(ciWakes()).toHaveLength(2);
  fake.setCi("pass");
  expect(arkP("companions", "sync").code).toBe(0);
  expect(ciWakes()).toHaveLength(2);
});

test("ARK-T657 an event whose send failed is sent again by the next sync, once", () => {
  const { folder, fake } = scenario(mergerAndStarter());
  expect(arkP("companions", "sync").code).toBe(0);
  const r7 = runId(907);
  advance(60);
  rawRun(r7, mergedRows(r7));

  fake.configure({ failSendOnce: true });
  const failed = arkP("companions", "sync");
  expect(failed.err).toMatch(new RegExp(`^ark: .*${r7}`, "m"));
  expect(failed.code).toBe(1);
  // The failed send is the merger's run.merged: its cursor has not passed that event (seq 2).
  expect(readCursor(folder, "merger").runs[r7]?.seq ?? 0).toBeLessThan(2);
  expect(wakesTo(fake.sent(), folder, "merger")).toEqual([]);

  const retry = arkP("companions", "sync");
  expect(retry.err).toBe("");
  const mergerWakes = wakesTo(fake.sent(), folder, "merger");
  expect(mergerWakes).toHaveLength(1);
  expect(mergerWakes[0]).toContain("trigger: run.merged");
  expect(mergerWakes[0]).toContain(`run: ${r7}`);

  expect(arkP("companions", "sync").code).toBe(0);
  expect(wakesTo(fake.sent(), folder, "merger")).toHaveLength(1);
});

// Step 9 of the case runs last: a companion added after old merged runs hears none of them.
test("ARK-T657 a companion added to a project with old merged runs gets no wake for them on its first sync", () => {
  const { folder, fake, save } = scenario(mergerAndStarter());
  const [r1, r5] = [runId(901), runId(905)];
  rawRun(r1, mergedRows(r1));
  expect(arkP("companions", "sync").code).toBe(0);
  advance(60);
  rawRun(r5, mergedRows(r5));
  expect(arkP("companions", "sync").code).toBe(0);
  expect(wakesTo(fake.sent(), folder, "merger")).toHaveLength(1);

  save([...mergerAndStarter(), entry("late", ["run.merged"])]);
  advance(60);
  const late = arkP("companions", "sync");
  expect(late.err).toBe("");
  expect(late.out).toContain("late: started");
  expect(wakesTo(fake.sent(), folder, "late")).toEqual([]);
  expect(readCursor(folder, "late").runs[r1]).toBeDefined();
  expect(readCursor(folder, "late").runs[r5]).toBeDefined();
  // The others heard nothing new either.
  expect(wakesTo(fake.sent(), folder, "merger")).toHaveLength(1);
});

// ------------------------------------------------------------------ ARK-T658

/** A project with `cortana` listed and started by a sync. */
function startedCortana() {
  const state = scenario([entry("cortana", ["run.merged"])]);
  expect(arkP("companions", "sync").code).toBe(0);
  state.fake.clearCalls();
  const dispatch = dispatchOf(state.folder, "cortana");
  // The companion answered its first message and sits idle: Orca lists it live and retained.
  state.fake.retain(dispatch);
  return { ...state, dispatch };
}

test("ARK-T658 ask wakes the live companion with the question and sends Master Chief nothing", () => {
  const { fake, dispatch } = startedCortana();
  process.env.ORCA_AGENT_SESSION_ID = "session-1";
  const asked = arkP("companion", "ask", "cortana", "Which runs failed on lint?");
  expect(asked.err).toBe("");
  expect(asked.code).toBe(0);
  const sent = fake.sent();
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe(`dispatch:${dispatch}`);
  expect(sent[0].from).toBe("orca_session_id:session-1");
  expect(sent[0].body).toContain("Which runs failed on lint?");
  expect(sent[0].body).toMatch(/question from the human or Master Chief/);
  // It is not a trigger wake.
  expect(sent[0].body).not.toMatch(/^trigger:/m);
});

test("ARK-T658 answer appends each answer with its test-clock time to answers.md and copies Master Chief", () => {
  const { folder, fake } = startedCortana();
  process.env.ORCA_AGENT_SESSION_ID = "session-1";
  const answers = join(folder, "companions", "cortana", "answers.md");

  const firstTime = isoNow();
  const first = arkP("companion", "answer", "cortana", "Runs 14 and 15 failed on lint.");
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  expect(readFileSync(answers, "utf8").trimEnd().endsWith("Runs 14 and 15 failed on lint.")).toBe(
    true,
  );
  expect(readFileSync(answers, "utf8")).toContain(firstTime);
  expect(fake.sent()).toHaveLength(1);
  expect(fake.sent()[0].to).toBe("term_chief");
  expect(fake.sent()[0].body).toContain("Runs 14 and 15 failed on lint.");
  expect(fake.sent()[0].body).toContain("cortana");

  advance(60);
  const secondTime = isoNow();
  expect(arkP("companion", "answer", "cortana", "A second answer.").code).toBe(0);
  const text = readFileSync(answers, "utf8");
  expect(text.indexOf(firstTime)).toBeLessThan(text.indexOf("Runs 14 and 15 failed on lint."));
  expect(text.indexOf("Runs 14 and 15 failed on lint.")).toBeLessThan(text.indexOf(secondTime));
  expect(text.indexOf(secondTime)).toBeLessThan(text.indexOf("A second answer."));
  expect(fake.sent()).toHaveLength(2);
});

test("ARK-T658 ask and answer from a process with no Orca session find the live Master Chief and the companion", () => {
  const { fake, dispatch } = startedCortana();
  expect(process.env.ORCA_AGENT_SESSION_ID).toBeUndefined();
  expect(arkP("companion", "ask", "cortana", "Any news?").code).toBe(0);
  expect(arkP("companion", "answer", "cortana", "No news.").code).toBe(0);
  const [question, copy] = fake.sent();
  expect(question.to).toBe(`dispatch:${dispatch}`);
  expect(question.from).toBe("term_chief");
  expect(copy.to).toBe("term_chief");
  expect(copy.from).toBe("term_chief");
  expect(copy.body).toContain("No news.");
});

test("ARK-T658 ask and answer for a name that is not in ark.yml, or an unsafe one, refuse and create nothing", () => {
  const { folder, fake } = startedCortana();
  const before = readdirSync(join(folder, "companions"));
  for (const name of ["ghost", "../x"]) {
    expectRefusal(arkP("companion", "ask", name, "Anyone there?"), name);
    expectRefusal(arkP("companion", "answer", name, "An answer."), name);
  }
  expect(fake.sent()).toEqual([]);
  expect(readdirSync(join(folder, "companions"))).toEqual(before);
  expect(existsSync(join(folder, "x"))).toBe(false);
});

test("ARK-T658 ask for a companion with no live worker refuses, and answer with Orca down keeps the answer in answers.md and says the copy failed", () => {
  const { folder, fake, dispatch } = startedCortana();
  fake.close(dispatch);
  expectRefusal(arkP("companion", "ask", "cortana", "Are you there?"), "not running");
  expect(fake.sent()).toEqual([]);

  fake.configure({ failAll: true });
  expectRefusal(
    arkP("companion", "answer", "cortana", "Kept answer."),
    "copy to Master Chief failed",
  );
  expect(readFileSync(join(folder, "companions", "cortana", "answers.md"), "utf8")).toContain(
    "Kept answer.",
  );
});

// ------------------------------------------------------------------ ARK-T659

const [leadRun, noLeadRun, closedRun, otherRun] = [runId(911), runId(912), runId(913), runId(914)];

/** A project with `cortana`, open runs R1 (lead), R2 (no lead) and R4 (another lead), and a closed run R3 whose lead is still listed. */
function adviceProject() {
  const state = scenario([entry("cortana", ["run.merged"])]);
  for (const run of [leadRun, noLeadRun, otherRun])
    writeRun({
      project,
      run,
      ticket: { id: run.slice(11, -2), title: `Ticket of ${run}` },
      phase: "building",
    });
  writeRun({
    project,
    run: closedRun,
    ticket: { id: run3Ticket, title: "Closed" },
    phase: "closed",
  });
  const lead = (run: string, number: number) => ({
    dispatchId: `ctx_lead${number}`,
    terminal: `term_lead${number}`,
    workspace: `host_1::${runDirectoryOf(project, run)}/workspace`,
  });
  state.fake.configure({
    leads: [lead(leadRun, 1), lead(closedRun, 3), lead(otherRun, 4)],
  });
  return state;
}
const run3Ticket = closedRun.slice(11, -2);

const adviceText = "Run R1 touches the same file as R3.";

test("ARK-T659 advise sends the run lead one status message marked as advice and not a gate answer, and Master Chief one copy", () => {
  const { fake } = adviceProject();
  const result = arkP("companion", "advise", "cortana", leadRun, adviceText);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  const sent = fake.sent();
  expect(sent).toHaveLength(2);
  const [toLead, copy] = sent;
  expect(toLead.to).toBe("term_lead1");
  expect(toLead.type).toBe("status");
  expect(toLead.subject).toStartWith("Advice from companion cortana");
  expect(toLead.body).toContain(adviceText);
  expect(toLead.body).toContain("not a gate answer");
  expect(copy.to).toBe("term_chief");
  expect(copy.body).toContain(adviceText);
  expect(copy.body).toContain("cortana");
  expect(copy.body).toContain(leadRun);
});

test("ARK-T659 advise refuses a run with no live lead, a closed run, an unknown run and a name not in ark.yml, and sends nothing", () => {
  const { fake } = adviceProject();
  expectRefusal(arkP("companion", "advise", "cortana", noLeadRun, adviceText), noLeadRun);
  // The lead of the closed run is still listed in Orca: the run's phase decides.
  expectRefusal(arkP("companion", "advise", "cortana", closedRun, adviceText), "closed");
  expectRefusal(arkP("companion", "advise", "cortana", runId(999), adviceText), runId(999));
  expectRefusal(arkP("companion", "advise", "ghost", leadRun, adviceText), "ghost");
  expect(fake.sent()).toEqual([]);
});

test("ARK-T659 advise exits 1 with a named line when a send or Orca fails, and sends no copy for advice that did not reach the lead", () => {
  const { fake } = adviceProject();
  fake.configure({ failSendTo: ["term_lead1"] });
  expectRefusal(arkP("companion", "advise", "cortana", leadRun, adviceText), leadRun);
  expect(fake.sent()).toEqual([]);

  // The lead keeps advice it got when only the copy fails.
  fake.configure({ failSendTo: ["term_chief"] });
  expectRefusal(arkP("companion", "advise", "cortana", leadRun, adviceText), "copy");
  expect(fake.sent().map((message) => message.to)).toEqual(["term_lead1"]);

  fake.configure({ failSendTo: [], failAll: true });
  fake.clearCalls();
  expectRefusal(arkP("companion", "advise", "cortana", leadRun, adviceText));
  expect(fake.sent()).toEqual([]);
});

const draft = (id: string | null, status = "ready") =>
  [
    "---",
    ...(id === null ? [] : [`id: ${id}`]),
    'title: "A companion idea"',
    `status: ${status}`,
    "acceptance_criteria:",
    "  - id: AC1",
    '    text: "The idea works"',
    "---",
    "## Why",
    "",
    "Because the suite is slow.",
    "",
  ].join("\n");

function writeDraft(name: string, text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "ark-draft-")), name);
  writeFileSync(file, text);
  return file;
}

test("ARK-T659 propose writes the ticket as proposed with a source line, and sends and queues nothing", () => {
  const { folder, fake } = adviceProject();
  fake.clearCalls();
  const file = writeDraft("draft.md", draft("ARK-901"));
  const result = arkP("companion", "propose", "cortana", file);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  const text = readFileSync(join(folder, "tickets", "ARK-901.md"), "utf8");
  expect(text).toMatch(/^status: proposed$/m);
  expect(text).not.toMatch(/^status: ready$/m);
  expect(text).toMatch(/^source: .*cortana/m);
  expect(text).toContain('title: "A companion idea"');
  expect(text).toContain("Because the suite is slow.");
  // No send, no task-create: nothing is queued.
  expect(fake.calls()).toEqual([]);
});

test("propose resolves a relative draft path against the project folder, not the current folder", () => {
  const { folder } = adviceProject();
  mkdirSync(join(folder, "companions", "cortana"), { recursive: true });
  writeFileSync(join(folder, "companions", "cortana", "draft.md"), draft("ARK-905"));
  const result = arkP("companion", "propose", "cortana", "companions/cortana/draft.md");
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(readFileSync(join(folder, "tickets", "ARK-905.md"), "utf8")).toMatch(
    /^status: proposed$/m,
  );
});

test("ARK-T659 propose never overwrites a ticket, and a draft with no id, an unknown name or a missing file writes nothing", () => {
  const { folder } = adviceProject();
  writeTicket(project, "ARK-900", [{ id: "AC1", text: "Exists" }]);
  const existing = join(folder, "tickets", "ARK-900.md");
  const before = readFileSync(existing, "utf8");
  const tickets = () => readdirSync(join(folder, "tickets"));
  const listed = tickets();

  expectRefusal(
    arkP("companion", "propose", "cortana", writeDraft("same.md", draft("ARK-900"))),
    "ARK-900",
  );
  expect(readFileSync(existing, "utf8")).toBe(before);
  expect(before).toMatch(/^status: ready$/m);

  expectRefusal(arkP("companion", "propose", "cortana", writeDraft("noid.md", draft(null))));
  expectRefusal(
    arkP("companion", "propose", "ghost", writeDraft("ghost.md", draft("ARK-902"))),
    "ghost",
  );
  expectRefusal(arkP("companion", "propose", "cortana", join(folder, "no-such-draft.md")));
  expect(tickets()).toEqual(listed);
});

test("ARK-T659 a ticket proposed with a source key reads with no warning and no error", () => {
  const { folder } = adviceProject();
  expect(
    arkP("companion", "propose", "cortana", writeDraft("draft.md", draft("ARK-901"))).code,
  ).toBe(0);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(readTicket(join(folder, "tickets", "ARK-901.md")).id).toBe("ARK-901");
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
