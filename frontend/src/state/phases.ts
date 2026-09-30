// Optional phases inside a deliverable. Mirrors backend/app/domain/phases.py: a phase starts
// the day after the previous one ends unless it has a `gap` (days left free before it). Every
// phase but the last has a length in days, and the last runs to the deliverable's end date.

import type { Deliverable, Phase } from "../types";
import { addDays, daysBetween } from "./dates";

export const DEFAULT_WORKFLOW = ["Dev", "Review", "UAT"];
const DEFAULT_SHARES = [0.6, 0.15, 0.25];

type Dated = Pick<Deliverable, "start_date" | "end_date" | "phases">;

export interface PhaseSpan {
  index: number;
  name: string;
  gap: number; // free days before this phase
  start: string;
  end: string;
  days: number;
}

/** Phases as parallel arrays, with the last phase's length made explicit. */
interface Layout {
  names: string[];
  gaps: number[];
  lengths: number[];
}

export function duration(d: Pick<Deliverable, "start_date" | "end_date">): number {
  return daysBetween(d.start_date, d.end_date) + 1;
}

export function hasPhases(d: Pick<Deliverable, "phases">): d is { phases: Phase[] } {
  return !!d.phases && d.phases.length > 0;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function layout(d: Dated): Layout {
  const phases = d.phases ?? [];
  const names = phases.map((p) => p.name);
  const gaps = phases.map((p, i) => (i === 0 ? 0 : (p.gap ?? 0)));
  const fixed = phases.slice(0, -1).map((p) => p.days ?? 1);
  return { names, gaps, lengths: [...fixed, duration(d) - sum(fixed) - sum(gaps)] };
}

function toPhases({ names, gaps, lengths }: Layout): Phase[] {
  return names.map((name, i) => {
    const p: Phase = { name };
    if (i < names.length - 1) p.days = lengths[i];
    if (gaps[i] > 0) p.gap = gaps[i];
    return p;
  });
}

const fits = (l: Layout) => l.lengths.every((n) => n >= 1) && l.gaps.every((g) => g >= 0);

/** Length of every phase, the last one included. */
export function phaseLengths(d: Dated): number[] {
  return hasPhases(d) ? layout(d).lengths : [];
}

export function phaseSpans(d: Dated): PhaseSpan[] {
  if (!hasPhases(d)) return [];
  const { names, gaps, lengths } = layout(d);
  let cursor = d.start_date;
  return names.map((name, index) => {
    const start = addDays(cursor, gaps[index]);
    const end = addDays(start, lengths[index] - 1);
    cursor = addDays(end, 1);
    return { index, name, gap: gaps[index], start, end, days: lengths[index] };
  });
}

/** The fewest days a deliverable can last without squeezing a phase below one day. */
export function minDuration(d: Pick<Deliverable, "phases">): number {
  return hasPhases(d) ? d.phases.length : 1;
}

/** Split `total` days by `shares`, giving every part at least one day. */
function scale(shares: number[], total: number): number[] {
  const whole = sum(shares);
  const out: number[] = [];
  let used = 0;
  shares.forEach((share, i) => {
    const left = shares.length - i - 1;
    const len = i === shares.length - 1 ? total - used : Math.max(1, Math.min(Math.round((total * share) / whole), total - used - left));
    out.push(len);
    used += len;
  });
  return out;
}

/** Phases for a plain deliverable broken into `names`, or null if it is too short. */
export function splitIntoPhases(d: Dated, names: string[] = DEFAULT_WORKFLOW): Phase[] | null {
  const total = duration(d);
  if (total < names.length) return null;
  const shares = names === DEFAULT_WORKFLOW ? DEFAULT_SHARES : names.map(() => 1);
  return toPhases({ names, gaps: names.map(() => 0), lengths: scale(shares, total) });
}

/**
 * Phases after the deliverable's dates change. The first phase absorbs a start change and the
 * last absorbs an end change, so everything in between stays on its dates. If that would squeeze
 * a phase below a day, the gaps are dropped and the phases rescaled to the new length.
 */
export function refitPhases(d: Dated, start: string, end: string): Phase[] | null | undefined {
  if (!hasPhases(d)) return d.phases;
  const l = layout(d);
  const total = daysBetween(start, end) + 1;
  if (total < l.names.length) return null;
  const next = { ...l, lengths: [...l.lengths] };
  next.lengths[0] -= daysBetween(d.start_date, start);
  next.lengths[next.lengths.length - 1] = total - sum(next.lengths.slice(0, -1)) - sum(next.gaps);
  if (fits(next)) return toPhases(next);
  return toPhases({ names: l.names, gaps: l.names.map(() => 0), lengths: scale(l.lengths, total) });
}

type Moved = { phases: Phase[]; end_date: string };

/**
 * Move the end of phase `index` by `delta` days. By default the change is absorbed right after
 * it: by the gap if there is one, otherwise by the next phase, so the end date holds. With
 * `push`, everything after keeps its length and the end date moves.
 */
export function moveEnd(d: Dated, index: number, delta: number, push: boolean): Moved {
  const l = layout(d);
  const lengths = [...l.lengths];
  const gaps = [...l.gaps];
  if (push) {
    const applied = Math.max(delta, 1 - lengths[index]);
    lengths[index] += applied;
    return { phases: toPhases({ ...l, lengths }), end_date: addDays(d.end_date, applied) };
  }
  const next = index + 1;
  const room = gaps[next] > 0 ? gaps[next] : lengths[next] - 1;
  const applied = Math.min(Math.max(delta, 1 - lengths[index]), room);
  lengths[index] += applied;
  if (gaps[next] > 0) gaps[next] -= applied;
  else lengths[next] -= applied;
  return { phases: toPhases({ ...l, gaps, lengths }), end_date: d.end_date };
}

/**
 * Move the start of phase `index` (not the first) by `delta` days, opening or closing the gap
 * before it. By default the phase's end holds, so it gets shorter or longer. With `push`, the
 * phase and everything after keep their lengths and the end date moves.
 */
export function moveStart(d: Dated, index: number, delta: number, push: boolean): Moved {
  const l = layout(d);
  const lengths = [...l.lengths];
  const gaps = [...l.gaps];
  const applied = push ? Math.max(delta, -gaps[index]) : Math.min(Math.max(delta, -gaps[index]), lengths[index] - 1);
  gaps[index] += applied;
  if (push) return { phases: toPhases({ ...l, gaps }), end_date: addDays(d.end_date, applied) };
  lengths[index] -= applied;
  return { phases: toPhases({ ...l, gaps, lengths }), end_date: d.end_date };
}

/** Remove one phase. Its time goes to a neighbour so the other phases keep their dates. */
export function removePhase(d: Dated, index: number): Phase[] | null {
  const l = layout(d);
  if (l.names.length <= 2) return null;
  const names = [...l.names];
  const gaps = [...l.gaps];
  const lengths = [...l.lengths];
  if (index < names.length - 1) {
    // The next phase takes over from this one's start.
    lengths[index + 1] += lengths[index] + gaps[index + 1];
    gaps[index + 1] = gaps[index];
  } else {
    lengths[index - 1] += gaps[index] + lengths[index];
  }
  [names, gaps, lengths].forEach((xs) => xs.splice(index, 1));
  gaps[0] = 0;
  return toPhases({ names, gaps, lengths });
}

/** Append a phase by splitting the last one in two, or null if the last phase is a single day. */
export function addPhase(d: Dated, name: string): Phase[] | null {
  const l = layout(d);
  const last = l.lengths[l.lengths.length - 1];
  if (last < 2) return null;
  return toPhases({
    names: [...l.names, name],
    gaps: [...l.gaps, 0],
    lengths: [...l.lengths.slice(0, -1), Math.ceil(last / 2), Math.floor(last / 2)],
  });
}

export function renamePhase(d: Dated, index: number, name: string): Phase[] {
  return d.phases!.map((p, i) => (i === index ? { ...p, name } : p));
}

/** Change in each phase's length between two versions, when both have the same phases. */
export function phaseDeltas(before: Dated | null | undefined, after: Dated): { name: string; delta: number; gapDelta: number }[] | null {
  if (!before || !hasPhases(before) || !hasPhases(after)) return null;
  const a = layout(before);
  const b = layout(after);
  if (a.names.join("\u0000") !== b.names.join("\u0000")) return null;
  return a.names.map((name, i) => ({ name, delta: b.lengths[i] - a.lengths[i], gapDelta: b.gaps[i] - a.gaps[i] }));
}

export function samePhases(a: Phase[] | null | undefined, b: Phase[] | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** "Dev 12d · 2d gap · Review 3d · UAT 5d" */
export function describePhases(d: Dated): string {
  if (!hasPhases(d)) return "none";
  return phaseSpans(d)
    .flatMap((s) => [...(s.gap ? [`${s.gap}d gap`] : []), `${s.name} ${s.days}d`])
    .join(" · ");
}

// Phase colours used when the timeline is coloured by phase: one hue per phase name.
export const PHASE_COLORS = ["#5468d4", "#9a5cc6", "#16939a", "#c7792a", "#c24a7c", "#5d9a3a"];

/** Phase names in the order they first appear in the plan, for stable colours. */
export function phaseNameOrder(deliverables: Deliverable[]): string[] {
  const names: string[] = [];
  for (const d of [...deliverables].sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id.localeCompare(b.id))) {
    for (const p of d.phases ?? []) if (!names.includes(p.name)) names.push(p.name);
  }
  return names;
}
