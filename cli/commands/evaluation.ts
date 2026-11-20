import { evaluationRecord } from "../evaluation.ts";
import type { Command } from "./types.ts";

export const evaluationRecordCommand: Command = {
  usage: "evaluation record <run> [--project <name>]",
  description:
    "Reads evaluation.md in the run folder and records its blockers, risks and surfaces (web_ui, cli_output, document or none). It refuses a missing file, a file with no Blockers, Risks or Surfaces list, an unknown surface, and a project whose ark.yml has no roles.evaluator. Blockers open the criteria gate; no blockers send the run to planning.\n\nAfter it records the evaluation with at least one blocker (the `criteria.opened` trigger), it sends the `criteria.opened` wake to each live companion whose `on` lists `criteria.opened`, at once and before it exits, with no `ark companions sync` or `ark chief state` in between. The wake is the one that `ark companions sync` sends: the same subject and body, one `wake.log` line, and the `cursor.json` of the companion moved past the event. An evaluation with no blockers sends no wake, and a companion whose `on` does not list `criteria.opened`, or that has no `cursor.json` (never synced), gets no message. The command starts, stops and releases no companion worker, never waits for a lock and never retries, and each Orca call of the wake gives up after 3 seconds. A wake it cannot send (Orca does not answer, the send fails, the companion has no live worker, or another sync holds the companion's lock) never fails the command: it prints on stderr one line for each companion, `companion <name>: wake <trigger> for <run> not sent: <reason>`, keeps the event, prints its `recorded evaluation:` line as before and exits 0. `ark companions sync` is the catch-up path: it sends the wake that the command could not send. A sync that runs at that moment holds the lock, so the line can appear for a wake that the sync then sends; the cursor keeps it from being sent twice. With no `companions` key in ark.yml the command makes no Orca call and its output does not change.",
  flags: { "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([runId], flags) => evaluationRecord(runId, flags["--project"] as string | undefined),
};
