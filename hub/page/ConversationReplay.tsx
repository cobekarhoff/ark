import { useEffect, useRef, useState } from "react";
import { clockText, spansDays, type Range } from "./conversation-model.ts";
import { reducedMotion } from "./motion.tsx";

/** Run seconds that pass in one real second. */
export const replaySpeeds = [10, 60, 600] as const;
export type ReplaySpeed = (typeof replaySpeeds)[number];

export type Replay = {
  /** Null when no replay runs: the whole conversation shows. */
  playhead: number | null;
  playing: boolean;
  speed: ReplaySpeed;
  /** The message sent by the last frame that crossed one: its arrow animates once. */
  pulse: { id: string; nonce: number } | null;
  play: () => void;
  pause: () => void;
  seek: (time: number) => void;
  setSpeed: (speed: ReplaySpeed) => void;
  exit: () => void;
};

/**
 * The replay clock. It lives in the tab, not in the data: a new poll of the conversation moves `full`
 * and `sent` but never resets the playhead. Under reduced motion `play` does nothing and `seek`
 * (the scrubber) still moves the playhead.
 */
export function useReplay(full: Range, sent: { id: string; time: number }[]): Replay {
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(60);
  const [pulse, setPulse] = useState<Replay["pulse"]>(null);
  const head = useRef<number | null>(null);
  const latest = useRef({ full, sent });
  latest.current = { full, sent };

  const seek = (time: number) => {
    head.current = time;
    setPlayhead(time);
  };

  useEffect(() => {
    if (!playing) return;
    let last: number | null = null;
    let frame = 0;
    const step = (now: number) => {
      const { full: range, sent: messages } = latest.current;
      const previous = head.current ?? range.start;
      const next = Math.min(range.end, previous + (last === null ? 0 : now - last) * speed);
      last = now;
      head.current = next;
      setPlayhead(next);
      const crossed = messages
        .filter((message) => message.time > previous && message.time <= next)
        .at(-1);
      if (crossed) setPulse((old) => ({ id: crossed.id, nonce: (old?.nonce ?? 0) + 1 }));
      if (next >= range.end) setPlaying(false);
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed]);

  return {
    playhead,
    playing,
    speed,
    pulse,
    play: () => {
      if (reducedMotion()) return;
      if (head.current === null || head.current >= full.end) seek(full.start);
      setPlaying(true);
    },
    pause: () => setPlaying(false),
    seek,
    setSpeed,
    exit: () => {
      setPlaying(false);
      head.current = null;
      setPlayhead(null);
      setPulse(null);
    },
  };
}

export function Player({ full, replay }: { full: Range; replay: Replay }) {
  const { playhead, playing, speed } = replay;
  const still = reducedMotion();
  const shown = playhead ?? full.end;
  return (
    <div className="cv-player" role="group" aria-label="Replay" data-testid="replay">
      <button
        type="button"
        className="btn small"
        data-testid="replay-play"
        disabled={still}
        title={still ? "Playback is off under reduced motion: use the scrubber" : undefined}
        onClick={playing ? replay.pause : replay.play}
      >
        {playing ? "Pause" : "Play"}
      </button>
      <div className="seg" role="group" aria-label="Replay speed">
        {replaySpeeds.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={speed === candidate}
            data-testid="replay-speed"
            data-speed={candidate}
            onClick={() => replay.setSpeed(candidate)}
          >
            {candidate}x
          </button>
        ))}
      </div>
      <input
        type="range"
        className="cv-scrubber"
        min={full.start}
        max={full.end}
        step={1}
        value={shown}
        aria-label="Replay position"
        aria-valuetext={clockText(shown, true, spansDays(full))}
        data-testid="replay-scrubber"
        onChange={(event) => replay.seek(Number(event.target.value))}
      />
      <span className="mono" data-testid="replay-clock">
        {clockText(shown, true, spansDays(full))}
      </span>
      <button
        type="button"
        className="btn small"
        data-testid="replay-exit"
        disabled={playhead === null}
        onClick={replay.exit}
      >
        Show all
      </button>
    </div>
  );
}
