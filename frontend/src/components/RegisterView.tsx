import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type ItemUpdate } from "../api/client";
import { formatDate } from "../state/dates";
import { groupsOf, membersOf } from "../state/people";
import { OUTCOMES, type Deliverable, type ItemEvent, type ItemInput, type ItemKind, type Person, type RegisterItem } from "../types";

const KIND_LABEL: Record<ItemKind, string> = { action: "Actions", risk: "Risks", issue: "Issues", decision: "Decisions" };
/** Card detail, from one line per card to everything: the panel's − and + buttons. */
const DENSITIES = ["Compact: one line per card", "Two lines per card", "Full detail"];
const DENSITY_KEY = "backstroke:raidDensity";
function storedDensity(): number {
  try {
    const n = Number(localStorage.getItem(DENSITY_KEY));
    return Number.isInteger(n) && n >= 0 && n < DENSITIES.length ? n : 1;
  } catch {
    return 1;
  }
}

/** RAID order: risks, actions, issues, decisions. */
const KINDS: ItemKind[] = ["risk", "action", "issue", "decision"];

const OUTCOME_LABEL: Record<string, string> = {
  done: "Done",
  dropped: "Dropped",
  mitigated: "Mitigated",
  passed: "Passed",
  accepted: "Accepted",
  happened: "Happened",
  resolved: "Resolved",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
};
const OUTCOME_HINT: Record<string, string> = {
  done: "It got done",
  dropped: "No longer needed",
  mitigated: "Reduced enough to stop watching",
  passed: "The moment for it has gone",
  accepted: "Living with it",
  happened: "It became an issue",
  resolved: "Fixed",
  superseded: "A newer decision replaces it",
  withdrawn: "Reversed, with nothing in its place",
};

export function KindTag({ kind, children }: { kind: ItemKind; children?: React.ReactNode }) {
  return <span className={`kind-tag ${kind}`}>{children ?? kind}</span>;
}

export const isOverdue = (item: RegisterItem, today: string) => item.kind === "action" && item.open && !!item.due_on && item.due_on < today;

function statusLabel(item: RegisterItem): string {
  if (item.outcome === "superseded") return `Superseded by ${item.superseded_by}`;
  if (!item.open) {
    const why = item.outcome ? OUTCOME_LABEL[item.outcome] : "Closed";
    return item.became ? `${why}, became ${item.became}` : `${why}${item.closed_on ? ` ${formatDate(item.closed_on)}` : ""}`;
  }
  return item.kind === "decision" ? "Active" : "Open";
}

/** "A-7: due 2026-10-14 → 2026-10-21" as "Due 2026-10-14 → 2026-10-21", for under the item itself. */
export const sentence = (line: string) => line.replace(/^[A-Z]-\d+: (.)/, (_, c: string) => c.toUpperCase());

export function meetingLabel(m: { title: string; held_on: string }): string {
  return `${m.title}, ${formatDate(m.held_on)}`;
}

interface RowProps {
  item: RegisterItem;
  deliverables: Map<string, Deliverable>;
  today: string;
  showMeeting?: boolean;
  onSelectDeliverable: (id: string) => void;
  children?: React.ReactNode;
}

/** One register item: ref, text, owner, due date, deliverables, where it was raised. */
export function ItemRow({ item, deliverables, today, showMeeting = true, onSelectDeliverable, children }: RowProps) {
  const overdue = isOverdue(item, today);
  return (
    <li className={`reg-item ${item.open ? "" : "closed"}`}>
      <div className="reg-head">
        <KindTag kind={item.kind}>{item.ref}</KindTag>
        <span className="reg-text">{item.text}</span>
      </div>
      <div className="reg-meta muted small">
        {item.owner && <span>{item.owner}</span>}
        {item.due_on && (
          <span className={overdue ? "overdue" : ""}>
            {overdue ? "Overdue since" : "Due"} {formatDate(item.due_on)}
          </span>
        )}
        {item.deliverable_ids.length ? (
          item.deliverable_ids.map((id) => (
            <button key={id} className="deliv-chip" onClick={() => onSelectDeliverable(id)} disabled={!deliverables.has(id)}>
              {deliverables.get(id)?.name ?? "removed deliverable"}
            </button>
          ))
        ) : (
          <span className="programme">Programme</span>
        )}
        {showMeeting && <span>{item.meeting ? meetingLabel(item.meeting) : "Added in the register"}</span>}
        <span className={`reg-status ${item.open ? "" : "closed"}`}>{statusLabel(item)}</span>
      </div>
      {children}
    </li>
  );
}

interface Props {
  projectId: string;
  register: RegisterItem[];
  deliverables: Deliverable[];
  today: string;
  people: Person[];
  /** Recorded in each item's history; empty when nobody has said who they are yet. */
  author: string;
  onSelectDeliverable: (id: string) => void;
  onCreate: (input: ItemInput & { author?: string }) => Promise<RegisterItem>;
  onUpdate: (itemId: number, input: ItemUpdate) => Promise<RegisterItem>;
}

const KIND_HINT: Record<ItemKind, string> = { action: "Someone has to do it", risk: "Might go wrong", issue: "Already going wrong", decision: "Agreed and on record" };
const KIND_EMPTY: Record<ItemKind, string> = { action: "No open actions", risk: "No open risks", issue: "No open issues", decision: "No active decisions" };

/** The register as a board: one row per kind in RAID order, its cards side by side, each row with its own add button. */
export function RegisterView(props: Props) {
  const [openOnly, setOpenOnly] = useState(true);
  const [density, setDensityState] = useState(storedDensity);
  const setDensity = (n: number) => {
    setDensityState(n);
    try {
      localStorage.setItem(DENSITY_KEY, String(n));
    } catch {
      /* ignore */
    }
  };
  const [owner, setOwner] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<ItemKind | null>(null);
  const [expanded, setExpanded] = useState<{ id: number; closing: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => new Map(props.deliverables.map((d) => [d.id, d])), [props.deliverables]);
  const groups = groupsOf(props.people);
  const author = props.author.trim() || undefined;

  // A group matches items owned by the group or by anyone in it.
  const owners = useMemo(() => {
    if (!owner) return null;
    const group = owner.startsWith("group:") ? owner.slice(6) : null;
    return new Set((group ? [group, ...membersOf(props.people, group)] : [owner]).map((n) => n.toLowerCase()));
  }, [owner, props.people]);
  const ownerNames = [...new Set([...props.people.map((p) => p.name), ...props.register.flatMap((i) => (i.owner ? [i.owner] : []))])].filter((n) => !groups.includes(n));
  const q = query.trim().toLowerCase();
  const filtering = !!owners || !!q;
  const shown = props.register
    .filter((i) => (!openOnly || i.open) && (!owners || owners.has((i.owner ?? "").toLowerCase())) && (!q || `${i.ref} ${i.text} ${i.owner ?? ""}`.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.open) - Number(a.open) || Number(isOverdue(b, props.today)) - Number(isOverdue(a, props.today)) || b.id - a.id);
  const activeDecisions = props.register.filter((i) => i.kind === "decision" && i.open);
  const openIssues = props.register.filter((i) => i.kind === "issue" && i.open);
  const closed = props.register.filter((i) => !i.open).length;

  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
      return true;
    } catch (e) {
      setError(e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(" ") : (e as Error).message);
      return false;
    }
  };
  const update = (item: RegisterItem, input: ItemUpdate) => run(() => props.onUpdate(item.id, { ...input, author }));
  const toggle = (item: RegisterItem, closing = false) => setExpanded((x) => (x?.id === item.id && x.closing === closing ? null : { id: item.id, closing }));

  return (
    <div className="page">
      <div className={`page-inner wide register density-${density}`}>
        <div className="reg-toolbar">
          <h2 className="reg-title">RAID</h2>
          <input
            className="small search"
            type="search"
            placeholder="Search the register"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the register"
          />
          <select className="small" value={owner} aria-label="Owner" onChange={(e) => setOwner(e.target.value)}>
            <option value="">Any owner</option>
            {groups.length > 0 && (
              <optgroup label="Groups">
                {groups.map((g) => (
                  <option key={g} value={`group:${g}`}>
                    {g}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="People">
              {ownerNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </optgroup>
          </select>
          <label className="toggle small">
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open only
            {openOnly && closed > 0 && <span className="muted">({closed} closed hidden)</span>}
          </label>
          <div className="zoom reg-density" role="group" aria-label="Card detail">
            <button className="icon" disabled={density === 0} onClick={() => setDensity(density - 1)} title={`Less detail (${DENSITIES[Math.max(0, density - 1)]})`}>
              −
            </button>
            <button
              className="icon"
              disabled={density === DENSITIES.length - 1}
              onClick={() => setDensity(density + 1)}
              title={`More detail (${DENSITIES[Math.min(DENSITIES.length - 1, density + 1)]})`}
            >
              +
            </button>
          </div>
        </div>
        {error && <p className="callout error small">{error}</p>}

        <div className="reg-board">
          {KINDS.map((k) => {
            const items = shown.filter((i) => i.kind === k);
            const open = props.register.filter((i) => i.kind === k && i.open).length;
            const late = k === "action" ? props.register.filter((i) => isOverdue(i, props.today)).length : 0;
            return (
              <section key={k} className={`reg-col ${k}`} aria-label={KIND_LABEL[k]}>
                <header className="reg-col-head">
                  <div className="reg-col-title">
                    <h3>
                      {KIND_LABEL[k]} <span className="reg-col-count">{open}</span>
                      {late > 0 && <span className="nav-badge overdue">{late} overdue</span>}
                    </h3>
                    <span className="muted small reg-col-hint">{KIND_HINT[k]}</span>
                  </div>
                  <button
                    className="icon small"
                    title={`Add ${KIND_LABEL[k].toLowerCase().slice(0, -1)}`}
                    aria-label={`Add ${KIND_LABEL[k].toLowerCase().slice(0, -1)}`}
                    onClick={() => setAdding(adding === k ? null : k)}
                  >
                    +
                  </button>
                </header>
                <div className="reg-row-body">
                  {adding === k && (
                    <AddItemForm
                      kind={k}
                      deliverables={props.deliverables}
                      people={props.people}
                      onCancel={() => setAdding(null)}
                      onAdd={(input) => run(async () => (await props.onCreate({ ...input, author }), setAdding(null)))}
                    />
                  )}
                  {items.length === 0 ? (
                    adding !== k && <p className="reg-col-empty muted small">{filtering ? "Nothing matches" : openOnly ? KIND_EMPTY[k] : "Nothing yet"}</p>
                  ) : (
                    <ul className="reg-cards" aria-label={KIND_LABEL[k]}>
                      {items.map((item) => {
                        const overdue = isOverdue(item, props.today);
                        const isOpen = expanded?.id === item.id;
                        return (
                          <li key={item.id} className={`reg-card ${item.open ? "" : "closed"} ${overdue ? "overdue" : ""} ${isOpen ? "expanded" : ""}`}>
                            <button
                              className="reg-card-main"
                              aria-expanded={isOpen}
                              title={
                                isOpen ? "Hide history" : `${item.text}\n\n${item.meeting ? meetingLabel(item.meeting) : "Added in the register"} · click for history and edit`
                              }
                              onClick={() => toggle(item)}
                            >
                              <span className="reg-card-top">
                                <KindTag kind={item.kind}>{item.ref}</KindTag>
                                {(!item.open || item.outcome) && <span className={`reg-status ${item.open ? "" : "closed"} ${item.outcome ?? ""}`}>{statusLabel(item)}</span>}
                                {overdue && <span className="reg-status overdue-text">Overdue</span>}
                              </span>
                              <span className="reg-text">{item.text}</span>
                            </button>
                            <div className="reg-card-meta small">
                              {item.owner && <span className="reg-owner">{item.owner}</span>}
                              {item.due_on && <span className={overdue ? "overdue-text" : "muted"}>Due {formatDate(item.due_on)}</span>}
                              {item.deliverable_ids.map((id) => (
                                <button key={id} className="deliv-chip" onClick={() => props.onSelectDeliverable(id)} disabled={!byId.has(id)}>
                                  {byId.get(id)?.name ?? "removed deliverable"}
                                </button>
                              ))}
                              {item.deliverable_ids.length === 0 && <span className="programme muted">Programme</span>}
                              <span className="reg-card-actions">
                                {item.kind === "action" && item.open && (
                                  <button className="small" onClick={() => update(item, { outcome: "done", closed_on: props.today })}>
                                    Done
                                  </button>
                                )}
                                {item.open && (
                                  <button className="small" aria-pressed={isOpen && expanded.closing} onClick={() => toggle(item, true)}>
                                    Close…
                                  </button>
                                )}
                                {!item.open && item.kind !== "decision" && (
                                  <button className="small" onClick={() => update(item, { status: "open" })}>
                                    Reopen
                                  </button>
                                )}
                              </span>
                            </div>
                            {(isOpen || density === DENSITIES.length - 1) && (
                              <div className="muted small reg-raised" title={item.raised_from.length ? `From ${item.raised_from.join(", ")}` : undefined}>
                                {item.meeting ? meetingLabel(item.meeting) : "Added in the register"}
                              </div>
                            )}
                            {isOpen && (
                              <ItemDetail
                                key={`${item.id}-${expanded.closing}`}
                                projectId={props.projectId}
                                item={item}
                                closing={expanded.closing && item.open}
                                deliverables={props.deliverables}
                                people={props.people}
                                today={props.today}
                                decisions={activeDecisions.filter((d) => d.id !== item.id)}
                                issues={openIssues}
                                onUpdate={(input) => update(item, input)}
                                onDone={() => setExpanded({ id: item.id, closing: false })}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface DetailProps {
  projectId: string;
  item: RegisterItem;
  closing: boolean;
  deliverables: Deliverable[];
  people: Person[];
  today: string;
  /** Active decisions that could supersede this one. */
  decisions: RegisterItem[];
  /** Open issues a risk could have become. */
  issues: RegisterItem[];
  onUpdate: (input: ItemUpdate) => Promise<boolean>;
  onDone: () => void;
}

/** An item's history, and the forms to close or edit it. Nothing is deleted; every change is kept. */
function ItemDetail(props: DetailProps) {
  const { item } = props;
  const [events, setEvents] = useState<ItemEvent[] | null>(null);
  const [editing, setEditing] = useState(false);
  // Reload the history whenever the item itself changes.
  const version = JSON.stringify(item);
  useEffect(() => {
    let cancelled = false;
    api
      .itemHistory(props.projectId, item.id)
      .then((e) => !cancelled && setEvents(e))
      .catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
  }, [props.projectId, item.id, version]);

  return (
    <div className="item-detail">
      {props.closing && <CloseForm {...props} />}
      {editing ? (
        <EditForm
          item={item}
          deliverables={props.deliverables}
          people={props.people}
          onCancel={() => setEditing(false)}
          onSave={async (input) => (await props.onUpdate(input)) && setEditing(false)}
        />
      ) : (
        !props.closing &&
        item.kind !== "decision" && (
          <button className="small secondary edit-btn" onClick={() => setEditing(true)}>
            Edit
          </button>
        )
      )}
      <h4>History</h4>
      {events === null ? (
        <p className="muted small">Loading…</p>
      ) : (
        <ol className="item-history">
          {events.map((e) => (
            <li key={e.id} className={e.type}>
              <span className="when muted">{formatDate(e.on)}</span>
              <span className="what">
                {e.type === "raised" ? (e.meeting ? `Raised at ${meetingLabel(e.meeting)}` : "Added in the register") : sentence(e.line)}
                {e.type !== "raised" && e.meeting && <span className="muted"> · at {e.meeting.title}</span>}
                {e.author && <span className="muted"> · {e.author}</span>}
                {e.note && <span className="note">“{e.note}”</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CloseForm(props: DetailProps) {
  const { item } = props;
  const outcomes = OUTCOMES[item.kind];
  const [outcome, setOutcome] = useState("");
  const [link, setLink] = useState(""); // the newer decision, or the issue a risk became ("" raises a new one)
  const [closedOn, setClosedOn] = useState(props.today);
  const [note, setNote] = useState("");
  const ready = outcome && (outcome !== "superseded" || link);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const ok = await props.onUpdate({
      outcome,
      closed_on: closedOn || props.today,
      note: note.trim() || undefined,
      ...(outcome === "superseded" ? { superseded_by: link } : {}),
      ...(outcome === "happened" && link ? { became: link } : {}),
    });
    if (ok) props.onDone();
  };

  return (
    <form className="close-form" onSubmit={submit}>
      <fieldset className="outcomes">
        <legend>Why is {item.ref} closing?</legend>
        {outcomes.map((o) => {
          // Superseding needs another active decision to point at.
          const unavailable = o === "superseded" && props.decisions.length === 0;
          return (
            <label key={o} className={`outcome ${outcome === o ? "chosen" : ""} ${unavailable ? "unavailable" : ""}`}>
              <input type="radio" name={`outcome-${item.id}`} value={o} checked={outcome === o} disabled={unavailable} onChange={() => (setOutcome(o), setLink(""))} />
              <strong>{OUTCOME_LABEL[o]}</strong>
              <span className="muted small">{unavailable ? "Record the newer decision first" : OUTCOME_HINT[o]}</span>
            </label>
          );
        })}
      </fieldset>
      {outcome === "superseded" && (
        <label className="field">
          <span>Superseded by</span>
          <select autoFocus value={link} onChange={(e) => setLink(e.target.value)}>
            <option value="">Choose the newer decision</option>
            {props.decisions.map((d) => (
              <option key={d.id} value={d.ref}>
                {d.ref}: {d.text.slice(0, 60)}
              </option>
            ))}
          </select>
        </label>
      )}
      {outcome === "happened" && (
        <label className="field">
          <span>Became</span>
          <select value={link} onChange={(e) => setLink(e.target.value)}>
            <option value="">A new issue, carrying over its text, owner and deliverables</option>
            {props.issues.map((i) => (
              <option key={i.id} value={i.ref}>
                {i.ref}: {i.text.slice(0, 60)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="field-row">
        <label className="field">
          <span>Why (optional)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={item.kind === "risk" ? "e.g. Vendor confirmed schema v3" : outcome === "withdrawn" ? "e.g. Escalation tool moved to phase 2" : "Kept in its history"}
          />
        </label>
        <label className="field narrow">
          <span>On</span>
          <input type="date" value={closedOn} onChange={(e) => setClosedOn(e.target.value)} />
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary small" onClick={props.onDone}>
          Cancel
        </button>
        <button className="primary small" disabled={!ready}>
          {outcome === "happened" && !link ? "Close and raise issue" : "Close"}
        </button>
      </div>
    </form>
  );
}

function OwnerInput(props: { value: string; onChange: (v: string) => void; people: Person[]; autoFocus?: boolean }) {
  return (
    <>
      <input autoFocus={props.autoFocus} value={props.value} onChange={(e) => props.onChange(e.target.value)} placeholder="Name or group" list="register-owners" />
      <datalist id="register-owners">
        {props.people.map((p) => (
          <option key={p.name} value={p.name}>
            {p.groups.join(", ")}
          </option>
        ))}
        {groupsOf(props.people).map((g) => (
          <option key={`group:${g}`} value={g}>
            group
          </option>
        ))}
      </datalist>
    </>
  );
}

function EditForm(props: { item: RegisterItem; deliverables: Deliverable[]; people: Person[]; onSave: (input: ItemUpdate) => void; onCancel: () => void }) {
  const { item } = props;
  const [text, setText] = useState(item.text);
  const [owner, setOwner] = useState(item.owner ?? "");
  const [due, setDue] = useState(item.due_on ?? "");
  const [linked, setLinked] = useState(item.deliverable_ids);
  const [note, setNote] = useState("");
  const names = new Map(props.deliverables.map((d) => [d.id, d.name]));

  const input: ItemUpdate = {};
  if (text.trim() !== item.text) input.text = text.trim();
  if ((owner.trim() || null) !== item.owner) input.owner = owner.trim() || null;
  if (item.kind === "action" && (due || null) !== item.due_on) input.due_on = due || null;
  if (linked.join() !== item.deliverable_ids.join()) input.deliverable_ids = linked;
  const changed = Object.keys(input).length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (changed && text.trim()) props.onSave({ ...input, note: note.trim() || undefined });
  };
  return (
    <form className="edit-form" onSubmit={submit}>
      <label className="field">
        <span>What</span>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Owner</span>
          <OwnerInput value={owner} onChange={setOwner} people={props.people} />
        </label>
        {item.kind === "action" && (
          <label className="field narrow">
            <span>Due</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        )}
      </div>
      <div className="field">
        <span>Deliverables</span>
        <div className="linked">
          {linked.map((id) => (
            <span key={id} className="deliv-chip">
              {names.get(id) ?? "removed deliverable"}
              <button type="button" className="chip-x" aria-label={`Unlink ${names.get(id) ?? id}`} onClick={() => setLinked(linked.filter((x) => x !== id))}>
                ×
              </button>
            </span>
          ))}
          <select className="small" value="" aria-label="Link a deliverable" onChange={(e) => e.target.value && setLinked([...linked, e.target.value])}>
            <option value="">{linked.length ? "+ Link another" : "Programme-level · link a deliverable"}</option>
            {props.deliverables
              .filter((d) => !linked.includes(d.id))
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </div>
      </div>
      <label className="field">
        <span>Why the change (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Kept in its history, e.g. Vendor asked for another week" />
      </label>
      <div className="modal-actions">
        <button type="button" className="secondary small" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="primary small" disabled={!changed || !text.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}

const ADD_PLACEHOLDER: Record<ItemKind, string> = {
  action: "e.g. Book the go-live comms slot",
  risk: "e.g. Vendor may slip the schema release",
  issue: "e.g. Test environment is down",
  decision: "e.g. Go-live moves to the weekend",
};

function AddItemForm(props: { kind: ItemKind; deliverables: Deliverable[]; people: Person[]; onAdd: (input: ItemInput) => void; onCancel: () => void }) {
  const { kind } = props;
  const [text, setText] = useState("");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    props.onAdd({ kind, text: text.trim(), owner: owner.trim() || null, due_on: kind === "action" && due ? due : null, deliverable_ids: deliverable ? [deliverable] : [] });
  };
  return (
    <form className="reg-add card" onSubmit={submit}>
      <label className="field">
        <span>
          What <em>required</em>
        </span>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={ADD_PLACEHOLDER[kind]} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Owner</span>
          <OwnerInput value={owner} onChange={setOwner} people={props.people} />
        </label>
        <label className="field">
          <span>Deliverable</span>
          <select value={deliverable} onChange={(e) => setDeliverable(e.target.value)}>
            <option value="">Programme-level</option>
            {props.deliverables.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {kind === "action" && (
          <label className="field">
            <span>Due</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary small" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="primary small" disabled={!text.trim()}>
          Add
        </button>
      </div>
    </form>
  );
}
