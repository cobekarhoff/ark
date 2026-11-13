import { exec } from "./exec.ts";

/** ARK_PS names another `ps` (tests): the real one is `/bin/ps`, because a `ps` earlier on PATH may reject `-E`. */
const psCommand = () => process.env.ARK_PS || "/bin/ps";

export type ProcessRow = {
  pid: number;
  parent: number;
  group: number;
  rssKilobytes: number;
  /** Cumulative CPU time of the process so far. */
  cpuSeconds: number;
  ageSeconds: number;
  /** The command line; with `environment` it is followed by the environment as one string, and callers must cut it. */
  text: string;
};

/** `ps` clock fields: `M:SS.ss`, `H:MM:SS` or `D-HH:MM:SS`, in seconds. Null when it is none of them. */
export function parseClock(text: string): number | null {
  const match = text.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  );
}

const rowPattern = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/;

/** One `ps` read of every process, or null when `ps` fails. A line that does not parse is skipped. */
export async function readProcessTable(environment: boolean): Promise<ProcessRow[] | null> {
  const output = await exec([
    psCommand(),
    ...(environment ? ["-E"] : []),
    "-ww",
    "-A",
    "-o",
    "pid=,ppid=,pgid=,rss=,time=,etime=,command=",
  ]);
  if (output === null) return null;
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(rowPattern);
    if (match === null) continue;
    const cpuSeconds = parseClock(match[5]!);
    const ageSeconds = parseClock(match[6]!);
    if (cpuSeconds === null || ageSeconds === null) continue;
    rows.push({
      pid: Number(match[1]),
      parent: Number(match[2]),
      group: Number(match[3]),
      rssKilobytes: Number(match[4]),
      cpuSeconds,
      ageSeconds,
      text: match[7]!,
    });
  }
  return rows;
}
