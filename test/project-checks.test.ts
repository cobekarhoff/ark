import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const repositoryRoot = join(import.meta.dir, "..");

test("ARK-302-AC9 docs show a checks block with format:check, typecheck, lint and cli-reference that diff cli.md", () => {
  const how = readFileSync(join(repositoryRoot, "docs/how-to/project-checks.md"), "utf8");
  const block = how.match(/```yaml\n(checks:\n[\s\S]*?)```/)?.[1];
  expect(block).toBeDefined();
  const checks = Bun.YAML.parse(block!) as {
    checks: { name: string; repo: string; command: string }[];
  };
  expect(checks.checks.map((check) => check.name)).toEqual([
    "format:check",
    "typecheck",
    "lint",
    "cli-reference",
  ]);
  const commands = Object.fromEntries(checks.checks.map((check) => [check.name, check.command]));
  expect(commands["format:check"]).toBe("bun run format:check");
  expect(commands.typecheck).toBe("bun run typecheck");
  expect(commands.lint).toBe("bun run lint");
  // A check must change no file: only the generator plus a diff check.
  expect(commands["cli-reference"]).toBe(
    "bun scripts/cli-reference.ts && git diff --exit-code docs/reference/cli.md",
  );
  for (const check of checks.checks) expect(check.repo).toBe(".");
});

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
