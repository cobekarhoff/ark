---
title: Tests and the trace matrix
description: Understand red-green proof, preservation, manual evidence and why green alone is not enough.
---

An acceptance criterion (AC) is a testable requirement, not a task. The plan gives
every AC a kind, `new` or `preserved`; human plan approval confirms that map.
The validator owns AC-tagged tests and audits their quality against `rules/test-audit.md`.
The implementer cannot change those tests to make its own work pass.

## Prove the right difference

| Kind | Required proof | What it tells you |
| --- | --- | --- |
| `new` | `ark test <run> --criteria <IDs> --red-green --as validator` | Head tests fail on base source, then pass on head source |
| `preserved` | `ark test <run> --criteria <IDs> --preservation --as validator` | The behavior passes on both base and head |

Red is a recorded failure or error in a selected test, not just a process exit.
Missing, skipped or ambiguous records can be inconclusive; a test that already
passes on base gives no red proof for new behavior. A failing suite cannot be
excused because the selected tests happen to pass. Every configured suite runs;
filtering which suites to start by source tag text would miss dynamic test names.

`ark test` uses suites committed in `.ark/repo.yml` at the run's recorded base.
Both proof modes require recorded implementation steps for every repository.
Only `--as validator` attributes AC-tagged test changes as validator work; a plain
test invocation does not vouch for them. For user interface (UI) or system behavior,
the validator also saves screenshots in the run's `artifacts/screenshots/<AC-ID>/`.

## Read the matrix

`ark trace-check <run>` builds `trace-matrix.md` from `ac.yml` and recorded evidence.
A passing row connects an AC, its kind and required level to the correct tests,
repository, current clean head, base proof and evidence artifacts. Evidence from
a different head, missing required proof or unknown criterion tags fails the check.
Manual-level ACs require a human-signed `manual/<AC-ID>.md` with `signed-by:` and
`at:` lines; an agent cannot manufacture that sign-off.

Trace checking exits zero only when its rules pass. The evidence packet refuses
without a passing trace check, and evidence approval recomputes the matrix so an
old green result cannot approve newly changed files.

## Review is evidence too, not automatic authority

The orchestrator gives each finding a disposition: `act_on`, `consider`, `noted`
or `dismissed`, with a reason. Priorities run from **P0 (must fix)** to **P3 (minor)**;
P1 is a likely defect or missing proof and P2 is worth fixing but never blocking.
An `act_on` P0 or P1 needs a verified failing test recorded at the current head,
or a concrete traced execution path when a test cannot reach it. A traced path is
weaker evidence. Unverified claims belong in `consider`, not in forced fix rounds.

Open actionable P0/P1 findings and failed checks return through the budgeted round
loop. The [human evidence gate](/lifecycle/) decides whether the final evidence
is sufficient; passing tests never authorizes an agent to merge.

For exact report identity, environment allowlists, overlay and attribution rules,
read the [implementation reference](/reference/implementation/). Sources:
`skills/ark/playbooks/ticket.md`, `cli/test.ts`, `cli/trace.ts` and `.ark/repo.yml`.
