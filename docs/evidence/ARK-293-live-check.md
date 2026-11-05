# ARK-293 live check (hub-live-check)

Hub: `http://hub.ark-293-1.localhost`, started from this worktree on the real `ARK_HOME` and real Orca, with `--name hub.ark-293-1.localhost` (without it every page answers `403 foreign origin`). Open run: `2026-11-04-ARK-293-1`. Closed run: `2026-11-04-ARK-309-1`. No console errors on any page.

## Observed rows, open run page, Agents

| Row | Shown | Orca model | Session model |
| --- | --- | --- | --- |
| Master Chief | `omp · anthropic/claude-sonnet-5-5 (configured) · unknown` | none, row not matched to its Orca agent | none |
| run lead | `unknown · gpt-6-luna · working` | none | `gpt-6-luna` |
| validator hub-live-check | `unknown · claude-sonnet-5-5 · working` | none | yes |
| validator hub-agent-state-tests | `unknown · claude-sonnet-5-5 · unknown` (ended, not in Orca) | none | yes |
| implementer hub-done-model | `unknown · claude-sonnet-5-5 · unknown` (ended, not in Orca) | none | yes |
| designer | `omp (configured) · anthropic/claude-sonnet-5-5 (configured) · unknown` | none | yes, file unassigned |
| evaluator | `omp (configured) · anthropic/claude-sonnet-5-5 (configured) · unknown` | none | yes, file unassigned |

Master Chief appears once in the list and once in the header chip (`Master Chief · 1 runs`).

## AC checks

- AC1: Orca has 4 agents in state `done`, none on a run row. The snapshot has no agent of kind `done` (5 `unknown`, 2 `working`). Home: Stuck agents 0. A live `done` row was not seen.
- AC3: worker and run lead rows show a session model with no label. `(configured)` stays on Master Chief, designer and evaluator, which a session or Orca knows or could know. See `findings/hub-live-check.md` P2-1 and P2-2.
- ARK-309 filter: `#/?project=smart-qc` Home shows 0 open runs and `#/?project=ark` shows 1. `#/runs?project=smart-qc` shows 0 open, 1 closed. `#/runs?project=ark` shows 1 open, 2 queued, 98 closed.
- Closed run page `#/run/2026-11-04-ARK-309-1`: 4 steps with models and costs, MR `!120`, 11 decisions.

Screenshots timed out in the headless browser. This file records page text and `/api/snapshot`.
