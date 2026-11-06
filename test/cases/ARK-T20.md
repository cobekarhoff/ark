---
id: ARK-T20
title: ARK-T20 provenance line has three variants
level: integration
technique: equivalence classes on gate answers (criteria, strategy, none) and precedence of the strategy answer
priority: high
risk: the body claims the human shaped the solution or wrote the spec when they did not, uses the wrong handle, or omits the not-reviewed sentence
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that the first body line names the token owner and one of three variants chosen from the gates the human answered. Serves ARK-316/AC5.

Expected: When the human answered a strategy gate, the system shall write `who shaped the solution`.

## Preconditions

- Three fixture runs: (A) the human answered the criteria gate only; (B) the human answered a strategy gate; (C) no gate answered.
- A fake `gh` whose `gh api user` returns login `cobekarhoff`, and a fake `glab` whose `glab api user` returns username `cobe.k`.
- A fixture run with both a criteria and a strategy answer (run D).

## Steps

1. Build the body for run A with the fake `gh`. Read line 1 and line 2.
2. Build the body for run B. Read the first line.
3. Build the body for run C. Read the first line.
4. Build the body for run D.
5. Build the body for run A on a GitLab host with the fake `glab`.
6. Run `bun test test/pr-writing.test.ts`.

## Expected results

- A: `> Written by an AI agent on behalf of @cobekarhoff, following their spec.` then `@cobekarhoff has not reviewed it yet.`
- B: `> Written by an AI agent on behalf of @cobekarhoff, who shaped the solution.` then `@cobekarhoff has not reviewed it yet.`
- C: `> Written by an AI agent on behalf of @cobekarhoff.` then `@cobekarhoff has not reviewed it yet.`
- D (both gates): the strategy variant, `who shaped the solution`.
- On GitLab the handle is `@cobe.k` from `glab api user`.
- The provenance line is the first line of the body in every variant.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
