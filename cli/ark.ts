#!/usr/bin/env bun
import { ArkError } from "./errors.ts";
import { evaluationRecord } from "./evaluation.ts";
import { gateRecord } from "./gate.ts";
import { mergeRequestOpen, mergeRequestStatus } from "./merge-request.ts";
import { planCheck } from "./plan.ts";
import { retro } from "./retro.ts";
import { runClose, runStart, runStep, status } from "./run.ts";
import { strategyRecord } from "./strategy.ts";
import { testRun } from "./test-run.ts";
import { ui, uiInstall, uiUninstall } from "./ui.ts";
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
    run: ([runId, stepId, action], flags) =>
      runStep(runId, stepId, action, flags["--failed"] === true),
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
    usage: "evaluation record <run>",
    description:
      "Reads evaluation.md in the run folder and records its blockers, risks and surfaces (web_ui, cli_output, document or none). It refuses a missing file, a file with no Blockers, Risks or Surfaces list, an unknown surface, and a project whose ark.yml has no roles.evaluator. Blockers open the criteria gate; no blockers send the run to planning.",
    flags: {},
    minimum: 1,
    maximum: 1,
    run: ([runId]) => evaluationRecord(runId),
  },
  {
    usage: "strategy record <run>",
    description:
      "Reads strategies.md in the run folder and records its strategy cards: the count, the recommended card and the card IDs. It refuses a missing file, a card with no approach, interfaces or tradeoffs, a mockup link to a file that is not in the run folder, a run with no evaluation record, one card with no reason, and, when the evaluation lists a surface other than none, a card with no mockup link or a project whose ark.yml has no roles.designer. Two or more cards open the strategy gate; one card opens no gate.",
    flags: {},
    minimum: 1,
    maximum: 1,
    run: ([runId]) => strategyRecord(runId),
  },
  {
    usage: "plan check <run>",
    description:
      "Checks plan.yml in the run folder and renders plan.md. It prints one line for each problem and exits 1 when the plan is invalid. A plan with no summary is invalid, and so is a decision with fewer than 2 or more than 4 options. It refuses a run with no strategy record or with an open strategy gate. It records the number of open decisions.",
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
      "Records your answer to a gate. The gates are criteria, strategy, plan and escalation. The strategy gate takes the ID of a card in the latest strategy record, or abort. Ark refuses an answer that the run's state does not allow, and refuses plan approve while the plan has an open decision.",
    flags: { "--note": true },
    minimum: 3,
    maximum: 3,
    run: ([runId, gate, answer], flags) =>
      gateRecord(runId, gate, answer, flags["--note"] as string | undefined),
  },
  {
    usage: "merge-request open <run>",
    description:
      "Pushes each repo's branch and opens one MR for each repo, in dependency order. No command merges.",
    flags: {},
    minimum: 1,
    maximum: 1,
    run: ([runId]) => mergeRequestOpen(runId),
  },
  {
    usage: "merge-request status <run>",
    description:
      "Prints each MR of the run as merged, open or closed, read from gh or glab. It changes nothing.",
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
    description:
      "Computes the run's cost, time, rework and intervention metrics and writes metrics.json.",
    flags: {},
    minimum: 1,
    maximum: 1,
    run: ([runId]) => retro(runId),
  },
  {
    usage: "ui [--port <number>]",
    description:
      "Serves the hub on 127.0.0.1, port 4317 unless --port says otherwise. The page is a React app that Bun bundles. The server reads Ark's files every second and Orca and Plannotator every 3 seconds, each with a hard timeout, and pushes changes over Server-Sent Events. Home shows what needs you (oldest first), live runs, Master Chief per project and the agents. Keys: j/k move, Enter opens, an item's action key runs its action, Cmd-K opens the palette, ? the shortcut sheet, z focus mode, Esc closes. A view bar switches views (keys 1 Home, 2 Map, 3 Timeline). Map: a graph of project, Master Chief, run, step, agent and MR with a needs-you badge on each node that waits for you; click a node or badge, or press j/k, to light its path; v turns dimming of the other nodes on or off; [ and ] step the replay to the previous or next event since your last visit and l returns to live; Map shares its selection with Home. Timeline: one lane for each Master Chief, run and standalone agent; w cycles the window 12h, 24h, 1h; b shows the cost burn, where a bucket with no provider cost shows ?; a click on a waiting gate block runs the action of its item; Timeline keeps its own selection. Time with no history shows UNAVAILABLE. Both views stop pulses under prefers-reduced-motion. Endpoints: GET /api/state and /api/events (SSE) feed Home; GET /api/map?at=<ISO time> returns {at, replay:{from?,to,events}, nodes:[{id,kind,label,state,needs_you}], edges:[[from,to]]} with state not_started, unavailable or unknown where nothing is known; GET /api/timeline?hours=1|12|24 returns {hours, lanes:[{id,kind,label,segments:[{kind,from,to|null,item?,state?}],cost:{usd,series:[{at,usd}]}}]} and refuses any other hours with 400. History: the hub appends to $ARK_HOME/hub/history.ndjson, one JSON object a line: collector.started when the hub starts, collector.tick each minute, and state.changed {time,key,state,activity?} when an agent (key agent:<run>:<terminal>), a Master Chief (chief:<project>) or the CI of an MR (ci:<MR url>) changes; a refresh with no change writes nothing, and time before the first start or between the last tick and the next start is unavailable. The only POST actions open an Orca terminal, a Plannotator review or the Inbox, or an MR URL. The server refuses a foreign Origin and any unknown action.",
    flags: { "--port": true },
    minimum: 0,
    maximum: 0,
    run: (_positionals, flags) => ui(Number(flags["--port"] ?? 4317)),
  },
  {
    usage: "ui install [--port <number>]",
    description:
      "Writes the LaunchAgent dev.ark.hub in ~/Library/LaunchAgents and loads it, so the hub starts at login and restarts after a crash (port 4317 unless --port says otherwise). The hub sends a macOS notification for each new Needs-me item through terminal-notifier (or the command in ARK_NOTIFIER), and a click opens the hub at that item. Install refuses, and writes nothing, when terminal-notifier is missing: run brew install terminal-notifier. A second run with the same settings changes nothing; with a new port it rewrites the plist and reloads.",
    flags: { "--port": true },
    minimum: 0,
    maximum: 0,
    run: (_positionals, flags) => uiInstall(Number(flags["--port"] ?? 4317)),
  },
  {
    usage: "ui uninstall",
    description:
      "Unloads and deletes the LaunchAgent dev.ark.hub. It does nothing, and exits 0, when the agent is not installed. The notification history in ~/.ark/hub/notifications.ndjson is kept.",
    flags: {},
    minimum: 0,
    maximum: 0,
    run: () => uiUninstall(),
  },
];

const helpText = ["Usage: ark <command>", ...commands.map((command) => `  ${command.usage}`)].join(
  "\n",
);

const commandWords = (command: Command): string[] =>
  command.usage.split(" ").filter((word) => /^[a-z-]+$/.test(word));

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
