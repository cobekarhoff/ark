---
id: ARK-T283
title: ARK-T283 the command table is the same as at base - order, usage, description, usage-advertised flags with arity, argument counts
level: integration
technique: characterization snapshot (golden master) with boundary values on argument counts
priority: high
risk: Moving the table into cli/commands/ drops, reorders or alters a command - usage, description, the arity of a flag its usage advertises, minimum or maximum - in a way that --help alone does not show and that moves docs/reference/cli.md with it
status: active
changed_by: 2026-11-13-ARK-405-1
---

## Objective

Prove that every `ark` command, its usage, its description, each flag its usage advertises (with its arity) and its argument counts are the same before and after the split of `cli/ark.ts`, and that the table order is unchanged. Serves ARK-372/AC1. Flags in the parser table that the usage string does not advertise are out of scope: the process cannot enumerate them.

Expected: When the command table changes, the system shall match the snapshot of the test, including `ark merge-request check`; the same commands keep the same order, usage, description, usage-advertised flags with their arity, minimum and maximum as the table in `cli/ark.ts` at base.

The test reads the table only through the `ark` process, so it passes at base and after the move, and does not import `cli/ark.ts` (importing it runs `main`).

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.
- Every probe of steps 2 to 6 runs in an empty temporary directory used as `HOME`, `ARK_HOME` and the working directory, with `ARK_PROJECT` cleared, addressing the CLI by absolute path (`bun <worktree>/cli/ark.ts`), so no handler that does run can touch real projects. The directory is removed afterwards.
- A snapshot file committed in `test/` that was captured from the base commit (before any move) by running the probe below at base. The snapshot holds, for each command in table order: usage, description, each usage-advertised flag with arity, probed minimum, probed maximum or unbounded.

## Steps

1. Run `bun cli/ark.ts --help`. Read the command lines, in printed order, as `scripts/cli-reference.ts` does.
2. For each command, run `bun cli/ark.ts <words> --help`. Capture usage and description (the text printed is `ark <usage>` then a blank line then the description).
3. Probe flags only in forms the parser rejects before any handler runs; the test never probes a flag by acceptance, because an accepted switch runs the handler (for example `run close --sweep`). Take the flag names from the `--flag` tokens of each usage string, and measure their arity and membership from the parser, not from the usage text (`--help` is answered before `parseFlags`, so the usage string cannot show whether the parser accepts a flag or whether it takes a value). Only these usage-advertised flags are probed; the parser is never asked for flags the usage does not name, so an unadvertised flag is not covered.
   a. Two-sentinel probe, for each flag `F` of the command: run the command words, then `F --zz-first --zz-second`. Both sentinels are unknown to every command. The stderr names the first flag the parser rejects, in `unknown flag <name>`: `<name>` = `F` means `F` is not in the parser table (removed); `<name>` = `--zz-first` means `F` is an accepted switch; `<name>` = `--zz-second` means `F` is a value flag that consumed `--zz-first`. Assert the named flag, not only `unknown flag`. Record the flag's measured arity as `absent`, `switch` or `value`. No handler runs.
   b. For each value flag, run the command words, then `<flag>` as the last argument with no value. The stderr must say `<flag> needs a value`.
   c. For each command, run the command words and `--zz-first` alone. The stderr must say `unknown flag --zz-first`.
4. Probe the argument counts from the process, only where a finite bound exists, with only forms that the parser rejects. `minimum - 1` positionals when minimum > 0 must fail with `wrong number of arguments`; for a finite maximum, `maximum + 1` positionals must fail likewise. A command with maximum `Infinity` (`worktree create`) has no maximum probe; record its maximum as unbounded. Pass side: run `minimum` positionals (when minimum > 0) and a finite `maximum` positionals; the stderr must not say `wrong number of arguments` (the handler may fail for other reasons). Skip the pass side, and record the skip in the test, for: `ui`, `ui install`, `ui uninstall` (the handlers start a hub or write outside the directory) and for `run close` (table minimum 0, but its handler rejects zero positionals with that same message, so the minimum has no process-visible pass side). `ui` is never run with a bare invocation; its fail side is `--zz-first` only.
5. Build the record list (command, usage, description, flag arity, probed minimum, probed maximum or unbounded) and compare it with the committed snapshot, deep-equal, with the list order significant.
6. Run `bun cli/ark.ts ui install --help` and `bun cli/ark.ts ui --help`, and `test`, `test-case`, `test-audit` likewise. Each must print its own usage (longest match).

`docs/reference/cli.md` equality with the generator is not checked here: `test/project-checks.test.ts` (ARK-302-AC10) owns it. This case keeps the base-table snapshot, which catches table and documentation changing together.

## Expected results

- The command lines of `ark --help` equal the snapshot order exactly; the count is 31 (the base table and `merge-request check`). The snapshot holds the new `merge-request check` command, the new count and the changed text of `test`, `run step` and `gate record`.
- For each command: usage, description, each usage-advertised flag with its parser-measured arity (`absent`, `switch`, `value`; step 3a) equal the snapshot; each probed bound behaves as in the snapshot; `F --zz-first --zz-second` names `--zz-first` for every advertised switch, `--zz-second` for every advertised value flag; an unknown flag fails with `unknown flag --zz-first`.
- `test-runner` is absent from `ark --help`.
- The same test passes at the base commit (before the move) and after it. A command dropped, duplicated or moved, a description edited, a usage-advertised flag deleted from the parser table, a usage-advertised flag changed from switch to value or back in the parser table (even with the usage string unchanged), or a changed probed minimum or finite maximum fails it. A flag added to the parser table but not advertised in usage is not detected.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
