---
id: ARK-T37
title: ARK-T37 body leads with the problem and lists Not done for a P1, a manual AC and a template
level: integration
technique: equivalence classes (kind bug, perf, refactor, UI; template, no template) and ordered-sections check
priority: high
risk: the body keeps pasting AC texts, drops the open P1 or the manual-pending AC from Not done, writes sections in the wrong order, picks the wrong evidence for the kind, or ignores the repo template headings
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that `body.ts` writes the AC4 sections in order, fits the evidence to the ticket `kind`, lists gaps under `Not done`, pastes no AC text, and fills the repo template headings. Serves ARK-316/AC4.

Expected: When a finding is open, the system shall list it under `Not done`.

## Preconditions

- Fixture run with one open P1, one manual-pending AC, one unproven AC, a last test result in which the check `lint` failed and the check `typecheck` did not run, a merge order of two MRs, and `kind: bug`; the AC text is a known sentence `AC-TEXT-MARKER`.
- Fixture repo with `.gitlab/merge_request_templates/Default.md` holding the headings Summary, Changes, Testing and Related.
- Variants: the same run with `kind: perf` (`baseline.md` and `compare.md` present), `kind: refactor`, and a UI run with ARK-312 test case results; and a variant with `.github/pull_request_template.md` and one with a rule file that names headings.

## Steps

1. Build the body with the old `description()` from the base commit for the fixture run. Keep it as the before evidence.
2. Build the body with the new builder for the same run (no template). Keep it as the after evidence.
3. Read the section order.
4. Read the evidence section for `kind: bug`: the AC test at base and at head.
5. Repeat for `perf`, `refactor` and UI runs.
6. Read the verify section and the `Not done` list. Then build the body again for a run in which `typecheck` ran and passed, and compare the lists.
7. Read the risk section and the revert text, and the AC checklist.
8. Search the body for `AC-TEXT-MARKER`.
9. Build the body with each of the three template sources.
10. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Section order is: provenance line, dependencies and timing, the problem, what is now different, evidence, how to verify, `Not done`, risk and how to revert, the AC checklist.
- Evidence by kind: bug shows the AC test failing at base and passing at head; perf names `baseline.md` and `compare.md`; refactor shows suites passing at base and at head; UI shows the ARK-312 test case results at base and head.
- How to verify is a list of `- [ ]` items, each with a backticked command and an `Expect` clause.
- `Not done` lists the open P1, the manual-pending AC, the unproven AC, the failed check `lint` and, as its own item, the not-run check `typecheck`. Removing `typecheck` from the not-run state (it ran and passed) removes that item and leaves the `lint` item.
- A run whose last `test.completed` has no `checks` field gets no `did not run` item in `Not done`; a `checks` list that lacks a configured check does.
- `What is different` holds the numbered Change items whole (never cut at a length), and holds no item of the `Risks:` list and no nested item.
- Risk section holds the merge-risk block of AC12, then one `git revert` per MR in reverse merge order.
- The AC checklist has ids with status only. `AC-TEXT-MARKER` is absent from the new body and present in the old body.
- With a template (`.gitlab/merge_request_templates/Default.md`, `.github/pull_request_template.md`, or a rule file that names headings) the content fills those headings (Summary, Changes, Testing, Related) instead.
- Old and new bodies are kept with the case result (before and after evidence).
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
