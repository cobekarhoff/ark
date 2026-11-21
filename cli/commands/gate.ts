import { gateRecord, escalate } from "../gate.ts";
import type { Command } from "./types.ts";

export const gateRecordCommand: Command = {
  usage:
    "gate record <run> <gate> [<criterion id>] <answer> [--criteria <file>] [--note <text>] [--project <name>]",
  description:
    "Records your answer to a gate. The gates are criteria, strategy, plan, escalation and manual. The strategy gate takes the ID of a card in the latest strategy record, or abort. The manual gate proves one criterion whose method is not `test` (`manual: true` reads as `demonstration`): `ark gate record <run> manual <criterion id> ok|problem [--note <text>]` records gate.answered with the field `criterion`; it refuses an ID that is not in the ticket or not manual, and the answer is never automatic. For a `demonstration` criterion, `ok` also leaves the line `human: ok` once, as the last line of `results/evidence/<AC id>.md`, when that file exists; `problem` and the other methods change no file. Before it writes `ok` for a `demonstration` criterion whose file exists, it checks the file with `human: ok` added and refuses a malformed file with `evidence malformed: <AC id>: <reason>`, the text of `ark merge-request open`, writing no event and no file. A manual answer records `heads`, the head of each repo, in gate.answered; stage `final` of `ark merge-request check` warns `manual answer older than head: <AC id>` when a head has changed since. Ark refuses an answer that the run's state does not allow, and refuses plan approve while the plan has an open decision. Both `<ticket id>/AC<k>` and `<ticket id>-AC<k>` name a criterion. `criteria accept` re-reads the ticket and refuses a new-scheme AC with `method: test` and an empty `verified_by` list, and names the AC. `criteria accept --criteria <file>` reads the criteria from a YAML file instead: a mapping with one key, `acceptance_criteria`, a list of `{id, text, method, verified_by, guard}`; a relative path is read from the run folder, an absolute path as it is. `guard: true` marks a guard: a `method: test` AC of a bug run that holds before and after the fix, so the bug run's red proof (`ark run step <run> <implementer step> start`) does not need it `failing`; the key is optional, `guard: false` writes nothing, and a value that is not `true` or `false` is refused. `criteria accept` records the guard ids in `criteria.updated` (`guards`). It refuses `guard: true` on a criterion whose method is not `test` and in a run whose kind is not `bug`, and names the AC, on both `criteria accept` paths. It refuses, with an `ark: <reason>` line and no write, a file that is missing or not YAML, an unknown key at the top level or in a criterion (`manual: true` too: write `method: demonstration`), a duplicate id, an unknown method, an empty list and a `method: test` criterion with an empty `verified_by` list. Otherwise it replaces the `acceptance_criteria` block of the ticket file (every other line and the body stay, the table in the body too), then copies the ticket to the run folder and records the gate as `criteria accept` does. It works only with `criteria accept`, in the phase `awaiting_criteria`; with any other gate, answer or phase it refuses and writes nothing.",
  flags: { "--criteria": true, "--note": true, "--project": true },
  minimum: 3,
  maximum: 4,
  run: ([runId, gate, ...args], flags) =>
    gateRecord(
      runId,
      gate,
      args,
      flags["--note"] as string | undefined,
      flags["--project"] as string | undefined,
      flags["--criteria"] as string | undefined,
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
