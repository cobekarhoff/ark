import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isHubName } from "../cli/proxy.ts";
import { outcomes, phases } from "../cli/lifecycle.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const playbookDirectory = join(import.meta.dir, "../skills/ark/playbooks");
const runLeadPlaybook = readFileSync(join(playbookDirectory, "run-lead.md"), "utf8");
const workerPlaybookText = readFileSync(join(playbookDirectory, "worker.md"), "utf8");

test("ARK-187-AC3 every literal `ark run close <run> <outcome>` in the playbooks uses a known outcome", () => {
  const closes: { file: string; outcome: string }[] = [];
  for (const file of readdirSync(playbookDirectory).filter((name) => name.endsWith(".md"))) {
    const text = readFileSync(join(playbookDirectory, file), "utf8");
    for (const [, outcome] of text.matchAll(/ark run close <run> ([a-z_]+)/g))
      closes.push({ file, outcome });
  }
  expect(closes.filter(({ file }) => file === "run-lead.md").length).toBeGreaterThan(0);
  for (const { file, outcome } of closes) {
    expect({ file, known: (outcomes as readonly string[]).includes(outcome) }).toEqual({
      file,
      known: true,
    });
  }
});

test("ARK-T86 every phase the docs and playbooks name is one the reducer emits", () => {
  const root = join(import.meta.dir, "..");
  const files = [
    "CONTEXT.md",
    "README.md",
    "docs/explanation/architecture.md",
    "docs/reference/cli.md",
    ...readdirSync(playbookDirectory).map((name) => `skills/ark/playbooks/${name}`),
  ].filter((file) => file.endsWith(".md") && existsSync(join(root, file)));
  const named: { file: string; phase: string }[] = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
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

test("ARK-286-AC6 package.json defines the typecheck, lint and format:check scripts", () => {
  const { scripts } = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
  for (const name of ["typecheck", "lint", "format:check"]) expect(scripts[name]).toBeTruthy();
});
test("ARK-289-AC5 changed playbooks and tests pass oxfmt --check", () => {
  const root = join(import.meta.dir, "..");
  const files = [
    "skills/ark/playbooks/brainstorm.md",
    "skills/ark/playbooks/chief.md",
    "test/playbooks.test.ts",
    "test/brainstorm.test.ts",
    "docs/evidence/ARK-289-ac6.md",
  ].filter((file) => existsSync(join(root, file)));
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

test("ARK-299-AC3 every portless, orca tab create and ark ui command in run-lead.md and worker.md has a form the CLI accepts", () => {
  expect(commandProblems(runLeadPlaybook)).toEqual([]);
  expect(commandProblems(workerPlaybookText)).toEqual([]);
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
  const commands = [...quotedCommands(runLeadPlaybook), ...quotedCommands(workerPlaybookText)];
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
  const skillDirectory = join(import.meta.dir, "../skills/ark");
  const slug = (heading: string) =>
    heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replace(/ /g, "-");
  const principles = readFileSync(join(skillDirectory, "principles.md"), "utf8");
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
