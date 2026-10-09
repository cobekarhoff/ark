# Ark skill extraction plan

Status: draft. Ark writes its own `ark-*` skills. Upstream skills are source material: ideas are extracted and rewritten, not vendored. Factory evals are out of scope (decision 42), so skills ship without eval suites. Each skill still has a schema-validated input/output contract checked by ordinary ark tests.

## Sequencing (decided 2026-10-08)

Engine first, skills against contracts. While building ark, engineers use the installed pstack unchanged; dogfooding showed it works as-is as a working style. `ark-*` skills are written only once the stage contract schemas they output exist:

| Phase 1 unit | Skills written |
|---|---|
| 1–2 (core, ledger) | None. Extend `docs/research/phase0-s5-pstack-dogfood.md`. |
| 3 (contracts, guard, admit) | `ark-acceptance`, `ark-test-audit` (author/review/defect modes), tried by hand on the pilot ticket |
| 4–5 (harness, plan gate) | `ark-intake`, `ark-architect`, `ark-build` |
| 6–8 (verify, forge) | `ark-review`, `ark-review-lead`, `ark-qe` |
| After live pilot-ticket replay | Fold in failures seen in real runs; port `how`/`why`/`unslop`/principles only where role skills need them |

Skills stay thin: read inputs, write one schema-valid output file, no subagents, no model choice. Grow them from observed failures, not upfront porting.

## Sources (pin these)

| Source | Revision | License | Copyright |
|---|---|---|---|
| [cursor/plugins `pstack/`](https://github.com/cursor/plugins/tree/ccb5507cec1546dc88135c1139c811e6c59115ba/pstack) | `ccb5507cec1546dc88135c1139c811e6c59115ba` | MIT (`pstack/LICENSE`) | Copyright (c) 2026 Lauren Tan |
| [openclaw `.agents/skills/test-audit`](https://github.com/openclaw/openclaw/tree/5976b544d7c5997eb9c26fa750a2dfb0fd2abcea/.agents/skills/test-audit) | `5976b544d7c5997eb9c26fa750a2dfb0fd2abcea` | MIT (root `LICENSE`) | Copyright (c) 2026 OpenClaw Foundation |

Attribution: `THIRD_PARTY_NOTICES.md` in the ark repo carries both MIT notices in full. Each derived `SKILL.md` has a frontmatter field `derived_from: [<source path>@<sha>]`. Rewritten text that substantially copies upstream prose keeps the notice; prefer fresh wording.

## Rules applied to every core skill

- One maintenance-owning role; consumers declared in role manifests.
- Typed input and output that match a stage contract in `schemas/`.
- No routing, no spawning, no model selection inside the skill. Upstream "spawn N subagents" becomes "the orchestrator runs N attempts" in `pipeline.yaml`.
- No upstream model defaults or automatic model substitution. Models come from role manifests within environment policy.
- No MCP discovery. Context arrives in the brief (knowledge refs, repo paths). Jira/Confluence access is an intake concern, not a skill concern.
- Versioned by content hash; the hash goes in the run manifest.
- Writes only to its declared output path.

## Capability verbs

pstack's harness mapping (explore, implement, review, parallel, ask_user, verify, model_role) is replaced by ark mechanisms:

| Verb | Ark mechanism |
|---|---|
| explore | Read grants in the role sandbox; `ark-how` / `ark-why` |
| implement | Builder write grants |
| review | Review stage (reviewer attempts + lead) |
| parallel | Orchestrator fan-out declared in pipeline, never in a skill |
| ask_user | Skill emits `needs-human` with a structured question; orchestrator opens a gate |
| verify | `ark verify` (trusted runner); QE interprets |
| model_role | Role manifest |

## Principles (shared reference, not a skill)

`skills/_principles.md`, referenced by all skills, rewritten from pstack principles: prove it works against the real artifact; fix root causes; guard the context window (summaries in artifacts, raw payloads as file refs); never block on the human (emit a gate and continue only where policy allows; irreversible actions always wait); sequence verifiable units; test behavior, not implementation; subtract before adding. Dropped: arena-style exhaust-the-design-space as a default (cost), build-the-lever as mandatory.

## Skill map

| Ark skill | Owner role | Consumers | Source | What changes from the source |
|---|---|---|---|---|
| `ark-intake` | intake | — | New | Normalizes local ticket text (Jira later) into `ticket.v1`; no source edits |
| `ark-how` | analyst | planner, builder, reviewer, qe | pstack `how` | Single pass inside one attempt; no explorer/explainer spawning; output feeds `analysis.knowledge_refs` and code map |
| `ark-why` | analyst | planner, reviewer | pstack `why` | Sources limited to git history, linked MRs, and environment `knowledge/`; no MCP discovery; keeps the observed/inferred/unknown confidence split |
| `ark-interrogate-ticket` | analyst | planner | pstack `interrogate` (adversarial stance only) | Probes the ticket, not a diff: ambiguities, conflicting requirements, missing acceptance signals → `analysis.unknowns`; blocking unknowns raise a gate |
| `ark-architect` | planner | builder (for material deviations) | pstack `architect` | Produces `plan.v1` with usage-first sketch, allowed paths, and deviation policy; "design it twice" optional, as two planner attempts declared in pipeline (arena), not internal fan-out; no human checkpoint inside the skill (plan gate does that) |
| `ark-arena-select` | planner | — | pstack `arena` | Optional stage: orchestrator runs N planner attempts; this skill is the picker/grafter with a declared rubric; off by default |
| `ark-acceptance` | acceptance-author | — | test-audit authoring gate + pstack verification concepts | Writes executable checks at the owning boundary, with the four gate answers and environment-class limitations; may not touch production code |
| `ark-build` | builder | — | pstack feature/bug-fix playbooks (prove-it-works, root cause) | Implements within allowed paths; records deviations; reproduces bugs first; new tests must pass `ark-test-audit` gate; no self-review loop |
| `ark-test-audit` | test-auditor | acceptance-author, builder, reviewer, qe | openclaw `test-audit` | See below |
| `ark-review` | reviewer | — | pstack `interrogate` rubric + code-quality lens, `no-comments` | Read-only; one shared rubric for all reviewers; covers correctness, security, scope vs plan, test value (junk patterns), comment policy (flags constraint comments, never edits) |
| `ark-review-lead` | review-lead | — | pstack `interrogate` lead judgment | Dedupes, records agreement/disagreement, assigns act/consider/noted/dismissed; only "act" items are blockers; agreement is evidence, not a vote |
| `ark-unslop` | review-lead | publisher, reflector | pstack `unslop` | Applies to MR descriptions, plan/ticket prose, and defect reports; not to code |
| `ark-qe` | qe | — | pstack verification concepts | Runs `ark verify`, interprets failures, writes `defect.v1` with repro; may not edit source or checks; checks regression proof rule |
| `ark-reflect` | reflector | — | pstack `reflect` | Scheduled pipeline over completed runs; proposals as MRs to ark (skills) or the environment (knowledge); never edits active runs; no auto-apply |
| `ark-env-verify-recipe` | (onboarding) | — | pstack `create-verification-skill` / `maintain-verification-skill` | Helps author environment `ark/tasks/` (up/seed/health/down) and keeps them current; output reviewed by humans |

Dropped from pstack: `tdd` (replaced by `ark-test-audit` + acceptance-first flow), `poteto-mode` routing and playbook selection (orchestrator owns flow), `swarm` as a skill (fan-out is pipeline config; aggregation rules move into stage definitions), `setup-pstack`, `automate-me`, `bro`, `make-bot-ui`, `show-me-your-work` (ledger covers it), `babysit`/`shipping` (engineers merge).

## `ark-test-audit` detail

Kept from openclaw `test-audit`:

- Authoring gate: the four questions; a missing answer blocks the test.
- Junk patterns list (assertion-free probes, self-comparisons, copied fixtures/inventories, source greps, private call-shape tests, duplicate invocations, test-only exports, expected values produced by code under test, mocks implementing the asserted behavior, fixtures supplying what the owner should produce, flag-restating capability tests, negative controls passing for unrelated reasons, overpromising names).
- Value bar and retention bar, including "static or slow is not a deletion reason".
- Candidate evidence fields required before deletion.
- Fail-before/pass-after regression rule at the owner boundary.

Replaced:

| openclaw step | Ark replacement |
|---|---|
| `scripts/run-vitest.mjs`, `check-changed.mjs`, `$crabbox` | Repo's own commands from environment config, run via `ark verify` or repo check tasks |
| `$autoreview` | Ark review stage |
| `scripts/pr`, PR landing | Ark publish → GitLab MR; engineers merge |
| Parallel discovery lanes | Separate scheduled audit pipeline, one coherent MR per run |

Modes:

| Mode | Where | Output |
|---|---|---|
| author | acceptance and build stages | Gate answers attached to each new test |
| review | reviewer lens | Findings for junk-pattern matches (blocking) |
| defect | QE | Regression proof check |
| audit | scheduled pipeline, never in a ticket | `test-audit-record.v1` per candidate (fields above) shown in dashboard; one MR |

## Add-on skills (environment-owned)

Pilot environment: its product-specific skills (framework, test-tooling, and review skills), plus a new traceability skill producing `traceability` for the QMS gate in the environment's own record format. A second environment: its own `config`, `debug`, `lookup` equivalents as add-ons. Retire `factory-*` pointer skills and `/analyze /plan /implement /review /verify` after cutover.

## Verification of skills (not evals)

Each skill change is checked by ordinary tests: frontmatter/`derived_from` present, contract schemas referenced exist, rendered brief stays within size limits, and the adapter conformance run still produces schema-valid output. Behavior quality is judged by humans at gates.
