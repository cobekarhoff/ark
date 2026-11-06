import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { evidenceFile, runCriteria } from "../cli/criteria.ts";
import { isCaseId } from "../cli/criterion-id.ts";
import { exec } from "../cli/exec.ts";
import { evidenceProblem } from "../cli/merge-request.ts";
import { projectDirectory } from "../cli/paths.ts";
import { isInside } from "../cli/usage/index.ts";
import { resolveEvidenceImage } from "./run-detail.ts";
import type {
  CaseRef,
  CaseResult,
  CaseVersion,
  Checkpoint,
  CommandRun,
  AcEvidence,
  EvidenceSection,
  PlanCaseEvidence,
  RunTestEvidence,
  SideEvidence,
  TestCaseRecord,
  TicketCases,
  TicketView,
} from "./types.ts";

const planActions = ["add", "update", "reuse", "retire"];
const gitTimeoutMilliseconds = 2000;
/** Versions of a case come from its newest commits only: the bound that keeps the read inside the request budget. */
const versionCommitLimit = 50;
const evidenceFileLimitBytes = 256 << 10;
const outputLimitChars = 20_000;
const imageName = /^(.+)\.(png|jpe?g|gif|webp)$/i;
const imageInText = /[^\s`'"()<>[\]]+\.(?:png|jpe?g|gif|webp)\b/gi;
const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/;

/** A front-matter value as text; "" when the key is missing or not text or a number. */
const field = (front: Record<string, unknown>, key: string): string =>
  typeof front[key] === "string" || typeof front[key] === "number" ? String(front[key]).trim() : "";

function frontOf(source: string): Record<string, unknown> | null {
  const match = source.match(frontMatter);
  if (!match) return null;
  try {
    const front = Bun.YAML.parse(match[1]);
    return front && typeof front === "object" ? (front as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `test_case_source` and the repo folders of a project's `ark.yml`; no repo folder when the file does not say. */
function settingsOf(project: string): { source: "local" | "zephyr"; roots: string[] } {
  try {
    const fields = Bun.YAML.parse(
      readFileSync(join(projectDirectory(project), "ark.yml"), "utf8"),
    ) as Record<string, unknown> | null;
    const workspace = typeof fields?.workspace === "string" ? fields.workspace : null;
    const repos =
      fields?.repos && typeof fields.repos === "object" ? Object.keys(fields.repos) : [];
    return {
      source: fields?.test_case_source === "zephyr" ? "zephyr" : "local",
      roots:
        workspace === null
          ? []
          : [...new Set([".", ...repos])].map((repo) => join(workspace, repo)),
    };
  } catch {
    return { source: "local", roots: [] };
  }
}

/** Every AC of the project that lists a case in `verified_by`, by case id. Memory only. */
function verifiersOf(tickets: TicketView[], project: string): Map<string, CaseRef[]> {
  const verifiers = new Map<string, CaseRef[]>();
  for (const ticket of tickets) {
    if (ticket.project !== project) continue;
    for (const criterion of ticket.document?.criteria ?? [])
      for (const id of criterion.verified_by)
        verifiers.set(id, [
          ...(verifiers.get(id) ?? []),
          { ticket: ticket.id, criterion: criterion.id },
        ]);
  }
  return verifiers;
}

/**
 * The commits of each case file with the `changed_by` the file had there, newest first. Two git
 * calls for the repo, whatever the number of cases. Null when git fails (not a git repo, no commit
 * yet, or too slow): the caller then reads the cases as missing.
 */
async function versionsOf(root: string, ids: string[]): Promise<Map<string, CaseVersion[]> | null> {
  const files = ids.map((id) => `test/cases/${id}.md`);
  const log = await exec(
    [
      "git",
      "-C",
      root,
      "log",
      "-n",
      String(versionCommitLimit),
      "--name-only",
      "--format=%x00%h %cI",
      "--",
      ...files,
    ],
    gitTimeoutMilliseconds,
  );
  if (log === null) return null;
  const commits: { commit: string; time: string; file: string }[] = [];
  for (const chunk of log.split("\0").slice(1)) {
    const [header, ...names] = chunk.split("\n");
    const [commit, time] = header.split(" ");
    for (const file of names.filter((name) => files.includes(name)))
      commits.push({ commit, time, file });
  }
  const versions = new Map<string, CaseVersion[]>(ids.map((id) => [id, []]));
  if (commits.length === 0) return versions;
  const child = Bun.spawn(["git", "-C", root, "cat-file", "--batch"], {
    stdin: new TextEncoder().encode(
      commits.map((entry) => `${entry.commit}:${entry.file}\n`).join(""),
    ),
    stdout: "pipe",
    stderr: "ignore",
    timeout: gitTimeoutMilliseconds,
  });
  const output = Buffer.from(await new Response(child.stdout).arrayBuffer());
  let at = 0;
  for (const { commit, time, file } of commits) {
    const end = output.indexOf("\n", at);
    if (end < 0) break;
    const size = Number(output.subarray(at, end).toString().split(" ")[2]);
    at = end + 1;
    if (!Number.isFinite(size)) continue; // `<spec> missing`: the commit deleted the file
    const front = frontOf(output.subarray(at, at + size).toString());
    at += size + 1;
    versions.get(file.slice("test/cases/".length, -".md".length))!.push({
      commit,
      time,
      changed_by: front ? field(front, "changed_by") : "",
    });
  }
  return versions;
}

function readLocalCase(
  roots: string[],
  id: string,
): { root: string; front: Record<string, unknown> } | null {
  if (!isCaseId(id)) return null;
  for (const root of roots) {
    try {
      const front = frontOf(readFileSync(join(root, "test", "cases", `${id}.md`), "utf8"));
      if (front) return { root, front };
    } catch {
      // not in this repo
    }
  }
  return null;
}

/** Text of a file under the run folder, cut at `limit` bytes; null when it is missing, a directory, or a symlink that leaves the folder. */
function readInside(
  directory: string,
  relative: string,
  limit = evidenceFileLimitBytes,
): string | null {
  try {
    const real = realpathSync(join(directory, relative));
    if (!isInside(real, realpathSync(directory)) || !statSync(real).isFile()) return null;
    return readFileSync(real).subarray(0, limit).toString();
  } catch {
    return null;
  }
}

/**
 * The test cases that the criteria of a ticket name in `verified_by`, in the order they first
 * appear. `local`: the case files of the project's repos, with versions from git. `zephyr`: only
 * what `result.json` of the ticket's newest run records. No Zephyr call. A case with no file or
 * evidence reads `missing`. Null for a ticket the hub does not know.
 */
export async function readTicketCases(
  project: string,
  ticketId: string,
  tickets: TicketView[],
  newestRunDirectory: string | null,
): Promise<TicketCases | null> {
  const ticket = tickets.find((entry) => entry.project === project && entry.id === ticketId);
  if (!ticket) return null;
  const ids = [
    ...new Set((ticket.document?.criteria ?? []).flatMap((criterion) => criterion.verified_by)),
  ];
  const { source, roots } = settingsOf(project);
  const verifiers = verifiersOf(tickets, project);
  const verifies = (id: string) => verifiers.get(id) ?? [];

  if (source === "zephyr") {
    const cases = ids.map((id): TestCaseRecord => {
      for (const side of ["head", "base"]) {
        const text =
          newestRunDirectory && isCaseId(id)
            ? readInside(newestRunDirectory, `results/evidence/${id}/${side}/result.json`)
            : null;
        let result: Record<string, unknown> | null = null;
        try {
          result = text === null ? null : JSON.parse(text);
        } catch {
          // damaged file: the other side, else missing
        }
        if (!result || typeof result !== "object") continue;
        return {
          id,
          name: field(result, "name"),
          status: field(result, "status"),
          sha: field(result, "sha"),
          ...(result.version === undefined ||
          result.version === null ||
          typeof result.version === "object"
            ? {}
            : { version: result.version as string | number }),
          verifies: verifies(id),
        };
      }
      return { id, missing: true };
    });
    return { source, cases };
  }

  const found = new Map(ids.map((id) => [id, readLocalCase(roots, id)]));
  const idsByRoot = new Map<string, string[]>();
  for (const [id, entry] of found)
    if (entry) idsByRoot.set(entry.root, [...(idsByRoot.get(entry.root) ?? []), id]);
  const versionsByRoot = new Map(
    await Promise.all(
      [...idsByRoot].map(
        async ([root, rootIds]) => [root, await versionsOf(root, rootIds)] as const,
      ),
    ),
  );
  const cases = ids.map((id): TestCaseRecord => {
    const entry = found.get(id);
    const versions = entry ? versionsByRoot.get(entry.root)?.get(id) : undefined;
    // A repo that is not a git repo (git failed) degrades to `missing`, never to an error.
    if (!entry || !versions) return { id, missing: true };
    const { front } = entry;
    const status = field(front, "status");
    return {
      id,
      title: field(front, "title"),
      level: field(front, "level"),
      technique: field(front, "technique"),
      priority: field(front, "priority"),
      risk: field(front, "risk"),
      status,
      ...(status === "retired" ? { reason: field(front, "retired_reason") } : {}),
      changed_by: field(front, "changed_by"),
      versions,
      verifies: verifies(id),
    };
  });
  return { source, cases };
}

/** The commands of a `command.log`: blocks of `<command>`, the output, and a line `exit <n>`. */
function parseCommandLog(log: string): CommandRun[] {
  const runs: CommandRun[] = [];
  let lines: string[] = [];
  const finish = (exit: number | null) => {
    const [command = "", ...output] = lines;
    const text = output.join("\n");
    runs.push({
      command,
      output: text.length > outputLimitChars ? `${text.slice(0, outputLimitChars)}\n… cut` : text,
      exit,
    });
    lines = [];
  };
  for (const line of log.split("\n")) {
    const exit = line.match(/^exit (-?\d+)$/);
    if (exit) finish(Number(exit[1]));
    else lines.push(line);
  }
  if (lines.some((line) => line !== "")) finish(null);
  return runs;
}

function readSide(
  directory: string,
  id: string,
  side: "base" | "head",
  withLog: boolean,
): SideEvidence {
  const folder = `results/evidence/${id}/${side}`;
  const text = isCaseId(id) ? readInside(directory, `${folder}/result.json`) : null;
  let result: Record<string, unknown> | null = null;
  try {
    result = text === null ? null : JSON.parse(text);
  } catch {
    // damaged result.json reads as not run
  }
  if (!result || typeof result !== "object") return { result: "not run", sha: null, runs: [] };
  const status = field(result, "status").toLowerCase();
  const outcome: CaseResult =
    status === "passed" || status === "pass"
      ? "pass"
      : status === "failed" || status === "fail"
        ? "fail"
        : "not run";
  const log = withLog ? readInside(directory, `${folder}/command.log`) : null;
  return {
    result: outcome,
    sha: field(result, "sha") || null,
    runs: log ? parseCommandLog(log) : [],
  };
}

/** The screenshot checkpoints of a case, oldest file first: `base` is before, `head` is after. Only images the image route would serve. */
function checkpointsOf(directory: string, id: string): Checkpoint[] {
  if (!isCaseId(id)) return [];
  const byName = new Map<string, Checkpoint & { time: number }>();
  for (const side of ["base", "head"] as const) {
    const folder = `results/evidence/${id}/${side}/screenshots`;
    let names: string[] = [];
    try {
      names = readdirSync(join(directory, folder));
    } catch {
      continue;
    }
    for (const file of names) {
      const name = file.match(imageName)?.[1];
      const image =
        name === undefined ? null : resolveEvidenceImage(directory, `${folder}/${file}`);
      if (name === undefined || image === null) continue;
      const entry = byName.get(name) ?? { name, before: null, after: null, time: Infinity };
      entry[side === "base" ? "before" : "after"] = `${folder}/${file}`;
      entry.time = Math.min(entry.time, statSync(image.real).mtimeMs);
      byName.set(name, entry);
    }
  }
  return [...byName.values()]
    .sort((a, b) => a.time - b.time || a.name.localeCompare(b.name))
    .map(({ name, before, after }) => ({ name, before, after }));
}

/** The sections of an evidence file as a tree by heading level, with the images that a section's lines name. */
function sectionsOf(directory: string, text: string): EvidenceSection[] {
  type Node = { level: number; title: string; lines: string[]; children: Node[] };
  const root: Node = { level: 0, title: "", lines: [], children: [] };
  const stack = [root];
  for (const line of text.split("\n")) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!heading) {
      stack.at(-1)!.lines.push(line);
      continue;
    }
    const node: Node = { level: heading[1].length, title: heading[2], lines: [], children: [] };
    while (stack.at(-1)!.level >= node.level) stack.pop();
    stack.at(-1)!.children.push(node);
    stack.push(node);
  }
  const convert = (node: Node): EvidenceSection => {
    const images: string[] = [];
    for (const path of node.lines.join("\n").match(imageInText) ?? []) {
      const relative = path.replace(/^\.\//, "");
      const shown = [relative, `results/evidence/${relative}`].find((candidate) =>
        resolveEvidenceImage(directory, candidate),
      );
      if (shown !== undefined && !images.includes(shown)) images.push(shown);
    }
    return {
      title: node.title,
      text: node.lines.join("\n").trim(),
      images,
      children: node.children.map(convert),
    };
  };
  // A file that opens with one `# Title` heading shows its sections, not the title.
  const only = root.children.length === 1 && root.children[0].level === 1 ? root.children[0] : null;
  const top = convert(only ?? root);
  return [
    ...(top.text === "" ? [] : [{ ...top, title: only ? "" : top.title, children: [] }]),
    ...top.children,
  ];
}

/**
 * The test evidence of a run, read on request (any run, open or closed): one entry for each case
 * that the plan marks add, update, reuse or retire, and the evidence file of each non-test AC of
 * the ticket (null sections when the file is missing or has the wrong shape for its method).
 */
export function readRunEvidence(
  directory: string,
  project: string,
  ticketId: string,
  tickets: TicketView[],
): RunTestEvidence {
  const verifiers = verifiersOf(tickets, project);
  let planned: PlanCaseEvidence[] = [];
  try {
    // Read leniently, as the other hub readers do: a plan that `ark plan check` would refuse still shows its rows.
    const plan = Bun.YAML.parse(readFileSync(join(directory, "plan.yml"), "utf8")) as {
      test_cases?: unknown;
    } | null;
    const listed = Array.isArray(plan?.test_cases) ? plan.test_cases : [];
    planned = listed.flatMap((entry) => {
      const { id, action, level } = (entry ?? {}) as Record<string, unknown>;
      if (typeof id !== "string" || !planActions.includes(action as string)) return [];
      const planLevel = typeof level === "string" ? level : "";
      const withLog = planLevel === "integration" || planLevel === "cli";
      return [
        {
          id,
          action: action as string,
          level: planLevel,
          base: readSide(directory, id, "base", withLog),
          head: readSide(directory, id, "head", withLog),
          verifies: verifiers.get(id) ?? [],
          checkpoints: checkpointsOf(directory, id),
        },
      ];
    });
  } catch {
    // no plan, or one that does not parse: no rows
  }
  let criteria: AcEvidence[] = [];
  try {
    criteria = runCriteria(directory)
      .filter((criterion) => criterion.method !== "test")
      .map(({ id, method }) => {
        const local = id.split("/").pop()!;
        const text = existsSync(evidenceFile(directory, id))
          ? readInside(directory, `results/evidence/${local}.md`)
          : null;
        return {
          id: local,
          method,
          sections:
            text === null || evidenceProblem(method, text) !== undefined
              ? null
              : sectionsOf(directory, text),
        };
      });
  } catch {
    // a ticket.md that does not read: no evidence blocks
  }
  return { cases: planned, criteria };
}
