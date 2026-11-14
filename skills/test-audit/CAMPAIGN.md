# Test audit campaign

Credit: adapted into Ark words from OpenClaw's test-audit skill, <https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md>. MIT License, Copyright 2026 OpenClaw Foundation.

A run lead reads this file when the ticket names a test audit campaign. A campaign prunes the tests of one project in lanes, and proves that no contract was lost. It is an ordinary Ark run: a `plan.yml` with steps whose roles are `implementer`, `validator` and `reviewer`. There is no ledger role. Read [references/audit.md](references/audit.md) first: it defines the marks, the junk patterns, the retention bar and the time rules that this file uses.

## Plan shape

| Step (name it for its work)        | Role        | What it does                                                                              |
| ---------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `baseline`                         | implementer | Commits the baseline snapshot (section 1).                                                |
| `ledger-<lane>`, one for each lane | reviewer    | Writes the ledger of its lane. Read-only (section 2).                                     |
| `keepers`                          | implementer | Lays out the layer plan: one keeper for each contract (section 3).                        |
| `cutover`                          | implementer | Deletes, merges and renames tests, and writes the test case entries (section 4).          |
| `preservation-review`              | reviewer    | Checks that no contract was lost (section 5).                                             |
| `break-restore`                    | implementer | Breaks each production owner once, shows the keeper red, restores the source (section 6). |

Order them with `needs`: the ledgers need `baseline`; `keepers` needs every ledger; `cutover` needs `keepers`; `preservation-review` needs `cutover`; `break-restore` needs `cutover`. A validator step is optional: a campaign adds no new test, and the criteria that it serves are proved by the `manual` gate answer `ok` and their evidence files, not by a test.

## 1. Baseline

Do this before any lane starts.

1. The `baseline` implementer step runs `ark test-audit inventory --project <name> --json` and commits the rows as one file under `test/` (for example `test/audit-baseline.json`). It is a scratch file: the `cutover` step deletes it. The commit is also what lets a ledger step close (section 2).
2. The run lead runs the full `ark test <run>` once at this head, which is the base plus the snapshot. It prints the failing files that are red on main (`red on main` lines, and `red_on_main` in the `test.completed` event) and writes `results/<suite>.report`. A suite that is not `parser: bun` is not in the inventory: the ledger worker of its lane inventories it by hand (`references/audit.md`, section 2).
3. A baseline failure is a likely product bug (the retention bar). The run does not fix it and does not delete its test. See section 7.

## 2. Ledger workers, one for each lane

A lane is a suite, a folder of tests, or a contract area, sized so that one worker can read it. Plan one `reviewer` step for each lane, and put the names of its files and its suite in its `goal`. The worker applies `references/audit.md` to its lane and edits no file.

It writes its ledger into `findings/<step>.md`. The file is a ledger, not a code review: it drops the `Reviewed head:` line that `worker.md` asks for, and holds:

- the ledger table of `references/audit.md`, section 7, with no extra `#` heading;
- the line `No findings.` (the ledger is not a list of defects; the run lead reads the table);
- the `## Merge risk` block, with a `- Not in plan: <path> — <reason>` line for any changed file no step lists;
- a last line `Verdict: approve` when the ledger has a row for every declaration of the lane, or `Verdict: reject` when it does not.

`ark run step ... finish` refuses a succeeded review whose range has no commit. The range starts at the `Reviewed head:` of the newest findings file of any reviewer step of the repo, or at the run's base when no file has one. A ledger file with that line would move the range of every other ledger step to its head, and a step whose range is empty is refused. Without the line each ledger step keeps the range from the base, and the `baseline` commit is in it: that is why each ledger step needs `baseline`. Never close a ledger step with `--failed` to get around the refusal: `--failed` says the review did not happen. The `preservation-review` step writes the normal form, with `Reviewed head:`.

A ledger step writes `time unknown` for a file with no report time. It never edits the test case entries; the cutover step does.

## 3. Layer plan: one keeper for each contract

The `keepers` implementer step reads every ledger and writes `<run folder>/findings/keepers.md` (a file the run lead reads; it is not a review). For each contract it names exactly one keeper: the test at the strongest boundary that is practical (one process on fixture files beats a mock; a real integration beats a unit test of a private function). Every `C` row of a ledger names a keeper that exists in this file or in a row marked `R` or `F`. A contract with two keepers, or a `C` row whose keeper is itself marked `C` or `D`, is a defect: fix the file.

## 4. Cutover

The `cutover` implementer step applies the ledgers, one lane at a time, and runs the project checks (`checks` in `ark.yml`) before each commit, as the worker playbook says. A campaign touches test files in bulk, so conversion on touch applies to every kept test. The ledger marks map to the `test_cases` entries of `plan.yml`:

| Mark | `test_cases` action | Needs                                                                                               |
| ---- | ------------------- | --------------------------------------------------------------------------------------------------- |
| R    | `reuse`             | The case entry exists. A test with an old AC id gets a case id (below).                             |
| F    | `update`            | `given`, `when`, `then` and `expected`; the title keeps or gets the case id.                        |
| C    | `retire`            | A `reason` that names the keeper's case id. The entry stays in `test/cases/` with status `retired`. |
| D    | `retire`            | A `reason`. The entry stays with status `retired`.                                                  |

A retained test gets a case id. A kept test with an old AC id (`ARK-<n>-AC<k>` in its title) needs a case: run `ark test-case new <KEY> --run <run>`, write the entry, and rename the test title to start with the case id. `ark test-case new` allocates under a lock, so several workers can run it at once. The plan's `test_cases` list will be long; the run lead writes every entry before the plan gate, from the ledgers, so that the reviewer does not reject a touched case that the plan misses. When the lanes are too many for one plan, cut the campaign into chained tickets.

`cutover` also deletes the baseline snapshot, and commits its tests and any evidence files before the last `ark test <run>`: a later commit makes the test head stale.

## 5. Preservation review

The `preservation-review` step is a `reviewer` step. List what the cutover changed with the inventory, not with a diff grep:

```sh
ark test-audit inventory --project <name> --changed <base>
```

It lists each declaration the diff changed and prints `old id touched:` for each one with an old AC id. For each deleted or merged test the reviewer finds its ledger row and checks that the mark is `C` or `D`, that a `C` row's keeper still exists in the tree and tests the contract, and that a `D` row names a junk pattern with its line. A deleted test with no row, a keeper that was deleted, or a `D` that protects a retention-bar contract is a P1 finding.

Cross-vendor: a plan step's `harness` and `model` must equal a pair in `roles` in `ark.yml`. A campaign review should use a vendor other than the implementer's. When the project's `roles.reviewer` is on the implementer's vendor, the review is not cross-vendor: say so in the plan summary, as `run-lead.md` already asks. A project that wants the cross-vendor review needs a second vendor in `roles.reviewer`.

## 6. Break and restore

No `ark` command records a break and restore. `ark test` runs the latest commit only, and uncommitted code counts for nothing. So a break is never made in the run's worktree and never counted by `ark test`. The `break-restore` implementer step does this in a scratch clone, for each contract whose test the run deleted (a `C` or `D` row for a contract; one break for each contract, not for each test):

1. `git clone --shared --no-checkout <your worktree> <run folder>/scratch/<name>`, then `git -C <run folder>/scratch/<name> checkout --detach <head>`. Never run `git worktree add`.
2. Break the production owner that the ledger row names, in the clone: one small change that the keeper must catch (invert a condition, return early, drop a field).
3. Run only the keeper's test file, with the suite's `command` from `ark.yml` (`base_command` with `{files}` shows how a file is selected), not the whole suite. The suites run under a CPU and memory budget; a break for each contract on a whole suite costs too much. The keeper must be red, and red for the contract: read the failure message.
4. Restore the owner byte for byte: `git -C <scratch> checkout -- <owner file>`. Prove it: `git -C <scratch> diff --exit-code -- <owner file>` exits 0, and `shasum <owner file>` equals the hash of the file at head. A commit then a revert does not prove it unless the same check passes.
5. Record the break in `results/evidence/<AC id>.md`, the file that the `manual` gate reads, for the criterion that asks for it, in its `inspection` form (Files, Checked against, Verdict). For each contract write the owner `path:line`, the break in one line, the keeper's file and case id, the command, the last lines of the red output, and the hashes before and after.
6. Remove the scratch clone.

Only an implementer step does this: a reviewer edits nothing, and a validator writes only tests. A contract with no red keeper is not preserved: the run lead sends the work back to `cutover` to restore the deleted test, or to name a better keeper.

## 7. Baseline failures

A failure in the baseline is written as a proposed bug ticket and is never fixed in the campaign run. The source of the list is `red_on_main` in the `test.completed` event of the section 1 run, and the `red on main` lines of its output.

- The run lead writes one ticket file for each baseline failure: `~/.ark/projects/<project>/tickets/<KEY>-<n>.md`, with the next number above the highest `<KEY>-*.md` in that folder, `status: proposed`, `kind: bug`, and the front matter of `skills/ark/playbooks/brainstorm.md` (section "Ticket format"). The run lead names the file in its report to Master Chief.
- A red test file that the run's own commits do not touch is not counted by `ark test`: leave the file out of every lane's cutover. A run that touches a red test counts its failure, so `ark test` fails on a product bug the run must not fix. When a lane cannot avoid the file, close the run with a recorded exception through the escalation gate; never fix the product in the run.
- A ledger row for it reads `R` with `baseline red`.
