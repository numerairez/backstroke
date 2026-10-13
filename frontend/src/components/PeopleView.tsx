import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { handle, tokenize } from "../state/people";
import type { Account, OrgPerson, OrgRoster, Project } from "../types";

interface Props {
  roster: OrgRoster;
  projects: Project[];
  /** Names used in the open project's meetings and register that aren't in the organisation yet. */
  unlisted: { names: string[]; project: Project } | null;
  onSave: (roster: OrgRoster) => Promise<unknown>;
  /** Only admins change People; everyone else sees it read-only. */
  readOnly: boolean;
  /** Everyone's sign-ins, shown to admins (null for everyone else). */
  accounts: Account[] | null;
  /** The signed-in account, which can't be removed or demoted from here. */
  me: Account;
  onSetAdmin: (accountId: number, isAdmin: boolean) => Promise<unknown>;
  onRevoke: (account: Account) => Promise<unknown>;
}

const same = (a: OrgRoster, b: OrgRoster) => JSON.stringify(a) === JSON.stringify(b);
const key = (s: string) => s.trim().toLowerCase();

/** The organisation's people and groups. Projects take groups (under Settings → Projects); saved together. */
export function PeopleView(props: Props) {
  const [draft, setDraft] = useState<OrgRoster>(props.roster);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  useEffect(() => setDraft(props.roster), [props.roster]);

  const dirty = !same(draft, props.roster);
  const people = draft.people;
  const unlistedProject = props.unlisted?.project;
  const unlisted = (props.unlisted?.names ?? []).filter((n) => !people.some((p) => key(p.name) === key(n)));
  const addUnlisted = () => setDraft((d) => ({ ...d, people: [...d.people, ...unlisted.map((name) => ({ name, groups: [], projects: [] }))] }));
  /** The projects someone is on, through the groups they're in (as drafted). */
  const projectsOf = (groups: string[]) => props.projects.filter((x) => groups.some((g) => draft.projects_by_group[g]?.includes(x.id)));
  const duplicates = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of people) if (p.name.trim()) seen.set(key(p.name), (seen.get(key(p.name)) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  }, [people]);
  const clashes = new Set(draft.groups.map(key).filter((g) => people.some((p) => key(p.name) === g)));

  const setPerson = (i: number, fields: Partial<OrgPerson>) => setDraft((d) => ({ ...d, people: d.people.map((p, j) => (j === i ? { ...p, ...fields } : p)) }));
  /** Put `name` in `group`, adding the group to the list when it's new. */
  const join = (i: number, group: string) => {
    const g = group.trim();
    if (!g) return;
    setDraft((d) => {
      const existing = d.groups.find((x) => key(x) === key(g)) ?? g;
      return {
        ...d,
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
    // The group keeps its projects under its new name.
    setDraft((d) => ({
      groups: d.groups.map((g) => (g === from ? t : g)),
      people: d.people.map((p) => ({ ...p, groups: p.groups.map((g) => (g === from ? t : g)) })),
      projects_by_group: Object.fromEntries(Object.entries(d.projects_by_group).map(([g, ps]) => [g === from ? t : g, ps])),
    }));
  };
  const removeGroup = (group: string) =>
    setDraft((d) => ({
      groups: d.groups.filter((g) => g !== group),
      people: d.people.map((p) => ({ ...p, groups: p.groups.filter((g) => g !== group) })),
      projects_by_group: Object.fromEntries(Object.entries(d.projects_by_group).filter(([g]) => g !== group)),
    }));
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

  /** Sign-in changes apply at once, apart from the roster draft. */
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(" ") : (e as Error).message);
    }
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await props.onSave({
        people: people.filter((p) => p.name.trim()).map((p) => ({ id: p.id, name: p.name.trim(), groups: p.groups, projects: [] })),
        groups: draft.groups,
        projects_by_group: draft.projects_by_group,
      });
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
              Everyone in the organisation, listed once, in any number of groups. Projects take groups (under <b>Projects</b>), so putting someone in a group puts them
              on its projects: they're offered as attendees and owners there, and see the project in their sidebar. Tag a group with its name to mean everyone in it.
            </p>
          </div>
          <span className="spacer" />
          {props.readOnly ? (
            <span className="muted small read-only-note">Only an admin can change people and groups.</span>
          ) : (
            <>
              {dirty && (
                <button className="secondary" onClick={() => (setDraft(props.roster), setError(null))} disabled={saving}>
                  Discard
                </button>
              )}
              <button className="primary" onClick={save} disabled={!dirty || saving || duplicates.size > 0 || clashes.size > 0}>
                {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
              </button>
            </>
          )}
        </header>
        {error && <p className="callout error small">{error}</p>}

        <fieldset className="bare" disabled={props.readOnly}>
          <div className="people-layout">
            <section className="card">
              <div className="section-head">
                <h3>
                  People <span className="muted small">{named.length}</span>
                </h3>
                <span className="spacer" />
                {unlisted.length > 0 && unlistedProject && (
                  <button
                    className="small secondary"
                    title={`Named in ${unlistedProject.name}'s meetings or register: ${unlisted.join(", ")}. Put them in one of its groups to make them members.`}
                    onClick={addUnlisted}
                  >
                    + Add {unlisted.length} from {unlistedProject.name}
                  </button>
                )}
                <button className="small" onClick={() => setDraft((d) => ({ ...d, people: [...d.people, { name: "", groups: [], projects: [] }] }))}>
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
                      <th>Projects</th>
                      <th>Tag</th>
                      {props.accounts && <th>Sign-in</th>}
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
                        projects={projectsOf(p.groups)}
                        onRemove={() => setDraft((d) => ({ ...d, people: d.people.filter((_, j) => j !== i) }))}
                        accounts={props.accounts}
                        me={props.me}
                        onSetAdmin={(id, on) => run(() => props.onSetAdmin(id, on))}
                        onRevoke={(a) => run(() => props.onRevoke(a))}
                      />
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted small">
                Removing someone doesn't change past meetings or register owners, but it does remove their sign-in. People register themselves with the name listed here.
              </p>
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
                      {(draft.projects_by_group[g]?.length ?? 0) > 0 && (
                        <div className="muted small">On {projectsOf([g]).map((x) => x.name).join(", ")}</div>
                      )}
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
        </fieldset>
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
  person: OrgPerson;
  /** The projects their groups work on. */
  projects: Project[];
  tag: string;
  problem: string | null;
  onName: (name: string) => void;
  onJoin: (group: string) => void;
  onLeave: (group: string) => void;
  onRemove: () => void;
  accounts: Account[] | null;
  me: Account;
  onSetAdmin: (accountId: number, isAdmin: boolean) => void;
  onRevoke: (account: Account) => void;
}) {
  const p = props.person;
  const account = props.accounts?.find((a) => p.id !== undefined && a.person_id === p.id) ?? null;
  const isMe = p.id === props.me.person_id;
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
        <div className="attendees">
          {props.projects.map((x) => (
            <span key={x.id} className="attendee project-chip" title={`Through ${p.groups.join(", ")}`}>
              <span className="attendee-name">{x.name}</span>
            </span>
          ))}
          {props.projects.length === 0 && <span className="muted small">None</span>}
        </div>
      </td>
      <td>
        <code className="muted small">{props.tag}</code>
      </td>
      {props.accounts && (
        <td>
          <div className="signin-cell">
            {account ? (
              <>
                <span className="small" title={account.email}>
                  {account.email}
                </span>
                <label className="small admin-toggle" title={isMe ? "Ask another admin to change your own rights" : undefined}>
                  <input type="checkbox" checked={account.is_admin} disabled={isMe} onChange={(e) => props.onSetAdmin(account.id, e.target.checked)} /> Admin
                </label>
                {!isMe && (
                  <button
                    className="small link"
                    title="Remove their sign-in so they can register again, e.g. after forgetting their password"
                    onClick={() => window.confirm(`Reset ${p.name}'s sign-in? They'll be signed out and can register again.`) && props.onRevoke(account)}
                  >
                    Reset
                  </button>
                )}
              </>
            ) : (
              <span className="muted small">{p.id === undefined ? "Save first" : "Not registered"}</span>
            )}
          </div>
        </td>
      )}
      <td>
        <button className="icon" aria-label={`Remove ${p.name || "person"}`} title={isMe ? "You can't remove yourself" : "Remove"} disabled={isMe} onClick={props.onRemove}>
          ×
        </button>
      </td>
    </tr>
  );
}
