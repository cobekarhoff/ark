// Frozen copy of `description()` from cli/merge-request.ts at commit 9b85039, the MR body builder before ARK-316.
// Test-only evidence for the ARK-T37 "before" body. Never imported by production code; do not update it.
// It is transpiled and run by test/pr-writing.test.ts, so it needs no imports.

type Criterion = { text: string };

export function description(
  ticket: { id: string; title: string },
  criteriaIds: string[],
  texts: Map<string, Criterion>,
  dependencyLines: string[],
  ui: { skills: string[]; findings: string[] } | null = null,
): string {
  const criteria = criteriaIds.map(
    (id) => `- ${id}${texts.has(id) ? `: ${texts.get(id)?.text}` : ""}`,
  );
  return [
    `Ticket: ${ticket.id} ${ticket.title}`,
    "",
    "Acceptance criteria this repo serves:",
    ...(criteria.length > 0 ? criteria : ["- none"]),
    ...(dependencyLines.length > 0 ? ["", ...dependencyLines] : []),
    ...(ui
      ? [
          "",
          "## UI/UX checks",
          "",
          `Skills applied: ${ui.skills.join(", ")}`,
          "",
          ...(ui.findings.length > 0 ? ui.findings : ["- No UI/UX findings."]),
        ]
      : []),
  ].join("\n");
}
