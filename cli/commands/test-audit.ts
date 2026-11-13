import { testAuditInventory } from "../test-audit.ts";
import type { Command } from "./types.ts";

export const testAuditInventoryCommand: Command = {
  usage: "test-audit inventory [--json] [--summary] [--changed <base>] --project <name>",
  description:
    "Lists every test declaration of the project's bun suites, read with the TypeScript AST from the project workspace. It changes no file. One row each, tab-separated, with the columns file, line, title, kind, id, acs and last: the kind is `case` (the title or its describe holds a test case id <KEY>-T<n>), `old` (an old AC id <KEY>-<n>-AC<k>) or `none`; acs are the criteria whose verified_by names the case, from the project tickets; last is the JUnit time of the newest results/<suite>.report, joined by file and title. A `test.each` table is one row marked `[table xN]`, a `skipIf`, `only` or `skip` declaration is marked with its modifier, and test syntax inside a string is no row. A file that two suites select is counted once. A suite with another parser prints a `skip:` line on stderr. --json prints the same rows as JSON (durationMs is null with no match). --summary prints the counts by kind, the total declarations and test lines, and the counts by file. --changed <base> lists only the declarations that the diff from <base> to HEAD changes in their title, table or body (a deleted file has none; a renamed file is compared at its old path), and prints `old id touched: <file>:<line> <title>` for each one with an old AC id. It exits 0.",
  flags: { "--project": true, "--json": false, "--summary": false, "--changed": true },
  minimum: 0,
  maximum: 0,
  run: (_positionals, flags) =>
    testAuditInventory(flags["--project"] as string | undefined, {
      json: flags["--json"] === true,
      summary: flags["--summary"] === true,
      changed: flags["--changed"] as string | undefined,
    }),
};
