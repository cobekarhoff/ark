/// <reference lib="webworker" />
import { readOrcaPass } from "./sources.ts";

/**
 * One `readOrca` pass in a thread of its own (ARK-606): the Orca reads, and the parse and map of their answers, held the hub's loop for over 200 ms
 * on a large Orca. It answers with the agents and waits as entries, or null when the pass failed or threw (`read()` treats both as a failed read).
 */
self.onmessage = async (event: MessageEvent<{ run: string; project: string }[]>) => {
  try {
    const value = await readOrcaPass(event.data);
    postMessage(value && { agents: [...value.agents], waits: [...value.waits] });
  } catch {
    postMessage(null);
  }
};
