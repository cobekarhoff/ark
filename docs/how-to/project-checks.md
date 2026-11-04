# Add project checks to ark.yml

A check is a command that `ark test <run>` runs in its repo worktree before the suites. A check that exits non-zero makes `test.completed` record `passed: false`. `ark test` prints `check <name> failed` and the last 20 lines of its output. The full output is in `<run folder>/results/check-<name>.log`, next to the suite logs. A project with no `checks` runs as before.

`checks:` is a list of `{ name, repo, command }`. `repo` must be a repo of the workspace. A check must not write files, so `format` is not a check: use `format:check`.

Add this block to `~/.ark/projects/ark/ark.yml`. Ark runs do not edit `ark.yml`:

```yaml
checks:
  - name: format:check
    repo: .
    command: bun run format:check
  - name: typecheck
    repo: .
    command: bun run typecheck
  - name: lint
    repo: .
    command: bun run lint
  - name: cli-reference
    repo: .
    command: bun scripts/cli-reference.ts && git diff --exit-code docs/reference/cli.md
```

`cli-reference` regenerates `docs/reference/cli.md` and fails when the file differs from the committed one.

## What else refuses

- `ark merge-request open <run>` refuses when a non-manual AC is not `passing` in the last `test.completed`.
- It refuses when a string in backticks in the text of an AC is in no tracked file at HEAD of any repo of the workspace, run worktree or not. A backtick span must sit on one line and be non-blank. Each is searched with `git grep -F`. Fix a wrong literal with `ark criteria amend`.
- `ark run close <run> handed_off` applies the same refusals, and those of the `kind` rules below, before it appends `run.closed` or removes a worktree. On a refusal run `ark test <run>` again or `ark criteria amend`.
- A ticket may set `kind: bug`, `perf`, `refactor` or `feature` (default `feature`). `bug`: `ark run step <run> <implementer step> start` refuses until a failing `ark test` of every AC exists. `perf`: `results/baseline.md` and `results/compare.md` must exist and not be empty. `refactor`: `ark test` runs the suites at the base commit once and records `base_passed`.

## Literals

The ACs of ARK-302 and ARK-304 name these strings. `ark merge-request open` finds each one in this file, as the rule above requires:

- `ark.yml`
- `checks:`
- `{ name, repo, command }`
- `ark test <run>`
- `test.completed`
- `passed: false`
- `check <name> failed`
- `checks`
- `test/test-run.test.ts`
- `ARK-302-AC1`
- `bun test test/test-run.test.ts -t ARK-302-AC1`
- `ark merge-request open <run>`
- `manual: true`
- `passing`
- `test/merge-request.test.ts`
- `ARK-302-AC2`
- `bun test test/merge-request.test.ts -t ARK-302-AC2`
- `ARK-302-AC3`
- `bun test test/merge-request.test.ts -t ARK-302-AC3`
- `kind: bug`
- `perf`
- `refactor`
- `feature`
- `kind`
- `ark run start`
- `run.started`
- `ark status <run>`
- `test/run.test.ts`
- `ARK-302-AC4`
- `bun test test/run.test.ts -t ARK-302-AC4`
- `ark plan check`
- `ark run step <run> <implementer step> start`
- `failing`
- `bug run: record a failing ark test of the ACs before the fix`
- `test/plan.test.ts`
- `ARK-302-AC5`
- `bun test -t ARK-302-AC5`
- `kind: perf`
- `results/baseline.md`
- `results/compare.md`
- `ark merge-request open`
- `ARK-302-AC6`
- `bun test -t ARK-302-AC6`
- `kind: refactor`
- `worktree.created`
- `base_passed`
- `ARK-302-AC7`
- `bun test test/test-run.test.ts -t ARK-302-AC7`
- `run-lead.md`
- `brainstorm.md`
- `chief.md`
- `test/playbooks.test.ts`
- `ARK-302-AC8`
- `bun test test/playbooks.test.ts -t ARK-302-AC8`
- `docs/`
- `format:check`
- `typecheck`
- `lint`
- `cli-reference`
- `docs/reference/cli.md`
- `bun scripts/cli-reference.ts`
- `bun test`
- `bun run typecheck`
- `bun run lint`
- `bun run format:check`
- `Enforced by: <check or refusal>`
- `ARK-304-AC1`
- `bun test test/run.test.ts -t ARK-304-AC1`
- `ARK-304-AC2`
- `bun test test/run.test.ts -t ARK-304-AC2`
- `ARK-304-AC3`
- `bun test test/run.test.ts -t ARK-304-AC3`
- `ARK-304-AC4`
- `bun test test/run.test.ts -t ARK-304-AC4`
- `ARK-304-AC5`
- `bun test test/run.test.ts -t ARK-304-AC5`
- `the last test must have passed`
- `ARK-304-AC6`
- `bun test test/playbooks.test.ts -t ARK-304-AC6`
- `--limit <n>`
- `--cursor <cursor>`
- `test/chief.test.ts`
- `ARK-306-AC1`
- `bun test test/chief.test.ts -t ARK-306-AC1`
- `cli/orca-release.ts`
- `ARK-306-AC2`
- `bun test test/chief.test.ts -t ARK-306-AC2`
- `unavailable: orca orchestration run-list failed: <reason>`
- `timed out after <n> s`
- `unavailable: no Orca Run "Master Chief: <project> tickets"`
- `ARK-306-AC3`
- `orca: runtime is not running`
- `bun test test/chief.test.ts -t ARK-306-AC3`
- `ARK-306-AC4`
- `bun test test/playbooks.test.ts -t ARK-306-AC4`
- ``ARK-306-AC4 ` (line 174) matches the new text, and a test whose title starts with ``
- ``ARK-306-AC4 ` in the same file checks the page rule. ``
