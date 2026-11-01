import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";

// The strategy gate has no fixed answers: the transition table checks the card ids of the run.
const gateAnswers: Record<string, string[]> = {
  criteria: ["accept", "edit", "abort"],
  strategy: [],
  plan: ["approve", "change", "abort"],
  escalation: ["one_more_round", "take_over", "abort"],
};

// Reads the ticket file named in run.started, so edits made at the criteria gate are picked up.
function acceptCriteria(runDirectory: string): void {
  const started = readEvents(runDirectory).find((event) => event.type === "run.started");
  const ticketFile = (started?.data as { ticket_file?: string } | undefined)?.ticket_file;
  if (!ticketFile || !existsSync(ticketFile)) {
    throw new ArkError(`ticket file not found: ${ticketFile ?? "(none recorded)"}`);
  }
  const content = readFileSync(ticketFile, "utf8");
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const criteria = frontmatter
    ? (Bun.YAML.parse(frontmatter[1]) as Record<string, unknown>)?.acceptance_criteria
    : undefined;
  const ids = Array.isArray(criteria)
    ? criteria.map((criterion) => String(criterion?.id ?? "")).filter(Boolean)
    : [];
  if (ids.length === 0) {
    throw new ArkError(
      `ticket ${ticketFile} has no acceptance criteria: add at least one, then record criteria accept again`,
    );
  }
  copyFileSync(ticketFile, join(runDirectory, "ticket.md"));
  appendEvent(runDirectory, "criteria.updated", { criteria: ids });
}

export function gateRecord(runId: string, gate: string, answer: string, note?: string): void {
  if (!Object.hasOwn(gateAnswers, gate)) {
    throw new ArkError(`unknown gate "${gate}": use ${Object.keys(gateAnswers).join(", ")}`);
  }
  if (gate !== "strategy" && !gateAnswers[gate].includes(answer)) {
    throw new ArkError(
      `unknown answer "${answer}" for gate ${gate}: use ${gateAnswers[gate].join(", ")}`,
    );
  }
  const { directory } = findRun(runId);
  const accepting = gate === "criteria" && answer === "accept";
  // Only the awaiting_criteria phase refreshes criteria; in any other phase the transition table refuses the answer.
  if (accepting && deriveState(readEvents(directory)).phase === "awaiting_criteria")
    acceptCriteria(directory);
  appendEvent(
    directory,
    "gate.answered",
    note === undefined ? { gate, answer } : { gate, answer, note },
  );
  console.log(`recorded ${gate} ${answer}`);
}
