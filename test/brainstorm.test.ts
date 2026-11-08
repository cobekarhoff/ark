import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const repositoryRoot = join(import.meta.dir, "..");

test("ARK-182-AC3 no tracked repo file points to the personal skill", () => {
  // The name is built here so that this file does not match its own search.
  const personalSkillName = ["ark", "brainstorm"].join("-");
  const search = Bun.spawnSync(["git", "grep", "-l", "--fixed-strings", personalSkillName], {
    cwd: repositoryRoot,
  });
  expect(search.stderr.toString()).toBe("");
  expect(search.stdout.toString()).toBe("");
  expect(search.exitCode).toBe(1);
});
