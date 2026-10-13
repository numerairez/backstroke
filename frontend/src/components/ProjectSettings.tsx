import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type { OrgRoster, Project } from "../types";

interface Props {
  /** Only admins change projects; everyone else sees them read-only. */
  readOnly: boolean;
  projects: Project[];
  org: OrgRoster;
  /** Changes when the New project form should take focus, e.g. after + in the sidebar. */
  focusNew: number;
  /** Reload projects and people after a save. */
  onSaved: () => Promise<void>;
  onOpen: (projectId: string) => void;
  onCreate: (name: string, description: string, groups: string[]) => Promise<void>;
}

const message = (e: unknown) => (e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(" ") : (e as Error).message);

/** Everyone in any of these groups, in the organisation's order. */
const membersOf = (org: OrgRoster, groups: string[]) => org.people.filter((p) => p.groups.some((g) => groups.includes(g))).map((p) => p.name);

/** Every project: its name, what it's for, and the groups working on it. Each project saves on its own. */
export function ProjectSettings(props: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [groups, setGroups] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.focusNew) return;
    nameInput.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    nameInput.current?.focus();
  }, [props.focusNew]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      await props.onCreate(name.trim(), description.trim(), groups);
      setName("");
      setDescription("");
      setGroups([]);
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <div className="page">
      <div className="page-inner wide">
        <header className="page-head">
          <div>
            <h2>Projects</h2>
            <p className="muted">
              A project is a plan of swimlanes with its meetings and its register of actions, risks, issues and decisions. Choose the groups working on it: everyone in
              them is a member, offered as an attendee and owner, and sees it under <b>Your projects</b>. Groups and who is in them are set under <b>People</b>.
            </p>
          </div>
          {props.readOnly && (
            <>
              <span className="spacer" />
              <span className="muted small read-only-note">Only an admin can change projects.</span>
            </>
          )}
        </header>

        <div className="project-cards">
          {props.projects.map((p) => (
            <ProjectCard key={p.id} readOnly={props.readOnly} project={p} org={props.org} onSaved={props.onSaved} onOpen={() => props.onOpen(p.id)} />
          ))}
          {!props.readOnly && (
            <form className="card project-card new" onSubmit={create}>
              <h3>New project</h3>
              <label className="field">
                <span>Name</span>
                <input ref={nameInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Data Platform" />
              </label>
              <label className="field">
                <span>What it's for (optional)</span>
                <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
              </label>
              <GroupPicker org={props.org} groups={groups} label="the new project" onChange={setGroups} />
              {error && <p className="callout error small">{error}</p>}
              <div className="card-actions">
                <span className="spacer" />
                <button className="primary small" disabled={!name.trim()}>
                  Create project
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

/** The groups working on a project as removable chips, a picker for the rest, and who that makes members. */
function GroupPicker(props: { org: OrgRoster; groups: string[]; label: string; onChange: (groups: string[]) => void }) {
  const { org, groups } = props;
  const others = org.groups.filter((g) => !groups.includes(g));
  const members = membersOf(org, groups);
  // Keep groups in the organisation's order, so the list reads the same everywhere.
  const order = (names: string[]) => org.groups.filter((g) => names.includes(g));
  return (
    <>
      <div className="field">
        <span>
          Groups <span className="muted small">{groups.length}</span>
        </span>
        <div className="attendees">
          {groups.map((g) => (
            <span key={g} className="attendee group-chip">
              <span className="attendee-name">{g}</span>
              <button className="attendee-x" aria-label={`Take ${g} off ${props.label}`} onClick={() => props.onChange(groups.filter((x) => x !== g))} type="button">
                ×
              </button>
            </span>
          ))}
          {groups.length === 0 && <span className="muted small">No groups yet.</span>}
          {others.length > 0 && (
            <select className="small add-member" value="" aria-label={`Add a group to ${props.label}`} onChange={(e) => e.target.value && props.onChange(order([...groups, e.target.value]))}>
              <option value="">+ Add group…</option>
              {others.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          )}
          {org.groups.length === 0 && <span className="muted small">Create groups under People first.</span>}
        </div>
      </div>
      <p className="muted small project-members">
        {members.length ? (
          <>
            <b>{members.length}</b> member{members.length === 1 ? "" : "s"}: {members.join(", ")}
          </>
        ) : groups.length ? (
          "No one is in these groups yet."
        ) : (
          "No members until a group is added."
        )}
      </p>
    </>
  );
}

function ProjectCard(props: { readOnly: boolean; project: Project; org: OrgRoster; onSaved: () => Promise<void>; onOpen: () => void }) {
  const { project } = props;
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [groups, setGroups] = useState(project.groups);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setGroups(project.groups);
  }, [project]);

  const detailsChanged = name.trim() !== project.name || description.trim() !== project.description;
  const groupsChanged = JSON.stringify(groups) !== JSON.stringify(project.groups);
  const dirty = detailsChanged || groupsChanged;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (detailsChanged) await api.updateProject(project.id, { name: name.trim(), description: description.trim() });
      if (groupsChanged) await api.setProjectGroups(project.id, groups);
      await props.onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card project-card">
      <div className="section-head">
        <input className="project-name-input" value={name} readOnly={props.readOnly} onChange={(e) => setName(e.target.value)} aria-label="Project name" />
        <span className="spacer" />
        <button className="small link" onClick={props.onOpen}>
          Open
        </button>
      </div>
      <fieldset className="bare card-fields" disabled={props.readOnly}>
        <label className="field">
          <span>What it's for</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
        </label>
        <GroupPicker org={props.org} groups={groups} label={project.name} onChange={setGroups} />
      </fieldset>
      {error && <p className="callout error small">{error}</p>}
      <div className="card-actions">
        <span className="muted small">
          {project.version} commit{project.version === 1 ? "" : "s"} · created {project.created_at.slice(0, 10)}
        </span>
        <span className="spacer" />
        {!props.readOnly && dirty && (
          <button className="small secondary" disabled={saving} onClick={() => (setName(project.name), setDescription(project.description), setGroups(project.groups), setError(null))}>
            Discard
          </button>
        )}
        {!props.readOnly && (
          <button className="small primary" disabled={!dirty || saving || !name.trim()} onClick={save}>
            {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>
        )}
      </div>
    </section>
  );
}
