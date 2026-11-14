import { ArkError } from "../errors.ts";
import { runStart, runStep, runClose, runCloseSweep, status } from "../run.ts";
import type { Command } from "./types.ts";

export const runStartCommand: Command = {
  usage: "run start <ticket-file> [--project <name>]",
  description:
    "Starts a run from a ticket file. It creates the run folder, copies the ticket and records the first event. It prints the run ID.\n\nWhere the project has `ticket_source: local`, it also sets the first `status:` line of the ticket file to `in_progress` and changes no other line. A refused start leaves the file unchanged. A ticket may set `kind: bug`, `perf`, `refactor` or `feature` (default `feature`); any other value exits 1 and names the allowed kinds. When a `kind: bug` or `kind: refactor` ticket has no `method: test` AC, it prints one line on stderr, `warning: kind <kind> has no method: test AC, so its red-test or base-pass rule does not apply`, and still starts the run. The kind is in `run.started`. Every new run waits in the phase `awaiting_criteria`, also with ACs and no blockers, until the human records `ark gate record <run> criteria accept`; the event has `criteria_gate: true`, and a log without it keeps its old phase. An AC id may be local to its ticket (`AC1`) or the old `<ticket id>-AC<k>`; the run names it `<ticket id>/AC<k>`. An AC has `method` (`test`, `demonstration`, `inspection` or `analysis`; default `test`; `manual: true` reads as `demonstration`) and `verified_by`, a list of test case ids. The start refuses an unknown method, a duplicate AC id and a `verified_by` that is not a list of strings.",
  flags: { "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([ticketFile], flags) => runStart(ticketFile, flags["--project"] as string | undefined),
};

export const runStepCommand: Command = {
  usage:
    "run step <run> <step> start|finish|interrupted [--failed] [--not-started] [--merge] [--project <name>]",
  description:
    "Records that a plan step started, finished or was interrupted. `ark run step <run> <step> start` also starts the worker of a plan step (not a --merge start) through `orca orchestration worker-start` in the step's worktree, as the run lead (`--from` names the run lead's Orca session), with the harness and model that `roles` of ark.yml gives the step's role (the pair of plan.yml when `roles` has none), and a spec it builds: the role and step id in words, the `Risks` of evaluation.md, each line of the `# Learnings applied` comment of plan.yml, each backticked string of the ACs the step serves, the `UI skills:` line, the rules in `rules.md` of the run folder when it exists and, for a reviewer, `Last reviewed head: <sha>`. It refuses before any Orca call when the start is not allowed, so a refused start launches no worker. It records step.started, then worker.started with the dispatch, the terminal, the harness and the session file (the new session file whose cwd is the worktree; `unknown` when none shows in 60 s). When worker-start fails it records step.finished with not_started (the round goes back), prints `ark: <step> not started: orca worker-start failed: <message>` and exits 1. The next start of an interrupted step runs `omp --restore <session>` in a terminal of the step's worktree and binds it as a supervised worker; with no session recorded, a harness with no restore command, or a failed terminal create or bind (the failed terminal is closed), it starts a fresh worker whose spec says an earlier worker was interrupted and that it must read `git status` and `git diff` before it goes on. Use --failed with finish when the step failed. Use --not-started with finish --failed when the worker never ran (worker-start exited non-zero and no worker is running): it records not_started: true on step.finished, takes back the round of that start, and the retro does not count the step. It is a usage error without --failed, and with start or --merge. Use `ark run step <run> <step> interrupted` when the worker of a running step is gone: it records step.finished with outcome interrupted, gives the round of that start back like not_started, changes no file in the worktree (it runs no git command) and lets the step start again at the same round. It is refused unless the step is running, while Orca lists the terminal of its worker in any state (disconnected too), and when Orca does not answer: it never guesses a worker dead. The terminal comes from the step's worker.started event; a running step with no worker.started event (an old run, a worker started by hand) is accepted without an Orca call, and any other step with no recorded terminal is refused. The retro counts no round for an interrupted start but keeps its time as working time, and `ark status` shows the step as interrupted. A step can start only after you approve the plan. Use --merge with start to run an implementer step that fixes a sync conflict: it costs no round, and it needs a failed ark worktree sync for the step repo. With `gates.escalation: auto` in ark.yml, an implementer start that is refused only because the round budget is spent, or because the MRs are open and no escalation answer exists, records gate escalation one_more_round by auto first and prints `escalation one_more_round by auto (<n> of <cap>)`; at most `escalation_rounds` of ark.yml (default 2) such answers per run (a --merge answer prints `(merge, not counted)` and does not count), never while escalation.requested is pending, never while the newest reviewer findings file holds a P0 or P1 finding with no `Repro:` line (a --merge start too), and the refusal past the cap is the usual one. For a `bug` run with a `method: test` AC it refuses an implementer start with `bug run: record a failing ark test of the ACs before the fix` until a `test.completed` has every non-manual AC `failing`; a bug run with no `method: test` AC has no such rule. A `finish` of a validator step, without --failed and after the refusal for uncommitted changes, runs stage `step` of `ark merge-request check` for the ACs of the step and is refused, with no event written, when it lists a problem: an AC string in no tracked file (counted once every implementer step that serves the AC has finished), a malformed evidence file, or a missing evidence file of an `analysis` AC. It never refuses for the MR title, a manual criterion with no answer, the last line `human: ok` or `reviewer:`, or an AC the step does not serve.",
  flags: {
    "--failed": false,
    "--not-started": false,
    "--merge": false,
    "--project": true,
  },
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
};

export const runCloseCommand: Command = {
  usage: "run close [<run> <outcome>] [--sweep] [--project <name>]",
  description:
    "Closes a run. The outcome is merged, abandoned, aborted or handed_off. Ark refuses an outcome that does not fit the run, such as merged with no MRs. For merged it deletes each repo's branch when its MR is merged (or, with no MR, when the branch is in the target branch); when `git fetch` fails and the MR state is unknown it keeps the branch and prints `kept     <repo>  <branch>: <reason>`. For handed_off Ark first applies the refusals of `ark merge-request open`, before it appends the event or removes a worktree: a non-manual criterion not `passing` in the last test, a manual criterion with no ok, a repo head changed since the last test, a counted AC string in no tracked file or a `not:` string still in one, a `kind: perf` run with a missing result file, a `kind: refactor` run with a `method: test` AC whose base did not pass, and missing, malformed or stale evidence (`evidence missing: <AC id> (<method>)`, `evidence malformed: <AC id>: <reason>`, `test evidence missing: <AC id> <test case id> (<base|head>)`, `test evidence stale: <AC id> <test case id>`). Only a string a file can hold counts: not one with a placeholder (`<`), a `*`, `...`, a `:<line>` suffix or the id of its own AC, and no string of a manual AC. A string also passes when it names a tracked file or folder at HEAD (one trailing `/` is dropped; an empty path never counts). A string that starts with `not:` is a removed string: it must be in no tracked file and name no tracked path, and the refusal names it without the prefix. For handed_off it keeps each branch with commits beyond its base (the base is in `worktree.created`) and prints `kept     <repo>  <branch>: handed off, <n> commit(s) ahead of <base>` for each; it deletes a branch with no commit beyond its base. An aborted run keeps a branch with commits the same way and prints `kept     <repo>  <branch>: aborted, <n> commit(s) ahead of <base>`; an aborted branch with no commit beyond its base is deleted. After the close it releases the settled Orca workers of the run (Orca Run `Ark run <run>`) and prints one line for each; it prints `<dispatch id> still active, not released` for an active one, and one `orca: workers not released: <reason>` line when Orca fails, and the close still exits 0. `ark run close --sweep [--project <name>]` does the same release for every closed run of the project (ARK_PROJECT when --project is not given), records no event, and prints nothing for a run with nothing to report. --sweep takes no run argument.\n\nWhere the project has `ticket_source: local`, it then sets the first `status:` line of the run's ticket file (`ticket_file` of `run.started`) to `done` for merged and to `ready` for aborted and abandoned, and changes no other line. handed_off leaves the file as it is. For a run with 2 or more repos, handed_off lists the branches in repo order, with `pending bump <step>` for each bump step that has not finished. A missing ticket file prints a `warning:` line and the close still succeeds.",
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
};

export const statusCommand: Command = {
  usage: "status [<run>] [--project <name>]",
  description:
    "Prints the state of one run: phase, round, first unfinished step, waiting gate, last test, test head, MRs and cost. The test head line is `test head: current` when every worktree is at the head of the last test, and one `test head: stale (<repo> tested <8 characters>, now <8 characters>)` line for each repo that changed. There is no test head line before the first test. For a project with `merge_requests: none` it prints `merge requests: none (local only)` in place of the MR lines, then `branch   <order>  <repo>  <branch>  <n> commit(s) ahead of <base, 8 characters>` for each worktree whose branch has commits beyond its base, in merge order, also after `ark run close <run> handed_off`. Without a run, it lists every open run. --project limits the config check to one project, like ARK_PROJECT, and with a run it looks for the run in that project only.\n\nThe list adds the age of the newest event of each open run after the step, as `Nm`, `Nh` or `Nd` (largest whole unit; hours up to 47), and ends the line with `  stale` when that age is over 24 hours: `<run>  <phase>  <step>  <age>[  stale]`. It prints the `kind` of the run after the ticket line.\n\nFor a `merge_requests: none` run with a `repos` block it prints, after the branch line of a repo (or after the last branch line when the repo has none), `pending bump: <step> (<kind> <upstream repo>, <pin>) needs <value>` for each bump step of that repo that has not succeeded. The value is 8 characters of the head of the upstream worktree for a submodule, and `<published version>` for any other kind. A plan with several repos and no `repos` block takes the order from step `needs` and prints `order: from step needs (no repos list)` once above the branches.",
  flags: { "--project": true },
  minimum: 0,
  maximum: 1,
  run: ([runId], flags) => status(runId, flags["--project"] as string | undefined),
};
