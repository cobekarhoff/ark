import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ArkError, yamlQuoteHint } from "./errors.ts";
import { discoverRepos } from "./workspace.ts";

export const caseLevels = ["unit", "integration", "e2e"];
export const caseStatuses = ["active", "retired"];
const fields = ["id", "title", "level", "technique", "priority", "risk", "status", "changed_by"];
const sections = [
  "Objective",
  "Preconditions",
  "Steps",
  "Expected results",
  "Screenshot checkpoints",
];

export type CaseEntry = { id: string; level: string; status: string };

/**
 * Reads `test/cases/*.md` of the repo at `root`. An absent folder is valid and gives no entries.
 * `label` is the path shown in `problems` ("test/cases" or "<repo>/test/cases").
 */
export function readCaseEntries(
  root: string,
  label = "test/cases",
): { entries: CaseEntry[]; problems: string[] } {
  const directory = join(root, "test", "cases");
  const entries: CaseEntry[] = [];
  const problems: string[] = [];
  if (!existsSync(directory)) return { entries, problems };
  for (const name of readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .sort()) {
    const shown = `${label}/${name}`;
    const text = readFileSync(join(directory, name), "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    let front: Record<string, unknown> = {};
    try {
      front = match ? ((Bun.YAML.parse(match[1]) ?? {}) as Record<string, unknown>) : {};
    } catch (err) {
      problems.push(
        `${shown} has frontmatter that is not valid YAML: ${(err as Error).message} (${yamlQuoteHint})`,
      );
      continue;
    }
    if (!match) {
      problems.push(`${shown} has no frontmatter between --- lines`);
      continue;
    }
    const value = (key: string) =>
      typeof front[key] === "string" || typeof front[key] === "number"
        ? String(front[key]).trim()
        : "";
    for (const field of fields)
      if (!value(field)) problems.push(`${shown} lacks the field "${field}"`);
    for (const section of sections)
      if (!new RegExp(`^##\\s+${section}\\s*$`, "m").test(match[2]))
        problems.push(`${shown} lacks the section "${section}"`);
    if (value("level") && !caseLevels.includes(value("level")))
      problems.push(`${shown} has level "${value("level")}": use unit, integration or e2e`);
    if (value("status") && !caseStatuses.includes(value("status")))
      problems.push(`${shown} has status "${value("status")}": use active or retired`);
    if (value("status") === "retired" && !value("retired_reason"))
      problems.push(`${shown} lacks the field "retired_reason"`);
    if (value("id") && name !== `${value("id")}.md`)
      problems.push(`${shown} has the id ${value("id")}: the file name must be ${value("id")}.md`);
    if (value("id") && value("title") && !value("title").startsWith(value("id")))
      problems.push(`${shown} has a title that does not start with its id ${value("id")}`);
    entries.push({
      id: value("id"),
      level: value("level"),
      status: value("status"),
    });
  }
  return { entries, problems };
}

/** Entries of every repo of the workspace at `workspace`. Problems name the repo path unless the repo is ".". */
export function readWorkspaceCases(workspace: string): {
  entries: CaseEntry[];
  problems: string[];
} {
  const all = { entries: [] as CaseEntry[], problems: [] as string[] };
  for (const repo of discoverRepos(workspace)) {
    const read = readCaseEntries(
      join(workspace, repo),
      repo === "." ? "test/cases" : `${repo}/test/cases`,
    );
    all.entries.push(...read.entries);
    all.problems.push(...read.problems);
  }
  return all;
}

const template = (id: string) => `---
id: ${id}
title: ${id} <what the case proves>
level: integration
technique: <for example boundary values, equivalence classes, state transition>
priority: medium
risk: <the defect this case catches>
status: active
changed_by: <run id or name>
---

## Objective

## Preconditions

## Steps

## Expected results

## Screenshot checkpoints
`;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new ArkError("ark test-case new must run in a git repo");
  return result.stdout.toString().trim();
}

/** Runs `action` holding a mkdir lock in the git dir, which git status never shows. A lock older than 30s is dead. */
function withLock<T>(lock: string, action: () => T): T {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true });
      } catch {
        // The holder released it between the checks: try again.
      }
      if (Date.now() > deadline) throw new ArkError(`could not take the lock ${lock}`);
      Bun.sleepSync(10);
    }
  }
  try {
    return action();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function testCaseNew(key: string): void {
  if (!/^[A-Z][A-Z0-9]*$/.test(key))
    throw new ArkError(`test case key "${key}" must be capital letters and digits, such as ARK`);
  const root = git(process.cwd(), "rev-parse", "--show-toplevel");
  const lock = join(
    git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    "ark-test-case.lock",
  );
  const counter = join(dirname(lock), `ark-test-case-${key}.counter`);
  const directory = join(root, "test", "cases");
  const pattern = new RegExp(`^${key}-T(\\d+)\\.md$`);
  const id = withLock(lock, () => {
    mkdirSync(directory, { recursive: true });
    // The last fetched origin target branch; no origin or ref counts as no entries.
    const originHead = Bun.spawnSync([
      "git",
      "-C",
      root,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const onTarget =
      originHead.exitCode === 0
        ? Bun.spawnSync([
            "git",
            "-C",
            root,
            "ls-tree",
            "--name-only",
            originHead.stdout.toString().trim(),
            "test/cases/",
          ])
        : undefined;
    const targetNames =
      onTarget?.exitCode === 0
        ? onTarget.stdout
            .toString()
            .split("\n")
            .map((path) => path.replace(/^test\/cases\//, ""))
        : [];
    const highest = Math.max(
      0,
      Number(existsSync(counter) ? readFileSync(counter, "utf8") : 0) || 0,
      ...[...readdirSync(directory), ...targetNames].map((name) =>
        Number(name.match(pattern)?.[1] ?? 0),
      ),
    );
    const next = `${key}-T${highest + 1}`;
    writeFileSync(counter, String(highest + 1));
    writeFileSync(join(directory, `${next}.md`), template(next), {
      flag: "wx",
    });
    return next;
  });
  console.log(id);
  console.error(`wrote test/cases/${id}.md`);
}
