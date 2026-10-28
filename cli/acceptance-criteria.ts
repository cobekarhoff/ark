import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptanceCriteriaYaml, append, check, commit, locked, open, readLedger, readTicket, sha256, summary } from "./run";

// criteria edit: the human changed the ticket's acceptance criteria, so the run re-reads them from the project's tickets folder.
// A kept AC keeps what the run added to it (kind, level ...); the run stays in awaiting_criteria until a new criteria packet is answered accept.
export function acceptanceCriteriaUpdate(runId: string): string {
  const { directory, state } = open(runId, "acceptance_criteria.updated", "acceptance-criteria update");
  const ticketFiles = readTicket(state.ticket);
  return locked(directory, () => {
    const events = readLedger(directory);
    const before = Bun.YAML.parse(readFileSync(join(directory, "ac.yml"), "utf8")) as { id: string }[];
    const acceptanceCriteria = ticketFiles.acs.map((criterion) => ({ ...before.find((previousCriterion) => previousCriterion.id === criterion.id), ...criterion }));
    check("ac", acceptanceCriteria, "ac.yml");
    const acceptanceCriteriaYml = acceptanceCriteriaYaml(acceptanceCriteria);
    const artifacts = { "ticket.md": sha256(ticketFiles.raw), "ticket.json": sha256(ticketFiles.ticketJson), "ac.yml": sha256(acceptanceCriteriaYml) };
    const next = append(directory, events, "acceptance_criteria.updated", { acs: acceptanceCriteria.map((criterion) => criterion.id), artifacts }); // refuses an event illegal in this state before any file changes
    copyFileSync(ticketFiles.source, join(directory, "ticket.md"));
    writeFileSync(join(directory, "ticket.json"), ticketFiles.ticketJson);
    writeFileSync(join(directory, "ac.yml"), acceptanceCriteriaYml);
    return `updated ${summary(commit(directory, next))}`;
  });
}
