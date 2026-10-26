# Playbook: ticket

For a ticket with new or changed behavior. `<run>` below is the run id printed by `ark run start`; `<dir>` is its folder (`~/.ark/projects/<project>/runs/<run>`, or `$ARK_HOME/...`). Human gates: G1 plan, G2 evidence; then host merge.

## Steps

Copy these ten lines into the todo list verbatim.

1. Intake: read the ticket and its ACs; open G0 only if the ticket has no acceptance criteria
2. Analyze: read the code the ACs touch and record the analysis
3. Plan: write plan.md and get G1 approval
4. Implement: create the worktree and spawn the implementer
5. Validate: spawn the validator and prove the ACs red then green
6. Review: spawn reviewer-x on the change
7. Judge: bucket every finding and record the judgment
8. Fix loop: send Act-on findings and failures back, at most two rounds, then GE
9. Evidence pack: pass trace-check and get G2 approval
10. MRs: open the PRs with ark mr; the human merges

## Calls per step

Run each command through bash. A non-zero exit is a refusal: read its message, fix the cause, never work around it.

### 1. Intake
- State `awaiting_g0` (no ACs): `ark gate packet <run> G0` prints the packet sha256. `ask` with Accept / Edit / Abort, then `ark gate answer <run> G0 accept|edit|abort --packet <sha256>`. (`abort`: stop.) Drafting ACs into the run is not wired yet: on accept or edit, tell the human to add the ACs to the ticket file and start a fresh run.
- Otherwise: read `<dir>/ticket.md` and `<dir>/ac.yml`; the AC IDs are final. `skip: ACs present, G0 not needed` for the G0 part.

### 2. Analyze
- Read the code (use `scout` agents for wide exploration). Write `<dir>/analysis.md`: what the ACs touch, risks, the contract between pieces.
- `ark advance <run> analysis.completed`

### 3. Plan
- Write `<dir>/plan.md`: approach, the contract, one test per AC at the strongest practical boundary, and a risk tier.
- `ark gate packet <run> G1` (prints `sha256:...`).
- `ask` with the fixed answers: Approve / Request changes / Abort.
- `ark gate answer <run> G1 approve|change|abort --packet <sha256>`. On `change`, revise `plan.md` and repeat from the packet. On `abort`, stop.

### 4. Implement
- `ark advance <run> build.started`
- `ark ws create <run>` (add `--repo <path>` per extra repo). It prints the worktree `<dir>/ws/<repo>`, the branch and `base_sha`.
- Spawn with the `task` tool, `agent: implementer`. The brief carries: ticket text, AC IDs, plan.md contract, the worktree path, the branch, and prior findings (none in round 0). Subagents see nothing else.
- Write the agent's typed result as JSON to `<dir>/inbox/implementer.json`, then `ark artifact record <run> implementer <dir>/inbox/implementer.json`. A schema failure is a refusal: respawn with the error. Status `blocked`: stop and tell the human.
- `ark advance <run> implementer.completed --data '{"repo":"<repo>"}'`. It refuses when the diff touches an AC-tagged test or the worktree is dirty.

### 5. Validate
- Spawn `agent: validator`. The brief carries: the AC IDs, plan.md, the worktree path, `<run>`, `base_sha` (from `<dir>/state.json`), the list of `ark test` calls it may make, and the rule path `rule://test-audit` (fallback: `<this skill dir>/../../rules/test-audit.md`).
- The validator itself runs `ark test <run> --acs <ids> --red-green`. Red-green refuses until `implementer.completed` is recorded for every repo.
- Write its result to `<dir>/inbox/validator.json`, then `ark artifact record <run> validator <dir>/inbox/validator.json`. Read `test_audit`: any `fail` entry is a defect to fix.
- `ark advance <run> build.completed` (state moves to `judging`, whatever the verdicts; step 7 and 8 decide what goes back).

### 6. Review
- Spawn `agent: reviewer-x`. The brief carries: spec, AC IDs, plan.md, `base_sha`, head SHA, the worktree path, prior findings.
- Write its result to `<dir>/inbox/reviewer-x.json`, then `ark artifact record <run> reviewer <dir>/inbox/reviewer-x.json`.

### 7. Judge
- For every reviewer finding, and every failed validator verdict or `test_audit` entry, decide a bucket: `act_on`, `consider`, `noted`, `dismissed`, each with a `reason`. Verify before you bucket: read the code at `file:line`.
- An `act_on` P0 or P1 needs `evidence`: `{"failing_test": "<test name>"}` (a test that fails now; spawn the validator to write one) or `{"trace_path": "<file:line -> file:line ...>"}` (the concrete execution path you traced). Without it, bucket `consider`. P2 and P3 never block.
- Write `<dir>/inbox/findings-<n>.json`, an array of `{id, reviewer, model, priority, file, line, claim, bucket, reason, evidence?}`. `model` is the model that actually answered, from the agent's session. Then `ark findings record <run> <dir>/inbox/findings-<n>.json`.

### 8. Fix loop
- Exit when there is no open `act_on` P0/P1 and every AC passes: `skip: clean` and go to step 9.
- Otherwise, round 1 or 2: write `<dir>/premise.md` first (the premise this fix shares with the last; check it directly before round 2). `ark advance <run> fix_round.started` (back to `building`). Respawn the implementer with the Act-on findings, failing tests and their evidence in the brief; repeat steps 4 (record + `implementer.completed`), 5, 6 and 7 on the new head.
- After the second round still fails: write `<dir>/premise.md` (the premise both fixes shared, and your diagnosis), `ark gate packet <run> GE` (premise plus the latest findings; prints `sha256:...`). `ask` with One more round (fold any guidance the human gives into the next brief) / Take over / Abort, then `ark gate answer <run> GE one_more_round|take_over|abort --packet <sha256>`. `ark advance` refuses `ge.*`: escalation is a gate. One more round and take over return to `building`; abort ends the run.

### 9. Evidence pack
- `ark trace-check <run>` writes `<dir>/trace-matrix.md` and exits 0 when it passes. Exit 1 prints why: fix it through step 8.
- `ark gate packet <run> G2` (refuses unless the latest trace-check passed). `ask` with Approve to open MRs / Send back / Abort. `ark gate answer <run> G2 approve|send_back|abort --packet <sha256>`.

### 10. MRs
- `ark mr <run>` opens one PR per repo and never merges. After the human merges on the host: `ark advance <run> run.completed`.
