import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempArkHome, tempGitRepo, writeProject } from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const arkEntry = join(import.meta.dir, "..", "cli", "ark.ts");
const runId = "2026-11-10-DEMO-1-1";

let main: string;
let worktree: string;

/** `ark` in `cwd`; the shared helper has no cwd. */
function arkIn(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["bun", arkEntry, ...args], { cwd, env: process.env });
  return {
    code: result.exitCode ?? 1,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

const cases = (root: string) => {
  const directory = join(root, "test", "cases");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
};

beforeEach(() => {
  tempArkHome();
  main = tempGitRepo();
  mkdirSync(join(main, "test", "cases"), { recursive: true });
  writeFileSync(join(main, "test", "cases", "DEMO-T5.md"), "existing\n");
  Bun.spawnSync(["git", "add", "-A"], { cwd: main });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@e.x", "commit", "-qm", "case"], {
    cwd: main,
  });
  const project = writeProject("demo", { workspace: main });
  // The run's root worktree is the mirror folder itself.
  const runDirectory = join(project, "runs", runId);
  mkdirSync(runDirectory, { recursive: true });
  worktree = join(runDirectory, "workspace");
  Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "ark/run", worktree], { cwd: main });
});

test("ARK-T196 ark test-case new --run writes into the run worktree from the main checkout and keeps ids unique", () => {
  const first = arkIn(main, "test-case", "new", "DEMO", "--run", runId);
  expect(first.code).toBe(0);
  expect(first.out).toBe("DEMO-T6\n");
  expect(first.err).toContain(join(worktree, "test", "cases", "DEMO-T6.md"));
  expect(cases(worktree)).toContain("DEMO-T6.md");
  expect(cases(main)).toEqual(["DEMO-T5.md"]);
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: main });
  expect(status.stdout.toString()).toBe("");

  const elsewhere = mkdtempSync(join(tmpdir(), "ark-elsewhere-"));
  const second = arkIn(elsewhere, "test-case", "new", "DEMO", "--run", runId, "--project", "demo");
  expect(second.code).toBe(0);
  expect(second.out).toBe("DEMO-T7\n");
  expect(cases(worktree)).toContain("DEMO-T7.md");
  expect(cases(main)).toEqual(["DEMO-T5.md"]);
});

test("ARK-T197 ark test-case new without --run refuses in the workspace checkout and works in a run worktree", () => {
  const refused = arkIn(main, "test-case", "new", "DEMO");
  expect(refused.code).toBe(1);
  expect(refused.out).toBe("");
  expect(refused.err).toContain("ark test-case new DEMO --run <run>");
  expect(cases(main)).toEqual(["DEMO-T5.md"]);

  const sub = join(main, "src");
  mkdirSync(sub);
  const nested = arkIn(sub, "test-case", "new", "DEMO");
  expect(nested.code).toBe(1);
  expect(nested.out).toBe("");
  expect(cases(main)).toEqual(["DEMO-T5.md"]);

  const inWorktree = arkIn(worktree, "test-case", "new", "DEMO");
  expect(inWorktree.code).toBe(0);
  expect(inWorktree.out).toBe("DEMO-T6\n");
  expect(cases(worktree)).toContain("DEMO-T6.md");
});
