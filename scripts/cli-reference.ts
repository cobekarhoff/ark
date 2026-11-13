#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const referencePath = join(repositoryRoot, "docs/reference/cli.md");
const startMarker = "<!-- generated:commands:start -->";
const endMarker = "<!-- generated:commands:end -->";
const wrapColumns = 100;

function arkHelp(words: string[]): string {
  const result = Bun.spawnSync(["bun", join(repositoryRoot, "cli/ark.ts"), ...words, "--help"], {
    cwd: repositoryRoot,
  });
  if (result.exitCode !== 0) {
    throw new Error(`ark ${words.join(" ")} --help failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

// A command line is lowercase words followed by `<` or `[`, for example `run start <ticket-file>`.
function commandNames(topLevelHelp: string): string[] {
  const names: string[] = [];
  for (const line of topLevelHelp.split("\n")) {
    const match = line.match(/^\s*([a-z][a-z-]*(?: [a-z][a-z-]*)*)(?:\s+[<[]|$)/);
    if (!match || match[1] === "ark" || match[1].startsWith("ark ")) continue;
    names.push(match[1]);
  }
  if (names.length === 0) throw new Error("ark --help lists no commands");
  return names;
}

// The job of each command, by its name or by its first words (the longest match wins). A command
// that matches no entry lands in `fallbackGroup`, so a new command never leaves the contents table.
const groups = [
  "Start and close",
  "Plan",
  "Build and test",
  "Gates",
  "Merge requests",
  "Master Chief",
  "Hub and services",
];
const fallbackGroup = "Other";
const groupByPrefix: Record<string, string> = {
  "run start": "Start and close",
  "run close": "Start and close",
  status: "Start and close",
  retro: "Start and close",
  evaluation: "Plan",
  strategy: "Plan",
  "ui-skills": "Plan",
  plan: "Plan",
  criteria: "Plan",
  "run step": "Build and test",
  worktree: "Build and test",
  workspace: "Build and test",
  test: "Build and test",
  "test-case": "Build and test",
  "test-audit": "Build and test",
  gate: "Gates",
  escalate: "Gates",
  "merge-request": "Merge requests",
  bump: "Merge requests",
  chief: "Master Chief",
  ui: "Hub and services",
  services: "Hub and services",
};

function groupOf(name: string): string {
  const words = name.split(" ");
  for (let length = words.length; length > 0; length--) {
    const group = groupByPrefix[words.slice(0, length).join(" ")];
    if (group !== undefined) return group;
  }
  return fallbackGroup;
}

// Greedy wrap. A word longer than the width keeps its own line.
function wrap(text: string, firstIndent = "", indent = ""): string {
  const lines: string[] = [];
  let line = firstIndent;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line.trim() === "" ? line + word : `${line} ${word}`;
    if (line.trim() !== "" && candidate.length > wrapColumns) {
      lines.push(line);
      line = indent + word;
    } else line = candidate;
  }
  if (line.trim() !== "") lines.push(line);
  return lines.join("\n");
}

// The index of `separator` outside a backtick span, or -1.
function indexOutsideCode(text: string, separator: string): number {
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "`") inCode = !inCode;
    else if (!inCode && text.startsWith(separator, i)) return i;
  }
  return -1;
}

const summaryLimit = 110;
const summaryMinimum = 20;

// The first sentence of the description, cut at a clause (` (` or `: ` outside code) when that
// leaves a sentence of at least `summaryMinimum` characters.
function summaryOf(description: string): string {
  const paragraph = description.split("\n\n")[0].replace(/\s+/g, " ").trim();
  let sentence = paragraph.match(/^.*?\.(?=\s|$)/)?.[0] ?? paragraph;
  sentence = sentence.replace(/\.$/, "");
  for (const separator of [" (", ": "]) {
    const cut = indexOutsideCode(sentence, separator);
    if (cut >= summaryMinimum) sentence = sentence.slice(0, cut);
  }
  // Still long: cut at the last comma outside code that fits, else at a word.
  if (sentence.length > summaryLimit) {
    const balanced = (text: string) => text.split("`").length % 2 === 1;
    let cut = sentence.lastIndexOf(", ", summaryLimit);
    while (cut >= summaryMinimum && !balanced(sentence.slice(0, cut)))
      cut = sentence.lastIndexOf(", ", cut - 1);
    if (cut >= summaryMinimum) sentence = sentence.slice(0, cut);
    else {
      sentence = sentence.slice(0, sentence.lastIndexOf(" ", summaryLimit));
      if (!balanced(sentence)) sentence = sentence.slice(0, sentence.lastIndexOf("`"));
      sentence = `${sentence.trimEnd()}…`;
    }
  }
  return sentence;
}

// In a table cell, `|` and `<` outside code spans would read as a column or an HTML tag.
function cell(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part.replaceAll("|", "\\|")
        : part.replaceAll("|", "\\|").replaceAll("<", "\\<"),
    )
    .join("");
}

type Command = { name: string; usage: string; description: string };

const commands: Command[] = commandNames(arkHelp([])).map((name) => {
  const [usage, ...paragraphs] = arkHelp(name.split(" ")).split("\n\n");
  return { name, usage: usage.trim(), description: paragraphs.join("\n\n") };
});

const used = [...groups, fallbackGroup].filter((group) =>
  commands.some((command) => groupOf(command.name) === group),
);
const rows = [
  ["Job", "Command", "What it does"],
  ...used.flatMap((group) =>
    commands
      .filter((command) => groupOf(command.name) === group)
      .map((command, i) => [
        i === 0 ? group : "",
        `[\`${command.name}\`](#${command.name.replaceAll(" ", "-")})`,
        cell(summaryOf(command.description)),
      ]),
  ),
];
// Padded like the formatter pads a Markdown table (by code point), so `format:check` leaves the
// file as written.
const widths = rows[0].map((_, column) =>
  Math.max(...rows.map((row) => Array.from(row[column]).length)),
);
const tableLine = (row: string[]) =>
  `| ${row.map((text, column) => text + " ".repeat(widths[column] - Array.from(text).length)).join(" | ")} |`;
const contents = [
  tableLine(rows[0]),
  `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
  ...rows.slice(1).map(tableLine),
].join("\n");

const sections = commands.map((command) => {
  const body = [
    wrap(command.usage, "", "    "),
    ...command.description
      .split("\n\n")
      .filter(Boolean)
      .map((paragraph) => wrap(paragraph)),
  ].join("\n\n");
  return `### ${command.name}\n\n\`\`\`text\n${body}\n\`\`\``;
});

const document = readFileSync(referencePath, "utf8");
const start = document.indexOf(startMarker);
const end = document.indexOf(endMarker);
if (start === -1 || end < start)
  throw new Error(`${referencePath} is missing the generated markers`);

const updated = `${document.slice(0, start + startMarker.length)}\n\n${contents}\n\n${sections.join("\n\n")}\n\n${document.slice(end)}`;
if (updated !== document) writeFileSync(referencePath, updated);
