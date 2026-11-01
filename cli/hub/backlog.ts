import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listProjects, projectDirectory } from "../paths.ts";

export type Ticket = {
  project: string;
  id: string;
  /** Null when the file cannot be read. */
  title: string | null;
  /** `unreadable` when the file cannot be read or has no `id` and `title`. It is never guessed. */
  status: string;
  milestone: string | null;
  depends_on: string[];
  file: string;
  error?: string;
};

export type TicketFile = Ticket & { body: string };

/** Every ticket file of every project, read fresh. A file that fails to read or parse shows as unreadable and hides no other ticket. */
export function readTicketFiles(): TicketFile[] {
  const found: TicketFile[] = [];
  for (const project of listProjects()) {
    const ticketsRoot = join(projectDirectory(project), "tickets");
    if (!existsSync(ticketsRoot)) continue;
    for (const name of readdirSync(ticketsRoot).sort()) {
      if (!name.endsWith(".md")) continue;
      const file = join(ticketsRoot, name);
      const unreadable = (error: string): TicketFile => ({
        project,
        id: name.replace(/\.md$/, ""),
        title: null,
        status: "unreadable",
        milestone: null,
        depends_on: [],
        file,
        error,
        body: "",
      });
      try {
        const text = readFileSync(file, "utf8");
        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        if (!match) {
          found.push(unreadable("no frontmatter"));
          continue;
        }
        const fields = Bun.YAML.parse(match[1]) as Record<string, unknown> | null;
        if (!fields || typeof fields.id !== "string" || typeof fields.title !== "string") {
          found.push(unreadable("frontmatter has no id and title"));
          continue;
        }
        found.push({
          project,
          id: fields.id,
          title: fields.title,
          status: typeof fields.status === "string" ? fields.status : "unknown",
          milestone: typeof fields.milestone === "string" ? fields.milestone : null,
          depends_on: Array.isArray(fields.depends_on) ? fields.depends_on.map(String) : [],
          file,
          body: match[2],
        });
      } catch (err) {
        found.push(unreadable((err as Error).message));
      }
    }
  }
  return found;
}

export type BacklogAnswer = { tickets: Ticket[] };

/** The Backlog API: each project's tickets from their files. The README table is not read. */
export function readBacklog(): BacklogAnswer {
  return { tickets: readTicketFiles().map(({ body: _body, ...ticket }) => ticket) };
}
