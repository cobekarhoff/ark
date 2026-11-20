import { statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type ProjectConfig } from "../cli/config.ts";
import { projectDirectory } from "../cli/paths.ts";

const signatureOf = (file: string): string | null => {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
};

const loaded = new Map<string, { signature: string | null; result: ProjectConfig | Error }>();

/**
 * `loadConfig` for the hub's periodic reads. `loadConfig` also walks the project workspace for repos
 * (`discoverRepos`), which on a big workspace holds the event loop for as long as the walk takes, once
 * for each agent of each run on each publish (ARK-533). The result is kept until `ark.yml` changes
 * (size and mtime); a failure is kept and thrown again. ponytail: a repo added to the workspace
 * without an `ark.yml` change shows at the next hub start; key the walk too if that matters.
 */
export function hubConfig(project: string): ProjectConfig {
  const signature = signatureOf(join(projectDirectory(project), "ark.yml"));
  let known = loaded.get(project);
  if (!known || known.signature !== signature) {
    let result: ProjectConfig | Error;
    try {
      result = loadConfig(project);
    } catch (error) {
      result = error as Error;
    }
    known = { signature, result };
    loaded.set(project, known);
  }
  if (known.result instanceof Error) throw known.result;
  return known.result;
}
