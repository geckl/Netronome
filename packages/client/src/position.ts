/**
 * Musical position <-> beats conversion.
 *
 * Kept in lockstep with apps/Backend/src/core/position.ts — one shared,
 * exactly-tested implementation instead of per-app parsing. The engine works
 * in absolute beats (a quarter note = 1 beat) on the server clock;
 * Tone.js-style "bars:beats:sixteenths" strings (e.g. "1:2:3", 0-indexed)
 * convert here.
 */

/** Tone.js bars:beats:sixteenths string, or a plain (possibly fractional) beat count. */
export type PositionInput = string | number;

/** Position -> beats. Returns undefined when the input is unparseable (=> "resume"). */
export function parsePosition(input: PositionInput | undefined | null): number | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "number") return Number.isFinite(input) ? Math.max(0, input) : undefined;
  if (input === "") return undefined;
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(input.trim());
  if (!match) return undefined;
  const bars = Number(match[1]);
  const beats = Number(match[2]);
  const sixteenths = Number(match[3]);
  return bars * 4 + beats + sixteenths / 4;
}

/** Beats -> a Tone.js bars:beats:sixteenths string, snapped to the nearest sixteenth. */
export function formatPosition(beats: number): string {
  if (!Number.isFinite(beats) || beats < 0) beats = 0;
  const sixteenthSteps = Math.round(beats * 4); // integer count of sixteenths
  const bars = Math.floor(sixteenthSteps / 16);
  const beatIdx = Math.floor((sixteenthSteps % 16) / 4);
  const sixteenth = sixteenthSteps % 4;
  return `${bars}:${beatIdx}:${sixteenth}`;
}
