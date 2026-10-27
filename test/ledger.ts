import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sha = (s: string) => `sha256:${new Bun.CryptoHasher("sha256").update(s).digest("hex")}`;
const read = (runDir: string) => readFileSync(join(runDir, "ledger.ndjson"), "utf8").trim().split("\n").filter(Boolean);

// For tests that present a ledger the CLI would never write (edited evidence, an event only a not-yet-built command writes):
// rewrite every line's `prev` so the hash chain holds, and re-anchor state.json on the line it already counted.
export function rechain(runDir: string) {
  let prev = sha("");
  const lines = read(runDir).map((l) => {
    const line = JSON.stringify({ ...JSON.parse(l), prev });
    prev = sha(line);
    return line;
  });
  writeFileSync(join(runDir, "ledger.ndjson"), lines.map((l) => `${l}\n`).join(""));
  const file = join(runDir, "state.json");
  if (!existsSync(file)) return;
  const state = JSON.parse(readFileSync(file, "utf8"));
  if (state.ledger_seq >= 1 && state.ledger_seq <= lines.length) state.ledger_head = sha(lines[state.ledger_seq - 1]);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}
