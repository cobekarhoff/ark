import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  arkWithin,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeFakeCommand,
  writeProject,
  writeTicket,
} from "./helpers.ts";
import { worktreeCleanup } from "../cli/worktree.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(60_000);

const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};
const fileProtocol = "protocol.file.allow=always";

/** Per-command limit; below the 60 s test timeout so a stalled command fails with its own message. */
const commandLimitMs = 45_000;

const ark = (...args: string[]) => arkWithin(commandLimitMs, ...args);

/** Runs a command; throws with the command line and stderr on a timeout or a non-zero exit. Returns trimmed stdout. */
function run(command: string[]): string {
  const result = Bun.spawnSync(command, { timeout: commandLimitMs });
  const line = command.join(" ");
  if (result.exitedDueToTimeout)
    throw new Error(`${line} timed out after ${commandLimitMs} ms: ${result.stderr.toString()}`);
  if (result.exitCode !== 0)
    throw new Error(`${line} failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const git = (directory: string, ...args: string[]): string =>
  run(["git", "-C", directory, ...args]);

/** Writes a file and commits it; returns the new HEAD. */
function commitFile(directory: string, name: string, content: string): string {
  writeFileSync(join(directory, name), content);
  git(directory, "add", "--", name); // never -A: a consumer worktree holds the library head in vendor/lib
  git(directory, "commit", "-q", "-m", `change ${name}`);
  return git(directory, "rev-parse", "HEAD");
}

type Meta = {
  workspace: string;
  /** Library repo with two commits: `first` is the one the consumers record. */
  first: string;
  second: string;
  /** Recorded commit of the submodule whose repo is not a repo of the workspace. */
  otherRecorded: string;
};

/**
 * A meta-repo (the root is not a repo) with repos/lib (two commits), repos/consumer (submodules vendor/lib at the
 * first library commit and vendor/other, a repository outside the workspace) and repos/plain (no submodule).
 */
function submoduleMeta(): Meta {
  const workspace = mkdtempSync(join(tmpdir(), "ark-submodule-meta-"));
  mkdirSync(join(workspace, "repos"));
  const library = join(workspace, "repos/lib");
  const other = tempGitRepo({ "other.txt": "other one\n" });
  const otherRecorded = git(other, "rev-parse", "HEAD");
  commitFile(other, "other.txt", "other two\n");
  git(other, "reset", "-q", "--hard", otherRecorded);
  const libraryRepo = tempGitRepo({ "lib.txt": "lib one\n" });
  const first = git(libraryRepo, "rev-parse", "HEAD");
  run(["mv", libraryRepo, library]);

  const consumer = tempGitRepo({ "app.txt": "app\n" });
  git(consumer, "-c", fileProtocol, "submodule", "add", "-q", library, "vendor/lib");
  git(consumer, "-c", fileProtocol, "submodule", "add", "-q", other, "vendor/other");
  git(consumer, "commit", "-q", "-m", "add submodules");
  run(["mv", consumer, join(workspace, "repos/consumer")]);
  const second = commitFile(library, "lib.txt", "lib two\n");
  commitFile(other, "other.txt", "other two\n");
  run(["mv", tempGitRepo({ "plain.txt": "plain\n" }), join(workspace, "repos/plain")]);
  return { workspace, first, second, otherRecorded };
}

/** A project over `workspace` whose suite runs `bun test` in repos/consumer, and a started run. */
function startRun(
  workspace: string,
  extra: Record<string, unknown> = {},
): { runId: string; runDirectory: string } {
  const arkHome = tempArkHome();
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [
      {
        name: "consumer",
        level: "integration",
        repo: "repos/consumer",
        command: "bun test ./library.test.ts --reporter=junit --reporter-outfile={report}",
        parser: "bun",
      },
    ],
    roles,
    ...extra,
  });
  const ticket = writeTicket(
    "demo",
    "FAKE-1",
    [{ id: "FAKE-1-AC1", text: "criterion" }],
    "Ticket FAKE-1",
  );
  const runId = ark("run", "start", ticket, "--project", "demo").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-1-\d+/,
  )![0];
  const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
  recordEvaluation(runDirectory);
  return { runId, runDirectory };
}

/** The consumer's suite: it reads the library through vendor/lib and logs the revision it saw. */
const consumerSuite = `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("ARK-T112 consumer reads vendor/lib", () => {
  const revision = Bun.spawnSync(["git", "-C", "vendor/lib", "rev-parse", "HEAD"]).stdout.toString().trim();
  const text = readFileSync("vendor/lib/lib.txt", "utf8").trim();
  console.log("library-revision " + revision + " text " + text);
  expect(text).not.toBe("");
});
`;

const mirrorOf = (runDirectory: string, repo: string) => join(runDirectory, "workspace", repo);
const stageOf = (directory: string) => git(directory, "ls-files", "--stage", "--", "vendor/lib");

function create(runId: string, ...repos: string[]) {
  return ark("worktree", "create", runId, ...repos);
}

/** Commits the suite file in the consumer worktree and runs `ark test`, returning the head-side log of ARK-T112. */
function consumerTestLog(runId: string, runDirectory: string): string {
  const consumer = mirrorOf(runDirectory, "repos/consumer");
  if (!existsSync(join(consumer, "library.test.ts")))
    commitFile(consumer, "library.test.ts", consumerSuite);
  ark("test", runId); // exit code is 1: no test carries the ticket AC; the case evidence is what is read
  return readFileSync(join(runDirectory, "results/evidence/ARK-T112/head/command.log"), "utf8");
}

describe("worktree create fills submodules", () => {
  test("ARK-T111 create fills vendor/lib at the recorded commit and leaves the index pointer alone", () => {
    const { workspace, first, second } = submoduleMeta();
    const { runId, runDirectory } = startRun(workspace);
    const recorded = stageOf(join(workspace, "repos/consumer"));
    expect(recorded).toContain(first);

    const created = create(runId, "repos/consumer");
    expect(created.code).toBe(0);

    const worktree = mirrorOf(runDirectory, "repos/consumer");
    expect(readFileSync(join(worktree, "vendor/lib/lib.txt"), "utf8")).toBe("lib one\n");
    expect(git(join(worktree, "vendor/lib"), "rev-parse", "HEAD")).toBe(first);
    expect(git(join(worktree, "vendor/lib"), "rev-parse", "HEAD")).not.toBe(second);
    expect(stageOf(worktree)).toBe(recorded);
    expect(git(worktree, "diff", "--cached", "--raw")).toBe("");
    expect(git(worktree, "status", "--porcelain")).toBe("");
    // the second submodule is filled too
    expect(readFileSync(join(worktree, "vendor/other/other.txt"), "utf8")).toBe("other one\n");
  });

  test("ARK-T111 a plain repo worktree is made with no submodule step", () => {
    const { workspace } = submoduleMeta();
    const { runId, runDirectory } = startRun(workspace);

    const created = create(runId, "repos/plain");
    expect(created.code).toBe(0);
    expect(created.out).not.toContain("submodule");

    const worktree = mirrorOf(runDirectory, "repos/plain");
    expect(readFileSync(join(worktree, "plain.txt"), "utf8")).toBe("plain\n");
    expect(existsSync(join(worktree, ".gitmodules"))).toBe(false);
    expect(git(worktree, "status", "--porcelain")).toBe("");
  });

  test("ARK-T111 a failing submodule names consumer, path and cause, keeps the worktree, and a retry does not delete it", () => {
    const { workspace } = submoduleMeta();
    const broken = join(workspace, "repos/consumer");
    const brokenCopy = join(workspace, "repos/broken");
    run(["git", "clone", "-q", "--no-hardlinks", broken, brokenCopy]);
    git(brokenCopy, "config", "user.name", "Ark Test");
    git(brokenCopy, "config", "user.email", "ark@example.com");
    git(brokenCopy, "config", "-f", ".gitmodules", "submodule.vendor/lib.url", "/no/such/library");
    git(brokenCopy, "commit", "-q", "-am", "point the submodule at a missing repository");
    // no modules in the source clone to borrow from: the commit cannot be fetched from anywhere
    rmSync(join(brokenCopy, ".git/modules"), { recursive: true, force: true });
    rmSync(join(brokenCopy, "vendor"), { recursive: true, force: true });
    git(brokenCopy, "checkout", "--", "vendor"); // empty gitlink folders, a clean checkout
    const { runId, runDirectory } = startRun(workspace);

    const first = create(runId, "repos/broken");
    expect(first.code).not.toBe(0);
    expect(first.err).toContain("repos/broken");
    expect(first.err).toContain("vendor/lib");
    expect(first.err).toContain("/no/such/library");
    const worktree = mirrorOf(runDirectory, "repos/broken");
    expect(existsSync(join(worktree, ".git"))).toBe(true);
    const created = () =>
      readFileSync(join(runDirectory, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "worktree.created" && event.data.repo === "repos/broken");
    expect(created()).toHaveLength(1);

    const retry = create(runId, "repos/broken");
    expect(retry.code).not.toBe(0);
    expect(retry.err).toContain("vendor/lib");
    expect(existsSync(join(worktree, ".git"))).toBe(true);
    expect(created()).toHaveLength(1);
  });
});

describe("worktree create and sync use the run's library head", () => {
  test("ARK-T112 a committed library change is seen by create, sync and ark test; the index pointer and an uncommitted change are not", () => {
    const { workspace, first, second, otherRecorded } = submoduleMeta();
    // sync needs origin/HEAD in each repo; the library maps to its worktree by basename, not by origin
    for (const repo of ["lib", "consumer"]) {
      const bare = mkdtempSync(join(tmpdir(), "ark-bare-"));
      run(["git", "init", "-q", "--bare", "-b", "main", bare]);
      const path = join(workspace, "repos", repo);
      git(path, "remote", "add", "origin", bare);
      git(path, "push", "-q", "-u", "origin", "main");
      git(path, "remote", "set-head", "origin", "main");
    }
    const { runId, runDirectory } = startRun(workspace);
    const recorded = stageOf(join(workspace, "repos/consumer"));
    expect(recorded).toContain(first);

    expect(create(runId, "repos/lib").code).toBe(0);
    const library = mirrorOf(runDirectory, "repos/lib");
    const libraryHead = commitFile(library, "lib.txt", "lib run change\n");
    const created = create(runId, "repos/consumer");
    expect(created.code).toBe(0);

    const consumer = mirrorOf(runDirectory, "repos/consumer");
    const folder = join(consumer, "vendor/lib");
    expect(git(folder, "rev-parse", "HEAD")).toBe(libraryHead);
    expect(readFileSync(join(folder, "lib.txt"), "utf8")).toBe("lib run change\n");
    expect(stageOf(consumer)).toBe(recorded);
    expect(git(consumer, "diff", "--cached", "--raw")).toBe("");
    // a submodule whose repo the run has no worktree of stays at its recorded commit
    expect(git(join(consumer, "vendor/other"), "rev-parse", "HEAD")).toBe(otherRecorded);

    const firstLog = consumerTestLog(runId, runDirectory);
    expect(firstLog).toContain(`library-revision ${libraryHead} text lib run change`);
    expect(firstLog).not.toContain(first);
    expect(firstLog).not.toContain(second);
    expect(
      JSON.parse(
        readFileSync(join(runDirectory, "results/evidence/ARK-T112/head/result.json"), "utf8"),
      ).status,
    ).toBe("passed");

    // a second committed change, a third left uncommitted, then sync
    const secondHead = commitFile(library, "lib.txt", "lib run change two\n");
    writeFileSync(join(library, "lib.txt"), "lib uncommitted\n");
    const synced = ark("worktree", "sync", runId);
    expect(synced.code).toBe(0);
    expect(git(folder, "rev-parse", "HEAD")).toBe(secondHead);
    expect(stageOf(consumer)).toBe(recorded);
    expect(git(consumer, "diff", "--cached", "--raw")).toBe("");

    const secondLog = consumerTestLog(runId, runDirectory);
    expect(secondLog).toContain(`library-revision ${secondHead} text lib run change two`);
    expect(secondLog).not.toContain("uncommitted");

    const status = ark("status", runId);
    const lines = status.out.split("\n").filter((line) => line.startsWith("submodule "));
    expect(lines).toEqual([
      `submodule repos/consumer/vendor/lib at run head of repos/lib ${secondHead.slice(0, 8)}`,
    ]);
  });

  test("ARK-T112 a library worktree made after the consumer's is picked up by a second create", () => {
    const { workspace, first } = submoduleMeta();
    const { runId, runDirectory } = startRun(workspace);
    expect(create(runId, "repos/consumer").code).toBe(0);
    const consumer = mirrorOf(runDirectory, "repos/consumer");
    expect(git(join(consumer, "vendor/lib"), "rev-parse", "HEAD")).toBe(first);
    expect(ark("status", runId).out).not.toContain("submodule repos/consumer");

    expect(create(runId, "repos/lib").code).toBe(0);
    const library = mirrorOf(runDirectory, "repos/lib");
    const libraryHead = commitFile(library, "lib.txt", "lib after the consumer\n");
    expect(create(runId, "repos/consumer").code).toBe(0);

    expect(git(join(consumer, "vendor/lib"), "rev-parse", "HEAD")).toBe(libraryHead);
    expect(stageOf(consumer)).toContain(first);
    expect(git(consumer, "diff", "--cached", "--raw")).toBe("");
    expect(ark("status", runId).out).toContain(
      `submodule repos/consumer/vendor/lib at run head of repos/lib ${libraryHead.slice(0, 8)}`,
    );
  });
});

/** Commits a `.gitmodules` URL that no clone can reach into the consumer, so only local objects can fill vendor/lib. */
function breakRemote(workspace: string): void {
  const consumer = join(workspace, "repos/consumer");
  git(consumer, "config", "-f", ".gitmodules", "submodule.vendor/lib.url", "/no/such/lib");
  git(consumer, "commit", "-q", "-am", "unreachable library remote");
}

describe("worktree create composes before setup and without the remote", () => {
  test("ARK-T111 setup runs after submodules are filled: it reads the recorded library", () => {
    const { workspace } = submoduleMeta();
    const { runId, runDirectory } = startRun(workspace, {
      setup: "test ! -d vendor || grep -q 'lib one' vendor/lib/lib.txt",
    });
    const created = create(runId, "repos/consumer");
    expect(created.err).toBe("");
    expect(created.code).toBe(0);
    expect(created.out).toContain("setup    repos/consumer");
    expect(existsSync(join(mirrorOf(runDirectory, "repos/consumer"), "vendor/lib/lib.txt"))).toBe(
      true,
    );
  });

  test("ARK-T112 an unreachable .gitmodules URL still composes from the run library worktree, for create and the base of ark test", () => {
    const { workspace, first } = submoduleMeta();
    breakRemote(workspace);
    const { runId, runDirectory } = startRun(workspace);
    expect(create(runId, "repos/lib").code).toBe(0);
    const libraryHead = commitFile(
      mirrorOf(runDirectory, "repos/lib"),
      "lib.txt",
      "lib run change\n",
    );
    const created = create(runId, "repos/consumer");
    expect(created.err).toBe("");
    expect(created.code).toBe(0);

    const consumer = mirrorOf(runDirectory, "repos/consumer");
    expect(git(join(consumer, "vendor/lib"), "rev-parse", "HEAD")).toBe(libraryHead);
    expect(stageOf(consumer)).toContain(first);
    expect(git(consumer, "diff", "--cached", "--raw")).toBe("");
    expect(ark("status", runId).out).toContain(
      `submodule repos/consumer/vendor/lib at run head of repos/lib ${libraryHead.slice(0, 8)}`,
    );

    const headLog = consumerTestLog(runId, runDirectory);
    expect(headLog).toContain(`library-revision ${libraryHead} text lib run change`);
    // the base suite only ran because the base fill cloned the recorded commit from the head worktree's
    // folder instead of /no/such/lib
    expect(existsSync(join(runDirectory, "results/evidence/ARK-T112/base/command.log"))).toBe(true);
  });
});

describe("worktree cleanup of composed submodules", () => {
  /** A consumer composed at the run head of a committed library change. */
  function composed(): { runId: string; consumer: string; folder: string } {
    const { workspace } = submoduleMeta();
    const { runId, runDirectory } = startRun(workspace);
    expect(create(runId, "repos/lib").code).toBe(0);
    commitFile(mirrorOf(runDirectory, "repos/lib"), "lib.txt", "lib run change\n");
    expect(create(runId, "repos/consumer").code).toBe(0);
    const consumer = mirrorOf(runDirectory, "repos/consumer");
    expect(git(consumer, "status", "--porcelain")).toContain("vendor/lib");
    return { runId, consumer, folder: join(consumer, "vendor/lib") };
  }

  test("ARK-T112 a clean composed worktree is removed", () => {
    const { runId, consumer } = composed();
    worktreeCleanup(runId, "demo");
    expect(existsSync(consumer)).toBe(false);
  });

  test.each([
    ["modified", "lib.txt"],
    ["untracked", "scratch.txt"],
  ])("ARK-T112 %s submodule files keep the composed worktree", (_label, file) => {
    const { runId, consumer, folder } = composed();
    writeFileSync(join(folder, file), "edited\n");
    worktreeCleanup(runId, "demo");
    expect(existsSync(consumer)).toBe(true);
    expect(readFileSync(join(folder, file), "utf8")).toBe("edited\n");
  });
});

describe("a stalled git or ark command fails at its own limit", () => {
  const testTimeoutMs = 60_000;

  /** Runs `call` with a shim named `name` first on PATH; returns what it threw and how long it took. */
  function stalledWith(
    name: string,
    script: string,
    call: () => unknown,
  ): { message: string; elapsedMs: number } {
    const saved = process.env.PATH;
    const started = Date.now();
    try {
      writeFakeCommand(name, script);
      call();
    } catch (error) {
      return { message: (error as Error).message, elapsedMs: Date.now() - started };
    } finally {
      process.env.PATH = saved;
    }
    throw new Error(`the ${name} call returned after ${Date.now() - started} ms and threw nothing`);
  }

  const limitOf = (message: string): number =>
    Number(message.match(/timed out after (\d+) ms/)?.[1]);

  test("ARK-T400 a git command that stalls fails with its command line, the limit and its stderr", () => {
    const directory = tempGitRepo();
    const { message, elapsedMs } = stalledWith(
      "git",
      "echo shim-git-stderr-marker >&2\nexec sleep 90",
      () => git(directory, "add", "--", "x.txt"),
    );
    expect(message).toContain(`git -C ${directory} add -- x.txt timed out after `);
    expect(message).toContain("shim-git-stderr-marker");
    expect(limitOf(message)).toBeGreaterThan(0);
    expect(limitOf(message)).toBeLessThan(testTimeoutMs);
    expect(elapsedMs).toBeLessThan(testTimeoutMs);
  });

  test("ARK-T400 an ark command that stalls fails with its command line and the limit", () => {
    const { message, elapsedMs } = stalledWith("bun", "exec sleep 90", () => ark("status"));
    expect(message).toContain("ark status timed out after ");
    expect(limitOf(message)).toBeGreaterThan(0);
    expect(limitOf(message)).toBeLessThan(testTimeoutMs);
    expect(elapsedMs).toBeLessThan(testTimeoutMs);
  });

  test("ARK-T400 a git command that fails at once names its command line, exit code and stderr, and no limit", () => {
    const directory = tempGitRepo();
    const { message } = stalledWith("git", "echo shim-fast-failure >&2\nexit 3", () =>
      git(directory, "add", "--", "x.txt"),
    );
    expect(message).toContain(
      `git -C ${directory} add -- x.txt failed (exit 3): shim-fast-failure`,
    );
    expect(message).not.toContain("timed out");
  });

  test("ARK-T400 healthy git and ark commands return their output unchanged", () => {
    expect(git(tempGitRepo(), "rev-parse", "--git-dir")).toBe(".git");
    const result = ark("--help");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: ark <command>");
  });
});
