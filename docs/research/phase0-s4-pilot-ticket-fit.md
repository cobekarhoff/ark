# Phase 0 S4: the pilot ticket as the first pilot

Date: 2026-10-08. Method: pstack Prototype. Throwaway script (not kept).

Result: **pass. The pilot ticket is a valid first pilot.** An acceptance check fails on the pre-change revision for the intended reason and passes on the fixed revision, against a cloud emulator (LocalStack-compatible), from a pinned multi-repo revision vector (7 repos in the pilot).

The check, the vector, and the pilot service details live in the pilot environment repo.

## Lessons for the design

1. **The positive control earned its place.** The first run failed identically on both revisions for an unrelated reason (an auth error). Without a control, "before = fail" would have been recorded for the wrong reason. This is the test-audit rule about negative controls that pass for unrelated reasons, observed live. `ark-acceptance` should require a positive control for every rejection-style check.
2. **Historical replay needs the whole revision vector, not one repo SHA**, including the environment repo: at the pinned date the environment repo already referenced a directory the product repo had not yet renamed. The override must adapt to what exists at the pinned revisions.
3. **Local auth configuration is environment config, and a disclosed limitation.** The check had to switch the service to a stub auth provider for the service account. The evidence must say so ("service-account auth stubbed") and make no auth claim.
4. **Check at the real HTTP boundary.** The original change's own tests override framework dependencies in-process. The check instead exercises the real HTTP boundary and the real emulated storage, which is the test-audit "real boundary" preference.

## Pilot shape for Phase 1

Replay the pilot ticket as a local ticket: base at the pre-change revision, intent from the ticket, this check as the approved acceptance check, with its positive control and the auth limitation. The original commit is the reference outcome. It is not an eval: there is no grading beyond the check itself.
