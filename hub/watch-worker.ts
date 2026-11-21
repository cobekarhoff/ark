/// <reference lib="webworker" />
import { watch, type FSWatcher } from "node:fs";

/**
 * The folder watchers of the Ark reader in a thread of their own (ARK-613): one `watch()` costs 5 to 8 ms of native time, so the
 * first pass over a home of 1,600 run folders held the hub's loop for 100 ms or more in every batch of 16. A message is the full list
 * of wanted folders: the worker closes the others, opens the new ones and answers `synced`. A change in any folder answers `change`.
 */
const watchers = new Map<string, FSWatcher>();

self.onmessage = (event: MessageEvent<string[]>) => {
  try {
    const wanted = new Set(event.data);
    for (const [path, watcher] of watchers) {
      if (wanted.has(path)) continue;
      watcher.close();
      watchers.delete(path);
    }
    for (const path of wanted) {
      if (watchers.has(path)) continue;
      try {
        watchers.set(
          path,
          watch(path, () => postMessage("change")),
        );
      } catch {
        // No watcher for this folder: the 2 s timer still sees its changes.
      }
    }
  } finally {
    postMessage("synced");
  }
};
