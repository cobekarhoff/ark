---
id: ARK-T704
title: ARK-T704 a bad call of an ark command stops in the parser with its reason and its usage, and help of a command that has a longer sibling prints its own usage
level: integration
technique: equivalence classes of parser rejection (too few arguments, too many arguments, value flag without value, unknown flag) over three commands with different argument bounds, plus longest-match help
priority: medium
risk: "parseFlags (cli/ark.ts) stops rejecting a bad call, or rejects it after the handler ran, or prints no reason or the usage of another command, so `ark retro` with no run reaches the handler, a missing flag value is read as a positional, an unknown flag is ignored, or `ark ui install --help` and `ark ui --help` print the usage of the wrong command"
status: active
changed_by: 2026-11-19-ARK-456-1
---

## Objective

Prove that a bad call of the `ark` command exits 1 in the parser, before any handler, and prints the reason and the usage of that command. Prove that `--help` of a command that is a prefix of another command (`ui`, `ui install`) prints its own usage line first. Serves ARK-456/AC3.

The authoring gate:

1. The contract is the exit code and the stderr of the real process: reason line `ark: <reason>`, then `usage: ark <usage>`, for each way `parseFlags` rejects a call (`wrong number of arguments`, `<flag> needs a value`, `unknown flag <flag>`), and the longest-match rule of `--help`.
2. The regression is `parseFlags` dropping a check, running it after the handler, or `--help` taking the shortest command match. Each fails an assertion of the steps below.
3. Existing proof misses it: ARK-T283 (retired by this run) held the only checks of these errors, inside a 30-command golden master of 22 s. `test/project-flag.test.ts` checks only that `--project` is accepted. `docs/reference/cli.md` and its `cli-reference` check guard the usage text, not the rejection. One case with three commands of different bounds covers each error class; a per-command probe adds no class.
4. No export, flag or hook: the case runs `bun cli/ark.ts` as a process, as a user does, and needs no new export of a non-test file, so it passes at the base commit.

Out of scope: the text of each description (the generated reference owns it); the accept side of the argument bounds of the other commands.

## Preconditions

- The worktree on the head under test, with dependencies installed.
- Each probe runs `bun <worktree>/cli/ark.ts <words>` in an empty temporary directory used as `HOME`, `ARK_HOME` and the working directory, with `ARK_PROJECT` cleared, so no handler that does run can read or write a real project. The directory is removed afterwards.
- The commands come from `ark --help`: `retro <run> [--project <name>]` (one argument, a value flag), `status [<run>] [--project <name>]` (zero or one argument), `chief state [--project <name>]` (no argument).

## Steps

1. Run `ark retro` with no argument, then `ark retro a b` with two. Record exit code and stderr.
2. Run `ark retro a --project` (the value flag is last, with no value).
3. Run `ark status --zz-first` (a flag no command knows).
4. Run `ark chief state extra` (one argument more than the maximum 0).
5. Run `ark ui install --help` and `ark ui --help`. Record exit code and stdout.

## Expected results

- Step 1: for both calls, the exit code shall be 1, stderr shall contain `wrong number of arguments` and the line `usage: ark retro <run> [--project <name>]`.
- Step 2: exit 1, stderr shall contain `--project needs a value` and the retro usage line.
- Step 3: exit 1, stderr shall contain `unknown flag --zz-first` and the line `usage: ark status [<run>] [--project <name>]`.
- Step 4: exit 1, stderr shall contain `wrong number of arguments` and the line `usage: ark chief state [--project <name>]`.
- Steps 1 to 4: no handler shall run: stdout is empty and the temporary directory holds no file a handler would write.
- Step 5: exit 0. The stdout of `ark ui install --help` shall start with `ark ui install `, the stdout of `ark ui --help` with `ark ui ` followed by `[--port` (not `ark ui install`). Each prints its own usage line first.
- The case passes at the base commit, since it needs no new export of a non-test file.

## Screenshot checkpoints

none: CLI exit codes and text; no UI.
