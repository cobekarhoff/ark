# Review panel spike: would a second reviewer model have caught the escaped defects?

Run ARK-349, replays done on 2026-11-07 with omp v18.16.0. **Question:** Ark reviews each change with one model (`openai-codex/gpt-6.1-sol`). Five reviews let a defect reach main (`reviewer: missed` in `escaped-defects.yml`). Would a second model, on the same prompt, have caught them?

**Answer: no, not in this sample.** The 24 replayed reviews found 1 of the 5 defects, once, and that single hit is a borderline call (see 2.3). The second vendor model, `claude-opus-5-5`, found none. Both models also missed the control, ARK-213, which the real reviewer found. A panel of the two models would have cost about $2.3 to $3.8 more per run (+41% to +68% of the mean run cost) for no measured gain over `gpt-6.1-sol` alone. The recommendation is **no panel** (section 3).

Three limits shape every number below: five defects, two repeats per model, and reviewers with no shell (section 1.4). Read the result as "no sign of a gain", not as proof that a panel can never help.

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
2. A short "Replay environment" block, the same text for every model; only the path and the shas change (below).
3. The reviewer section of `worker.md`, from the installed Ark plugin (`skills/ark/playbooks/worker.md` of the Ark repo, HEAD `3fb5e81e134348dd9ea4070b9c6ce61f8180a040`, the file last changed in `14f5cea356190c362657fcb8f2937c1e4d443c2a` on 2026-11-06). The six runs were reviewed with older versions of that section; the current one is used for all six. The text is in `results/spike/reviewer-section.md`.
4. The run's `ticket.md`.
5. The run's `plan.md`.

Left out on purpose, because each would reveal a defect or the model: findings files, `retro.md`, `plan.yml` (its model field names the reviewer), `events.ndjson` and `escaped-defects.yml`. No prompt names or hints at the defect. Prompts are in `results/spike/prompts/<run>.md` (225 to 370 lines each).

The replay environment text, with `<…>` filled per run:

> Your working folder is the checkout `<scratch checkout>` (git repo, branch `review`, HEAD = `<head>`). The run base commit is `<base>` (branch `base`). The diff to review is `git diff $(git merge-base HEAD base)..HEAD`. There is no run folder, no `events.ndjson` and no `plan.yml`: the text of `plan.md` and `ticket.md` is below. Treat the checkout as read-only: do not edit, commit, stash, reset or checkout. Instead of writing a findings file, print the findings file content as your final answer, in the format of the Reviewer section (`Reviewed head: <sha>` first, findings, `## Merge risk`, `Verdict:` line).

### 1.4 How the models ran

Command, run from the scratch checkout of each review (proven on omp v18.16.0 in `results/spike/omp-command.md`):

```sh
omp --model <provider/model> --mode json -p @<prompt file> \
    --tools read,grep,find,glob --thinking medium \
    --no-lsp --no-extensions --no-title \
    --session-dir <out dir>/<run>-<model>-<n>
```

- **Thinking level:** `medium`, the same for both models. omp's output stream does not record the level, so this is what the command line set.
- **Tools:** `read`, `grep`, `find`, `glob` only. The streams of the 24 reviews show 514 `read`, 186 `grep`, 56 `glob` and 13 `find` calls and nothing else.
- **No bash.** omp has no read-only sandbox for a shell, so no model could run `git diff`, the tests or any repro command. Every review says so in its own text, and most read the files at head in place of the diff. The playbook says a P0 or P1 needs a repro command with quoted output, so a no-shell reviewer files its findings as P2. **Findings were capped at what a reviewer without a shell can claim.** This is stricter than a real review step, which can run the tests. It is also why no review here has a rank above P2 for a found defect: the one P1 in the 24 reviews (306, claude-opus-5-5 review 2) has a `grep` repro.
- **Other differences from a real step:** `skills/ark/principles.md` is not in the scratch checkouts, so no finding names a principle; there is no run folder, so the reviewer reads the plan text from the prompt; skills (`read skill://<name>`) stay enabled; the playbook version is the current one (1.3).
- **Real model:** each turn of the omp stream records the provider and model that answered. All 24 reviews show only the model that was asked for (`openai-codex/gpt-6.1-sol` or `anthropic/claude-opus-5-5`), so no sub-session or fallback model ran. Tokens and cost are the sums over the turns of each stream (`usage.totalTokens` and `usage.cost.total`; the token count includes cache reads). omp computes the cost from token prices; whether `openai-codex` usage is billed is outside the stream. Wall time is from the shell, or from the stream timestamps for the four reviews of run 179, which the replay step reused from a finished first attempt (exit status assumed 0, `agent_end` present).
- **ARK-213 control:** the real review of run 178 found the defect as P1 with a shell. The replay of that same diff is the check that the setup can find a defect at all.

## 2. Models tried and what they found

### 2.1 Models

| Model                                       | Role                       | Result                                     |
| ------------------------------------------- | -------------------------- | ------------------------------------------ |
| `openai-codex/gpt-6.1-sol`                  | control (today's reviewer) | ran, 2 reviews on each of the 6 diffs (12) |
| `anthropic/claude-opus-5-5`                 | second vendor              | ran, 2 reviews on each of the 6 diffs (12) |
| `opencode-go/beam-free`                     | third vendor, tried        | does not work: `401 api_key_expired`       |
| `openrouter/~anthropic/claude-fable-latest` | third vendor, tried        | does not work: `401 User not found`        |

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

I judged all 24 reviews myself, one finding at a time, in this step. I am a model too (`anthropic/claude-sonnet-5-5`), so a bias toward findings from the same vendor as the judge is possible; no human checked my verdicts. I ran no tests.

- **Found.** A finding counts as "found" only if it names the escaped defect's mechanism. I read the `escaped-defects.yml` entry and the fix commit for each defect (1.1), then compared each finding with the mechanism. A finding in the same function that names a different problem is not found.
- **Real.** A finding is "real" only if I confirmed its central claim in the code at the pinned head, with a file and line cited in 2.4. For a test finding, the test source had to show what the finding says. I did not run code, so a claim about runtime behaviour that the source alone does not settle is **not verified**, and I never count it as real. A finding fixed later in main also counts as real; I note those cases. The hub code of runs 178, 179, 181 and 291 was rewritten in main, so "fixed later" rarely applies: I checked each finding at head instead.
- **False.** A finding whose claim the code at head contradicts. I found none.
- **Rank.** The rank the reviewer gave, P0 to P3. Every found defect was ranked P2.

### 2.3 Which defects were found

| Defect                       | gpt-6.1-sol (2 reviews)                           | claude-opus-5-5 (2 reviews) |
| ---------------------------- | ------------------------------------------------- | --------------------------- |
| 1. ARK-217 (run 179)         | not found                                         | not found                   |
| 2. ARK-181 (run 181)         | not found                                         | not found                   |
| 3. ARK-309 (run 291)         | not found                                         | not found                   |
| 4. ARK-310 gap 2 (run 186)   | **found in review 1**, P2 (borderline, see below) | not found                   |
| 5. ARK-310 gap 1 (run 306)   | not found                                         | not found                   |
| 6. ARK-213 control (run 178) | not found                                         | not found                   |

- **Found in 1 of 24 reviews.** `gpt-6.1-sol` review 1 of run 186, P2: "Actual models can include the run lead's model instead of only the worker's models" (`cli/retro.ts:515`). The model says that `actualModels` takes every message that `assignSteps` attributes to a step by working folder and time window, so a message from another session, the run lead's, lands in the step's model set and "can falsely set `same_vendor_review`". The code at head confirms the path: `windowOf` attributes a message to a step by `isInside(message.cwd, …/workspace/<repo>)` and the time window only (`cli/retro.ts:114-127`), and `same_vendor_review` is built from those models (`cli/retro.ts:568-573,597`). That is the mechanism of ARK-310 gap 2, where a sonnet sub-session inside a codex review step was attributed to the step. **Borderline:** the foreign model the finding names is the run lead's session, not an omp sub-session. I counted it as found. Read strictly, the answer is 0 of 5 for every model and the panel.
- **Near miss, ARK-217.** `claude-opus-5-5` review 1 of run 179 reads `gateWaits` at `cli/retro.ts:209-213` and notes that it opens a `plan` wait at every valid `plan.checked`. Its finding is that unanswered waits stay open until the run ends (`cli/hub/detail.ts:121,183`). That is real (finding 1 of 2.4) but a different problem: the escaped defect is that a re-check replaces the open wait, so the wait counts from the last check. Not found.
- **ARK-213 control.** None of the 4 reviews names the defect. The two `gpt-6.1-sol` reviews flag `uiUninstall` ignoring a failed `launchctl unload` (`cli/ui.ts:229-230`), and `claude-opus-5-5` review 2 flags the unchanged-plist early return (`cli/ui.ts:187`). Both are real, neither is the update path that writes the new plist and then deletes it when the load fails (`cli/ui.ts:195-200`). The real reviewer, with a shell, found it. So the replay setup, with no shell, did not reproduce a find that the real process made.
- **ARK-310 gap 1 and ARK-309.** All 4 reviews of each read the code that holds the defect and none flagged it. For gap 1, `claude-opus-5-5` review 1 even lists the `chief state` "unavailable" and "none" behaviour under "Checked with no finding". For ARK-309, `gpt-6.1-sol` reviews 1 and 2 report that the project switcher lists only projects with tickets (`hub/page/Roadmap.tsx:157-162`). That is real, but it is a different gap from the escaped defect, which concerned the states the switcher was missing from; the in-run fix `1f3f9fd` is already in the head.

### 2.4 Results of every review

One row per review. "Other findings" counts every finding except the escaped defect. "Real" and "Not verified" split that count by 2.2; the rest is false (none). Tokens include cache reads.

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
| gpt-6.1-sol     | 1      | yes   | P2   | 2              | 2    | 0            | 243,088 | $0.15 | 69 s      | openai-codex/gpt-6.1-sol  |
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

Totals over the 24 reviews:

| Model           | Reviews | Reviews that found the defect | Findings other than the defect | Real | Not verified | False | Tokens     | Cost   | Mean cost per review | Mean wall time |
| --------------- | ------- | ----------------------------- | ------------------------------ | ---- | ------------ | ----- | ---------- | ------ | -------------------- | -------------- |
| gpt-6.1-sol     | 12      | 1                             | 33                             | 33   | 0            | 0     | 3,522,231  | $2.06  | $0.17                | 72 s           |
| claude-opus-5-5 | 12      | 0                             | 66                             | 63   | 3            | 0     | 16,140,892 | $12.13 | $1.01                | 133 s          |
| both            | 24      | 1                             | 99                             | 96   | 3            | 0     | 19,663,123 | $14.19 | $0.59                | 103 s          |

Replay cost is $14.19 in all. Opus costs 5.9 times what `gpt-6.1-sol` costs on the same prompts, and takes 1.8 times as long. `claude-opus-5-5` also files twice as many findings (66 against 34).

Distinct real findings other than the escaped defects, after removing repeats within a diff: `gpt-6.1-sol` 20, `claude-opus-5-5` 43, 12 of them in both, 51 in the union. The 3 findings I could not verify all come from `claude-opus-5-5` (run 178 rows 3 and 6, run 291 row 2 in 2.5). So a panel finds more real problems than one model (51 against 43 and 20), but none of the extra ones is an escaped defect.

### 2.5 The findings I judged

One table per diff. "Found by" uses G1 and G2 for the two `gpt-6.1-sol` reviews and O1 and O2 for the two `claude-opus-5-5` reviews. Paths are from the repo root at the pinned head. A finding that two reviews state in different words is one row.

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

| #   | Finding                                                                                                                    | Found by       | Verdict                   | Evidence at head                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The AC3 "false" tests pass because build and review ran in different repos                                                 | O1, O2, G1, G2 | real                      | `test/retro.test.ts:759,781` use `installAllSessions` (build in `repos/platform`, review in `repos/shared`); `cli/retro.ts:123` groups by the executed repo |
| 2   | The docs say "each plan step ID", but the keys are the steps that started                                                  | O1, O2, G1, G2 | real                      | `docs/reference/cli.md:164`; `cli/retro.ts:475`                                                                                                             |
| 3   | `model changed:` fires on any spelling difference, such as a role alias                                                    | O2             | real                      | `cli/retro.ts:535`; the role aliases are in `docs/reference/cli.md:368`                                                                                     |
| –   | **The escaped defect (G1):** a run lead's session is attributed to a root-repo step, so `same_vendor_review` can read true | G1             | **found**, P2, borderline | `cli/retro.ts:114-127,568-573,597` (see 2.3)                                                                                                                |

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

## 3. Decision

The panel is two reviewers whose findings are merged; a defect counts as found when either one finds it. The only pair that ran is `gpt-6.1-sol` with `claude-opus-5-5`. The decision table is at the end of this file.

### 3.1 Cost per run

The extra cost comes from the `metrics.json` of the **latest 30 runs that have one**. I took every `~/.ark/projects/ark/runs/*/metrics.json` (110 files), ordered the runs by the time of their last event, and kept the last 30: `2026-11-03-ARK-191-1` through `2026-11-06-ARK-343-1`. This run (ARK-349) has no `metrics.json` yet. The figures:

- Total cost of the 30 runs $168.21, mean $5.61 per run.
- Reviewer cost (`cost.by_role.reviewer.usd`) $19.49 (11.6% of the total), mean **$0.65 per run** (median $0.53, lowest $0.23, highest $1.52). All 30 runs have a known reviewer cost.
- The 30 runs have 69 reviewer `step.started` events (2.3 per run, counting rework rounds) and 37 reviewer steps in their `plan.yml`; every one of the 37 uses `openai-codex/gpt-6.1-sol`. So the real reviewer cost is **$0.28 per review step start**.
- The ticket's own figure was $15.09 of about $102 over 30 runs. The window has moved since it was written, so I use my numbers.

**How the replayed cost compares.** A replayed `gpt-6.1-sol` review cost $0.17 on average (range $0.12 to $0.25), 61% of the real $0.28 per review step. The replay is cheaper than a real step because it has no shell, runs no tests and reads no earlier findings. A replayed `claude-opus-5-5` review cost $1.01 (range $0.36 to $2.02), 3.6 times the real cost per step and 5.9 times the replayed `gpt-6.1-sol` cost on the same prompts.

**Extra cost per run of the panel** (an Opus review added to every review step; `gpt-6.1-sol` stays as today). Two estimates, because the replay and the real steps differ:

- From the replayed Opus cost per review times the 2.3 review steps per run: $1.01 × 2.3 = **$2.33 per run**, +41% on the mean run cost.
- From the real reviewer cost scaled by the replayed price ratio: $0.65 × 5.9 = **$3.84 per run**, +68%.

So the extra cost is $2.3 to $3.8 per run. The ticket's estimate of about 15% assumed a second reviewer that costs what the first one does. Opus does not.

### 3.2 Recommendation

**No panel.** Do not add a second reviewer model to the review step, for any run.

Reason:

- The replay gives no sign that a second model would have caught these defects. The panel found 1 of 5 (borderline), the same as `gpt-6.1-sol` alone, and `claude-opus-5-5` found none. The control is 0 for both models.
- It would cost $2.3 to $3.8 more per run, a rise of 41% to 68% in the mean run cost, for no measured catch.
- Three of the five escaped defects (the fixture date in ARK-181, the test timing in ARK-309, the model of an omp sub-session in ARK-310 gap 2) turn on things the diff text does not show: today's date, timing, which model ran. A second vendor reading the same text does not supply them. [INFERENCE: I did not test this.]
- The models do find real problems: 96 of the 99 other findings were real. `gpt-6.1-sol` alone gives 20 distinct real ones, and `claude-opus-5-5` adds 31 more, none of them an escaped defect. If those matter, that is a question for the reviewer rubric, not for a panel.

A "panel above a risk rule" is not supported either. With 1 hit in 24 reviews there is no pattern in which kind of run a second model helps, so no rule could be tested.

**Uncertainty.** This is a recommendation, not a proof:

- **Five defects.** One hit more or fewer moves "1 of 5" to 0 or 2. The one hit is borderline, and I would drop it on a strict reading.
- **Two repeats, same-model variance.** Two reviews of the same model on the same diff differ. The one hit is in review 1 and not in review 2. On run 306 `claude-opus-5-5` review 2 filed a P1 and review 1 did not. The spread inside one model is as large as the gap between the models, and two repeats cannot show an effect smaller than that.
- **No-shell reviewers.** The replay could not run tests or commands. The control shows the cost: the real reviewer, with a shell, found ARK-213 as P1, and 0 of the 4 no-shell reviews did. Reviewers that can run the tests may catch more than this replay did, and this spike cannot say how much.
- **Same diff, current playbook.** The replay reads the whole diff with today's reviewer section, not the older text and the delta-only re-reviews of the real runs.
- **One judge.** I judged the findings; another judge could move the borderline hit or the three unverified findings. "Real" means confirmed in the code, not confirmed by running it.
- **Third vendor.** Not tested: no third-vendor model works on this host.

An approved recommendation becomes a proposed ticket. This spike does not write the ticket, and it changes no product code, playbook or setting.

### 3.3 Decision table

How to read it:

- "Found" is the best of the model's two reviews on each diff. By review, `gpt-6.1-sol` found a defect in 1 of 12 reviews and `claude-opus-5-5` in 0 of 12.
- The panel adds nothing to `gpt-6.1-sol` alone in found defects: the one hit came from `gpt-6.1-sol`.
- "False" is a finding the code contradicts: none. "Not verified" is a finding I could not settle from the source: 3, all from `claude-opus-5-5`. Both count the findings other than the escaped defect.
- The extra cost of `claude-opus-5-5` alone is its cost minus today's $0.65 per run: $2.33 − $0.65 = $1.68 and $3.84 − $0.65 = $3.19.

| Panel (findings merged)                                        | Defects found of 5                          | ARK-213 control (the real reviewer found it) | False findings (merged) | Not verified (merged) | Extra cost per run                          |
| -------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------- | ----------------------- | --------------------- | ------------------------------------------- |
| `gpt-6.1-sol` alone (today)                                    | 1 (run 186, borderline; 0 if read strictly) | not found (0 of 2 reviews)                   | 0 of 33                 | 0                     | $0 (this is today's reviewer)               |
| `claude-opus-5-5` alone                                        | 0                                           | not found (0 of 2 reviews)                   | 0 of 66                 | 3                     | +$1.7 to +$3.2 if it replaced `gpt-6.1-sol` |
| **`gpt-6.1-sol` + `claude-opus-5-5`** (the only pair that ran) | **1** (same defect; 0 if read strictly)     | not found (0 of 4 reviews)                   | 0 of 99                 | 3                     | **+$2.3 to +$3.8**                          |
