import { expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempGitRepo } from "./helpers";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const script = join(import.meta.dir, "..", "scripts", "project-autocommit.sh");
const ignoredDirectories = ["runs", "services", "test-cache", "qe", "audit", "prototypes"];

interface PassResult {
  code: number;
  out: string;
  err: string;
}

// An index.lock is held by a real process, and the loop is observed pass by pass: no wall-clock wait (ARK-T126).

// ARK-T663: launchd gives the job only HOME, PATH, ARK_HOME, ARK_PROJECT and TMPDIR, so the test does too.
test("ARK-T663 project-autocommit.sh makes the project folder a git repository and commits a changed ticket, once per change, without a push, and its loop outlives a failed commit", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ark-autocommit-"));
  const parent = tempGitRepo();
  const arkHome = join(parent, "ark-home");
  const home = join(scratch, "home");
  mkdirSync(home);
  // No identity, a signing key that cannot sign, and a default that would push a new branch to origin.
  writeFileSync(
    join(home, ".gitconfig"),
    "[init]\n\tdefaultBranch = main\n[push]\n\tautoSetupRemote = true\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n",
  );
  const environment = (project?: string): Record<string, string> => ({
    PATH: process.env.PATH as string,
    HOME: home,
    TMPDIR: scratch,
    ARK_HOME: arkHome,
    ...(project === undefined ? {} : { ARK_PROJECT: project }),
  });
  const holders: Bun.Subprocess[] = [];

  const projectDirectory = (name: string) => join(arkHome, "projects", name);
  const project = projectDirectory("ark");
  const other = projectDirectory("other");
  const ticket = (directory: string) => join(directory, "tickets", "ARK-1.md");
  const setTicket = (directory: string, status: string) =>
    writeFileSync(ticket(directory), `---\nstatus: ${status}\n---\n# ARK-1\n`);
  const git = (directory: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", directory, ...args], { env: environment() });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  const commits = (directory: string) => Number(git(directory, "rev-list", "--count", "HEAD").out);
  const lastFiles = (directory: string) =>
    git(directory, "show", "--name-only", "--format=", "HEAD").out.trim().split("\n").sort();
  const subject = (directory: string) => git(directory, "log", "-1", "--format=%s").out.trim();
  const once = (name: string | undefined, ...extra: string[]): PassResult => {
    const result = Bun.spawnSync(["bash", script, scratch, "1", ...extra], {
      env: environment(name),
      timeout: 30_000,
    });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  /** A real process that holds `<project>/.git/index.lock` with its own pid in it, like a running `git` command. */
  const holdLock = async (directory: string) => {
    const lock = join(directory, ".git", "index.lock");
    const holder = Bun.spawn(["sh", "-c", `echo $$ > '${lock}'; echo ready; exec sleep 120`], {
      stdout: "pipe",
    });
    holders.push(holder);
    await holder.stdout.getReader().read();
    const release = () => {
      holder.kill();
      rmSync(lock, { force: true });
    };
    return { lock, pid: holder.pid, release };
  };

  let loop: Bun.Subprocess | undefined;
  try {
    for (const [directory, text] of [
      [project, "ark"],
      [other, "other"],
    ] as const) {
      mkdirSync(join(directory, "tickets"), { recursive: true });
      setTicket(directory, "todo");
      writeFileSync(join(directory, "ROADMAP.md"), `# ${text} roadmap\n`);
      writeFileSync(join(directory, "ark.yml"), `name: ${text}\n`);
      writeFileSync(join(directory, "learnings.md"), `# ${text} learnings\n`);
    }
    for (const directory of ignoredDirectories) {
      mkdirSync(join(project, directory), { recursive: true });
      writeFileSync(join(project, directory, "file.txt"), "ignored\n");
    }
    const parentCommits = commits(parent);

    // 1. First pass: own repository, one commit, nothing ignored tracked, no identity and a failing signer.
    const first = once("ark", "--once");
    expect(first.code, first.err).toBe(0);
    expect(existsSync(join(project, ".git"))).toBe(true);
    expect(commits(parent)).toBe(parentCommits);
    expect(git(parent, "ls-files").out).not.toContain("ark-home");
    expect(commits(project)).toBe(1);
    expect(subject(project)).toContain("autocommit");
    expect(lastFiles(project)).toEqual([
      ".gitignore",
      "ROADMAP.md",
      "ark.yml",
      "learnings.md",
      "tickets/ARK-1.md",
    ]);
    const tracked = git(project, "ls-files").out;
    for (const directory of ignoredDirectories) expect(tracked).not.toContain(`${directory}/`);
    const ignoreLines = readFileSync(join(project, ".gitignore"), "utf8").split("\n");
    for (const directory of ignoredDirectories) expect(ignoreLines).toContain(`${directory}/`);

    // 2. Nothing changed: no commit.
    expect(once("ark", "--once").code).toBe(0);
    expect(commits(project)).toBe(1);
    expect(git(project, "status", "--porcelain").out).toBe("");

    // 3. A changed ticket is exactly one new commit holding only the ticket.
    setTicket(project, "in_progress");
    expect(once("ark", "--once").code).toBe(0);
    expect(commits(project)).toBe(2);
    expect(lastFiles(project)).toEqual(["tickets/ARK-1.md"]);
    expect(subject(project)).toContain("autocommit");
    const diff = git(project, "show", "--format=", "HEAD", "--", "tickets/ARK-1.md").out;
    expect(diff).toContain("-status: todo");
    expect(diff).toContain("+status: in_progress");
    expect(once("ark", "--once").code).toBe(0);
    expect(commits(project)).toBe(2);

    // 4. The three files commit together; new files in ignored folders and the job's own log do not.
    writeFileSync(join(project, "ROADMAP.md"), "# ark roadmap\n- changed\n");
    writeFileSync(join(project, "ark.yml"), "name: ark\nchanged: true\n");
    writeFileSync(join(project, "learnings.md"), "# ark learnings\n- changed\n");
    for (const directory of ignoredDirectories)
      writeFileSync(join(project, directory, "new.txt"), "ignored\n");
    writeFileSync(join(project, "services", "project-autocommit.log"), "a line\n");
    expect(once("ark", "--once").code).toBe(0);
    expect(commits(project)).toBe(3);
    expect(lastFiles(project)).toEqual(["ROADMAP.md", "ark.yml", "learnings.md"]);
    expect(git(project, "status", "--porcelain").out).toBe("");

    // 5. A user .gitignore stays byte for byte; the ticket change is committed.
    const userIgnore = "runs/\nservices/\ntest-cache/\nqe/\nprototypes/\nmine/\n";
    writeFileSync(join(project, ".gitignore"), userIgnore);
    setTicket(project, "review");
    expect(once("ark", "--once").code).toBe(0);
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toBe(userIgnore);
    expect(commits(project)).toBe(4);
    expect(git(project, "show", "--format=", "HEAD", "--", "tickets/ARK-1.md").out).toContain(
      "+status: review",
    );

    // 6. With a remote and an upstream, every push form would land a ref: none lands.
    const origin = join(scratch, "origin.git");
    expect(
      Bun.spawnSync(["git", "init", "-q", "--bare", "--initial-branch=main", origin]).exitCode,
    ).toBe(0);
    git(project, "remote", "add", "origin", origin);
    git(project, "config", "branch.main.remote", "origin");
    git(project, "config", "branch.main.merge", "refs/heads/main");
    setTicket(project, "done");
    expect(once("ark", "--once").code).toBe(0);
    expect(commits(project)).toBe(5);
    expect(git(origin, "for-each-ref").out).toBe("");

    // 7. A held lock: --once exits 1 with the git error, commits nothing and leaves the lock alone.
    setTicket(project, "blocked");
    const held = await holdLock(project);
    const failed = once("ark", "--once");
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("index.lock");
    expect(commits(project)).toBe(5);
    expect(readFileSync(held.lock, "utf8").trim()).toBe(String(held.pid));
    held.release();
    expect(once("ark", "--once").code).toBe(0);
    expect(commits(project)).toBe(6);

    // 8. The loop survives the held lock, logs it, and commits on later passes. A fake `sleep` on PATH stops the loop
    // between passes and reports its argument on stderr (the interval), so each pass is observed with no wall-clock wait.
    setTicket(project, "todo");
    const loopHeld = await holdLock(project);
    const fakeBin = join(scratch, "bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "sleep"), '#!/bin/sh\necho "sleep $1" >&2\nread go\n');
    chmodSync(join(fakeBin, "sleep"), 0o755);
    const loopProcess = Bun.spawn(["bash", script, scratch, "1"], {
      env: { ...environment("ark"), PATH: `${fakeBin}:${process.env.PATH}` },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    loop = loopProcess;
    const reader = loopProcess.stderr.getReader();
    let logged = "";
    /** Reads the loop's stderr until its next call of `sleep`, and returns what the pass wrote before it. */
    const untilSleep = async () => {
      const start = logged.length;
      while (!logged.slice(start).includes("sleep 1\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`the loop ended: ${logged}`);
        logged += new TextDecoder().decode(chunk.value);
      }
      return logged.slice(start);
    };
    const nextPass = async () => {
      await loopProcess.stdin.write("go\n");
      await loopProcess.stdin.flush();
      return untilSleep();
    };
    // Pass 1 fails on the lock, logs it, and the loop goes on to sleep the interval.
    expect(await untilSleep()).toContain("autocommit failed");
    expect(loopProcess.exitCode).toBeNull();
    expect(commits(project)).toBe(6);
    expect(readFileSync(loopHeld.lock, "utf8").trim()).toBe(String(loopHeld.pid));
    // Once the lock is gone the next pass commits the ticket.
    loopHeld.release();
    expect(await nextPass()).not.toContain("autocommit failed");
    expect(commits(project)).toBe(7);
    expect(lastFiles(project)).toEqual(["tickets/ARK-1.md"]);
    // A pass with no change makes no empty commit.
    await nextPass();
    expect(commits(project)).toBe(7);
    // The same process commits a later change.
    writeFileSync(join(project, "learnings.md"), "# ark learnings\n- from the loop\n");
    await nextPass();
    expect(commits(project)).toBe(8);
    expect(lastFiles(project)).toEqual(["learnings.md"]);
    expect(loopProcess.exitCode).toBeNull();
    loopProcess.kill();
    await loopProcess.exited;

    // 9. Two passes at the same moment: one commit, a sound repository, no lock left behind.
    setTicket(project, "in_progress");
    const copies = [1, 2].map(() =>
      Bun.spawn(["bash", script, scratch, "1", "--once"], {
        env: environment("ark"),
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    for (const code of await Promise.all(copies.map((copy) => copy.exited)))
      expect([0, 1]).toContain(code);
    expect(commits(project)).toBe(9);
    expect(git(project, "fsck").code).toBe(0);
    expect(existsSync(join(project, ".git", "index.lock"))).toBe(false);

    // 10. Another project commits in its own repository only.
    const arkCommits = commits(project);
    expect(once("other", "--once").code).toBe(0);
    expect(commits(other)).toBe(1);
    expect(lastFiles(other)).toContain("tickets/ARK-1.md");
    expect(commits(project)).toBe(arkCommits);
    expect(commits(parent)).toBe(parentCommits);

    // 11. A project with no folder: exit 1 naming it, nothing created.
    const missing = once("missing", "--once");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("missing");
    expect(existsSync(projectDirectory("missing"))).toBe(false);

    // 12. An empty or unset ARK_PROJECT exits 1 at once, loop or not, and never inits `projects/`.
    for (const name of ["", undefined]) {
      for (const extra of [["--once"], []]) {
        const bad = once(name, ...extra);
        expect(bad.code).toBe(1);
        expect(bad.err).toContain("ARK_PROJECT");
      }
    }
    expect(existsSync(join(arkHome, "projects", ".git"))).toBe(false);
    expect(existsSync(join(project, ".git"))).toBe(true);
    expect(existsSync(join(other, ".git"))).toBe(true);
    expect(commits(project)).toBe(arkCommits);
    expect(commits(other)).toBe(1);
    expect(commits(parent)).toBe(parentCommits);
  } finally {
    loop?.kill();
    for (const holder of holders) holder.kill();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
