#!/usr/bin/env bun
// Regenerates the command section of docs/reference/cli.md from `ark --help`
// and `ark <command> --help`. Run it again after any change to the help text.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const referencePath = join(repositoryRoot, "docs/reference/cli.md");
const startMarker = "<!-- generated:commands:start -->";
const endMarker = "<!-- generated:commands:end -->";

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

const sections = commandNames(arkHelp([])).map(
  (name) => `### ${name}\n\n\`\`\`text\n${arkHelp(name.split(" "))}\n\`\`\``,
);

const document = readFileSync(referencePath, "utf8");
const start = document.indexOf(startMarker);
const end = document.indexOf(endMarker);
if (start === -1 || end < start)
  throw new Error(`${referencePath} is missing the generated markers`);

const updated = `${document.slice(0, start + startMarker.length)}\n\n${sections.join("\n\n")}\n\n${document.slice(end)}`;
if (updated !== document) writeFileSync(referencePath, updated);
