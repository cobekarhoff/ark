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
