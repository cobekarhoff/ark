---
id: ARK-T29
title: ARK-T29 evidence section lists 2 test cases and at most 5 screenshots
level: integration
technique: boundary values on the screenshot count (5, 6, 7) and a run with no evidence folder
priority: medium
risk: the Evidence section is absent or lists 7 screenshots, a screenshot is presented as uploaded, or EVID04 does not fire and the body ships with no evidence
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that when `results/evidence/` exists the body has an `## Evidence` section with one line per test case and at most 5 screenshot paths, and that EVID04 checks it. Serves ARK-316/AC14.

Expected: When `results/evidence/` exists, the system shall write an `## Evidence` section.

## Preconditions

- Fixture run with `results/evidence/` holding two test cases, each with `base/` and `head/` (`result.json`, `command.log`, `screenshots/`); 7 screenshots in total across 6 user flows: flow `login` has two screenshots (`login-1.png`, `login-2.png`, sorting first), and flows `search`, `cart`, `checkout`, `profile`, `logout` have one each; a known head SHA.
- A variant run with 7 screenshots across 3 flows (3, 2 and 2 screenshots).
- Variant runs with exactly 5 and exactly 6 screenshots, and a run with no `results/evidence/` folder.

## Steps

1. Build the body for the 7-screenshot run. Read the `## Evidence` section.
2. Count lines for test cases and the screenshot paths, and read the flow of each listed path. Build the body for the 3-flow variant.
3. Run lint on the body. Read EVID04.
4. Remove the `## Evidence` section from the body and run lint.
5. Edit the body so the section names 6 screenshots, then 7, and run lint. Do the same for 5.
6. Build the body for the run with no `results/evidence/`, and run lint.
7. Run `bun test test/pr-writing.test.ts`.

## Expected results

- The section has one line for each of the 2 test cases: its id, the result at base, the result at head and the head SHA.
- The section names at most 5 screenshot paths, one per distinct user flow: no flow appears twice, so `login-1.png` and `login-2.png` are not both listed (taking the first 5 paths would list both), and says that the screenshots stay in the run folder and are not uploaded. The other 2 screenshots are not listed. The 3-flow variant lists 3 paths, one per flow.
- Lint on the complete body does not fail EVID04.
- EVID04 fails when `results/evidence/` exists and the section is missing.
- EVID04 warns when the section names more than 5 screenshots (6 and 7 warn; 5 does not).
- A run with no `results/evidence/` has no required section and EVID04 does not fail.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
