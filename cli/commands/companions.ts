import {
  companionAdvise,
  companionAnswer,
  companionAsk,
  companionPropose,
  companionsSync,
} from "../companions.ts";
import type { Command } from "./types.ts";

export const companionsSyncCommand: Command = {
  usage: "companions sync [--project <name>]",
  description:
    "Keeps one Orca worker alive for each companion listed under `companions` in ark.yml, and wakes it. A companion with no live worker is started with `orca orchestration worker-start --keep-open --run <Master Chief's Run>`, with the harness and model of its entry, the repo of the `workspace` of ark.yml as its worktree (the only path Orca resolves; the project folder is named in the spec), and a spec made of the fixed companion preamble and the text of its instructions file. A worker is live when its recorded dispatch id (`companions/<name>/worker.json`, written only after the start succeeded) is a row of `worker-list` of Master Chief's Run with liveness `live`: a kept-open companion stays live, and retained, after each turn. A `companions/<name>/` folder whose companion is no longer listed gets `worker-stop` and then `worker-release` for its recorded dispatch id; the folder keeps its ideas and answers. It prints one line for each companion: `<name>: running`, `<name>: started` or `<name>: stopped`. Each live companion then gets one `orca orchestration send --to dispatch:<id>` for each new event of a trigger it lists in `on`: `run.merged` is a `run.closed` event with outcome `merged`, `run.started` is `run.started`, `criteria.opened` is an `evaluation.recorded` event with at least one blocker, `escalation` is `escalation.requested`, and `ci.failed` is a failed check on an MR of a run in `merge_requests_open`, read live from `gh` or `glab` and keyed by run, MR number and check name. The message names the trigger and the run id. `companions/<name>/cursor.json` holds the last event of each run and the failures already sent; it is written after the send worked, so a failed send is sent again, and a companion's first sync only writes it and sends nothing for older events. A run whose events cannot be read is named on a `note:` line and skipped. A sync that finds another sync running for a companion refuses that companion with an `ark: ` line. It exits 1 after printing an `ark: ` line for each failure, and still handles the other companions; it exits 1 and changes nothing when Master Chief's Run or Orca cannot be read. With no `companions` key and no recorded worker it prints nothing and makes no Orca call. `ark chief state` runs the same sync. --project falls back to ARK_PROJECT.",
  flags: { "--project": true },
  minimum: 0,
  maximum: 0,
  run: (_positionals, flags) => companionsSync(flags["--project"] as string | undefined),
};

export const companionAskCommand: Command = {
  usage: "companion ask <name> <question> [--project <name>]",
  description:
    "Sends the live worker of the companion one message that holds the question and says it is a question from the human or Master Chief, not a trigger wake; the companion answers with `ark companion answer`. It exits 1 with an `ark: ` line, and sends nothing, when the name is not in ark.yml (it creates no folder) or the companion has no live worker. --project falls back to ARK_PROJECT.",
  flags: { "--project": true },
  minimum: 2,
  maximum: 2,
  run: (positionals, flags) =>
    companionAsk(positionals[0], positionals[1], flags["--project"] as string | undefined),
};

export const companionAnswerCommand: Command = {
  usage: "companion answer <name> <text> [--project <name>]",
  description:
    "Appends the text and its time to `companions/<name>/answers.md` with one write, then sends Master Chief a copy. Master Chief is the live one of the project, found as `ark chief handover` finds it, so it works with no Orca session variable (the hub calls it that way). It exits 1 with an `ark: ` line when the name is not in ark.yml (it creates no folder), and when the copy fails: then the answer is already in the file. --project falls back to ARK_PROJECT.",
  flags: { "--project": true },
  minimum: 2,
  maximum: 2,
  run: (positionals, flags) =>
    companionAnswer(positionals[0], positionals[1], flags["--project"] as string | undefined),
};

export const companionAdviseCommand: Command = {
  usage: "companion advise <name> <run> <text> [--project <name>]",
  description:
    "Sends the run lead of an open run one message of type `status` whose subject starts with `Advice from companion <name>:` and whose body says it is advice and not a gate answer, then sends Master Chief a copy with the run id. The lead is the worker of Master Chief's Run that leads the run, found as `ark chief state` finds it. Nothing is sent unless both the lead and the live Master Chief are found. It exits 1 with an `ark: ` line when the name is not in ark.yml, the run does not exist or is closed, the run has no live lead, or a send fails; when the send to the lead fails no copy goes out, and when only the copy fails the lead keeps the advice. --project falls back to ARK_PROJECT.",
  flags: { "--project": true },
  minimum: 3,
  maximum: 3,
  run: (positionals, flags) =>
    companionAdvise(
      positionals[0],
      positionals[1],
      positionals[2],
      flags["--project"] as string | undefined,
    ),
};

export const companionProposeCommand: Command = {
  usage: "companion propose <name> <file> [--project <name>]",
  description:
    "Copies the draft ticket (a relative path is resolved against the project folder, not the current folder) to `tickets/<id>.md` of the project with `status: proposed` (whatever status the draft names) and the front matter line `source: companion <name>`, and prints the path. The draft must be a valid ticket with an id like `ARK-123`. It exits 1 with an `ark: ` line and writes nothing when the name is not in ark.yml, the file is missing, the draft has no id or is not a valid ticket, or a ticket with that id already exists (an existing ticket is never overwritten). It never queues the ticket and sends no message: the human approves it, and Master Chief queues it. --project falls back to ARK_PROJECT.",
  flags: { "--project": true },
  minimum: 2,
  maximum: 2,
  run: (positionals, flags) =>
    companionPropose(positionals[0], positionals[1], flags["--project"] as string | undefined),
};
