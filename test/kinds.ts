import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The orchestrator proposes each AC's kind in ac.yml at intake and the human confirms it by approving plan; fixtures that reach plan do the proposing here.
export function setKinds(runDirectory: string, kind: "new" | "preserved" | Record<string, "new" | "preserved"> = "new") {
  const file = join(runDirectory, "ac.yml");
  const acceptanceCriteria = Bun.YAML.parse(readFileSync(file, "utf8")) as { id: string }[];
  writeFileSync(file, Bun.YAML.stringify(acceptanceCriteria.map((acceptanceCriterion) => ({ ...acceptanceCriterion, kind: typeof kind === "string" ? kind : (kind[acceptanceCriterion.id] ?? "new") })), null, 2));
}
