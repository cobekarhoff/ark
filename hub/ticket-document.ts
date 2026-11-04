import type { TicketDocument } from "./types.ts";

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

/** The first sentence of the `## Problem` section, else of `## Why`; null when neither has text. */
export function whyOf(source: string): string | null {
  const body = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)?.[1] ?? source;
  const text = sectionOf(body, "problem") || sectionOf(body, "why");
  return text.replace(/\s+/g, " ").match(/^.*?(?:[.!?](?=\s)|[.!?]$|$)/)?.[0] || null;
}

/**
 * The Problem and Change sections and the numbered acceptance criteria of a ticket file. Leaves as
 * plain strings: the page puts them in the document as text, never as Markdown HTML.
 */
export function parseTicketDocument(source: string): TicketDocument {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const body = match ? match[2] : source;
  let fields: Record<string, unknown> | null = null;
  try {
    fields = match ? (Bun.YAML.parse(match[1]) as Record<string, unknown> | null) : null;
  } catch {
    // A front matter that does not parse still leaves the body readable.
  }
  const listed = Array.isArray(fields?.acceptance_criteria) ? fields.acceptance_criteria : [];
  return {
    problem: sectionOf(body, "problem"),
    change: sectionOf(body, "change"),
    criteria: listed.flatMap((entry) => {
      const criterion = entry as { id?: unknown; text?: unknown } | null;
      return typeof criterion?.id === "string" && typeof criterion.text === "string"
        ? [{ id: criterion.id, text: criterion.text }]
        : [];
    }),
  };
}
