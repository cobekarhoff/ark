# Review panel spike: would a second reviewer model have caught the escaped defects?

Run ARK-349, replays done on 2026-11-07 with omp v18.16.0, in two rounds. **Question:** Ark reviews each change with one model (`openai-codex/gpt-6.1-sol`). Five reviews let a defect reach main (`reviewer: missed` in `escaped-defects.yml`). Would a second model, on the same prompt, have caught them?

Round 1 gave the models no diff, only a command to produce it (section 3). Round 2 (sections 1, 2 and 4) gives every review the pinned diff as a read-only file. Round 2 is the measured result. Round 1 stays as a labelled baseline.

**Answer: no panel for now, but the answer is closer than round 1 suggested.** Under a strict rule (a hit names the escaped defect's own mechanism), the 24 round 2 reviews found **2 of the 5 defects**: ARK-181 (3 of 24 reviews: `gpt-6.1-sol` twice, `claude-opus-5-5` once) and ARK-310 gap 2 (1 of 24 reviews: `claude-opus-5-5` review 2, ranked P1). `gpt-6.1-sol` alone found 1 of 5 and `claude-opus-5-5` alone found 2 of 5, so the panel found nothing that `claude-opus-5-5` alone did not. On the ARK-213 control, which the real reviewer found, `claude-opus-5-5` found it in 2 of 2 reviews (ranked P3) and `gpt-6.1-sol` in 0 of 2. Three defects (ARK-217, ARK-309, ARK-310 gap 1) were found by none of the 24. A panel of the two models would cost about $2.5 to $3.6 more per run (+45% to +64% of the mean run cost). The recommendation is **no always-on panel** (section 4), with the one finding that `claude-opus-5-5` is the stronger reviewer on this sample, and a 5.6 times higher price.

Three limits shape every number below: five defects, two repeats per model, and reviewers with no shell (section 1.4). Read the result as "a possible gain on 1 defect of 5", not as proof that a panel helps or cannot help.

## 1. What was replayed

### 1.1 The six reviews

Each row is one review step of a past run, rebuilt from the run's `events.ndjson` and its `ark/ARK-<n>-*` branch. The old run workspaces are deleted, so the diffs come from the branches.

| #   | Run                  | Escaped defect (ticket)                                                                                                                                                     | Review step                | Base                                       | Head                                       | Diff `base..head`     |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------ | ------------------------------------------ | --------------------- |
| 1   | 2026-11-01-ARK-179-1 | ARK-217: a plan gate wait counted from the last `plan.checked`, so a one-hour wait showed 0.025 s (`gateWaits`, `cli/retro.ts:209`)                                         | `run-detail-review`        | `b9dcf9ace5b4607cfdddceb64711e0877e0bba2d` | `bf22bd7d0da167a5f325c3e4e05a8db5288898b0` | 21 files, +3307 −59   |
| 2   | 2026-11-01-ARK-181-1 | ARK-181: the ARK-181-AC6 metrics fixtures were dated 2026-10-29, so the current-week view showed none (`test/hub-views.test.ts:606,610`)                                    | `hub-views-review`         | `474281d235272b8c8477be6c84dbdafac6207d55` | `31807ef4813e1e602107d25341b7605b1155e51f` | 22 files, +4863 −301  |
| 3   | 2026-11-04-ARK-291-1 | ARK-309: roadmap graph chip clipped and project switcher missing on some states; the ARK-291-AC9 scroll test measured before every source loaded (`test/pw/hub.pw.ts:3040`) | `hub-roadmap-review`       | `eb0c047264ba2c3bbb2fb141ee5134ab0a1567ab` | `56b41b0190e97a9c4803bee3e9e6c79b55f38c33` | 57 files, +10040 −707 |
| 4   | 2026-11-03-ARK-186-1 | ARK-310 gap 2: `same_vendor_review` read true when omp ran a sonnet sub-session inside a codex review step (`cli/retro.ts:568-573,597`)                                     | `retro-models-review`      | `fb373c2b37cd0fcf49762843bce398414c6d519f` | `d44e5df5309f4019efe3dd1ed092a7ebe9d50807` | 5 files, +260 −4      |
| 5   | 2026-11-04-ARK-306-1 | ARK-310 gap 1: `ark chief state` said "no live run lead" for a structured worker whose liveness could not be checked, and printed blank task titles (`cli/chief.ts:121`)    | `paged-orca-reader-review` | `3b268c804d4bdc579e24ba98bd3c95777fd989e9` | `6490f58aef8df2cdfc4c400429a98ce8a0c02c11` | 31 files, +1370 −163  |
| 6   | 2026-11-01-ARK-178-1 | Control, ARK-213: a failed `launchctl load` on update deleted the working plist (`cli/ui.ts:195-200`). The reviewer found it as P1 and the run lead left it as P2           | `hub-notifications-review` | `b9dcf9ace5b4607cfdddceb64711e0877e0bba2d` | `8cdd3cded401b58e766b8ca0e09395ba0e13ebae` | 12 files, +896 −16    |

The defect is present at the head of rows 1, 2, 4, 5 and 6, and I read the line cited in each at head. Row 3 holds only half of it (see the ARK-291 discrepancy below). The escaped-defect notes and the fix commits are in `~/.ark/projects/ark/escaped-defects.yml`. The fixes, from git in the Ark repo: ARK-217 `76e2cbf` (adds `keepFirst` to `ask("plan", …)`), ARK-181 `0ba317a` (dates the fixtures at now), ARK-213 `6e4bd35` (restores the old plist after a failed load), ARK-309 `6aad77c` (adds the `stale-label` wait to the AC9 test) and ARK-310 `a066f44` and `8907cb3` (mixed review vendors, helper calls ignored for models, structured leads and titles in `chief state`).

### 1.2 Which diff counts: the pin rule

1. A review step is one `step.started` of role reviewer. For a run with several rounds, the reviewed diff is that of the **last review round before merge**, the review that let the defect through.
2. **Head** = the last commit of the branch's first-parent chain whose committer time is at or before the `step.started` time of that round. **Base** = the `base` of the run's `worktree.created` event.
3. The replay uses the full diff `base..head`, even when the real round re-read only the change since the last reviewed head. A model must have the chance to see the defect, and a delta-only prompt could not catch a defect from an earlier round. No "last reviewed head" line is in any prompt.
4. The head must not contain the fix commit of that run's own defect. Each scratch checkout was built with `git init` plus `git fetch` of the head only, no remotes, reflog expired and gc pruned, so it holds only the ancestors of the head. The own fix commit is absent in rows 1, 2, 4, 5 and 6.

Evidence for each pick (event times, commit times, branch tips) is in `results/spike/pins.md` of the run folder.

**ARK-291 discrepancy.** `escaped-defects.yml` names `1f3f9fd` as the fix of the ARK-309 defect. That commit is an implementer commit from round 2 (14:15:09Z). It is an ancestor of every reviewed head and was made before the first reviewer step started, so rule 4 cannot be met: no reviewed diff holds the chip and switcher defect. What the head still holds is the second half of the note: the `ARK-291-AC9` Playwright test has no `await expect(page.getByTestId("stale-label")).toHaveCount(0)` before it measures the scroll (`stale-label` appears in `test/pw/hub.pw.ts` only at `:191`, `:585` and `:2309`, outside the AC9 test that starts at `:3004`). Its fix is `6aad77c`, so I judged row 3 against `6aad77c`. Only that half of the defect could be found in this diff. Row 3 also differs from the others because the final round of the real run did find something else (a P1 on a legacy `#/backlog?project=` link).

Not recoverable: the exact worker spec the run lead sent. It is rebuilt from the run-lead playbook's template (see 1.3).

### 1.3 The prompt

The prompt is the same for every model. For one run it is these parts, in this order:

1. The step spec: `/skill:ark worker <run> <step>`, then `You are the REVIEWER for step <step> of run <run>.`, then `UI skills: <skills of plan.yml>` for the three runs whose step had a skills list (291, 186, 306).
2. A short "Replay environment" block, the same text for every model; only the paths and the shas change (below). It names the **diff file** (see 1.5).
3. The reviewer section of `worker.md`, from the installed Ark plugin (`skills/ark/playbooks/worker.md` of the Ark repo, HEAD `3fb5e81e134348dd9ea4070b9c6ce61f8180a040`, the file last changed in `14f5cea356190c362657fcb8f2937c1e4d443c2a` on 2026-11-06). The six runs were reviewed with older versions of that section; the current one is used for all six. The text is in `results/spike/reviewer-section.md`.
4. The run's `ticket.md`.
5. The run's `plan.md`.

Left out on purpose, because each would reveal a defect or the model: findings files, `retro.md`, `plan.yml` (its model field names the reviewer), `events.ndjson` and `escaped-defects.yml`. No prompt names or hints at the defect. Round 2 prompts are in `results/spike/prompts-diff/<run>.md` (225 to 370 lines each, plus the replay sentence below); the round 1 prompts are the same files without that sentence (`results/spike/prompts/<run>.md`).

The replay environment text of round 2, with `<…>` filled per run. The last sentence is new in round 2:

> Your working folder is the checkout `<scratch checkout>` (git repo, branch `review`, HEAD = `<head>`). The run base commit is `<base>` (branch `base`). The diff to review is `git diff $(git merge-base HEAD base)..HEAD`. That diff is already generated as the read-only file `<scratch checkout>/.review/diff.patch` (unified diff, base to HEAD, complete): it is the diff to review. Read it with the `read` tool, in ranges if it is long, and use the checkout for the surrounding code. There is no run folder, no `events.ndjson` and no `plan.yml`: the text of `plan.md` and `ticket.md` is below. Treat the checkout as read-only: do not edit, commit, stash, reset or checkout. Instead of writing a findings file, print the findings file content as your final answer, in the format of the Reviewer section (`Reviewed head: <sha>` first, findings, `## Merge risk`, `Verdict:` line).

### 1.4 How the models ran

Command, run from the scratch checkout of each review (proven on omp v18.16.0 in `results/spike/omp-command.md`; round 2 uses the same command and caps, with `--max-time 20m --max-cost 8`, 4 reviews in parallel, driver `results/spike/drive-diff.py`, output in `results/spike/replays-diff/`):

```sh
omp --model <provider/model> --mode json -p @<prompt file> \
    --tools read,grep,find,glob --thinking medium \
    --no-lsp --no-extensions --no-title \
    --session-dir <out dir>/<run>-<model>-<n>
```

- **Thinking level:** `medium`, the same for both models. omp's output stream does not record the level, so this is what the command line set.
- **Tools:** `read`, `grep`, `find`, `glob` only. The streams of the 24 round 2 reviews show 431 `read`, 155 `grep`, 44 `glob` and 17 `find` calls and nothing else. Every one of the 24 reviews read `.review/diff.patch` (2 to 17 `read` calls on it each), so the diff reached every reviewer.
- **No bash.** omp has no read-only sandbox for a shell, so no model could run the tests or any repro command. Most reviews say so in their own text. The playbook says a P0 or P1 needs a repro command with quoted output, so a no-shell reviewer would file findings as P2; 9 of the 112 findings are ranked P1 anyway (each with a repro line the reviewer could not run), 75 are P2 and 28 are P3. **Findings were capped at what a reviewer without a shell can claim.** This is stricter than a real review step, which can run the tests.
- **Other differences from a real step:** `skills/ark/principles.md` is not in the scratch checkouts, so no finding names a principle; there is no run folder, so the reviewer reads the plan text from the prompt; skills (`read skill://<name>`) stay enabled; the playbook version is the current one (1.3).
- **Real model:** each turn of the omp stream records the provider and model that answered. All 24 reviews show only the model that was asked for, so no sub-session or fallback model ran. Tokens and cost are the sums over the turns of each stream (`usage.totalTokens` and `usage.cost.total`; the token count includes cache reads). omp computes the cost from token prices; whether `openai-codex` usage is billed is outside the stream. Wall time is from the shell. All 24 exited 0 at the first attempt.
- **ARK-213 control:** the real review of run 178 found the defect as P1 with a shell. The replay of that same diff is the check that the setup can find a defect at all.

### 1.5 The diff file

For each of the six reviews the diff was generated with `git diff --no-color base..review` in the scratch checkout, outside any model session, and written to `<scratch checkout>/.review/diff.patch` with mode 0444 in a read-only folder. `.review/` is in the checkout's `.git/info/exclude`, so it is in no commit, and its name does not hint at a defect. The merge base of `review` and `base` equals `base` in all six checkouts, so the file is the same diff as the playbook's `git diff $(git merge-base HEAD base)..HEAD`. Lengths: run 178 1,140 lines, 179 3,873, 181 5,649, 186 344, 291 12,247, 306 2,123. The file holds the content merged from main into each run branch, as in the real review.

## 2. Models tried and what they found

### 2.1 Models

| Model                                       | Role                       | Result                                                                                       |
| ------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `openai-codex/gpt-6.1-sol`                  | control (today's reviewer) | ran, 2 reviews on each of the 6 diffs with the diff file (12); 12 more in round 1 without it |
| `anthropic/claude-opus-5-5`                 | second vendor              | ran, 2 reviews on each of the 6 diffs with the diff file (12); 12 more in round 1 without it |
| `opencode-go/beam-free`                     | third vendor, tried        | does not work: `401 api_key_expired`                                                         |
| `openrouter/~anthropic/claude-fable-latest` | third vendor, tried        | does not work: `401 User not found`                                                          |

A third vendor was not added. I tried the first model that `omp models --json` lists for each of the other two providers (`opencode-go`, `openrouter`). The commands, run from `/tmp` on this host (the unrelated Atlassian MCP warning line is dropped):

```text
$ omp --model opencode-go/beam-free -p "reply with the word ok" --no-session
401 This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store. Signing in again will not renew this key. (type=authentication_error param=api_key_expired)
exit=1

$ omp --model 'openrouter/~anthropic/claude-fable-latest' -p "reply with the word ok" --no-session
401 User not found.
exit=1
```

The same probe with the two working models answered `ok` with exit 0 (`openai-codex/gpt-6.1-sol` and `anthropic/claude-opus-5-5`). Both failures are at the provider key, not at the model id, so I expect other models of the same provider to fail the same way; I did not try them. Raw outputs: `results/spike/probe/`.

### 2.2 How I judged the findings

I judged all 24 round 2 reviews myself, one finding at a time, in this step, and judged the round 1 reviews again under the same rule. I am a model too (`anthropic/claude-sonnet-5-5`), so a bias toward findings from the same vendor as the judge is possible; no human checked my verdicts. I ran no tests, with one exception: I ran `Bun.markdown.render` on a raw-HTML sample to settle one finding (2.5, run 179 row 14).

- **Found (the strict rule).** A finding counts as "found" only if it names the escaped defect's own mechanism. I read the `escaped-defects.yml` entry and the fix commit for each defect (1.1), then compared each finding with the mechanism. A finding in the same function or about the same symptom that names a different problem is a **related near miss**, not a hit. Example: for ARK-310 gap 2 the mechanism is that a mixed-vendor review, or a helper/side-call model inside a step, is counted into the step's models (the fixes `a066f44` and `8907cb3` add `entry.vendors.size === 1` and skip helper messages). A finding that a run lead's session is attributed to a step by working folder is a near miss.
- **Real.** A finding is "real" only if I confirmed its central claim in the code at the pinned head, with a file and line cited in 2.5. For a test finding, the test source had to show what the finding says. A claim about runtime behaviour that the source alone does not settle is **not verified**, and I never count it as real. Where a finding is real in mechanism but its impact (a slowdown, a cost) was not measured, the verdict says so.
- **False.** A finding whose claim the code at head contradicts.
- **Rank.** The rank the reviewer gave, P0 to P3.

### 2.3 Which defects were found

| Defect                       | gpt-6.1-sol (2 reviews) | claude-opus-5-5 (2 reviews)  |
| ---------------------------- | ----------------------- | ---------------------------- |
| 1. ARK-217 (run 179)         | not found               | not found                    |
| 2. ARK-181 (run 181)         | **found in 2 of 2**, P2 | **found in 1 of 2** (2), P2  |
| 3. ARK-309 (run 291)         | not found, near miss    | not found, near miss         |
| 4. ARK-310 gap 2 (run 186)   | not found               | **found in 1 of 2** (2), P1  |
| 5. ARK-310 gap 1 (run 306)   | not found, near miss    | not found, near miss         |
| 6. ARK-213 control (run 178) | not found               | **found in 2 of 2**, P3 each |

- **Found in 4 of the 20 reviews of the five defects, on 2 defects, and in 2 of the 4 control reviews.** `gpt-6.1-sol` 2 reviews (both ARK-181), `claude-opus-5-5` 2 reviews (ARK-181 review 2 and ARK-310 gap 2 review 2), and 2 `claude-opus-5-5` reviews on the control.
- **ARK-181.** All three hits say that the AC6 headless test's metrics fixtures close on `2026-10-29` while the Metrics view starts at the browser's current week, so the test passes only in the week of the fixtures (`test/hub-views.test.ts:606-613`, `ui/views.tsx:308-309`). That is the escaped defect. The two `gpt-6.1-sol` hits mark their impact as `[INFERENCE]` because they could not run the test; the mechanism is still the defect's. `claude-opus-5-5` review 1 did not find it.
- **ARK-310 gap 2.** `claude-opus-5-5` review 2 (P1): omp `model_usage` side calls on another model become `UsageMessage`s (`cli/usage/omp.ts:86,95`), so `actualModels`, the model-changed line and the vendor loop count them, and `same_vendor_review` can come out true on a cross-vendor review (`cli/retro.ts:510-519,533-545`). That is a helper/side-call model counted into the step's vendors, the mechanism of the defect. Its suggested fix (mark side calls, leave them out of the vendor sets) is the direction the merged fix took with `!message.helper`. The other three reviews of run 186 did not name it.
- **ARK-213 control.** `claude-opus-5-5` reviews 1 and 2 name it, both as P3: install writes the new plist, then `rmSync(path)` when the load fails, so a working install is deleted (`cli/ui.ts:195-200`). The real reviewer ranked it P1, with a shell. Both `gpt-6.1-sol` reviews flag `uiUninstall` ignoring a failed `launchctl unload` (`cli/ui.ts:229-232`), a real but different problem. So with the diff, the setup can reproduce the find in 2 of 4 reviews, but not at the real rank.
- **Near miss, ARK-217.** Both `gpt-6.1-sol` reviews read `gateWaits` and flag that it opens an escalation wait at every failed step (`cli/retro.ts:212-213`), which does not follow the real escalation phase (`cli/events.ts`). That is real but not the escaped defect, which is that a re-check replaces the open plan wait so the wait counts from the last check. No review names the re-check.
- **Near miss, ARK-309.** All 4 reviews report that a project with no ticket files cannot be opened on Roadmap (`hub/page/Roadmap.tsx:157-162`). That is real, but it is a different gap from the escaped defect (the chip clip, and the states the switcher was missing from); the in-run fix `1f3f9fd` is already in the head. No review names the AC9 scroll test measuring before every source loaded.
- **Near miss, ARK-310 gap 1.** `claude-opus-5-5` reviews 1 and 2 report that the fake `orca` in `test/chief.test.ts` ignores `--full`, so dropping it would make every open run read "has no live run lead". That is a different path to the same message. No review names a structured worker whose liveness could not be checked, or the blank task titles.

### 2.4 Results of every review

One row per review. "Other findings" counts every finding except the escaped defect. "Real", "Not verified" and "False" split that count by 2.2. Tokens include cache reads. All 24 reviews ran only the requested model (`openai-codex/gpt-6.1-sol` or `anthropic/claude-opus-5-5`) and exited 0.

#### 1. 2026-11-01-ARK-179-1 (ARK-217)

| Model           | Review | Found | Rank | Other findings | Real | Not verified | False | Tokens    | Cost  | Wall time |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | ----- | --------- | ----- | --------- |
| gpt-6.1-sol     | 1      | no    | –    | 4              | 4    | 0            | 0     | 500,908   | $0.22 | 91 s      |
| gpt-6.1-sol     | 2      | no    | –    | 5              | 5    | 0            | 0     | 429,367   | $0.22 | 83 s      |
| claude-opus-5-5 | 1      | no    | –    | 7              | 7    | 0            | 0     | 733,796   | $1.06 | 126 s     |
| claude-opus-5-5 | 2      | no    | –    | 10             | 8    | 1            | 1     | 1,567,760 | $1.40 | 164 s     |

#### 2. 2026-11-01-ARK-181-1 (ARK-181)

| Model           | Review | Found | Rank | Other findings | Real | Not verified | False | Tokens    | Cost  | Wall time |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | ----- | --------- | ----- | --------- |
| gpt-6.1-sol     | 1      | yes   | P2   | 5              | 5    | 0            | 0     | 503,215   | $0.25 | 83 s      |
| gpt-6.1-sol     | 2      | yes   | P2   | 6              | 6    | 0            | 0     | 535,227   | $0.27 | 106 s     |
| claude-opus-5-5 | 1      | no    | –    | 6              | 6    | 0            | 0     | 1,537,485 | $1.17 | 158 s     |
| claude-opus-5-5 | 2      | yes   | P2   | 10             | 10   | 0            | 0     | 2,099,675 | $1.33 | 179 s     |

#### 3. 2026-11-04-ARK-291-1 (ARK-309)

| Model           | Review | Found | Rank | Other findings | Real | Not verified | False | Tokens    | Cost  | Wall time |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | ----- | --------- | ----- | --------- |
| gpt-6.1-sol     | 1      | no    | –    | 3              | 3    | 0            | 0     | 453,290   | $0.27 | 73 s      |
| gpt-6.1-sol     | 2      | no    | –    | 4              | 3    | 1            | 0     | 623,852   | $0.33 | 78 s      |
| claude-opus-5-5 | 1      | no    | –    | 6              | 6    | 0            | 0     | 2,480,563 | $1.62 | 177 s     |
| claude-opus-5-5 | 2      | no    | –    | 6              | 6    | 0            | 0     | 3,079,642 | $1.64 | 193 s     |

#### 4. 2026-11-03-ARK-186-1 (ARK-310 gap 2)

| Model           | Review | Found | Rank | Other findings | Real | Not verified | False | Tokens  | Cost  | Wall time |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | ----- | ------- | ----- | --------- |
| gpt-6.1-sol     | 1      | no    | –    | 3              | 3    | 0            | 0     | 150,571 | $0.11 | 48 s      |
| gpt-6.1-sol     | 2      | no    | –    | 2              | 2    | 0            | 0     | 153,591 | $0.11 | 42 s      |
| claude-opus-5-5 | 1      | no    | –    | 2              | 2    | 0            | 0     | 263,480 | $0.39 | 58 s      |
| claude-opus-5-5 | 2      | yes   | P1   | 2              | 2    | 0            | 0     | 527,586 | $0.70 | 101 s     |

#### 5. 2026-11-04-ARK-306-1 (ARK-310 gap 1)

| Model           | Review | Found | Rank | Other findings | Real | Not verified | False | Tokens    | Cost  | Wall time |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | ----- | --------- | ----- | --------- |
| gpt-6.1-sol     | 1      | no    | –    | 2              | 2    | 0            | 0     | 320,736   | $0.17 | 56 s      |
| gpt-6.1-sol     | 2      | no    | –    | 2              | 2    | 0            | 0     | 286,415   | $0.18 | 58 s      |
| claude-opus-5-5 | 1      | no    | –    | 4              | 4    | 0            | 0     | 1,174,074 | $1.17 | 155 s     |
| claude-opus-5-5 | 2      | no    | –    | 3              | 2    | 1            | 0     | 817,757   | $0.87 | 111 s     |

#### 6. 2026-11-01-ARK-178-1 (ARK-213, control)

| Model           | Review | Found | Rank | Other findings | Real | Not verified | False | Tokens  | Cost  | Wall time |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | ----- | ------- | ----- | --------- |
| gpt-6.1-sol     | 1      | no    | –    | 3              | 3    | 0            | 0     | 205,709 | $0.11 | 68 s      |
| gpt-6.1-sol     | 2      | no    | –    | 3              | 3    | 0            | 0     | 184,853 | $0.11 | 53 s      |
| claude-opus-5-5 | 1      | yes   | P3   | 4              | 3    | 1            | 0     | 967,881 | $0.96 | 156 s     |
| claude-opus-5-5 | 2      | yes   | P3   | 4              | 4    | 0            | 0     | 768,066 | $0.74 | 131 s     |

Totals over the 24 round 2 reviews:

| Model           | Reviews | Reviews that found a defect (control excluded) | Findings (all) | Other than the defect | Real | Not verified | False | Tokens     | Cost   | Mean cost per review | Mean wall time |
| --------------- | ------- | ---------------------------------------------- | -------------- | --------------------- | ---- | ------------ | ----- | ---------- | ------ | -------------------- | -------------- |
| gpt-6.1-sol     | 12      | 2 (control: 0)                                 | 44             | 42                    | 41   | 1            | 0     | 4,347,734  | $2.35  | $0.20                | 70 s           |
| claude-opus-5-5 | 12      | 2 (control: 2)                                 | 68             | 64                    | 60   | 3            | 1     | 16,017,765 | $13.05 | $1.09                | 142 s          |
| both            | 24      | 4 (control: 2)                                 | 112            | 106                   | 101  | 4            | 1     | 20,365,499 | $15.40 | $0.64                | 106 s          |

(The control hits are 2 of the 112 findings and are not counted in "Other than the defect".) Replay cost is $15.40 in all. `claude-opus-5-5` costs 5.6 times what `gpt-6.1-sol` costs on the same prompts, takes 2.0 times as long, and files 1.5 times as many findings (68 against 44). Giving the diff raised the cost per review by 14% for `gpt-6.1-sol` ($0.17 to $0.20) and 8% for `claude-opus-5-5` ($1.01 to $1.09) against round 1.

Distinct real findings other than the escaped defects, after removing repeats within a diff: `gpt-6.1-sol` 23, `claude-opus-5-5` 43, 13 of them in both, 53 in the union. The 4 findings I could not verify come from 4 reviews (run 179 O2, run 291 G2, run 306 O2, run 178 O1), and the 1 false finding is from `claude-opus-5-5` (run 179 O2, row 14). So a panel finds more real problems than one model (53 against 43 and 23), and one of the extras is an escaped defect only if the model that finds it is `claude-opus-5-5`.

### 2.5 The findings I judged

One table per diff. "Found by" uses G1 and G2 for the two `gpt-6.1-sol` reviews and O1 and O2 for the two `claude-opus-5-5` reviews. Paths are from the repo root at the pinned head. A finding that two reviews state in different words is one row. The escaped defect has its own row marked **found**.

#### 1. Run 179 (head `bf22bd7`)

| #   | Finding                                                                                                                                           | Found by       | Verdict                                           | Evidence at head                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | An escalation wait opens at every failed step, but the escalation phase needs an exhausted round budget and a failed test (near miss for ARK-217) | G1, G2         | real                                              | `cli/retro.ts:212-213` asks `escalation` at each failed `step.finished`; `cli/events.ts:230-241` sets the phase only when `round >= roundBudget && lastTest && !lastTest.passed`                                                                            |
| 2   | A vanished or replaced agent keeps its last liveness state, so the rest of the run counts as stalled                                              | O1, O2, G1, G2 | real                                              | `cli/hub/detail.ts:194-202` never expires a state; `cli/hub/history.ts:131` writes records only for the agents Orca lists now                                                                                                                               |
| 3   | An agent is matched to a step by substring and gets the whole step's cost and wall time                                                           | O1, O2, G1, G2 | real                                              | `cli/hub/detail.ts:322` (`agent.title.includes(candidate.id)`) and `:336`                                                                                                                                                                                   |
| 4   | Report and mockup paths are plain text, not links                                                                                                 | G1, G2         | real                                              | `ui/app.tsx:1257,1286-1287`; the ticket asks for links to reports and mockups                                                                                                                                                                               |
| 5   | The proof table shows only "N of M" per criterion and hides the cases and their results                                                           | G2             | real                                              | `ui/app.tsx:1249-1253`                                                                                                                                                                                                                                      |
| 6   | The AC3 test cannot fail on per-agent cost or wall time                                                                                           | O1, O2         | real                                              | `test/run-detail.test.ts:389-396`: both checks accept `"unknown"` for every agent                                                                                                                                                                           |
| 7   | Refresh waits on `gh` and `glab` through `collectHistory`, every 3 s per merge request                                                            | O1             | real (effect on the 5 s push target not measured) | `cli/hub/state.ts:147` awaits `collectHistory`; `cli/hub/history.ts:19,65,84` call `gh` and `glab`; `cli/ui.ts:11,59` refresh every 3000 ms                                                                                                                 |
| 8   | Every refresh decompresses every Codex `.zst` rollout whole, to read one `cwd`                                                                    | O1, O2         | real (cost not measured)                          | `cli/usage/index.ts:80` decompresses the whole file, then slices 64 KiB                                                                                                                                                                                     |
| 9   | The AC2 test fixture uses `passed`/`failed` where `ark test` writes `passing`/`failing`                                                           | O1             | real                                              | `test/run-detail.test.ts:278-283` writes `"passed"` and `"failed"`; `cli/test-run.ts:10,33-34` define and write `"passing"` and `"failing"`; `ui/app.tsx:1249` reads `"failing"`                                                                            |
| 10  | A malformed `#run=` hash throws while the page renders                                                                                            | O1, O2         | real                                              | `ui/app.tsx:209`: `decodeURIComponent(location.hash.slice("#run=".length))` with no `try`                                                                                                                                                                   |
| 11  | An error in one run's `buildDetail` stops the refresh for every run                                                                               | O2             | real                                              | `cli/hub/state.ts:150-157`: `Promise.all` over the runs with no per-run catch                                                                                                                                                                               |
| 12  | Unavailable report cases are attached to every criterion                                                                                          | O2             | real                                              | `cli/hub/detail.ts:103`: `found.status === "unavailable" \|\| found.criteria.includes(id)`                                                                                                                                                                  |
| 13  | The AC4 test fails the Orca read with exit 1 and never delays it, so the timeout path is untested                                                 | O2             | real                                              | `test/run-detail.test.ts:70` (`exit 1` for the bad handle), `:431-443`                                                                                                                                                                                      |
| 14  | The plan renderer passes raw HTML through unchanged                                                                                               | O2             | **false**                                         | `cli/hub/detail.ts:217-221` escapes through the `text` callback; `Bun.markdown.render` on `<script>…` and `<img onerror>` with an escaping `text` callback returned `&lt;…`; `test/run-detail.test.ts:570-578` expects `&lt;img src=x onerror=alert(1)&gt;` |
| 15  | The branch carries the ARK-178 files (`cli/hub/notify.ts`, `ui install`) inside the ARK-179 diff                                                  | O2             | **not verified**                                  | the diff does list `cli/hub/notify.ts`; whether that is a defect of the run or content merged from main into the branch (see 1.5) is not settled by the source                                                                                              |

The escaped defect (ARK-217, a re-check replaces the open plan wait) is named by no review.

#### 2. Run 181 (head `31807ef`)

| #   | Finding                                                                                                                                                           | Found by       | Verdict                  | Evidence at head                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| –   | **The escaped defect:** the AC6 headless test's fixtures close on `2026-10-29` and the Metrics view starts at the current week, so the test passes only that week | G1, G2, O2     | **found**, P2 each       | `test/hub-views.test.ts:606-613` (fixtures dated `2026-10-29`); `ui/views.tsx:308-309` (`new Date()`); the test does not change the week before it asserts   |
| 1   | Override rate reads a key that `metrics.json` never has                                                                                                           | O2, G1, G2     | real                     | `cli/hub/metrics.ts:91` reads `override_rate`; `cli/retro.ts:514-515` writes `decisions`, and no code writes `override_rate`                                 |
| 2   | A partly measured run cost shows as an exact day cost                                                                                                             | O1, O2, G1, G2 | real                     | `cli/hub/metrics.ts:88,107` set the flag only for `null`; `cli/retro.ts:485-494` writes `includes_unknown`                                                   |
| 3   | The per-ticket "Approve and queue" sends the instruction for all proposed tickets                                                                                 | O1, O2         | real                     | `ui/views.tsx:206` sends no ticket id; `cli/hub/types.ts:51-52` is "approve and queue the proposed tickets in the order shown"                               |
| 4   | Agent cost is the sum of every session in the folder tree                                                                                                         | O1, O2, G1, G2 | real                     | `cli/hub/agents.ts:88`; `cli/usage/index.ts:128` (`isInside`)                                                                                                |
| 5   | One unreadable session file fails the whole Agents API                                                                                                            | O1, O2, G1, G2 | real                     | `cli/usage/index.ts:124` throws; `cli/ui.ts:83` does not catch                                                                                               |
| 6   | The five new read routes skip the Host check of `/api/runs/:run`                                                                                                  | O1             | real                     | `cli/ui.ts:82-97` have no `isLocalRequest`; `:74,121,129,141` do                                                                                             |
| 7   | Search polls every 5 s and the selected hit is a list index that can move                                                                                         | O1             | real                     | `ui/views.tsx:51,506`                                                                                                                                        |
| 8   | A search hit's link target is printed as text and opens nothing                                                                                                   | O2, G1, G2     | real                     | `ui/views.tsx:573-578`                                                                                                                                       |
| 9   | The tickets README appears as an unreadable ticket                                                                                                                | O2, G2         | real                     | `cli/hub/backlog.ts:27` skips only non-`.md` names; `test/hub-views.test.ts:187` puts its README in another folder                                           |
| 10  | Every usage scan decompresses every Codex `.jsonl.zst` rollout to find its `cwd`                                                                                  | O2             | real (cost not measured) | `cli/usage/index.ts:86`: `findCwd(readCodexText(file).slice(0, 65536))`                                                                                      |
| 11  | The five new APIs are not documented                                                                                                                              | O2             | real                     | `docs/reference/cli.md` documents `GET /api/runs/<run>` only; none of `/api/backlog`, `/api/agents`, `/api/metrics`, `/api/search`, `/api/projects` is in it |
| 12  | The AC1 approve-and-queue test posts to the endpoint and never uses the Backlog view                                                                              | O2             | real                     | `test/hub-views.test.ts:221-236` calls `fetch(".../api/actions/chief-instruction")`                                                                          |

#### 3. Run 291 (head `56b41b0`)

| #   | Finding                                                                                   | Found by       | Verdict                                              | Evidence at head                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A project with no ticket file cannot be opened on Roadmap (near miss for ARK-309)         | O1, O2, G1, G2 | real                                                 | `hub/page/Roadmap.tsx:157-162` takes names from `snapshot.tickets` only; main later adds runs and gates to the list (`projectsOf`, `hub/page/derive.ts:204-209`)                                                        |
| 2   | An unreadable `ROADMAP.md` is reported as "no roadmap"                                    | G1             | real                                                 | `hub/sources.ts:74-78` return null on a read error; `:97` turns null into `{ none }`                                                                                                                                    |
| 3   | Graph nodes have no run links                                                             | G1, G2         | real                                                 | `hub/page/RoadmapGraph.tsx:155` has only the ticket anchor and the file has no `RunLinks`                                                                                                                               |
| 4   | An open run hides the "proposed" badge                                                    | G2             | real                                                 | `hub/page/RoadmapParts.tsx:95`                                                                                                                                                                                          |
| 5   | A post-test amendment leaves the earlier acceptance proof in force                        | G2             | **not verified**                                     | `cli/events.ts:181-195` clears the manual gate and the plan on `criteria.amended` but not the criterion status or the last test; whether a merge can still pass depends on the merge-request code, which I did not read |
| 6   | The copy result is only in a screen-reader-only span                                      | O1             | real                                                 | `hub/page/RoadmapParts.tsx:316,342,364`; `hub/page/styles.css:85`                                                                                                                                                       |
| 7   | Unreadable or unknown tickets are relabelled `proposed`                                   | O1, O2         | real (mechanism; whether it is wrong is a spec call) | `hub/sources.ts:99-102`; its own comment says such a ticket "waits in Review"                                                                                                                                           |
| 8   | `Why` renders code spans, but `whyOf` strips every backtick                               | O1, O2         | real                                                 | `hub/page/RoadmapParts.tsx:36`; `hub/ticket-document.ts:16`                                                                                                                                                             |
| 9   | Milestone, view and search text live in a module global, not in the URL                   | O1             | real                                                 | `hub/page/Roadmap.tsx:69-79` (`let remembered`); the switcher links carry the project only (`:338-343`)                                                                                                                 |
| 10  | The project switcher navigates from a `<button>` `onClick` instead of a link              | O1             | real (style)                                         | `hub/page/Roadmap.tsx:338-352`                                                                                                                                                                                          |
| 11  | The AC11 evidence file is missing from the branch                                         | O2             | real                                                 | `docs/evidence/` has `ARK-277-ac13.md` … `ARK-303-validator.md` and no `ARK-291-ac11.md`                                                                                                                                |
| 12  | In Graph view `j`/`k` order by lane only, not by drawn row                                | O2             | real                                                 | `hub/page/Roadmap.tsx:176`                                                                                                                                                                                              |
| 13  | `whyOf` cuts at the first `.`, `!` or `?` followed by whitespace, including abbreviations | O2             | real                                                 | `hub/ticket-document.ts:23`: `[.!?](?=\s)`                                                                                                                                                                              |

The escaped defect (the AC9 scroll test measures before every source loaded; the chip and switcher half is already fixed in the head) is named by no review.

#### 4. Run 186 (head `d44e5df`)

| #   | Finding                                                                                                                                     | Found by       | Verdict                                              | Evidence at head                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| –   | **The escaped defect:** side-call (`model_usage`) models become step models, so `same_vendor_review` can read true on a cross-vendor review | O2             | **found**, P1                                        | `cli/usage/omp.ts:86,95` turn a `model_usage` record into a `UsageMessage` with its own model; `cli/retro.ts:510-519,533-545` read every message for models and vendors |
| 1   | The AC3 "false" tests pass because build and review ran in different repos                                                                  | O1, O2, G1, G2 | real                                                 | `test/retro.test.ts:759,781` use `installAllSessions` (build in `repos/platform`, review in `repos/shared`); `cli/retro.ts:123` groups by the executed repo             |
| 2   | The docs say each plan step has an `actual_models` entry, but the keys are the steps that started                                           | O1, O2, G1, G2 | real                                                 | `docs/reference/cli.md:164`; `cli/retro.ts:472,475,510`                                                                                                                 |
| 3   | The model comparison uses the bare name after the last `/`, which replaces the plan's exact match                                           | G1             | real (mechanism; whether it is wrong is a spec call) | `cli/retro.ts:527-536` slices `model.slice(model.lastIndexOf("/") + 1)`; its comment says this is deliberate                                                            |

#### 5. Run 306 (head `6490f58`)

| #   | Finding                                                                                                                         | Found by       | Verdict          | Evidence at head                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The AC3 tests miss the 12-Run case with no Master Chief Run and the `exit 1` `orca: runtime is not running` case                | O1             | real             | `test/chief.test.ts:415` exits 4, `:460-468` uses 230 Runs; the ticket's AC3 names both cases                                                      |
| 2   | The AC5 test only checks that other test titles exist in the source                                                             | O1, O2, G1, G2 | real             | `test/chief.test.ts:471-477`                                                                                                                       |
| 3   | The fake `orca` ignores `--full`, so no test checks the flag that `coordinator_handle` depends on (near miss for ARK-310 gap 1) | O1, O2         | real             | `test/chief.test.ts:42-56`: the `run-list` case parses `--limit` and `--cursor` only; `cli/chief.ts:69-73` and `cli/orca.ts:49` pass `--full`      |
| 4   | The Orca spawn-and-parse code exists twice                                                                                      | O1             | real (style)     | `cli/exec.ts:8` (`exec`) and `:57` (`execResult`) are two spawn paths, and `cli/orca-release.ts` has its own `call`                                |
| 5   | `hub/roadmap.ts` adds `readRoadmap`, an export with no production caller                                                        | G1, G2         | real             | `hub/roadmap.ts:75`; the only importer is `test/roadmap.test.ts:6`                                                                                 |
| 6   | The diff carries ARK-290 and ARK-303 changes that are not part of ARK-306                                                       | O2             | **not verified** | the diff lists those files; whether they are the run's own work or content merged from main into the branch (see 1.5) is not settled by the source |

The escaped defect (a structured worker whose liveness could not be checked reads "no live run lead", and blank task titles) is named by no review.

#### 6. Run 178, control (head `8cdd3cd`)

| #   | Finding                                                                                                               | Found by       | Verdict                                                       | Evidence at head                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| –   | **The control defect:** a failed `launchctl load` on update deletes the working plist                                 | O1, O2         | **found**, P3 each                                            | `cli/ui.ts:195-200`: `unload`, `writeFileSync(path, plist)`, then `rmSync(path)` when `load` fails                                                              |
| 1   | The notifier baseline is set from a reader that does not produce the items, so items that existed at start can notify | O1, O2, G1, G2 | real                                                          | `cli/ui.ts:33-34`; `cli/hub/state.ts:226`; `cli/hub/plannotator.ts:80-83`                                                                                       |
| 2   | De-duplication is lost on restart                                                                                     | G1, G2         | real                                                          | `cli/hub/notify.ts:57` (empty `seen`)                                                                                                                           |
| 3   | `uiUninstall` ignores a failed `launchctl unload`, deletes the plist and reports success                              | G1, G2         | real                                                          | `cli/ui.ts:228-232`                                                                                                                                             |
| 4   | A gate that reopens under the same id never notifies again                                                            | O1             | **not verified**                                              | `cli/hub/notify.ts` says in a comment that an item is "never notified twice, even if its item goes and returns", so whether this is a defect is a spec question |
| 5   | A repeated id overwrites its history record, so several notifications show as one row                                 | O1             | real                                                          | `cli/hub/notify.ts:34` (`Map.set` by id)                                                                                                                        |
| 6   | The test setup does not clear `ARK_NOTIFIER`, so older hub tests can call the real notifier                           | O1             | real                                                          | `test/ui.test.ts:42-50` deletes six variables and `ARK_NOTIFIER` is not one of them                                                                             |
| 7   | A gate that opens before the first full refresh finishes counts as existing at start and never notifies               | O2             | real (follows the plan; the plan accepts this)                | `cli/ui.ts:28-34`: `ark: refreshedOnce` gates the Ark baseline                                                                                                  |
| 8   | The notifier URL is not URL-encoded, but the page decodes it                                                          | O2             | real (impact depends on the characters in an id; not checked) | `cli/hub/notify.ts:85`; `ui/app.tsx:120`                                                                                                                        |
| 9   | The notification history is re-read and pushed every second                                                           | O2             | real                                                          | `cli/hub/state.ts:236`; `cli/ui.ts:10,43`                                                                                                                       |

## 3. Round 1 baseline: replays without the diff

### 3.1 What round 1 was

Round 1 ran the same 24 reviews (6 diffs, `gpt-6.1-sol` and `claude-opus-5-5`, 2 repeats each) with the prompt of section 1.3 minus the diff file: the "Replay environment" block named the checkout and the command `git diff $(git merge-base HEAD base)..HEAD` but gave no output, and no tool could run it. Every review said so, and most read selected files at head instead of the patch. The run lead's review of the first version of this document found that this is a different experiment from the one asked (reviewers could not focus on the changed lines), so round 2 (sections 1, 2 and 4) repeats it with the diff. The data are in `results/spike/replays/`. Cost and speed were close to round 2 ($14.19 for the 24, against $15.40; mean wall time 103 s against 106 s).

**Strict counts, round 1.** Under the strict rule of 2.2, **no round 1 review found any of the 5 defects, and none found the control** (0 of 4 reviews on that diff). The one finding that round 1 first counted as a hit does not meet the rule. `gpt-6.1-sol` review 1 of run 186 (P2, `cli/retro.ts:515`) said "Actual models can include the run lead's model instead of only the worker's models" and proposed excluding orchestration sessions. That is a run lead's session attributed to a step by working folder and time window, which the code at head confirms (`cli/retro.ts:114-127,568-573,597`) and is real. But it is not the mechanism of ARK-310 gap 2, a helper or side-call model counted into a step's vendors, and the merged fixes (`a066f44` with `entry.vendors.size === 1`, `8907cb3` with the helper filter) do not implement its proposal. It is a **related near miss**. Sensitivity: read broadly, round 1 found 1 of 5 (the same near miss); I do not count it.

Other round 1 near misses are as in round 2: `claude-opus-5-5` review 1 of run 179 flagged that unanswered waits stay open until the run ends (`cli/hub/detail.ts:121,183`), not the re-check; both `gpt-6.1-sol` reviews and `claude-opus-5-5` review 2 of run 178 flagged `uiUninstall` and the unchanged-plist early return, not the failed update (`cli/ui.ts:195-200`); all 4 reviews of run 291 and none of run 306 named the escaped defect.

### 3.2 Results of every round 1 review

One row per review. "Other findings" counts every finding (no round 1 review found a defect under the strict rule). "Real" and "Not verified" split that count by 2.2; the rest is false (none). Tokens include cache reads.

#### 1. 2026-11-01-ARK-179-1 (ARK-217)

| Model           | Review | Found | Rank | Other findings | Real | Not verified | Tokens    | Cost  | Wall time | Real model                |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | --------- | ----- | --------- | ------------------------- |
| gpt-6.1-sol     | 1      | no    | –    | 4              | 4    | 0            | 342,516   | $0.19 | 83 s      | openai-codex/gpt-6.1-sol  |
| gpt-6.1-sol     | 2      | no    | –    | 4              | 4    | 0            | 392,736   | $0.25 | 79 s      | openai-codex/gpt-6.1-sol  |
| claude-opus-5-5 | 1      | no    | –    | 6              | 6    | 0            | 1,136,564 | $1.06 | 103 s     | anthropic/claude-opus-5-5 |
| claude-opus-5-5 | 2      | no    | –    | 5              | 5    | 0            | 1,594,637 | $1.19 | 119 s     | anthropic/claude-opus-5-5 |

#### 2. 2026-11-01-ARK-181-1 (ARK-181)

| Model           | Review | Found | Rank | Other findings | Real | Not verified | Tokens    | Cost  | Wall time | Real model                |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | --------- | ----- | --------- | ------------------------- |
| gpt-6.1-sol     | 1      | no    | –    | 3              | 3    | 0            | 257,005   | $0.15 | 64 s      | openai-codex/gpt-6.1-sol  |
| gpt-6.1-sol     | 2      | no    | –    | 3              | 3    | 0            | 300,824   | $0.18 | 68 s      | openai-codex/gpt-6.1-sol  |
| claude-opus-5-5 | 1      | no    | –    | 8              | 8    | 0            | 1,363,412 | $0.98 | 131 s     | anthropic/claude-opus-5-5 |
| claude-opus-5-5 | 2      | no    | –    | 9              | 9    | 0            | 1,397,009 | $0.95 | 133 s     | anthropic/claude-opus-5-5 |

#### 3. 2026-11-04-ARK-291-1 (ARK-309)

| Model           | Review | Found | Rank | Other findings | Real | Not verified | Tokens    | Cost  | Wall time | Real model                |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | --------- | ----- | --------- | ------------------------- |
| gpt-6.1-sol     | 1      | no    | –    | 3              | 3    | 0            | 447,059   | $0.25 | 92 s      | openai-codex/gpt-6.1-sol  |
| gpt-6.1-sol     | 2      | no    | –    | 2              | 2    | 0            | 380,676   | $0.22 | 82 s      | openai-codex/gpt-6.1-sol  |
| claude-opus-5-5 | 1      | no    | –    | 7              | 6    | 1            | 3,077,320 | $1.99 | 251 s     | anthropic/claude-opus-5-5 |
| claude-opus-5-5 | 2      | no    | –    | 6              | 6    | 0            | 3,400,786 | $2.02 | 231 s     | anthropic/claude-opus-5-5 |

#### 4. 2026-11-03-ARK-186-1 (ARK-310 gap 2)

| Model           | Review | Found | Rank | Other findings | Real | Not verified | Tokens  | Cost  | Wall time | Real model                |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | ------- | ----- | --------- | ------------------------- |
| gpt-6.1-sol     | 1      | no    | –    | 3              | 3    | 0            | 243,088 | $0.15 | 69 s      | openai-codex/gpt-6.1-sol  |
| gpt-6.1-sol     | 2      | no    | –    | 2              | 2    | 0            | 220,044 | $0.12 | 52 s      | openai-codex/gpt-6.1-sol  |
| claude-opus-5-5 | 1      | no    | –    | 2              | 2    | 0            | 288,396 | $0.36 | 58 s      | anthropic/claude-opus-5-5 |
| claude-opus-5-5 | 2      | no    | –    | 3              | 3    | 0            | 422,006 | $0.47 | 78 s      | anthropic/claude-opus-5-5 |

#### 5. 2026-11-04-ARK-306-1 (ARK-310 gap 1)

| Model           | Review | Found | Rank | Other findings | Real | Not verified | Tokens  | Cost  | Wall time | Real model                |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | ------- | ----- | --------- | ------------------------- |
| gpt-6.1-sol     | 1      | no    | –    | 1              | 1    | 0            | 286,205 | $0.15 | 62 s      | openai-codex/gpt-6.1-sol  |
| gpt-6.1-sol     | 2      | no    | –    | 1              | 1    | 0            | 185,903 | $0.13 | 53 s      | openai-codex/gpt-6.1-sol  |
| claude-opus-5-5 | 1      | no    | –    | 2              | 2    | 0            | 937,816 | $0.95 | 126 s     | anthropic/claude-opus-5-5 |
| claude-opus-5-5 | 2      | no    | –    | 3              | 3    | 0            | 499,903 | $0.49 | 76 s      | anthropic/claude-opus-5-5 |

#### 6. 2026-11-01-ARK-178-1 (ARK-213 (control))

| Model           | Review | Found | Rank | Other findings | Real | Not verified | Tokens    | Cost  | Wall time | Real model                |
| --------------- | ------ | ----- | ---- | -------------- | ---- | ------------ | --------- | ----- | --------- | ------------------------- |
| gpt-6.1-sol     | 1      | no    | –    | 4              | 4    | 0            | 237,838   | $0.15 | 83 s      | openai-codex/gpt-6.1-sol  |
| gpt-6.1-sol     | 2      | no    | –    | 4              | 4    | 0            | 228,337   | $0.12 | 83 s      | openai-codex/gpt-6.1-sol  |
| claude-opus-5-5 | 1      | no    | –    | 7              | 5    | 2            | 1,029,405 | $0.84 | 136 s     | anthropic/claude-opus-5-5 |
| claude-opus-5-5 | 2      | no    | –    | 8              | 8    | 0            | 993,638   | $0.82 | 150 s     | anthropic/claude-opus-5-5 |

Totals over the 24 round 1 reviews:

| Model           | Reviews | Reviews that found a defect | Findings | Real | Not verified | False | Tokens     | Cost   | Mean cost per review | Mean wall time |
| --------------- | ------- | --------------------------- | -------- | ---- | ------------ | ----- | ---------- | ------ | -------------------- | -------------- |
| gpt-6.1-sol     | 12      | 0                           | 34       | 34   | 0            | 0     | 3,522,231  | $2.06  | $0.17                | 72 s           |
| claude-opus-5-5 | 12      | 0                           | 66       | 63   | 3            | 0     | 16,140,892 | $12.13 | $1.01                | 133 s          |
| both            | 24      | 0                           | 100      | 97   | 3            | 0     | 19,663,123 | $14.19 | $0.59                | 103 s          |

Distinct real findings after removing repeats within a diff: `gpt-6.1-sol` 21, `claude-opus-5-5` 43, 12 of them in both, 52 in the union.

### 3.3 The round 1 findings

One table per diff, as in 2.5. "Found by" uses G1, G2, O1 and O2 for the reviews. Round 1 evidence is the code at the same pinned heads.

#### 1. Run 179 (head `bf22bd7`)

| #   | Finding                                                                                                                            | Found by       | Verdict                  | Evidence at head                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | An unanswered gate wait counts as open until the run ends, so a failed step turns the rest of the run into "waiting for the human" | O1             | real                     | `cli/hub/detail.ts:121,183` use `end` for an unanswered wait; `cli/retro.ts:213` asks an escalation wait at every failed step |
| 2   | A vanished or replaced agent keeps its last liveness state, so the rest of the run counts as stalled                               | O1, O2, G1, G2 | real                     | `cli/hub/detail.ts:194-202` never expires a state; `cli/hub/history.ts:131` writes records only for the agents Orca lists now |
| 3   | Unknown liveness counts as working time                                                                                            | G1             | real                     | `cli/hub/detail.ts:194-205`: the last branch is `working`                                                                     |
| 4   | The AC3 test cannot fail on per-agent cost or wall time                                                                            | O1, O2         | real                     | `test/run-detail.test.ts:389-396`: both checks accept `"unknown"` for every agent                                             |
| 5   | Every refresh decompresses every Codex `.zst` rollout whole, to read one `cwd`                                                     | O1, O2         | real (cost not measured) | `cli/usage/index.ts:80` decompresses the whole file, then slices 64 KiB                                                       |
| 6   | An agent is matched to a step by substring and gets the whole step's cost                                                          | O1, O2, G1, G2 | real                     | `cli/hub/detail.ts:322` (`agent.title.includes(candidate.id)`) and `:336`                                                     |
| 7   | Report and mockup paths are plain text, not links                                                                                  | O1, G1, G2     | real                     | `ui/app.tsx:1257,1286-1287`; the ticket asks for "links to reports in `results/`" and "mockup links"                          |
| 8   | The timeline rebuilds state for every event prefix, O(n²)                                                                          | O2             | real                     | `cli/hub/detail.ts:127-129` calls `deriveState(events.slice(0, i))` per event                                                 |
| 9   | Run detail joins the last `test.completed` with report files that a later `ark test` overwrites                                    | G2             | real                     | `cli/hub/detail.ts:61,72` read `results/<suite>.report`; `cli/test-run.ts:94` appends the event only after the suites ran     |

#### 2. Run 181 (head `31807ef`)

| #   | Finding                                                                           | Found by       | Verdict | Evidence at head                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------- | -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Override rate reads a key that `metrics.json` never has                           | O1, O2, G1, G2 | real    | `cli/hub/metrics.ts:91` reads `override_rate`; `cli/retro.ts:515` writes `decisions`, and no code writes `override_rate`                                                      |
| 2   | The per-ticket "Approve and queue" sends the instruction for all proposed tickets | O1, O2         | real    | `ui/views.tsx:206` sends no ticket id; `cli/hub/types.ts:51-52` is "approve and queue the proposed tickets in the order shown"                                                |
| 3   | One unreadable session file fails the whole Agents API                            | O1, O2         | real    | `cli/usage/index.ts:124` throws; `cli/ui.ts:83` does not catch                                                                                                                |
| 4   | Agent cost is the sum of every session in the folder tree                         | O1, O2, G1     | real    | `cli/usage/index.ts:128` (`isInside`); `cli/hub/agents.ts:28` says so in a comment                                                                                            |
| 5   | The five new read routes skip the Host check of `/api/runs/:run`                  | O1, O2         | real    | `cli/ui.ts:82-97` have no `isLocalRequest`; `:74,121,129,141` do                                                                                                              |
| 6   | A partly measured run cost shows as an exact day cost                             | O1, O2, G1, G2 | real    | `cli/hub/metrics.ts:107` sets the flag only for `null`; `cli/retro.ts:494` writes `includes_unknown`                                                                          |
| 7   | A search hit's link target is printed as text                                     | O1, G2         | real    | `ui/views.tsx:573-578`                                                                                                                                                        |
| 8   | The e2e check "shows both projects" passes on incidental text                     | O1             | real    | `test/hub-views.test.ts:663`: `toContain("one")`, and "none" contains "one"                                                                                                   |
| 9   | The tickets README appears as an unreadable ticket                                | O2             | real    | `cli/hub/backlog.ts:27` skips only non-`.md` names; `~/.ark/projects/ark/tickets/README.md` exists; the test puts its README in another folder (`test/hub-views.test.ts:187`) |
| 10  | Search polls `orca search` every 5 s                                              | O2             | real    | `ui/views.tsx:51`                                                                                                                                                             |
| 11  | The selected search hit is a list index and can move on refresh                   | O2             | real    | `ui/views.tsx:506`                                                                                                                                                            |

#### 3. Run 291 (head `56b41b0`)

| #   | Finding                                                                              | Found by | Verdict                                                                                       | Evidence at head                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The copy result is only in a screen-reader-only span                                 | O1       | real                                                                                          | `hub/page/RoadmapParts.tsx:316,342,364`; `hub/page/styles.css:85`                                                                                                        |
| 2   | Hovering a row moves the keyboard cursor, so `j`/`k` jump after a scroll             | O1       | **not verified**                                                                              | the wiring is there (`hub/page/Roadmap.tsx:455`, `hub/page/RoadmapParts.tsx:190`); the jump after a scroll needs a browser that sends a mouse event, which I did not run |
| 3   | Roadmap view state lives in a module global and leaks into other projects and visits | O1, O2   | real                                                                                          | `hub/page/Roadmap.tsx:79`; main later keeps the state per project (ARK-309, `ProjectRoadmap` in `hub/page/Roadmap.tsx`)                                                  |
| 4   | `Why` renders code spans, but `whyOf` strips every backtick                          | O1, O2   | real                                                                                          | `hub/page/RoadmapParts.tsx:36`; `hub/ticket-document.ts:16`                                                                                                              |
| 5   | Shipped folds are kept by mutating a `useState` object                               | O1       | real (style)                                                                                  | `hub/page/Roadmap.tsx:180,493`                                                                                                                                           |
| 6   | `ark ui` help still describes a grouped table and `GET /api/ticket`                  | O1, O2   | real                                                                                          | `cli/ark.ts:274`; `test/hub.test.ts:1459` says there is no `/api/ticket` route                                                                                           |
| 7   | Ticket keys are built by hand next to `ticketKey`                                    | O1       | real                                                                                          | `hub/page/RoadmapParts.tsx:27,146`; `hub/page/derive.ts:149`                                                                                                             |
| 8   | The graph's done strip grows by one slot per edge, not per dot                       | O2       | real (mechanism; the size on real data was not measured)                                      | `hub/page/roadmap-graph.ts:111,150`                                                                                                                                      |
| 9   | `crossings` is exported only for a unit test                                         | O2       | real                                                                                          | `hub/page/roadmap-graph.ts:263`; only `test/roadmap-graph.test.ts:2,25` call it                                                                                          |
| 10  | In Graph view `j`/`k` order by lane only, not by drawn row                           | O2       | real                                                                                          | `hub/page/Roadmap.tsx:176`                                                                                                                                               |
| 11  | A project with no ticket file cannot be shown                                        | G1, G2   | real; main later adds runs and gates to the list (`projectsOf`, `hub/page/derive.ts:204-209`) | `hub/page/Roadmap.tsx:157-162` takes names from `snapshot.tickets` only                                                                                                  |
| 12  | Graph nodes have no run links                                                        | G1       | real                                                                                          | `hub/page/RoadmapGraph.tsx:155` has only the ticket anchor and the file has no `RunLinks`; the ticket says "Keep the ARK-284 run links on rows and graph nodes"          |
| 13  | An unreadable `ROADMAP.md` is reported as "no roadmap"                               | G1       | real                                                                                          | `hub/sources.ts:74-78` return null on a read error; `:97` turns null into `{ none }`                                                                                     |
| 14  | An open run hides the "proposed" badge                                               | G2       | real                                                                                          | `hub/page/RoadmapParts.tsx:95`; the ticket's AC3 asks for the phase and the badge                                                                                        |

#### 4. Run 186 (head `d44e5df`)

| #   | Finding                                                                                                                  | Found by       | Verdict                                                   | Evidence at head                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The AC3 "false" tests pass because build and review ran in different repos                                               | O1, O2, G1, G2 | real                                                      | `test/retro.test.ts:759,781` use `installAllSessions` (build in `repos/platform`, review in `repos/shared`); `cli/retro.ts:123` groups by the executed repo |
| 2   | The docs say "each plan step ID", but the keys are the steps that started                                                | O1, O2, G1, G2 | real                                                      | `docs/reference/cli.md:164`; `cli/retro.ts:475`                                                                                                             |
| 3   | `model changed:` fires on any spelling difference, such as a role alias                                                  | O2             | real                                                      | `cli/retro.ts:535`; the role aliases are in `docs/reference/cli.md:368`                                                                                     |
| 4   | A run lead's session is attributed to a root-repo step by working folder and time, so `same_vendor_review` can read true | G1             | real; related near miss, not the escaped defect (see 3.1) | `cli/retro.ts:114-127,568-573,597`                                                                                                                          |

#### 5. Run 306 (head `6490f58`)

| #   | Finding                                                                                                          | Found by                                   | Verdict | Evidence at head                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The AC3 tests miss the 12-Run case with no Master Chief Run and the `exit 1` `orca: runtime is not running` case | O1 (the 12-Run half), O2 (both, ranked P1) | real    | `test/chief.test.ts:415` exits 4, `:460-468` uses 230 Runs; the ticket's AC3 names both cases; `runtime is not running` is in no test (only `docs/how-to/project-checks.md:129`) |
| 2   | The AC5 test only checks that other test titles exist in the source                                              | O1, O2, G1, G2                             | real    | `test/chief.test.ts:471-477`                                                                                                                                                     |
| 3   | The `ARK_ORCA_TIMEOUT_MS` comment says it reaches every Orca read                                                | O2                                         | real    | `cli/orca.ts:59`; `hub/sources.ts:226` calls `orcaPages` with the default 2 s (`cli/exec.ts:2`)                                                                                  |

#### 6. Run 178, control (head `8cdd3cd`)

| #   | Finding                                                                                                                                     | Found by       | Verdict                                                       | Evidence at head                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The Plannotator baseline waits on `sessions`, but items come from Inbox `threads`, so a late Inbox notifies everything that already existed | O1, O2, G1, G2 | real                                                          | `cli/ui.ts:34`; `cli/hub/state.ts:226`; `cli/hub/plannotator.ts:80-83` (items from `threads`; a null read adds nothing)                          |
| 2   | De-duplication is lost on restart, and a repeated id overwrites its history record                                                          | G1, G2, O2     | real                                                          | `cli/hub/notify.ts:57` (empty `seen`), `:34` (`Map.set` by id)                                                                                   |
| 3   | A gate, MR or agent that reopens under the same id never notifies again while the server runs                                               | O1             | **not verified**                                              | `cli/hub/notify.ts` says in a comment "never notified twice, even if its item goes and returns", so whether this is a defect is a spec question  |
| 4   | The restart test has at most one poll after the baseline                                                                                    | O1             | real                                                          | `test/ui.test.ts:1299-1315`: a 1300 ms sleep (`:1310`), and the poll interval is 1000 ms (`cli/ui.ts:10`)                                        |
| 5   | The notifier URL is not URL-encoded, but the page decodes it                                                                                | O1, O2         | real (impact depends on the characters in an id; not checked) | `cli/hub/notify.ts:85`; `ui/app.tsx:120`                                                                                                         |
| 6   | Fixed sleeps make the baseline tests timing-dependent                                                                                       | O1             | **not verified**                                              | the sleeps exist (`test/ui.test.ts:1269,1385,1496`); that they flake is a runtime claim                                                          |
| 7   | The notification history is re-read and pushed every second                                                                                 | O1, O2         | real                                                          | `cli/hub/state.ts:236`; `cli/ui.ts:10,43`                                                                                                        |
| 8   | The PRD trace columns do not list ARK-178                                                                                                   | O1             | real                                                          | `docs/prd.md:65,68`; the ticket traces `[R10, R13]`; main's rows do not list it either                                                           |
| 9   | The AC4 test passes even if `#item=` selects nothing                                                                                        | O2             | real                                                          | `ui/app.tsx:111` shows `needs[0]` when nothing is selected; the test (`test/ui.test.ts:1485-1530`) has one item in a fresh `ARK_HOME` (`:42-52`) |
| 10  | The quiet-start tests only assert that no log file exists                                                                                   | O2             | real                                                          | `test/ui.test.ts:1313,1365-1366`                                                                                                                 |
| 11  | `ui install --port abc` writes `NaN` into a KeepAlive plist                                                                                 | O2             | real                                                          | `cli/ark.ts:182`                                                                                                                                 |
| 12  | An unchanged plist returns early without checking the agent is loaded                                                                       | O2             | real                                                          | `cli/ui.ts:187`                                                                                                                                  |
| 13  | A click-through consumes the hash before the Orca and Plannotator sources have loaded                                                       | G1, G2         | real                                                          | `ui/app.tsx:125-132`; `cli/ui.ts:76` sends state at connect and `:52-60` refreshes later                                                         |
| 14  | `uiUninstall` ignores a failed `launchctl unload`, deletes the plist and reports success                                                    | G1, G2         | real                                                          | `cli/ui.ts:229-230`                                                                                                                              |

## 4. Decision

The panel is two reviewers whose findings are merged; a defect counts as found when either one finds it. The only pair that ran is `gpt-6.1-sol` with `claude-opus-5-5`. The decision table is at the end of this section.

### 4.1 Cost per run

The extra cost comes from the `metrics.json` of the **latest 30 runs that have one**. I took every `~/.ark/projects/ark/runs/*/metrics.json` (110 files), ordered the runs by the time of their last event, and kept the last 30: `2026-11-03-ARK-191-1` through `2026-11-06-ARK-343-1`. This run (ARK-349) has no `metrics.json` yet. The figures:

- Total cost of the 30 runs $168.21, mean $5.61 per run.
- Reviewer cost (`cost.by_role.reviewer.usd`) $19.49 (11.6% of the total), mean **$0.65 per run** (median $0.53, lowest $0.23, highest $1.52). All 30 runs have a known reviewer cost.
- The 30 runs have 69 reviewer `step.started` events (2.3 per run, counting rework rounds) and 37 reviewer steps in their `plan.yml`; every one of the 37 uses `openai-codex/gpt-6.1-sol`. So the real reviewer cost is **$0.28 per review step start**.
- The ticket's own figure was $15.09 of about $102 over 30 runs. The window has moved since it was written, so I use my numbers.

**How the replayed cost compares** (round 2, with the diff). A replayed `gpt-6.1-sol` review cost $0.20 on average (range $0.11 to $0.33), 69% of the real $0.28 per review step. The replay is cheaper than a real step because it has no shell, runs no tests and reads no earlier findings. A replayed `claude-opus-5-5` review cost $1.09 (range $0.39 to $1.64), 3.9 times the real cost per step and 5.6 times the replayed `gpt-6.1-sol` cost on the same prompts. Time per review: `gpt-6.1-sol` 70 s on average (42 to 106 s), `claude-opus-5-5` 142 s (58 to 193 s). Tokens per review: `gpt-6.1-sol` 362,000 on average, `claude-opus-5-5` 1,335,000.

**Extra cost per run of the panel** (an Opus review added to every review step; `gpt-6.1-sol` stays as today). Two estimates, because the replay and the real steps differ:

- From the replayed Opus cost per review times the 2.3 review steps per run: $1.09 × 2.3 = **$2.50 per run**, +45% on the mean run cost.
- From the real reviewer cost scaled by the replayed price ratio: $0.65 × 5.6 = **$3.61 per run**, +64%.

So the extra cost is $2.5 to $3.6 per run. The ticket's estimate of about 15% assumed a second reviewer that costs what the first one does. Opus does not.

### 4.2 Recommendation

**No always-on panel.** Do not add a second reviewer model to every review step.

Reason:

- **The measured gain is one defect.** With the diff, the panel found 2 of 5 and `gpt-6.1-sol` alone found 1 of 5. The extra defect is ARK-310 gap 2, found in 1 of the 2 `claude-opus-5-5` reviews of that diff. Three of the five defects were found by none of the 24 reviews. The panel adds nothing to `claude-opus-5-5` alone.
- **It would cost $2.5 to $3.6 more per run,** a rise of 45% to 64% in the mean run cost. Over the roughly 110 runs that have metrics, that is about $275 to $400 extra, to have avoided 1 of the 5 escaped defects (ARK-310 gap 2). The panel pays only if one escaped defect costs more than that to find and fix later [INFERENCE: the cost of an escaped defect was not measured here; this is the break-even for the human to compare with].
- **Three defects were found by none of the 24 reviews** (ARK-217, ARK-309, ARK-310 gap 1). I did not test whether a reviewer with a shell, or a different prompt, would find them. [INFERENCE: ARK-309's AC9 scroll test depends on when each source has loaded, which is hard to see in a diff.]
- **The models do find real problems:** 101 of the 106 other findings in round 2 were real. `gpt-6.1-sol` alone gives 23 distinct real ones, and `claude-opus-5-5` adds 30 more (53 in the union). If those matter, that is a question for the reviewer rubric, not for a panel.

**What the data say about the model.** On this sample `claude-opus-5-5` was the stronger reviewer: 2 of 5 defects against 1, the control in 2 of 2 reviews against 0 of 2, and 43 distinct real findings against 23. It costs 5.6 times as much per review. If the human wants to spend more on review, replacing `gpt-6.1-sol` with `claude-opus-5-5` would add $1.85 to $2.96 per run and found everything the panel found; a panel of both is the more expensive way to get the same result. This is a hypothesis for a larger trial, not a finding.

**A "panel above a risk rule"** is not supported either. Four hits in 24 reviews, on two defects, give no pattern in which kind of run a second model helps, so no rule could be tested.

**Uncertainty.** This is a recommendation, not a proof:

- **Five defects.** One more or fewer hit moves "2 of 5" to 1 or 3. The ARK-310 gap 2 hit is one review of four on that diff, and the gap between `gpt-6.1-sol` and `claude-opus-5-5` rests on it.
- **Two repeats, same-model variance.** Two reviews of the same model on the same diff differ. `claude-opus-5-5` found ARK-181 in review 2 and not in review 1, and ARK-310 gap 2 in review 2 and not in review 1. Two repeats cannot show an effect smaller than that spread.
- **Round 1 against round 2.** Without the diff (round 1) no review found any defect under the strict rule, and none found the control. With the diff, 4 of 24 found a defect and 2 of 4 found the control. The comparison also carries run-to-run variance, so I take it as a sign that the diff matters, not as a size of the effect.
- **No-shell reviewers.** The replay could not run tests or commands. The control shows the cost: the real reviewer, with a shell, ranked ARK-213 as P1, and the two replays that named it ranked it P3. Reviewers that can run the tests may catch more than this replay did, and this spike cannot say how much.
- **Same diff, current playbook.** The replay reads the whole diff with today's reviewer section, not the older text and the delta-only re-reviews of the real runs.
- **One judge.** I judged the findings; another judge could move a near miss to a hit (for example the ARK-309 and ARK-310 gap 1 near misses) or the 4 unverified findings. A broader reading of "found" is in the sensitivity line below. "Real" means confirmed in the code, not confirmed by running it.
- **Third vendor.** Not tested: no third-vendor model works on this host.

**Sensitivity: a broader reading of "found".** If a related near miss counted as found, ARK-217 (both `gpt-6.1-sol` reviews flag the wrong escalation wait), ARK-309 (all 4 reviews flag the project list) and ARK-310 gap 1 (`claude-opus-5-5` flags the fake `orca` and `--full`) would join, giving `gpt-6.1-sol` 3 of 5 and `claude-opus-5-5` 4 of 5. I do not count them: none of those findings names the escaped defect's mechanism, and each fix would have left the escaped defect in place.

An approved recommendation becomes a proposed ticket. This spike does not write the ticket, and it changes no product code, playbook or setting.

### 4.3 Decision table

How to read it (all numbers are round 2, with the diff):

- "Found" is the best of the model's two reviews on each diff, under the strict rule. By review, `gpt-6.1-sol` found a defect in 2 of 12 reviews and `claude-opus-5-5` in 2 of 12 (both on different defects, plus 2 of 2 on the control).
- The panel adds one defect to `gpt-6.1-sol` alone (ARK-310 gap 2, from `claude-opus-5-5`) and none to `claude-opus-5-5` alone.
- "False" is a finding the code contradicts; "not verified" is a finding I could not settle from the source. Both count the findings other than the escaped defect.
- The extra cost of `claude-opus-5-5` alone is its cost minus today's $0.65 per run: $2.50 − $0.65 = $1.85 and $3.61 − $0.65 = $2.96.

| Panel (findings merged)                                        | Defects found of 5                               | ARK-213 control (the real reviewer found it) | False findings (merged) | Not verified (merged) | Extra cost per run                          |
| -------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------- | ----------------------- | --------------------- | ------------------------------------------- |
| `gpt-6.1-sol` alone (today)                                    | 1 (ARK-181)                                      | not found (0 of 2 reviews)                   | 0 of 42                 | 1                     | $0 (this is today's reviewer)               |
| `claude-opus-5-5` alone                                        | 2 (ARK-181, ARK-310 gap 2)                       | found, P3 (2 of 2 reviews)                   | 1 of 64                 | 3                     | +$1.9 to +$3.0 if it replaced `gpt-6.1-sol` |
| **`gpt-6.1-sol` + `claude-opus-5-5`** (the only pair that ran) | **2** (the same two; the second comes from Opus) | found, P3 (2 of 4 reviews)                   | 1 of 106                | 4                     | **+$2.5 to +$3.6**                          |

Round 1 for comparison (no diff, strict rule): 0 of 5 for every row, control not found in any of its 4 reviews, 0 false, 3 not verified (section 3).
