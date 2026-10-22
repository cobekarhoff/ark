import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { append, commit, type LedgerEvent, project, readLedger, runDir, sha256 } from "./run";
import { transitions } from "./transitions";

// Gate packets (PRD "Gates and loop policy"): built from run-folder artifacts, no model involved.
const REQUIRED: Record<string, string[]> = { G0: ["ticket.md", "ac.yml"], G1: ["plan.md", "ac.yml"], G2: ["trace-matrix.md"] };

function buildPacket(dir: string, runId: string, gate: string): string {
  const sections = REQUIRED[gate].map((f) => {
    if (!existsSync(join(dir, f))) throw new Error(`${gate} packet needs ${f}, which is missing from the run folder`);
    return `## ${f}\n\n${readFileSync(join(dir, f), "utf8").trimEnd()}\n`;
  });
  if (gate === "G0") {
    const none = (Bun.YAML.parse(readFileSync(join(dir, "ac.yml"), "utf8")) as unknown[]).length === 0;
    sections.push(`## Missing\n\n${none ? "- acceptance criteria: the ticket has none" : "- nothing detected by the CLI"}\n`);
  }
  if (gate === "G2") {
    const art = join(dir, "artifacts");
    const files = existsSync(art) ? (readdirSync(art, { recursive: true }) as string[]).filter((f) => statSync(join(art, f)).isFile()).sort() : [];
    sections.push(`## Test evidence\n\n${files.length ? files.map((f) => `- artifacts/${f}`).join("\n") : "- none"}\n`);
  }
  return `# ${gate} packet: ${runId}\n\n${sections.join("\n")}`;
}

// G2 is built only from a trace-check that passed on the matrix now on disk, with no test evidence recorded after it.
function requireTrace(dir: string, events: LedgerEvent[]) {
  const t = events.findLast((e) => e.type === "trace.checked");
  if (!t) throw new Error("G2 packet needs a passing trace-matrix.md; run 'ark trace-check' first");
  if (!t.data.passed) throw new Error(`G2 packet refused: the latest trace-check failed:\n${(t.data.failures as string[]).map((f) => `  - ${f}`).join("\n")}`);
  if (events.some((e) => e.seq > t.seq && e.type.startsWith("test."))) throw new Error("G2 packet refused: tests ran after the last trace-check; rerun 'ark trace-check'");
  const file = join(dir, "trace-matrix.md");
  if (!existsSync(file) || sha256(readFileSync(file)) !== t.data.matrix_sha256) throw new Error("G2 packet refused: trace-matrix.md changed since trace-check; rerun 'ark trace-check'");
}

export function gatePacket(runId: string, gate: string): string {
  if (!(gate in REQUIRED)) throw new Error(`unknown gate '${gate}'; expected G0, G1 or G2`);
  const dir = runDir(runId);
  const events = readLedger(dir);
  const state = project(events).state;
  if (!(`gate.packet:${gate}` in transitions[state])) throw new Error(`cannot build the ${gate} packet in state '${state}'`);
  if (gate === "G2") requireTrace(dir, events);
  const body = buildPacket(dir, runId, gate);
  const path = `gates/${gate}.packet.md`;
  const hash = sha256(body);
  mkdirSync(join(dir, "gates"), { recursive: true });
  writeFileSync(join(dir, path), body);
  commit(dir, append(dir, events, "gate.packet", { gate, path, packet_sha256: hash }));
  return `${hash}\n`;
}

const git = (key: string) => Bun.spawnSync(["git", "config", key]).stdout.toString().trim();

export function gateAnswer(runId: string, gate: string, answer: string, packetHash: string): string {
  if (!(gate in REQUIRED)) throw new Error(`unknown gate '${gate}'; expected G0, G1 or G2`);
  const awaiting = `awaiting_${gate.toLowerCase()}` as keyof typeof transitions;
  const allowed = Object.keys(transitions[awaiting]).filter((k) => k.startsWith(`gate.answered:${gate}:`)).map((k) => k.split(":")[2]);
  if (!allowed.includes(answer)) throw new Error(`unknown answer '${answer}' for ${gate}; expected ${allowed.join(", ")}`);

  const dir = runDir(runId);
  const events = readLedger(dir);
  const packet = events.findLast((e) => e.type === "gate.packet" && e.data.gate === gate);
  if (!packet) throw new Error(`${gate} has no packet; run 'ark gate packet ${runId} ${gate}' first`);
  if (events.some((e) => e.seq > packet.seq && e.type === "gate.answered" && e.data.gate === gate)) {
    throw new Error(`${gate} packet ${packet.data.packet_sha256} is already answered`);
  }
  const state = project(events).state;
  if (state !== awaiting) throw new Error(`${gate} is not awaiting an answer (state '${state}')`);
  if (packetHash !== packet.data.packet_sha256) throw new Error(`stale packet hash ${packetHash}; the current ${gate} packet is ${packet.data.packet_sha256}`);
  const file = join(dir, packet.data.path as string);
  if (!existsSync(file) || sha256(readFileSync(file)) !== packetHash) throw new Error(`${packet.data.path} changed since it was hashed; rebuild the packet`);

  const os_user = userInfo().username;
  const git_name = git("user.name");
  const git_email = git("user.email");
  if (!git_name || !git_email) throw new Error("git config user.name and user.email must be set to record the approver");
  const by = `${git_name} <${git_email}> (${os_user})`;
  commit(dir, append(dir, events, "gate.answered", { gate, answer, by, os_user, git_name, git_email, packet_sha256: packetHash }));
  return `${gate} ${answer} recorded by ${by}\n`;
}
