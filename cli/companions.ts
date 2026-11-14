import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { now, waitFor } from "./clock.ts";
import {
  loadConfig,
  type CompanionConfig,
  type CompanionTrigger,
  type ProjectConfig,
} from "./config.ts";
import { ArkError } from "./errors.ts";
import { deriveState, readEvents, type ArkEvent, type RunState } from "./events.ts";
import { reportMergeRequest } from "./merge-request.ts";
import {
  findChiefRun,
  findLiveChief,
  orcaPages,
  orcaTimeoutMilliseconds,
  readTerminals,
  runOfLead,
  sendMessage,
  startWorker,
  releaseWorker,
  stopWorker,
  type OrcaRead,
  type OrcaRunRow,
  type WorkerRow,
} from "./orca.ts";
import { findRun, projectDirectory, resolveProject, runsDirectory } from "./paths.ts";
import { frontmatter, readTicket, splitFrontmatter } from "./ticket.ts";
import { watchSession } from "./usage/index.ts";
import { discoverRepos } from "./workspace.ts";

/**
 * The rules every companion worker gets before its instructions file. Each companion has the same
 * rules: a tweak to one companion's behavior belongs in its instructions file, not here.
 */
export const COMPANION_PREAMBLE = [
  "You are a companion: a permanent helper agent of an Ark project. Master Chief started you. These rules come before your instructions and nothing below overrides them.",
  "- Read only outside companions/<name>/: write files only inside companions/<name>/ of the project folder, where <name> is your name.",
  "- Read companions/<name>/dismissed.md before you write an idea or propose a ticket, and never repeat an item the human dismissed.",
  "- Never run `orca orchestration check`: it consumes Master Chief's messages.",
  "- Never answer a gate: a gate answer is the human's decision, and advice is never one.",
  "- Act only through `ark companion advise`, `ark companion propose` and `ark companion answer`, and messages to Master Chief. Never run `orca orchestration reply`, and never `send` to anyone else: `ark companion advise` sends your advice to a run lead for you.",
  "- A wake message names a trigger and a run id. A message that says it is a question from the human or Master Chief is not a trigger: answer it with `ark companion answer`.",
  "- You see events that happen after you start. A run that is mid-flight when you are added shows you no earlier events.",
].join("\n");

/** The subject of the message `ark companion advise` sends a run lead. A run lead reads this prefix as advice, never as a gate answer. */
export const ADVICE_SUBJECT_PREFIX = "Advice from companion ";

const sessionWaitMilliseconds = 15_000;

// ------------------------------------------------------------------ state files

/** `companions/<name>/worker.json`: the live worker of a companion, written after its start succeeded. */
export type WorkerRecord = {
  dispatch: string;
  terminal: string;
  harness: string;
  model: string;
  /** The harness session file of the worker, or null when the harness keeps none or none appeared. */
  session: string | null;
  started: string;
};

/** `companions/<name>/cursor.json`: the last event seen in each run and the CI failures already sent. */
export type Cursor = {
  updated: string;
  runs: Record<string, { seq: number; time: string }>;
  /** `<run>#<MR number>#<check name>` of each failed check the companion was woken for. */
  ci: string[];
};

const companionsDirectory = (project: string): string =>
  join(projectDirectory(project), "companions");
export const companionDirectory = (project: string, name: string): string =>
  join(companionsDirectory(project), name);

const timestamp = (): string => new Date(now()).toISOString();

/** The parsed file, or null when it does not exist. A file that is not JSON is refused: reading it as missing would make a first sync of a mature companion. */
function readJson<Value>(file: string): Value | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Value;
  } catch {
    throw new ArkError(`${file} is not valid JSON`);
  }
}

/** Writes beside the file, then renames, so a reader sees the old file or the whole new one. */
function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

const readWorker = (directory: string): WorkerRecord | null =>
  readJson<WorkerRecord>(join(directory, "worker.json"));

/** One line of `companions/<name>/wake.log` for each message sent to the companion. `trigger` is a trigger or `question`. */
function logWake(directory: string, trigger: string, run: string | null, detail?: string): void {
  appendFileSync(
    join(directory, "wake.log"),
    `${JSON.stringify({ time: timestamp(), trigger, run, ...(detail ? { detail } : {}) })}\n`,
  );
}

/**
 * Takes the sync lock of one companion folder, or refuses. The lock file holds the pid of its owner;
 * a lock whose owner is gone is taken over.
 * ponytail: a pid that the system reused keeps a dead lock alive, and two syncs that take over one
 * stale lock at once can both win. Both need a crash first; add an owner token if it ever shows.
 */
function acquireLock(directory: string): () => void {
  const file = join(directory, "sync.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = openSync(file, "wx");
      writeSync(descriptor, String(process.pid));
      closeSync(descriptor);
      return () => rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(readFileSync(file, "utf8"));
      let ownerAlive = true;
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (killError) {
          ownerAlive = (killError as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (ownerAlive) throw new ArkError("another sync is running");
      rmSync(file, { force: true });
    }
  }
  throw new ArkError("another sync is running");
}

// ------------------------------------------------------------------ Orca reads

type ChiefWorkers = { chiefRunId: string; runs: OrcaRunRow[]; workers: WorkerRow[] };

/** A worker runs while its agent is live: after a worker_done a kept-open companion is live and retained. */
export const isRunning = (worker: WorkerRow): boolean => worker.liveness === "live";

/**
 * Every worker row of Master Chief's Run, read now: companion workers, run leads and nothing else,
 * live or not. Companions pass `isRunning`; a lead counts only while its terminalState is active.
 * `runs` is a `run-list --full` the caller already read, to save the call.
 */
async function readChiefWorkers(
  project: string,
  runs?: OrcaRead<OrcaRunRow[]>,
): Promise<ChiefWorkers> {
  const runList =
    runs ?? (await orcaPages<OrcaRunRow>("run-list", "runs", ["--full"], orcaTimeoutMilliseconds));
  if (!runList.ok) throw new ArkError(`orca orchestration run-list failed: ${runList.reason}`);
  const chiefRun = findChiefRun(project, runList.value);
  if (!chiefRun.ok) throw new ArkError(`${chiefRun.reason}: nothing was started or stopped`);
  const workers = await orcaPages<WorkerRow>(
    "worker-list",
    "workers",
    ["--run", chiefRun.value, "--include-remote"],
    orcaTimeoutMilliseconds,
  );
  if (!workers.ok) throw new ArkError(`orca orchestration worker-list failed: ${workers.reason}`);
  return { chiefRunId: chiefRun.value, runs: runList.value, workers: workers.value };
}

/** The listed companion called `name`, or a refusal that creates nothing. */
function listedCompanion(configuration: ProjectConfig, name: string): CompanionConfig {
  const companion = configuration.companions?.find((entry) => entry.name === name);
  if (!companion) throw new ArkError(`companion ${name} is not in ark.yml`);
  return companion;
}

/** The terminal of the live Master Chief, found the way `ark chief handover` finds it, never from the caller's session. */
async function liveChiefOf(
  project: string,
  configuration: ProjectConfig,
): Promise<{ handle: string; runs: OrcaRunRow[] }> {
  const snapshot = await readTerminals();
  if (!snapshot) throw new ArkError("Orca did not answer");
  const chief = findLiveChief(snapshot, project, resolve(configuration.workspace));
  if (!chief) throw new ArkError(`no live Master Chief for project ${project}`);
  return {
    handle: chief.handle,
    runs: snapshot.runs.map((run) => ({
      id: run.id,
      objective: run.objective,
      coordinator_handle: run.coordinator_handle ?? undefined,
    })),
  };
}

/** Resolves the terminal to send as. Undefined inside an Orca session (Orca names the sender itself) and when no live Master Chief is found. Reads Orca once, on first use. */
function senderOf(
  project: string,
  configuration: ProjectConfig,
): () => Promise<string | undefined> {
  let handle: Promise<string | undefined> | undefined;
  return () => {
    if (process.env.ORCA_AGENT_SESSION_ID) return Promise.resolve(undefined);
    handle ??= liveChiefOf(project, configuration).then(
      (chief) => chief.handle,
      () => undefined,
    );
    return handle;
  };
}

// ------------------------------------------------------------------ sync

/** What a sync did. `lines` go to the output, `problems` each to an `ark: ` line (exit 1). */
export type SyncResult = { lines: string[]; problems: string[] };

type ScannedRun = { name: string; events: ArkEvent[]; state: RunState };

/** The runs of the project with a readable event log, and the names of those without one. Same rule as `readStates` of `ark chief state`. */
function scanRuns(project: string): { runs: ScannedRun[]; unreadable: string[] } {
  const runsRoot = runsDirectory(project);
  const runs: ScannedRun[] = [];
  const unreadable: string[] = [];
  if (!existsSync(runsRoot)) return { runs, unreadable };
  for (const name of readdirSync(runsRoot).sort()) {
    try {
      const events = readEvents(join(runsRoot, name));
      if (events.length > 0) runs.push({ name, events, state: deriveState(events) });
    } catch {
      unreadable.push(name);
    }
  }
  return { runs, unreadable };
}

/** The trigger an event fires, or undefined. A start with `criteria_gate: true` is no gate opening: the gate opens when the evaluation names a blocker. */
function triggerOf(event: ArkEvent): CompanionTrigger | undefined {
  switch (event.type) {
    case "run.started":
      return "run.started";
    case "evaluation.recorded":
      return Array.isArray(event.data.blockers) && event.data.blockers.length > 0
        ? "criteria.opened"
        : undefined;
    case "escalation.requested":
      return "escalation";
    case "run.closed":
      return event.data.outcome === "merged" ? "run.merged" : undefined;
    default:
      return undefined;
  }
}

/** The failed checks of one MR of a run in `merge_requests_open`; `failed` is null when the host could not be read. */
type CiRead = { run: string; number: number; url: string; failed: string[] | null };

function readCi(runs: ScannedRun[], workspace: string): CiRead[] {
  return runs
    .filter(({ state }) => state.phase === "merge_requests_open")
    .flatMap(({ name, state }) =>
      state.merge_requests.map((merge) => {
        const worktree = state.worktrees.find((candidate) => candidate.repo === merge.repo)?.path;
        const report = reportMergeRequest(
          merge,
          worktree !== undefined && existsSync(worktree) ? worktree : workspace,
          undefined,
        );
        return {
          run: name,
          number: merge.number,
          url: merge.url,
          failed:
            report.ci === "unknown"
              ? null
              : report.ci === "failed"
                ? report.failedChecks.length > 0
                  ? report.failedChecks.map((check) => check.name)
                  : ["unnamed check"]
                : [],
        };
      }),
    );
}

type Wake = { trigger: CompanionTrigger; run: string; ticket: string; detail: string[] };
/** One move of a cursor. A step with a `wake` sends it first and applies only when the send worked. */
type Step = { wake?: Wake; apply: (cursor: Cursor) => void };

/**
 * The moves that bring `previous` up to the runs and CI now. With no `previous` (a first sync) the
 * moves carry no wake: the companion starts at the present and hears nothing of older events.
 * A CI failure is keyed by run, MR number and check name; a key leaves the cursor once the check no
 * longer fails, so a check that fails again wakes the companion again.
 */
function stepsOf(
  companion: CompanionConfig,
  previous: Cursor | null,
  runs: ScannedRun[],
  ci: CiRead[],
): Step[] {
  const steps: Step[] = [];
  for (const run of runs) {
    const seen = previous?.runs[run.name]?.seq ?? 0;
    for (const event of run.events) {
      if (event.seq <= seen) continue;
      const trigger = triggerOf(event);
      steps.push({
        wake:
          previous && trigger && companion.on.includes(trigger)
            ? { trigger, run: run.name, ticket: ticketText(run.state), detail: [] }
            : undefined,
        apply: (cursor) => {
          cursor.runs[run.name] = { seq: event.seq, time: event.time };
        },
      });
    }
  }
  if (!companion.on.includes("ci.failed")) return steps;
  const states = new Map(runs.map((run) => [run.name, run.state]));
  for (const read of ci) {
    if (read.failed === null) continue;
    const failed = read.failed;
    const prefix = `${read.run}#${read.number}#`;
    const known = new Set(previous?.ci ?? []);
    const fresh = failed.filter((check) => !known.has(prefix + check));
    steps.push({
      wake:
        previous && fresh.length > 0
          ? {
              trigger: "ci.failed",
              run: read.run,
              ticket: ticketText(states.get(read.run)!),
              detail: [`merge request: ${read.url}`, `failed checks: ${fresh.join(", ")}`],
            }
          : undefined,
      apply: (cursor) => {
        cursor.ci = [
          ...cursor.ci.filter((key) => !key.startsWith(prefix)),
          ...failed.map((check) => prefix + check),
        ];
      },
    });
  }
  // A run that is no longer in `merge_requests_open` takes its failures with it.
  const openRuns = new Set(ci.map((read) => read.run));
  steps.push({
    apply: (cursor) => {
      cursor.ci = cursor.ci.filter((key) => openRuns.has(key.split("#")[0]));
    },
  });
  return steps;
}

const ticketText = (state: RunState): string => `${state.ticket.id} ${state.ticket.title}`;

function wakeBody(wake: Wake): string {
  return [
    `trigger: ${wake.trigger}`,
    `run: ${wake.run}`,
    `ticket: ${wake.ticket}`,
    ...wake.detail,
  ].join("\n");
}

/**
 * Sends each wake of `steps` in order and moves the cursor after each send worked, so a failed send
 * is sent again by the next sync (at least once). The first failure stops this companion.
 */
async function applySteps(
  name: string,
  directory: string,
  worker: WorkerRecord,
  previous: Cursor | null,
  steps: Step[],
  problems: string[],
  sender: () => Promise<string | undefined>,
): Promise<void> {
  const cursor: Cursor = {
    updated: "",
    runs: { ...previous?.runs },
    ci: [...(previous?.ci ?? [])],
  };
  const before = JSON.stringify([cursor.runs, cursor.ci]);
  const save = () => {
    cursor.updated = timestamp();
    writeJson(join(directory, "cursor.json"), cursor);
  };
  for (const step of steps) {
    if (step.wake) {
      const sent = await sendMessage({
        to: `dispatch:${worker.dispatch}`,
        subject: `Companion wake: ${step.wake.trigger} ${step.wake.run}`,
        body: wakeBody(step.wake),
        from: await sender(),
      });
      if (!sent.ok) {
        problems.push(
          `companion ${name}: wake ${step.wake.trigger} for ${step.wake.run} not sent: ${sent.reason}`,
        );
        break;
      }
      logWake(directory, step.wake.trigger, step.wake.run, step.wake.detail.join("; "));
      step.apply(cursor);
      save();
    } else step.apply(cursor);
  }
  if (previous === null || JSON.stringify([cursor.runs, cursor.ci]) !== before) save();
}

/**
 * Starts the worker of `companion`: the preamble and its instructions file, in the repo of the
 * workspace of ark.yml (the one path Orca knows as a worktree), kept open, in Master Chief's Run.
 */
async function startCompanion(
  project: string,
  workspace: string,
  companion: CompanionConfig,
  directory: string,
  chiefRunId: string,
  sender: () => Promise<string | undefined>,
): Promise<OrcaRead<WorkerRecord>> {
  const [firstRepo] = discoverRepos(workspace);
  if (firstRepo === undefined) return { ok: false, reason: `${workspace} holds no git repo` };
  const workspaceRepo = join(workspace, firstRepo);
  const projectFolder = projectDirectory(project);
  const instructionsFile = join(projectFolder, companion.instructions);
  let instructions: string;
  try {
    instructions = readFileSync(instructionsFile, "utf8");
  } catch {
    return { ok: false, reason: `cannot read ${instructionsFile}` };
  }
  const spec = [
    COMPANION_PREAMBLE,
    `Your name is ${companion.name}. The project is ${project}: pass \`--project ${project}\` to every \`ark\` command. The project folder is ${projectFolder}; your folder is ${directory}.`,
    `Your instructions (${companion.instructions}):`,
    instructions,
  ].join("\n\n");
  // ponytail: Master Chief and other workers run in the same repo, so the session is the first new
  // file there whose first prompt holds the companion's own line. Rare miss: the prompt is not in
  // the first 64 KiB, then no session is recorded and the cost shows unknown.
  const watch = watchSession(companion.harness, workspaceRepo, `Your name is ${companion.name}. `);
  const started = await startWorker({
    spec,
    title: `Companion: ${companion.name}`,
    worktree: workspaceRepo,
    harness: companion.harness,
    model: companion.model,
    keepOpen: true,
    run: chiefRunId,
    from: await sender(),
  });
  if (!started.ok) return started;
  if (started.value.dispatch === "unknown")
    return {
      ok: false,
      reason: "worker-start answered no dispatch id, so the worker cannot be tracked",
    };
  const session = watch ? await waitFor(watch, sessionWaitMilliseconds, 1000) : undefined;
  const record: WorkerRecord = {
    dispatch: started.value.dispatch,
    terminal: started.value.terminal,
    harness: companion.harness,
    model: companion.model,
    session: session ?? null,
    started: timestamp(),
  };
  writeJson(join(directory, "worker.json"), record);
  return { ok: true, value: record };
}

/** Names of the `companions/` folders that hold a worker record. */
function recordedNames(project: string): string[] {
  const root = companionsDirectory(project);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "worker.json")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Keeps one live Orca worker for each listed companion, stops the worker of a companion that is no
 * longer listed, and wakes each live companion once for each new event of a trigger it lists. Returns
 * null, with no Orca call, when nothing is listed and nothing is recorded. Throws when Master Chief's
 * Run or its worker list cannot be read: then nothing was started, stopped or sent.
 * `runs` is a `run-list --full` the caller read already.
 */
export async function syncCompanions(
  project: string,
  configuration: ProjectConfig,
  runs?: OrcaRead<OrcaRunRow[]>,
): Promise<SyncResult | null> {
  const listed = configuration.companions ?? [];
  const listedNames = new Set(listed.map((companion) => companion.name));
  const removed = recordedNames(project).filter((name) => !listedNames.has(name));
  if (listed.length === 0 && removed.length === 0) return null;

  const result: SyncResult = { lines: [], problems: [] };
  // Lock before any Orca read: a sync that starts after another one finished must see its record.
  const releases: (() => void)[] = [];
  const locked = new Map<string, string>();
  try {
    for (const name of [...listed.map((companion) => companion.name), ...removed]) {
      const directory = companionDirectory(project, name);
      mkdirSync(directory, { recursive: true });
      try {
        releases.push(acquireLock(directory));
        locked.set(name, directory);
      } catch (error) {
        if (!(error instanceof ArkError)) throw error;
        result.problems.push(`companion ${name}: ${error.message}`);
      }
    }
    if (locked.size === 0) return result;

    const { chiefRunId, workers } = await readChiefWorkers(project, runs);
    const sender = senderOf(project, configuration);
    const live = new Set(workers.filter(isRunning).map((worker) => worker.dispatchId));

    const needsRuns = listed.some((companion) => locked.has(companion.name));
    const scan = needsRuns ? scanRuns(project) : { runs: [], unreadable: [] };
    let ci: CiRead[] | undefined;
    for (const companion of listed) {
      const directory = locked.get(companion.name);
      if (directory === undefined) continue;
      try {
        let worker = readWorker(directory);
        if (worker !== null && live.has(worker.dispatch))
          result.lines.push(`${companion.name}: running`);
        else {
          const started = await startCompanion(
            project,
            configuration.workspace,
            companion,
            directory,
            chiefRunId,
            sender,
          );
          if (!started.ok) {
            result.problems.push(`companion ${companion.name} not started: ${started.reason}`);
            continue;
          }
          worker = started.value;
          result.lines.push(`${companion.name}: started`);
        }
        if (companion.on.includes("ci.failed") && ci === undefined) {
          ci = readCi(scan.runs, resolve(configuration.workspace));
          for (const read of ci)
            if (read.failed === null)
              result.lines.push(`note: the CI of ${read.run} (${read.url}) could not be read`);
        }
        const previous = readJson<Cursor>(join(directory, "cursor.json"));
        await applySteps(
          companion.name,
          directory,
          worker,
          previous,
          stepsOf(companion, previous, scan.runs, ci ?? []),
          result.problems,
          sender,
        );
      } catch (error) {
        if (!(error instanceof ArkError)) throw error;
        result.problems.push(`companion ${companion.name}: ${error.message}`);
      }
    }
    for (const name of removed) {
      const directory = locked.get(name);
      if (directory === undefined) continue;
      const worker = readWorker(directory);
      if (worker === null) continue;
      if (live.has(worker.dispatch)) {
        const stopped = await stopWorker(worker.dispatch);
        if (!stopped.ok) {
          result.problems.push(
            `companion ${name} not stopped: worker-stop failed: ${stopped.reason}`,
          );
          continue;
        }
        // A kept-open worker stays live and retained after worker-stop: only a release ends it.
        const released = await releaseWorker(worker.dispatch);
        if (!released.ok && !released.reason.includes("dispatch_inactive")) {
          result.problems.push(
            `companion ${name} not stopped: worker-release failed: ${released.reason}`,
          );
          continue;
        }
      }
      // The folder keeps its ideas and answers. A companion listed again later starts from the present.
      rmSync(join(directory, "worker.json"), { force: true });
      rmSync(join(directory, "cursor.json"), { force: true });
      result.lines.push(`${name}: stopped`);
    }
    if (needsRuns && scan.unreadable.length > 0)
      result.lines.push(
        `note: the events of ${scan.unreadable.join(", ")} cannot be read, so those runs send no wake`,
      );
    return result;
  } finally {
    for (const release of releases) release();
  }
}

/** `ark companions sync`. */
export async function companionsSync(inProject?: string): Promise<void> {
  const project = resolveProject(inProject);
  const result = await syncCompanions(project, loadConfig(project));
  if (result === null) return;
  if (result.lines.length > 0) console.log(result.lines.join("\n"));
  for (const problem of result.problems) console.error(`ark: ${problem}`);
  if (result.problems.length > 0) process.exitCode = 1;
}

// ------------------------------------------------------------------ the commands of a companion

/** `ark companion ask`: one message to the live worker, marked as a question from the human or Master Chief. */
export async function companionAsk(
  name: string,
  question: string,
  inProject?: string,
): Promise<void> {
  const project = resolveProject(inProject);
  const configuration = loadConfig(project);
  listedCompanion(configuration, name);
  const directory = companionDirectory(project, name);
  const worker = readWorker(directory);
  const notRunning = `companion ${name} is not running: run \`ark companions sync\``;
  if (worker === null) throw new ArkError(notRunning);
  const { workers } = await readChiefWorkers(project);
  if (!workers.some((row) => row.dispatchId === worker.dispatch && isRunning(row)))
    throw new ArkError(notRunning);
  const sent = await sendMessage({
    to: `dispatch:${worker.dispatch}`,
    subject: "Question for you",
    body: [
      "This is a question from the human or Master Chief. It is not a trigger wake.",
      `Answer it with \`ark companion answer ${name} <text> --project ${project}\`.`,
      "",
      `Question: ${question}`,
    ].join("\n"),
    from: await senderOf(project, configuration)(),
  });
  if (!sent.ok) throw new ArkError(`question to ${name} not sent: ${sent.reason}`);
  logWake(directory, "question", null, question);
}

/** `ark companion answer`: appends the answer to `answers.md`, then copies Master Chief. The file keeps the answer when the copy fails. */
export async function companionAnswer(
  name: string,
  text: string,
  inProject?: string,
): Promise<void> {
  const project = resolveProject(inProject);
  const configuration = loadConfig(project);
  listedCompanion(configuration, name);
  const directory = companionDirectory(project, name);
  mkdirSync(directory, { recursive: true });
  // One append, so two answers at once stay whole.
  appendFileSync(join(directory, "answers.md"), `## ${timestamp()}\n\n${text}\n\n`);
  const failed = (reason: string) =>
    new ArkError(
      `answer of ${name} saved in answers.md, but the copy to Master Chief failed: ${reason}`,
    );
  let chiefHandle: string;
  try {
    chiefHandle = (await liveChiefOf(project, configuration)).handle;
  } catch (error) {
    throw failed((error as Error).message);
  }
  const sent = await sendMessage({
    to: chiefHandle,
    subject: `Companion ${name} answers`,
    body: `The companion ${name} answers:\n\n${text}`,
    from: chiefHandle,
  });
  if (!sent.ok) throw failed(sent.reason);
}

/** `ark companion advise`: advice to the lead of an open run, then a copy to Master Chief. Nothing goes out unless both recipients are found. */
export async function companionAdvise(
  name: string,
  run: string,
  text: string,
  inProject?: string,
): Promise<void> {
  const project = resolveProject(inProject);
  const configuration = loadConfig(project);
  listedCompanion(configuration, name);
  const { directory } = findRun(run, project);
  if (deriveState(readEvents(directory)).phase === "closed")
    throw new ArkError(`run ${run} is closed: advice goes only to the lead of an open run`);
  const chief = await liveChiefOf(project, configuration);
  const { workers, runs } = await readChiefWorkers(project, { ok: true, value: chief.runs });
  const lead = workers.find(
    (worker) => (worker.terminalState ?? "active") === "active" && runOfLead(runs, worker) === run,
  );
  if (!lead) throw new ArkError(`run ${run} has no live run lead`);
  const toLead = await sendMessage({
    to: lead.terminal ?? `dispatch:${lead.dispatchId}`,
    subject: `${ADVICE_SUBJECT_PREFIX}${name}: ${run}`,
    // `status` is no reply and no gate message: the run lead reads it as information.
    type: "status",
    from: chief.handle,
    body: [
      `This is advice from the companion ${name} about run ${run}. It is advice and not a gate answer: never read it as the human's answer at any gate.`,
      "",
      text,
    ].join("\n"),
  });
  if (!toLead.ok) throw new ArkError(`advice to the lead of ${run} not sent: ${toLead.reason}`);
  const copy = await sendMessage({
    to: chief.handle,
    subject: `Companion ${name} advised the lead of ${run}`,
    body: `The companion ${name} sent the lead of run ${run} this advice (not a gate answer):\n\n${text}`,
    from: chief.handle,
  });
  if (!copy.ok)
    throw new ArkError(
      `advice reached the lead of ${run}, but the copy to Master Chief failed: ${copy.reason}`,
    );
}

/**
 * `ark companion propose`: copies the draft to `tickets/<id>.md` as `status: proposed` with a `source` line. It never overwrites a ticket and never queues.
 * A relative draft path is resolved against the project folder, not the process cwd: a companion runs in the workspace repo.
 */
export function companionPropose(name: string, draft: string, inProject?: string): void {
  const project = resolveProject(inProject);
  listedCompanion(loadConfig(project), name);
  const file = resolve(projectDirectory(project), draft);
  if (!existsSync(file)) throw new ArkError(`draft not found: ${file}`);
  const text = readFileSync(file, "utf8");
  const { id } = readTicket(file);
  // The hub lists only `<KEY>-<number>.md`: any other id would write a ticket nobody sees.
  if (!/^[A-Z]+-\d+$/.test(id))
    throw new ArkError(`draft id ${id} must look like ARK-123: letters, a dash and a number`);
  const folder = join(projectDirectory(project), "tickets");
  const taken = existsSync(folder)
    ? readdirSync(folder)
        .filter((entry) => entry.endsWith(".md"))
        .find((entry) => {
          if (entry === `${id}.md`) return true;
          try {
            return frontmatter(readFileSync(join(folder, entry), "utf8")).fields?.id === id;
          } catch {
            return false;
          }
        })
    : undefined;
  if (taken) throw new ArkError(`ticket ${id} already exists in ${join(folder, taken)}`);
  const { yaml, body } = splitFrontmatter(text);
  const fields = yaml!.split(/\r?\n/).filter((line) => !/^(status|source):/.test(line));
  mkdirSync(folder, { recursive: true });
  const target = join(folder, `${id}.md`);
  writeFileSync(
    target,
    `---\n${[...fields, "status: proposed", `source: companion ${name}`].join("\n")}\n---\n${body}`,
    { flag: "wx" },
  );
  console.log(target);
}
