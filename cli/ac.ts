import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acYaml, append, check, commit, locked, open, readLedger, readTicket, sha256, summary } from "./run";

// G0 edit: the human changed the ticket's acceptance criteria, so the run re-reads them from the project's tickets folder.
// A kept AC keeps what the run added to it (kind, level ...); the run stays in awaiting_g0 until a new G0 packet is answered accept.
export function acUpdate(runId: string): string {
  const { dir, state } = open(runId, "ac.updated", "ac update");
  const t = readTicket(state.ticket);
  return locked(dir, () => {
    const events = readLedger(dir);
    const before = Bun.YAML.parse(readFileSync(join(dir, "ac.yml"), "utf8")) as { id: string }[];
    const acs = t.acs.map((a) => ({ ...before.find((b) => b.id === a.id), ...a }));
    check("ac", acs, "ac.yml");
    const acYml = acYaml(acs);
    const artifacts = { "ticket.md": sha256(t.raw), "ticket.json": sha256(t.ticketJson), "ac.yml": sha256(acYml) };
    const next = append(dir, events, "ac.updated", { acs: acs.map((a) => a.id), artifacts }); // refuses an event illegal in this state before any file changes
    copyFileSync(t.src, join(dir, "ticket.md"));
    writeFileSync(join(dir, "ticket.json"), t.ticketJson);
    writeFileSync(join(dir, "ac.yml"), acYml);
    return `updated ${summary(commit(dir, next))}`;
  });
}
