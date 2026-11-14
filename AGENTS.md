# Ark

Rules for a person or an agent that changes this repo. Commands and test conventions: [Work on Ark](docs/how-to/work-on-ark.md).

- Before each commit run `bun run format`, then `bun run format:check`, `bun run typecheck` and `bun run lint`; commit the files `format` changed. Do this for Markdown-only changes too.
- Regenerate `docs/reference/cli.md` with `bun scripts/cli-reference.ts` after you change a command description, and commit both files.
- Run a new `ark` command once through `bun cli/ark.ts <command> ...`, in its documented argument order, before you finish.
- A new hub route that returns run files or agent output calls `isLocalRequest` and escapes rendered Markdown.
- A check that guards a push covers every push of the command, including the refresh of an open MR.
- A change that makes a reader skip or drop an item lists every reader of the same collection and handles the item in each.

Read next:

- [Work on Ark](docs/how-to/work-on-ark.md): install, the checks, the opt-in hook, test conventions.
- [CONTEXT.md](CONTEXT.md): the glossary.
- [docs/README.md](docs/README.md): every other page.
- [rules/test-audit.md](rules/test-audit.md): the test gate.
