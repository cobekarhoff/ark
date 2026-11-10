#!/usr/bin/env bun
import { chiefHandover, chiefState } from "./chief.ts";
import { ArkError } from "./errors.ts";
import { criteriaAmend } from "./criteria.ts";
import { evaluationRecord } from "./evaluation.ts";
import { escalate, gateRecord } from "./gate.ts";
import { bumpRefresh, mergeRequestOpen, mergeRequestStatus } from "./merge-request.ts";
import { planCheck } from "./plan-check.ts";
import { retro } from "./retro.ts";
import { runClose, runCloseSweep, runStart, runStep, status } from "./run.ts";
import { strategyRecord } from "./strategy.ts";
import { testCaseNew } from "./test-case.ts";
import { testRun, testRunnerMain } from "./test-run.ts";
import { uiSkills } from "./ui-skills.ts";
import { ui, uiInstall, uiUninstall } from "./ui.ts";
import { workspaceSync, worktreeAnchor, worktreeCreate, worktreeSync } from "./worktree.ts";

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
      "Starts a run from a ticket file. It creates the run folder, copies the ticket and records the first event. It prints the run ID.\n\nWhere the project has `ticket_source: local`, it also sets the first `status:` line of the ticket file to `in_progress` and changes no other line. A refused start leaves the file unchanged. A ticket may set `kind: bug`, `perf`, `refactor` or `feature` (default `feature`); any other value exits 1 and names the allowed kinds. When a `kind: bug` or `kind: refactor` ticket has no `method: test` AC, it prints one line on stderr, `warning: kind <kind> has no method: test AC, so its red-test or base-pass rule does not apply`, and still starts the run. The kind is in `run.started`. Every new run waits in the phase `awaiting_criteria`, also with ACs and no blockers, until the human records `ark gate record <run> criteria accept`; the event has `criteria_gate: true`, and a log without it keeps its old phase. An AC id may be local to its ticket (`AC1`) or the old `<ticket id>-AC<k>`; the run names it `<ticket id>/AC<k>`. An AC has `method` (`test`, `demonstration`, `inspection` or `analysis`; default `test`; `manual: true` reads as `demonstration`) and `verified_by`, a list of test case ids. The start refuses an unknown method, a duplicate AC id and a `verified_by` that is not a list of strings.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([ticketFile], flags) => runStart(ticketFile, flags["--project"] as string | undefined),
  },
  {
    usage:
      "run step <run> <step> start|finish [--failed] [--not-started] [--merge] [--project <name>]",
    description:
      "Records that a plan step started or finished. Use --failed with finish when the step failed. Use --not-started with finish --failed when the worker never ran (worker-start exited non-zero and no worker is running): it records not_started: true on step.finished, takes back the round of that start, and the retro does not count the step. It is a usage error without --failed, and with start or --merge. A step can start only after you approve the plan. Use --merge with start to run an implementer step that fixes a sync conflict: it costs no round, and it needs a failed ark worktree sync for the step repo. With `gates.escalation: auto` in ark.yml, an implementer start that is refused only because the round budget is spent, or because the MRs are open and no escalation answer exists, records gate escalation one_more_round by auto first and prints `escalation one_more_round by auto (<n> of 2)`; at most 2 such answers per run (a --merge answer prints `(merge, not counted)` and does not count), never while escalation.requested is pending, and the third refusal is the usual one. For a `bug` run with a `method: test` AC it refuses an implementer start with `bug run: record a failing ark test of the ACs before the fix` until a `test.completed` has every non-manual AC `failing`; a bug run with no `method: test` AC has no such rule.",
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
  },
  {
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
    usage: "criteria amend <run> <criterion id> <file> --reason <text> [--project <name>]",
    description:
      "Writes the text in <file> as the new text of one criterion in the run's ticket.md (frontmatter and table row) and records criteria.amended with the criterion, the old text, the new text, `by: human` and the required --reason (the human's reason for the new text). Use it for an amendment the human approved, when an AC wording is wrong after planning, instead of aborting the run. It works in every phase before merge_requests_open (awaiting_strategy, planning, building, escalation) and refuses a run in merge_requests_open or closed (naming the phase), an unknown criterion, an empty file, and a missing or empty --reason. It clears the manual answer of the criterion. Before the plan is approved it also clears the plan check: run ark plan check again so plan.md lists the amendment. After plan approval the run keeps its phase and approval and the next ark test judges the new text: do not run ark plan check again, it can change the plan hash and reset the approval. ark status lists each amendment with its reason.",
    flags: { "--project": true, "--reason": true },
    minimum: 3,
    maximum: 3,
    run: ([runId, criterionId, file], flags) =>
      criteriaAmend(
        runId,
        criterionId,
        file,
        flags["--reason"] as string | undefined,
        flags["--project"] as string | undefined,
      ),
  },
  {
    usage: "strategy record <run> [--project <name>]",
    description:
      "Reads strategies.md in the run folder and records its strategy cards: the count, the recommended card and the card IDs. It refuses a missing file, a card with no approach, interfaces or tradeoffs, a mockup link to a file that is not in the run folder, a run with no evaluation record, one card with no reason, and, when the evaluation lists a surface other than none, a card with no mockup link, and, when the surfaces include web_ui, a card with no Skills line or a Skills line that names a skill `ark ui-skills <run>` does not list, or a project whose ark.yml has no roles.designer. A mockup and roles.designer are not needed when the surface is only none, or when there is one card and the surface is only document. A Skills line is needed only when the surfaces include web_ui. Two or more cards open the strategy gate; one card opens no gate.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => strategyRecord(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "ui-skills <run> [--project <name>]",
    description:
      "Prints the UI skills of the run, one line for each. When the Surfaces list in the recorded evaluation includes web_ui, it prints the required skills, then one more line for the React skill, which is only for a change that touches React code. For any other Surfaces list (none, cli_output or document alone), it prints none. It exits 1 for a run with no recorded evaluation. The Designer, the implementer, the validator and the reviewer read these skills; strategy record and plan check refuse a Skills line or a skills list that names any other skill.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => uiSkills(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "plan check <run> [--project <name>]",
    description:
      "Checks plan.yml in the run folder and renders plan.md. It prints one line for each problem and exits 1 when the plan is invalid. A plan with no summary is invalid, and so is a summary with no row for an AC of the ticket. A plan with no `design.interfaces` is invalid, and so is an interface with no name or with no `callers`, or with a blank caller. A plan with a cycle, an unknown `needs`, a duplicate step id, an unknown role, or a step with no id, role, repo, harness or model is invalid. A summary with no why, no changes, or a change with no criterion, where, now or fix is invalid. A decision with no id, a duplicate id, no question, an option with no label, or a `recommended` or `chosen` that is not an option, is invalid. A test case with a level other than integration or e2e is invalid. A criterion with no integration or e2e test case is invalid, and so is a test case with an empty list or no expected sentence. A decision with fewer than 2 or more than 4 options is invalid. A step whose harness and model are not the pair of any entry in roles in ark.yml is invalid: the problem names the step, its pair and the allowed pairs. It refuses a run with no strategy record or with an open strategy gate. When the evaluation lists web_ui, it also needs a skills list in at least one step, only skills that `ark ui-skills <run>` lists, and every required skill in each non-empty list; plan.md then has a Skills column. A run with no recorded evaluation, or with no web_ui surface, needs no skills list. It records the number of open decisions. For `kind: bug` the first step must be a validator step that serves every AC, a manual one too. For `kind: perf` the `goal` of the first step must name `results/baseline.md` and the `goal` of the last step must name `results/compare.md`. `goal` is an optional step text. A test case has an `id` of the shape `<KEY>-T<n>` and an `action` of `add`, `update`, `reuse` or `retire`; only add and update need `given`, `when` and `then`, and retire needs `reason`. It refuses an unknown action, a retire with no reason, a reuse, update or retire whose id has no entry in `test/cases/` of a repo of the workspace, a `verified_by` id that is no active entry there and no add entry of the plan, and a new-scheme AC with `method: test` whose `verified_by` holds no integration or e2e case. A plan test case in the old shape (free id, one `criterion`, no action) still loads and keeps the old rule. It also refuses any bad entry in `test/cases/` and names its file; an absent folder is valid. plan.md lists each case with its action.\n\nThe optional `repos` block holds the repo edges of a plan that touches 2 or more repos: a list of `{ repo, why, depends_on }`, where `depends_on` is a list of edges `{ repo, kind, pin, evidence, bump }`. `kind` is `submodule`, `package`, `compose` or `api`; `pin` says how the repo holds the upstream repo; `evidence` is the file and line that show the edge; `bump` is the id of the bump step in the repo, for a `submodule` or `package` edge that the ticket changes upstream. ark does not parse manifests: the run lead finds each edge. With a `repos` block, the merge order comes from its edges and step `needs` make no repo edge; a plan with no block (an old plan) takes the edges from step `needs`. The command refuses a repo listed twice or outside the workspace, an unknown `kind`, an edge with no `pin` or no `evidence`, a `bump` that is no step of the repo, a step of a repo that is not in the block, a cycle between repos, and a step of a downstream repo with no `needs` path from an implementer step of an upstream repo. plan.md lists the repos in merge order.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => planCheck(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "worktree anchor <run> [--project <name>]",
    description:
      "Makes the run's worktree early, for the first repo of the workspace, with the same branch, `setup` and `worktree.created` event as `worktree create`. It prints one line, `path:<absolute path>`, the folder to start the run lead and its first workers in. A second call prints the same line and records nothing. A later `worktree create` prints `exists` for that repo. A repo with `repos.<repo>.base` in ark.yml starts from `origin/<base>` after `git fetch origin <base>`, not from the clone's HEAD; a failed fetch exits 1, names the repo and makes no worktree. If `setup` exits non-zero it removes the worktree and exits 1, as `worktree create` does. It refuses a closed run.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => worktreeAnchor(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "worktree create <run> [<repo>...] [--allow-dirty] [--project <name>]",
    description:
      "Builds the run's workspace mirror. A repo with `repos.<repo>.base` in ark.yml gets its worktree from `origin/<base>` after `git fetch origin <base>`, not from the clone's HEAD; if that fetch fails the command exits 1, names the repo and the fetch error, and makes no worktree for it. Each named repo, or every repo the plan uses, gets a worktree on the branch `ark/<ticket id>-<slug>`, or on the lowest free `-2`, `-3`, ... suffix when that name exists locally or on origin; `worktree.created` records the branch. Before it adds any worktree it checks every nested repo that has none yet for uncommitted changes: it prints the changed paths and exits 1, and makes nothing. With `--allow-dirty` it prints the paths as a warning and branches from HEAD without those changes. The root repo `.` is never refused and needs no flag: when the command makes the root worktree and the root has uncommitted changes, it prints `warning  .        <workspace> has <n> uncommitted changes, not in the worktree` and the paths on stderr, once per run, and exits 0. Every other path is a symlink to the workspace. When `ark.yml` sets `setup`, the command runs it with `sh -c` in each new worktree. If `setup` exits non-zero, the command removes that worktree and its branch, prints the repo, the exit code and the last 10 lines of stderr (of stdout when stderr is empty), and exits 1. If the removal fails, the output names each `left behind` worktree path and branch. It records the worktree only after `setup` passes. A repo folder with a `.git` and no recorded worktree is a stale leftover: the next create removes it, then runs `setup` again.",
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
    usage: "test <run> [--quick] [--wait] [--stop] [--project <name>]",
    description:
      "Runs the project's suites on the run's workspace mirror and records which ACs have a passing test. A criterion with `manual: true` in ticket.md has no test: it shows `manual pending`, `manual ok` or `manual problem` from the manual gate, even when a test is tagged with it. It exits 1 unless every AC is passing or manual ok. `passed` in test.completed counts the automated criteria only, so a manual pending never opens the escalation gate. It first runs each entry of `checks` in `ark.yml` (`{ name, repo, command }`) in its repo worktree, before the suites. A check that exits non-zero prints `check <name> failed` and the last 20 lines of its output, and records `passed: false`. On every `ark test` it also runs suites on a throwaway checkout at the base commit of each worktree (an untouched repo runs as at head). A `kind: refactor` run runs every suite whole there. For another kind, a suite with `base_files` and `base_command` runs only the test files of the run's own commits (`git log --first-parent --no-merges --name-only <base>..HEAD`, merge-in files left out, files that exist at head, matching `base_files`) through `base_command`; a suite with none prints `skipped  (no changed test file)`, and when every suite is skipped there is no base checkout, `setup` or compose. A suite with no `base_files` runs whole. Before it runs, it copies the head's version of each file that the diff adds or changes under a `test`, `tests` or `features` folder at any depth into that checkout, so a new test meets the base build. A deleted or renamed file stays at base. A failure at base is data and does not fail `ark test`, except for a `kind: refactor` run with a `method: test` AC, where the suites must pass at base: `ark test` exits 1 and records `base_passed`. Each suite runs with `ARK_EVIDENCE_DIR` set to a scratch folder, and the `checkpoint` helper of `test/pw/helpers.ts` writes `screenshots/<checkpoint name>.png` under it (nothing when the variable is not set). After the parsers find the test case ids, it writes `results/evidence/<test case id>/base/` and `results/evidence/<test case id>/head/` in the run folder, each with `result.json` (the case id, the JUnit name, the status passed, failed or skipped, and the commit SHA of the checkout that ran), `command.log` (the first line is the suite command with `{report}` replaced, then the whole output of the suite, and the last line `exit <code>`; every case of one suite shares it) and `screenshots/`. A case that the head run reports and the base run does not, because its suite crashed or its test file was deleted at head, gets a failed base `result.json`; a case whose suite or test file the base did not run gets the status `not run`, with no `sha` and no `command.log`. A criterion whose cases have no result because a suite was skipped reads `not run` and does not fail `ark test`. A folder of a case that no longer appears is removed. The suite logs stay in `<suite>.log` and `base-<suite>.log`. An AC with a non-empty `verified_by` list is decided by its test cases at every level, unit included: passing when each has a passing result, failing when one has a failing result, missing when one has no result. An AC with no `verified_by` still reads the integration and e2e results tagged with its AC id. A method other than `test` shows through the manual gate, as `manual: true` does; its evidence file `results/evidence/<AC id>.md` is checked by `ark merge-request open`. Each criterion line ends with `via <case> <result>, ...`, `via tag` or `method <method>`, and one `evidence   results/evidence/<test case id>/{base,head}` line follows for each case. It refuses a bad entry in `test/cases/` and names its file. `--quick` runs, at head only and with no base run, the changed own-commit test files of each suite that `paths` selects (a suite with no `base_files` runs whole); it records `mode: quick` and a `duration` in test.completed, a pass reads `not run` for each AC, and it prints `mode: quick (not a gate: run ark test <run> before the MR)`. A plain `ark test` records `mode: full`, and an event with no `mode` reads as full. `ark merge-request open` and `ark run close <run> handed_off` refuse unless the last test at the current head is full, and name `ark test <run>`. `ark test` starts a detached runner process and prints what the runner prints, so a lost connection does not stop the tests: the runner takes the host lock itself, holds it until it ends, and writes `results/runner.json` (pid, mode, state, exit code), `results/runner.out` and `results/runner.err` in the run folder. A signal to the `ark test` caller does not stop the suites. `--wait` prints what the runner of the run printed, from the start, and exits with its code, whether the runner still runs or has ended; with no runner it exits 1. After a lost connection run `ark test <run> --wait`, never `ark test` again. A second `ark test` of a run with a live runner of the same mode attaches to it; one of another mode (`--quick` against full) exits 1 and names `--wait` and `--stop`. A runner whose pid is dead or whose start time changed is stale: `--wait` prints its output and exits 1, and the next `ark test` starts a new runner. `--stop` sends SIGTERM to the runner, which stops every suite process group, records the state `stopped` and releases the lock; the command returns when the runner is gone, and an attached caller exits 128 plus the signal number. A passed suite result is kept per project and printed `reused`: the head result is keyed by the HEAD of every repo, the mode and the suite command (a checkout with uncommitted changes reads and stores nothing); the base result by the base commits, a hash of the copied test files and the suite command, and with every base suite stored there is no checkout, `setup` or compose. A reused result keeps its evidence, its `base_passed` and its flaky files; a failed result is never stored; `checks` run on every call. At head, a failed test file runs once more through `base_command` with that one file (a failure at base is data and is not retried). A pass counts and the file is listed as `flaky` in the output, in `test.completed` (`flaky`, and `reused` for the reused suites), in the retro metrics and in the MR body; a second failure fails the suite. A suite with no `base_command`, or a failed test whose report names no file, is not retried. It prints `tests      <passed> passed, <skipped> skipped (base <n>), <deleted> deleted` and one `deleted    <file>  <title>` line for each test the base has and the head lacks, and records `passed_count`, `skipped`, `base_skipped` and `deleted` (a list of `{ file, name }`) in test.completed; the counts cover every test, not only the ones with a test case ID, and the MR body shows them. The base side comes from a census: the whole suites run once more on a pristine checkout of the base commit (replayed from the cache when its key is stored). A renamed test counts as deleted. A quick run counts the skipped tests at head only and has no `base_skipped` and no `deleted`. This only reports: it never changes the exit code.",
    flags: { "--project": true, "--quick": false, "--wait": false, "--stop": false },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) =>
      testRun(runId, flags["--project"] as string | undefined, {
        quick: flags["--quick"] === true,
        wait: flags["--wait"] === true,
        stop: flags["--stop"] === true,
      }),
  },
  {
    usage: "test-case new <KEY> [--run <run>] [--project <name>]",
    description:
      "Run in a git repo, or anywhere with `--run <run>` (with `--project <name>` when the run ID is in several projects), which writes into the root repo worktree of that run and refuses a closed run or one with no worktree. Without `--run` it refuses in the `workspace:` checkout of a project, since that file belongs to no run. It allocates the next test case ID `<KEY>-T<n>`, one above the highest of a counter file per key in the git common directory, the `<KEY>-T*` entries in `test/cases/` and the entries on the last fetched origin target branch (a missing origin counts as none; it never fetches), and writes `test/cases/<KEY>-T<n>.md` with status `active`. It holds a lock in the git directory while it reads the highest number, writes the counter and then the file, so parallel runs and worktrees of one repo get different IDs. It prints the ID alone on stdout and the path of the file on stderr. An entry is one Markdown file with the frontmatter `id`, `title` (starts with the id), `level` (unit, integration or e2e), `technique`, `priority`, `risk` (the defect the case catches), `status` (active or retired; a retired entry also has `retired_reason`) and `changed_by`, and the sections Objective, Preconditions, Steps, Expected results and Screenshot checkpoints. `test_case_source` in ark.yml accepts `local` only. Outside a git repo it exits 1.",
    flags: { "--run": true, "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([key], flags) =>
      testCaseNew(
        key,
        flags["--run"] as string | undefined,
        flags["--project"] as string | undefined,
      ),
  },
  {
    usage: "gate record <run> <gate> [<criterion id>] <answer> [--note <text>] [--project <name>]",
    description:
      "Records your answer to a gate. The gates are criteria, strategy, plan, escalation and manual. The strategy gate takes the ID of a card in the latest strategy record, or abort. The manual gate proves one criterion whose method is not `test` (`manual: true` reads as `demonstration`): `ark gate record <run> manual <criterion id> ok|problem [--note <text>]` records gate.answered with the field `criterion`; it refuses an ID that is not in the ticket or not manual, and the answer is never automatic. For a `demonstration` criterion, `ok` also leaves the line `human: ok` once, as the last line of `results/evidence/<AC id>.md`, when that file exists; `problem` and the other methods change no file. Ark refuses an answer that the run's state does not allow, and refuses plan approve while the plan has an open decision. Both `<ticket id>/AC<k>` and `<ticket id>-AC<k>` name a criterion. `criteria accept` re-reads the ticket and refuses a new-scheme AC with `method: test` and an empty `verified_by` list, and names the AC.",
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
    usage: "merge-request open <run> [--summary <text>] [--project <name>]",
    description:
      "Pushes each repo's branch and posts one ready MR (not Draft) for each repo, in merge order: the order of the `repos` graph of plan.yml, upstream first. A plan with no `repos` block (an old plan) takes the order from step `needs`. Each `merge_request.opened` event has the fields `order` (the place of its repo in the merge order) and `waits_for` (the upstream repos whose MRs it waits for). Title and body come from the run: the title is `<ticket id>: <summary>`, 72 characters or less in total, where `summary` is the ticket's `summary:` field, else the ticket title, each used only when the whole title fits, else the text of `--summary`; with none it exits 1 before any push with `ticket has no summary: pass --summary`. A `pr_writing.title_prefix` rule in ark.yml wins over that form. The body is written from the run folder and linted before the push, and a lint `fail` refuses. The plan gate answer is the go-ahead: no confirm flag. A repo that already has an open MR gets the new head pushed and the text between `<!-- pr-writing:begin -->` and `<!-- pr-writing:end -->` in its body replaced; text outside the markers stays, an old body with no markers is rewritten whole once and the output says so, a body that did not change is left alone, and a merged or closed MR is skipped. Run it again after each post-MR round. It refuses, with exit 1 and before any push, when a repo head changed since the last test, and ends the error with `run ark test <run> again`. It also refuses, before any push, when a criterion with `manual: true` has no manual ok, and names each one. The MR targets `repos.<repo>.base` when ark.yml sets it (`--base <base>` on GitHub, `--target-branch <base>` on GitLab), else the branch origin/HEAD names. No command merges. For a project with `merge_requests: none` in ark.yml it exits 1 before any command runs and prints `project <project> has merge_requests: none: close the run with ark run close <run> handed_off`. It also refuses, before any push, when a non-manual AC is not `passing` in the last test (it names each), when a string in backticks in an AC text is in no tracked file of a run worktree at HEAD (it names the AC and the string; Only a string a file can hold counts: not one with a placeholder (`<`), a `*`, `...`, a `:<line>` suffix or the id of its own AC, and no string of a manual AC. A string also passes when it names a tracked file or folder at HEAD (one trailing `/` is dropped; an empty path never counts). A string that starts with `not:` is a removed string: it must be in no tracked file and name no tracked path, and the refusal names it without the prefix.), for `kind: perf` when `results/baseline.md` or `results/compare.md` is missing or empty, and for a `kind: refactor` run with a `method: test` AC unless `base_passed` is true. Last, it checks the evidence and refuses, before any push and before any event, with `refused: evidence is not complete` and one line for each AC or case that fails. A non-test AC needs one file `results/evidence/<AC id>.md` in the run folder (`<AC id>` is the local id such as `AC6`; an old `manual: true` AC reads as `demonstration`). The line is `evidence missing: <AC id> (<method>)` for a missing file and `evidence malformed: <AC id>: <reason>` for a file without a section of its method, naming it. `demonstration`: the sections What the human did, What the human saw, Before and After (each with a screenshot path, checked for shape, not for existence), and the last line `human: ok`, which `ark gate record <run> manual <AC id> ok` writes. `inspection`: the sections Files (each `path:start-end`), Checked against and Verdict, with the line `reviewer: pass` or `reviewer: fail`. `analysis`: the sections Command, Output, Threshold and Result, each given for Base and for Head. For an AC with `method: test`, each case in its `verified_by` needs `results/evidence/<test case id>/base/` and `head/` (`test evidence missing: <AC id> <test case id> (<base|head>)`), and the commit SHA in the `head` `result.json` must be the current head of a repo of the run (`test evidence stale: <AC id> <test case id>`). An AC with no `verified_by` needs no test evidence.",
    flags: { "--summary": true, "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) =>
      mergeRequestOpen(runId, flags["--project"] as string | undefined, {
        summary: flags["--summary"] as string | undefined,
      }),
  },
  {
    usage: "merge-request status <run> [--since <time>] [--json] [--project <name>]",
    description:
      "For a project with `merge_requests: none` it prints `merge requests: none`, exits 0 and calls no gh and no glab. Otherwise it prints each MR of the run as `<repo>  <state>  <url>`, then `ci: passed|failed|running|none|unknown`, `conflict` when the MR cannot merge into its target branch (`conflict: unknown` when the host cannot say), and `checks failing: <names>`, read from gh or glab. Under an MR that lists upstreams in `waits_for` it prints `  waits for !N (<state>)` for each, then `  bump <step>  <kind> <upstream repo>  pin <pin>  <state>` for each bump step of its repo in the plan. The bump state is `refreshed to <value>` once `ark bump refresh` recorded it (8 characters for a submodule); else for a submodule `points at upstream branch <8 characters>` (the pointer in the downstream worktree), and for any other kind `waits for upstream merge` or, with the upstream MR merged, `waits for upstream publish`. Ark asks no package registry. With --since <ISO 8601 time> it also lists each human comment written after that time (bots and the logged-in Ark user left out), indented under its MR with author, file:line, body and URL; `comments: unknown` when they cannot be read. With --json it prints one array of {repo,url,state,ci,failedChecks:[{name,url}],conflict,comments}; conflict and comments are null when unknown. A value gh or glab cannot answer prints `unknown` and the command exits 0; unknown is never a pass. It changes nothing.",
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
    usage: "bump refresh <run> <step> [--to <value>] [--project <name>]",
    description:
      "Records `bump.refreshed` for a bump step of the plan (a step named in the `bump` field of a repo edge) and prints `refreshed <step> to <value>`. For a submodule edge it fetches the submodule in the downstream worktree, moves its pointer (the `pin` path) to the merge commit of the upstream MR (`merge_commit_sha` or `squash_commit_sha` on GitLab, `mergeCommit` on GitHub), never to the branch head, commits the pointer and records the commit. It refuses when the upstream MR is not merged or names no merge commit. `--to <commit>` replaces the merge commit. For any other edge kind `--to <value>` is required and the command only records it: the pin edit is an implementer round. It refuses a step that is not a bump step. `ark merge-request status` then shows `refreshed to <value>` (8 characters for a submodule).",
    flags: { "--to": true, "--project": true },
    minimum: 2,
    maximum: 2,
    run: ([runId, step], flags) =>
      bumpRefresh(runId, step, {
        to: flags["--to"] as string | undefined,
        project: flags["--project"] as string | undefined,
      }),
  },
  {
    usage: "worktree sync <run> [--project <name>]",
    description:
      "Fetches and merges origin's target branch (`repos.<repo>.base` when set, else the branch origin/HEAD names) into each worktree of the run, and pushes the branch of each repo that has an MR (never for a project with `merge_requests: none`). It records worktree.synced for each repo. Before the merge it checks that no `test/cases/<id>.md` the branch added since the merge-base exists on the target with other content; if one does, it records a conflict, skips the merge and the push, and goes on to the next repo. On a merge conflict it records it, undoes the merge and goes on to the next repo. After the last repo it exits 1, printing `test case id taken on the target branch: <id>` for each taken id and naming every conflicting repo. A closed run gets a phase error and its worktrees stay unchanged. It never merges an MR.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => worktreeSync(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "workspace sync <run> [--project <name>]",
    description:
      "Fetches and fast-forwards the target branch (`repos.<repo>.base` when set, else the branch origin/HEAD names) of the workspace checkout of each repo the run touched. It exits 1 and names the repo when git refuses, for example on a conflicting local change. It prints repo, branch and head.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => workspaceSync(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "status [<run>] [--project <name>]",
    description:
      "Prints the state of one run: phase, round, first unfinished step, waiting gate, last test, test head, MRs and cost. The test head line is `test head: current` when every worktree is at the head of the last test, and one `test head: stale (<repo> tested <8 characters>, now <8 characters>)` line for each repo that changed. There is no test head line before the first test. For a project with `merge_requests: none` it prints `merge requests: none (local only)` in place of the MR lines, then `branch   <order>  <repo>  <branch>  <n> commit(s) ahead of <base, 8 characters>` for each worktree whose branch has commits beyond its base, in merge order, also after `ark run close <run> handed_off`. Without a run, it lists every open run. --project limits the config check to one project, like ARK_PROJECT, and with a run it looks for the run in that project only.\n\nThe list adds the age of the newest event of each open run after the step, as `Nm`, `Nh` or `Nd` (largest whole unit; hours up to 47), and ends the line with `  stale` when that age is over 24 hours: `<run>  <phase>  <step>  <age>[  stale]`. It prints the `kind` of the run after the ticket line.\n\nFor a `merge_requests: none` run with a `repos` block it prints, after the branch line of a repo (or after the last branch line when the repo has none), `pending bump: <step> (<kind> <upstream repo>, <pin>) needs <value>` for each bump step of that repo that has not succeeded. The value is 8 characters of the head of the upstream worktree for a submodule, and `<published version>` for any other kind. A plan with several repos and no `repos` block takes the order from step `needs` and prints `order: from step needs (no repos list)` once above the branches.",
    flags: { "--project": true },
    minimum: 0,
    maximum: 1,
    run: ([runId], flags) => status(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "retro <run> [--project <name>]",
    description:
      "Computes the run's cost, time, rework and intervention metrics and writes metrics.json. The `time` object holds `wall_seconds`, `by_step` and four parts that add up to `wall_seconds`: `waiting_on_you_seconds` (gate waits; an escalation wait starts at the last step.finished or test.completed before the escalation request or answer, and an open gate runs to the end), `working_seconds` (step windows), `waiting_to_merge_seconds` (from the first merge request) and `idle_seconds` (the rest); a moment in two parts goes to the first in that order. The `rework` object holds `rounds` (highest round of a non-merge step), `escalations` (escalation gate answers) and `findings_sent_back` (lines in each `findings/round-<n>.md` file that start, after optional `#` marks, one list marker (`N.`, `-` or `*`) and bold marks, with `P0`, `P1`, `P2` or `P3`; no findings folder counts 0). `rework.findings_left_p0p1` counts the P0 and P1 list lines under `## Run lead decision` in each findings file whose first of the words `leave` and `send back` is `leave`. `rework.merge_steps` counts steps started with `--merge`. `human_intervention.plan_changes` counts the plan `change` answers plus every plan `approve` answer after the first, whoever gave it (`by` human or auto): `plan_changes: 0` for a plan approved once, `plan_changes: 2` for one change and a second approve. `actual_models` maps each plan step ID to the sorted, unique models of its sessions (an empty list when no session was found). For each step whose session models differ from its model in plan.yml (compared without a provider prefix, so `anthropic/claude-x` matches `claude-x`), it prints `model changed: step <step> planned <plan model>, ran <models>`; a run with no readable plan.yml prints none. `same_vendor_review` is true when a reviewer step ran all of its models on one vendor that an implementer step in the same repo also ran (`claude-` is anthropic, `gpt-` is openai, any other model has no vendor). A reviewer step that ran models of two vendors is `mixed`: it is not same vendor, `ark retro` prints `mixed review steps: <steps>`. It prints `same vendor review: true (<steps>)` or `false`. Both are reports only.",
    flags: { "--project": true },
    minimum: 1,
    maximum: 1,
    run: ([runId], flags) => retro(runId, flags["--project"] as string | undefined),
  },
  {
    usage: "chief state [--project <name>]",
    description:
      "Prints a Markdown snapshot of Master Chief's state, read live from its sources and never from a file: open runs with phase and current step, run leads (live ones only, dispatch and terminal) from `orca orchestration worker-list`, which reads Master Chief's own Orca Run; `task-list` reads the same Run for the queue, queued Orca Tasks (`ready` and `pending`), the head of the workspace's main branch, `gates` and `concurrency` from ark.yml, the number of closed runs since the last interview (`(due)` at 10 or more) and free disk space. It reads every page of the Run list, so a Master Chief Run past the first page is found. A source that fails prints `unavailable: <command> failed: <reason>` under its heading, and the other sections still print. An empty source prints `none`. --project falls back to ARK_PROJECT.",
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
      "Serves the hub in hub/ on 127.0.0.1, port 4317 unless --port says otherwise (0 picks a free port). --name <host> (such as ark.localhost) also lets the hub answer to that name. One background reader builds a snapshot of the runs, plans, models, MRs, usage cost, tickets and roadmap; the page gets it over one Server-Sent Events stream (/events; GET /api/snapshot returns the same JSON). A closed run, its decisions, files and agent transcripts are read when the page asks, not kept in the snapshot. Views: Home (tiles for what needs you, then blockers, the review queue and run progress with usage), Runs (every run on one board and a cross-run dependency graph; #/map redirects here), a run page (any run: progress strip, plan, agents, MR evidence, decisions, files, transcripts) and Roadmap (grouped table; a ticket opens as a full page with its dependency graph; the ticket text is read when the page asks, GET /api/ticket/<project>/<id>). The hub's one action is POST /api/open-in-orca, which runs orca terminal switch for a live terminal; it sends no text to a terminal, changes no run state and steers no agent.",
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
      "Unloads and deletes the LaunchAgents dev.ark.hub and dev.ark.proxy, so the hub stops and neither starts at login. It does not stop the shared portless proxy: that keeps running until you run `portless proxy stop`. It does nothing, and exits 0, when neither agent is installed.",
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
