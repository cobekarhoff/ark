import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { arkHome } from "../paths.ts";
import { exec } from "./exec.ts";
import { kindLabels, type Item, type Source } from "./types.ts";

/** What a notification keeps of its item. The item itself may be gone later. */
export type NotifiedItem = Pick<Item, "kind" | "project" | "title">;
export type Notification = { id: string; time: string; item: NotifiedItem; acted: boolean };

const hubDirectory = () => join(arkHome(), "hub");
const historyFile = () => join(hubDirectory(), "notifications.ndjson");

function append(record: Record<string, unknown>): void {
  mkdirSync(hubDirectory(), { recursive: true });
  appendFileSync(historyFile(), `${JSON.stringify(record)}\n`);
}

/**
 * The history, newest first. A line with `item` is a notification; a line with `acted` marks the
 * notification of that ID as acted on. A damaged line is skipped.
 */
export function readNotifications(): Notification[] {
  let text: string;
  try {
    text = readFileSync(historyFile(), "utf8");
  } catch {
    return [];
  }
  const notifications = new Map<string, Notification>();
  for (const line of text.split("\n")) {
    try {
      const record = JSON.parse(line);
      if (record.item) notifications.set(record.id, { ...record, acted: false });
      else if (notifications.has(record.acted)) notifications.get(record.acted)!.acted = true;
    } catch {
      continue;
    }
  }
  return [...notifications.values()].sort((left, right) => right.time.localeCompare(left.time));
}

/** Records that the human opened the hub from the notification of `id`. Unknown or acted IDs change nothing. */
export function markActed(id: string): void {
  if (readNotifications().some((notification) => notification.id === id && !notification.acted))
    append({ acted: id, time: new Date().toISOString() });
}

/**
 * Sends one notification for each Needs-me item that appears after start. Each source has its own
 * baseline, taken from its first successful read, so items that exist at start, or that a slow
 * source reports late, stay quiet. An ID is never notified twice, even if its item goes and returns.
 * The record is stored before the notifier runs: a crash between the two loses one notification
 * and never doubles one.
 */
export function createNotifier(getPort: () => number) {
  const seen = new Set<string>();
  const baselined = new Set<Source>();

  return {
    poll(items: Item[], ready: Record<Source, boolean>): void {
      for (const source of Object.keys(ready) as Source[]) {
        if (!ready[source]) continue;
        const fresh = items.filter((item) => item.source === source && !seen.has(item.id));
        for (const item of fresh) seen.add(item.id);
        if (baselined.has(source)) for (const item of fresh) void send(item);
        baselined.add(source);
      }
    },
  };

  async function send(item: Item): Promise<void> {
    const time = new Date().toISOString();
    try {
      append({
        id: item.id,
        time,
        item: { kind: item.kind, project: item.project, title: item.title },
      });
    } catch (error) {
      console.error(`hub: cannot store notification ${item.id}: ${String(error)}`);
      return;
    }
    const notifier = process.env.ARK_NOTIFIER || "terminal-notifier";
    const url = `http://127.0.0.1:${getPort()}/#item=${item.id}`;
    const output = await exec([
      notifier,
      "-title",
      `Ark: ${kindLabels[item.kind]}`,
      "-message",
      `${item.title} · ${item.project}`,
      "-open",
      url,
    ]);
    if (output === null) console.error(`hub: ${notifier} failed for ${item.id}`);
  }
}
