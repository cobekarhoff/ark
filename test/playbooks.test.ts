// ARK-290 AC5 string: `bun test test/playbooks.test.ts -t ARK-290-AC5`.
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isHubName } from "../cli/proxy.ts";
import { outcomes } from "../cli/transitions.ts";
import { reactSkill, requiredUiSkills } from "../cli/ui-skills.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

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
  expect(dispatch).toContain("ark worktree anchor <run>");
  expect(dispatch).toMatch(/worker-start[^\n]*run-lead[^\n]*--worktree path:<printed path>/);
  expect(dispatch).not.toContain("--worktree current");
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

/** Command lines that run `orca orchestration worker-start`; prose that only names `worker-start` is left out. */
function workerStartLines(playbook: string): string[] {
  return playbook
    .split("\n")
    .filter((line) => line.includes("orca orchestration worker-start --spec"));
}

function section(playbook: string, heading: string): string {
  return playbook.split(heading)[1]?.split("\n## ")[0] ?? "";
}

test("ARK-276-AC1 no worker-start line in chief.md or run-lead.md starts in the main workspace", () => {
  const lines = [...workerStartLines(chiefPlaybook), ...workerStartLines(runLeadPlaybook)];
  expect(lines).toHaveLength(4); // run lead, evaluator, designer, step worker
  for (const line of lines) {
    expect(line).toMatch(/--worktree path:<[^>]+>/);
    expect(line).not.toContain("--worktree current");
    expect(line).not.toContain("--worktree path:<workspace");
  }
});

test("ARK-276-AC6 chief and run-lead start their early workers in the printed anchor selector", () => {
  const dispatch = section(chiefPlaybook, "## 6. Start a run lead for each ready ticket");
  const runStart = dispatch.indexOf("ark run start");
  const anchor = dispatch.indexOf("ark worktree anchor <run>");
  const workerStart = dispatch.indexOf("orca orchestration worker-start");
  expect(runStart).toBeGreaterThanOrEqual(0);
  expect(anchor).toBeGreaterThan(runStart);
  expect(workerStart).toBeGreaterThan(anchor);
  expect(dispatch).toMatch(/printed `path:<\.\.\.>`/);
  expect(dispatch).toMatch(/worker-start[^\n]*run-lead[^\n]*--worktree path:<printed path>/);
  expect(dispatch).toMatch(/stay in the main workspace/);

  const evaluate = section(runLeadPlaybook, "## 2. Evaluate the ticket and open the criteria gate");
  expect(evaluate).toContain("ark worktree anchor <run>");
  const anchorAt = evaluate.indexOf("ark worktree anchor <run>");
  expect(anchorAt).toBeLessThan(evaluate.indexOf("orca orchestration worker-start"));
  const early = evaluate
    .split("\n")
    .filter((line) => line.includes("orca orchestration worker-start --spec"));
  expect(early).toHaveLength(2);
  expect(early[0]).toContain("worker <run> evaluator");
  expect(early[1]).toContain("worker <run> designer");
  for (const line of early) expect(line).toContain("--worktree path:<printed path>");
});

test("ARK-276-AC6 every worker-start line keeps its --agent <harness> --model <model> from ark.yml or plan.yml", () => {
  for (const line of [...workerStartLines(chiefPlaybook), ...workerStartLines(runLeadPlaybook)])
    expect(line).toMatch(/--agent <harness> --model <model> --json$/);
});

test("ARK-276-AC7 run-lead releases the evaluator, the designer and every step worker after done, failed and abnormal exits", () => {
  const release = "orca orchestration worker-release --dispatch <dispatch id> --json";
  const record = runLeadPlaybook.split("5. Record the result:")[1]?.split("\n## ")[0] ?? "";
  expect(record).toContain(release);
  expect(record).toMatch(/after its `worker_done`/);
  expect(record).toMatch(/after a failed exit/);
  expect(record).toMatch(/after an abnormal exit \(the worker is gone and sent no `worker_done`\)/);
  expect(record).toMatch(/the evaluator and the designer too/);

  const evaluate = section(runLeadPlaybook, "## 2. Evaluate the ticket and open the criteria gate");
  expect(
    evaluate.match(/Wait for its `worker_done`, then release it, as in section 7/g),
  ).toHaveLength(2);
});

test("ARK-276-AC7 chief releases the run lead when not yet released, before the ark run close line", () => {
  const close = section(chiefPlaybook, "## 8. Close the run");
  const release = close.indexOf(
    "orca orchestration worker-release --dispatch <dispatch id> --json",
  );
  const closeCommand = close.indexOf("`ark run close <run>");
  expect(release).toBeGreaterThanOrEqual(0);
  expect(closeCommand).toBeGreaterThan(release);
  expect(close).toMatch(/Release the run lead before you close the run/);
  expect(close).toMatch(/Do it when it is not yet released/);
  expect(close).toMatch(/worker-list --include-remote --json/);
});

test("ARK-278-AC6 cli.md lists --sweep for run close; chief.md section 8 names the release and the one-time sweep", () => {
  const reference = readFileSync(join(import.meta.dir, "../docs/reference/cli.md"), "utf8");
  expect(reference).toMatch(/ark run close \[<run> <outcome>\] \[--sweep\]/);

  const close = section(chiefPlaybook, "## 8. Close the run");
  expect(close).toMatch(/`ark run close`[^\n]*releases[^\n]*Orca workers/);
  expect(close).toContain("`ark run close --sweep`");
});

const flat = (text: string) => text.replaceAll(/\s+/g, " ");

test("ARK-279-AC5 run-lead.md has the four UI skills texts and names no skill", () => {
  const lead = flat(runLeadPlaybook);
  // (a) Designer brief and the card line
  expect(lead).toMatch(/read and apply the UI skills of `ark ui-skills <run>`/);
  expect(lead).toMatch(/`Skills:` line on each card/);
  // (b) plan section
  expect(lead).toMatch(
    /give a `skills` list .*to every implementer, validator and reviewer step that touches the UI/,
  );
  expect(lead).toMatch(/Add the React skill .* to a step that touches React code/);
  // (c) step worker spec
  expect(lead).toContain("add a line `UI skills: <the skills of the step>` to the worker spec");
  // (d) UI finding ranked like any other
  expect(lead).toMatch(
    /UI finding .*`\*\*Skill:\*\*`.* is a finding like any other: treat it by its rank/,
  );
  for (const name of [...requiredUiSkills, reactSkill]) expect(runLeadPlaybook).not.toContain(name);
});

test("ARK-279-AC6 worker.md has the read-apply-report, Designer and Reviewer skills texts", () => {
  const worker = flat(workerPlaybook);
  // (a) section 1
  const section1 = flat(workerPlaybook.split(/^## 2\./m)[0]);
  expect(section1).toMatch(
    /If the step has a `skills` list in `plan.yml`, read each skill with `skill:\/\/<name>` before you work, and apply it\. Name the skills you applied in your `worker_done` report\. This covers the implementer and the validator/,
  );
  // (b) Designer step takes the skills from ark ui-skills, adds the two extras, keeps the rules
  const designer =
    worker.match(/Read these skills for direction and craft: [^]*?(?= \d+\. |$)/)?.[0] ?? "";
  expect(designer).toContain("the UI skills of `ark ui-skills <run>`");
  expect(designer).toContain("`prototype`");
  expect(designer).toContain("`plannotator-visual-explainer`");
  expect(worker).toContain("impeccable generate");
  expect(worker).toMatch(/live mode/i);
  // (c) Reviewer
  expect(worker).toMatch(
    /read each skill with `skill:\/\/<name>` and check the diff against every skill in it/,
  );
  expect(worker).toContain("`- **Skill:** <skill>`");
  expect(worker).toContain("`- **Rule:** <name of the rule or guideline>`");
});

const defect =
  /A worker that still stops at a permission prompt is a defect: tell (?:Master Chief|the run lead), and never approve it in the worker/;

test("ARK-280-AC2 every worker-start line of chief.md and run-lead.md runs in an Ark-made worktree, where the setting is written", () => {
  const lines = [...workerStartLines(chiefPlaybook), ...workerStartLines(runLeadPlaybook)];
  expect(lines).toHaveLength(4);
  for (const line of lines) expect(line).toMatch(/--worktree path:<[^>]+>/);
  expect(section(chiefPlaybook, "## 6. Start a run lead for each ready ticket")).toContain(
    "It writes `.omp/config.yml` with `tools.approvalMode: yolo` in the new worktree",
  );
  expect(section(runLeadPlaybook, "## 6. Create the worktrees")).toContain(
    "`.omp/config.yml` with `tools.approvalMode: yolo` in each repo worktree it makes (`ark worktree anchor` too)",
  );
  const bootstrapPlaybook = readFileSync(join(playbookDirectory, "bootstrap.md"), "utf8");
  const depthCheck = section(bootstrapPlaybook, "## 6. Confirm Orca's nesting depth is at least 2");
  expect(depthCheck).toContain("--worktree path:<workspace>");
  expect(depthCheck).toContain(
    "the depth check follows the global `tools.approvalMode`. A worker that stops at a permission prompt here is not a depth failure: tell the human.",
  );
});

test("ARK-280-AC4 the playbooks call a worker that stops at a permission prompt a defect to report, not to approve", () => {
  const evaluate = section(runLeadPlaybook, "## 2. Evaluate the ticket and open the criteria gate");
  const steps = section(runLeadPlaybook, "## 7. Run the steps");
  // evaluator and designer starts in section 2, step workers in section 7
  expect(evaluate.match(new RegExp(defect.source, "g"))).toHaveLength(2);
  expect(steps.match(new RegExp(defect.source, "g"))).toHaveLength(1);
  expect(section(chiefPlaybook, "## 6. Start a run lead for each ready ticket")).toMatch(
    /a worker that still stops at one is a defect to fix, never to click through/,
  );
  expect(readFileSync(join(playbookDirectory, "worker.md"), "utf8")).toMatch(defect);
});

test("ARK-282-AC5 run-lead section 7 sends a worker-start that never ran to finish --failed --not-started and the roles check", () => {
  const rule = runLeadPlaybook
    .split("\n")
    .find((line) => line.includes("If `worker-start` exits non-zero"));
  expect(rule).toBeDefined();
  expect(rule).toContain("no running terminal");
  expect(rule).toContain("ark run step <run> <step> finish --failed --not-started");
  expect(rule).toContain("and not `finish --failed`");
  expect(rule).toContain("read `roles` in `ark.yml` again");
  expect(rule).toContain("ark plan check <run>");
  expect(rule).toMatch(/model, harness or ACP model/);
});

test("ARK-281-AC5 chief.md states the 3 auto-merger rules in section 12 and the HELD superseded action", () => {
  const line = chiefPlaybook
    .split("\n")
    .find((l) => l.includes("scripts/auto-merger.sh <workspace>"));
  expect(line).toBeDefined();
  expect(line).toContain("`retro.md`");
  expect(line).toMatch(/`superseded` or `done`/);
  expect(line).toMatch(/`HELD: <run> #<number> <reason>` lines to stderr/);
  const loops = chiefPlaybook.split(/^## 12\./m)[1];
  expect(loops).toContain(line!);
  const held = chiefPlaybook
    .split("\n")
    .find((l) => l.startsWith("A `HELD: <run> #<number> ticket superseded`"));
  expect(held).toBeDefined();
  expect(held).toMatch(/close the run `aborted` or `abandoned`/);
  expect(held).toContain("`gh pr close <url>`");
  expect(chiefPlaybook.split(/^## 8\./m)[1]?.split(/^## 9\./m)[0]).toContain(held!);
});

test("ARK-187-AC3 every literal `ark run close <run> <outcome>` in the playbooks uses a known outcome", () => {
  const closes: { file: string; outcome: string }[] = [];
  for (const file of readdirSync(playbookDirectory).filter((name) => name.endsWith(".md"))) {
    const text = readFileSync(join(playbookDirectory, file), "utf8");
    for (const [, outcome] of text.matchAll(/ark run close <run> ([a-z_]+)/g))
      closes.push({ file, outcome });
  }
  expect(closes.filter(({ file }) => file === "run-lead.md").length).toBeGreaterThan(0);
  for (const { file, outcome } of closes) {
    expect({ file, known: outcomes.includes(outcome) }).toEqual({ file, known: true });
  }
});

// ARK-187-AC4 is also a live human check: abort a real run at a gate before any MR opens.
test("ARK-187-AC4 run-lead lets the human abort in any phase before an MR opens and closes as aborted", () => {
  expect(runLeadPlaybook).toContain("The human can abort in any phase before an MR opens");
  expect(runLeadPlaybook).toContain("ark run close <run> aborted");
});

const retroPlaybook = readFileSync(join(playbookDirectory, "retro.md"), "utf8");
const chiefSection = (n: number) =>
  chiefPlaybook.split(new RegExp(`^## ${n}\\.`, "m"))[1]?.split(/^## \d+\./m)[0] ?? "";

test("ARK-286-AC1 chief section 7 has the busy-agent rule and every send carries a retry id", () => {
  const supervise = chiefSection(7);
  for (const text of ["already processing", "30 seconds", "5 times"])
    expect(supervise).toContain(text);

  const sends = chiefPlaybook.split("\n").filter((l) => l.includes("orca orchestration send"));
  expect(sends.length).toBeGreaterThan(0);
  for (const line of sends) expect(line).toContain("--retry-request");
});

test("ARK-286-AC2 chief reports an undelivered message and sends it again on the next wait", () => {
  const rule = chiefSection(7).split("### A busy agent")[1]?.split(/^### /m)[0] ?? "";
  expect(rule).toMatch(
    /tell the human the target, the subject and that the message is not delivered/,
  );
  expect(rule).toMatch(/Send the message again on your next wait/);
  expect(rule).toMatch(/Never treat the message as delivered/);
});

test("ARK-286-AC3 run-lead has the busy-agent rule with a shared retry id and a fallback", () => {
  for (const text of ["already processing", "--retry-request", "30 seconds", "5 sends"])
    expect(runLeadPlaybook).toContain(text);
  expect(runLeadPlaybook).toContain("orca orchestration check --wait");
  expect(runLeadPlaybook).toContain("final report");
});

test("ARK-286-AC4 retro handoff send carries a retry id and names the chief rule", () => {
  const part1 = retroPlaybook.split("## Part 2")[0]!;
  const send = part1.split("\n").find((l) => l.includes("orca orchestration send"));
  expect(send).toContain("--retry-request <id>");
  expect(part1).toContain("already processing");
  expect(part1).toMatch(/"A busy agent" in `playbooks\/chief\.md` section 7/);
});

test("ARK-286-AC5 chief leaves a close of an aborted run to the run lead unless none is alive", () => {
  const close = chiefSection(8);
  const row = close.split("\n").find((l) => l.startsWith("| The human stops the run"));
  expect(row).toContain("`ark run close <run> aborted`");
  const rule = close.split("\n").find((l) => l.startsWith("Abort row:"));
  expect(rule).toContain("the run lead runs `ark run close <run> aborted` itself");
  expect(rule).toContain("ark status <run>");
  expect(rule).toContain("no run lead is alive");
  expect(runLeadPlaybook).toContain("ark run close <run> aborted");
});

test("ARK-286-AC6 package.json defines the typecheck, lint and format:check scripts", () => {
  const { scripts } = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
  for (const name of ["typecheck", "lint", "format:check"]) expect(scripts[name]).toBeTruthy();
});

const brainstormPlaybook = readFileSync(join(playbookDirectory, "brainstorm.md"), "utf8");
const brainstormHandoff = brainstormPlaybook.split("\n## 8. Hand off")[1]?.split("\n## ")[0] ?? "";
const brainstormRules = brainstormPlaybook.split("\n## Rules")[1]?.split("\n## ")[0] ?? "";
const chiefWaitSection = chiefPlaybook.split("\n## 7. ")[1]?.split("\n## ")[0] ?? "";

test("ARK-289-AC1 brainstorm section 8 asks 'Send it' or 'Do not send' and sends only on 'Send it'", () => {
  expect(brainstormHandoff).toMatch(/Show the message to the human\. Then ask with the ask tool/);
  expect(brainstormHandoff).toContain("'Send it'");
  expect(brainstormHandoff).toContain("'Do not send'");
  expect(brainstormHandoff).toContain("Send only when the answer is 'Send it'.");
  expect(brainstormHandoff).toContain("Never send for an answer the human did not give.");
});

test("ARK-289-AC2 brainstorm gives the one send command and the rules allow only it", () => {
  expect(brainstormHandoff).toContain(
    `orca orchestration send --to run:<id of the Run 'Master Chief: <project> tickets'> --type status --subject "Brainstorm handoff: <ticket ids>" --body "$message" --json`,
  );
  expect(brainstormHandoff).toContain(
    'starts with the line `Human approval: "<the human\'s answer, word for word>" for <ticket ids> at <ISO time>`',
  );
  expect(brainstormHandoff).toContain(
    "The question lists the ticket ids that the answer approves.",
  );
  expect(brainstormHandoff).toContain('Human approval: "Send it" for ARK-290, ARK-291 at ');
  for (const item of [
    "ticket ids and the dependency order",
    "What may run in parallel",
    "The models",
    "The gates",
  ]) {
    expect(brainstormHandoff).toContain(item);
  }
  expect(brainstormRules).toContain("`orca orchestration run-list`");
  expect(brainstormRules).toContain("the one `orca orchestration send` of section 8");
  expect(brainstormRules).toContain("Never run any other `orca orchestration` command.");
  expect(brainstormRules).toContain("Never run `orca terminal send`.");
  expect(brainstormRules).toContain("Never queue a ticket.");
});

test("ARK-289-AC3 brainstorm falls back to the paste-ready message without retry", () => {
  expect(brainstormHandoff).toContain(
    "When no Run has the objective 'Master Chief: <project> tickets', or the send exits non-zero, do not retry with another command. Show the paste-ready message and tell the human why it was not sent.",
  );
});

test("ARK-289-AC4 chief queues a Brainstorm handoff only with a named approval and an existing ticket", () => {
  const handoff = chiefWaitSection.indexOf("`Brainstorm handoff:`");
  const notice = chiefWaitSection.indexOf("A `status` message from a run lead is a notice");
  expect(handoff).toBeGreaterThanOrEqual(0);
  expect(notice).toBeGreaterThan(handoff);
  expect(chiefWaitSection).toContain("is a request to evaluate and queue");
  expect(chiefWaitSection).toContain("evaluate it (section 3) and queue it (section 5)");
  expect(chiefWaitSection).toContain("The body has the `Human approval:` line.");
  expect(chiefWaitSection).toContain(
    "The ticket id is in the `for <ticket ids>` list of that line.",
  );
  expect(chiefWaitSection).toContain("A ticket that is not in the list is not queued.");
  expect(chiefWaitSection).toContain("The ticket file exists under `tickets/`.");
  expect(chiefWaitSection).toContain(
    "Tell the human one line per queued ticket: that you queued it from a brainstorm handoff, with the approval line and its time quoted. Do not ask the human again.",
  );
  expect(chiefWaitSection).toContain("A handoff is never a gate answer.");
  expect(chiefWaitSection).toContain("pass it to the human as a notice and queue nothing for it");
});

test("ARK-289-AC5 changed playbooks and tests pass oxfmt --check", () => {
  const root = join(import.meta.dir, "..");
  const files = [
    "skills/ark/playbooks/brainstorm.md",
    "skills/ark/playbooks/chief.md",
    "test/playbooks.test.ts",
    "test/brainstorm.test.ts",
    "docs/evidence/ARK-289-ac6.md",
  ].filter((file) => existsSync(join(root, file)));
  const result = Bun.spawnSync(["bunx", "oxfmt", "--check", ...files], { cwd: root });
  expect(result.exitCode).toBe(0);
});

test("ARK-289-AC6 the live check records the message id, Master Chief's queue line and the human approval", () => {
  const text = readFileSync(join(import.meta.dir, "../docs/evidence/ARK-289-ac6.md"), "utf8");
  const lines = text.split("\n");
  expect(lines.some((line) => line.startsWith("message id: msg_"))).toBe(true);
  expect(
    lines.some(
      (line) =>
        line.startsWith("Master Chief:") &&
        line.includes("Human approval:") &&
        line.includes("for ARK-186"),
    ),
  ).toBe(true);
  expect(lines).toContain("human: ok");
});

test("ARK-287-AC5 run-lead.md tells the lead to re-test a stale head before asking, to re-test after a refused open, and the validator to commit evidence first", () => {
  const escalate = flat(section(runLeadPlaybook, "## 9. Escalate when the round budget is spent"));
  expect(escalate).toContain("test head:");
  expect(escalate).toContain("stale");
  const retest = escalate.indexOf("`ark test <run>`", escalate.indexOf("test head:"));
  expect(retest).toBeGreaterThan(-1);
  expect(retest).toBeLessThan(escalate.indexOf("orca orchestration ask"));

  const open = flat(section(runLeadPlaybook, "## 10. Open the MRs"));
  expect(open).toContain("changed since the last test");
  expect(open).toMatch(/Run `ark test <run>` and open again\. This needs no gate/);

  const rework = flat(section(runLeadPlaybook, "## 8. Test, review and rework"));
  expect(rework).toMatch(
    /validator commits its evidence files (?:\(.*?\) )?before the last `ark test <run>`, so that no commit follows that test/,
  );
});

test("ARK-298-AC5 ADR 0009 names --name and *.localhost", () => {
  const adr = readFileSync(
    join(import.meta.dir, "../docs/adr/0009-hub-is-a-read-only-live-view.md"),
    "utf8",
  );
  expect(adr).toContain("--name");
  expect(adr).toContain("*.localhost");
});

test("ARK-283-AC5 cli.md and run-lead.md name the manual gate, cli.md equals the generator output, and the ticket playbooks keep manual: true", () => {
  const root = join(import.meta.dir, "..");
  const path = join(root, "docs/reference/cli.md");
  const reference = readFileSync(path, "utf8");
  expect(reference).toContain("manual");
  expect(reference).toContain("ark gate record <run> manual <criterion id> ok|problem");
  for (const status of ["manual pending", "manual ok", "manual problem"])
    expect(reference).toContain(status);

  const runLead = readFileSync(join(playbookDirectory, "run-lead.md"), "utf8");
  expect(runLead).toContain("manual");
  expect(runLead).toContain("ark gate record <run> manual <criterion id> ok|problem");
  expect(runLead).toContain("manual pending");
  expect(runLead).toContain("Master Chief");

  for (const name of ["run-lead.md", "chief.md", "brainstorm.md", "retro.md"])
    expect(readFileSync(join(playbookDirectory, name), "utf8"), name).toContain("manual: true");

  Bun.spawnSync(["bun", join(root, "scripts/cli-reference.ts")], { cwd: root });
  expect(readFileSync(path, "utf8")).toBe(reference);
});

const workerPlaybookText = readFileSync(join(playbookDirectory, "worker.md"), "utf8");

test("ARK-299-AC1 run-lead.md Live human check has the seven items in order, with the slug rule once", () => {
  const live = flat(section(runLeadPlaybook, "### Live human check"));
  const steps = [
    "1. Slug, stated once:",
    "2. Pick a free `<port>` first",
    "3. In the run worktree, start the hub in a background terminal",
    "portless hub.<slug> --app-port <port> ark ui --port <port> --name hub.<slug>.localhost",
    "4. Preflight:",
    "curl -sf http://hub.<slug>.localhost/api/snapshot",
    "use the printed `http://127.0.0.1:<port>` and say so in the report",
    "5. Open the page:",
    "orca tab create --worktree path:<run worktree> --url http://hub.<slug>.localhost",
    "`orca orchestration ask` text",
    "6. In the evidence file, name the URL, not a port.",
    "7. Stop the hub when the check is done.",
  ];
  let at = -1;
  for (const step of steps) {
    const found = live.indexOf(step);
    expect(found, step).toBeGreaterThan(at);
    at = found;
  }
  expect(flat(runLeadPlaybook).split("Run `2026-11-03-ARK-284-1` gives `ark-284-1`")).toHaveLength(
    2,
  );
});

test("ARK-299-AC2 worker.md and run-lead.md start a prototype as portless <topic>.proto, name the URL not a port, and stop it", () => {
  const worker = flat(workerPlaybookText);
  const lead = flat(runLeadPlaybook);
  for (const text of [worker, lead]) {
    expect(text).toContain("portless <topic>.proto --app-port <port> <command>");
    expect(text).toContain("http://<topic>.proto.localhost");
    expect(text).not.toMatch(/on `localhost`/);
  }
  expect(worker).toContain("Report the URL, not a port.");
  expect(worker).toContain("Stop the server after the check.");
  expect(worker).toContain("portless <project> --app-port <port> <command>");
  const gate = lead.slice(lead.indexOf("plannotator annotate"));
  expect(gate).toContain(
    "orca tab create --worktree path:<run worktree> --url http://<topic>.proto.localhost",
  );
});

/** Every code-block line and inline `command` of a Markdown text. */
const quotedCommands = (text: string): string[] => {
  const blocks = [...text.matchAll(/^[ \t]*```\w*\n([\s\S]*?)^[ \t]*```/gm)];
  const rest = text.replaceAll(/^[ \t]*```\w*\n[\s\S]*?^[ \t]*```/gm, "");
  return [
    ...blocks.flatMap(([, body]) => body.split("\n").map((line) => line.trim())),
    ...[...rest.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span),
  ].filter(Boolean);
};

/** What the CLI would refuse in the portless, orca tab create and ark ui commands of a playbook. */
const commandProblems = (text: string): string[] => {
  const problems: string[] = [];
  if (/\bark route\b/.test(text)) problems.push("quotes ark route");
  for (const command of quotedCommands(text)) {
    if (command.startsWith("portless ")) {
      const appPort = command.match(/^portless [^\s-]\S* --app-port (\S+) [^\s-]/)?.[1];
      const validPort =
        appPort === "<port>" ||
        (/^\d+$/.test(appPort ?? "") && Number(appPort) >= 1 && Number(appPort) <= 65535);
      if (!validPort) problems.push(`portless form: ${command}`);
    }
    if (/^orca tab create(\s|$)/.test(command)) {
      const args = command.slice("orca tab create".length).match(/(?:<[^>]*>|\S)+/g) ?? [];
      const pairs = new Map<string, string>();
      for (let i = 0; i < args.length; i += 2) {
        if (!/^--(url|worktree)$/.test(args[i]) || !args[i + 1] || args[i + 1].startsWith("-"))
          pairs.set("bad", args[i]);
        else pairs.set(args[i], args[i + 1]);
      }
      if (pairs.size !== 2 || !pairs.has("--url") || !pairs.has("--worktree"))
        problems.push(`orca tab create flags: ${command}`);
    }
    const ui = command.match(/\bark ui(?=\s|$).*/)?.[0];
    if (ui) {
      const name = ui.match(/--name (\S+)/)?.[1];
      if (!name || !isHubName(name.replaceAll("<slug>", "ark-1")))
        problems.push(`ark ui --name: ${command}`);
    }
  }
  return problems;
};

test("ARK-299-AC3 every portless, orca tab create and ark ui command in run-lead.md and worker.md has a form the CLI accepts", () => {
  expect(commandProblems(runLeadPlaybook)).toEqual([]);
  expect(commandProblems(workerPlaybookText)).toEqual([]);
  // rejected forms, through the same checker
  for (const bad of [
    "orca tab create --url --worktree",
    "orca tab create -x --url http://a.localhost --worktree current",
    "orca tab create --url http://a.localhost",
    "orca tab create --url http://a.localhost --worktree current --bogus x",
    "portless hub.ark-1 --app-port --bogus bun app.ts",
    "portless hub.ark-1 --app-port 0 bun app.ts",
    "portless hub.ark-1 --app-port 99999 bun app.ts",
    "portless hub.ark-1 --app-port 3000",
  ])
    expect(commandProblems(`\`${bad}\``), bad).toHaveLength(1);
  expect(commandProblems("`orca tab create --worktree path:x --url http://a.localhost`")).toEqual(
    [],
  );
  for (const good of ["1", "65535", "<port>"])
    expect(commandProblems(`\`portless a.proto --app-port ${good} bun app.ts\``), good).toEqual([]);
  // the check sees the commands: not vacuously empty
  const commands = [...quotedCommands(runLeadPlaybook), ...quotedCommands(workerPlaybookText)];
  expect(
    commands.filter((command) => /^portless \S+ --app-port/.test(command)).length,
  ).toBeGreaterThanOrEqual(4);
  expect(
    commands.filter((command) => command.startsWith("orca tab create")).length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    commands.filter((command) => command.includes("ark ui --port")).length,
  ).toBeGreaterThanOrEqual(1);
});

test("ARK-299-AC4 the evidence file holds curl -sf, orca tab create and portless list with their output", () => {
  const text = readFileSync(join(import.meta.dir, "../docs/evidence/ARK-299-ac4.md"), "utf8");
  expect(text).toContain("$ curl -sf http://hub.ark-299-check.localhost/api/snapshot");
  expect(text).toMatch(
    /\$ orca tab create --worktree path:\S+ --url http:\/\/hub\.ark-299-check\.localhost\n\S/,
  );
  const lists = text.split("$ portless list\n");
  expect(lists).toHaveLength(3);
  expect(lists[1]).toContain("http://hub.ark-299-check.localhost  ->");
  expect(lists[2]).toMatch(/^No active routes\./);
});

test("ARK-295-AC6 run-lead step 3 skips gh pr list and glab mr list for a none project", () => {
  const step = section(runLeadPlaybook, "3. Read the workspace and the learnings")
    .split("\n3. ")[1]
    ?.split("\n\n")[0];
  expect(step).toContain("`gh pr list --state all --limit 10`");
  expect(step).toContain(
    "When `ark.yml` says `merge_requests: none`, skip `gh pr list` and `glab mr list`",
  );
});

test("ARK-295-AC6 run-lead section 10 has a local-only paragraph that syncs and never opens an MR", () => {
  const paragraph = section(runLeadPlaybook, "10. Open the MRs")
    .split("\n\n")
    .find((text) => text.includes("`merge_requests: none`"));
  expect(paragraph).toBeDefined();
  expect(paragraph).toContain("never run `ark merge-request open <run>`");
  expect(paragraph).toContain("`ark worktree sync <run>`");
  expect(paragraph).toContain("go to section 11");
  expect(paragraph).not.toMatch(/then run, as a separate command/i);
});

test("ARK-295-AC6 run-lead section 11 step 3 lists the branches from ark status in place of MR links", () => {
  const step = section(runLeadPlaybook, "11. Retro and final report")
    .split("\n3. ")[1]
    ?.split("\n4. ")[0];
  expect(step).toContain("For a `none` project, list the branches from `ark status <run>`");
  expect(step).toContain("in place of MR links");
});

test("ARK-295-AC6 chief tells the human the branches on a none worker_done, closes handed_off on the answer and skips the auto-merger", () => {
  const workerDone = chiefPlaybook
    .split("\n3. If the run is in phase `building`, the outcome is not `failed`,")[1]
    ?.split("\n4. ")[0];
  expect(workerDone).toBeDefined();
  expect(workerDone).toContain("project's `ark.yml` says `merge_requests: none`");
  expect(workerDone).toContain("`git -C <repo> log --oneline <base>..<branch>`");
  expect(workerDone).toContain("`worktree.created` event");
  expect(workerDone).toContain("On their answer run `ark run close <run> handed_off`");

  const loops = section(chiefPlaybook, "12. Background loops");
  expect(loops).toContain(
    "Do not start `scripts/auto-merger.sh` for a project whose `ark.yml` says `merge_requests: none`",
  );
});

test("ARK-295-AC6 chief keeps a failed run lead out of the local-only handoff", () => {
  const afterStatus = chiefPlaybook.split("2. Run `ark status <run>`.")[1] as string;
  const localOnly = afterStatus.indexOf("If the run is in phase `building`");
  expect(localOnly).toBeGreaterThan(-1);
  expect(afterStatus.slice(localOnly, afterStatus.indexOf("\n4. "))).toContain(
    "the outcome is not `failed`",
  );
  expect(afterStatus).toContain(
    "4. If the outcome is `failed`, or the run is not in `merge_requests_open`, tell the human",
  );
});

test("ARK-295-AC6 retro needs no host check for handed_off and bootstrap writes merge_requests: none only when the human says so", () => {
  expect(retroPlaybook).toContain("`handed_off` needs no host check: the run has no MR.");
  expect(bootstrapPlaybook).toContain(
    "Write `merge_requests: none` only when the human says the project must not push",
  );
  expect(bootstrapPlaybook).toContain("Never detect it.");
  expect(bootstrapPlaybook).toMatch(/^merge_requests: none # only when the human says/m);
});

test("ARK-295-AC7 the generated CLI reference equals the file and its ark.yml key table lists merge_requests", () => {
  const root = join(import.meta.dir, "..");
  const path = join(root, "docs/reference/cli.md");
  const before = readFileSync(path, "utf8");
  expect(
    Bun.spawnSync(["bun", join(root, "scripts/cli-reference.ts")], { cwd: root }).exitCode,
  ).toBe(0);
  const after = readFileSync(path, "utf8");
  expect(after).toBe(before);
  expect(after).toMatch(
    /^\| `merge_requests` +\| no +\| string +\| `open` \(the default\) or `none`\./m,
  );
});

const root300 = join(import.meta.dir, "..");
const read300 = (file: string) => readFileSync(join(root300, file), "utf8");

test("ARK-300-AC3 local-names.md has the install, check, remove steps and the smoke test evidence", () => {
  const page = read300("docs/how-to/local-names.md");
  for (const text of [
    "npm i -g portless",
    "ark ui install",
    "portless doctor",
    "portless list",
    "curl -sf http://ark.localhost/api/snapshot",
    "ark ui uninstall",
    "192.168.0.174",
    "exit 56",
    "404",
  ])
    expect(page).toContain(text);
});

test("ARK-300-AC4 run-a-ticket.md links local-names.md and cli.md mentions dev.ark.proxy", () => {
  expect(read300("docs/how-to/run-a-ticket.md")).toContain("(local-names.md)");
  expect(read300("docs/reference/cli.md")).toContain("dev.ark.proxy");
});

test("ARK-300-AC5 the live check evidence records a proof line", () => {
  expect(read300("docs/evidence/ARK-300-ac5.md").split("\n")).toContainEqual(
    expect.stringMatching(/^proof: (passed|partial)$/),
  );
});

const root290 = join(import.meta.dir, "..");
const playbook290 = (name: string) =>
  readFileSync(join(root290, "skills/ark/playbooks", name), "utf8");

test("ARK-290-AC5 brainstorm, retro and chief follow ROADMAP.md and no README backlog", () => {
  const brainstorm = playbook290("brainstorm.md");
  expect(brainstorm).toContain("ROADMAP.md");
  expect(brainstorm).not.toContain("the backlog table");
  expect(brainstorm).toContain("Write each new ticket into no list of `ROADMAP.md`");
  expect(brainstorm).toContain("only when the human says so");
  expect(brainstorm).toContain("Add no row to the README");
  expect(brainstorm).not.toMatch(/Mermaid/);
  expect(brainstorm).toContain("Human approval:");

  const retro = playbook290("retro.md");
  expect(retro).toContain("into no list of `~/.ark/projects/ark/ROADMAP.md`");
  expect(retro).toContain("Add no row to the tickets README");
  expect(retro).not.toMatch(/Add a row for it/);

  const chief = playbook290("chief.md");
  expect(chief).toContain(
    "Move a ticket between Now, Next and Later in `ROADMAP.md` only when the human says so",
  );
  expect(chief).toContain("edit no README Status cell");
  expect(chief).not.toMatch(/update the Status cell/i);
  // removing the Status step must leave each numbered step of section 8 on its own line
  expect(chief).toMatch(/\n2\. If the outcome is `merged`/);
});

// ARK-288-AC6 proof: `bun test test/playbooks.test.ts -t ARK-288-AC6`
test("ARK-288-AC6 run-lead sends a status with the run, the round and <n> of 2 after an automatic escalation answer, and does not ask", () => {
  const escalate = flat(section(runLeadPlaybook, "## 9. Escalate when the round budget is spent"));
  expect(escalate).toContain("`gates.escalation: auto`");
  expect(escalate).toContain("`gate: escalation`, `answer: one_more_round`, `by: auto`");
  expect(escalate).toContain(
    "Do not record the answer and do not `ask`. Send Master Chief a `status`",
  );
  expect(escalate).toContain("--type status");
  expect(escalate).toContain(
    '--subject "Escalation answered by auto: <ticket id> round <round> (<n> of 2)"',
  );
  expect(escalate).toContain("Run <run>");
  expect(escalate).toContain("`ark escalate` (a requested escalation)");
  const repair = flat(section(runLeadPlaybook, "## 10. Open the MRs"));
  expect(repair).toContain(
    "With `gates.escalation: auto`, `ark run step ... start` records it by auto",
  );
  const lead = flat(runLeadPlaybook);
  expect(lead).toContain("`escalation` set to `auto` is answered by Ark too, up to 2 times");
  expect(lead).toContain("you report it with a `status`, not an `ask`");
});

test("ARK-288-AC6 chief section 7 passes the auto escalation status to the human and relays no question", () => {
  const supervise = flat(section(chiefPlaybook, "## 7. Supervise"));
  expect(supervise).toContain("`Escalation answered by auto:`");
  expect(supervise).toContain("pass it on as one line");
  expect(supervise).toContain(
    "`<ticket>: auto granted extra round <round> (<n> of 2). No action needed.`",
  );
  expect(supervise).toContain("and ask nothing");
  expect(supervise).toContain("never relay as a question");
  expect(supervise).toContain(
    "The third spent budget, and any escalation that `ark escalate` requested, still arrive as an `ask`",
  );
});

test("ARK-288-AC6 neither playbook still says the escalation gate stays with the human when set to auto", () => {
  for (const playbook of [runLeadPlaybook, chiefPlaybook]) {
    const text = flat(playbook);
    expect(text).not.toContain("`criteria` and `escalation` gates stay with the human");
    expect(text).not.toContain("`criteria` and `escalation` gates still go to the human");
    expect(text).not.toContain("nothing answers them yet");
    expect(text).not.toContain("`criteria` and `escalation` always go to the human");
  }
});

test("ARK-302-AC8 run-lead section 4 tells the run lead to read kind and write the first and last steps for bug, perf and refactor", () => {
  const plan = section(runLeadPlaybook, "## 4. Write the plan\n");
  expect(plan).not.toBe("");
  expect(plan).toMatch(/Read `kind`/);
  expect(plan).toMatch(/`bug`:[^\n]*first step is a validator step that serves every AC/);
  expect(plan).toMatch(
    /`perf`:[^\n]*first step `goal` names `results\/baseline\.md`[^\n]*last step `goal` names `results\/compare\.md`/,
  );
  expect(plan).toMatch(/`refactor`:[^\n]*`base_passed`/);
});

test("ARK-302-AC8 brainstorm and chief section 6 say to set kind in a new ticket", () => {
  const brainstorm = readFileSync(join(playbookDirectory, "brainstorm.md"), "utf8");
  expect(brainstorm).toMatch(
    /`kind` \(`bug`, `perf`, `refactor` or `feature`; set it in every new ticket/,
  );

  const start = section(chiefPlaybook, "## 6. Start a run lead for each ready ticket\n");
  expect(start).not.toBe("");
  expect(start).toMatch(
    /^ *kind: feature # bug, perf, refactor or feature:.*set it in every new ticket/m,
  );
});

test("ARK-297-AC4 bootstrap step 7 does not set the global omp config and says Ark writes each worktree config.yml", () => {
  const step = bootstrapPlaybook
    .split("## 7. Make the workspace's skills reachable for workers")[1]
    ?.split("\n## ")[0];
  expect(step).toBeDefined();
  expect(bootstrapPlaybook).not.toContain("omp config set");
  expect(step).toContain(
    "`skills.customDirectories` into the `.omp/config.yml` of each nested worktree",
  );
  expect(step).toMatch(/global OMP config is not changed/);
  expect(step).toContain("Claude Code workers and Codex workers");
  expect(step).toContain("`SKILL.md` paths in the step prompt");
});

test("ARK-297-AC5 the spikes note says skills reach a nested worktree through skills.customDirectories in its .omp/config.yml", () => {
  const spikes = readFileSync(join(import.meta.dir, "../docs/explanation/orca-spikes.md"), "utf8");
  const item = spikes.split("- **Workspace skills don't load.**")[1]?.split("\n- ")[0];
  expect(item).toBeDefined();
  expect(item).toContain("`skills.customDirectories`");
  expect(item).toContain("`.omp/config.yml` of each nested worktree");
});

test("ARK-304-AC6 chief section 8 row and worker_done step 3 say close applies the refusals of merge-request open", () => {
  const sentence =
    "`ark run close` applies the refusals of `ark merge-request open`; on a refusal, run `ark test <run>` again or `ark criteria amend`, and tell the human which AC is open";
  const row = section(chiefPlaybook, "## 8.")
    .split("\n")
    .find((line) => line.includes("`ark run close <run> handed_off`"));
  expect(row).toContain(sentence);
  const step = chiefPlaybook
    .split("\n3. If the run is in phase `building`, the outcome is not `failed`,")[1]
    ?.split("\n4. ")[0];
  expect(step).toContain(sentence);
  expect(chiefPlaybook).not.toContain("the last test must have passed");
});

test("ARK-305-AC4 brainstorm and chief AC-authoring advice puts removed strings in not: and stale strings outside backticks", () => {
  for (const [file, heading] of [
    ["brainstorm.md", "## Ticket format"],
    ["chief.md", "## 3. Evaluate the ticket"],
  ]) {
    const section = readFileSync(join(playbookDirectory, file), "utf8")
      .split(heading)[1]
      ?.split("\n## ")[0];
    expect(section).toBeDefined();
    expect(section).toContain(
      "in `not:` (`` `not:docs/old/` ``): it must then be in no tracked file",
    );
    expect(section).toMatch(
      /string that the run rewrites, or that only describes the old state, outside backticks/,
    );
  }
});
