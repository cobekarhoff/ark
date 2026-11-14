# Work on Ark

For a person or an agent that changes Ark's own code. [`AGENTS.md`](../../AGENTS.md) holds the short rules; this page holds the commands and the test conventions. [`CONTEXT.md`](../../CONTEXT.md) defines the words.

## Install

Ark needs Bun 1.4.0 (the version of both CI jobs). On a Mac:

```sh
bun install --frozen-lockfile
bunx playwright install chromium
```

CI runs the second command with `--with-deps`, which also installs system packages on Linux. `bun test` starts Playwright from some tests, so install the browser before the first run.

## The four checks

```sh
bun run format        # writes: run it yourself before you commit
bun run format:check
bun run typecheck
bun run lint
```

Run `format` first, and commit the files it changes. The other three only check. `.githooks/pre-commit` and CI never run `format`: a file you forgot to format fails there.

[`.githooks/pre-commit`](../../.githooks/pre-commit) runs `typecheck`, `lint`, `format:check` and `bun test --parallel`. CI has two jobs: the first runs `typecheck`, `lint`, `format:check` and `bun test --parallel`; the second runs `bunx playwright test`.

The hook is opt-in. Turn it on once per clone:

```sh
git config core.hooksPath .githooks
```

The hook runs the full Bun suite, not only the files you changed. On a busy host that is slow.

## Run one file

```sh
bun test test/<file>.test.ts                 # one Bun test file
bunx playwright test test/pw/<file>.pw.ts    # one browser spec
```

`bun test` never runs a spec: `bunfig.toml` ignores `test/pw/**`, and `playwright.config.ts` takes only `test/pw/**/*.pw.ts`. `bun test --parallel` is the `test` script of `package.json`.

## Generated reference

`docs/reference/cli.md` is generated from the command descriptions in `cli/ark.ts`. Change the description there, regenerate, and commit both files:

```sh
bun scripts/cli-reference.ts
```

The generator rewrites only the text between `<!-- generated:commands:start -->` and `<!-- generated:commands:end -->`. A hand edit of that text fails the check named `cli-reference` and `ARK-302-AC10`; see [Ark's own check that writes](project-checks.md#arks-own-check-that-writes). Run a new command once through `bun cli/ark.ts <command> ...`, in its documented argument order, before you call the change done.

The command table snapshot, `test/command-table.snapshot.json`, is regenerated with:

```sh
UPDATE_COMMAND_TABLE=1 bun test test/command-table.test.ts
```

## `ark test --quick` and `ark test`

`ark test <run>` takes a run, so it works only inside a run. `--quick` runs at head only, with no base run, and only the changed test files of the run's own commits in each suite that `paths` selects. It records `mode: quick` and is never a gate. `ark merge-request open` refuses unless the last test at head is a full `ark test <run>`. See [`ark test`](../reference/cli.md#test). Outside a run, use the commands above.

## Tests

- A test starts its title with its test case id, for example `ARK-T100 ...`. A test case is the file `test/cases/<id>.md`, made by `ark test-case new <KEY>` (in a git repo, or with `--run <run>`).
- A UI test calls `checkpoint(page, "<name>")` from `test/pw/helpers.ts` before each assertion, so the screenshot exists when the assertion fails. It writes only when `ARK_EVIDENCE_DIR` is set, as `ark test` does.
- A test that builds a git origin names its branch: `git init --initial-branch=main`, then push `HEAD:refs/heads/main`. The default branch of a Mac is `main`; that of the Linux CI runner is `master`, so a fixture that relies on the default passes here and fails in CI.
- A hub spec reads the time through the frozen clock of `test/pw/helpers.ts`: `useCleanup()` freezes it, and `testNow`, `isoAt`, `dateOf` and `isoAgo` follow it. A spec never calls `new Date(` or `Date.now()` (`test/wallclock.test.ts` fails it). A test of a view that defaults to the current week or day dates its fixtures from the clock, never a literal date. A test that compares a clock text uses fixed offsets, or a range that crosses midnight on purpose.
- A UI test of an overlay or a list checks that the element is hit at its centre, with `document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)` (example: `test/pw/hub.pw.ts`), not only `toBeVisible()`: an overflow ancestor can clip it.
- A test with fake tools that are stale waits until each source has its first read before it asserts the chip text (`staleRow` in `test/pw/hub.pw.ts`). Run it once with `bunx playwright test --workers=4 --repeat-each=4` before you finish: Linux CI fails where a Mac passes.
- A test of a view that picks one of several files (sessions, rounds, versions) uses an owner with at least two files and an anchor in the second.
- A change to the header of the hub keeps `.top` wrapping (`hub/page/styles.css`), so the project chips do not clip on Linux CI.

The test gate is [`rules/test-audit.md`](../../rules/test-audit.md): what a test protects, what regression fails it, and whether another test already owns the contract.
