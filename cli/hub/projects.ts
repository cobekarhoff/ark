import { resolve } from "node:path";
import { loadConfig, type ProjectConfig } from "../config.ts";
import { listProjects } from "../paths.ts";
import { findLiveChief, readTerminals } from "./orca.ts";

export type ProjectView = {
  name: string;
  /** Null when ark.yml cannot be read; `error` says why. */
  ticket_source: ProjectConfig["ticket_source"] | null;
  roles: Record<string, { harness: string; model: string }> | null;
  workspace: string | null;
  error?: string;
  /** `unknown` when Orca did not answer or the workspace is not known. It is never turned into `missing`. */
  chief:
    | { state: "live"; handle: string; harness: string | null; model: string | null }
    | { state: "missing" | "unknown" };
};

export type ProjectsAnswer = { projects: ProjectView[] };

/** The Projects API: ark.yml roles and models, ticket source and Master Chief state of each project. Read-only. */
export async function readProjects(): Promise<ProjectsAnswer> {
  const snapshot = await readTerminals();
  const projects = listProjects().map((name): ProjectView => {
    let config: ProjectConfig;
    try {
      config = loadConfig(name);
    } catch (err) {
      return {
        name,
        ticket_source: null,
        roles: null,
        workspace: null,
        error: (err as Error).message,
        chief: { state: "unknown" },
      };
    }
    const workspace = resolve(config.workspace);
    const terminal = snapshot ? findLiveChief(snapshot, name, workspace) : undefined;
    return {
      name,
      ticket_source: config.ticket_source,
      roles: config.roles,
      workspace,
      chief: !snapshot
        ? { state: "unknown" }
        : terminal
          ? {
              state: "live",
              handle: terminal.handle,
              harness: terminal.agentIdentity ?? null,
              model: terminal.model ?? null,
            }
          : { state: "missing" },
    };
  });
  return { projects };
}
