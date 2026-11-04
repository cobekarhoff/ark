#!/usr/bin/env bun
import { chiefHandover, chiefState } from "./chief.ts";
import { ArkError } from "./errors.ts";
import { criteriaAmend } from "./criteria.ts";
import { evaluationRecord } from "./evaluation.ts";
import { escalate, gateRecord } from "./gate.ts";
import { mergeRequestOpen, mergeRequestStatus } from "./merge-request.ts";
import { planCheck } from "./plan.ts";
import { retro } from "./retro.ts";
import { runClose, runCloseSweep, runStart, runStep, status } from "./run.ts";
import { strategyRecord } from "./strategy.ts";
import { testRun } from "./test-run.ts";
import { uiSkills } from "./ui-skills.ts";
import { ui, uiInstall, uiUninstall } from "./ui.ts";
import { workspaceSync } from "./workspace.ts";
import { worktreeAnchor, worktreeCreate, worktreeSync } from "./worktree.ts";

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
    usage:
      "run step <run> <step> start|finish [--failed] [--not-started] [--merge] [--project <name>]",
    description:
      "Records that a plan step started or finished. Use --failed with finish when the step failed. Use --not-started with finish --failed when the worker never ran (worker-start exited non-zero and no worker is running): it records not_started: true on step.finished, takes back the round of that start, and the retro does not count the step. It is a usage error without --failed, and with start or --merge. A step can start only after you approve the plan. Use --merge with start to run an implementer step that fixes a sync conflict: it costs no round, and it needs a failed ark worktree sync for the step repo.",
    flags: { "--failed": false, "--not-started": false, "--merge": false, "--project": true },
    minimum: 3,
    maximum: 3,
    run: ([runId, stepId, action], flags) =>
      runStep(
        runId,
        stepId,
        action,
        flags["--failed"] === true,
        flags["--merge"] === true,
        flags["--not-started"] === true,
        flags["--project"] as string | undefined,
      ),
  },
  {
    usage: "run close [<run> <outcome>] [--sweep] [--project <name>]",
    description:
      "Closes a run. The outcome is merged, abandoned, aborted or handed_off. Ark refuses an outcome that does not fit the run, such as merged with no MRs. For merged it deletes each repo's branch when its MR is merged (or, with no MR, when the branch is in the target branch); when `git fetch` fails and the MR state is unknown it keeps the branch and prints `kept     <repo>  <branch>: <reason>`. After the close it releases the settled Orca workers of the run (Orca Run `Ark run <run>`) and prints one line for each; it prints `<dispatch id> still active, not released` for an active one, and one `orca: workers not released: <reason>` line when Orca fails, and the close still exits 0. `ark run close --sweep [--project <name>]` does the same release for every closed run of the project (ARK_PROJECT when --project is not given), records no event, and prints nothing for a run with nothing to report. --sweep takes no run argument.",
    flags: { "--project": true, "--sweep": false },
    minimum: 0,
    maximum: 2,
    run: (positionals, flags) => {
      const project = flags["--project"] as string | undefined;
      if (flags["--sweep"] === true) {
        if (positionals.length > 0) throw new ArkError("--sweep takes no run argument");
        return runCloseSweep(project);
      }
      if (positionals.length !== 2)
        throw new ArkError(
          "wrong number of arguments\nusage: ark run close [<run> <outcome>] [--sweep] [--project <name>]",
        );
      return runClose(positionals[0], positionals[1], project);
    },
  },
  {
    usage: "evaluation record <run> [--project <name>]",
    description:
      "Reads evaluation.md in the run folder and records its blockers, risks and surfaces (web_ui, cli_output, document or none). It refuses a missing file, a file with no Blockers, Risks or Surfaces list, an unknown surface, and a project whose ark.yml has no roles.evaluator. Blockers open the criteria gate; no blockers send the run to planning.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => evaluationRecord(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "criteria amend <run> <criterion id> <file> [--project <name>]",
    description:
      "Writes the text in <file> as the new text of one criterion in the run's ticket.md (frontmatter and table row) and records criteria.amended with the criterion, the old text and the new text. Use it for an amendment the human approved. It refuses an unknown criterion, an empty file, and a run outside the phases awaiting_strategy and planning. It clears the plan check: run ark plan check again so plan.md lists the amendment before the plan gate.",
    flags: { "--project": true },
    minimum: 3,
    maximum: 3,
    run: ([runId, criterionId, file], flags) =>
      criteriaAmend(runId, criterionId, file, flags["--project"] as string | undefined),
  },
  {
    usage: "strategy record <run> [--project <name>]",
    description:
      "Reads strategies.md in the run folder and records its strategy cards: the count, the recommended card and the card IDs. It refuses a missing file, a card with no approach, interfaces or tradeoffs, a mockup link to a file that is not in the run folder, a run with no evaluation record, one card with no reason, and, when the evaluation lists a surface other than none, a card with no mockup link or no Skills line, a Skills line that names a skill `ark ui-skills <run>` does not list, or a project whose ark.yml has no roles.designer. A mockup, a Skills line and roles.designer are not needed when the surface is only none, or when there is one card and the surface is only document. Two or more cards open the strategy gate; one card opens no gate.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => strategyRecord(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "ui-skills <run> [--project <name>]",
    description:
      "Prints the UI skills of the run, one line for each. When the Surfaces list in the recorded evaluation is not none, it prints the required skills, then one more line for the React skill, which is only for a change that touches React code. When Surfaces is none, it prints none. It exits 1 for a run with no recorded evaluation. The Designer, the implementer, the validator and the reviewer read these skills; strategy record and plan check refuse a Skills line or a skills list that names any other skill.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => uiSkills(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "plan check <run> [--project <name>]",
    description:
      "Checks plan.yml in the run folder and renders plan.md. It prints one line for each problem and exits 1 when the plan is invalid. A plan with no summary is invalid, and so is a summary with no row for an AC of the ticket. A plan with no `design.interfaces` is invalid, and so is an interface with no name or with no `callers`, or with a blank caller. A plan with a cycle, an unknown `needs`, a duplicate step id, an unknown role, or a step with no id, role, repo, harness or model is invalid. A summary with no why, no changes, or a change with no criterion, where, now or fix is invalid. A decision with no id, a duplicate id, no question, an option with no label, or a `recommended` or `chosen` that is not an option, is invalid. A test case with a level other than integration or e2e is invalid. A criterion with no integration or e2e test case is invalid, and so is a test case with an empty list or no expected sentence. A decision with fewer than 2 or more than 4 options is invalid. A step whose harness and model are not the pair of any entry in roles in ark.yml is invalid: the problem names the step, its pair and the allowed pairs. It refuses a run with no strategy record or with an open strategy gate. When the evaluation lists a surface other than none, it also needs a skills list in at least one step, only skills that `ark ui-skills <run>` lists, and every required skill in each non-empty list; plan.md then has a Skills column. A run with no recorded evaluation counts as none. It records the number of open decisions.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => planCheck(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "worktree anchor <run> [--project <name>]",
    description:
      "Makes the run's worktree early, for the first repo of the workspace, with the same branch, `setup` and `worktree.created` event as `worktree create`. It prints one line, `path:<absolute path>`, the folder to start the run lead and its first workers in. A second call prints the same line and records nothing. A later `worktree create` prints `exists` for that repo. If `setup` exits non-zero it removes the worktree and exits 1, as `worktree create` does. It refuses a closed run.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => worktreeAnchor(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "worktree create <run> [<repo>...] [--allow-dirty] [--project <name>]",
    description:
      "Builds the run's workspace mirror. Each named repo, or every repo the plan uses, gets a worktree on the branch `ark/<ticket id>-<slug>`, or on the lowest free `-2`, `-3`, ... suffix when that name exists locally or on origin; `worktree.created` records the branch. Before it adds any worktree it checks every repo that has none yet for uncommitted changes: it prints the changed paths and exits 1, and makes nothing. With `--allow-dirty` it prints the paths as a warning and branches from HEAD without those changes. Every other path is a symlink to the workspace. When `ark.yml` sets `setup`, the command runs it with `sh -c` in each new worktree. If `setup` exits non-zero, the command removes that worktree and its branch, prints the repo, the exit code and the last 10 lines of stderr (of stdout when stderr is empty), and exits 1. If the removal fails, the output names each `left behind` worktree path and branch. It records the worktree only after `setup` passes. A repo folder with a `.git` and no recorded worktree is a stale leftover: the next create removes it, then runs `setup` again.",
    flags: { "--allow-dirty": false, "--project": true },
    minimum: 1,
    maximum: Infinity,
    run: ([runId, ...repos], flags) =>
      worktreeCreate(
        runId,
        repos,
        flags["--project"] as string | undefined,
        flags["--allow-dirty"] === true,
      ),
  },
  {
    usage: "test <run> [--project <name>]",
    description:
      "Runs the project's suites on the run's workspace mirror and records which ACs have a passing test. A criterion with `manual: true` in ticket.md has no test: it shows `manual pending`, `manual ok` or `manual problem` from the manual gate, even when a test is tagged with it. It exits 1 unless every AC is passing or manual ok. `passed` in test.completed counts the automated criteria only, so a manual pending never opens the escalation gate.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => testRun(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "gate record <run> <gate> [<criterion id>] <answer> [--note <text>] [--project <name>]",
    description:
      "Records your answer to a gate. The gates are criteria, strategy, plan, escalation and manual. The strategy gate takes the ID of a card in the latest strategy record, or abort. The manual gate proves one criterion that has `manual: true` in ticket.md: `ark gate record <run> manual <criterion id> ok|problem [--note <text>]` records gate.answered with the field `criterion`; it refuses an ID that is not in the ticket or not manual, and the answer is never automatic. Ark refuses an answer that the run's state does not allow, and refuses plan approve while the plan has an open decision.",
    flags: { "--note": true, "--project": true },
    minimum: 3,
    maximum: 4,
    run: ([runId, gate, ...args], flags) =>
      gateRecord(
        runId,
        gate,
        args,
        flags["--note"] as string | undefined,
        flags["--project"] as string | undefined,
      ),
  },
  {
    usage: "escalate <run> --reason <text> [--project <name>]",
    description:
      "Opens the escalation gate when the round budget is spent, also when the last ark test passed. Use it for an unresolved review P0 or P1. It records escalation.requested with the reason. It refuses a run that is not in phase building, a round budget that is not spent, and an empty reason. Answer the gate with ark gate record.",
    flags: { "--reason": true, "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) =>
      escalate(
        runId,
        flags["--reason"] as string | undefined,
        flags["--project"] as string | undefined,
      ),
  },
  {
    usage: "merge-request open <run> [--project <name>]",
    description:
      "Pushes each repo's branch and opens one MR for each repo, in dependency order. It refuses, with exit 1 and before any push, when a repo head changed since the last test, and ends the error with `run ark test <run> again`. It also refuses, before any push, when a criterion with `manual: true` has no manual ok, and names each one. No command merges.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => mergeRequestOpen(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "merge-request status <run> [--since <time>] [--json] [--project <name>]",
    description:
      "Prints each MR of the run as `<repo>  <state>  <url>`, then `ci: passed|failed|running|none|unknown`, `conflict` when the MR cannot merge into its target branch (`conflict: unknown` when the host cannot say), and `checks failing: <names>`, read from gh or glab. With --since <ISO 8601 time> it also lists each human comment written after that time (bots and the logged-in Ark user left out), indented under its MR with author, file:line, body and URL; `comments: unknown` when they cannot be read. With --json it prints one array of {repo,url,state,ci,failedChecks:[{name,url}],conflict,comments}; conflict and comments are null when unknown. A value gh or glab cannot answer prints `unknown` and the command exits 0; unknown is never a pass. It changes nothing.",
    flags: { "--since": true, "--json": false, "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) =>
      mergeRequestStatus(runId, flags["--project"] as string | undefined, {
        since: flags["--since"] as string | undefined,
        json: flags["--json"] === true,
      }),
  },
  {
    usage: "worktree sync <run> [--project <name>]",
    description:
      "Fetches and merges origin's target branch into each worktree of the run, and pushes the branch of each repo that has an MR. It records worktree.synced for each repo. On a conflict it records it, undoes the merge and goes on to the next repo. After the last repo it exits 1 and names every conflicting repo. A closed run gets a phase error and its worktrees stay unchanged. It never merges an MR.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => worktreeSync(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "workspace sync <run> [--project <name>]",
    description:
      "Fetches and fast-forwards the target branch of the workspace checkout of each repo the run touched. It exits 1 and names the repo when git refuses, for example on a conflicting local change. It prints repo, branch and head.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => workspaceSync(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "status [<run>] [--project <name>]",
    description:
      "Prints the state of one run: phase, round, first unfinished step, waiting gate, last test, test head, MRs and cost. The test head line is `test head: current` when every worktree is at the head of the last test, and one `test head: stale (<repo> tested <8 characters>, now <8 characters>)` line for each repo that changed. There is no test head line before the first test. Without a run, it lists every open run. --project limits the config check to one project, like ARK_PROJECT, and with a run it looks for the run in that project only.",
    flags: { "--project": true },
    minimum: 0,
    maximum: 1,
    run: ([runId], flags) => status(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "retro <run> [--project <name>]",
    description:
      "Computes the run's cost, time, rework and intervention metrics and writes metrics.json. The `rework` object holds `rounds` (highest round of a non-merge step), `escalations` (escalation gate answers) and `findings_sent_back` (lines in each `findings/round-<n>.md` file that start, after optional `#` marks, one list marker (`N.`, `-` or `*`) and bold marks, with `P0`, `P1`, `P2` or `P3`; no findings folder counts 0). `rework.merge_steps` counts steps started with `--merge`. `human_intervention.plan_changes` counts the plan `change` answers plus every plan `approve` answer after the first, whoever gave it (`by` human or auto): `plan_changes: 0` for a plan approved once, `plan_changes: 2` for one change and a second approve. `actual_models` maps each plan step ID to the sorted, unique models of its sessions (an empty list when no session was found). For each step whose session models differ from its model in plan.yml (compared without a provider prefix, so `anthropic/claude-x` matches `claude-x`), it prints `model changed: step <step> planned <plan model>, ran <models>`; a run with no readable plan.yml prints none. `same_vendor_review` is true when a validator or reviewer step ran on the same vendor as an implementer step in the same repo (`claude-` is anthropic, `gpt-` is openai, any other model has no vendor); it prints `same vendor review: true (<steps>)` or `false`. Both are reports only.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => retro(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "chief state [--project <name>]",
    description:
      "Prints a Markdown snapshot of Master Chief's state, read live from its sources and never from a file: open runs with phase and current step, run leads (live ones only, dispatch and terminal) from `orca orchestration worker-list`, which reads Master Chief's own Orca Run; `task-list` reads the same Run for the queue, queued Orca Tasks (`ready` and `pending`), the head of the workspace's main branch, `gates` and `concurrency` from ark.yml, closed runs with an empty Close check and free disk space. A source that fails prints `unavailable: <reason>` under its heading, and the other sections still print. An empty source prints `none`. --project falls back to ARK_PROJECT.",
    flags: { "--project": true },
    minimum: 0,
    maximum: 0,
    run: (_positionals, flags) => chiefState(flags["--project"] as string | undefined),
  },
  {
    usage: "chief handover [--project <name>]",
    description:
      "Starts a new Master Chief for the project with `orca agent launch --surface terminal`, using `roles.chief` from ark.yml, and prints the new terminal handle. The prompt names the old Master Chief terminal (found with the live Master Chief of the project), tells the agent to wait until that terminal is gone, and then to run `run-use` on the existing Master Chief Run. It never closes the old terminal: Master Chief does that after the command returns. It exits 1 and starts nothing when no live Master Chief exists, when Orca does not answer or when `roles.chief` is not set. --project falls back to ARK_PROJECT.",
    flags: { "--project": true },
    minimum: 0,
    maximum: 0,
    run: (_positionals, flags) => chiefHandover(flags["--project"] as string | undefined),
  },
  {
    usage: "ui [--port <number>] [--name <host>]",
    description:
      "Serves the hub in hub/ on 127.0.0.1, port 4317 unless --port says otherwise (0 picks a free port). --name <host> (such as ark.localhost) also lets the hub answer to that name. One background reader builds a snapshot of the runs, plans, models, MRs, usage cost and backlog; the page gets it over one Server-Sent Events stream (/events; GET /api/snapshot returns the same JSON). A closed run, its decisions, files and agent transcripts are read when the page asks, not kept in the snapshot. Views: Home (tiles for what needs you, then blockers, the review queue and run progress with usage), Runs (every run on one board and a cross-run dependency graph; #/map redirects here), a run page (any run: progress strip, plan, agents, MR evidence, decisions, files, transcripts) and Backlog (grouped table; a ticket opens as a full page with its dependency graph; the ticket text is read when the page asks, GET /api/ticket/<project>/<id>). The hub's one action is POST /api/open-in-orca, which runs orca terminal switch for a live terminal; it sends no text to a terminal, changes no run state and steers no agent.",
    flags: { "--port": true, "--name": true },
    minimum: 0,
    maximum: 0,
    run: (_positionals, flags) =>
      ui(Number(flags["--port"] ?? 4317), flags["--name"] as string | undefined),
  },
  {
    usage: "ui install [--port <number>]",
    description:
      "Writes the LaunchAgents dev.ark.proxy and dev.ark.hub in ~/Library/LaunchAgents and loads them (proxy first), so the name proxy (portless proxy start --unprivileged) starts at login and the hub starts at login and restarts after a crash (port 4317 unless --port says otherwise). When portless is found (ARK_PORTLESS, else PATH; it needs Node 24+ on the PATH of the shell that runs install), the hub runs through it as http://ark.localhost and install prints the line '  name:   http://ark.localhost'. When it is not found, install writes no proxy agent, keeps the plain hub, prints 'portless not found: the hub stays at http://127.0.0.1:<port>' and exits 0. A second run with the same settings changes nothing; with a new port or a switch between the two forms it rewrites the plist and reloads. If loading an agent fails, install restores and reloads the previous plist of that agent only (or removes a new plist), reports any reload failure, and exits 1. See docs/how-to/local-names.md.",
    flags: { "--port": true },
    minimum: 0,
    maximum: 0,
    run: (_positionals, flags) => uiInstall(Number(flags["--port"] ?? 4317)),
  },
  {
    usage: "ui uninstall",
    description:
      "Unloads and deletes the LaunchAgents dev.ark.hub and dev.ark.proxy. It does nothing, and exits 0, when neither agent is installed.",
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
