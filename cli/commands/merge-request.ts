import {
  bumpRefresh,
  mergeRequestCheck,
  mergeRequestOpen,
  mergeRequestStatus,
} from "../merge-request.ts";
import type { Command } from "./types.ts";

export const mergeRequestOpenCommand: Command = {
  usage: "merge-request open <run> [--summary <text>] [--project <name>]",
  description:
    "Pushes each repo's branch and posts one ready MR (not Draft) for each repo, in merge order: the order of the `repos` graph of plan.yml, upstream first. A plan with no `repos` block (an old plan) takes the order from step `needs`. Each `merge_request.opened` event has the fields `order` (the place of its repo in the merge order) and `waits_for` (the upstream repos whose MRs it waits for). Title and body come from the run: the title is `<ticket id>: <summary>`, 72 characters or less in total, where `summary` is the ticket's `summary:` field, else the ticket title, each used only when the whole title fits, else the text of `--summary`; with none it exits 1 before any push with `ticket has no summary: pass --summary`. A `pr_writing.title_prefix` rule in ark.yml wins over that form. The body is written from the run folder and linted before the push, and a lint `fail` refuses. The plan gate answer is the go-ahead: no confirm flag. A repo that already has an open MR gets the new head pushed and the text between `<!-- pr-writing:begin -->` and `<!-- pr-writing:end -->` in its body replaced; text outside the markers stays, an old body with no markers is rewritten whole once and the output says so, a body that did not change is left alone, and a merged or closed MR is skipped. Run it again after each post-MR round. It refuses, with exit 1 and before any push, when a repo head changed since the last test, and ends the error with `run ark test <run> again`. It also refuses, before any push, when a criterion with `manual: true` has no manual ok, and names each one. The MR targets `repos.<repo>.base` when ark.yml sets it (`--base <base>` on GitHub, `--target-branch <base>` on GitLab), else the branch origin/HEAD names. No command merges. For a project with `merge_requests: none` in ark.yml it exits 1 before any command runs and prints `project <project> has merge_requests: none: close the run with ark run close <run> handed_off`. It also refuses, before any push, when a non-manual AC is not `passing` in the last test (it names each), when a string in backticks in an AC text is in no tracked file of a run worktree at HEAD (it names the AC and the string; Only a string a file can hold counts: not one with a placeholder (`<`), a `*`, `...`, a `:<line>` suffix or the id of its own AC, and no string of a manual AC. A string also passes when it names a tracked file or folder at HEAD (one trailing `/` is dropped; an empty path never counts). A string that starts with `not:` is a removed string: it must be in no tracked file and name no tracked path, and the refusal names it without the prefix.), for `kind: perf` when `results/baseline.md` or `results/compare.md` is missing or empty, and for a `kind: refactor` run with a `method: test` AC unless `base_passed` is true. Last, it checks the evidence and refuses, before any push and before any event, with `refused: evidence is not complete` and one line for each AC or case that fails. A non-test AC needs one file `results/evidence/<AC id>.md` in the run folder (`<AC id>` is the local id such as `AC6`; an old `manual: true` AC reads as `demonstration`). The line is `evidence missing: <AC id> (<method>)` for a missing file and `evidence malformed: <AC id>: <reason>` for a file without a section of its method, naming it. `demonstration`: the sections What the human did, What the human saw, Before and After (each with a screenshot path, checked for shape, not for existence), and the last line `human: ok`, which `ark gate record <run> manual <AC id> ok` writes. `inspection`: the sections Files (each `path:start-end`), Checked against and Verdict, with the line `reviewer: pass` or `reviewer: fail`. `analysis`: the sections Command, Output, Threshold and Result, each given for Base and for Head. For an AC with `method: test`, each case in its `verified_by` needs `results/evidence/<test case id>/base/` and `head/` (`test evidence missing: <AC id> <test case id> (<base|head>)`), and the commit SHA in the `head` `result.json` must be the current head of a repo of the run (`test evidence stale: <AC id> <test case id>`). An AC with no `verified_by` needs no test evidence. Then it runs the security scan, before any push or event, and on every call, also the refresh of an open MR: gitleaks (`--redact`) on the commits that the run branch added (`--first-parent --no-merges <base>..HEAD`, so a commit merged in from the target is not scanned), and osv-scanner on each lockfile of the head, with its licences. It refuses with `refused: security scan found <n> problems` and one line for each finding, `secret: <rule> in <file>:<line> (commit <8 characters>)` or `vulnerability: <id> <SEVERITY>, <package> <version>, <lockfile>`, for a secret and for a high or critical vulnerability, also one that the base already has, and never prints a secret value. A finding that `security.accepted` of ark.yml lists (`id` and `reason`; `id` is the vulnerability id, one of its aliases, or the gitleaks fingerprint `<commit>:<file>:<rule>:<line>`) does not block. A `.gitleaks.toml`, `.gitleaksignore` or `gitleaks:allow` in the run branch has no effect: gitleaks scans a clone of the branch with no working tree, the `.gitleaks.toml` of the base applies, and a relative `extend.path` in it is not supported; `security.accepted` is the way to accept a finding. A scanner that exits with an unexpected code, prints a report that cannot be read or cannot reach the network (osv-scanner needs osv.dev and deps.dev) refuses with its stderr: a failed scan never reads as clean. When gitleaks or osv-scanner is not installed it refuses first, with the lines that `ark status` prints (`scanner: <tool> is not installed: brew install <tool>`), whatever the repo holds. Medium and low vulnerabilities, accepted findings and the licences of the packages that are new at the head against the base lockfile do not block: the body lists them in a `Security` section (`**Security**` at tier 0), and no section when there is nothing to list. Before any push, lint or event it runs `git fetch origin` and `git merge-tree --write-tree HEAD origin/<target>` in each repo it pushes, a new MR or an open one it refreshes (changing no file and no ref), and refuses when the head does not merge cleanly: it names the repo, records worktree.synced with a conflict so that `ark run step <run> <step> start --merge` is allowed, and pushes nothing for any repo. A merge-tree error that is not a conflict (no common history, no origin/<target>, git older than 2.38) is a refusal that shows git's text.",
  flags: { "--summary": true, "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([runId], flags) =>
    mergeRequestOpen(runId, flags["--project"] as string | undefined, {
      summary: flags["--summary"] as string | undefined,
    }),
};

export const mergeRequestCheckCommand: Command = {
  usage:
    "merge-request check <run> --stage <head|step|final> [--step <id>] [--summary <text>] [--project <name>]",
  description:
    "Prints each problem that `ark merge-request open` would refuse, one line for each, and exits 1 when any exists; with none it prints nothing and exits 0. It changes no file, event or ref and never fetches. The text of a line is the text of the open refusal, and the AC strings are the one joined line `AC string in no tracked file at head: <AC id> `<string>`; ...`. `--stage head` checks what needs only the current head: each backticked AC string against the tracked files, the MR title (`ticket has no summary: pass --summary`, or the title of 73 characters or more that `--summary` makes), and the shape of each evidence file that exists, except the last line `human: ok` of a demonstration file and the `reviewer:` line of an inspection file. `--stage step` adds `evidence missing: <AC id> (<method>)` for each non-test AC that the plan step named by `--step <id>` serves, or for every non-test AC when no `--step` is given. `--stage final` adds every other refusal of open, in its order: no test result, a quick test, a manual criterion without ok, criteria not passing, a repo that changed since the last test, the `perf` and `refactor` rules, and every evidence problem including the last lines, each on its own line, then the refusal of the security scan (a missing scanner, a secret, a high or critical vulnerability) as one message; the scan runs gitleaks and osv-scanner, which needs the network. In stage `final` it also prints `warning: manual answer older than head: <AC id>` for a manual answer whose recorded head differs from the repo head now (a clean `ark worktree sync` merge is not a difference; an answer with no recorded head never warns); a warning does not change the exit code. `--summary` is the `--summary` of `ark merge-request open`.",
  flags: { "--stage": true, "--step": true, "--summary": true, "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([runId], flags) =>
    mergeRequestCheck(runId, flags["--project"] as string | undefined, {
      stage: flags["--stage"] as string | undefined,
      step: flags["--step"] as string | undefined,
      summary: flags["--summary"] as string | undefined,
    }),
};

export const mergeRequestStatusCommand: Command = {
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
};

export const bumpRefreshCommand: Command = {
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
};
