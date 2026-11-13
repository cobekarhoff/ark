/** Every external reader (orca, plannotator) waits at most this long. */
export const readerTimeoutMilliseconds = 2000;

/**
 * Runs a command and returns its stdout, or null when it fails, is missing or takes longer than
 * the timeout. A null never means "dead": callers report it as unknown.
 */
export async function exec(
  command: string[],
  timeoutMilliseconds = readerTimeoutMilliseconds,
  okExitCodes = [0],
  cwd?: string,
): Promise<string | null> {
  try {
    // `env` makes Bun resolve the command on the PATH of now: on Linux it otherwise keeps the PATH of its start.
    const child = Bun.spawn(command, {
      cwd,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const killer = setTimeout(() => child.kill(), timeoutMilliseconds);
    // The race also covers a killed shell whose grandchild still holds the stdout pipe open.
    let backstop: ReturnType<typeof setTimeout> | undefined;
    const output = await Promise.race([
      new Response(child.stdout)
        .text()
        .then(async (text) => (okExitCodes.includes(await child.exited) ? text : null)),
      new Promise<null>((done) => {
        backstop = setTimeout(() => done(null), timeoutMilliseconds + 100);
      }),
    ]);
    clearTimeout(backstop);
    clearTimeout(killer);
    return output;
  } catch {
    return null;
  }
}

/** `exec` plus JSON parsing. Output of a local tool is trusted, so the result is cast by the caller. */
export async function execJson<T>(
  command: string[],
  timeoutMilliseconds = readerTimeoutMilliseconds,
  okExitCodes = [0],
  cwd?: string,
): Promise<T | null> {
  const output = await exec(command, timeoutMilliseconds, okExitCodes, cwd);
  if (output === null) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

export type ExecResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean };

/**
 * Runs a command and returns what `exec` hides: exit code, stderr and whether the timeout fired.
 * Never throws: a command that cannot start gives a null code and the error text as stderr.
 */
export async function execResult(
  command: string[],
  timeoutMilliseconds = readerTimeoutMilliseconds,
): Promise<ExecResult> {
  try {
    const child = Bun.spawn(command, {
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let deadlineFired = false;
    const killer = setTimeout(() => {
      deadlineFired = true;
      child.kill();
    }, timeoutMilliseconds);
    // The backstop also covers a killed shell whose grandchild still holds a pipe open.
    let backstop: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
        async ([stdout, stderr]) => ({ stdout, stderr, code: await child.exited, timedOut: false }),
      ),
      new Promise<ExecResult>((done) => {
        backstop = setTimeout(
          () => done({ stdout: "", stderr: "", code: null, timedOut: true }),
          timeoutMilliseconds + 100,
        );
      }),
    ]);
    clearTimeout(backstop);
    clearTimeout(killer);
    // Only this call's own deadline counts: a child killed by another signal keeps its stderr.
    return { ...result, timedOut: result.timedOut || deadlineFired };
  } catch (err) {
    return { stdout: "", stderr: String(err), code: null, timedOut: false };
  }
}

/** The reason a command failed: first non-empty stderr line, else `exit <code>`, or the timeout. */
export function failureReason(result: ExecResult, timeoutMilliseconds: number): string {
  if (result.timedOut) return `timed out after ${Math.ceil(timeoutMilliseconds / 1000)} s`;
  const line = result.stderr.split("\n").find((text) => text.trim() !== "");
  return line?.trim() ?? `exit ${result.code}`;
}
