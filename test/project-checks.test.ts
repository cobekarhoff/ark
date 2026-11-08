import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const repositoryRoot = join(import.meta.dir, "..");

test("ARK-302-AC10 docs/reference/cli.md equals the output of bun scripts/cli-reference.ts", () => {
  const path = join(repositoryRoot, "docs/reference/cli.md");
  const committed = readFileSync(path, "utf8");
  const generated = Bun.spawnSync(["bun", "scripts/cli-reference.ts"], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(generated.exitCode).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(committed);
});
