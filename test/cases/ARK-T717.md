---
id: ARK-T717
title: ARK-T717 every tracked link to skills/shared resolves from the file and through skill://<name>
level: integration
technique: equivalence classes (link read as a file, link read as a clamped skill path), walk of every tracked file under skills/, boundary of the clamp (depth 1 and depth 2 links)
priority: high
risk: "a skill links to skills/shared with `../shared/<f>.md`; omp reads it as skill://<name>/../shared/<f>.md, clamps the `..` inside the skill folder to `skills/<name>/shared/<f>.md`, and the read ends in File not found, so a worker never reads the shared rules, engineering rules and worker protocol (32 links at base c75e21b: 31 in SKILL.md files and 1 in skills/ark-reviewer/rubrics/reviewer.md). A skill folder that links to shared and holds no `shared` entry, a `shared` entry that points elsewhere, or a Markdown edit that fixes one way and breaks the other, turns the case red."
status: active
changed_by: 2026-11-20-ARK-526-1
---

## Objective

Prove that each relative Markdown link, in a tracked file under `skills/`, that points at a file of `skills/shared/` resolves to that file in two ways:

1. File-relative: the link joined to the folder of the file that holds it names an existing file under `skills/shared/` (the way claude, codex and pi read it).
2. Skill path: `skill://<name>` followed by `/<link>`, with every `..` kept inside the folder of skill `<name>` (a `..` at the skill root is dropped, as omp does), names an existing file whose real path is the same file as the file-relative one. This is how omp opens the link of a worker: `skills/ark-evaluator/../shared/rules.md` clamps to `skills/ark-evaluator/shared/rules.md`; `../../shared/principles.md` in `skills/ark-reviewer/rubrics/reviewer.md` clamps to `skills/ark-reviewer/shared/principles.md`.

`<name>` is the first path segment under `skills/`. Links of `skills/shared/*.md` have no skill name (`shared` has no SKILL.md) and are checked file-relative only. Links that do not point into `skills/shared/` (`../../rules/*.md`, `../../docs/...`, `../ark-reviewer/rubrics/reviewer.md`), `http(s)://` links and links inside code fences are out of scope. A `#fragment` is stripped before the join.

The test walks `git ls-files skills` (or an equivalent tracked-file walk) and reads only regular Markdown files, so the tracked `skills/<skill>/shared` symlink entries added by the fix are neither read as a file nor walked a second time. The set of links comes from the walk: the test hardcodes no count and no list of skills.

Expected: When a tracked file under `skills/` links to a file of `skills/shared/`, the link shall resolve to that file both from the folder of the file and as a clamped `skill://<name>` path.

Authoring gate:

1. Protects the contract "a skill's link to `skills/shared` opens on the first read in every harness", including the omp skill path, which no other test models.
2. Credible regression: a new skill or rubric that links to `shared` without the `shared` symlink in its folder; a deleted or retargeted `skills/<skill>/shared` symlink; a copier or refactor that stores the shared files as a copy that drifts; a link edit that satisfies omp and breaks the file-relative read.
3. Existing proof misses it: ARK-T85 resolves only the links of `principles.md` and `engineering.md`, file-relative; ARK-T410 and ARK-T716 read the shared files for outcomes and phases, not for link targets. One owning case for the link contract; the other cases stay as they are.
4. No test-only export, flag or hook: the test reads the tracked files and models the omp clamp in a few lines of its own, the same model AC2 records against a real omp read at base.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed and `git` on PATH.
- At least ten skill folders under `skills/ark-*` link to `skills/shared/` and the walk finds at least one such link of depth 2 (`skills/ark-reviewer/rubrics/reviewer.md`). The test fails when the walk finds fewer, so an empty scan cannot pass.
- For the baseline run: the tree at base `c75e21b`, without the `skills/<skill>/shared` symlinks.

## Steps

1. At the base commit `c75e21b` (or the branch with the symlinks removed from the index), run the test `ARK-T717 every tracked link to skills/shared resolves from the file and through skill://<name>`.
2. At the head of the branch, with the tracked symlinks `skills/<skill>/shared -> ../shared` for each skill folder that links to shared, run the same test.
3. At the head, remove one symlink (for example `skills/ark-reviewer/shared`) in a scratch copy and run the test again; restore it.

## Expected results

- Step 1: the test fails for the skill-path way on all 32 links (31 in SKILL.md files, 1 in `rubrics/reviewer.md`), and the file-relative way passes for each. The failure message names the file, the link and the clamped path (`skills/ark-evaluator/shared/rules.md`).
- Step 2: the test passes. Every link resolves both ways, and each clamped path has the same real path as the file-relative target (a symlink to `../shared`, not a copy).
- Step 3: the test fails and names the link that lost its `shared` entry (`skills/ark-reviewer/rubrics/reviewer.md` and the ark-reviewer SKILL.md links), and no other link.

## Screenshot checkpoints

None. The surface is tracked files; no screenshot applies.
