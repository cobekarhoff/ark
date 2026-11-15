---
id: ARK-T680
title: ARK-T680 a body still over the GitHub limit with no log lines collapses its case blocks to one line each and its Deleted bullets to one line, and open posts it under the limit
level: integration
technique: boundary values (body at log keep 0 of 65,536 stays whole in ARK-T681; of 65,537 collapses), equivalence classes of the Deleted input (369 / 0 / absent) and a state transition (log tails cut first, then the collapse), on a 276-case plan with 369 deleted tests
priority: high
risk: "ark merge-request open refuses a plan of 276 cases with many deleted tests because the body is still over 65,536 characters after the log tails are cut (the 106,916-character body of 2026-11-14-ARK-386-1); or the collapse drops a case id, so plan membership is hidden; or it cuts or drops an AC evidence file; or it starts at `>=` or before the log tails are cut to none, so ARK-T364 breaks; or the collapsed line loses the `ID: base X, head Y @ sha` claim, so lint EVID03 skips and EVID01 warns; or the lines are plain text, so SIZE01 counts them as prose and refuses the MR; or the body no longer says why the blocks are gone; or the Deleted line names no count, or a path that is no file (the open path, the refresh of an open MR and `gather.ts` all post this text), or the collapsed form prints a Deleted line for 0 deleted tests or for an old or quick run"
status: active
changed_by: 2026-11-14-ARK-507-1
---

## Objective

Prove that when the body is still longer than `githubBodyLimit` at log keep 0 (case block with the result only), `ark merge-request open` posts a body of at most 65,536 characters in which each plan case is one line (case id, status, path of its evidence), the Deleted bullets are one line with the count, the path `events.ndjson` of the run folder and the words that the full list is the `deleted` field of its last `test.completed` event, and every case id and every AC evidence file is still in the body. Serves ARK-507/AC1. No file is written for the list: the path names the run's own `events.ndjson`, which exists before `open` and before `gather.ts`. Red at base: the body is over the limit at keep 0, so the base body is over 65,536 and `open` refuses it.

## Preconditions

- A shippable GitHub fixture as in ARK-T200: temporary `ARK_HOME`, project, git repo with a bare `origin`, a fake `gh` on `PATH` that records each `gh pr create` call and its body file, ACs passing, heads current. Real `events.ndjson`, real ledger reader, real `buildBody`, no mocked ledger.
- The ticket is `kind: bug`. Every plan case has `base fail` and `head pass` in its `result.json`, so each collapsed line holds `` `ID`: base fail, head pass @ sha ``. The five AC evidence files hold no `base fail` and no `head pass` text, so only the collapsed case lines can satisfy EVID01.
- A `plan.yml` whose `test_cases` lists 276 cases. Their ids mix 1-digit to 4-digit numbers. 275 have `results/evidence/<id>/{base,head}/result.json` and a 20-line `head/command.log` of short lines (no `secretLike` word). One plan case has no evidence folder.
- 20 more evidence folders for cases that the plan does not name.
- Five AC evidence files, `results/evidence/AC1.md` to `AC5.md`, of about 4,600 characters each (about 23,000 in all), with no `secretLike` word.
- The last `test.completed` in the run folder's `events.ndjson` is `mode: full` with 369 deleted tests, each with a file and a title of about 100 characters, some titles holding backticks and a pipe.
- Sizes are fixed so that the body at log keep 0 is over 65,536 characters (the validator measures it at base and records the number in the test). A fixture whose body fits at keep 0 is not this case: it passes at base.
- Fixture B, for the empty Deleted line: the 276-case plan and the evidence of fixture A, with the last `test.completed` holding `deleted: []` (0 deleted) and `baseSkipped` set. The `ticket.md` problem text is padded so that the body at keep 0 is over 65,536 characters. Fixture C is the same with a last `test.completed` that has no `deleted` and no `baseSkipped` field (an old or quick run), padded the same way.
- Fixture D, for the boundary at 65,537: the plan, the evidence and the problem text padding of ARK-T364, with 150 plan cases and the five AC evidence files shrunk to about 400 characters each, and 4 deleted tests in place of 369. Those drops and the shrinks bring the body at keep 0 to well under 65,537 before padding. Then the `ticket.md` problem text is padded, as in ARK-T364, so that the body at keep 0 is exactly 65,537 characters. It is built with the real ledger reader and `buildBody`. Padding only adds characters, so the starting body is below 65,537 by design.

## Steps

1. Copy the last `test.completed` line of the run's `events.ndjson` (fixture A). Run `ark merge-request open <run>` on fixture A (276 cases, 369 deleted tests) and read the body from the recorded `gh pr create` call.
2. Measure the posted body length. Find the line of each of the 276 plan case ids, the `<details>` blocks, the `Log (last` label, the `  - Deleted:` bullets, the Tests line, the Deleted line and the note about the collapse.
3. Compare each `results/evidence/AC<n>.md` text with its block in the body.
4. Read the path named in the Deleted line: it is `events.ndjson` of the run folder. Check that the file exists and that its last `test.completed` line is the line copied before step 1 and holds all 369 entries in `deleted`. The whole file is not compared: `open` appends `merge_request.opened` to it.
5. Run `lintBody` over the body with the ledger.
6. Build the body twice from the same events and compare.
7. Run the real `skills/pr-writing/scripts/gather.ts --run-dir <run folder>` from the repo of fixture A and read `.pr-writing/body.md`. Compare its Deleted line with the one of step 2 and open the path it names.
8. Change the ledger of fixture A so the body differs: rewrite the `head/result.json` of one plan case with a new sha (a changed head), keeping the 276 cases and the 369 deleted tests. Run `ark merge-request open <run>` again with the fake `gh` reporting the PR as open with the body of step 1 (the refresh of an open MR), and read the body of the recorded update call. The body must differ from the open MR body, or no update is recorded (`action: unchanged`).
9. Build the body of fixtures B and C and find the Tests line and any Deleted line.
10. Build the body of fixture D and measure it before and after the collapse.

## Expected results

- `open` shall finish with exit 0 and post one body of at most `githubBodyLimit` characters. At base it fails because the body is longer than the limit.
- When the body at log keep 0 is over `githubBodyLimit`, the body shall have exactly one `- ` list line for each of the 275 plan cases with evidence, holding the case id, the claim `` `ID`: base fail, head pass @ sha `` and the path `results/evidence/<id>/`, and no per-case `<details>` block and no `Log (last` label. The plan case with no evidence folder and the 20 cases that the plan does not name shall have no line, as before this change.
- The body shall have no `  - Deleted:` bullet. It shall have one Deleted line with the count 369, the path `events.ndjson` and the words that the full list is the `deleted` field of its last `test.completed` event. The file at that path shall exist, and its last `test.completed` line shall equal the line copied before step 1 and hold all 369 deleted tests. The Tests line with the passed, skipped and deleted counts shall stay.
- The body shall hold each of `AC1.md` to `AC5.md` whole, in its own block.
- The body shall carry one note that says the per-case blocks and the Deleted bullets were collapsed to fit the limit. The note shall not read as a test case claim and shall name no screenshot path.
- The body that `gather.ts` writes shall be equal to the body of step 1 and shall name the same existing file in the Deleted line. The refresh of an open MR (step 8) shall record one update, and its body shall follow the same collapse rules: one line for each plan case with evidence, one Deleted line with the count 369 and the same path, no `  - Deleted:` bullet, each of `AC1.md` to `AC5.md` whole, and at most `githubBodyLimit` characters. Its line for the changed case shall show the new sha. It is not compared with the body of step 1, which it differs from by design.
- For fixture B (0 deleted tests) and fixture C (no `deleted` field, an old or quick run), the collapsed body shall have no Deleted line and no `  - Deleted:` bullet, and shall name no path for a list. The Tests line shall stay as today: `0 deleted` for B, and `(no base count, deleted not counted)` for C. The case lines and the note shall be as in fixture A, and the body shall be at most 65,536 characters.
- When the body at keep 0 is exactly 65,537 characters (fixture D), the body shall collapse and be at most 65,536 characters. The case at exactly 65,536 is ARK-T681.
- `lintBody` shall report no failure: EVID03 shall match the claim of each case line, SIZE01 shall not count the lines as prose, EVID04 shall pass, and EVID01 (kind bug) shall give no warning, because `base fail` and `head pass` appear only in the collapsed case lines.
- Two builds from the same events shall give identical bodies.

## Screenshot checkpoints

none: the proof is the Markdown text of the MR body; the collapsed lines name no image.
