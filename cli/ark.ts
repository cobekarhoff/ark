#!/usr/bin/env bun
import { ArkError } from "./errors.ts";
import { gateRecord } from "./gate.ts";
import { mergeRequestOpen, mergeRequestStatus } from "./merge-request.ts";
import { planCheck } from "./plan.ts";
import { retro } from "./retro.ts";
import { runClose, runStart, runStep, status } from "./run.ts";
import { testRun } from "./test-run.ts";
import { workspaceSync } from "./workspace.ts";
import { worktreeCreate, worktreeSync } from "./worktree.ts";

type Flags = Record<string, string | true>;

type Command = {
  usage: string;
  description: string;
  /** Flags this command accepts. A value of `true` takes a value, `false` is a switch. */
  flags: Record<string, boolean>;
  minimum: number;
  maximum: number;
  run: (positionals: string[], flags: Flags) => void | Promise<void>;
};

// Listed in the order `ark --help` prints them.
const commands: Command[] = [
  {
    usage: "run start <ticket-file> [--project <name>]",
    description:
      "Starts a run from a ticket file. It creates the run folder, copies the ticket and records the first event. It prints the run ID.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([ticketFile], flags) => runStart(ticketFile, flags["--project"] as string | undefined),
  },
  {
    usage: "run step <run> <step> start|finish [--failed]",
    description:
      "Records that a plan step started or finished. Use --failed with finish when the step failed. A step can start only after you approve the plan.",
    flags: { "--failed": false },
    minimum: 3,
    maximum: 3,
    run: ([runId, stepId, action], flags) => runStep(runId, stepId, action, flags["--failed"] === true),
  },
  {
    usage: "run close <run> <outcome>",
    description:
      "Closes a run. The outcome is merged, abandoned, aborted or handed_off. Ark refuses an outcome that does not fit the run, such as merged with no MRs.",
    flags: {},
    minimum: 2,
    maximum: 2,
    run: ([runId, outcome]) => runClose(runId, outcome),
  },
  {
    usage: "plan check <run>",
    description: "Checks plan.yml in the run folder and renders plan.mmd. It prints one line for each problem and exits 1 when the plan is invalid.",
    flags: {},
    minimum: 1,
    maximum: 1,
    run: ([runId]) => planCheck(runId),
  },
  {
    usage: "worktree create <run> [<repo>...]",
    description:
      "Builds the run's workspace mirror. Each named repo, or every repo the plan uses, gets a worktree. Every other path is a symlink to the workspace.",
    flags: {},
    minimum: 1,
    maximum: Infinity,
    run: ([runId, ...repos]) => worktreeCreate(runId, repos),
  },
  {
    usage: "test <run>",
    description:
      "Runs the project's suites on the run's workspace mirror and records which ACs have a passing test. It exits 1 unless every AC passes.",
    flags: {},
    minimum: 1,
    maximum: 1,
    run: ([runId]) => testRun(runId),
  },
  {
    usage: "gate record <run> <gate> <answer> [--note <text>]",
    description:
      "Records your answer to a gate. The gates are criteria, plan and escalation. Ark refuses an answer that the run's state does not allow.",
    flags: { "--note": true },
    minimum: 3,
    maximum: 3,
    run: ([runId, gate, answer], flags) => gateRecord(runId, gate, answer, flags["--note"] as string | undefined),
  },
  {
    usage: "merge-request open <run>",
    description: "Pushes each repo's branch and opens one MR for each repo, in dependency order. No command merges.",
    flags: {},
    minimum: 1,
    maximum: 1,
    run: ([runId]) => mergeRequestOpen(runId),
  },
  {
    usage: "merge-request status <run>",
    description: "Prints each MR of the run as merged, open or closed, read from gh or glab. It changes nothing.",
    flags: {},
    minimum: 1,
    maximum: 1,
    run: ([runId]) => mergeRequestStatus(runId),
  },
  {
    usage: "worktree sync <run>",
    description:
      "Fetches and merges origin's target branch into each worktree of the run, and pushes the branch of each repo that has an MR. On a conflict it undoes the merge, names the repo and exits 1. It never merges an MR.",
    flags: {},
    minimum: 1,
    maximum: 1,
    run: ([runId]) => worktreeSync(runId),
  },
  {
    usage: "workspace sync <run>",
    description:
      "Fetches and fast-forwards the target branch of the workspace checkout of each repo the run touched. It exits 1 and names the repo when git refuses, for example on a conflicting local change. It prints repo, branch and head.",
    flags: {},
    minimum: 1,
    maximum: 1,
    run: ([runId]) => workspaceSync(runId),
  },
  {
    usage: "status [<run>] [--project <name>]",
    description:
      "Prints the state of one run: phase, round, first unfinished step, waiting gate, last test, MRs and cost. Without a run, it lists every open run. --project limits the config check to one project, like ARK_PROJECT.",
    flags: { "--project": true },
    minimum: 0,
    maximum: 1,
    run: ([runId], flags) => status(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "retro <run>",
    description: "Computes the run's cost, time, rework and intervention metrics and writes metrics.json.",
    flags: {},
    minimum: 1,
    maximum: 1,
    run: ([runId]) => retro(runId),
  },
];

const helpText = ["Usage: ark <command>", ...commands.map((command) => `  ${command.usage}`)].join("\n");

const commandWords = (command: Command): string[] => command.usage.split(" ").filter((word) => /^[a-z-]+$/.test(word));

function parseFlags(command: Command, args: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (!Object.hasOwn(command.flags, arg)) throw new ArkError(`unknown flag ${arg}\nusage: ark ${command.usage}`);
    if (!command.flags[arg]) {
      flags[arg] = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined) throw new ArkError(`${arg} needs a value\nusage: ark ${command.usage}`);
    flags[arg] = value;
  }
  if (positionals.length < command.minimum || positionals.length > command.maximum) {
    throw new ArkError(`wrong number of arguments\nusage: ark ${command.usage}`);
  }
  return { positionals, flags };
}

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(helpText);
    return;
  }
  const command = commands.find((candidate) => {
    const words = commandWords(candidate);
    return words.every((word, i) => args[i] === word);
  });
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
