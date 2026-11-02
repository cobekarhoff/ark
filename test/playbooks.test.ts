import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const playbookDirectory = join(import.meta.dir, "../skills/ark/playbooks");
const chiefPlaybook = readFileSync(join(playbookDirectory, "chief.md"), "utf8");
const bootstrapPlaybook = readFileSync(join(playbookDirectory, "bootstrap.md"), "utf8");
const runLeadPlaybook = readFileSync(join(playbookDirectory, "run-lead.md"), "utf8");

test("ARK-169-AC1 bootstrap creates the depth-check Run before starting a worker", () => {
  const depthCheck = bootstrapPlaybook
    .split("## 6. Confirm Orca's nesting depth is at least 2")[1]
    ?.split("\n## ")[0];
  expect(depthCheck).toBeDefined();

  const shellBlocks = [...depthCheck!.matchAll(/^[ \t]*```sh\n([\s\S]*?)^[ \t]*```/gm)].map(
    ([, body]) => body,
  );
  const commands = shellBlocks.join("\n");
  const createRun = commands.search(/^\s*orca orchestration run-create\b/m);
  const startWorker = commands.search(/^\s*orca orchestration worker-start\b/m);

  expect(createRun).toBeGreaterThanOrEqual(0);
  expect(startWorker).toBeGreaterThan(createRun);
});

test("ARK-169-AC2 chief creates its own Run at start and queues Tasks in it", () => {
  const queueSection = chiefPlaybook
    .split("## 5. Queue the approved tickets")[1]
    ?.split("\n## ")[0];
  expect(queueSection).toBeDefined();
  expect(queueSection).toMatch(/Use the Run bound at start/);

  const runCreate = chiefPlaybook.indexOf(
    'orca orchestration run-create --objective "Master Chief: <project> tickets"',
  );
  const taskCreate = chiefPlaybook.indexOf("orca orchestration task-create");
  expect(runCreate).toBeGreaterThanOrEqual(0);
  expect(taskCreate).toBeGreaterThan(runCreate);
});
test("ARK-162-AC1 Master Chief proceeds only with an Orca terminal handle", () => {
  const command = chiefPlaybook.match(/Run `([^`]+)`\./)?.[1];
  expect(command).toBe('test -n "$ORCA_TERMINAL_HANDLE"');
  expect(chiefPlaybook).not.toContain("caller.orcaSessionId");

  const withTerminalHandle = Bun.spawnSync(["sh", "-c", command!], {
    env: { ...process.env, ORCA_TERMINAL_HANDLE: "terminal-test" },
  });
  const withoutTerminalHandle = Bun.spawnSync(["sh", "-c", command!], {
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "ORCA_TERMINAL_HANDLE"),
    ),
  });

  expect(withTerminalHandle.exitCode).toBe(0);
  expect(withoutTerminalHandle.exitCode).not.toBe(0);
});

test("ARK-164-AC1 dispatch starts in an Orca-known worktree and completes the queue Task at close", () => {
  const dispatch = chiefPlaybook
    .split("## 6. Start a run lead for each ready ticket")[1]
    ?.split("\n## ")[0];
  const close = chiefPlaybook.split("## 8. Close the run")[1]?.split("\n## ")[0];
  expect(dispatch).toBeDefined();
  expect(close).toBeDefined();

  expect(dispatch).not.toMatch(/task-update[^\n]*--status dispatched/);
  expect(dispatch).toContain("--worktree current");
  expect(dispatch).not.toMatch(/worker-start[^\n]*--worktree path:/);
  expect(close).toMatch(/orca orchestration task-update[^\n]*--status completed/);
});

test("ARK-166-AC3 opens Plannotator on plan.md only", () => {
  const planGate = runLeadPlaybook.split("## 5. Plan gate")[1]?.split("\n## ")[0];
  expect(planGate).toBeDefined();
  const annotateCommand = planGate!.match(/plannotator annotate "[^"]+"/)?.[0];
  expect(annotateCommand).toBe('plannotator annotate "<run folder>/plan.md"');
  expect(annotateCommand).not.toContain("plan.mmd");
  expect(annotateCommand).not.toContain("plan.yml");
});

test("ARK-231-AC1 run-lead section 5 backgrounds the Plannotator review and stops it when Master Chief relays the answer", () => {
  const planGate = runLeadPlaybook.split("## 5. Plan gate")[1]?.split("\n## ")[0];
  expect(planGate).toBeDefined();
  expect(planGate).toMatch(/plannotator annotate "<run folder>\/plan\.md"[^\n]*&\n/);
  expect(planGate).toMatch(/echo \$! > "<run folder>\/gates\/plan-<n>\.pid"/);
  const relay = planGate!.match(/If Master Chief relays[^\n]*/)?.[0];
  expect(relay).toBeDefined();
  expect(relay).toMatch(/kill "\$\(cat "<run folder>\/gates\/plan-<n>\.pid"\)"/);
  expect(relay!.indexOf("kill")).toBeLessThan(relay!.indexOf("ark gate record"));
});

test("ARK-171-AC5 run-lead section 4 asks for callers of each interface and an output example", () => {
  const writePlan = runLeadPlaybook.split("## 4. Write the plan")[1]?.split("\n## ")[0];
  expect(writePlan).toBeDefined();
  expect(writePlan).toMatch(/Find the callers of each one before you write it/);
  expect(writePlan).toMatch(/`example` \(a sample of new or changed output\)/);
  expect(writePlan).toMatch(/design\.interfaces/);
});
test("ARK-174-AC1 bootstrap detects UI repos and offers both design files", () => {
  const uiDetection = bootstrapPlaybook.split("### UI")[1]?.split("\n## ")[0];
  const designContext = bootstrapPlaybook.split("## 10. Design context")[1]?.split("\n## ")[0];

  expect(uiDetection).toBeDefined();
  expect(designContext).toBeDefined();
  expect(uiDetection).toMatch(/web framework in `package\.json`/);
  expect(uiDetection).toMatch(/HTML templates/);
  expect(uiDetection).toMatch(/Storybook config/);
  expect(uiDetection).toMatch(/ios` or `android` project/);
  expect(uiDetection).toMatch(
    /For each one, record whether `PRODUCT\.md` and `DESIGN\.md` already exist at its root/,
  );
  expect(designContext).toMatch(/offer the files below for each UI repo from step 2/);
  expect(designContext).toMatch(/Existing UI code, no `PRODUCT\.md`: run impeccable `init`/);
  expect(designContext).toMatch(/Existing UI code, no `DESIGN\.md`: run impeccable `document`/);
});

test("ARK-174-AC2 bootstrap asks once about a planned UI and limits files by answer", () => {
  const ask = bootstrapPlaybook
    .split("## 3. Ask only what you could not detect")[1]
    ?.split("\n## ")[0];
  const designContext = bootstrapPlaybook.split("## 10. Design context")[1]?.split("\n## ")[0];

  expect(ask).toBeDefined();
  expect(designContext).toBeDefined();
  expect(ask).toMatch(/only when step 2 found no repo with UI code/);
  expect(ask).toMatch(
    /Recommended: `<yes or no>`, because `<evidence from the README or the tickets>`/,
  );
  expect(designContext).toMatch(
    /Planned UI with no code \(a "yes" in step 3\): run impeccable `init` only/,
  );
  expect(designContext).toMatch(/`DESIGN\.md` comes later, from the first Designer run/);
  expect(designContext).toMatch(/No UI and a "no" in step 3: make no design file/);
});

test("ARK-174-AC3 bootstrap preserves and reports existing design files", () => {
  const designContext = bootstrapPlaybook.split("## 10. Design context")[1]?.split("\n## ")[0];
  const report = bootstrapPlaybook.split("## 11. Report")[1]?.split("\n## ")[0];

  expect(designContext).toBeDefined();
  expect(report).toBeDefined();
  expect(designContext).toMatch(/Never write over `PRODUCT\.md` or `DESIGN\.md`/);
  expect(designContext).toMatch(
    /For a file that already exists, skip its command and list the file as skipped in step 11/,
  );
  expect(report).toMatch(/Skipped, already exists: <repo>\/PRODUCT\.md/);
});

test("ARK-174-AC4 report and Designer use committed design context", () => {
  const report = bootstrapPlaybook.split("## 11. Report")[1]?.split("\n## ")[0];
  const designer = readFileSync(join(playbookDirectory, "worker.md"), "utf8")
    .split("### Designer")[1]
    ?.split("\n### ")[0];

  expect(report).toBeDefined();
  expect(designer).toBeDefined();
  expect(report).toMatch(/Design files/);
  expect(report).toMatch(/Made: <repo>\/PRODUCT\.md \(impeccable init\)/);
  expect(report).toMatch(/Made: <repo>\/DESIGN\.md \(impeccable document\)/);
  expect(report).toMatch(/Commit and merge the made files/);
  expect(report).toMatch(/Run worktrees start from the base branch/);
  expect(designer).toMatch(/run `impeccable context` in the UI repo's worktree/);
  expect(designer).toMatch(
    /When a file is missing, say so in a line at the top of `strategies\.md`/,
  );
});

test("ARK-177-AC7 chief playbook refuses a second live Master Chief and takes over a dead Run", () => {
  const oneChief = chiefPlaybook
    .split("### One Master Chief for each project")[1]
    ?.split("\n## ")[0];

  expect(oneChief).toBeDefined();
  expect(oneChief).toMatch(/List the Runs: `orca orchestration run-list --json`/);
  expect(oneChief).toMatch(/objective is exactly "Master Chief: <project> tickets"/);
  expect(oneChief).toMatch(/If none exists, create it now/);
  expect(oneChief).toMatch(/If the handle is live and is not your own.*stop/i);
  expect(oneChief).toMatch(/A Master Chief for <project> already runs in terminal <handle>/);
  expect(oneChief).toMatch(/If the handle is dead.*take over that Run/i);
  expect(oneChief).toMatch(/run-use --id <run id>/);
});

test("ARK-210-AC4 run-lead section 9 names ark escalate and forbids a failing test to open the gate", () => {
  const section = runLeadPlaybook
    .split("## 9. Escalate when the round budget is spent")[1]
    ?.split("\n## ")[0];
  expect(section).toBeDefined();
  expect(section).toMatch(/ark escalate <run> --reason/);
  expect(section).toMatch(/P0 or P1/);
  expect(section).toMatch(/Never add a failing test only to open the gate/);
});

const runLeadStart = runLeadPlaybook.split("## 1. Start")[1]?.split("\n## ")[0];

test("ARK-229-AC1 run-lead section 1 checks the inbox and searches the run folder before run-create", () => {
  expect(runLeadStart).toBeDefined();
  const inbox = runLeadStart!.search(/Read your Orca inbox with the `check` command/);
  const search = runLeadStart!.search(/Search the run folder for a `run_\.\.\.` ID/);
  const createRun = runLeadStart!.search(/orca orchestration run-create\b/);

  expect(inbox).toBeGreaterThanOrEqual(0);
  expect(search).toBeGreaterThan(inbox);
  expect(createRun).toBeGreaterThan(search);
});

test("ARK-229-AC2 run-lead section 1 binds a found Run with run-use and creates only when none is found", () => {
  expect(runLeadStart).toBeDefined();
  expect(runLeadStart).toMatch(/If you found a Run, bind it\. Do not run `run-create`/);
  expect(runLeadStart).toMatch(/run-use --id <run_id>/);
  expect(runLeadStart!.match(/run-create\b.*--objective/g)).toHaveLength(1);
  expect(runLeadStart).toMatch(/Only when no existing Run was found[\s\S]*run-create --objective/);
});

test("ARK-228-AC3 run-lead section 9 tells the run lead to continue with steps 1 to 3 after ark escalate", () => {
  const section = runLeadPlaybook
    .split("## 9. Escalate when the round budget is spent")[1]
    ?.split("\n## ")[0];
  expect(section).toMatch(/After `ark escalate`, continue with steps 1 to 3/);
});

test("ARK-232-AC1 run-lead section 7 reads the first dispatch terminal about 2 minutes after start, before the long wait, with orca terminal read as fallback", () => {
  const section = runLeadPlaybook.split("## 7. Run the steps")[1]?.split("\n## ")[0];
  expect(section).toBeDefined();

  const shortWait = section!.search(
    /About 2 minutes after the first dispatch on each model starts, wait once for 120 seconds[\s\S]*?--timeout-ms 120000/,
  );
  const earlyRead = section!.search(/worker-read --dispatch <dispatch id> --source terminal/);
  const fallback = section!.search(
    /If `worker-read` returns no text[\s\S]*?orca terminal read --terminal <handle> --json/,
  );
  const longWait = section!.search(/--timeout-ms 900000/);

  expect(shortWait).toBeGreaterThanOrEqual(0);
  expect(earlyRead).toBeGreaterThan(shortWait);
  expect(fallback).toBeGreaterThan(earlyRead);
  expect(longWait).toBeGreaterThan(fallback);
});

const workerPlaybook = readFileSync(join(playbookDirectory, "worker.md"), "utf8");
const implementerSection = workerPlaybook.split("### Implementer")[1]?.split("\n### ")[0];

test("ARK-236-AC1 worker implementer runs format, format:check, typecheck and lint before each commit and before worker_done, also in rework and Markdown-only changes", () => {
  expect(implementerSection).toBeDefined();
  expect(implementerSection).toMatch(/Before each commit and before `worker_done`/);
  expect(implementerSection).toMatch(
    /`format` \(it writes\), then `format:check`, `typecheck` and `lint`/,
  );
  expect(implementerSection).toMatch(/in rework rounds too, and for Markdown-only changes/);
});

test("ARK-236-AC2 worker commits its own work before worker_done and run-lead section 8 says a findings file never forbids it", () => {
  expect(implementerSection).toMatch(
    /Commit your own work on the branch[^\n]*before `worker_done`/,
  );

  const section = runLeadPlaybook.split("## 8. Test, review and rework")[1]?.split("\n## ")[0];
  expect(section).toBeDefined();
  expect(section).toMatch(/A findings file never forbids an implementer commit/);
});

test("ARK-236-AC3 run-lead section 7 gives the worktree path of repo . without a trailing /.", () => {
  const section = runLeadPlaybook.split("## 7. Run the steps")[1]?.split("\n## ")[0];
  expect(section).toBeDefined();
  expect(section).toMatch(
    /For a repo named `\.` it is `<run folder>\/workspace`, with no trailing `\/\.`/,
  );
});

test("ARK-236-AC4 run-lead section 1 treats a found run_ ID as a candidate and binds only after run-show shows the objective", () => {
  expect(runLeadStart).toBeDefined();
  expect(runLeadStart).toMatch(/Treat an ID found there as a candidate only/);

  const show = runLeadStart!.search(/run-show --id <run_id> --json/);
  const objective = runLeadStart!.search(
    /Bind with `run-use` only after `run-show` shows the objective `Ark run <run>`/,
  );
  const bind = runLeadStart!.search(/run-use --id <run_id>/);
  expect(show).toBeGreaterThanOrEqual(0);
  expect(objective).toBeGreaterThan(show);
  expect(bind).toBeGreaterThan(show);
});

test("ARK-236-AC5 run-lead section 7 copies every literal string an AC names into the worker spec word for word", () => {
  const section = runLeadPlaybook.split("## 7. Run the steps")[1]?.split("\n## ")[0];
  expect(section).toBeDefined();
  expect(section).toMatch(
    /copy every literal string an AC names \(a field, flag or message\) word for word/,
  );
});

test("ARK-244-AC3 chief names both loop scripts by path", () => {
  expect(chiefPlaybook).toContain("scripts/auto-merger.sh");
  expect(chiefPlaybook).toContain("scripts/temp-cleaner.sh");
});

test("ARK-244-AC4 chief takes over from live state and hands over at 70% context use", () => {
  expect(chiefPlaybook).toMatch(/ark chief state --project <project>/);
  expect(chiefPlaybook).toMatch(/`handoff\.md` keeps only standing rules/);

  const handover = chiefPlaybook.split(/^## .*70%.*$/m)[1]?.split("\n## ")[0];
  expect(handover).toBeDefined();
  expect(chiefPlaybook).toContain("70% or more");
  const run = handover!.indexOf("ark chief handover --project <project>");
  const close = handover!.indexOf("orca terminal close");
  expect(run).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(run);

  // No rule may tell Master Chief to write a State section in handoff.md.
  expect(chiefPlaybook).not.toMatch(
    /(write|keep|update|add)[^.\n]*State section[^.\n]*handoff\.md/i,
  );
  expect(chiefPlaybook).toMatch(/Do not write a State section/);
});
