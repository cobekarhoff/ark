import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const repositoryRoot = join(import.meta.dir, "..");

test("ARK-T413 no tracked repo file points to the deleted personal skill folder of the old brainstorm skill", () => {
  // The path is built here so that this file does not match its own search. The repo's own skill of the
  // same name (skills/ark-brainstorm/) is not the personal skill, so only the personal path is searched.
  const personalSkillPath = [".agents", "skills", ["ark", "brainstorm"].join("-")].join("/");
  const search = Bun.spawnSync(["git", "grep", "-l", "--fixed-strings", personalSkillPath], {
    cwd: repositoryRoot,
  });
  expect(search.stderr.toString()).toBe("");
  expect(search.stdout.toString()).toBe("");
  expect(search.exitCode).toBe(1);
});
