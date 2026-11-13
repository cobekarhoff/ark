import { testCaseNew } from "../test-case.ts";
import type { Command } from "./types.ts";

export const testCaseNewCommand: Command = {
  usage: "test-case new <KEY> [--run <run>] [--project <name>]",
  description:
    "Run in a git repo, or anywhere with `--run <run>` (with `--project <name>` when the run ID is in several projects), which writes into the root repo worktree of that run and refuses a closed run or one with no worktree. Without `--run` it refuses in the `workspace:` checkout of a project, since that file belongs to no run. It allocates the next test case ID `<KEY>-T<n>`, one above the highest of a counter file per key in the git common directory, the `<KEY>-T*` entries in `test/cases/` and the entries on the last fetched origin target branch (a missing origin counts as none; it never fetches), and writes `test/cases/<KEY>-T<n>.md` with status `active`. It holds a lock in the git directory while it reads the highest number, writes the counter and then the file, so parallel runs and worktrees of one repo get different IDs. It prints the ID alone on stdout and the path of the file on stderr. An entry is one Markdown file with the frontmatter `id`, `title` (starts with the id), `level` (unit, integration or e2e), `technique`, `priority`, `risk` (the defect the case catches), `status` (active or retired; a retired entry also has `retired_reason`) and `changed_by`, and the sections Objective, Preconditions, Steps, Expected results and Screenshot checkpoints. `test_case_source` in ark.yml accepts `local` only. Outside a git repo it exits 1.",
  flags: { "--run": true, "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([key], flags) =>
    testCaseNew(
      key,
      flags["--run"] as string | undefined,
      flags["--project"] as string | undefined,
    ),
};
