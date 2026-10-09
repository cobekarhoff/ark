# Phase 1 architect brief (arena input)

## Task

Produce one candidate design package for ark's Phase 1 walking skeleton: TypeScript type sketch with `throw new Error("not implemented")` bodies, function signatures, module map, and a one-page rationale per the architect rationale template. Planning only; nothing gets implemented.

## Phase 1 must do, end to end

Replay the pilot ticket as a local ticket against the pilot environment:

1. `ark env add <path>` registers an agentic environment (reads its `ark/` config).
2. `ark ticket new` creates a local ticket. `ark run <ticket>` starts it.
3. Agent stages run headless harness processes (Claude Code first; OMP adapter proven feasible) in a per-ticket worktree: intake → analyze → plan → acceptance.
4. Human plan gate (`ark gate decide` or dashboard). Approval pins plan + acceptance check hashes (locks checks).
5. Build → local review (N reviewers + lead) → verify (trusted runner: env up, seed, run locked checks, evidence bundle, down) → QE interprets → publish GitLab MR → wait CI → wait merge.
6. Shared repair cap (default 3) across review blockers, QE defects, CI blockers. Then needs-human.
7. Background service; CLI and minimal dashboard are clients. Restart recovers known-safe state; ambiguous → needs-human. No second writer.
8. No sandbox (decision 44): after each attempt, detect tampering (locked-check hashes, diff paths ⊆ allowed paths) and reject.

## Read these (ground truth)

- `docs/design-spec.md`: architecture, contracts, events, manifest, pipeline, verify contract. Treat as requirements, but you may change internal structure.
- `docs/design-interview.md`: decisions 1–44 (some superseded; 42 removes all factory evals; 44 removes sandboxing for Phases 0–1).
- `CONTEXT.md`: glossary. Use these terms.
- `docs/research/phase0-s1-harness.md`: real CLI flags, event stream shapes, cancel behavior of Claude Code and OMP.
- `docs/research/phase0-s3-clean-env.md` and `phase0-s4-pilot-ticket-fit.md`: real environment recipe and the pilot ticket's acceptance check.
- architect skill: `SKILL.md` and its `references/` (runner-prompt, rationale-template, design-red-flags).

## Fixed constraints

TypeScript on Node.js. SQLite append-only event ledger, rebuildable projections. Canonical JSON artifacts validated against schemas; Markdown rendered. `pipeline.yaml` with typed stage kinds (agent, command, gate, wait) and declarative transitions, no embedded code, no LLM routing. Ark repo holds no product knowledge; the environment repo supplies pipeline, roles, risk rules, env tasks. Engineers merge in GitLab. No factory evals.

## Arena rubric (the picker scores on these)

1. **Recoverability.** State after any crash is derivable from durable records; every step is safe to re-run or provably detected as ambiguous.
2. **Interface depth.** Adding a harness, a stage kind instance, or an environment touches one small surface.
3. **Single owner per state.** No split ownership of ticket state, attempts, leases, artifacts.
4. **Phase 1 size.** Smallest design that runs the pilot ticket end to end. No speculative seams.
5. **Boundary enforcement.** Schema validation, tamper detection, allowed-path checks happen at one boundary each.
6. **Testable at real boundaries.** Real git, real subprocesses, real Compose, without mocks of ark's own internals.

## Output

Write to your assigned directory only:

- `RATIONALE.md`: per the rationale template, usage first.
- `sketch/*.ts`: types and signatures, `not implemented` bodies, doc comments with invariants.
- `MODULES.md`: module map, who owns which state, call graph for one full ticket run and for a crash-restart.
