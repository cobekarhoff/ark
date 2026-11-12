import { hashOf, useLive } from "./store.tsx";
import type { HostLevel, HostView, ResourcesView } from "../types.ts";

/** What each level is called on the strip. Memory pressure says what macOS says; `unchecked` is a signal nobody could read, never normal. */
const levelWords: Record<HostLevel, string> = {
  normal: "normal",
  amber: "amber",
  red: "red",
  unchecked: "unchecked",
};
const pressureWords: Record<HostLevel, string> = {
  normal: "normal",
  amber: "warn",
  red: "critical",
  unchecked: "unchecked",
};

const gigabytes = (value: number | null) => (value === null ? "—" : `${value.toFixed(1)} GB`);

/** The signal, its text and its level, in the order of the strip. */
function signalsOf(host: HostView) {
  return [
    {
      key: "cpu",
      label: "CPU",
      value: host.cpu.percent === null ? "—" : `${Math.round(host.cpu.percent)}%`,
      title: host.cpu.cores === null ? "cores unknown" : `${host.cpu.cores} cores`,
      level: host.cpu.level,
      words: levelWords,
    },
    {
      key: "pressure",
      label: "Memory pressure",
      value: pressureWords[host.pressure.level],
      title:
        host.pressure.free_percent === null
          ? "free memory unknown"
          : `${host.pressure.free_percent}% of memory free`,
      level: host.pressure.level,
      words: pressureWords,
    },
    {
      key: "swap",
      label: "Swap",
      value: gigabytes(host.swap.used_gb),
      title: `of ${gigabytes(host.swap.total_gb)} · amber above 2 GB, red above 6 GB`,
      level: host.swap.level,
      words: levelWords,
    },
    {
      key: "disk",
      label: "Disk free",
      value: host.disk.free_gb === null ? "—" : `${host.disk.free_gb} GB`,
      title: "on / · amber under 30 GB, red under 15 GB",
      level: host.disk.level,
      words: levelWords,
    },
    {
      key: "load",
      label: "Load",
      value: host.load.five === null ? "—" : host.load.five.toFixed(1),
      title: `1/5/15 min: ${[host.load.one, host.load.five, host.load.fifteen]
        .map((load) => (load === null ? "—" : load.toFixed(1)))
        .join(
          " / ",
        )}${host.cpu.cores === null ? "" : ` on ${host.cpu.cores} cores`} · amber above 10, red above 12`,
      level: host.load.level,
      words: levelWords,
    },
  ];
}

/** The `ark test` budget: who holds it and who waits, for how long. */
function admissionText(admission: ResourcesView["admission"]): string {
  if (admission.holders.length === 0 && admission.waiting.length === 0) return "idle";
  const holders = admission.holders.map((holder) => holder.run).join(", ");
  const waiting = admission.waiting
    .map((waiter) => `${waiter.run} ${waiter.waited_seconds} s`)
    .join(", ");
  return `${holders === "" ? "no holder" : `holds: ${holders}`}${waiting === "" ? "" : ` · waiting: ${waiting}`}`;
}

/** Host resources on every page. The level is a mark and a word as well as a colour. */
export function ResourcesStrip() {
  const { snapshot } = useLive();
  const resources = snapshot?.resources;
  const known = resources !== undefined && resources !== "unknown";
  return (
    <div
      className="host-strip"
      role="region"
      aria-label="Host resources"
      data-testid="resources-strip"
    >
      {known ? (
        signalsOf(resources.host).map((signal) => (
          <div
            key={signal.key}
            className={`sig lv ${signal.level}`}
            title={signal.title}
            data-testid={`strip-${signal.key}`}
            data-level={signal.level}
          >
            <span className="mark" aria-hidden="true" />
            <span className="k">{signal.label}</span>
            <span className="v">{signal.value}</span>
            <span className="tag">{signal.words[signal.level]}</span>
          </div>
        ))
      ) : (
        <div className="sig lv unchecked" data-testid="strip-unknown" data-level="unchecked">
          <span className="mark" aria-hidden="true" />
          <span className="k">Host resources</span>
          <span className="tag">unchecked</span>
        </div>
      )}
      {known ? (
        <div className="adm" data-testid="strip-admission">
          <span className="k">ark test</span>
          <span className="mono">{admissionText(resources.admission)}</span>
        </div>
      ) : null}
      <a className="go" href={hashOf("#/resources")}>
        Resources
      </a>
    </div>
  );
}
