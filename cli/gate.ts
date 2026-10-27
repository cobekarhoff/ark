import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { append, commit, type LedgerEvent, locked, mrEnabled, project, readLedger, runDir, sha256, unattributed, worktreeHeads } from "./run";
import { buildMatrix } from "./trace";
import { transitions } from "./transitions";

// Gate packets (PRD "Gates and loop policy"): built from run-folder artifacts, no model involved.
// Every source artifact is listed with its sha256 (`## file (sha256:..)`, `- file (sha256:..)`), so the packet's own hash covers what it was built from.
const REQUIRED: Record<string, string[]> = { G0: ["ticket.md", "ac.yml"], G1: ["plan.md", "ac.yml"], G2: ["trace-matrix.md", "ac.yml"], GE: ["premise.md"] };

function buildPacket(dir: string, runId: string, gate: string): string {
  const sections = REQUIRED[gate].map((f) => {
    if (!existsSync(join(dir, f))) throw new Error(`${gate} packet needs ${f}, which is missing from the run folder`);
    const bytes = readFileSync(join(dir, f));
    return `## ${f} (${sha256(bytes)})\n\n${bytes.toString("utf8").trimEnd()}\n`;
  });
  if (gate === "G0") {
    const none = (Bun.YAML.parse(readFileSync(join(dir, "ac.yml"), "utf8")) as unknown[]).length === 0;
    sections.push(`## Missing\n\n${none ? "- acceptance criteria: the ticket has none" : "- nothing detected by the CLI"}\n`);
  }
  if (gate === "G2") {
    const art = join(dir, "artifacts");
    const files = existsSync(art) ? (readdirSync(art, { recursive: true }) as string[]).filter((f) => statSync(join(art, f)).isFile()).sort() : [];
    sections.push(`## Test evidence\n\n${files.length ? files.map((f) => `- artifacts/${f} (${sha256(readFileSync(join(art, f)))})`).join("\n") : "- none"}\n`);
    const man = join(dir, "manual");
    const signed = existsSync(man) ? (readdirSync(man, { recursive: true }) as string[]).filter((f) => statSync(join(man, f)).isFile()).sort() : [];
    sections.push(`## Manual records\n\n${signed.length ? signed.map((f) => `- manual/${f} (${sha256(readFileSync(join(man, f)))})`).join("\n") : "- none"}\n`);
  }
  if (gate === "GE") { // the escalation packet: the shared premise and the newest recorded findings
    const dirF = join(dir, "artifacts", "findings");
    const newest = existsSync(dirF) ? Math.max(0, ...readdirSync(dirF).map((f) => parseInt(f)).filter(Number.isInteger)) : 0;
    if (!newest) sections.push("## Latest findings\n\n- none recorded\n");
    else {
      const bytes = readFileSync(join(dirF, `${newest}.json`));
      sections.push(`## artifacts/findings/${newest}.json (${sha256(bytes)})\n\n${bytes.toString("utf8").trimEnd()}\n`);
    }
  }
  return `# ${gate} packet: ${runId}\n\n${sections.join("\n")}`;
}

// file -> sha256 for every source line of a packet body.
const sources = (body: string) => new Map([...body.matchAll(/^(?:## |- )(.+?) \((sha256:[0-9a-f]{64})\)$/gm)].map((m) => [m[1], m[2]]));

// G2 is built, and approved, only when the matrix recomputed now passes and is byte-identical to trace-matrix.md; no stored verdict is trusted.
function requireTrace(dir: string, runId: string, events: LedgerEvent[], what: string) {
  const { matrix, failures } = buildMatrix(dir, runId, project(events), events);
  if (failures.length) throw new Error(`${what} refused: trace-matrix.md would fail trace-check:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  const file = join(dir, "trace-matrix.md");
  if (!existsSync(file) || readFileSync(file, "utf8") !== matrix) throw new Error(`${what} refused: trace-matrix.md is out of date; run 'ark trace-check'`);
}

const checkGate = (gate: string) => {
  if (!Object.hasOwn(REQUIRED, gate)) throw new Error(`unknown gate '${gate}'; expected G0, G1, G2 or GE (escalation)`);
};

export function gatePacket(runId: string, gate: string): string {
  checkGate(gate);
  const dir = runDir(runId);
  return locked(dir, () => {
    const events = readLedger(dir);
    const state = project(events).state;
    if (!Object.hasOwn(transitions[state], `gate.packet:${gate}`)) throw new Error(`cannot build the ${gate} packet in state '${state}'`);
    if (gate === "G2") requireTrace(dir, runId, events, "G2 packet");
    const body = buildPacket(dir, runId, gate);
    const hash = sha256(body);
    const path = `gates/${gate}.${hash.slice("sha256:".length)}.packet.md`; // by hash: a rebuilt packet never overwrites the one an earlier answer recorded
    mkdirSync(join(dir, "gates"), { recursive: true });
    writeFileSync(join(dir, path), body);
    commit(dir, append(dir, events, "gate.packet", { gate, path, packet_sha256: hash }));
    return `${hash}\n`;
  });
}

const git = (key: string) => Bun.spawnSync(["git", "config", key]).stdout.toString().trim();

export function gateAnswer(runId: string, gate: string, answer: string, packetHash: string): string {
  checkGate(gate);
  const awaiting = `awaiting_${gate.toLowerCase()}` as keyof typeof transitions;
  const allowed = Object.keys(transitions[awaiting]).filter((k) => k.startsWith(`gate.answered:${gate}:`)).map((k) => k.split(":")[2]);
  if (!allowed.includes(answer)) throw new Error(`unknown answer '${answer}' for ${gate}; expected ${allowed.join(", ")}`);

  const dir = runDir(runId);
  return locked(dir, () => {
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

    // An approving answer binds what was shown: rebuilding the packet from the run folder now must give the same bytes.
    // Change, edit, send-back and abort stay possible on a stale packet, since the way out of a changed source is to answer and rebuild.
    if (answer === "accept" || answer === "approve") {
      const rebuilt = buildPacket(dir, runId, gate);
      if (sha256(rebuilt) !== packetHash) {
        const was = sources(readFileSync(file, "utf8"));
        const now = sources(rebuilt);
        const changed = [...new Set([...was.keys(), ...now.keys()])].filter((f) => was.get(f) !== now.get(f));
        throw new Error(`${gate} packet is stale: ${changed.join(", ") || "its sources"} changed since it was built; answer change (or edit, send_back) and rebuild the packet`);
      }
      if (gate === "G2" && answer === "approve") requireTrace(dir, runId, events, "G2 approval");
    }
    // An answer that approves or starts a round vouches for the worktrees as they are now; one that starts a round also marks where the next implementer step begins.
    const run = project(events);
    const startsRound = (transitions[awaiting] as Record<string, string>)[`gate.answered:${gate}:${answer}`] === "building"; // answer is one of `allowed`
    let heads = {};
    if ((gate === "G2" || gate === "GE") && answer !== "abort") {
      const bad = unattributed(dir, run, events);
      if (bad.length) throw new Error(`${gate} ${answer} refused:\n${bad.map((b) => `  - ${b}`).join("\n")}`);
      if (startsRound) heads = { heads: worktreeHeads(dir, run) };
    }
    const os_user = userInfo().username;
    const git_name = git("user.name");
    const git_email = git("user.email");
    if (!git_name || !git_email) throw new Error("git config user.name and user.email must be set to record the approver");
    const by = `${git_name} <${git_email}> (${os_user})`;
    // ark.yml mr: false: approval ends the run at ready branches, no ark mr. Read before anything is written.
    const closing = gate === "G2" && answer === "approve" && !mrEnabled();
    const answered = append(dir, events, "gate.answered", { gate, answer, by, os_user, git_name, git_email, packet_sha256: packetHash, ...heads });
    commit(dir, closing ? append(dir, answered, "run.closed", { reason: "mr disabled" }) : answered);
    return `${gate} ${answer} recorded by ${by}\n${closing ? "MRs are disabled in ark.yml; run closed at ready branches\n" : ""}`;
  });
}
