# Phase 0 S5: dogfooding pstack (running log)

## Availability

- **Claude Code:** `pstack@pstack-claude` 0.9.74 (Michael Denyer's port of cursor/plugins pstack, MIT) is installed and enabled. Skills, the `poteto-agent` and `comment-sicko` subagents, and effort agents load natively.
- **OMP:** not installed. The port ships a Pi extension (`pi/index.ts`) built against upstream Pi (`@earendil-works/pi-coding-agent`). OMP compatibility with that extension is unverified. In an OMP session the skills can still be read as files and followed, with OMP's own subagent and todo tools in place of the Claude ones (`skills/poteto-mode/references/pi-tools.md` gives the mapping).
- **Model defaults** in the port's `models.json` are direct Anthropic models (`opus`, `fable`, `sonnet`). S2 recorded environment approval of the current Anthropic account, so these defaults are acceptable for Phases 0–1. Ark role manifests still pass models explicitly.

## Usage so far

| When | Skill / playbook | Harness | Worked unchanged? | Notes |
|---|---|---|---|---|
| S1–S4 | Prototype playbook | OMP (read as file) | Yes | One decision per spike, smallest script, observation as result, throwaway in `/tmp/ark-spikes/`. Fit Phase 0 exactly. |
| S4 | `how` (single-pass variant) | OMP | Partly | Traced the pilot ticket's diff, endpoint, auth provider precedence, and init-dir history before writing the check. Done inline, not with explorer fan-out; enough for a narrow question. |
| S4 | principle: test-behavior-not-implementation, prove-it-works | OMP | Yes | Drove the check to the real HTTP boundary and added a positive control, which caught the 401 false failure. |
| S3 | principle: prove-it-works | OMP | Yes | "Fast run is suspicious" check exposed the reused 6-week-old image. |
| Phase 1 planning | `architect` → `arena` (3 runners, 1 cross-judge, graft by base author) | OMP `task` subagents | Mostly | Assigning each runner a whole-shape direction (reducer, journal, filesystem) produced genuinely different designs; a free-running same-model arena would likely converge. Model diversity degraded (OMP's task tool takes no per-runner model). The cross-judge (B) and picker (A) disagreed; arena's rule "read both rationales, pick for maintainability" resolved it, and the judge's grafts and shared-error list were the most valuable output. Handing the graft to the base runner (it already held its design in context) worked well. ~45 agent-minutes total. |
| Phase 1 design review | `interrogate` (3-model panel, lead judgment) | Claude Code headless + OMP | Partly | Claude Code reviewers on opus and fable failed on account limits (session cap, credits), and the failure came back as exit 0 with a one-line text "review". The adapter lesson: a harness run is not done unless the output parses. Re-ran opus through OMP on the same Anthropic route. Two models, two harnesses: 30 findings, 7 accepted as Act on, no reviewer challenged the reducer base. Template filling needed a real script (macOS `awk -v` rejects multi-line values). |
| Phase 0 planning | multi-phase-plan playbook | — | Not used | Too heavy for spikes: 10 swarm live lanes per PR, hourly `/loop` audit tick, `check-plan.mjs`, Claude-specific plan store. Candidate for Phase 1 planning only, trimmed. |

## Early read for the skill extraction plan

- Prototype playbook: adopt nearly as-is as guidance for spikes; it has no self-orchestration.
- multi-phase-plan and orchestrate: self-orchestrating (spawns owners, arms loops, decides merges). Ark's orchestrator owns all of that, so these stay source material only.
