import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const playbookDirectory = join(import.meta.dir, "../skills/ark/playbooks");
const chiefPlaybook = readFileSync(join(playbookDirectory, "chief.md"), "utf8");
const bootstrapPlaybook = readFileSync(join(playbookDirectory, "bootstrap.md"), "utf8");

test("ARK-162-AC1 Master Chief proceeds only with an Orca terminal handle", () => {
  const command = chiefPlaybook.match(/Run `([^`]+)`\./)?.[1];
  expect(command).toBe("test -n \"$ORCA_TERMINAL_HANDLE\"");
  expect(chiefPlaybook).not.toContain("caller.orcaSessionId");

  const withTerminalHandle = Bun.spawnSync(["sh", "-c", command!], {
    env: { ...process.env, ORCA_TERMINAL_HANDLE: "terminal-test" },
  });
  const withoutTerminalHandle = Bun.spawnSync(["sh", "-c", command!], {
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ORCA_TERMINAL_HANDLE")),
  });

  expect(withTerminalHandle.exitCode).toBe(0);
  expect(withoutTerminalHandle.exitCode).not.toBe(0);
});

test("ARK-162-AC2 bootstrap depth check does not create a Run", () => {
  const depthCheck = bootstrapPlaybook.split("## 6. Confirm Orca's nesting depth is at least 2")[1]?.split("\n## ")[0];
  expect(depthCheck).toBeDefined();

  const shellBlocks = [...depthCheck!.matchAll(/```sh\n([\s\S]*?)\n```/g)].map(([, body]) => body);
  expect(shellBlocks.join("\n")).not.toMatch(/^\s*orca orchestration run-create\b/m);
});
test("ARK-164-AC1 dispatch starts in an Orca-known worktree and completes the queue Task at close", () => {
  const dispatch = chiefPlaybook.split("## 6. Start a run lead for each ready ticket")[1]?.split("\n## ")[0];
  const close = chiefPlaybook.split("## 8. Close the run")[1]?.split("\n## ")[0];
  expect(dispatch).toBeDefined();
  expect(close).toBeDefined();

  expect(dispatch).not.toMatch(/task-update[^\n]*--status dispatched/);
  expect(dispatch).toContain("--worktree current");
  expect(dispatch).not.toMatch(/worker-start[^\n]*--worktree path:/);
  expect(close).toMatch(/orca orchestration task-update[^\n]*--status completed/);
});
