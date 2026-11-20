/// <reference lib="webworker" />
import { loadConfig } from "../cli/config.ts";

/**
 * `loadConfig` of one project in a thread of its own: it walks the project workspace and runs `git config` with
 * `spawnSync` in each repo that has a `.gitmodules`, which held the hub's loop for 200 ms on the first read (ARK-533).
 */
self.onmessage = (event: MessageEvent<string>) => {
  try {
    postMessage({ config: loadConfig(event.data) });
  } catch (error) {
    postMessage({ error: (error as Error).message });
  }
};
