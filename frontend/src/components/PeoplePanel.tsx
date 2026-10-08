import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { groupsOf, handle } from "../state/people";
import type { Person } from "../types";

interface Props {
  people: Person[];
  /** Names used in meetings and the register that aren't in the list yet. */
  unlisted: string[];
  onSave: (people: Person[]) => Promise<unknown>;
}

const same = (a: Person[], b: Person[]) => JSON.stringify(a) === JSON.stringify(b);

/** The project's people and their groups, edited as a list and saved together. */
export function PeoplePanel(props: Props) {
  const [draft, setDraft] = useState<Person[]>(props.people);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(props.people), [props.people]);

  const dirty = !same(draft, props.people);
  const groups = useMemo(() => groupsOf(draft), [draft]);
  const unlisted = props.unlisted.filter((n) => !draft.some((p) => p.name.trim().toLowerCase() === n.toLowerCase()));

  const set = (i: number, fields: Partial<Person>) => setDraft((d) => d.map((p, j) => (j === i ? { ...p, ...fields } : p)));
  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await props.onSave(draft.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), group: p.group?.trim() || null })));
    } catch (e) {
      setError(e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(" ") : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="register people">
      <p className="hint">
        People here are suggested when you add attendees, pick an owner, or type <code>@</code> in notes. Tag a whole group with its name, or add
        it to a meeting in one click.
      </p>
      {error && <p className="callout error small">{error}</p>}

      <datalist id="people-groups">
        {groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      {draft.length > 0 && (
        <div className="people-grid">
          <span className="muted small">Name</span>
          <span className="muted small">Group</span>
          <span className="muted small">Tag</span>
          <span />
          {draft.map((p, i) => (
            <PersonRow key={i} person={p} tag={p.name.trim() ? `@${handle(p.name, draft)}` : ""} onChange={(f) => set(i, f)} onRemove={() => setDraft((d) => d.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
      <div className="people-actions">
        <button className="small secondary" onClick={() => setDraft((d) => [...d, { name: "", group: null }])}>
          + Add person
        </button>
        {unlisted.length > 0 && (
          <button className="small secondary" title={unlisted.join(", ")} onClick={() => setDraft((d) => [...d, ...unlisted.map((name) => ({ name, group: null }))])}>
            + Add {unlisted.length} from meetings
          </button>
        )}
        <span className="spacer" />
        {dirty && (
          <button className="small secondary" onClick={() => setDraft(props.people)} disabled={saving}>
            Discard
          </button>
        )}
        <button className="small primary" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {draft.length === 0 && <p className="muted small">No one listed yet.</p>}
      <p className="muted small">Removing someone here doesn't change past meetings or register owners.</p>
    </div>
  );
}

function PersonRow(props: { person: Person; tag: string; onChange: (fields: Partial<Person>) => void; onRemove: () => void }) {
  const p = props.person;
  return (
    <>
      <input value={p.name} placeholder="Name" aria-label="Name" autoFocus={!p.name} onChange={(e) => props.onChange({ name: e.target.value })} />
      <input value={p.group ?? ""} placeholder="e.g. Data" aria-label={`${p.name || "Person"}'s group`} list="people-groups" onChange={(e) => props.onChange({ group: e.target.value })} />
      <code className="muted small">{props.tag}</code>
      <button className="link small" aria-label={`Remove ${p.name || "person"}`} onClick={props.onRemove}>
        ×
      </button>
    </>
  );
}
