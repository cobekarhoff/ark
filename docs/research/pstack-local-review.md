# Pstack local-review source notes

Read during the ark design interview. Source URLs below track upstream `main`; exact commits and content hashes must be pinned before extraction/adoption.

## Source facts

- [`interrogate`](https://github.com/cursor/plugins/blob/main/pstack/skills/interrogate/SKILL.md) launches one read-only reviewer per configured model, gives every reviewer the same prompt and rubric, and attributes adversarial signal to model diversity rather than assigned personas. It synthesizes findings and uses lead judgment to categorize them as act on, consider, noted, or dismissed. It does not auto-apply edits.
- [`unslop`](https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md) removes AI patterns from writing. It is not itself the code-simplification reviewer.
- [`no-comments`](https://github.com/cursor/plugins/blob/main/pstack/skills/no-comments/SKILL.md) delegates comment review, checks the report, and then performs accepted repairs through additional steps. Its full self-orchestration and repair behavior cannot be copied into ark's read-only local review stage.
- The [`README`](https://github.com/cursor/plugins/blob/main/pstack/README.md) identifies pstack as poteto's work and lists MIT licensing. It says `deslop` belongs to the separate cursor-team-kit plugin, not pstack.

## Proposed ark adaptations, not yet approved

- Ark's orchestrator owns review fan-out, synthesis, repair transitions, and budgets.
- Local reviewers inspect the same approved intent and exact diff, read-only, and return typed evidence-backed findings.
- Model selections come only from role manifests and must satisfy the environment's enterprise-provider policy. Do not copy upstream automatic model substitutions.
- Findings can carry correctness, security, maintainability, test-value, and comment/constraint concerns. Agreement between models is useful evidence, not proof of correctness or a majority-vote pass rule.
- All accepted source changes belong to Build, not Review.
- Preserve upstream attribution and license notices when deriving our `ark-*` skills; obtain and pin the actual license text before distributing adaptations.

## Boundary correction

Arbiter is the separate CI/CD MR reviewer. It is not the name of ark's local review panel or lead.
