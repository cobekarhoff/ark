import { gateRecord, escalate } from "../gate.ts";
import type { Command } from "./types.ts";

export const gateRecordCommand: Command = {
  usage: "gate record <run> <gate> [<criterion id>] <answer> [--note <text>] [--project <name>]",
  description:
    "Records your answer to a gate. The gates are criteria, strategy, plan, escalation and manual. The strategy gate takes the ID of a card in the latest strategy record, or abort. The manual gate proves one criterion whose method is not `test` (`manual: true` reads as `demonstration`): `ark gate record <run> manual <criterion id> ok|problem [--note <text>]` records gate.answered with the field `criterion`; it refuses an ID that is not in the ticket or not manual, and the answer is never automatic. For a `demonstration` criterion, `ok` also leaves the line `human: ok` once, as the last line of `results/evidence/<AC id>.md`, when that file exists; `problem` and the other methods change no file. Ark refuses an answer that the run's state does not allow, and refuses plan approve while the plan has an open decision. Both `<ticket id>/AC<k>` and `<ticket id>-AC<k>` name a criterion. `criteria accept` re-reads the ticket and refuses a new-scheme AC with `method: test` and an empty `verified_by` list, and names the AC.",
  flags: { "--note": true, "--project": true },
  minimum: 3,
  maximum: 4,
  run: ([runId, gate, ...args], flags) =>
    gateRecord(
      runId,
      gate,
      args,
      flags["--note"] as string | undefined,
      flags["--project"] as string | undefined,
    ),
};

export const escalateCommand: Command = {
  usage: "escalate <run> --reason <text> [--project <name>]",
  description:
    "Opens the escalation gate when the round budget is spent, also when the last ark test passed. Use it for an unresolved review P0 or P1. It records escalation.requested with the reason. It refuses a run that is not in phase building, a round budget that is not spent, and an empty reason. Answer the gate with ark gate record.",
  flags: { "--reason": true, "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([runId], flags) =>
    escalate(
      runId,
      flags["--reason"] as string | undefined,
      flags["--project"] as string | undefined,
    ),
};
