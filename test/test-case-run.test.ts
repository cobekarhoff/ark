import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initProjectRepo,
  linkedArkHome,
  tempArkHome,
  tempGitRepo,
  writeProject,
} from "./helpers.ts";

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

  // A plain repo outside ARK_HOME/projects is nobody's workspace or project folder: the guard leaves it alone.
  const plain = tempGitRepo();
  const inPlain = arkIn(plain, "test-case", "new", "DEMO");
  expect(inPlain.code).toBe(0);
  expect(inPlain.out).toBe("DEMO-T1\n");
  expect(cases(plain)).toEqual(["DEMO-T1.md"]);
});

/** A project folder that is a git repo (ARK-482) through a symlinked ARK_HOME, with a run worktree nested in it. */
function projectWorld() {
  const arkHome = linkedArkHome();
  const checkout = tempGitRepo();
  const project = writeProject("demo", { workspace: checkout });
  initProjectRepo(project);
  const runDirectory = join(project, "runs", runId);
  mkdirSync(runDirectory, { recursive: true });
  const runWorktree = join(runDirectory, "workspace");
  Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "ark/run", runWorktree], { cwd: checkout });
  return { arkHome, project, runDirectory, runWorktree };
}

/** What a refusal in `project` must leave: no test/ folder, nothing of ark test-case in .git, a clean status. */
function expectProjectUntouched(project: string) {
  expect(existsSync(join(project, "test"))).toBe(false);
  expect(
    readdirSync(join(project, ".git")).filter((name) => name.startsWith("ark-test-case")),
  ).toEqual([]);
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: project });
  expect(status.stdout.toString()).toBe("");
}

test("ARK-T666 ark test-case new without --run refuses in the project folder and every folder under it, and writes no file", () => {
  const { project, runDirectory } = projectWorld();
  const results = join(runDirectory, "results");
  const deeper = join(runDirectory, "scratch", "deeper");
  mkdirSync(results);
  mkdirSync(deeper, { recursive: true });
  for (const folder of [project, join(project, "runs"), runDirectory, results, deeper]) {
    const refused = arkIn(folder, "test-case", "new", "DEMO");
    expect([folder, refused.code, refused.out]).toEqual([folder, 1, ""]);
    expect(refused.err).toContain(realpathSync(project));
    expect(refused.err).toContain("ark test-case new DEMO --run <run>");
  }
  expectProjectUntouched(project);
});

test("ARK-T666 ark test-case new without --run refuses in a project folder that has no ark.yml and no runs", () => {
  const { arkHome } = projectWorld();
  const bare = join(arkHome, "projects", "other");
  initProjectRepo(bare);
  const refused = arkIn(bare, "test-case", "new", "DEMO");
  expect([refused.code, refused.out]).toEqual([1, ""]);
  expect(refused.err).toContain("ark test-case new DEMO --run <run>");
  expectProjectUntouched(bare);
});

test("ARK-T666 ark test-case new writes into the run worktree, nested in the project folder, with or without --run", () => {
  const { project, runWorktree } = projectWorld();
  const sub = join(runWorktree, "src");
  mkdirSync(sub);
  const inWorktree = arkIn(runWorktree, "test-case", "new", "DEMO");
  expect([inWorktree.code, inWorktree.out]).toEqual([0, "DEMO-T1\n"]);
  const inSub = arkIn(sub, "test-case", "new", "DEMO");
  expect([inSub.code, inSub.out]).toEqual([0, "DEMO-T2\n"]);
  const fromProject = arkIn(project, "test-case", "new", "DEMO", "--run", runId);
  expect([fromProject.code, fromProject.out]).toEqual([0, "DEMO-T3\n"]);
  expect(cases(runWorktree)).toEqual(["DEMO-T1.md", "DEMO-T2.md", "DEMO-T3.md"]);
  expectProjectUntouched(project);
});
