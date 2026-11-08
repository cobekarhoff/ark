# Scenarios

Three runs, step by step: what the human does, what each agent does, what the `ark` command refuses, and what lands at the end. The first uses a real run on this repo. The other two are the shape of a run, not a transcript. The [architecture](architecture.md) page explains each part; [the tour](../tour.html) lets you click through the same states.

## 1. One repo: a ticket on Ark itself

Run `2026-11-05-ARK-311-1`. The ticket changed how Ark proves acceptance criteria: nine ACs, two implementer steps, two validator steps, one cross-vendor review. It merged as [#123](https://github.com/cobekarhoff/ark/pull/123) after three rounds.

```mermaid
sequenceDiagram
  autonumber
  participant You
  participant MC as Master Chief
  participant RL as Run lead
  participant W as Workers
  participant ark as ark command
  You->>MC: run ARK-311
  MC->>ark: ark run start ARK-311
  MC->>RL: start run lead (Orca)
  RL->>W: evaluator
  W-->>RL: evaluation.md: 0 blockers, 8 risks
  RL->>MC: criteria gate: 9 ACs, method and verified_by
  MC->>You: accept?
  You-->>MC: accept
  RL->>ark: ark strategy record (1 card: no gate)
  RL->>ark: ark plan check → plan.md
  RL->>MC: plan gate
  MC->>You: plan.md in Plannotator
  You-->>MC: approve
  loop round 1 to 3
    RL->>W: implementer cli-core, then docs-rules
    RL->>W: validator ac-tests, doc-tests
    RL->>ark: ark test → every AC at head
    RL->>W: reviewer (Codex, fresh context)
    W-->>RL: findings: 3 P0, 1 P1 with repro
    RL->>RL: re-run each repro, send back 3, leave 1
  end
  RL->>MC: escalation: budget spent after round 2
  MC->>You: one more round, take over, abort?
  You-->>MC: one_more_round
  RL->>ark: ark merge-request open (refuses once: AC literal missing)
  RL->>ark: ark test, then open again → PR #123
  MC->>You: PR open, one waived P0 is your decision
  Note over You: merge on the host
  RL->>ark: ark retro → metrics.json, writes retro.md
  MC->>You: three questions, one learning, one check proposed
```

What each gate looked like:

1. **Criteria.** The evaluator found no blockers and eight risks, among them that the always-open criteria gate would stall every existing test fixture. Those risks went into the implementer's spec word for word. You accepted the nine ACs with their `method` and `verified_by`.
2. **Plan.** One strategy card, so no strategy gate. `plan.md` showed five steps in a graph (`cli-core` → `docs-rules`, `ac-tests` → `doc-tests` → `repo-review`), the Design block with each interface and its callers, and the test cases as Gherkin. You approved.
3. **Rounds.** Round 1 review: three P0s and a P1, each with a `Repro:` command and quoted output. The run lead re-ran every repro. Three were sent back (docs still stated the old rules; pytest and behave reports were hand-built instead of captured; parsers dropped the slash-form AC tag). One P0, touched old-id tests not converted, was left: the ticket said not to migrate old tests in bulk and the edits were fixture-only. Round 2 fixed two; one docs file still used other words, so round 3 was needed.
4. **Escalation.** The budget of two was spent after round 2. You answered `one_more_round`.
5. **Merge request.** `ark merge-request open` refused the first time: the AC literal `ark test-case new ARK` was in no tracked file. The validator added it, `ark test` ran again, the PR opened. You merged it.
6. **Retro.** $8.48, 33.6 M tokens, 7.3 hours wall. Twelve orchestration restarts, nine tool errors. Two proposals: a learning that a validator spec lists the ACs' backticked literals, and a docs-rule step that greps diagrams as well as prose. You approved the first; it is enforced by the `ark merge-request open` AC-literal refusal.

What the human did, in total: named the ticket, accepted the criteria, approved the plan, answered one escalation, waived one finding, merged. Everything else was unattended.

## 2. A dependency chain: one ticket across several repos

Clara and Smart QC are the same shape: a meta-repo workspace with `repos/*` cloned from a GitLab group, knowledge files at the root, and docker compose to run the services together. One ticket needs a change in a shared package and in the service that uses it.

```mermaid
flowchart TB
  subgraph plan[Plan: steps in needs order]
    s1[implementer<br/>repos/shared/packages] --> s2[validator<br/>repos/shared/packages]
    s1 --> s3[implementer<br/>repos/platform<br/>needs: shared]
    s3 --> s4[validator<br/>repos/platform<br/>compose runs both worktrees]
    s2 & s4 --> s5[reviewer<br/>both repos, one diff per repo]
  end
  s5 --> t[ark test<br/>docker compose --project-directory run/workspace<br/>every AC at head across both]
  t --> mr1[MR 1: shared/packages]
  mr1 --> mr2[MR 2: platform<br/>Depends on !1]
  mr2 --> you{You merge 1, then 2}
  classDef g fill:#fff3cd,stroke:#b8860b
  class you g
```

Step by step:

1. **Evaluate.** The evaluator reads the ticket, the workspace's `AGENTS.md` and `knowledge/`, and the code in both repos. It names which repos change and in what order, and any AC that no integration test could prove across the boundary.
2. **Criteria.** You accept each AC's `method` and `verified_by`. An AC that only a person can check in a running stack gets `method: demonstration` and a `manual: true` flag.
3. **Plan.** `plan.yml` has one step per role per repo, with `needs` running from the package to the service. The design block lists the changed interface in the package and every caller in the service. `ark plan check` refuses a cycle or a service step that does not `need` the package step.
4. **Worktrees.** `ark worktree create` mirrors the workspace into the run folder: the two repos the run touches become worktrees on the same branch name; everything else, including `docker-compose.yml` and `knowledge/`, is a symlink. The service builds against `../shared/packages` because the compose file's `./repos/*` paths resolve inside the run folder.
5. **Build and prove.** The package implementer finishes first; the service implementer starts after. Validators write integration tests that run through compose against both worktrees. `ark test` runs every suite from the run folder and decides each AC from its `verified_by` cases at head. A `manual` AC waits for your `ok` from a running stack.
6. **Review.** One reviewer step covers both repos: one diff per repo against its base, the callers read across the boundary.
7. **Merge requests.** `ark merge-request open` pushes both branches and opens one MR per repo in merge order (the repo edges of the plan, upstream first), with a dependency where the GitLab tier allows it and `Depends on !N` in the description otherwise. You merge the package MR first; the service MR's pipeline runs against the merged package.
8. **While open.** A failed pipeline, a comment or a conflict in either MR starts an MR round on that repo. `ark worktree sync` merges the target branch into each worktree and pushes every open branch; a conflict goes to an implementer with `--merge`.

The point of the shape: one ticket, one run, one plan, one proof across the chain, and the order of the MRs comes from the plan, not from a person remembering it.

## 3. A hand-off: a repo where Ark may not push

Smart QC today runs with `merge_requests: none` and every clone has its push URL disabled. Ark does the whole run and stops before the host.

```mermaid
flowchart LR
  run[Run: evaluate, criteria, plan, build, prove, review] --> sync[ark worktree sync<br/>exit 0, nothing pushed]
  sync --> close[ark run close handed_off<br/>branches stay in their clones<br/>worktrees removed]
  close --> you{You review the branch<br/>and open the MR yourself}
  close --> retro[retro.md as for any run]
  classDef g fill:#fff3cd,stroke:#b8860b
  class you g
```

What differs from scenario 1:

- `ark merge-request open` refuses in a `merge_requests: none` project. The run lead runs `ark worktree sync`, reads that it exited 0, and goes straight to the retro.
- Every refusal that guards an MR still runs at close: the last `ark test` passed at the latest commit, every manual AC is `ok`, every AC literal is in a tracked file, no commit followed the last test. A run cannot be handed off with less proof than it would need to open an MR.
- The outcome is `handed_off`. Each branch with commits beyond its base stays in its clone under `review/<ticket>`; the worktrees are removed. Master Chief tells you which branches to look at.
- Skills in the product repo that contain push steps are skipped by the workers; the run lead says so in the plan.

This is the mode for a regulated product repo while its own validation and review gates are the record: Ark produces the branch, the passing tests at head and the review findings, and a person carries them across the line. When the git-host gate can verify that evidence itself, the same project switches to `merge_requests: open` with no other change to the run.

## What the three have in common

|                          | One repo                           | Dependency chain                               | Hand-off                                      |
| ------------------------ | ---------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| Where you decide         | criteria, plan, escalation, merge  | the same, plus manual ACs from a running stack | the same, minus merge; you open the MR        |
| Proof                    | test cases at head in one worktree | test cases at head across composed worktrees   | the same; checked at close instead of at open |
| What Ark refuses         | an MR before every AC passes       | an MR out of merge order; a plan with a cycle  | any push                                      |
| What lands               | one MR                             | one MR per repo, in order                      | branches in their clones                      |
| What you read afterwards | `retro.md`, `metrics.json`         | the same, per run                              | the same                                      |
