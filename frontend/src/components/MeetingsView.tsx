import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { formatDate, formatTimestamp } from "../state/dates";
import { itemsFromNotes, mention, parseLine, parseNotes, setLineTag, TAG_RE, TAGS, type ParsedLine } from "../state/notes";
import { groupsOf, knownNames, membersOf, mentionAt, suggestPeople } from "../state/people";
import { appendToNotes, copilotPrompt, importRecap } from "../state/recap";
import type { MeetingsStore } from "../state/useMeetings";
import type { Deliverable, ItemKind, Meeting, Person } from "../types";
import { ItemRow, KindTag, isOverdue } from "./RegisterView";
import { PreReadPanel } from "./Trail";

interface Props {
  projectId: string;
  /** Changes when the plan or register does, so the pre-read reloads. */
  refreshKey: string;
  store: MeetingsStore;
  /** Deliverables as staged, so new ones can be mentioned. */
  deliverables: Deliverable[];
  today: string;
  openId: number | null;
  onOpen: (meetingId: number | null) => void;
  /** Set when a bar is clicked on the timeline; inserted at the cursor. */
  mentionRequest: { name: string; nonce: number } | null;
  stagedCount: number;
  onReviewChanges: () => void;
  onFinish: (meeting: Meeting) => void;
  onViewCommit: (seq: number) => void;
  onSelectDeliverable: (id: string) => void;
}

/** The Meetings tab beside the plan: the list, or one meeting's notes. */
export function MeetingsView(props: Props) {
  const meeting = props.store.meetings.find((m) => m.id === props.openId) ?? null;
  return meeting ? <MeetingEditor {...props} meeting={meeting} /> : <MeetingList {...props} />;
}

function MeetingList(props: Props) {
  const titles = [...new Set(props.store.meetings.map((m) => m.title))];
  const [title, setTitle] = useState(titles[0] ?? "");
  const [heldOn, setHeldOn] = useState(props.today);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setError(null);
    try {
      const m = await props.store.create(title.trim(), heldOn);
      props.onOpen(m.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const inProgress = props.store.meetings.filter((m) => !m.finished_at);
  const finished = props.store.meetings.filter((m) => m.finished_at);

  return (
    <div className="meetings">
        <form className="meeting-new" onSubmit={create}>
          <div className="field-row">
            <label className="field">
              <span>New meeting</span>
              <input list="meeting-titles" value={title} placeholder="e.g. Steering committee" onChange={(e) => setTitle(e.target.value)} />
              <datalist id="meeting-titles">
                {titles.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <label className="field date">
              <span>Date</span>
              <input type="date" value={heldOn} onChange={(e) => setHeldOn(e.target.value)} />
            </label>
          </div>
          <button className="primary small" disabled={!title.trim() || !heldOn}>
            Start meeting
          </button>
          <p className="muted small">A meeting with the same title as an earlier one starts with its attendees. Actions, risks, issues and decisions go to the register when it finishes.</p>
        </form>
        {error && <p className="callout error small">{error}</p>}
        {props.store.error && <p className="callout error small">{props.store.error}</p>}

        {props.store.meetings.length === 0 && <p className="hint">No meetings yet. Start one to take notes beside the plan.</p>}
        {[
          ["In progress", inProgress],
          ["Finished", finished],
        ].map(([label, list]) =>
          (list as Meeting[]).length === 0 ? null : (
            <section key={label as string}>
              <h4>{label as string}</h4>
              <ul className="meeting-list">
                {(list as Meeting[]).map((m) => (
                  <li key={m.id}>
                    <button className="meeting-row" onClick={() => props.onOpen(m.id)}>
                      <span className="meeting-title">{m.title}</span>
                      <span className="muted">
                        {formatDate(m.held_on)} {m.held_on.slice(0, 4)}
                      </span>
                      <span className="meeting-sub small">
                        {m.attendees.filter((a) => a.present).length} attending
                        {m.finished_at ? (
                          <>
                            {" "}· {m.items.length} item{m.items.length === 1 ? "" : "s"}
                            {m.commit_seq !== null && <> · plan commit #{m.commit_seq}</>}
                          </>
                        ) : (
                          <>
                            {" "}· <span className="in-progress">In progress</span>
                          </>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}
    </div>
  );
}

function MeetingEditor(props: Props & { meeting: Meeting }) {
  const { meeting, store } = props;
  const finished = meeting.finished_at !== null;
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const [newName, setNewName] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = store.people;

  const lines = useMemo(() => parseNotes(meeting.notes, props.deliverables, meeting.held_on, people), [meeting.notes, props.deliverables, meeting.held_on, people]);
  const items = useMemo(() => itemsFromNotes(lines), [lines]);
  const byId = useMemo(() => new Map(props.deliverables.map((d) => [d.id, d])), [props.deliverables]);
  const carried = store.register.filter((i) => i.kind === "action" && i.open && i.meeting?.id !== meeting.id);

  const setNotes = (notes: string) => store.edit(meeting.id, { notes });

  // A bar clicked on the timeline is written in at the cursor.
  const handled = useRef<number | null>(props.mentionRequest?.nonce ?? null);
  useEffect(() => {
    const req = props.mentionRequest;
    const el = notesRef.current;
    if (!req || req.nonce === handled.current || !el) return;
    handled.current = req.nonce;
    const at = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, at);
    const insert = `${before && !/\s$/.test(before) ? " " : ""}${mention(req.name)} `;
    setNotes(before + insert + el.value.slice(el.selectionEnd ?? at));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + insert.length, at + insert.length);
    });
  }, [props.mentionRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tag buttons toggle the tag on the line the cursor is on.
  const tagCurrentLine = (kind: ItemKind) => {
    const el = notesRef.current;
    if (!el) return;
    const index = el.value.slice(0, el.selectionStart).split("\n").length - 1;
    const current = lines[index]?.kind ?? null;
    setNotes(setLineTag(meeting.notes, index, current === kind ? null : kind));
    requestAnimationFrame(() => el.focus());
  };

  const setAttendees = (attendees: Meeting["attendees"]) => store.edit(meeting.id, { attendees });
  const attending = (name: string) => meeting.attendees.some((a) => a.name.toLowerCase() === name.toLowerCase());
  const addAttendees = (names: string[]) => {
    const add = [...new Set(names.map((n) => n.trim()).filter((n) => n && !attending(n)))];
    if (add.length) setAttendees([...meeting.attendees, ...add.map((name) => ({ name, present: true }))]);
  };
  const addAttendee = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    // A group's name adds everyone in it.
    const group = groupsOf(people).find((g) => g.toLowerCase() === name.toLowerCase());
    addAttendees(group ? membersOf(people, group) : [name]);
    setNewName("");
  };
  const groupsToAdd = groupsOf(people).filter((g) => membersOf(people, g).some((n) => !attending(n)));

  const markDone = async (itemId: number) => {
    setError(null);
    try {
      await store.updateItem(itemId, { outcome: "done", closed_on: meeting.held_on, meeting_id: meeting.id });
    } catch (e) {
      setError(e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(" ") : (e as Error).message);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${meeting.title}” on ${formatDate(meeting.held_on)} and its notes?`)) return;
    await store.remove(meeting.id);
    props.onOpen(null);
  };

  return (
    <div className="meeting">
      <div className="meeting-top">
        <button className="link small" onClick={() => (void store.flush(), props.onOpen(null))}>
          ← All meetings
        </button>
        {finished ? <span className="finished-chip small">Finished {formatTimestamp(meeting.finished_at!)}</span> : <span className="in-progress small">In progress</span>}
        <span className={`save-state small ${store.saveState}`}>
          {store.saveState === "saving" ? "Saving…" : store.saveState === "failed" ? "Not saved. Retrying on next edit" : "Saved"}
        </span>
        <span className="spacer" />
        {!finished && (
          <>
            <button className="danger small" onClick={remove}>
              Delete
            </button>
            <button className="primary small" onClick={async () => (await store.flush(), props.onFinish(meeting))}>
              Finish meeting…
            </button>
          </>
        )}
      </div>
      <div className="meeting-heading">
        <input className="meeting-title-input" value={meeting.title} disabled={finished} aria-label="Meeting title" onChange={(e) => store.edit(meeting.id, { title: e.target.value })} />
        <input type="date" value={meeting.held_on} disabled={finished} aria-label="Meeting date" onChange={(e) => e.target.value && store.edit(meeting.id, { held_on: e.target.value })} />
      </div>

      {/* Stacked in a narrow panel; three columns (context | notes | people) once it's wide. */}
      <div className="meeting-body">
          <aside className="meeting-area context-area">
            {finished ? (
              <section className="meeting-section">
                <h3>Recorded</h3>
                {meeting.commit_seq !== null ? (
                  <button className="link small" onClick={() => props.onViewCommit(meeting.commit_seq!)}>
                    Plan commit #{meeting.commit_seq} · {meeting.reference}
                  </button>
                ) : (
                  <p className="muted small">No plan changes.</p>
                )}
                {meeting.items.length === 0 ? (
                  <p className="muted small">No actions, risks, issues or decisions.</p>
                ) : (
                  <ul className="reg-list">
                    {meeting.items.map((i) => (
                      <ItemRow key={i.id} item={i} deliverables={byId} today={props.today} showMeeting={false} onSelectDeliverable={props.onSelectDeliverable} />
                    ))}
                  </ul>
                )}
              </section>
            ) : (
              <PreReadPanel
                projectId={props.projectId}
                meetingId={meeting.id}
                title={meeting.title}
                refreshKey={`${props.refreshKey}|${meeting.held_on}|${meeting.title}`}
                onViewCommit={props.onViewCommit}
                onSelectDeliverable={props.onSelectDeliverable}
              />
            )}

            {!finished && carried.length > 0 && (
              <section className="meeting-section">
                <h3>
                  Open actions <span className="muted small">{carried.length}</span>
                </h3>
                <ul className="carried">
                  {carried.map((i) => (
                    <li key={i.id} className={isOverdue(i, meeting.held_on) ? "overdue" : ""}>
                      <button className="small done-btn" onClick={() => markDone(i.id)} title={`Mark ${i.ref} done on ${formatDate(meeting.held_on)}`}>
                        Done
                      </button>
                      <KindTag kind="action">{i.ref}</KindTag>
                      <span className="carried-text">
                        {i.text}
                        <span className="muted small">
                          {i.owner && ` · ${i.owner}`}
                          {i.due_on && ` · due ${formatDate(i.due_on)}`}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {error && <p className="callout error small">{error}</p>}
          </aside>

          <section className="meeting-area notes-area">
            <div className="section-head">
              <h3>Notes</h3>
              {!finished && (
                <button className="small secondary" aria-expanded={importing} onClick={() => setImporting((v) => !v)}>
                  {importing ? "Close import" : "Import recap"}
                </button>
              )}
            </div>
            {importing && (
              <RecapImport
                deliverables={props.deliverables}
                people={knownNames(people, meeting.attendees.map((a) => a.name))}
                roster={people}
                meetingDate={meeting.held_on}
                onAdd={(added) => {
                  setNotes(appendToNotes(meeting.notes, added));
                  setImporting(false);
                }}
              />
            )}
            <div className="notes-wrap">
              <MentionTextarea
                textareaRef={notesRef}
                className="notes-input"
                value={meeting.notes}
                people={people}
                spellCheck
                placeholder={"One point per line. Start a line with !action, ?risk, !issue or =decision.\nClick a bar on the plan to mention it. Type @ to tag someone or a group."}
                onChange={setNotes}
                onBlur={() => void store.flush()}
              />
            </div>
            {!finished ? (
              <div className="notes-hints small">
                <span className="muted">Tag the current line:</span>
                {(Object.keys(TAGS) as ItemKind[]).map((k) => (
                  <button key={k} type="button" className={`tag-btn ${k}`} onMouseDown={(e) => e.preventDefault()} onClick={() => tagCurrentLine(k)}>
                    {TAGS[k]}
                  </button>
                ))}
                <span className="muted">
                  <code>@Ravi</code> or a group assigns · <code>by Fri</code> sets a due date
                </span>
              </div>
            ) : (
              <p className="muted small">Notes stay editable. The items under Recorded were captured when the meeting finished and don't change with the notes.</p>
            )}
          </section>

          <section className="meeting-area people-area meeting-section">
              <h3>
                Participants{" "}
                <span className="muted small">
                  {meeting.attendees.filter((a) => a.present).length} of {meeting.attendees.length} here
                </span>
              </h3>
              <p className="participants" title="Click a name to mark them absent or present. Hover a name to remove it.">
                {meeting.attendees.length === 0 && <span className="muted">No one yet. </span>}
                {meeting.attendees.map((a, i) => (
                  <span key={a.name} className={`participant ${a.present ? "" : "absent"}`}>
                    <button
                      className="participant-name"
                      title={a.present ? "Present. Click to mark absent" : "Absent. Click to mark present"}
                      onClick={() => setAttendees(meeting.attendees.map((x) => (x.name === a.name ? { ...x, present: !x.present } : x)))}
                    >
                      {a.name}
                    </button>
                    <button className="participant-x" aria-label={`Remove ${a.name}`} title={`Remove ${a.name}`} onClick={() => setAttendees(meeting.attendees.filter((x) => x.name !== a.name))}>
                      ×
                    </button>
                    {i < meeting.attendees.length - 1 && <span className="participant-sep">, </span>}
                  </span>
                ))}
              </p>
              <div className="participants-add">
                <form onSubmit={addAttendee}>
                  <input className="small" value={newName} placeholder="+ name or group" aria-label="Add participant" list="meeting-people" onChange={(e) => setNewName(e.target.value)} />
                  <datalist id="meeting-people">
                    {people
                      .filter((p) => !attending(p.name))
                      .map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.groups.join(", ")}
                        </option>
                      ))}
                    {groupsToAdd.map((g) => (
                      <option key={`group:${g}`} value={g}>
                        group: {membersOf(people, g).join(", ")}
                      </option>
                    ))}
                  </datalist>
                </form>
                {groupsToAdd.map((g) => (
                  <button key={g} className="link small" title={`Add ${membersOf(people, g).filter((n) => !attending(n)).join(", ")}`} onClick={() => addAttendees(membersOf(people, g))}>
                    + {g}
                  </button>
                ))}
              </div>
          </section>

          {!finished && (
            <div className="meeting-area picked-area">
                <section className="meeting-section">
                  <h3>
                    Picked up from the notes <span className="muted small">{items.length}</span>
                  </h3>
                  {items.length === 0 ? (
                    <p className="muted small">Lines starting with !action, ?risk, !issue or =decision appear here.</p>
                  ) : (
                    <ul className="picked">
                      {lines
                        .filter((l) => l.kind && l.text)
                        .map((l) => (
                          <PickedLine key={l.index} line={l} onTag={(k) => setNotes(setLineTag(meeting.notes, l.index, k))} onSelectDeliverable={props.onSelectDeliverable} />
                        ))}
                    </ul>
                  )}
                </section>

                <section className="meeting-section">
                  <h3>Plan changes</h3>
                  {props.stagedCount > 0 ? (
                    <p className="small">
                      {props.stagedCount} staged change{props.stagedCount === 1 ? "" : "s"} can be committed with this meeting.{" "}
                      <button className="link" onClick={props.onReviewChanges}>
                        Review
                      </button>
                    </p>
                  ) : (
                    <p className="muted small">None staged. Drag bars on the plan, or right-click one, to stage the changes agreed here.</p>
                  )}
                </section>
            </div>
          )}
      </div>
    </div>
  );
}

const NEXT: Record<ItemKind, ItemKind | null> = { action: "risk", risk: "issue", issue: "decision", decision: null };

function PickedLine(props: { line: ParsedLine; onTag: (kind: ItemKind | null) => void; onSelectDeliverable: (id: string) => void }) {
  const l = props.line;
  return (
    <li>
      <button className={`kind-tag ${l.kind} as-button`} title="Change type" onClick={() => props.onTag(NEXT[l.kind!])}>
        {l.kind}
      </button>
      <span className="picked-text">
        {l.segments.map((s, i) =>
          s.type === "deliverable" ? (
            <button key={i} className="deliv-chip" onClick={() => props.onSelectDeliverable(s.id)}>
              {s.name}
            </button>
          ) : s.type === "person" ? (
            <b key={i}>@{s.name}</b>
          ) : s.type === "unknown" ? (
            <span key={i} className="unknown" title="No deliverable has this name">
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
        <span className="muted small">
          {l.kind === "action" && l.due_on && ` · due ${formatDate(l.due_on)}`}
          {l.kind === "action" && !l.owner && " · no owner"}
          {l.deliverable_ids.length === 0 && " · programme-level"}
        </span>
      </span>
    </li>
  );
}

function RecapImport(props: {
  deliverables: Deliverable[];
  people: string[];
  roster: Person[];
  meetingDate: string;
  onAdd: (lines: ReturnType<typeof importRecap>) => void;
}) {
  const [tab, setTab] = useState<"paste" | "prompt">("paste");
  const [text, setText] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const lines = useMemo(() => importRecap(text, props.deliverables, props.people), [text, props.deliverables, props.people]);
  const prompt = useMemo(() => copilotPrompt(props.deliverables, props.people), [props.deliverables, props.people]);
  const tagged = lines.filter((l) => TAG_RE.test(l.line)).length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied("Copied.");
    } catch {
      setCopied("Couldn't copy. Select the text and copy it.");
    }
  };

  return (
    <div className="recap-import">
      <div className="seg-toggle" role="group" aria-label="Import">
        <button aria-pressed={tab === "paste"} onClick={() => setTab("paste")}>
          Paste recap
        </button>
        <button aria-pressed={tab === "prompt"} onClick={() => setTab("prompt")}>
          Prompt for Copilot
        </button>
      </div>
      {tab === "prompt" ? (
        <>
          <p className="small">
            After the meeting, paste this into Copilot in Teams. Its answer comes back in Backstroke's format, so every line is tagged and linked when you paste it
            here.
          </p>
          <pre className="recap-prompt">{prompt}</pre>
          <div className="row-actions">
            <button className="small" onClick={copy}>
              Copy prompt
            </button>
            {copied && <span className="muted small">{copied}</span>}
          </div>
        </>
      ) : (
        <>
          <textarea
            className="recap-input"
            rows={7}
            value={text}
            autoFocus
            placeholder={"Paste a Copilot recap or anyone's notes.\nLines under “Follow-up tasks” become actions; lines that say “agreed” or “decided” become decisions."}
            onChange={(e) => setText(e.target.value)}
          />
          {lines.length > 0 && (
            <>
              <h3>
                Preview <span className="muted small">{lines.length} lines, {tagged} tagged</span>
              </h3>
              <ul className="picked recap-preview">
                {lines.map((l, i) => {
                  const parsed = parseLine(l.line, i, props.deliverables, props.meetingDate, props.roster);
                  return (
                    <li key={i}>
                      {parsed.kind ? <KindTag kind={parsed.kind} /> : <span className="kind-tag note">note</span>}
                      <span className="picked-text">
                        {parsed.text}
                        {parsed.owner && <span className="muted small"> · {parsed.owner}</span>}
                        {parsed.due_on && <span className="muted small"> · due {formatDate(parsed.due_on)}</span>}
                        {l.why && <span className="why"> {l.why}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="muted small">Tags come from the recap's headings and plain keywords, and names are matched exactly. Fix any line in the notes afterwards.</p>
            </>
          )}
          <div className="row-actions">
            <button className="primary small" disabled={lines.length === 0} onClick={() => props.onAdd(lines)}>
              Add {lines.length || ""} line{lines.length === 1 ? "" : "s"} to notes
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** A textarea that offers the project's people and groups after an @, written as their tag. */
function MentionTextarea(
  props: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> & {
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    value: string;
    people: Person[];
    onChange: (value: string) => void;
  },
) {
  const { textareaRef, value, people, onChange, ...rest } = props;
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const at = caret === null ? null : mentionAt(value, caret);
  const options = at && at.start !== dismissed ? suggestPeople(at.query, people) : [];
  const open = options.length > 0;
  useEffect(() => setActive(0), [at?.start, at?.query]);

  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  const accept = (handle: string) => {
    const el = textareaRef.current;
    if (!at || caret === null || !el) return;
    const insert = `@${handle} `;
    const after = value.slice(caret).replace(/^\s/, "");
    onChange(value.slice(0, at.start) + insert + after);
    const to = at.start + insert.length;
    setCaret(to);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(to, to);
    });
  };

  return (
    <>
      <textarea
        {...rest}
        ref={textareaRef}
        value={value}
        aria-autocomplete="list"
        aria-expanded={open}
        onChange={(e) => (onChange(e.target.value), track(e.target))}
        onSelect={(e) => track(e.currentTarget)}
        onBlur={(e) => (setCaret(null), rest.onBlur?.(e))}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            accept(options[active].handle);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDismissed(at!.start);
          }
        }}
      />
      {open && (
        <ul className="mention-menu" role="listbox" aria-label="People">
          {options.map((o, i) => (
            <li key={`${o.label}|${o.detail}`}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => accept(o.handle)}
              >
                <span>{o.label}</span>
                <span className="muted small">{o.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
