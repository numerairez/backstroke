// The project's people and their groups, as offered when tagging.
// In notes a person is written `@Handle`: their first name when no one else shares it, otherwise
// their whole name run together (@RaviKumar). A group's handle tags the group (@Data).

import type { Person } from "../types";

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const firstWord = (name: string) => name.trim().split(/\s+/)[0] ?? "";
/** Letters, digits, - and _ only, so it reads back as one `@Word` token. */
const tokenize = (s: string) => s.replace(/[^\w-]/g, "").replace(/^[^A-Za-z]+/, "");

export function groupsOf(people: Person[]): string[] {
  return [...new Set(people.flatMap((p) => (p.group ? [p.group] : [])))];
}

export function membersOf(people: Person[], group: string): string[] {
  return people.filter((p) => p.group === group).map((p) => p.name);
}

/** How to tag someone in notes, without the @. */
export function handle(name: string, people: Person[]): string {
  const first = tokenize(firstWord(name));
  const shared = people.filter((p) => compact(firstWord(p.name)) === compact(first)).length > 1;
  return first && !shared ? first : tokenize(name);
}

/** The person or group an `@Word` means, or the word itself when it names neither. */
export function resolvePerson(word: string, people: Person[]): string {
  const want = compact(word);
  const exact = people.find((p) => compact(p.name) === want);
  if (exact) return exact.name;
  const byFirst = people.filter((p) => compact(firstWord(p.name)) === want);
  if (byFirst.length === 1) return byFirst[0].name;
  return groupsOf(people).find((g) => compact(g) === want) ?? word;
}

export interface PersonSuggestion {
  label: string;
  /** What to write after the @. */
  handle: string;
  detail: string;
}

/** People and groups whose name, or any word of it, starts with `query`. */
export function suggestPeople(query: string, people: Person[], limit = 6): PersonSuggestion[] {
  const q = compact(query);
  const matches = (s: string) => !q || compact(s).startsWith(q) || s.split(/\s+/).some((w) => compact(w).startsWith(q));
  const persons = people.filter((p) => matches(p.name)).map((p) => ({ label: p.name, handle: handle(p.name, people), detail: p.group ?? "" }));
  const groups = groupsOf(people)
    .filter(matches)
    .map((g) => ({ label: g, handle: tokenize(g), detail: `group · ${membersOf(people, g).length}` }));
  return [...persons, ...groups].slice(0, limit);
}

/** The `@partial` the caret sits at the end of, if any. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = text.slice(0, caret).match(/(^|[^\w@\]])@([A-Za-z][\w-]*)?$/);
  if (!m) return null;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** Everyone known: the people list first, then any other names given. */
export function knownNames(people: Person[], others: string[]): string[] {
  const seen = new Set(people.map((p) => p.name.toLowerCase()));
  return [...people.map((p) => p.name), ...others.filter((n) => n && !seen.has(n.toLowerCase()) && (seen.add(n.toLowerCase()), true))];
}
