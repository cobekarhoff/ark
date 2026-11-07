// Runs one pr-writing call in its own process. `Bun.spawnSync` inside a bun test does not see a PATH changed after
// start-up, so a test that needs the fake `gh` and `glab` on PATH runs the real module here, with an explicit env.
// Usage: bun driver.ts <ledger|post> '<json input>'. It prints one JSON line: { value } or { error }, plus out and err.
import { buildLedger } from "../../../skills/pr-writing/lib/ledger.ts";
import { postMergeRequest } from "../../../skills/pr-writing/lib/post.ts";

const [command, argument] = process.argv.slice(2);
const input = JSON.parse(argument);
const out: string[] = [];
const err: string[] = [];
console.log = (...parts: unknown[]) => void out.push(parts.join(" "));
console.error = (...parts: unknown[]) => void err.push(parts.join(" "));

let answer: { value?: unknown; error?: string };
try {
  answer = { value: command === "ledger" ? buildLedger(input) : postMergeRequest(input) };
} catch (thrown) {
  answer = { error: (thrown as Error).message };
}
process.stdout.write(`${JSON.stringify({ ...answer, out, err })}\n`);
