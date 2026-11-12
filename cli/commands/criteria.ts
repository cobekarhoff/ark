import { criteriaAmend } from "../criteria.ts";
import type { Command } from "./types.ts";

export const criteriaAmendCommand: Command = {
  usage:
    "criteria amend <run> <criterion id> (<file> [--carry-manual <words>] | --verified-by <case ids>) --reason <text> [--project <name>]",
  description:
    "Writes the text in <file> as the new text of one criterion in the run's ticket.md (frontmatter and table row) and records criteria.amended with the criterion, the old text, the new text, `by: human` and the required --reason (the human's reason for the new text). Use it for an amendment the human approved, when an AC wording is wrong after planning, instead of aborting the run. It works in every phase before merge_requests_open (awaiting_strategy, planning, building, escalation) and refuses a run in merge_requests_open or closed (naming the phase), an unknown criterion, an empty file, and a missing or empty --reason. It clears the manual answer of the criterion, unless the call also gives `--carry-manual <the human's words>`: that keeps the answer and records the words in the event as `carry_manual` (it needs a manual criterion and non-blank words, and works with the text form only). Second form, no file: `--verified-by <case ids>` (comma separated) replaces the `verified_by` list of the criterion in ticket.md and records criteria.amended with `verified_by_old`, `verified_by_new`, `by: human` and --reason. The text does not change and every manual answer stays. It refuses an id that has no active `test/cases/<id>.md` at HEAD of the run's worktree (a file only in the working tree or the index, or a retired case, is refused; the message names the id), an empty entry, a repeated id and the same phase, criterion and --reason cases as the text form, and it writes nothing on a refusal. Use it when test case ids are renumbered. Before the plan is approved it also clears the plan check: run ark plan check again so plan.md lists the amendment. After plan approval the run keeps its phase and approval and the next ark test judges the new text: do not run ark plan check again, it can change the plan hash and reset the approval. ark status lists each amendment with its reason.",
  flags: {
    "--project": true,
    "--reason": true,
    "--verified-by": true,
    "--carry-manual": true,
  },
  minimum: 2,
  maximum: 3,
  run: ([runId, criterionId, file], flags) =>
    criteriaAmend(runId, criterionId, file, {
      reason: flags["--reason"] as string | undefined,
      verifiedBy: flags["--verified-by"] as string | undefined,
      carryManual: flags["--carry-manual"] as string | undefined,
      project: flags["--project"] as string | undefined,
    }),
};
