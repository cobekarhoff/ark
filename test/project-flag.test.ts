import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const repositoryRoot = join(import.meta.dir, "..");
const config = () => ({
  workspace: tempGitRepo(),
  ticket_source: "local",
  suites: [
    { name: "cli", level: "integration", repo: ".", command: "bun test {report}", parser: "bun" },
  ],
  roles: {
    implementer: { harness: "omp", model: "task" },
    evaluator: { harness: "omp", model: "validate" },
    validator: { harness: "omp", model: "validate" },
    reviewer: { harness: "omp", model: "validate" },
  },
});

/** Every run-id command with the arguments it needs, without --project. */
const runIdCommands: string[][] = [
  ["run", "step", "RUN", "implement", "start"],
  ["run", "close", "RUN", "abandoned"],
  ["evaluation", "record", "RUN"],
  ["strategy", "record", "RUN"],
  ["plan", "check", "RUN"],
  ["worktree", "create", "RUN"],
  ["test", "RUN"],
  ["gate", "record", "RUN", "criteria", "accept"],
  ["escalate", "RUN", "--reason", "stuck"],
  ["merge-request", "open", "RUN"],
  ["merge-request", "status", "RUN"],
  ["worktree", "sync", "RUN"],
  ["workspace", "sync", "RUN"],
  ["status", "RUN"],
  ["retro", "RUN"],
];
const withRun = (command: string[], run: string, ...extra: string[]) => [
  ...command.map((word) => (word === "RUN" ? run : word)),
  ...extra,
];

let runId: string;

beforeEach(() => {
  tempArkHome();
  writeProject("ark", config());
  writeProject("other", config());
  // Same ticket, same day: both projects get the same run id.
  const ticket = (project: string) =>
    writeTicket(project, "ARK-209", [{ id: "ARK-209-AC1", text: "observable" }]);
  runId = ark("run", "start", ticket("ark")).out.trim();
  expect(ark("run", "start", ticket("other")).out.trim()).toBe(runId);
});

test("ARK-209-AC2 evaluation record --project ark succeeds when another project's ark.yml is invalid", () => {
  const home = process.env.ARK_HOME as string;
  writeFileSync(
    join(home, "projects/ark/runs", runId, "evaluation.md"),
    "## Blockers\n\n## Risks\n\n## Surfaces\n\n- none\n",
  );
  writeFileSync(join(home, "projects/other/ark.yml"), "suites: [this is: not valid");
  const result = ark("evaluation", "record", runId, "--project", "ark");
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  const events = readFileSync(join(home, "projects/ark/runs", runId, "events.ndjson"), "utf8");
  expect(events).toContain("evaluation.recorded");
});

test("ARK-209-AC1 every run-id command with --project reads the run in that project, not several", () => {
  for (const command of runIdCommands) {
    // Control: the run id exists in both projects, so the plain command is ambiguous.
    const plain = ark(...withRun(command, runId));
    expect(plain.err, command.join(" ")).toContain("exists in several projects");
    const scoped = ark(...withRun(command, runId, "--project", "ark"));
    expect(scoped.err, command.join(" ")).not.toContain("unknown flag");
    expect(scoped.err, command.join(" ")).not.toContain("several projects");
    expect(scoped.err, command.join(" ")).not.toContain("run not found");
  }
});

test("ARK-209-AC1 --project with an unknown project or a project without the run exits 1", () => {
  // other lacks this run: a different id that exists only in ark.
  const home = process.env.ARK_HOME as string;
  const lone = "2026-01-01-LONE-1";
  for (const dir of [join(home, "projects/ark/runs", lone)]) {
    Bun.spawnSync(["cp", "-R", join(home, "projects/ark/runs", runId), dir]);
  }
  for (const command of runIdCommands) {
    const label = command.join(" ");
    const unknown = ark(...withRun(command, lone, "--project", "nope"));
    expect(unknown.code, label).toBe(1);
    expect(unknown.err, label).toContain("project nope does not exist");
    const wrong = ark(...withRun(command, lone, "--project", "other"));
    expect(wrong.code, label).toBe(1);
    expect(wrong.err, label).toContain(`run not found in project other: ${lone}`);
  }
});

test("ARK-T86 --help lists --project for each run-id command", () => {
  const help = ark("--help").out.split("\n");
  for (const command of runIdCommands) {
    const prefix = command.slice(0, command.indexOf("RUN")).join(" ");
    const line = help.find(
      (candidate) => candidate.trim().startsWith(`${prefix} `) && /<run>/.test(candidate),
    );
    expect(line, prefix).toBeDefined();
    expect(line, prefix).toContain("[--project <name>]");
  }
});

test("ARK-T88 ark run step --help names --not-started and not_started", () => {
  const help = Bun.spawnSync(["bun", join(repositoryRoot, "cli/ark.ts"), "run", "step", "--help"], {
    cwd: repositoryRoot,
  }).stdout.toString();
  expect(help).toContain("--not-started");
  expect(help).toContain("not_started");
});

test("ARK-T89 status and merge-request open help describe the test head line and the refusal", () => {
  const help = (...args: string[]) =>
    Bun.spawnSync(["bun", join(repositoryRoot, "cli/ark.ts"), ...args, "--help"], {
      cwd: repositoryRoot,
    }).stdout.toString();
  const status = help("status");
  expect(status).toContain("test head: current");
  expect(status).toContain("test head: stale (<repo> tested <8 characters>, now <8 characters>)");
  const open = help("merge-request", "open");
  expect(open).toContain("refuses");
  expect(open).toContain("run ark test <run> again");
});
