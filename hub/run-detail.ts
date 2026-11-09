import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { ArkEvent } from "../cli/events.ts";
import { isInside } from "../cli/paths.ts";
import type { TimelineEntry } from "./types.ts";

/**
 * Every line of `events.ndjson` that parses, in order. A line that does not (a half line the
 * writer has not finished, or a damaged one) is skipped: the run still shows, and the timeline
 * and the run state both ignore that line.
 */
export function readEventsLeniently(runDirectory: string): ArkEvent[] {
  const file = join(runDirectory, "events.ndjson");
  if (!existsSync(file)) return [];
  const events: ArkEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line) as ArkEvent;
      if (typeof event?.type === "string" && typeof event.time === "string") events.push(event);
    } catch {
      // skipped on purpose
    }
  }
  return events;
}

const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
const plural = (amount: number, word: string) => `${amount} ${word}${amount === 1 ? "" : "s"}`;

type Describe = (data: Record<string, any>) => Pick<TimelineEntry, "why" | "counts" | "url">;
/** One rule for "criterion passes", for the timeline counts and the closed band: passing, or a manual criterion answered ok. */
export const isProved = (status: string) => status === "passing" || status === "manual ok";
const plain = (why: string) => ({ why, counts: null, url: null });

/** The events that are decisions, and the sentence for each: the payload fields are those the `cli/` writers record. */
const describers: Record<string, Describe> = {
  "gate.answered": (data) =>
    plain(
      `${data.gate} gate: ${data.answer}${data.by ? ` by ${data.by}` : ""}${data.note ? ` (${data.note})` : ""}`,
    ),
  "strategy.recorded": (data) =>
    plain(
      `${plural(Number(data.count ?? count(data.cards)), "card")}, recommended ${data.recommended}`,
    ),
  "plan.checked": (data) =>
    plain(
      `${data.valid ? "ok" : `invalid, ${plural(count(data.problems), "problem")}`} · ${plural(count(data.steps), "step")}`,
    ),
  "evaluation.recorded": (data) =>
    plain(
      `${plural(count(data.blockers), "blocker")}, ${plural(count(data.risks), "risk")}, surface ${(data.surfaces ?? []).join(", ") || "none"}`,
    ),
  "escalation.requested": (data) => plain(String(data.reason ?? "")),
  "test.completed": (data) => {
    const statuses = Object.values<string>(data.criteria ?? {});
    const counts = {
      // A manual criterion counts as proved at `manual ok`, as failing at `manual problem`, else as missing.
      pass: statuses.filter(isProved).length,
      fail: statuses.filter((status) => status === "failing" || status === "manual problem").length,
      missing: statuses.filter((status) => status === "missing" || status === "manual pending")
        .length,
      notRun: statuses.filter((status) => status === "not run").length,
    };
    // An event with no mode is an old full run.
    const quick = data.mode === "quick";
    return {
      why: `${data.passed ? "passed" : "failed"}${quick ? " (quick, not a gate)" : ""}`,
      counts,
      url: null,
    };
  },
  "merge_request.opened": (data) => ({
    why: `${data.repo} !${data.number} opened`,
    counts: null,
    url: typeof data.url === "string" ? data.url : null,
  }),
  "run.closed": (data) => plain(String(data.outcome ?? "")),
};

/** The decisions of a run, oldest first. Every other event type (step, worktree, criteria) is left out. */
export function timelineOf(events: ArkEvent[]): TimelineEntry[] {
  return events
    .filter((event) => event.type in describers)
    .map((event) => ({
      time: event.time,
      type: event.type,
      ...describers[event.type](event.data ?? {}),
    }));
}

/** Documents at the top of a run folder, in reading order, then the folders whose direct files are shown. */
const documents = ["ticket.md", "evaluation.md", "strategies.md", "plan.md", "retro.md"];
const folders = ["findings", "results"];
const shownPattern = /^(findings|results)\/[^/]+$/;

/**
 * The absolute path of a run file the page may show, or null. The relative path is checked as text
 * first (no `..`, `.`, empty or backslash segment, no NUL), so it is rejected before any join. Then
 * the real path, with symlinks resolved, must lie inside the real run folder and name a regular file.
 */
export function resolveRunFile(runDirectory: string, relative: string): string | null {
  if (relative.includes("\0") || relative.includes("\\")) return null;
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return null;
  if (!documents.includes(relative) && !shownPattern.test(relative)) return null;
  try {
    const real = realpathSync(join(runDirectory, relative));
    if (!isInside(real, realpathSync(runDirectory)) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** Image types the image route serves, by file extension. Never SVG: it can carry script. */
const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const imageLimitBytes = 10 << 20;

/** The image type that the first bytes of a file prove, or null. */
function imageTypeOfBytes(head: Uint8Array): string | null {
  const startsWith = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (
    startsWith(0x47, 0x49, 0x46, 0x38) &&
    (head[4] === 0x37 || head[4] === 0x39) &&
    head[5] === 0x61
  )
    return "image/gif";
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  )
    return "image/webp";
  return null;
}

/**
 * The real path and content type of an image under `results/evidence/` of the run, or null. The text
 * of the path is checked first (no `..`, `.`, empty or backslash segment, no NUL), before any join.
 * Then the extension must be an image type, the real path (symlinks resolved) must lie inside the real
 * run folder and name a regular file, and the first bytes must prove the type the extension names:
 * a text file called `x.png` is not served.
 */
export function resolveEvidenceImage(
  runDirectory: string,
  relative: string,
): { real: string; type: string } | null {
  if (relative.includes("\0") || relative.includes("\\")) return null;
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return null;
  if (segments.length < 3 || segments[0] !== "results" || segments[1] !== "evidence") return null;
  const extension = segments.at(-1)!.split(".").pop()!.toLowerCase();
  const declared = imageTypes[extension];
  if (declared === undefined) return null;
  try {
    const real = realpathSync(join(runDirectory, relative));
    const stat = statSync(real);
    if (
      !isInside(real, realpathSync(runDirectory)) ||
      !stat.isFile() ||
      stat.size > imageLimitBytes
    )
      return null;
    const descriptor = openSync(real, "r");
    const head = new Uint8Array(12);
    try {
      readSync(descriptor, head, 0, 12, 0);
    } finally {
      closeSync(descriptor);
    }
    return imageTypeOfBytes(head) === declared ? { real, type: declared } : null;
  } catch {
    return null;
  }
}

/** The run files that exist and resolve inside the run folder, in reading order. */
export function listRunFiles(runDirectory: string): string[] {
  const found: string[] = [];
  for (const name of documents) if (resolveRunFile(runDirectory, name)) found.push(name);
  for (const folder of folders) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(runDirectory, folder)).sort();
    } catch {
      // no folder, no files
    }
    for (const entry of entries)
      if (resolveRunFile(runDirectory, `${folder}/${entry}`)) found.push(`${folder}/${entry}`);
  }
  return found;
}
