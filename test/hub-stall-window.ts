// ARK-602/AC1, ARK-T730: names the work that ran in the window of the largest loop lag of the ARK-T699 soak.
// Test support only: its callers are ARK-T699 (the failure message of the lag assert) and ARK-T730.

type SourcePass = { last_ms: number | null; ended_at: string | null };
export type WindowProbe = {
  at: number;
  lag_ms: number | null;
  sources: Record<string, SourcePass>;
};
export type WindowLine = { at: number; text: string };

type NamedPass = { name: string; duration: number; endedAt: number };

/**
 * The window of the largest lag runs from the probe before the first probe that reported it up to that probe.
 * A pass is [ended - last_ms, ended] in soak time; every distinct pass seen at any probe that overlaps the
 * window is named, so a pass that the next pass of its source overwrote is still found.
 */
export function windowMessage(
  probes: WindowProbe[],
  lines: WindowLine[],
  startEpoch: number,
): string {
  const largestLag = Math.max(0, ...probes.map((probe) => probe.lag_ms ?? 0));
  if (largestLag === 0) return "ARK-T699: the hub reported no lag";
  const index = probes.findIndex((probe) => (probe.lag_ms ?? 0) === largestLag);
  const windowStart = index > 0 ? probes[index - 1]!.at : 0;
  const windowEnd = probes[index]!.at;

  const passes = new Map<string, NamedPass>();
  for (const probe of probes) {
    for (const [name, source] of Object.entries(probe.sources)) {
      if (source.ended_at === null || source.last_ms === null) continue;
      const endedAt = Date.parse(source.ended_at) - startEpoch;
      if (endedAt < windowStart || endedAt - source.last_ms > windowEnd) continue;
      passes.set(`${name} ${endedAt}`, { name, duration: source.last_ms, endedAt });
    }
  }
  const sourceRows = [...passes.values()]
    .sort((left, right) => left.endedAt - right.endedAt)
    .map((pass) => `  ${pass.name}: ${pass.duration} ms, ended ${pass.endedAt}`);
  const lineRows = lines
    .filter((line) => line.at >= windowStart && line.at <= windowEnd)
    .map((line) => `  ${line.at}: ${line.text}`);

  return [
    `ARK-T699: the largest loop lag was ${largestLag} ms, ${windowEnd} ms into the soak`,
    `window: ${windowStart}..${windowEnd} ms into the soak`,
    "sources that ran or ended in the window (name, last pass, end time into the soak):",
    ...(sourceRows.length > 0 ? sourceRows : ["  no source"]),
    "hub lines in the window:",
    ...(lineRows.length > 0 ? lineRows : ["  no hub line"]),
  ].join("\n");
}
