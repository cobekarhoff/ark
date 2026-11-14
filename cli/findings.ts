/** List lines of the `## Run lead decision` section of a findings file; the section ends at the next heading. */
export function decisionLines(text: string): string[] {
  const lines: string[] = [];
  let inDecision = false;
  for (const line of text.split("\n")) {
    if (/^#{1,6}\s/.test(line)) inDecision = /^##\s+Run lead decision\s*$/i.test(line);
    else if (inDecision) lines.push(line);
  }
  return lines;
}

/**
 * Dropped lines (`- dropped <title>: <reason>`) of `## Run lead decision`, each as the text after `dropped`.
 * The line is a list item: it starts with `-` or `*`, then optional bold marks, then `dropped` in any case.
 */
export function droppedLines(text: string): string[] {
  return decisionLines(text).flatMap((line) => {
    const match = /^\s*[-*]\s+(?:\*\*|__)?dropped\b[*_:]*\s*(.*)$/i.exec(line);
    return match ? [match[1].toLowerCase()] : [];
  });
}

/** Rules of a `rules.md` file: its list lines (`-` or `*` marker, then text). Headings, prose and blank lines count 0. */
export function ruleLines(text: string): string[] {
  return text.split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line));
}

/** True when `## Run lead decision` has a dropped line for the finding with this title, matched case-insensitively. */
export function isDropped(text: string, title: string): boolean {
  const wanted = title.trim().toLowerCase();
  return wanted !== "" && droppedLines(text).some((line) => line.startsWith(`${wanted}:`));
}
