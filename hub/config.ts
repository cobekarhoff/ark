import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type ProjectConfig } from "../cli/config.ts";
import { projectDirectory } from "../cli/paths.ts";

const signatureFile = (project: string) => join(projectDirectory(project), "ark.yml");

const signatureOf = (file: string): string | null => {
  try {
    const stats = statSync(file);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
};

const loaded = new Map<string, { signature: string | null; result: ProjectConfig | Error }>();

/**
 * `loadConfig` for the hub's periodic reads. `loadConfig` also walks the project workspace for repos
 * (`discoverRepos`, with a `git` call in each repo that has submodules), which on a big workspace holds the
 * event loop for as long as the walk takes (ARK-533). So the read keeps the result and never reads a file:
 * `primeHubConfig` (async, in a worker thread) loads it again when `ark.yml` changed (size and mtime), and
 * the Ark read calls it for each project before `compose()` asks. A failure is kept and thrown again. Only a
 * project that was never primed loads here, in the loop.
 * ponytail: a repo added to the workspace without an `ark.yml` change shows at the next hub start; key the walk too if that matters.
 */
export function hubConfig(project: string): ProjectConfig {
  let known = loaded.get(project);
  if (!known) {
    let result: ProjectConfig | Error;
    try {
      result = loadConfig(project);
    } catch (error) {
      result = error as Error;
    }
    known = { signature: signatureOf(signatureFile(project)), result };
    loaded.set(project, known);
  }
  if (known.result instanceof Error) throw known.result;
  return known.result;
}

/** Loads the project's config in a worker thread when `ark.yml` is new or changed; the next `hubConfig` answers from memory. */
export async function primeHubConfig(project: string): Promise<void> {
  let signature: string | null = null;
  try {
    const stats = await stat(signatureFile(project));
    signature = `${stats.size}:${stats.mtimeMs}`;
  } catch {
    // No ark.yml: the load fails the way `loadConfig` fails.
  }
  const known = loaded.get(project);
  if (known && known.signature === signature) return;
  const worker = new Worker(new URL("./config-worker.ts", import.meta.url));
  try {
    const reply = await new Promise<{ config?: ProjectConfig; error?: string }>(
      (resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage(project);
      },
    );
    loaded.set(project, {
      signature,
      result: reply.config ?? new Error(reply.error ?? "the config did not load"),
    });
  } catch {
    // The worker did not start: the first `hubConfig` loads it in the loop.
  } finally {
    worker.terminate();
  }
}
