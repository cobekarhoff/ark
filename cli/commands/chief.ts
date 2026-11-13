import { chiefState, chiefHandover } from "../chief.ts";
import type { Command } from "./types.ts";

export const chiefStateCommand: Command = {
  usage: "chief state [--project <name>]",
  description:
    "Prints a Markdown snapshot of Master Chief's state, read live from its sources and never from a file: open runs with phase and current step, run leads (live ones only, dispatch and terminal) from `orca orchestration worker-list`, which reads Master Chief's own Orca Run; `task-list` reads the same Run for the queue, queued Orca Tasks (`ready` and `pending`), the head of the workspace's main branch, `gates` and `concurrency` from ark.yml, the number of closed runs since the last interview (`(due)` at 10 or more) and free disk space. It reads every page of the Run list, so a Master Chief Run past the first page is found. A source that fails prints `unavailable: <command> failed: <reason>` under its heading, and the other sections still print. An empty source prints `none`. The `Red on main` section lists each file that an open run's last full `test.completed` recorded in `red_on_main`, with the run id, once; a run whose events cannot be read prints `unavailable` there. --project falls back to ARK_PROJECT.",
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
