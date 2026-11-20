import { expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const repositoryRoot = join(import.meta.dir, "..");
const packageConfiguration = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
};
const fixtureFiles = {
  "src/nested/valid.ts": "export const answer: number = 42;\n",
  "test/smoke.test.ts":
    'import { expect, test } from "bun:test";\ntest("smoke", () => expect(1).toBe(1));\n',
  "README.md": "# Fixture\n\nA small isolated project.\n",
};

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "ark-tooling-"));
}

function writeProjectFile(projectDirectory: string, filePath: string, contents: string): void {
  const destination = join(projectDirectory, filePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function runCommand(
  projectDirectory: string,
  command: string,
  arguments_: string[] = [],
): {
  code: number;
  output: string;
} {
  const result = Bun.spawnSync([command, ...arguments_], {
    cwd: projectDirectory,
    env: { ...process.env },
  });
  return {
    code: result.exitCode ?? 1,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

function createToolingProject(projectDirectory: string): void {
  writeProjectFile(
    projectDirectory,
    "package.json",
    `${JSON.stringify({ name: "tooling-fixture", private: true, type: "module", scripts: packageConfiguration.scripts }, null, 2)}\n`,
  );
  for (const filePath of ["tsconfig.json", ".oxlintrc.json", ".oxfmtrc.json"]) {
    writeProjectFile(
      projectDirectory,
      filePath,
      readFileSync(join(repositoryRoot, filePath), "utf8"),
    );
  }
  writeProjectFile(projectDirectory, ".gitignore", "node_modules/\n");
  for (const [filePath, contents] of Object.entries(fixtureFiles)) {
    writeProjectFile(projectDirectory, filePath, contents);
  }
  symlinkSync(join(repositoryRoot, "node_modules"), join(projectDirectory, "node_modules"), "dir");
}

test("ARK-175-AC4 opt-in pre-commit hook blocks defects and preserves the staged tree", () => {
  const projectDirectory = temporaryDirectory();
  try {
    createToolingProject(projectDirectory);
    const hookPath = join(projectDirectory, ".githooks/pre-commit");
    writeProjectFile(
      projectDirectory,
      ".githooks/pre-commit",
      readFileSync(join(repositoryRoot, ".githooks/pre-commit"), "utf8"),
    );
    chmodSync(hookPath, 0o755);
    writeProjectFile(projectDirectory, ".gitignore", "node_modules/\n");
    const git = (...arguments_: string[]) => runCommand(projectDirectory, "git", arguments_);
    expect(git("init", "-q", "-b", "main").code).toBe(0);
    expect(git("config", "user.name", "Ark Tooling Test").code).toBe(0);
    expect(git("config", "user.email", "ark@example.com").code).toBe(0);
    expect(git("add", "-A").code).toBe(0);
    expect(git("commit", "-q", "-m", "fixture baseline").code).toBe(0);
    expect(git("config", "--local", "core.hooksPath", ".githooks").code).toBe(0);

    writeProjectFile(projectDirectory, "README.md", "# Fixture\n\nA valid committed change.\n");
    expect(git("add", "README.md").code).toBe(0);
    expect(git("commit", "-q", "-m", "valid change").code).toBe(0);

    const defectCases = [
      { filePath: "src/nested/type-error.ts", contents: 'export const invalid: number = "no";\n' },
      {
        filePath: "src/nested/promise.ts",
        contents: "export function broken(): void { Promise.resolve(1); }\n",
      },
      { filePath: "src/nested/drift.ts", contents: "export const drift={value:1};\n" },
      {
        filePath: "test/smoke.test.ts",
        contents:
          'import { expect, test } from "bun:test";\ntest("failure", () => expect(1).toBe(2));\n',
      },
    ];
    for (const defectCase of defectCases) {
      writeProjectFile(projectDirectory, defectCase.filePath, defectCase.contents);
      expect(git("add", defectCase.filePath).code).toBe(0);
      const stagedTreeBeforeCommit = git("write-tree");
      expect(stagedTreeBeforeCommit.code).toBe(0);
      const rejectedCommit = git("commit", "-m", "invalid change");
      expect(rejectedCommit.code).not.toBe(0);
      expect(git("write-tree").output.trim()).toBe(stagedTreeBeforeCommit.output.trim());
      expect(git("reset", "--hard", "HEAD").code).toBe(0);
    }

    expect(git("config", "--local", "--unset", "core.hooksPath").code).toBe(0);
    expect(git("config", "--local", "--get", "core.hooksPath").code).not.toBe(0);
  } finally {
    rmSync(projectDirectory, { recursive: true, force: true });
  }
}, 120_000);

test("ARK-184-AC1 lint config has no file-glob override for no-thenable", () => {
  const configuration = JSON.parse(
    readFileSync(join(repositoryRoot, ".oxlintrc.json"), "utf8"),
  ) as { overrides?: { files: string[]; rules?: Record<string, unknown> }[] };
  const offending = (configuration.overrides ?? []).filter(
    (override) => override.rules && "unicorn/no-thenable" in override.rules,
  );
  expect(offending).toEqual([]);
});
