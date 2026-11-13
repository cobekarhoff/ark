#!/usr/bin/env bun
import { ArkError } from "./errors.ts";
import { testRunnerMain } from "./test-run.ts";
import { runCloseCommand, runStartCommand, runStepCommand, statusCommand } from "./commands/run.ts";
import { evaluationRecordCommand } from "./commands/evaluation.ts";
import { criteriaAmendCommand } from "./commands/criteria.ts";
import { strategyRecordCommand } from "./commands/strategy.ts";
import { uiSkillsCommand } from "./commands/ui-skills.ts";
import { planCheckCommand } from "./commands/plan-check.ts";
import {
  workspaceSyncCommand,
  worktreeAnchorCommand,
  worktreeCreateCommand,
  worktreeSyncCommand,
} from "./commands/worktree.ts";
import { testCommand } from "./commands/test.ts";
import { testCaseNewCommand } from "./commands/test-case.ts";
import { testAuditInventoryCommand } from "./commands/test-audit.ts";
import { escalateCommand, gateRecordCommand } from "./commands/gate.ts";
import {
  bumpRefreshCommand,
  mergeRequestOpenCommand,
  mergeRequestStatusCommand,
} from "./commands/merge-request.ts";
import { retroCommand } from "./commands/retro.ts";
import { chiefHandoverCommand, chiefStateCommand } from "./commands/chief.ts";
import { uiCommand, uiInstallCommand, uiUninstallCommand } from "./commands/ui.ts";
import {
  servicesInstallCommand,
  servicesStatusCommand,
  servicesUninstallCommand,
} from "./commands/services.ts";
import type { Command, Flags } from "./commands/types.ts";

// Listed in the order `ark --help` prints them.
const commands: Command[] = [
  runStartCommand,
  runStepCommand,
  runCloseCommand,
  evaluationRecordCommand,
  criteriaAmendCommand,
  strategyRecordCommand,
  uiSkillsCommand,
  planCheckCommand,
  worktreeAnchorCommand,
  worktreeCreateCommand,
  testCommand,
  testCaseNewCommand,
  testAuditInventoryCommand,
  gateRecordCommand,
  escalateCommand,
  mergeRequestOpenCommand,
  mergeRequestStatusCommand,
  bumpRefreshCommand,
  worktreeSyncCommand,
  workspaceSyncCommand,
  statusCommand,
  retroCommand,
  chiefStateCommand,
  chiefHandoverCommand,
  uiCommand,
  uiInstallCommand,
  uiUninstallCommand,
  servicesInstallCommand,
  servicesUninstallCommand,
  servicesStatusCommand,
];

const helpText = ["Usage: ark <command>", ...commands.map((command) => `  ${command.usage}`)].join(
  "\n",
);

const commandWords = (command: Command): string[] =>
  command.usage.split(" ").filter((word) => /^[a-z][a-z-]*$/.test(word));

function parseFlags(command: Command, args: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (!Object.hasOwn(command.flags, arg))
      throw new ArkError(`unknown flag ${arg}\nusage: ark ${command.usage}`);
    if (!command.flags[arg]) {
      flags[arg] = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined)
      throw new ArkError(`${arg} needs a value\nusage: ark ${command.usage}`);
    flags[arg] = value;
  }
  if (positionals.length < command.minimum || positionals.length > command.maximum) {
    throw new ArkError(`wrong number of arguments\nusage: ark ${command.usage}`);
  }
  return { positionals, flags };
}

async function main(args: string[]): Promise<void> {
  // The detached process `ark test` starts; not a command for people, so not in the help.
  if (args[0] === "test-runner") {
    process.exit(
      await testRunnerMain(
        args[1]!,
        args[args.indexOf("--project") + 1]!,
        args.includes("--quick"),
      ),
    );
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(helpText);
    return;
  }
  // The longest match wins, so `ui install` is not read as `ui`.
  const command = commands
    .filter((candidate) => commandWords(candidate).every((word, i) => args[i] === word))
    .sort((left, right) => commandWords(right).length - commandWords(left).length)[0];
  if (!command) {
    console.error(helpText);
    process.exitCode = 1;
    return;
  }
  const rest = args.slice(commandWords(command).length);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`ark ${command.usage}\n\n${command.description}`);
    return;
  }
  const { positionals, flags } = parseFlags(command, rest);
  await command.run(positionals, flags);
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof ArkError)) throw err;
  console.error(`ark: ${err.message}`);
  process.exitCode = 1;
}
