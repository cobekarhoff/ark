import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeCommand } from "./helpers";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const realGit = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["/usr/bin/git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
const out = (cwd: string, ...args: string[]) =>
  realGit(cwd, ...args)
    .stdout.toString()
    .trim();

// Runs in a child bun so the git shim on PATH is the git that `tempGitRepo` finds. The child prints a `marker` git call
// around each step, so the shim log shows which git processes each step started.
const child = `
  import { tempGitRepo } from ${JSON.stringify(join(import.meta.dir, "helpers.ts"))};
  const marker = () => Bun.spawnSync(["git", "marker"]);
  const files = JSON.parse(process.env.FILES!);
  const other = JSON.parse(process.env.OTHER!);
  marker();
  const first = tempGitRepo(files);
  marker();
  const second = tempGitRepo(files);
  marker();
  const third = tempGitRepo(other);
  marker();
  console.log(JSON.stringify({ first, second, third }));
`;

test("ARK-T159 tempGitRepo gives each call an independent, faithful repo from one template per file set and starts no git process after the first build", () => {
  const log = join(mkdtempSync(join(tmpdir(), "ark-shim-log-")), "git.log");
  writeFileSync(log, "");
  const savedPath = process.env.PATH;
  try {
    writeFakeCommand("git", `echo "$*" >> "${log}"\nexec /usr/bin/git "$@"`);
    const unique = `unique ${log}\n`;
    const files = { "a/one.txt": unique };
    const result = Bun.spawnSync(["bun", "-e", child], {
      env: {
        ...process.env,
        FILES: JSON.stringify(files),
        OTHER: JSON.stringify({ "b/two.txt": unique }),
      },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const { first, second, third } = JSON.parse(result.stdout.toString());

    // Git calls between the markers: the first build, the second call, the other file set.
    const segments: string[][] = [];
    for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      if (line === "marker") segments.push([]);
      else segments.at(-1)!.push(line);
    }
    const [build, secondCall, otherBuild] = segments;
    expect(build!.length).toBeGreaterThan(0);
    expect(secondCall).toEqual([]);
    expect(otherBuild!.length).toBeGreaterThan(0);

    expect(second).not.toBe(first);
    for (const repo of [first, second]) {
      expect(existsSync(join(repo, ".git"))).toBe(true);
      expect(readFileSync(join(repo, "a/one.txt"), "utf8")).toBe(unique);
      expect(out(repo, "status", "--porcelain")).toBe("");
    }
    expect(out(first, "rev-parse", "HEAD")).toBe(out(second, "rev-parse", "HEAD"));

    // A commit in one repo does not reach the other.
    const headBefore = out(second, "rev-parse", "HEAD");
    writeFileSync(join(first, "new.txt"), "x");
    expect(realGit(first, "add", "-A").exitCode).toBe(0);
    expect(realGit(first, "commit", "-q", "-m", "more").exitCode).toBe(0);
    const added = out(first, "rev-parse", "HEAD");
    expect(out(second, "rev-parse", "HEAD")).toBe(headBefore);
    expect(realGit(second, "cat-file", "-e", added).exitCode).not.toBe(0);

    // The template is never handed out: moving the first repo leaves the second whole.
    renameSync(first, `${first}-moved`);
    expect(out(second, "status", "--porcelain")).toBe("");

    // Another file set builds its own repo.
    expect(existsSync(join(third, "b/two.txt"))).toBe(true);
    expect(existsSync(join(third, "a/one.txt"))).toBe(false);
  } finally {
    process.env.PATH = savedPath;
  }
});
