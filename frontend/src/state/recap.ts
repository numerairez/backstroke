// Turning a meeting recap (e.g. from Copilot in Teams) into notes markup, without AI.
// Lines are tagged from the recap's own headings ("Follow-up tasks", "Decisions", "Risks", "Issues")
// and a few plain keywords; deliverable and people names are matched exactly.

import type { Deliverable } from "../types";
import { mention, TAG_RE, TAGS } from "./notes";

export interface RecapLine {
  /** The line in notes markup, ready to append. */
  line: string;
  /** Why it was tagged, shown in the preview. Empty for plain notes. */
  why: string;
}

const BULLET_RE = /^(?:[-*•‣◦]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const DECIDED_RE = /\b(agreed|decided|approved)\b/i;

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const firstName = (name: string) => name.trim().split(/\s+/)[0];

type Section = "action" | "risk" | "issue" | "decision" | null;

function sectionOf(heading: string): Section {
  if (/follow|action|task|next step|to.?do/i.test(heading)) return "action";
  if (/decision|agreed/i.test(heading)) return "decision";
  // "Risks and issues" stays risks, as before; a heading of only issues or blockers is issues.
  if (/risk|concern/i.test(heading)) return "risk";
  if (/issue|blocker|problem/i.test(heading)) return "issue";
  return null;
}

const SECTION_WORDS = /follow|action|task|next step|to.?do|decision|risk|issue|concern|blocker|problem|notes|summary|discussion|recap|topics|agenda/i;

/**
 * A heading: "## Notes", "**Decisions**", "Follow-up tasks:", or a short line naming a known section.
 * Other short lines stay notes, so nothing the recap says is dropped.
 */
function headingText(line: string): string | null {
  if (BULLET_RE.test(line) || TAG_RE.test(line)) return null;
  const bare = line.replace(/^#+\s*/, "").replace(/\*\*|__/g, "").replace(/:\s*$/, "").trim();
  if (!bare || bare.length >= 60) return null;
  const marked = /^#/.test(line) || /^(\*\*|__).+(\*\*|__):?$/.test(line) || /:\s*$/.test(line);
  const named = bare.length < 40 && !/[.!?]$/.test(bare) && SECTION_WORDS.test(bare);
  return marked || named ? bare : null;
}

/** Write each deliverable name as a mention, longest names first so "Data Mapping" wins over "Data". */
function linkDeliverables(text: string, deliverables: Deliverable[]): string {
  let out = text;
  for (const d of [...deliverables].sort((a, b) => b.name.length - a.name.length)) {
    if (!d.name.trim()) continue;
    const re = new RegExp(`(?<![@\\[\\w-])${reEscape(d.name.trim())}(?![\\w\\]-])`, "gi");
    out = out.replace(re, mention(d.name));
  }
  return out;
}

/** The person named first in the line, matched by full or first name. */
function firstPerson(text: string, people: string[]): string | null {
  let best: { name: string; at: number } | null = null;
  for (const name of people) {
    for (const candidate of new Set([name.trim(), firstName(name)])) {
      if (!candidate) continue;
      const at = text.search(new RegExp(`\\b${reEscape(candidate)}\\b`, "i"));
      if (at >= 0 && (!best || at < best.at)) best = { name: firstName(name), at };
    }
  }
  return best?.name ?? null;
}

export function importRecap(text: string, deliverables: Deliverable[], people: string[]): RecapLine[] {
  const out: RecapLine[] = [];
  let section: Section = null;
  let heading = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = headingText(line);
    if (h !== null) {
      heading = h;
      section = sectionOf(h);
      continue;
    }
    const body = linkDeliverables(line.replace(BULLET_RE, "").replace(/\*\*|__/g, ""), deliverables);
    if (TAG_RE.test(body)) {
      out.push({ line: body, why: "already tagged" });
      continue;
    }
    const decided = section ? null : body.match(DECIDED_RE);
    const kind = section ?? (decided ? "decision" : null);
    if (!kind) {
      out.push({ line: body, why: "" });
      continue;
    }
    const why = section ? `under “${heading}”` : `says “${decided?.[1].toLowerCase()}”`;
    const owner = kind === "action" ? firstPerson(body, people) : null;
    out.push({ line: `${TAGS[kind]} ${owner ? `@${owner} ` : ""}${body}`, why });
  }
  return out;
}

/** Append imported lines after the existing notes, separated by a blank line. */
export function appendToNotes(notes: string, lines: RecapLine[]): string {
  const added = lines.map((l) => l.line).join("\n");
  if (!added) return notes;
  return notes.trim() ? `${notes.replace(/\s+$/, "")}\n\n${added}` : added;
}

/** A prompt for Copilot (or any assistant) that makes it write the recap in Backstroke's markup. */
export function copilotPrompt(deliverables: Deliverable[], people: string[]): string {
  const names = people.map(firstName).filter(Boolean);
  return [
    "Summarise this meeting for Backstroke. Output plain text with one item per line and no headings, bullets or numbering.",
    "- Start an action with !action, a risk (might go wrong) with ?risk, an issue (already going wrong) with !issue and a decision with =decision. Every other line is a note.",
    names.length
      ? `- Put the owner straight after the tag as @Name. Use only these names: ${names.join(", ")}.`
      : "- Put the owner straight after the tag as @Name, using their first name.",
    '- Write due dates as "by Fri" or "by 14 Oct".',
    deliverables.length
      ? `- When a line is about one of these deliverables, write it exactly as shown: ${deliverables.map((d) => mention(d.name)).join(", ")}.`
      : "",
    "- Only include what was said in the meeting. Don't add advice or items nobody raised.",
  ]
    .filter(Boolean)
    .join("\n");
}
