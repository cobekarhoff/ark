import { chiefState, chiefHandover } from "../chief.ts";
import type { Command } from "./types.ts";

export const chiefStateCommand: Command = {
  usage: "chief state [--project <name>]",
  description:
    "Prints a Markdown snapshot of Master Chief's state, read live from its sources and never from a file: open runs with phase and current step, run leads (live ones only, dispatch and terminal) from `orca orchestration worker-list`, which reads Master Chief's own Orca Run; `task-list` reads the same Run for the queue, queued Orca Tasks (`ready` and `pending`), the unread messages of every type to Master Chief's Orca Run, the head of the workspace's main branch, `gates` and `concurrency` from ark.yml, the number of closed runs since the last interview (`(due)` at 10 or more) and free disk space. It reads every page of the Run list, so a Master Chief Run past the first page is found. A source that fails prints `unavailable: <command> failed: <reason>` under its heading, and the other sections still print. An empty source prints `none`. The `Master Chief inbox` section reads `orca orchestration inbox --terminal run:<id> --full` and keeps the rows with `read` 0, without marking any message read (`check` marks messages read, and `check --peek` is refused for a caller that is not the Run's coordinator); it prints `unread for Master Chief: <n>, oldest <m> min`, with the age of the oldest in whole minutes, or `unread for Master Chief: 0`, and a read that fails prints `unavailable` with the reason, never 0. The `Red on main` section lists each file that an open run's last full `test.completed` recorded in `red_on_main`, with the run id, once; a run whose events cannot be read prints `unavailable` there. It also runs `ark companions sync` and prints its lines, and each failure as `unavailable: <reason>`, under `Companions`; with no `companions` in ark.yml and no recorded companion worker it adds no section and no Orca call, and a failing sync never changes the exit code. --project falls back to ARK_PROJECT.",
  flags: { "--project": true },
  minimum: 0,
  maximum: 0,
  run: (_positionals, flags) => chiefState(flags["--project"] as string | undefined),
};

export const chiefHandoverCommand: Command = {
  usage: "chief handover [--project <name>]",
  description:
    "Starts a new Master Chief for the project with `orca agent launch --surface terminal`, using `roles.chief` from ark.yml, and prints the new terminal handle. The prompt names the old Master Chief terminal (found with the live Master Chief of the project), tells the agent to wait until that terminal is gone, and then to run `run-use` on the existing Master Chief Run. It never closes the old terminal: Master Chief does that after the command returns. It exits 1 and starts nothing when no live Master Chief exists, when Orca does not answer or when `roles.chief` is not set. --project falls back to ARK_PROJECT.",
  flags: { "--project": true },
  minimum: 0,
  maximum: 0,
  run: (_positionals, flags) => chiefHandover(flags["--project"] as string | undefined),
};
