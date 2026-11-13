import { evaluationRecord } from "../evaluation.ts";
import type { Command } from "./types.ts";

export const evaluationRecordCommand: Command = {
  usage: "evaluation record <run> [--project <name>]",
  description:
    "Reads evaluation.md in the run folder and records its blockers, risks and surfaces (web_ui, cli_output, document or none). It refuses a missing file, a file with no Blockers, Risks or Surfaces list, an unknown surface, and a project whose ark.yml has no roles.evaluator. Blockers open the criteria gate; no blockers send the run to planning.",
  flags: { "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([runId], flags) => evaluationRecord(runId, flags["--project"] as string | undefined),
};
