# Playbook: ticket

For a ticket with new or changed behavior. `<run>` below is the run id printed by `ark run start` (`<date>-<ticket>-<n>`); `<dir>` is its folder (`~/.ark/projects/<project>/runs/<run>`, or `$ARK_HOME/...`). Human gates: G0 AC clarity (only when the ticket has no ACs), G1 plan, escalation (`GE`, only when the round budget is spent), G2 evidence; then the host merge. An answer is the human's: they run `ark gate answer` in their own terminal and type the gate name; you never can.

## Steps

Copy these ten lines into the todo list verbatim.

1. Intake: read the ticket and its ACs; open G0 only if the ticket has no acceptance criteria
2. Analyze: read the code the ACs touch and record the analysis
3. Plan: write plan.md and get G1 approval
4. Implement: create the worktree and spawn the implementer
5. Validate: spawn the validator and prove the ACs red then green
6. Review: spawn reviewer-x on the change
7. Judge: bucket every finding and record the judgment
8. Rounds: send verified findings and failed checks back within the round budget, then escalation (`ark gate ... GE`)
9. Evidence pack: pass trace-check and get G2 approval
10. MRs: open the MRs with ark mr; the human merges and records the outcome

## Calls per step

Every `ark ...` call below is the typed tool named after it (`ark advance` is `ark_advance`, `ark gate packet` is `ark_gate_packet`, `ark trace-check` is `ark_trace_check`); you have no bash. A tool error is a refusal: read its message, fix the cause, never work around it.

**Gate answers (every `ark gate answer` below).** There is no tool for it and you never run it: an answer comes only from the human typing it in their own terminal (ADR 0002). After `ark_gate_packet`, `ask` the human with the fixed answers; the question carries the exact command for each answer, e.g. `ark gate answer <run> G1 approve --packet <sha256>`, to type in their terminal. Wait for them to say it is done, then read `<dir>/state.json` and go on only if its `gates` entry for the gate shows the answer; if it does not, say so and wait. If `ask` is not available (print mode), print the question and the commands and stop.

### 1. Intake
- State `awaiting_g0` (no ACs): `ark gate packet <run> G0` prints the packet sha256. `ask` the human with the packet and Accept / Edit / Abort; they answer with `ark gate answer <run> G0 <answer> --packet <sha256>` in their terminal. `abort`: stop. On `edit` the run stays at G0 and no later step is legal: the human adds the ACs to the ticket file, you run `ark ac update <run>` (it re-reads the ticket's ACs into `ac.yml` and records `ac.updated`), build a new G0 packet and the human answers again; only `accept` lets the run continue.
- Otherwise: read `<dir>/ticket.md` and `<dir>/ac.yml`; the AC IDs are final. `skip: ACs present, G0 not needed` for the G0 part.

### 2. Analyze
- Read the code (use `scout` agents for wide exploration). Write `<dir>/analysis.md`: what the ACs touch, risks, the contract between pieces.
- `ark advance <run> analysis.completed`

### 3. Plan
- Write `<dir>/plan.md`: approach, the contract, one test per AC at the strongest practical boundary, and a risk tier.
- Add `kind: new` (behavior absent before the change) or `kind: preserved` (present before and after) to every AC in `<dir>/ac.yml`: you propose it, the human confirms it by approving G1, and the answer `approve` is refused while any AC has no kind. The G1 packet lists the ACs that lack one.
- `ark gate packet <run> G1` (prints `sha256:...`).
- `ask` the human with the packet and the fixed answers Approve / Request changes / Abort: `ark gate answer <run> G1 approve|change|abort --packet <sha256>` in their terminal. On `change`, revise `plan.md` and repeat from the packet. On `abort`, stop.

### 4. Implement
- `ark advance <run> build.started`
- `ark ws create <run>` (add `--repo <path>` per extra repo). It prints the worktree `<dir>/ws/<repo>`, the branch and `base_sha`.
- Spawn with the `task` tool, `agent: implementer`. The brief carries: ticket text, AC IDs, plan.md contract, the worktree path, the branch, and prior findings (none in round 0). Subagents see nothing else.
- Write the agent's typed result as JSON to `<dir>/inbox/implementer.json`, then `ark artifact record <run> implementer <dir>/inbox/implementer.json`. A schema failure is a refusal: respawn with the error. Status `blocked`: stop and tell the human.
- `ark advance <run> implementer.completed --data '{"repo":"<repo>"}'`. It refuses when the diff touches an AC-tagged test or the worktree is dirty. When a human has taken over at an escalation, `state.json` has `implementer: human` and `next_action` asks the human to implement: the human commits in the worktree, then you record their step with the same command (it names them as the implementer); the vendor rule still binds the validator and reviewers.

### 5. Validate
- Spawn `agent: validator`. The brief carries: the AC IDs with their kinds, plan.md, the worktree path, `<run>`, `base_sha` (from `<dir>/state.json`), the list of `ark test` calls it may make, and the rule path `rule://test-audit` (fallback: `<this skill dir>/../../rules/test-audit.md`).
- The validator itself runs `ark test <run> --acs <ids> --red-green --as validator` for `new` ACs (red-green proof) and `ark test <run> --acs <ids> --preservation --as validator` for `preserved` ACs (preservation proof: the tagged tests pass on base and on head). `--as validator` records the step by role: only a validator step vouches for AC-tagged test commits, a plain `ark test` never does. Both refuse until `implementer.completed` is recorded for every repo. For UI or system behavior the validator saves screenshots under `<dir>/artifacts/screenshots/<AC-ID>/`; the trace matrix lists them per AC.
- Write its result to `<dir>/inbox/validator.json`, then `ark artifact record <run> validator <dir>/inbox/validator.json`. Read `test_audit`: any `fail` entry is a defect to fix.
- `ark advance <run> build.completed` (state moves to `judging`, whatever the verdicts; step 7 and 8 decide what goes back).

### 6. Review
- Spawn `agent: reviewer-x`. The brief carries: spec, AC IDs, plan.md, `base_sha`, head SHA, the worktree path, prior findings.
- Write its result to `<dir>/inbox/reviewer-x.json`, then `ark artifact record <run> reviewer <dir>/inbox/reviewer-x.json`.

### 7. Judge
- For every reviewer finding, and every failed validator verdict or `test_audit` entry, decide a bucket: `act_on`, `consider`, `noted`, `dismissed`, each with a `reason`. Verify before you bucket: read the code at `file:line`.
- An `act_on` P0 or P1 must be a verified finding: `evidence` is `{"failing_test": "<test name>"}` (a tagged test that the latest `ark test` at the current head recorded as failing; spawn the validator to write one and run it with `ark test`) or, where no test can reach it, `{"traced_path": "<file:line -> file:line ...>"}` (the concrete execution path you traced; the evidence gate marks it as weaker). `ark findings record` refuses a failing test it cannot find in the ledger. Without evidence, bucket `consider`. P2 and P3 never block.
- Write `<dir>/inbox/findings-<n>.json`, an array of `{id, reviewer, model, priority, file, line, claim, bucket, reason, evidence?}`. `model` is the model that actually answered, from the agent's session. Then `ark findings record <run> <dir>/inbox/findings-<n>.json`.

### 8. Rounds
- Exit when there is no open `act_on` P0/P1 and every AC passes: `skip: clean` and go to step 9.
- Otherwise, while the round budget lasts (`loop.max_rounds` in `ark.yml`, default two; `state.json` `round` counts the rounds used): write `<dir>/premise.md` first (the premise this round shares with the last; check it directly before the last round). `ark advance <run> fix_round.started` (back to `building`; refused once the budget is spent). Respawn the implementer with the Act-on findings, failing tests and their evidence in the brief; repeat steps 4 (record + `implementer.completed`), 5, 6 and 7 on the new head.
- Once the budget is spent and a check still fails: write `<dir>/premise.md` (the premise the rounds shared, and your diagnosis), `ark gate packet <run> GE` (rounds used, premise and the latest findings; prints `sha256:...`). `ask` the human with the packet; the answers are One more round (exactly one more; fold any guidance the human gives into the next brief) / Take over (the human becomes the implementer) / Abort: `ark gate answer <run> GE one_more_round|take_over|abort --packet <sha256>` in their terminal. `ark advance` refuses `ge.*`: escalation is a gate. One more round and take over return to `building`; abort ends the run. A G2 send-back is a round too.

### 9. Evidence pack
- `ark trace-check <run>` writes `<dir>/trace-matrix.md` and exits 0 when it passes. Exit 1 prints why: fix it through step 8.
- `ark gate packet <run> G2` (refuses unless the latest trace-check passed; lists the verified findings, with traced paths marked as weaker evidence). `ask` the human with the packet; the answers are Approve to open MRs / Send back / Abort: `ark gate answer <run> G2 approve|send_back|abort --packet <sha256>` in their terminal. With `mr: false` in `ark.yml`, approval ends the run as handed off.

### 10. MRs
- `ark mr <run>` opens one MR per repo and never merges. After the human merges or closes them on the host, they record the outcome in their terminal: `ark run close <run> merged` (every MR merged) or `ark run close <run> abandoned` (closed unmerged). A run stopped before any MR existed is aborted; the next `ark run start <ID>` starts run n+1 once every earlier run is closed.
