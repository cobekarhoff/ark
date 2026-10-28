import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimHumanAsk } from "./binding";
import { confirmHuman, verifyHumanProof } from "./human";
import { append, commit, type LedgerEvent, locked, maxRounds, mergeRequestsEnabled, project, readLedger, runDirectory, sha256, unattributed, worktreeHeads } from "./run";
import { buildMatrix } from "./trace";
import { transitions } from "./transitions";

// Gate packets (PRD "Gates and loop policy"): built from run-folder artifacts, no model involved.
// Every source artifact is listed with its sha256 (`## file (sha256:..)`, `- file (sha256:..)`), so the packet's own hash covers what it was built from.
const REQUIRED: Record<string, string[]> = { criteria: ["ticket.md", "ac.yml"], plan: ["plan.md", "ac.yml"], evidence: ["trace-matrix.md", "ac.yml"], escalation: ["premise.md"] };

function buildPacket(directory: string, runId: string, gate: string): string {
  const sections = REQUIRED[gate].map((artifactFile) => {
    if (!existsSync(join(directory, artifactFile))) throw new Error(`${gate} packet needs ${artifactFile}, which is missing from the run folder`);
    const bytes = readFileSync(join(directory, artifactFile));
    return `## ${artifactFile} (${sha256(bytes)})\n\n${bytes.toString("utf8").trimEnd()}\n`;
  });
  const acceptanceCriteria = () => Bun.YAML.parse(readFileSync(join(directory, "ac.yml"), "utf8")) as { id: string; kind?: string }[];
  if (gate === "criteria") {
    const none = acceptanceCriteria().length === 0;
    sections.push(`## Missing\n\n${none ? "- acceptance criteria: the ticket has none" : "- nothing detected by the command-line interface (CLI)"}\n`);
  }
  if (gate === "plan") {
    const unkinded = withoutKind(acceptanceCriteria());
    sections.push(`## Missing\n\n${unkinded.length ? `- acceptance criterion (AC) kind (new or preserved, confirmed by your approval): ${unkinded.join(", ")}` : "- nothing detected by the command-line interface (CLI)"}\n`);
  }
  if (gate === "evidence") {
    const artifactsDirectory = join(directory, "artifacts");
    const files = existsSync(artifactsDirectory) ? (readdirSync(artifactsDirectory, { recursive: true }) as string[]).filter((artifactFile) => statSync(join(artifactsDirectory, artifactFile)).isFile()).sort() : [];
    sections.push(`## Test evidence\n\n${files.length ? files.map((artifactFile) => `- artifacts/${artifactFile} (${sha256(readFileSync(join(artifactsDirectory, artifactFile)))})`).join("\n") : "- none"}\n`);
    const manualDirectory = join(directory, "manual");
    const signed = existsSync(manualDirectory) ? (readdirSync(manualDirectory, { recursive: true }) as string[]).filter((artifactFile) => statSync(join(manualDirectory, artifactFile)).isFile()).sort() : [];
    sections.push(`## Manual records\n\n${signed.length ? signed.map((artifactFile) => `- manual/${artifactFile} (${sha256(readFileSync(join(manualDirectory, artifactFile)))})`).join("\n") : "- none"}\n`);
    sections.push(`## Verified findings\n\n${verifiedFindings(directory).map((line) => `- ${line}`).join("\n") || "- none"}\n`);
  }
  if (gate === "escalation") { // the escalation packet: the round budget, the shared premise and the newest recorded findings
    const run = project(readLedger(directory));
    sections.push(`## Rounds\n\n- rounds used: ${run.round} of ${maxRounds()} (the round budget)\n- the human answers one_more_round (exactly one more round), take_over (the human implements) or abort\n`);
    const findingsDirectory = join(directory, "artifacts", "findings");
    const newest = existsSync(findingsDirectory) ? Math.max(0, ...readdirSync(findingsDirectory).map((artifactFile) => parseInt(artifactFile)).filter(Number.isInteger)) : 0;
    if (!newest) sections.push("## Latest findings\n\n- none recorded\n");
    else {
      const bytes = readFileSync(join(findingsDirectory, `${newest}.json`));
      sections.push(`## artifacts/findings/${newest}.json (${sha256(bytes)})\n\n${bytes.toString("utf8").trimEnd()}\n`);
    }
  }
  return `# ${gate} packet: ${runId}\n\n${sections.join("\n")}`;
}

// file -> sha256 for every source line of a packet body.
const sources = (body: string) => new Map([...body.matchAll(/^(?:## |- )(.+?) \((sha256:[0-9a-f]{64})\)$/gm)].map((match) => [match[1], match[2]]));

// Evidence is built, and approved, only when the matrix recomputed now passes and is byte-identical to trace-matrix.md; no stored verdict is trusted.
function requireTrace(directory: string, runId: string, events: LedgerEvent[], what: string) {
  const { matrix, failures, heads } = buildMatrix(directory, runId, project(events), events);
  if (failures.length) throw new Error(`${what} refused: trace-matrix.md would fail trace-check:\n${failures.map((artifactFile) => `  - ${artifactFile}`).join("\n")}`);
  const file = join(directory, "trace-matrix.md");
  if (!existsSync(file) || readFileSync(file, "utf8") !== matrix) throw new Error(`${what} refused: trace-matrix.md is out of date; run 'ark trace-check'`);
  const approvedHeads: Record<string, string> = {};
  for (const [repositoryName, head] of heads) {
    if (!head) throw new Error(`${what} refused: ${repositoryName} has no clean worktree head`);
    approvedHeads[repositoryName] = head;
  }
  return approvedHeads;
}

const checkGate = (gate: string) => {
  if (!Object.hasOwn(REQUIRED, gate)) throw new Error(`unknown gate '${gate}'; expected criteria, plan, evidence or escalation`);
};

export function gatePacket(runId: string, gate: string): string {
  checkGate(gate);
  const directory = runDirectory(runId);
  return locked(directory, () => {
    const events = readLedger(directory);
    const state = project(events).state;
    if (!Object.hasOwn(transitions[state], `gate.packet:${gate}`)) throw new Error(`cannot build the ${gate} packet in state '${state}'`);
    if (gate === "escalation" && project(events).round < maxRounds()) throw new Error(`cannot build the escalation packet: ${project(events).round} of ${maxRounds()} rounds used; escalation opens only once the round budget is spent (ark advance fix_round.started starts a round)`);
    if (gate === "evidence") requireTrace(directory, runId, events, "evidence packet");
    const body = buildPacket(directory, runId, gate);
    const hash = sha256(body);
    const path = `gates/${gate}.${hash.slice("sha256:".length)}.packet.md`; // by hash: a rebuilt packet never overwrites the one an earlier answer recorded
    mkdirSync(join(directory, "gates"), { recursive: true });
    writeFileSync(join(directory, path), body);
    commit(directory, append(directory, events, "gate.packet", { gate, path, packet_sha256: hash }));
    return `${hash}\n`;
  });
}

const withoutKind = (acceptanceCriteria: { id: string; kind?: string }[]) => acceptanceCriteria.filter((criterion) => !criterion.kind).map((criterion) => criterion.id);

type Finding = { id: string; priority: string; bucket: string; file: string; line: number; evidence?: { failing_test?: string; traced_path?: string } };

// Verified findings (CONTEXT.md): act-on P0 and P1 findings, oldest recorded first, each with what verified it. A traced path is weaker evidence than a failing test, and the packet says so.
function verifiedFindings(directory: string): string[] {
  const folder = join(directory, "artifacts", "findings");
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((artifactFile) => /^\d+\.json$/.test(artifactFile)).sort((a, b) => parseInt(a) - parseInt(b)).flatMap((artifactFile) =>
    (JSON.parse(readFileSync(join(folder, artifactFile), "utf8")) as Finding[]).filter((finding) => finding.bucket === "act_on" && (finding.priority === "P0" || finding.priority === "P1")).map((finding) =>
      `${finding.id} ${finding.priority} ${finding.file}:${finding.line}: ${finding.evidence?.failing_test ? `failing test '${finding.evidence.failing_test}'` : `traced path, weaker evidence (no test reaches it): ${finding.evidence?.traced_path}`}`));
}

export function gateAnswer(runId: string, gate: string, answer: string, packetHash: string): string {
  checkGate(gate);
  const awaiting = `awaiting_${gate}` as keyof typeof transitions;
  const allowed = [...new Set(Object.keys(transitions[awaiting]).filter((k) => k.startsWith(`gate.answered:${gate}:`)).map((k) => k.split(":")[2]))]; // the evidence escalated variant shares its answer name
  if (!allowed.includes(answer)) throw new Error(`unknown answer '${answer}' for ${gate}; expected ${allowed.join(", ")}`);

  const directory = runDirectory(runId);
  const action = `gate.answered:${gate}`;
  const identity = confirmHuman(directory, runId, action, answer, packetHash, allowed);
  return locked(directory, () => {
    const events = readLedger(directory);
    const packet = events.findLast((event) => event.type === "gate.packet" && event.data.gate === gate);
    if (!packet) throw new Error(`${gate} has no packet; run 'ark gate packet ${runId} ${gate}' first`);
    if (events.some((event) => event.seq > packet.seq && event.type === "gate.answered" && event.data.gate === gate)) {
      throw new Error(`${gate} packet ${packet.data.packet_sha256} is already answered`);
    }
    const state = project(events).state;
    if (state !== awaiting) throw new Error(`${gate} is not awaiting an answer (state '${state}')`);
    if (packetHash !== packet.data.packet_sha256) throw new Error(`stale packet hash ${packetHash}; the current ${gate} packet is ${packet.data.packet_sha256}`);
    const file = join(directory, packet.data.path as string);
    if (!existsSync(file) || sha256(readFileSync(file)) !== packetHash) throw new Error(`${packet.data.path} changed since it was hashed; rebuild the packet`);

    let approvedHeads: Record<string, string> | undefined;
    // An approving answer binds what was shown: rebuilding the packet from the run folder now must give the same bytes.
    if (answer === "accept" || answer === "approve" || (gate === "escalation" && answer !== "abort")) {
      const rebuilt = buildPacket(directory, runId, gate);
      if (sha256(rebuilt) !== packetHash) {
        const was = sources(readFileSync(file, "utf8"));
        const now = sources(rebuilt);
        const changed = [...new Set([...was.keys(), ...now.keys()])].filter((artifactFile) => was.get(artifactFile) !== now.get(artifactFile));
        throw new Error(`${gate} packet is stale: ${changed.join(", ") || "its sources"} changed since it was built; answer change (or edit, send_back) and rebuild the packet`);
      }
      if (gate === "evidence" && answer === "approve") approvedHeads = requireTrace(directory, runId, events, "evidence approval");
      // The AC kind is proposed at intake and confirmed by the human at the plan gate: no approval while one is missing.
      const unkinded = gate === "plan" ? withoutKind(Bun.YAML.parse(readFileSync(join(directory, "ac.yml"), "utf8")) as { id: string; kind?: string }[]) : [];
      if (unkinded.length) throw new Error(`plan approve refused: ${unkinded.join(", ")} ${unkinded.length > 1 ? "have" : "has"} no kind; set 'kind: new' or 'kind: preserved' in ac.yml and rebuild the packet`);
    }
    // An answer that approves or starts a round vouches for the worktrees as they are now; one that starts a round also marks where the next implementer step begins.
    const run = project(events);
    const escalated = gate === "evidence" && answer === "send_back" && run.round >= maxRounds();
    const startsRound = !escalated && (transitions[awaiting] as Record<string, string>)[`gate.answered:${gate}:${answer}`] === "building"; // answer is one of `allowed`
    let heads = {};
    if ((gate === "evidence" || gate === "escalation") && answer !== "abort") {
      const bad = unattributed(directory, run, events);
      if (bad.length) throw new Error(`${gate} ${answer} refused:\n${bad.map((b) => `  - ${b}`).join("\n")}`);
      if (startsRound) heads = { heads: worktreeHeads(directory, run) };
    }
    if (!verifyHumanProof(directory, runId, action, answer, packetHash, allowed, identity)) {
      throw new Error(`human confirmation for ${action} is no longer valid; ask the human again`);
    }
    if (!identity.question || !identity.ask_call_id || !claimHumanAsk(identity.question, identity.ask_call_id)) {
      throw new Error(`ask confirmation ${identity.ask_call_id} was already used; ask the human again`);
    }
    const acceptanceCriteriaKinds = gate === "plan" && answer === "approve"
      ? Object.fromEntries((Bun.YAML.parse(readFileSync(join(directory, "ac.yml"), "utf8")) as { id: string; kind: string }[]).map((criterion) => [criterion.id, criterion.kind]))
      : undefined;
    const closing = gate === "evidence" && answer === "approve" && !mergeRequestsEnabled() && !events.some((event) => event.type === "merge_request.opened");
    const answered = append(directory, events, "gate.answered", { gate, answer, ...identity, packet_sha256: packetHash, ...(acceptanceCriteriaKinds ? { ac_kinds: acceptanceCriteriaKinds } : {}), ...(escalated ? { escalated: true } : {}), ...heads, ...(approvedHeads ? { approved_heads: approvedHeads } : {}) });
    commit(directory, closing ? append(directory, answered, "run.closed", { outcome: "handed_off", reason: "merge requests disabled" }) : answered);
    return `${gate} ${answer} recorded by ${identity.by}\n${closing ? "merge requests are disabled in ark.yml; run closed at ready branches, handed off\n" : ""}`;
  });
}
