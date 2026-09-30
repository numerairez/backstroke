// Where a deliverable stands, derived from its planned dates, its finish dates and a "today".
// Nothing here is stored: status is always computed, so replaying an old version with the
// date of that version shows what was overdue at the time.

import type { Deliverable } from "../types";
import { daysBetween } from "./dates";
import { hasPhases, phaseSpans, type PhaseSpan } from "./phases";

export type StatusKind = "todo" | "progress" | "behind" | "overdue" | "done";

export interface Status {
  kind: StatusKind;
  /** done: finish minus planned end (negative = early). */
  delta?: number;
  /** overdue / behind: days past the planned end (of the deliverable, or of the late phase). */
  days?: number;
  /** progress: days until the planned end (0 = due today). */
  left?: number;
  finishedOn?: string;
  /** phased: the first phase not yet done. */
  current?: PhaseSpan;
  /** behind: the phase the plan says should be under way today. */
  planned?: PhaseSpan;
}

interface Span {
  start: string;
  end: string;
  finishedOn?: string | null;
}

/** Status of one planned span (a deliverable without phases, or one phase) as of `today`. */
export function spanStatus(s: Span, today: string): Status {
  // A finish recorded after `today` hasn't happened yet as of that day.
  if (s.finishedOn && s.finishedOn <= today) return { kind: "done", delta: daysBetween(s.end, s.finishedOn), finishedOn: s.finishedOn };
  if (today < s.start) return { kind: "todo" };
  if (today > s.end) return { kind: "overdue", days: daysBetween(s.end, today) };
  return { kind: "progress", left: daysBetween(today, s.end) };
}

export function phaseStatuses(d: Deliverable, today: string): { span: PhaseSpan; status: Status }[] {
  const phases = d.phases ?? [];
  return phaseSpans(d).map((span) => ({ span, status: spanStatus({ ...span, finishedOn: phases[span.index]?.finished_on }, today) }));
}

/**
 * Status of a deliverable. A phased one is "behind" when a phase is past its end and not done
 * while the deliverable's own end date is still ahead: an early warning before it goes overdue.
 */
export function deliverableStatus(d: Deliverable, today: string): Status | null {
  if (d.type === "milestone") return null;
  if (!hasPhases(d)) return spanStatus({ start: d.start_date, end: d.end_date, finishedOn: d.finished_on }, today);
  const phases = phaseStatuses(d, today);
  const last = phases[phases.length - 1];
  if (last.status.kind === "done") return { ...last.status, delta: daysBetween(d.end_date, last.status.finishedOn!) };
  const current = phases.find((p) => p.status.kind !== "done")!;
  const planned = phases.find((p) => today >= p.span.start && today <= p.span.end)?.span;
  if (today > d.end_date) return { kind: "overdue", days: daysBetween(d.end_date, today), current: current.span };
  if (current.status.kind === "overdue") return { kind: "behind", days: current.status.days, current: current.span, planned };
  if (today < d.start_date) return { kind: "todo" };
  return { kind: "progress", left: daysBetween(today, d.end_date), current: current.span };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function finishText(delta: number): string {
  if (delta === 0) return "on time";
  return delta > 0 ? `${plural(delta, "day")} late` : `${plural(-delta, "day")} early`;
}

/** Short label, e.g. "Overdue 5d", "Behind · Dev 4d late", "Done · 1 day early". */
export function statusLabel(s: Status): string {
  switch (s.kind) {
    case "done":
      return `Done · ${finishText(s.delta ?? 0)}`;
    case "overdue":
      return `Overdue ${s.days}d`;
    case "behind":
      return `Behind · ${s.current?.name} ${s.days}d late`;
    case "progress":
      return s.left === 0 ? "Due today" : `In progress · ${s.left}d left`;
    case "todo":
      return "Not started";
  }
}
