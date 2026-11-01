import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { findRun, listProjects, projectDirectory } from "../paths.ts";
import { readRuns } from "./ark.ts";
import { exec, execJson } from "./exec.ts";
import { findLiveChief, findRunLead, readTerminals } from "./orca.ts";
import { abortInstruction, instructions } from "./types.ts";

const idPattern = /^[\w.-]+$/;
const handlePattern = /^term_[\w-]+$/;

type Params = Record<string, unknown>;

/** The file a `plannotator-annotate` action opens. The page names a run or ticket, never a path. */
function annotateTarget(params: Params): string {
  const { kind, run, project, ticket } = params;
  if (kind === "plan" || kind === "strategy" || kind === "retro") {
    if (typeof run !== "string" || !idPattern.test(run)) throw new Error("bad run");
    const file = {
      plan: "plan.md",
      strategy: "strategies.md",
      retro: "retro.md",
    }[kind];
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

type Reply = { status: number; body: Record<string, unknown> };
const reply = (status: number, error: string): Reply => ({
  status,
  body: { error },
});
const ok: Reply = { status: 200, body: { ok: true } };
const sendTimeoutMilliseconds = 5000;

/** Free text for a terminal: one line, no control bytes, so it cannot press keys. */
function messageText(params: Params): string {
  const { text } = params;
  if (typeof text !== "string" || text.trim() === "" || text.length > 2000)
    throw new Error("text must be 1 to 2000 characters");
  if (/\p{Cc}/u.test(text)) throw new Error("text must be one line");
  return text;
}

function knownProject(params: Params): string {
  const { project } = params;
  if (typeof project !== "string" || !listProjects().includes(project))
    throw new Error("bad project");
  return project;
}

/** The workspace is where ark.yml says it is; Master Chief runs in it. */
const workspaceOf = (project: string) => resolve(loadConfig(project).workspace);

const send = async (handle: string, text: string): Promise<Reply> =>
  (await exec(
    ["orca", "terminal", "send", "--terminal", handle, "--text", text, "--enter", "--json"],
    sendTimeoutMilliseconds,
  )) === null
    ? reply(502, "orca terminal send failed or timed out")
    : ok;

/** Sends one line to the live Master Chief of a project. The server picks the handle; no live Master Chief means 409 and no send. */
async function toChief(project: string, text: string): Promise<Reply> {
  const snapshot = await readTerminals();
  if (!snapshot) return reply(502, "orca did not answer");
  const chief = findLiveChief(snapshot, project, workspaceOf(project));
  return chief
    ? send(chief.handle, text)
    : reply(409, `no live Master Chief for project ${project}`);
}

/** The open run named by the page. A closed or unknown run is a bad param. */
function openRun(params: Params): { run: string; project: string } {
  const { run } = params;
  if (typeof run !== "string" || !idPattern.test(run)) throw new Error("bad run");
  const found = readRuns().find(({ state }) => state.run === run && state.phase !== "closed");
  if (!found) throw new Error(`no open run ${run}`);
  return { run, project: found.state.project };
}

const steering: Record<string, (params: Params) => Promise<Reply>> = {
  "chief-message": (params) => toChief(knownProject(params), messageText(params)),
  "chief-instruction": (params) => {
    const project = knownProject(params);
    const { instruction, confirmed } = params;
    if (instruction === "abort") {
      const { run, project: owner } = openRun(params);
      if (owner !== project) throw new Error(`run ${run} is not in project ${project}`);
      if (confirmed !== true) throw new Error("abort needs confirmed: true");
      return toChief(project, abortInstruction(run));
    }
    if (typeof instruction !== "string" || !Object.hasOwn(instructions, instruction))
      throw new Error("bad instruction");
    return toChief(project, instructions[instruction as keyof typeof instructions]);
  },
  "run-lead-message": async (params) => {
    if (params.handle !== undefined) throw new Error("the page does not choose a terminal");
    const { run } = openRun(params);
    const text = messageText(params);
    const snapshot = await readTerminals();
    if (!snapshot) return reply(502, "orca did not answer");
    const lead = findRunLead(snapshot, run);
    return lead ? send(lead.handle, text) : reply(409, `no live run lead for run ${run}`);
  },
  "chief-spawn": async (params) => {
    const project = knownProject(params);
    const chief = loadConfig(project).roles.chief;
    if (!chief)
      throw new Error(
        `roles.chief (harness and model) is not set in ark.yml for project ${project}`,
      );
    for (const value of [chief.harness, chief.model])
      if (!/^[\w.:/@-]+$/.test(value))
        throw new Error("roles.chief has characters a shell would read");
    const snapshot = await readTerminals();
    if (!snapshot) return reply(502, "orca did not answer");
    const workspace = workspaceOf(project);
    if (findLiveChief(snapshot, project, workspace))
      return reply(409, `project ${project} already has a live Master Chief`);
    const created = await execJson<{
      result?: { terminal?: { handle?: string }; handle?: string };
    }>(
      [
        "orca",
        "terminal",
        "create",
        "--worktree",
        `path:${workspace}`,
        "--title",
        `Master Chief: ${project}`,
        "--command",
        `${chief.harness} --model ${chief.model} "/skill:ark chief"`,
        "--json",
      ],
      sendTimeoutMilliseconds,
    );
    const handle = created?.result?.terminal?.handle ?? created?.result?.handle;
    if (!handle || !handlePattern.test(handle)) return reply(502, "orca terminal create failed");
    return (await exec(
      ["orca", "terminal", "switch", "--terminal", handle],
      sendTimeoutMilliseconds,
    )) === null
      ? reply(502, "orca terminal switch failed")
      : ok;
  },
};

const opener = process.platform === "darwin" ? "open" : "xdg-open";

/**
 * The fixed list. Each action builds one command from validated params and nothing else.
 * These actions only navigate: they open a terminal tab, a review, the Inbox or an MR page.
 * The steering actions above type one fixed or validated line into a terminal the server picks.
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
  if (Object.hasOwn(steering, name)) {
    try {
      return await steering[name](params);
    } catch (err) {
      return reply(400, (err as Error).message);
    }
  }
  const build = Object.hasOwn(actions, name) ? actions[name] : undefined;
  if (!build) return { status: 404, body: { error: `unknown action: ${name}` } };
  let command: string[];
  try {
    command = build(params, urls);
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
  if (name === "plannotator-annotate") {
    Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
    return { status: 200, body: { ok: true } };
  }
  const output = await exec(command, 5000);
  return output === null
    ? { status: 502, body: { error: `${command[0]} failed or timed out` } }
    : { status: 200, body: { ok: true } };
}
