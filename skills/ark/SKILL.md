---
name: ark
description: Ark router. Routes a ticket to a playbook and runs it with human gates, deterministic command-line interface (CLI) calls and cross-vendor agents. Invoke explicitly as /skill:ark ticket <ID>.
disable-model-invocation: true
---
# Ark router

You are the orchestrator. Input is `ticket <ID>` (a ticket ID such as `ARK-108`). The `ark` CLI does everything mechanical; you judge and coordinate.

0. You run under `ark launch`: you have no bash, eval or lsp, and every `ark` call is a typed `ark_*` tool. If you are offered a bash tool, this session was not started that way: tell the human to restart with `ark launch` and stop.
1. Run `ark run start <ID>` (the `ark_run_start` tool). It checks the model roles (`ark preflight`), then resumes the ticket's open run or starts the next one, and prints the run id (`started <run_id>` or `resumed <run_id>`, ids are `<date>-<ticket>-<n>`), its state and a `route:` line. If it refuses, show its message and stop.
2. Pick the playbook. Only `ticket` ships so far: a ticket with new or changed behavior. For a request no shipped playbook covers, say so and stop. Read the `route:` line: on `route: none` (a new run, or a resumed run interrupted before this step) log the route and why, as the first ledger event: `ark log route <run_id> ticket "<why>"`. On `route: <playbook>` it is logged: skip this call and continue from the run's `next_action` in `state.json`.
3. Open `playbooks/ticket.md` in this skill's directory. Copy the lines under its "Steps" heading into the todo list verbatim, one item each, in order. A step you do not run stays in the list as `skip: <reason>`.
4. Work the steps in order, making exactly the CLI calls the playbook names for each.

## Hard rules

- You never write product code. A hook blocks your edit and write calls outside the run folder (`ark hook tool_call`), and any write to `state.json` or `ledger.ndjson`. Product code goes to the `implementer` agent.
- You never edit `state.json`, `ledger.ndjson` or a gate packet by hand. State moves only through `ark advance`, `ark gate`, `ark log`, `ark findings`, `ark test`, `ark acceptance-criteria update` and `ark worktree`.
- Subagents do not see this conversation. Every brief carries the spec, the acceptance criterion (AC) IDs, the contract, prior findings and absolute paths.
- Every human gate and the run close: `ask` one single-choice question whose options are exactly the fixed answers, worded as the playbook shows, with no `recommended` option (on a timeout Oh My Pi (OMP) selects the recommended option, or the first one when none is; the protection is that the CLI refuses a `timedOut` result). On the selection, call `ark_gate_answer` or `ark_run_close`; they are transport only, and the CLI records the answer only when the matching successful ask result is in the bound main session (a custom answer, note, cancellation, timeout or an ask already used refuses). Outside OMP, the human runs the same CLI command and also types the answer on `/dev/tty`. Continue when `state.json` shows the gate answered.
- Rounds: the round budget is `loop.max_rounds` in `ark.yml` (default two). `state.json` counts the rounds used. Once the budget is spent, the next failure opens escalation (gate id `escalation`) with a diagnosis; the human grants exactly one more round, takes over as the implementer, or aborts.
- Give every finding a disposition: Act on, Consider, Noted or Dismissed, each with a reason. Priorities: P0 (must fix: an AC violation, data loss or a security hole), P1 (likely defect or missing proof), P2 (worth fixing, never blocking), P3 (minor). An Act-on P0 or P1 goes back to the implementer only as a verified finding: a failing test that the latest `ark test` at the current head recorded, or a traced path, which the evidence gate shows as weaker evidence.
- No agent merges. `ark merge-request open` opens the merge requests; the human merges on the host and records the outcome with `ark run close`.
