import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const skillDirectory = join(repositoryRoot, "skills/ark");
const router = readFileSync(join(skillDirectory, "SKILL.md"), "utf8");
const brainstormPlaybookPath = join(skillDirectory, "playbooks/brainstorm.md");
const brainstormPlaybook = readFileSync(brainstormPlaybookPath, "utf8");

/** Text of a `## <heading>` section, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const body = markdown.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0];
  expect(body, `section "${heading}"`).toBeDefined();
  return body!;
}

test("ARK-182-AC1 the router loads playbooks/brainstorm.md and names brainstorm in its description and unknown-playbook list", () => {
  const description = router.match(/^description: (.*)$/m)?.[1];
  expect(description).toContain("`/skill:ark brainstorm`");

  expect(router).toMatch(/^\| `brainstorm`\s*\| none\s*\| `playbooks\/brainstorm\.md`\s*\|/m);
  expect(existsSync(brainstormPlaybookPath)).toBe(true);

  const unknownList = router.match(
    /Unknown playbook "<name>"\. Use one of:\n((?: {2,}.*\n)+)/,
  )?.[1];
  expect(unknownList).toMatch(/^ +brainstorm +\S/m);
});

test("ARK-182-AC2 the brainstorm playbook shows the eight steps in order with the ticket format, the STE rule and the UI-ideas procedure", () => {
  const stepHeadings = [...brainstormPlaybook.matchAll(/^## (\d+)\. (.+)$/gm)].map(
    ([, number, title]) => `${number}. ${title}`,
  );
  expect(stepHeadings).toEqual([
    "1. Load context",
    "2. Find facts yourself",
    "3. Ask",
    "4. Check the decisions against the PRD and ADRs",
    "5. Prototype UI ideas",
    "6. Slice and order",
    "7. Write tickets",
    "8. Hand off",
  ]);

  const ask = section(brainstormPlaybook, "3. Ask");
  expect(ask).toContain("one question at a time");
  expect(ask).toContain("`grilling` skill in rounds");

  const ticketFormat = section(brainstormPlaybook, "Ticket format");
  expect(ticketFormat).toContain("acceptance_criteria");
  expect(ticketFormat).toContain("Problem, Change, Acceptance criteria");

  expect(brainstormPlaybook).toContain("ASD-STE100");

  const uiIdeas = section(brainstormPlaybook, "UI ideas");
  expect(uiIdeas).toMatch(/Dispatch 3 parallel agents/);
  expect(uiIdeas).toMatch(/variant-<letter>\.html/);
  expect(uiIdeas).toMatch(/docs\/design\/<topic>\//);
});

test("ARK-182-AC3 no tracked repo file points to the personal skill", () => {
  // The name is built here so that this file does not match its own search.
  const personalSkillName = ["ark", "brainstorm"].join("-");
  const search = Bun.spawnSync(["git", "grep", "-l", "--fixed-strings", personalSkillName], {
    cwd: repositoryRoot,
  });
  expect(search.stderr.toString()).toBe("");
  expect(search.stdout.toString()).toBe("");
  expect(search.exitCode).toBe(1);
});

test("ARK-182-AC4 the brainstorm playbook writes proposed tickets with a README row and graph node, and forbids ready, queueing and sending to Master Chief", () => {
  const rules = section(brainstormPlaybook, "Rules");
  expect(rules).toContain("always `proposed`");
  expect(rules).toContain("Never write `ready`.");
  expect(rules).toContain("Never queue a ticket.");
  expect(rules).toContain("Never run an `orca orchestration` command.");
  expect(rules).toContain("Never send anything to Master Chief's terminal.");

  const writeTickets = section(brainstormPlaybook, "7. Write tickets");
  expect(writeTickets).toMatch(/table row, with status `proposed`/);
  expect(writeTickets).toMatch(/Mermaid node, and the edges for its `depends_on`/);

  expect(section(brainstormPlaybook, "Ticket format")).toContain("`status: proposed`");
});
