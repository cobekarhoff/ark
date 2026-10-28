# Playbook: ticket

For a ticket with new or changed behavior. `<run>` below is the run id printed by `ark run start` (`<date>-<ticket>-<n>`); `<dir>` is its folder (`~/.ark/projects/<project>/runs/<run>`, or `$ARK_HOME/...`). Human gates: G0 AC clarity (only when the ticket has no ACs), G1 plan, escalation (`GE`, only when the round budget is spent), G2 evidence; then the host merge. The human answers through the matching main-session `ask` result; outside OMP they run the CLI in their own terminal.

## Steps

Copy these ten lines into the todo list verbatim.

1. Intake: read the ticket and its ACs; open G0 only if the ticket has no acceptance criteria
2. Analyze: read the code the ACs touch and record the analysis
3. Plan: write plan.md and get G1 approval
4. Implement: create the worktree and spawn the implementer
5. Validate: spawn the validator and prove the ACs red then green
6. Review: spawn reviewer-x on the change
7. Judge: give every finding a disposition
8. Rounds: send verified findings and failed checks back within the round budget, then escalation (`ark gate ... GE`)
9. Evidence pack: pass trace-check and get G2 approval
10. MRs: open the MRs with ark mr; the human merges and records the outcome

## Calls per step

Every `ark ...` call below is the typed tool named after it (`ark advance` is `ark_advance`, `ark gate packet` is `ark_gate_packet`, `ark gate answer` is `ark_gate_answer`, `ark run close` is `ark_run_close`, `ark ac update` is `ark_ac_update`, `ark trace-check` is `ark_trace_check`); you have no bash. Ask only machine-valued choices matching the CLI answers and include the packet hash in the question. The hidden answer tool cannot create human proof; an error is a refusal: read its message, fix the cause, never work around it.

**Gate answers (every `ark_gate_answer` below).** After `ark_gate_packet`, read/show the packet and `ask` one single-choice question: `multi` false, one option per fixed answer, labelled exactly as the answer, no `recommended` option (OMP auto-selects it on timeout), the question text exactly as shown for that gate below. Submit the selection with `ark_gate_answer`; it succeeds only when that ask result is bound to the main session and unused. A refusal for missing proof prints the exact question to ask. Outside OMP, the human runs `ark gate answer` in their own terminal and also types the selected answer on `/dev/tty`. If `ask` is unavailable (print mode), stop; do not answer without its proof.

### 1. Intake
- State `awaiting_g0` (no ACs): `ark_gate_packet` for G0 prints the packet sha256. Ask one question: `Ark gate.answered:G0 for run <run>; packet <sha256>. Choose exactly one: accept, edit, abort.` Submit the selected value with `ark_gate_answer`. On `abort`: stop. On `edit`, the run stays at G0 and no later step is legal: the human adds the ACs to the ticket file, you run `ark ac update <run>` (it re-reads the ticket's ACs into `ac.yml` and records `ac.updated`), build a new G0 packet and ask again; only `accept` lets the run continue.
- Otherwise: read `<dir>/ticket.md` and `<dir>/ac.yml`; the AC IDs are final. `skip: ACs present, G0 not needed` for the G0 part.

### 2. Analyze
- Read the code (use `scout` agents for wide exploration). Write `<dir>/analysis.md`: what the ACs touch, risks, the contract between pieces.
- `ark advance <run> analysis.completed`

### 3. Plan
- Write `<dir>/plan.md`: approach, the contract, one test per AC at the strongest practical boundary, and a risk tier.
- Add `kind: new` (behavior absent before the change) or `kind: preserved` (present before and after) to every AC in `<dir>/ac.yml`: you propose it, the human confirms it by approving G1, and the answer `approve` is refused while any AC has no kind. The G1 packet lists the ACs that lack one.
- `ark gate packet <run> G1` (prints `sha256:...`).
- Ask the human one question: `Ark gate.answered:G1 for run <run>; packet <sha256>. Choose exactly one: approve, change, abort.` Submit the selection with `ark_gate_answer`. On `change`, revise `plan.md` and repeat from the packet. On `abort`, stop.

### 4. Implement
- `ark advance <run> build.started`
- `ark ws create <run>` (add `--repo <path>` per extra repo). It prints the worktree `<dir>/ws/<repo>`, the branch and `base_sha`.
- Spawn with the `task` tool, `agent: implementer`. The brief carries: ticket text, AC IDs, plan.md contract, the worktree path, the branch, and prior findings (none in round 0). Subagents see nothing else.
- Write the agent's typed result as JSON to `<dir>/inbox/implementer.json`, then `ark artifact record <run> implementer <dir>/inbox/implementer.json`. A schema failure is a refusal: respawn with the error. Status `blocked`: stop and tell the human.
- `ark advance <run> implementer.completed --data '{"repo":"<repo>"}'`. It refuses when the diff touches an AC-tagged test or the worktree is dirty. When a human has taken over at an escalation, `state.json` has `implementer: human` and `next_action` asks the human to implement: the human commits in the worktree, then you call the same command. It refuses and prints the exact question `Ark implementer.completed:<repo> for run <run>; packet <sha256 of the worktree HEAD>. Choose exactly one: confirm, abort.`; ask it (no `recommended` option) and, on `confirm`, call the command again: it names the human as the implementer. The vendor rule still binds the validator and reviewers.

### 5. Validate
- Spawn `agent: validator`. The brief carries: the AC IDs with their kinds, plan.md, the worktree path, `<run>`, `base_sha` (from `<dir>/state.json`), the list of `ark test` calls it may make, and the rule path `rule://test-audit` (fallback: `<this skill dir>/../../rules/test-audit.md`).
- The validator itself runs `ark test <run> --acs <ids> --red-green --as validator` for `new` ACs (red-green proof) and `ark test <run> --acs <ids> --preservation --as validator` for `preserved` ACs (preservation proof: the tagged tests pass on base and on head). `--as validator` records the step by role: only a validator step vouches for AC-tagged test commits, a plain `ark test` never does. Both refuse until `implementer.completed` is recorded for every repo. For UI or system behavior the validator saves screenshots under `<dir>/artifacts/screenshots/<AC-ID>/`; the trace matrix lists them per AC.
- Write its result to `<dir>/inbox/validator.json`, then `ark artifact record <run> validator <dir>/inbox/validator.json`. Read `test_audit`: any `fail` entry is a defect to fix.
- `ark advance <run> build.completed` (state moves to `judging`, whatever the verdicts; step 7 and 8 decide what goes back).

### 6. Review
- Spawn `agent: reviewer-x`. The brief carries: spec, AC IDs, plan.md, `base_sha`, head SHA, the worktree path, prior findings.
- Write its result to `<dir>/inbox/reviewer-x.json`, then `ark artifact record <run> reviewer <dir>/inbox/reviewer-x.json`.

### 7. Judge
- For every reviewer finding and failed validator verdict or `test_audit` entry, assign a disposition: `act_on`, `consider`, `noted` or `dismissed`, each with a `reason`. Verify before assigning it: read the code at `file:line`.
- An `act_on` P0 or P1 must be a verified finding: `evidence` is `{"failing_test": "<test name>"}` (a tagged test the latest `ark test` at the current head recorded as failing; spawn the validator to write one and run it with `ark test`) or, where no test can reach it, `{"traced_path": "<file:line -> file:line ...>"}` (the concrete execution path you traced; the evidence gate marks it as weaker). `ark findings record` refuses a failing test it cannot find in the ledger. Without evidence, set disposition to `consider`. P2 and P3 never block.
- Write `<dir>/inbox/findings-<n>.json`, an array of `{id, reviewer, model, priority, file, line, claim, bucket, reason, evidence?}` (the schema's `bucket` key holds the disposition). `model` is the model that actually answered, from the agent's session. Then `ark findings record <run> <dir>/inbox/findings-<n>.json`.

### 8. Rounds
- Exit when there is no open `act_on` P0/P1 and every AC passes: `skip: clean` and go to step 9.
- Otherwise, while the round budget lasts (`loop.max_rounds` in `ark.yml`, default two; `state.json` `round` counts the rounds used): write `<dir>/premise.md` first (the premise this round shares with the last; check it directly before the last round). `ark advance <run> fix_round.started` (back to `building`; refused once the budget is spent). Respawn the implementer with the Act-on findings, failing tests and their evidence in the brief; repeat steps 4 (record + `implementer.completed`), 5, 6 and 7 on the new head.
- Once the budget is spent and a check still fails: write `<dir>/premise.md` (the premise the rounds shared, and your diagnosis), build `GE` with `ark_gate_packet` (rounds used, premise and latest findings; prints the hash), then ask: `Ark gate.answered:GE for run <run>; packet <sha256>. Choose exactly one: one_more_round, take_over, abort.` Submit the selected value with `ark_gate_answer`. `ark advance` refuses `ge.*`: escalation is a gate. One more round and take over each count as a round and return to `building`; abort ends the run. A G2 send-back counts as a round too; one sent after the budget is spent returns to `judging` so that you open `GE`.

### 9. Evidence pack
- `ark trace-check <run>` writes `<dir>/trace-matrix.md` and exits 0 when it passes. Exit 1 prints why: fix it through step 8.
- Build G2 with `ark_gate_packet` (it refuses unless the latest trace-check passed). Ask: `Ark gate.answered:G2 for run <run>; packet <sha256>. Choose exactly one: approve, send_back, abort.` Submit the selection with `ark_gate_answer`. With `mr: false` in `ark.yml`, approval closes the run at the ready branches, handed off, and step 10 does not apply.

### 10. MRs
- `ark mr <run>` opens one MR per repo and prints `close_packet: <sha256>` once an MR is open. After the human merges or closes them on the host, ask: `Ark run.closed for run <run>; packet <close_packet>. Choose exactly one: merged, abandoned.` Then call `ark_run_close` (a refusal prints this question). `merged` requires an MR for every repo; `abandoned` requires at least one opened MR. Once an MR exists the run cannot be aborted or handed off, only closed this way. A run stopped before any MR existed is aborted; the next `ark run start <ID>` starts run n+1 once every earlier run is closed.
