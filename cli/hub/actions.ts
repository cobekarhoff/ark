import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRun, listProjects, projectDirectory } from "../paths.ts";
import { exec } from "./exec.ts";

const idPattern = /^[\w.-]+$/;
const handlePattern = /^term_[\w-]+$/;

type Params = Record<string, unknown>;

/** The file a `plannotator-annotate` action opens. The page names a run or ticket, never a path. */
function annotateTarget(params: Params): string {
  const { kind, run, project, ticket } = params;
  if (kind === "plan" || kind === "strategy" || kind === "retro") {
    if (typeof run !== "string" || !idPattern.test(run)) throw new Error("bad run");
    const file = { plan: "plan.md", strategy: "strategies.md", retro: "retro.md" }[kind];
    return join(findRun(run).directory, file);
  }
  if (kind === "ticket") {
    if (typeof project !== "string" || !listProjects().includes(project))
      throw new Error("bad project");
    if (typeof ticket !== "string" || !idPattern.test(ticket)) throw new Error("bad ticket");
    return join(projectDirectory(project), "tickets", `${ticket}.md`);
  }
  throw new Error("bad kind");
}

const opener = process.platform === "darwin" ? "open" : "xdg-open";

/**
 * The fixed list. Each action builds one command from validated params and nothing else.
 * Actions only navigate: they open a terminal tab, a review, the Inbox or an MR page.
 */
const actions: Record<string, (params: Params, urls: Set<string>) => string[]> = {
  "orca-terminal-switch": ({ handle }) => {
    if (typeof handle !== "string" || !handlePattern.test(handle)) throw new Error("bad handle");
    return ["orca", "terminal", "switch", "--terminal", handle];
  },
  "plannotator-session": ({ index }) => {
    if (!Number.isInteger(index) || (index as number) < 1) throw new Error("bad index");
    return ["plannotator", "sessions", "--open", String(index)];
  },
  "plannotator-annotate": (params) => {
    const target = annotateTarget(params);
    if (!existsSync(target)) throw new Error("file not found");
    return ["plannotator", "annotate", target];
  },
  "plannotator-inbox": () => ["plannotator", "inbox", "--open"],
  "open-url": ({ url }, urls) => {
    if (typeof url !== "string" || !urls.has(url)) throw new Error("unknown url");
    return [opener, url];
  },
};

/** A browser page on another origin must not drive the hub. Requests with no Origin (curl, tests) pass. */
export function isLocalRequest(request: Request, port: number): boolean {
  const local = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  return (
    (origin === null || local.some((authority) => origin === `http://${authority}`)) &&
    (host === null || local.includes(host))
  );
}

/** Runs one action. Returns the HTTP status and a message; an unknown action or bad param runs nothing. */
export async function runAction(
  name: string,
  params: Params,
  urls: Set<string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const build = Object.hasOwn(actions, name) ? actions[name] : undefined;
  if (!build) return { status: 404, body: { error: `unknown action: ${name}` } };
  let command: string[];
  try {
    command = build(params, urls);
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
  if (name === "plannotator-annotate") {
    Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
    return { status: 200, body: { ok: true } };
  }
  const output = await exec(command, 5000);
  return output === null
    ? { status: 502, body: { error: `${command[0]} failed or timed out` } }
    : { status: 200, body: { ok: true } };
}
