import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "./errors.ts";
import { canonicalCriterion } from "./criterion-id.ts";
import { evidenceFile, frontmatter, manualCriteria, parseCriteria, runCriteria } from "./ticket.ts";
import { appendEvent, deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";

// The strategy gate has no fixed answers: the transition table checks the card ids of the run.
const gateAnswers: Record<string, string[]> = {
  criteria: ["accept", "edit", "abort"],
  strategy: [],
  plan: ["approve", "change", "abort"],
  escalation: ["one_more_round", "take_over", "abort"],
  manual: ["ok", "problem"],
};

// Reads the ticket file named in run.started, so edits made at the criteria gate are picked up.
function acceptCriteria(runDirectory: string): void {
  const started = readEvents(runDirectory).find((event) => event.type === "run.started");
  const ticketFile = (started?.data as { ticket_file?: string } | undefined)?.ticket_file;
  if (!ticketFile || !existsSync(ticketFile)) {
    throw new ArkError(`ticket file not found: ${ticketFile ?? "(none recorded)"}`);
  }
  const fields = frontmatter(readFileSync(ticketFile, "utf8")).fields ?? {};
  const parsed = parseCriteria(fields, ticketFile);
  const ids = parsed.map((criterion) => criterion.id);
  if (ids.length === 0) {
    throw new ArkError(
      `ticket ${ticketFile} has no acceptance criteria: add at least one, then record criteria accept again`,
    );
  }
  const empty = parsed.filter(
    (criterion) =>
      criterion.newScheme && criterion.method === "test" && criterion.verified_by.length === 0,
  );
  if (empty.length > 0) {
    throw new ArkError(
      `cannot accept criteria: ${empty.map((criterion) => `${criterion.id} has method "test" and an empty verified_by list`).join("; ")}. Add an integration or e2e test case id to verified_by, or set method to demonstration, inspection or analysis.`,
    );
  }
  copyFileSync(ticketFile, join(runDirectory, "ticket.md"));
  appendEvent(runDirectory, "criteria.updated", { criteria: ids });
}

export function gateRecord(
  runId: string,
  gate: string,
  args: string[],
  note?: string,
  inProject?: string,
): void {
  // The manual gate is answered for one criterion: `<criterion id> <answer>`; the others take `<answer>`.
  const [criterionArgument, answer] = gate === "manual" ? args : [undefined, args[0]];
  if (answer === undefined) {
    throw new ArkError(
      gate === "manual"
        ? "the manual gate needs a criterion id and an answer: ark gate record <run> manual <criterion id> ok|problem"
        : `gate ${gate} needs an answer`,
    );
  }
  if (!Object.hasOwn(gateAnswers, gate)) {
    throw new ArkError(`unknown gate "${gate}": use ${Object.keys(gateAnswers).join(", ")}`);
  }
  if (gate !== "strategy" && !gateAnswers[gate].includes(answer)) {
    throw new ArkError(
      `unknown answer "${answer}" for gate ${gate}: use ${gateAnswers[gate].join(", ")}`,
    );
  }
  const { directory } = findRun(runId, inProject);
  const criterion =
    criterionArgument === undefined
      ? undefined
      : canonicalCriterion(criterionArgument, deriveState(readEvents(directory)).ticket.id);
  if (criterion !== undefined) {
    if (!deriveState(readEvents(directory)).criteria.some((c) => c.id === criterion))
      throw new ArkError(`criterion ${criterion} is not in the ticket`);
    if (!manualCriteria(directory).includes(criterion))
      throw new ArkError(`criterion ${criterion} is not manual: set \`manual: true\` in ticket.md`);
  }
  const accepting = gate === "criteria" && answer === "accept";
  // Only the awaiting_criteria phase refreshes criteria; in any other phase the transition table refuses the answer.
  if (accepting && deriveState(readEvents(directory)).phase === "awaiting_criteria")
    acceptCriteria(directory);
  appendEvent(directory, "gate.answered", {
    gate,
    ...(criterion === undefined ? {} : { criterion }),
    answer,
    by: "human",
    ...(note === undefined ? {} : { note }),
  });
  // A demonstration file ends with the human's `human: ok`, once. The other methods' files are the reviewer's or a command's.
  if (criterion !== undefined && answer === "ok") {
    const file = evidenceFile(directory, criterion);
    const method = runCriteria(directory).find((entry) => entry.id === criterion)?.method;
    if (method === "demonstration" && existsSync(file)) {
      const kept = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "human: ok");
      writeFileSync(file, `${kept.join("\n").trimEnd()}\n\nhuman: ok\n`);
    }
  }
  console.log(`recorded ${gate} ${answer}`);
}

export function escalate(runId: string, reason: string | undefined, inProject?: string): void {
  const { directory } = findRun(runId, inProject);
  appendEvent(directory, "escalation.requested", { reason: (reason ?? "").trim() });
  const state = deriveState(readEvents(directory));
  console.log(`recorded escalation request: round ${state.round} of ${state.round_budget}`);
}
