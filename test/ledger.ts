import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hash = (text: string) => `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;
const read = (runDirectory: string) => readFileSync(join(runDirectory, "ledger.ndjson"), "utf8").trim().split("\n").filter(Boolean);

// For tests that present a ledger the CLI would never write (edited evidence, an event only a not-yet-built command writes):
// rewrite every line's `prev` so the hash chain holds, and re-anchor state.json on the line it already counted.
export function rechain(runDirectory: string) {
  let previousHash = hash("");
  const lines = read(runDirectory).map((rawLine) => {
    const line = JSON.stringify({ ...JSON.parse(rawLine), prev: previousHash });
    previousHash = hash(line);
    return line;
  });
  writeFileSync(join(runDirectory, "ledger.ndjson"), lines.map((line) => `${line}\n`).join(""));
  const file = join(runDirectory, "state.json");
  if (!existsSync(file)) return;
  const state = JSON.parse(readFileSync(file, "utf8"));
  if (state.ledger_seq >= 1 && state.ledger_seq <= lines.length) state.ledger_head = hash(lines[state.ledger_seq - 1]);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}
