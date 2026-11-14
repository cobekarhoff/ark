---
name: ark-evaluator
description: Check a ticket before the run lead plans: probe its ACs read-only and write evaluation.md with blockers, risks and surfaces. Use when the run lead starts the evaluator worker with /skill:ark-evaluator <run>. It edits no product code.
---

# Ark evaluator

Arguments: `<run>`.

Read [`skills/shared/rules.md`](../shared/rules.md) first, then [`skills/shared/worker-protocol.md`](../shared/worker-protocol.md).

You check the ticket before the run lead plans. Your harness and model come from `roles.evaluator` in `ark.yml`. You edit no product code, and you commit nothing. The only file you write is `<run folder>/evaluation.md`.

1. Read `<run folder>/ticket.md` and each AC. Read the code and the context that each AC touches.
2. Probe what you doubt, read-only: run a command with `--help`, read a log, or run `run-current` from the right terminal. Never change a file in the repo, and never start an agent.
3. Write `<run folder>/evaluation.md` with three headings, each followed by a bullet list. An empty `Blockers` or `Risks` list is valid: leave the heading with no bullets. A missing heading is refused. `Surfaces` needs at least one value.

   ```markdown
   ## Blockers

   - AC1: a worker cannot call `worker-start`, so no test can prove it.

   ## Risks

   - Existing plan fixtures need an `evaluation.recorded` event.

   ## Surfaces

   - cli_output
   ```

   - A surface is what a person sees when the ticket is done. Use `web_ui`, `cli_output`, `document` or `none`. Use `none` alone when the change shows a person nothing. Any other value makes the run lead start a Designer, except for one card whose surfaces are only `cli_output`, `document` or `none`, which starts no Designer. List a surface only when the ticket changes it. List `cli_output` only when the change adds or changes text that a person reads; a change that leaves that text as it is lists `none`.
   - A blocker is an AC that is not possible, that no integration or E2E test case can prove (a criterion with a method other than `test`, or `manual: true`, is exempt: its proof is the gate `manual` answer `ok`), or that conflicts with other code. Each blocker names the AC ID and the reason, with your evidence.
   - A risk is a problem the plan must handle. It is not a reason to stop.
   - For each AC, search the whole repo and list under `Risks`, by file and line: each caller of the changed interface, each writer of the changed state, each early-exit or jump path of a changed skill, each row kind of a changed table, each new read route with its origin check and escaping, each fixture file that builds the old shape, and each diagram or table that holds the old rule.
   - A ticket with no ACs has no AC to block: put your doubts about the ticket in the risks.

4. Do not run `ark evaluation record`. The run lead does that. Report with `--outcome succeeded` and name `evaluation.md` in `--report-path`.
