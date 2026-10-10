import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { handle, tokenize } from "../state/people";
import type { Person, Roster } from "../types";

interface Props {
  roster: Roster;
  /** Names used in meetings and the register that aren't in the list yet. */
  unlisted: string[];
  onSave: (roster: Roster) => Promise<unknown>;
}

const same = (a: Roster, b: Roster) => JSON.stringify(a) === JSON.stringify(b);
const key = (s: string) => s.trim().toLowerCase();

/** The project's people and groups. Someone can be in any number of groups. Saved together. */
export function PeopleView(props: Props) {
  const [draft, setDraft] = useState<Roster>(props.roster);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  useEffect(() => setDraft(props.roster), [props.roster]);

  const dirty = !same(draft, props.roster);
  const people = draft.people;
  const unlisted = props.unlisted.filter((n) => !people.some((p) => key(p.name) === key(n)));
  const duplicates = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of people) if (p.name.trim()) seen.set(key(p.name), (seen.get(key(p.name)) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  }, [people]);
  const clashes = new Set(draft.groups.map(key).filter((g) => people.some((p) => key(p.name) === g)));

  const setPerson = (i: number, fields: Partial<Person>) => setDraft((d) => ({ ...d, people: d.people.map((p, j) => (j === i ? { ...p, ...fields } : p)) }));
  /** Put `name` in `group`, adding the group to the list when it's new. */
  const join = (i: number, group: string) => {
    const g = group.trim();
    if (!g) return;
    setDraft((d) => {
      const existing = d.groups.find((x) => key(x) === key(g)) ?? g;
      return {
        groups: d.groups.some((x) => key(x) === key(g)) ? d.groups : [...d.groups, g],
        people: d.people.map((p, j) => (j === i && !p.groups.includes(existing) ? { ...p, groups: [...p.groups, existing] } : p)),
      };
    });
  };
  const leave = (i: number, group: string) => setPerson(i, { groups: people[i].groups.filter((g) => g !== group) });
  const toggleMember = (group: string, name: string) =>
    setDraft((d) => ({
      ...d,
      people: d.people.map((p) => (p.name !== name ? p : { ...p, groups: p.groups.includes(group) ? p.groups.filter((g) => g !== group) : [...p.groups, group] })),
    }));
  const renameGroup = (from: string, to: string) => {
    const t = to.trim();
    if (!t || t === from) return;
    if (draft.groups.some((g) => g !== from && key(g) === key(t))) {
      setError(`There's already a group called ${t}.`);
      return;
    }
    setError(null);
    setDraft((d) => ({ groups: d.groups.map((g) => (g === from ? t : g)), people: d.people.map((p) => ({ ...p, groups: p.groups.map((g) => (g === from ? t : g)) })) }));
  };
  const removeGroup = (group: string) => setDraft((d) => ({ groups: d.groups.filter((g) => g !== group), people: d.people.map((p) => ({ ...p, groups: p.groups.filter((g) => g !== group) })) }));
  const moveGroup = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const groups = [...d.groups];
      [groups[i], groups[i + dir]] = [groups[i + dir], groups[i]];
      return { ...d, groups };
    });
  const addGroup = (e: React.FormEvent) => {
    e.preventDefault();
    const g = newGroup.trim();
    if (!g) return;
    if (!draft.groups.some((x) => key(x) === key(g))) setDraft((d) => ({ ...d, groups: [...d.groups, g] }));
    setNewGroup("");
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await props.onSave({ people: people.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), groups: p.groups })), groups: draft.groups });
    } catch (e) {
      setError(e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(" ") : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const named = people.filter((p) => p.name.trim());

  return (
    <div className="page">
      <div className="page-inner wide people">
        <header className="page-head">
          <div>
            <h2>People</h2>
            <p className="muted">
              Suggested when you add attendees, pick an owner, or type <code>@</code> in notes. Tag a group with its name to mean everyone in it, or add the whole group to a
              meeting in one click. Someone can be in more than one group.
            </p>
          </div>
          <span className="spacer" />
          {dirty && (
            <button className="secondary" onClick={() => (setDraft(props.roster), setError(null))} disabled={saving}>
              Discard
            </button>
          )}
          <button className="primary" onClick={save} disabled={!dirty || saving || duplicates.size > 0 || clashes.size > 0}>
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </header>
        {error && <p className="callout error small">{error}</p>}

        <div className="people-layout">
          <section className="card">
            <div className="section-head">
              <h3>
                People <span className="muted small">{named.length}</span>
              </h3>
              <span className="spacer" />
              {unlisted.length > 0 && (
                <button className="small secondary" title={unlisted.join(", ")} onClick={() => setDraft((d) => ({ ...d, people: [...d.people, ...unlisted.map((name) => ({ name, groups: [] }))] }))}>
                  + Add {unlisted.length} from meetings
                </button>
              )}
              <button className="small" onClick={() => setDraft((d) => ({ ...d, people: [...d.people, { name: "", groups: [] }] }))}>
                + Add person
              </button>
            </div>
            <datalist id="people-groups">
              {draft.groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            {people.length === 0 ? (
              <p className="muted small">No one listed yet.</p>
            ) : (
              <table className="people-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Groups</th>
                    <th>Tag</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {people.map((p, i) => (
                    <PersonRow
                      key={i}
                      person={p}
                      tag={p.name.trim() ? `@${handle(p.name, people)}` : ""}
                      problem={duplicates.has(key(p.name)) ? "Listed twice" : clashes.has(key(p.name)) ? "Same name as a group" : null}
                      onName={(name) => setPerson(i, { name })}
                      onJoin={(g) => join(i, g)}
                      onLeave={(g) => leave(i, g)}
                      onRemove={() => setDraft((d) => ({ ...d, people: d.people.filter((_, j) => j !== i) }))}
                    />
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted small">Removing someone here doesn't change past meetings or register owners.</p>
          </section>

          <section className="card">
            <div className="section-head">
              <h3>
                Groups <span className="muted small">{draft.groups.length}</span>
              </h3>
            </div>
            <form className="inline-form" onSubmit={addGroup}>
              <input placeholder="New group, e.g. Steering" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} aria-label="New group name" />
              <button className="small" disabled={!newGroup.trim()}>
                Add
              </button>
            </form>
            {draft.groups.length === 0 && <p className="muted small">No groups yet.</p>}
            <ul className="group-list">
              {draft.groups.map((g, i) => {
                const members = named.filter((p) => p.groups.includes(g));
                const others = named.filter((p) => !p.groups.includes(g));
                return (
                  <li key={g} className={clashes.has(key(g)) ? "problem" : ""}>
                    <div className="group-head">
                      <GroupName name={g} onRename={(to) => renameGroup(g, to)} />
                      <code className="muted small">@{tokenize(g)}</code>
                      <span className="spacer" />
                      <button className="icon" title="Move up" disabled={i === 0} onClick={() => moveGroup(i, -1)}>
                        ↑
                      </button>
                      <button className="icon" title="Move down" disabled={i === draft.groups.length - 1} onClick={() => moveGroup(i, 1)}>
                        ↓
                      </button>
                      <button className="icon" title={`Delete ${g} (people stay)`} onClick={() => removeGroup(g)}>
                        ×
                      </button>
                    </div>
                    <div className="attendees">
                      {members.map((p) => (
                        <span key={p.name} className="attendee">
                          <span className="attendee-name">{p.name}</span>
                          <button className="attendee-x" aria-label={`Take ${p.name} out of ${g}`} onClick={() => toggleMember(g, p.name)}>
                            ×
                          </button>
                        </span>
                      ))}
                      {members.length === 0 && <span className="muted small">No one yet.</span>}
                      {others.length > 0 && (
                        <select className="small add-member" value="" aria-label={`Add someone to ${g}`} onChange={(e) => e.target.value && toggleMember(g, e.target.value)}>
                          <option value="">+ Add…</option>
                          {others.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function GroupName(props: { name: string; onRename: (to: string) => void }) {
  const [draft, setDraft] = useState(props.name);
  useEffect(() => setDraft(props.name), [props.name]);
  return (
    <input
      className="group-name"
      value={draft}
      aria-label="Group name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => (draft.trim() ? props.onRename(draft) : setDraft(props.name))}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(props.name);
      }}
    />
  );
}

function PersonRow(props: {
  person: Person;
  tag: string;
  problem: string | null;
  onName: (name: string) => void;
  onJoin: (group: string) => void;
  onLeave: (group: string) => void;
  onRemove: () => void;
}) {
  const p = props.person;
  const [adding, setAdding] = useState("");
  const submit = () => {
    if (adding.trim()) props.onJoin(adding);
    setAdding("");
  };
  return (
    <tr className={props.problem ? "problem" : ""}>
      <td>
        <input value={p.name} placeholder="Name" aria-label="Name" autoFocus={!p.name} onChange={(e) => props.onName(e.target.value)} title={props.problem ?? undefined} />
        {props.problem && <div className="error-text small">{props.problem}</div>}
      </td>
      <td>
        <div className="attendees">
          {p.groups.map((g) => (
            <span key={g} className="attendee group-chip">
              <span className="attendee-name">{g}</span>
              <button className="attendee-x" aria-label={`Take ${p.name || "them"} out of ${g}`} onClick={() => props.onLeave(g)}>
                ×
              </button>
            </span>
          ))}
          <input
            className="group-input"
            value={adding}
            placeholder={p.groups.length ? "+ group" : "Add a group"}
            aria-label={`Add ${p.name || "this person"} to a group`}
            list="people-groups"
            onChange={(e) => setAdding(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
      </td>
      <td>
        <code className="muted small">{props.tag}</code>
      </td>
      <td>
        <button className="icon" aria-label={`Remove ${p.name || "person"}`} title="Remove" onClick={props.onRemove}>
          ×
        </button>
      </td>
    </tr>
  );
}
