import { expect, test } from "bun:test";
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

const repositoryRoot = join(import.meta.dir, "..");
const packageConfiguration = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
};
const ciWorkflow = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
const ciCommands = [...ciWorkflow.matchAll(/^      - run: (.+)$/gm)].map((match) => match[1]);
const expectedCiCommands = [
  "bun install --frozen-lockfile",
  "bun run typecheck",
  "bun run lint",
  "bun run format:check",
  "bun test",
];
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

function executeCiSequence(projectDirectory: string): {
  failedCommand: string | null;
  output: string;
} {
  let output = "";
  for (const commandLine of ciCommands) {
    if (commandLine === "bun install --frozen-lockfile") continue;
    const [command, ...arguments_] = commandLine.split(" ");
    const result = runCommand(projectDirectory, command, arguments_);
    output += `${commandLine}\n${result.output}`;
    if (result.code !== 0) return { failedCommand: commandLine, output };
  }
  return { failedCommand: null, output };
}

test("ARK-175-AC1 TypeScript 7 checks the repository and rejects nested type errors", () => {
  const version = runCommand(repositoryRoot, "./node_modules/.bin/tsc", ["--version"]);
  expect(version.code).toBe(0);
  expect(version.output).toMatch(/Version 7\./);
  expect(runCommand(repositoryRoot, "bun", ["run", "typecheck"]).code).toBe(0);

  const projectDirectory = temporaryDirectory();
  try {
    createToolingProject(projectDirectory);
    writeProjectFile(
      projectDirectory,
      "src/nested/type-error.ts",
      'export const invalid: number = "not a number";\n',
    );
    const result = runCommand(projectDirectory, "bun", ["run", "typecheck"]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("type-error.ts");
  } finally {
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("ARK-175-AC2 type-aware lint rejects and then accepts a handled floating promise", () => {
  expect(runCommand(repositoryRoot, "bun", ["run", "lint"]).code).toBe(0);
  const projectDirectory = temporaryDirectory();
  try {
    createToolingProject(projectDirectory);
    const sourcePath = "src/nested/promise.ts";
    writeProjectFile(
      projectDirectory,
      sourcePath,
      "export function broken(): void { Promise.resolve(1); }\n",
    );
    const rejected = runCommand(projectDirectory, "bun", ["run", "lint"]);
    expect(rejected.code).not.toBe(0);
    expect(rejected.output).toContain("no-floating-promises");
    expect(rejected.output).toContain(sourcePath);

    writeProjectFile(
      projectDirectory,
      sourcePath,
      "export async function handled(): Promise<void> { await Promise.resolve(1); }\n",
    );
    const repaired = runCommand(projectDirectory, "bun", ["run", "lint"]);
    if (repaired.code !== 0) throw new Error(repaired.output);
  } finally {
    rmSync(projectDirectory, { recursive: true, force: true });
  }
}, 120_000);

test("ARK-175-AC3 formatter rejects source and document drift and fixes both", () => {
  expect(runCommand(repositoryRoot, "bun", ["run", "format:check"]).code).toBe(0);
  const projectDirectory = temporaryDirectory();
  try {
    createToolingProject(projectDirectory);
    writeProjectFile(projectDirectory, "src/nested/drift.ts", "export const drift={value:1};\n");
    writeProjectFile(
      projectDirectory,
      "notes.md",
      "# Notes\n\n| name |value|\n|---|---|\n|one|two|\n",
    );
    const rejected = runCommand(projectDirectory, "bun", ["run", "format:check"]);
    expect(rejected.code).not.toBe(0);
    expect(rejected.output).toContain("drift.ts");
    expect(rejected.output).toContain("notes.md");

    expect(runCommand(projectDirectory, "bun", ["run", "format"]).code).toBe(0);
    expect(runCommand(projectDirectory, "bun", ["run", "format:check"]).code).toBe(0);
  } finally {
    rmSync(projectDirectory, { recursive: true, force: true });
  }
});

test("ARK-175-AC4 CI command sequence blocks each failed check", () => {
  expect(ciCommands).toEqual(expectedCiCommands);
  const defectCases = [
    {
      filePath: "src/nested/type-error.ts",
      contents: 'export const invalid: number = "no";\n',
      failingCheck: "bun run typecheck",
    },
    {
      filePath: "src/nested/promise.ts",
      contents: "export function broken(): void { Promise.resolve(1); }\n",
      failingCheck: "bun run lint",
    },
    {
      filePath: "src/nested/drift.ts",
      contents: "export const drift={value:1};\n",
      failingCheck: "bun run format:check",
    },
    {
      filePath: "test/smoke.test.ts",
      contents:
        'import { expect, test } from "bun:test";\ntest("failure", () => expect(1).toBe(2));\n',
      failingCheck: "bun test",
    },
  ];
  for (const defectCase of defectCases) {
    const projectDirectory = temporaryDirectory();
    try {
      createToolingProject(projectDirectory);
      const valid = executeCiSequence(projectDirectory);
      if (valid.failedCommand !== null) throw new Error(valid.output);

      writeProjectFile(projectDirectory, defectCase.filePath, defectCase.contents);
      const rejected = executeCiSequence(projectDirectory);
      expect(rejected.failedCommand).toBe(defectCase.failingCheck);
      expect(rejected.output).toContain(defectCase.failingCheck);
    } finally {
      rmSync(projectDirectory, { recursive: true, force: true });
    }
  }
}, 120_000);

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
