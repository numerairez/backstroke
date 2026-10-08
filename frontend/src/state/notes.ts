// Meeting notes markup. Plain text, one item per line:
//   !action @Ravi freeze the schema by Fri     -> an action owned by Ravi, due the next Friday
//   ?risk vendor may slip @[Data Mapping]       -> a risk on a deliverable
//   =decision hold @[Go-Live] at 30 Oct         -> a decision
// `@[Name]` names a deliverable. A bare `@Word` is a deliverable when it matches one with the
// spaces removed (@DataMapping), otherwise a person or group from the project's people (see
// people.ts), or a name as written. Everything here is deterministic.

import type { Deliverable, ItemInput, ItemKind, Person } from "../types";
import { addDays, toDay, weekday } from "./dates";
import { resolvePerson } from "./people";

export const TAGS: Record<ItemKind, string> = { action: "!action", risk: "?risk", decision: "=decision" };
const TAG_RE = /^(!action|\?risk|=decision)\b\s*/i;
const TOKEN_RE = /@\[([^\]\n]+)\]|@([A-Za-z][\w-]*)/g;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type Segment =
  | { type: "text"; text: string }
  | { type: "deliverable"; id: string; name: string }
  | { type: "person"; name: string }
  | { type: "unknown"; text: string; name: string };

export interface ParsedLine {
  index: number;
  kind: ItemKind | null;
  segments: Segment[];
  /** The line as words, tag removed and mentions written as names. */
  text: string;
  owner: string | null;
  due_on: string | null;
  deliverable_ids: string[];
  /** `@[Name]` mentions that match no deliverable. */
  unknown: string[];
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function findDeliverable(deliverables: Deliverable[], name: string, exact: boolean): Deliverable | undefined {
  const want = exact ? name.trim().toLowerCase() : compact(name);
  return deliverables.find((d) => (exact ? d.name.trim().toLowerCase() : compact(d.name)) === want);
}

/** "by Fri", "by 14 Oct", "by Oct 14" or "by 2026-10-14", read relative to the meeting date. */
export function parseDue(text: string, meetingDate: string): string | null {
  const iso = text.match(/\bby (\d{4}-\d{2}-\d{2})\b/i);
  if (iso) return iso[1];

  const day = text.match(/\bby (sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i);
  if (day) {
    // The next one after the meeting: "by Fri" said on a Friday means a week later.
    const target = DAYS.indexOf(day[1].toLowerCase());
    const ahead = ((target - weekday(meetingDate) + 7) % 7) || 7;
    return addDays(meetingDate, ahead);
  }

  const dm = text.match(/\bby (\d{1,2}) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  const md = text.match(/\bby (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})\b/i);
  const parts = dm ? { d: Number(dm[1]), m: dm[2] } : md ? { d: Number(md[2]), m: md[1] } : null;
  if (!parts || parts.d < 1 || parts.d > 31) return null;
  const month = MONTHS.indexOf(parts.m.toLowerCase()) + 1;
  // The next such date on or after the meeting.
  let year = Number(meetingDate.slice(0, 4));
  const at = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
  if (toDay(at(year)) < toDay(meetingDate)) year += 1;
  return at(year);
}

export function parseLine(line: string, index: number, deliverables: Deliverable[], meetingDate: string, people: Person[] = []): ParsedLine {
  let body = line.trim();
  let kind: ItemKind | null = null;
  const tag = body.match(TAG_RE);
  if (tag) {
    kind = (Object.keys(TAGS) as ItemKind[]).find((k) => TAGS[k] === tag[1].toLowerCase()) ?? null;
    body = body.slice(tag[0].length);
  }

  const segments: Segment[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN_RE)) {
    if (m.index > last) segments.push({ type: "text", text: body.slice(last, m.index) });
    if (m[1] !== undefined) {
      const d = findDeliverable(deliverables, m[1], true);
      segments.push(d ? { type: "deliverable", id: d.id, name: d.name } : { type: "unknown", text: m[0], name: m[1].trim() });
    } else {
      const d = findDeliverable(deliverables, m[2], false);
      segments.push(d ? { type: "deliverable", id: d.id, name: d.name } : { type: "person", name: resolvePerson(m[2], people) });
    }
    last = m.index + m[0].length;
  }
  if (last < body.length) segments.push({ type: "text", text: body.slice(last) });

  // "!action @Ravi chase the vendor": the leading person is the owner, not part of the text.
  const lead = segments.findIndex((s) => s.type !== "text" || s.text.trim());
  const words = lead >= 0 && segments[lead].type === "person" ? segments.filter((_, i) => i !== lead) : segments;
  const text = words
    .map((s) => (s.type === "text" ? s.text : s.type === "unknown" ? s.name : s.name))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = kind ? text.charAt(0).toUpperCase() + text.slice(1) : text;
  const deliverable_ids = [...new Set(segments.flatMap((s) => (s.type === "deliverable" ? [s.id] : [])))];
  const owner = segments.find((s): s is Extract<Segment, { type: "person" }> => s.type === "person")?.name ?? null;
  return {
    index,
    kind,
    segments,
    text: sentence,
    owner,
    due_on: kind === "action" ? parseDue(body, meetingDate) : null,
    deliverable_ids,
    unknown: segments.flatMap((s) => (s.type === "unknown" ? [s.name] : [])),
  };
}

export function parseNotes(notes: string, deliverables: Deliverable[], meetingDate: string, people: Person[] = []): ParsedLine[] {
  return notes.split("\n").map((line, i) => parseLine(line, i, deliverables, meetingDate, people));
}

/** The register items a meeting's notes would record. */
export function itemsFromNotes(lines: ParsedLine[]): (ItemInput & { line: number })[] {
  return lines
    .filter((l) => l.kind && l.text)
    .map((l) => ({ line: l.index, kind: l.kind!, text: l.text, owner: l.owner, due_on: l.due_on, deliverable_ids: l.deliverable_ids }));
}

/** Set (or clear) the tag on line `index`. */
export function setLineTag(notes: string, index: number, kind: ItemKind | null): string {
  const lines = notes.split("\n");
  const bare = (lines[index] ?? "").trim().replace(TAG_RE, "");
  lines[index] = kind ? `${TAGS[kind]} ${bare}` : bare;
  return lines.join("\n");
}

/** How to write a deliverable in notes. */
export const mention = (name: string) => `@[${name}]`;

/** Suggested commit reason: the meeting's decisions, in order. */
export function reasonFromDecisions(items: ItemInput[]): string {
  return items
    .filter((i) => i.kind === "decision")
    .map((i) => i.text.replace(/[.\s]+$/, ""))
    .join(". ");
}
