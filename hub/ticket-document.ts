import { canonicalCriterion } from "../cli/criterion-id.ts";
import { frontmatter, splitFrontmatter } from "../cli/ticket.ts";
import type { TicketCriterionView, TicketDocument } from "./types.ts";

/** Text of a section of a ticket body: the lines under `## <heading>` up to the next `## `. */
function sectionOf(body: string, heading: string): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`);
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

/** Text without inline code marks: ticket titles and `why` are shown as plain text. */
export const withoutCodeMarks = (text: string): string => text.replaceAll("`", "");

/** The first sentence of the `## Problem` section, else of `## Why`, as plain text (no backticks, never past a heading or paragraph); null when neither has text. */
export function whyOf(source: string): string | null {
  const { body } = splitFrontmatter(source);
  const text = sectionOf(body, "problem") || sectionOf(body, "why");
  const paragraph = text.split(/\r?\n\s*\r?\n|\r?\n#{1,6}\s/)[0];
  const sentence = paragraph.replace(/\s+/g, " ").match(/^.*?(?:[.!?](?=\s)|[.!?]$|$)/)?.[0];
  return sentence ? withoutCodeMarks(sentence) || null : null;
}

/**
 * The Problem and Change sections and the numbered acceptance criteria of a ticket file. Leaves as
 * plain strings: the page puts them in the document as text, never as Markdown HTML.
 */
export function parseTicketDocument(source: string): TicketDocument {
  const { body } = splitFrontmatter(source);
  let fields: Record<string, unknown> | undefined;
  try {
    fields = frontmatter(source).fields;
  } catch {
    // A front matter that does not parse still leaves the body readable.
  }
  const listed = Array.isArray(fields?.acceptance_criteria) ? fields.acceptance_criteria : [];
  return {
    problem: sectionOf(body, "problem"),
    change: sectionOf(body, "change"),
    criteria: criteriaOf(listed),
  };
}

type Listed = {
  id?: unknown;
  text?: unknown;
  method?: unknown;
  manual?: unknown;
  verified_by?: unknown;
};

/**
 * Criteria with their local id (`ARK-243-AC4` and `AC4` are the same AC), `method` (`manual: true`
 * alone reads `demonstration`, none reads `test`) and `verified_by` (`[]` unless a list of strings).
 * An AC written twice in different forms is listed once, with the case ids of both.
 */
function criteriaOf(listed: unknown[]): TicketCriterionView[] {
  const found = new Map<string, TicketCriterionView>();
  for (const entry of listed) {
    const criterion = entry as Listed | null;
    if (typeof criterion?.id !== "string" || typeof criterion.text !== "string") continue;
    const id = canonicalCriterion(criterion.id).split("/").pop()!;
    const verified =
      Array.isArray(criterion.verified_by) &&
      criterion.verified_by.every((item) => typeof item === "string")
        ? (criterion.verified_by as string[])
        : [];
    const same = found.get(id);
    if (same) {
      same.verified_by = [...new Set([...same.verified_by, ...verified])];
      continue;
    }
    found.set(id, {
      id,
      text: criterion.text,
      method:
        typeof criterion.method === "string"
          ? criterion.method
          : criterion.manual === true
            ? "demonstration"
            : "test",
      verified_by: verified,
    });
  }
  return [...found.values()];
}
