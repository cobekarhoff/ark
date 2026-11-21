/// <reference lib="webworker" />
import { type OrcaJob, readDirectoryPass, readOrcaPass } from "./sources.ts";

/**
 * One Orca job in a thread of its own (ARK-606): the Orca reads, and the parse and map of their answers, held the hub's loop for over 200 ms
 * on a large Orca. A `pass` answers with the agents and waits as entries, a `directory` with the directory and the closed runs it read;
 * either answers null when the read failed or threw (`read()` and `readConversation` treat both as a failed read).
 */
self.onmessage = async (event: MessageEvent<OrcaJob>) => {
  try {
    const job = event.data;
    if (job.kind === "pass") {
      const value = await readOrcaPass(job.openRuns);
      postMessage(value && { agents: [...value.agents], waits: [...value.waits] });
      return;
    }
    const closed = new Map(job.closed);
    const directory = await readDirectoryPass(job.arkRuns, new Set(job.seen), closed);
    const known = new Set(job.closed.map(([arkRun]) => arkRun));
    postMessage(
      directory && { directory, closed: [...closed].filter(([arkRun]) => !known.has(arkRun)) },
    );
  } catch {
    postMessage(null);
  }
};
