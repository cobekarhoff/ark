import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";

type Card = { id: string; fields: Record<string, string>; text: string };

const fieldNames = [
  "approach",
  "interfaces",
  "tradeoffs",
  "steps",
  "mockup",
  "mockups",
  "recommended",
  "reason",
];

/**
 * strategies.md has one level-2 heading for each card: `## <id> <title>`. A card is a list of
 * `Name: text` fields (Approach, Interfaces, Tradeoffs, Steps, Mockup, Recommended, Reason). A
 * field runs until the next field or heading.
 */
export function parseCards(content: string): Card[] {
  const cards: Card[] = [];
  let card: Card | null = null;
  let field: string | null = null;
  for (const line of content.split("\n")) {
    const heading = line.match(/^##\s+(\S+)(?:\s+(.*?))?\s*$/);
    if (heading) {
      card = { id: heading[1], fields: {}, text: `### ${heading[1]} ${heading[2] ?? ""}`.trim() };
      cards.push(card);
      field = null;
      continue;
    }
    if (!card) continue;
    card.text += `\n${line}`;
    const named = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (named && fieldNames.includes(named[1].toLowerCase())) {
      field = named[1].toLowerCase();
      card.fields[field] = named[2];
    } else if (field) {
      card.fields[field] += `\n${line}`;
    }
  }
  for (const found of cards) found.text = found.text.trimEnd();
  return cards;
}

/** Paths in a Mockup field: markdown links, or comma and space separated paths. */
export function mockupPaths(value: string): string[] {
  const links = [...value.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  if (links.length > 0) return links;
  return value
    .split(/[\s,]+/)
    .map((path) => path.replaceAll("`", "").replace(/^-+$/, ""))
    .filter(Boolean);
}

export function strategyRecord(runId: string): void {
  const { project, directory } = findRun(runId);
  const state = deriveState(readEvents(directory));
  if (!state.evaluation)
    throw new ArkError(
      "strategy.recorded refused: missing evaluation.recorded (ark evaluation record)",
    );
  const file = join(directory, "strategies.md");
  if (!existsSync(file)) throw new ArkError(`strategies.md not found in ${directory}`);

  const needsMockups = state.evaluation.surfaces.some((surface) => surface !== "none");
  if (needsMockups && !loadConfig(project).roles.designer) {
    throw new ArkError(
      `ark.yml of project ${project} has no roles.designer: add its harness and model (the evaluation lists surface ${state.evaluation.surfaces.join(", ")})`,
    );
  }

  const cards = parseCards(readFileSync(file, "utf8"));
  if (cards.length === 0)
    throw new ArkError(
      'strategies.md has no cards: add one "## <id> <title>" heading for each card',
    );
  const ids = new Set<string>();
  for (const card of cards) {
    if (ids.has(card.id)) throw new ArkError(`strategies.md has two cards with the id ${card.id}`);
    ids.add(card.id);
    for (const name of ["approach", "interfaces", "tradeoffs"]) {
      if (!card.fields[name]?.trim())
        throw new ArkError(
          `strategy card ${card.id} has no ${name}: add a "${name[0].toUpperCase()}${name.slice(1)}:" line`,
        );
    }
    const mockups = mockupPaths(`${card.fields.mockup ?? ""} ${card.fields.mockups ?? ""}`);
    if (needsMockups && mockups.length === 0) {
      throw new ArkError(
        `strategy card ${card.id} has no mockup link: the evaluation lists surface ${state.evaluation.surfaces.join(", ")}, so add a "Mockup:" line`,
      );
    }
    for (const mockup of mockups) {
      const path = resolve(directory, mockup);
      const inside = relative(directory, path);
      if (
        inside.startsWith("..") ||
        isAbsolute(inside) ||
        !existsSync(path) ||
        !statSync(path).isFile()
      )
        throw new ArkError(
          `strategy card ${card.id} links ${mockup}, which is not a file in the run folder`,
        );
    }
  }

  const recommended = cards.filter((card) =>
    /^(yes|true)\b/i.test(card.fields.recommended?.trim() ?? ""),
  );
  if (cards.length > 1 && recommended.length !== 1) {
    throw new ArkError(
      `strategies.md needs exactly one card with "Recommended: yes", found ${recommended.length}`,
    );
  }
  const reason = cards[0].fields.reason?.trim() ?? "";
  if (cards.length === 1 && !reason) {
    throw new ArkError(
      `strategy card ${cards[0].id} is the only card: add a "Reason:" line that says why there is no alternative`,
    );
  }
  const recommendedId = (recommended[0] ?? cards[0]).id;

  appendEvent(directory, "strategy.recorded", {
    count: cards.length,
    recommended: recommendedId,
    cards: cards.map((card) => card.id),
    ...(cards.length === 1 ? { reason } : {}),
    card_text: Object.fromEntries(cards.map((card) => [card.id, card.text])),
  });
  console.log(
    `recorded strategy: ${cards.length} card${cards.length === 1 ? "" : "s"}, recommended ${recommendedId}`,
  );
}
