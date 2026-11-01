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

test("ARK-169-AC2 chief creates its own Run unless the current Run has the queue objective", () => {
  const queueSection = chiefPlaybook
    .split("## 5. Queue the approved tickets")[1]
    ?.split("\n## ")[0];
  expect(queueSection).toBeDefined();
  expect(queueSection).toMatch(
    /Use that Run only when its objective is exactly "Master Chief: <project> tickets"\./,
  );
  expect(queueSection).toMatch(
    /In every other case, including no Run or a Run with another objective, create it\./,
  );

  const runCreate = queueSection!.indexOf(
    'orca orchestration run-create --objective "Master Chief: <project> tickets"',
  );
  const taskCreate = queueSection!.indexOf("orca orchestration task-create");
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
