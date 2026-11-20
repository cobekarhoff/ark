import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isHubName } from "../cli/proxy.ts";
import { outcomes, phases } from "../cli/lifecycle.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const root = join(import.meta.dir, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

const sharedFiles = [
  "skills/shared/rules.md",
  "skills/shared/worker-protocol.md",
  "skills/shared/principles.md",
];
const workerSkillFiles = ["evaluator", "designer", "implementer", "validator", "reviewer"].map(
  (role) => `skills/ark-${role}/SKILL.md`,
);

/**
 * The ten role skills (`skills/ark-<role>/SKILL.md`) and the shared files. Fails when the glob finds
 * fewer than ten skills or a shared file is missing, so a moved folder cannot make a scan vacuous.
 */
function skillAndSharedFiles(): string[] {
  const skills = [...new Bun.Glob("skills/ark-*/SKILL.md").scanSync({ cwd: root })].sort();
  expect(skills.length).toBeGreaterThanOrEqual(10);
  for (const file of sharedFiles) expect(existsSync(join(root, file)), file).toBe(true);
  return [...skills, ...sharedFiles];
}

test("ARK-T410 every literal `ark run close <run> <outcome>` in the skills uses a known outcome", () => {
  const closes: { file: string; outcome: string }[] = [];
  for (const file of skillAndSharedFiles()) {
    for (const [, outcome] of read(file).matchAll(/ark run close <run> ([a-z_]+)/g))
      closes.push({ file, outcome });
  }
  expect(
    closes.filter(({ file }) => file === "skills/ark-run-lead/SKILL.md").length,
  ).toBeGreaterThan(0);
  for (const { file, outcome } of closes) {
    expect({ file, known: (outcomes as readonly string[]).includes(outcome) }).toEqual({
      file,
      known: true,
    });
  }
});

test("ARK-T86 every phase the docs and skills name is one the reducer emits", () => {
  const files = [
    "CONTEXT.md",
    "README.md",
    "docs/explanation/architecture.md",
    "docs/reference/cli.md",
    ...skillAndSharedFiles(),
  ].filter((file) => file.endsWith(".md") && existsSync(join(root, file)));
  const named: { file: string; phase: string }[] = [];
  for (const file of files) {
    const text = read(file);
    for (const [, phase] of text.matchAll(/\bphases? (?:is |are |in |of |to )?`([a-z_]+)`/g))
      named.push({ file, phase });
    const diagram = text.match(/```mermaid\nstateDiagram-v2\n([\s\S]*?)```/)?.[1] ?? "";
    for (const [, from, to] of diagram.matchAll(/^\s+([a-z_]+) --> ([a-z_]+)/gm))
      named.push({ file, phase: from }, { file, phase: to });
  }
  expect(named.filter(({ file }) => file.endsWith("architecture.md")).length).toBeGreaterThan(0);
  const known: readonly string[] = phases;
  for (const { file, phase } of named)
    expect({ file, phase, known: known.includes(phase) }).toEqual({ file, phase, known: true });
});

test("ARK-T411 changed skills and tests pass oxfmt --check", () => {
  const files = [
    "skills/ark-brainstorm/SKILL.md",
    "skills/ark-chief/SKILL.md",
    "test/playbooks.test.ts",
  ];
  for (const file of files) expect(existsSync(join(root, file)), file).toBe(true);
  const result = Bun.spawnSync(["bunx", "oxfmt", "--check", ...files], { cwd: root });
  expect(result.exitCode).toBe(0);
});

/** Every code-block line and inline `command` of a Markdown text. */
const quotedCommands = (text: string): string[] => {
  const blocks = [...text.matchAll(/^[ \t]*```\w*\n([\s\S]*?)^[ \t]*```/gm)];
  const rest = text.replaceAll(/^[ \t]*```\w*\n[\s\S]*?^[ \t]*```/gm, "");
  return [
    ...blocks.flatMap(([, body]) => body.split("\n").map((line) => line.trim())),
    ...[...rest.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span),
  ].filter(Boolean);
};

/** What the CLI would refuse in the portless, orca tab create and ark ui commands of a playbook. */
const commandProblems = (text: string): string[] => {
  const problems: string[] = [];
  if (/\bark route\b/.test(text)) problems.push("quotes ark route");
  for (const command of quotedCommands(text)) {
    if (command.startsWith("portless ")) {
      const appPort = command.match(/^portless [^\s-]\S* --app-port (\S+) [^\s-]/)?.[1];
      const validPort =
        appPort === "<port>" ||
        (/^\d+$/.test(appPort ?? "") && Number(appPort) >= 1 && Number(appPort) <= 65535);
      if (!validPort) problems.push(`portless form: ${command}`);
    }
    if (/^orca tab create(\s|$)/.test(command)) {
      const args = command.slice("orca tab create".length).match(/(?:<[^>]*>|\S)+/g) ?? [];
      const pairs = new Map<string, string>();
      for (let i = 0; i < args.length; i += 2) {
        if (!/^--(url|worktree)$/.test(args[i]) || !args[i + 1] || args[i + 1].startsWith("-"))
          pairs.set("bad", args[i]);
        else pairs.set(args[i], args[i + 1]);
      }
      if (pairs.size !== 2 || !pairs.has("--url") || !pairs.has("--worktree"))
        problems.push(`orca tab create flags: ${command}`);
    }
    const ui = command.match(/\bark ui(?=\s|$).*/)?.[0];
    if (ui) {
      const name = ui.match(/--name (\S+)/)?.[1];
      if (!name || !isHubName(name.replaceAll("<slug>", "ark-1")))
        problems.push(`ark ui --name: ${command}`);
    }
  }
  return problems;
};

test("ARK-T412 every portless, orca tab create and ark ui command in the run-lead skill, the worker skills and the worker protocol has a form the CLI accepts", () => {
  const commandFiles = [
    "skills/ark-run-lead/SKILL.md",
    ...workerSkillFiles,
    "skills/shared/worker-protocol.md",
  ];
  for (const file of commandFiles) expect(commandProblems(read(file)), file).toEqual([]);
  // rejected forms, through the same checker
  for (const bad of [
    "orca tab create --url --worktree",
    "orca tab create -x --url http://a.localhost --worktree current",
    "orca tab create --url http://a.localhost",
    "orca tab create --url http://a.localhost --worktree current --bogus x",
    "portless hub.ark-1 --app-port --bogus bun app.ts",
    "portless hub.ark-1 --app-port 0 bun app.ts",
    "portless hub.ark-1 --app-port 99999 bun app.ts",
    "portless hub.ark-1 --app-port 3000",
  ])
    expect(commandProblems(`\`${bad}\``), bad).toHaveLength(1);
  expect(commandProblems("`orca tab create --worktree path:x --url http://a.localhost`")).toEqual(
    [],
  );
  for (const good of ["1", "65535", "<port>"])
    expect(commandProblems(`\`portless a.proto --app-port ${good} bun app.ts\``), good).toEqual([]);
  // the check sees the commands: not vacuously empty
  const commands = commandFiles.flatMap((file) => quotedCommands(read(file)));
  expect(
    commands.filter((command) => /^portless \S+ --app-port/.test(command)).length,
  ).toBeGreaterThanOrEqual(4);
  expect(
    commands.filter((command) => command.startsWith("orca tab create")).length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    commands.filter((command) => command.includes("ark ui --port")).length,
  ).toBeGreaterThanOrEqual(1);
});

test("ARK-T85 every link in principles.md points to a file and heading that exist", () => {
  const skillDirectory = join(root, "skills/shared");
  const slug = (heading: string) =>
    heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replace(/ /g, "-");
  const principles = read("skills/shared/principles.md");
  const links = [...principles.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    const [path, anchor] = link.split("#");
    const file = join(skillDirectory, path!);
    expect(existsSync(file), `${link}: file missing`).toBe(true);
    if (anchor) {
      const slugs = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /^#{1,6} /.test(line))
        .map((line) => slug(line.replace(/^#+ /, "").trim()));
      expect(slugs, `${link}: heading missing`).toContain(anchor);
    }
  }
});

test("ARK-303-AC8 package.json has typecheck, lint and format:check scripts that do not run bun test", () => {
  const { scripts } = JSON.parse(
    readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
  ) as {
    scripts: Record<string, string>;
  };
  for (const name of ["typecheck", "lint", "format:check"]) {
    expect(scripts[name]).toBeTruthy();
    expect(scripts[name]).not.toContain("bun test");
  }
});
