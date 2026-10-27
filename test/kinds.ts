import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The orchestrator proposes each AC's kind in ac.yml at intake and the human confirms it by approving G1; fixtures that reach G1 do the proposing here.
export function setKinds(runDir: string, kind: "new" | "preserved" | Record<string, "new" | "preserved"> = "new") {
  const file = join(runDir, "ac.yml");
  const acs = Bun.YAML.parse(readFileSync(file, "utf8")) as { id: string }[];
  writeFileSync(file, Bun.YAML.stringify(acs.map((a) => ({ ...a, kind: typeof kind === "string" ? kind : kind[a.id] })), null, 2));
}
