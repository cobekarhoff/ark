# Ark reviewer rubric

Shared by every Ark reviewer (`reviewer-x`, `reviewer-s`). Adapted from pstack's interrogate rubric. Models differ only in the per-vendor tuning lines of their agent files; the rubric is identical so the adversarial signal comes from model diversity, not personas.

Review the diff between the base and head commit hashes (secure hash algorithm identifiers, SHAs) in your brief against the spec, each acceptance criterion (AC) and the contract. Judge the change, not the author.

## Lenses

1. **Correctness.** Does the code do what the ACs and contract say, on every path: empty input, errors, concurrency, partial failure, boundaries? Trace one real input end to end before you call it correct.
2. **Root cause vs symptom.** If the change fixes a defect, does it fix the cause where every caller routes through, or does it patch the one path the ticket names? Grep the callers. A guard in one caller with siblings still broken is a finding.
3. **Verification.** Is each AC proven by a real test that fails without the change and passes with it? Run the tests yourself in a throwaway checkout when you can. "Looks right" is not verification.
4. **Test gate.** Audit every new or changed test against the test-authoring gate (`rule://test-audit`). Flag a test that does not assert the behavior its AC names, that takes its expected value from the code under test, or whose mocks supply the behavior it asserts, and any assertion on call shape or private predicates.
5. **Security.** Trust boundaries, injection, secrets in code or logs, authorization, unsafe deserialization, path handling, dependency changes. Anything touching authentication, protected health information (PHI) or input boundaries gets extra scrutiny.
6. **Complexity.** Code or abstraction no requirement asks for; a simpler design that meets the same ACs. Dead code, speculative options, new dependencies for a few lines.
7. **Naming.** Check every name and abbreviation the diff adds or changes against the naming gate (`rule://naming`; if it does not resolve, read `rules/naming.md` in the Ark plugin). Flag a shorthand identifier that holds a domain object or lives beyond a few lines (`ws`, `cfg`, `pr`), a command, flag or gate with an alias or short id, and prose, help, an error or a prompt that uses an abbreviation before spelling it out at first use, including "acceptance criterion (AC)" and "merge request (MR)". Leave AC IDs such as `ARK-013-AC2` and the universal names `id`, `url`, `json`, loop indexes and a one-line `catch (err)` alone. Judge only lines the diff touches.

## Findings

- Priority: **P0** (must fix) breaks an AC or loses or corrupts data or opens a security hole; **P1** a likely defect or missing proof for an AC; **P2** worth fixing, not blocking; **P3** minor. A naming finding is P2 unless the name misleads a user.
- Every finding names `file` and `line`, a one-line `title`, a `confidence` from 0 to 1 and `evidence`: a failing command you ran with its output, or the exact call path with file and line. A finding without evidence is not reported.
- Report each distinct problem once. Do not report praise, formatting or style beyond the naming gate.
- P0 and P1 should be reproduced or traced. The lead will not send a P0 or P1 back to the implementer without a failing test or a traced path.
