---
id: ARK-T283
title: ARK-T283 the command table is the same as at base - order, usage, description, usage-advertised flags with arity, argument counts
level: integration
technique: characterization snapshot (golden master) with boundary values on argument counts
priority: high
risk: Moving the table into cli/commands/ drops, reorders or alters a command - usage, description, the arity of a flag its usage advertises, minimum or maximum - in a way that --help alone does not show and that moves docs/reference/cli.md with it
status: active
changed_by: 2026-11-14-ARK-392-1
---

## Objective

Prove that each `ark` command's record (usage, description, each flag its usage advertises with its arity, and its argument counts) and the table order equal the committed snapshot, so a move of the table out of `cli/ark.ts` changes none of them. Serves ARK-372/AC1. Flags in the parser table that the usage string does not advertise are out of scope: the process cannot enumerate them.

Expected: When the command table is built from cli/commands, the system shall present the same commands in the same order with the same usage, flags and argument counts, and the new ark test description.

The test reads the table only through the `ark` process, so it does not depend on the file that holds the table, and it does not import `cli/ark.ts` (importing it runs `main`). The snapshot was first captured at the ARK-372 base (27 commands); the three `services` commands were added to it when ARK-372 merged main (`fe7b2dd`), and later runs updated descriptions in it when they changed a command description (ARK-333 changed the `test` description). Every record other than `test` equals the table at this run's base (c8dc7f3). The test fails at this run's base by design, because the snapshot holds the new description.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.
- Every probe of steps 2 to 6 runs in an empty temporary directory used as `HOME`, `ARK_HOME` and the working directory, with `ARK_PROJECT` cleared, addressing the CLI by absolute path (`bun <worktree>/cli/ark.ts`), so no handler that does run can touch real projects. The directory is removed afterwards.
- A snapshot file committed in `test/`, made by running the probe below. It was first captured at the ARK-372 base (27 commands, before any move); the three `services` commands were added to it when ARK-372 merged main (`fe7b2dd`), and later runs updated descriptions in it when they changed a command description (ARK-333 changed the `test` description). Every record other than `test` equals the table at this run's base (c8dc7f3). The snapshot holds, for each command in table order: usage, description, each usage-advertised flag with arity, probed minimum, probed maximum or unbounded.

## Steps

1. Run `bun cli/ark.ts --help`. Read the command lines, in printed order, as `scripts/cli-reference.ts` does.
2. For each command, run `bun cli/ark.ts <words> --help`. Capture usage and description (the text printed is `ark <usage>` then a blank line then the description).
3. Probe flags only in forms the parser rejects before any handler runs; the test never probes a flag by acceptance, because an accepted switch runs the handler (for example `run close --sweep`). Take the flag names from the `--flag` tokens of each usage string, and measure their arity and membership from the parser, not from the usage text (`--help` is answered before `parseFlags`, so the usage string cannot show whether the parser accepts a flag or whether it takes a value). Only these usage-advertised flags are probed; the parser is never asked for flags the usage does not name, so an unadvertised flag is not covered.
   a. Two-sentinel probe, for each flag `F` of the command: run the command words, then `F --zz-first --zz-second`. Both sentinels are unknown to every command. The stderr names the first flag the parser rejects, in `unknown flag <name>`: `<name>` = `F` means `F` is not in the parser table (removed); `<name>` = `--zz-first` means `F` is an accepted switch; `<name>` = `--zz-second` means `F` is a value flag that consumed `--zz-first`. Assert the named flag, not only `unknown flag`. Record the flag's measured arity as `absent`, `switch` or `value`. No handler runs.
   b. For each value flag, run the command words, then `<flag>` as the last argument with no value. The stderr must say `<flag> needs a value`.
   c. For each command, run the command words and `--zz-first` alone. The stderr must say `unknown flag --zz-first`.
4. Probe the argument counts from the process. For each command outside the skip list below, run it with 0, 1, 2, 3, 4 and 5 positionals (`p1`, `p2`, ...). A count is accepted when the stderr does not say `wrong number of arguments` (the handler may fail for other reasons, and a command with minimum 0 runs bare). The minimum is the first accepted count (no accepted count fails the test). The maximum is the last accepted count, or `unbounded` when 5 is accepted (`worktree create`). The accepted counts must form one unbroken range. Skip list, where only the fail side runs: `ui`, `ui install`, `ui uninstall`, `services install` and `services uninstall` (the handlers start a hub or write outside the directory), and `run close` (table minimum 0, but its handler rejects zero positionals with that same message, so the minimum has no process-visible pass side). Their bounds are fixed in the test (0 to 0; `run close` 0 to 2), and `maximum + 1` positionals must fail with `wrong number of arguments`. `ui` is never run with a bare invocation; its fail side is one extra positional, `--zz-first` and the flag probes of step 3.
5. Build the record list (command, usage, description, flag arity, probed minimum, probed maximum or unbounded) and compare it with the committed snapshot, deep-equal, with the list order significant.
6. Run `bun cli/ark.ts <command> --help` for `ui`, `ui install`, `test`, `test-case new` and `test-audit inventory`. Each must print its own usage, starting with `ark <command> ` (longest match).

`docs/reference/cli.md` equality with the generator is not checked here: `test/project-checks.test.ts` (ARK-302-AC10) owns it. This case keeps the snapshot (the table at this run's base plus the ARK-333 `test` description), which catches table and documentation changing together.

## Expected results

- The command lines of `ark --help` equal the snapshot order exactly; the count is 30. The snapshot holds the new `ark test` description (suite failure exit code, log path and last 20 lines; test case hint) and no other record that differs from this run's base.
- For each command: usage, description, each usage-advertised flag with its parser-measured arity (`absent`, `switch`, `value`; step 3a) equal the snapshot; each probed bound behaves as in the snapshot; `F --zz-first --zz-second` names `--zz-first` for every advertised switch, `--zz-second` for every advertised value flag; an unknown flag fails with `unknown flag --zz-first`.
- `test-runner` is absent from `ark --help`.
- `test/command-table.snapshot.json` holds the `retro` description with the `rework.rules_added` text (the count of rule lines in `rules.md`, the same text as `cli/commands/retro.ts`); the snapshot record changes together with the description, and the case still compares the process output with it.
- The snapshot was first captured at the ARK-372 base (27 commands); the three `services` commands were added to it when ARK-372 merged main (`fe7b2dd`), and later runs updated descriptions in it when they changed a command description (ARK-333 changed the `test` description). Every record other than `test` equals the table at this run's base (c8dc7f3). The test passes after the move with the new description, and fails at this run's base by design (the snapshot holds the new description). A command dropped, duplicated or moved, a description edited away from the snapshot, a usage-advertised flag deleted from the parser table, a usage-advertised flag changed from switch to value or back in the parser table (even with the usage string unchanged), or a changed probed minimum or finite maximum fails it. A flag added to the parser table but not advertised in usage is not detected.
- `test/command-table.snapshot.json` holds the `worktree sync` description of ARK-371 (it names `conflicts` and the regeneration of the files `ark.yml` lists under `generated`); the snapshot is updated together with `cli/commands/worktree.ts`, and the case still compares the process output with it.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
