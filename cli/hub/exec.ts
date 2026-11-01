/** Every external reader (orca, plannotator) waits at most this long. */
export const readerTimeoutMilliseconds = 2000;

/**
 * Runs a command and returns its stdout, or null when it fails, is missing or takes longer than
 * the timeout. A null never means "dead": callers report it as unknown.
 */
export async function exec(
  command: string[],
  timeoutMilliseconds = readerTimeoutMilliseconds,
): Promise<string | null> {
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const killer = setTimeout(() => child.kill(), timeoutMilliseconds);
    // The race also covers a killed shell whose grandchild still holds the stdout pipe open.
    const output = await Promise.race([
      new Response(child.stdout)
        .text()
        .then(async (text) => ((await child.exited) === 0 ? text : null)),
      Bun.sleep(timeoutMilliseconds + 100).then(() => null),
    ]);
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
): Promise<T | null> {
  const output = await exec(command, timeoutMilliseconds);
  if (output === null) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}
