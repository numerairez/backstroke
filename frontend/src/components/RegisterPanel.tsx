import { useMemo, useState } from "react";
import { ApiError, type ItemUpdate } from "../api/client";
import { formatDate } from "../state/dates";
import type { Deliverable, ItemInput, ItemKind, RegisterItem } from "../types";

const KIND_LABEL: Record<ItemKind, string> = { action: "Actions", risk: "Risks", decision: "Decisions" };

export function KindTag({ kind, children }: { kind: ItemKind; children?: React.ReactNode }) {
  return <span className={`kind-tag ${kind}`}>{children ?? kind}</span>;
}

export const isOverdue = (item: RegisterItem, today: string) => item.kind === "action" && item.open && !!item.due_on && item.due_on < today;

function statusLabel(item: RegisterItem): string {
  if (item.status === "superseded") return `Superseded by ${item.superseded_by}`;
  if (!item.open) return `${item.status === "done" ? "Done" : "Closed"}${item.closed_on ? ` ${formatDate(item.closed_on)}` : ""}`;
  return item.kind === "decision" ? "Active" : "Open";
}

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

/** One action, risk or decision: ref, text, owner, due date, deliverables, where it was raised. */
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
        {item.due_on && <span className={overdue ? "overdue" : ""}>{overdue ? "Overdue since" : "Due"} {formatDate(item.due_on)}</span>}
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
  register: RegisterItem[];
  deliverables: Deliverable[];
  today: string;
  onSelectDeliverable: (id: string) => void;
  onCreate: (input: ItemInput) => Promise<RegisterItem>;
  onUpdate: (itemId: number, input: ItemUpdate) => Promise<RegisterItem>;
}

export function RegisterPanel(props: Props) {
  const [kind, setKind] = useState<ItemKind | "all">("all");
  const [openOnly, setOpenOnly] = useState(true);
  const [adding, setAdding] = useState(false);
  const [superseding, setSuperseding] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => new Map(props.deliverables.map((d) => [d.id, d])), [props.deliverables]);

  const overdue = props.register.filter((i) => isOverdue(i, props.today)).length;
  const shown = props.register
    .filter((i) => (kind === "all" || i.kind === kind) && (!openOnly || i.open))
    .sort((a, b) => Number(isOverdue(b, props.today)) - Number(isOverdue(a, props.today)) || b.id - a.id);
  const activeDecisions = props.register.filter((i) => i.kind === "decision" && i.open);

  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(" ") : (e as Error).message);
    }
  };

  return (
    <div className="register">
      <div className="reg-toolbar">
        <div className="seg-toggle" role="group" aria-label="Show">
          {(["all", "action", "risk", "decision"] as const).map((k) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === "all" ? "All" : KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <label className="toggle small">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open only
        </label>
      </div>
      {overdue > 0 && (
        <p className="callout error small">
          {overdue} action{overdue === 1 ? " is" : "s are"} overdue.
        </p>
      )}
      {error && <p className="callout error small">{error}</p>}

      {adding ? (
        <AddItemForm
          deliverables={props.deliverables}
          onCancel={() => setAdding(false)}
          onAdd={(input) => run(async () => (await props.onCreate(input), setAdding(false)))}
        />
      ) : (
        <button className="small secondary" onClick={() => setAdding(true)}>
          + Add item
        </button>
      )}

      {shown.length === 0 && (
        <p className="hint">
          {props.register.length === 0
            ? "Nothing in the register yet. Actions, risks and decisions from meeting notes land here when a meeting finishes."
            : "Nothing matches. Untick Open only to see closed items."}
        </p>
      )}
      <ul className="reg-list">
        {shown.map((item) => (
          <ItemRow key={item.id} item={item} deliverables={byId} today={props.today} onSelectDeliverable={props.onSelectDeliverable}>
            <div className="reg-actions">
              {item.kind === "action" && (
                <button className="small" onClick={() => run(() => props.onUpdate(item.id, { status: item.open ? "done" : "open", closed_on: item.open ? props.today : null }))}>
                  {item.open ? "Mark done" : "Reopen"}
                </button>
              )}
              {item.kind === "risk" && (
                <button className="small" onClick={() => run(() => props.onUpdate(item.id, { status: item.open ? "closed" : "open", closed_on: item.open ? props.today : null }))}>
                  {item.open ? "Close" : "Reopen"}
                </button>
              )}
              {item.kind === "decision" && item.open && superseding !== item.id && activeDecisions.length > 1 && (
                <button className="small" onClick={() => setSuperseding(item.id)}>
                  Superseded by…
                </button>
              )}
              {superseding === item.id && (
                <select
                  autoFocus
                  defaultValue=""
                  aria-label={`Decision that supersedes ${item.ref}`}
                  onBlur={() => setSuperseding(null)}
                  onChange={(e) => e.target.value && run(async () => (await props.onUpdate(item.id, { status: "superseded", superseded_by: e.target.value }), setSuperseding(null)))}
                >
                  <option value="">Choose the newer decision</option>
                  {activeDecisions
                    .filter((d) => d.id !== item.id)
                    .map((d) => (
                      <option key={d.id} value={d.ref}>
                        {d.ref}: {d.text.slice(0, 60)}
                      </option>
                    ))}
                </select>
              )}
            </div>
          </ItemRow>
        ))}
      </ul>
    </div>
  );
}

function AddItemForm(props: { deliverables: Deliverable[]; onAdd: (input: ItemInput) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<ItemKind>("action");
  const [text, setText] = useState("");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    props.onAdd({
      kind,
      text: text.trim(),
      owner: owner.trim() || null,
      due_on: kind === "action" && due ? due : null,
      deliverable_ids: deliverable ? [deliverable] : [],
    });
  };
  return (
    <form className="reg-add" onSubmit={submit}>
      <div className="field-row">
        <label className="field">
          <span>Type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
            <option value="action">Action</option>
            <option value="risk">Risk</option>
            <option value="decision">Decision</option>
          </select>
        </label>
        <label className="field">
          <span>Owner</span>
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Name" />
        </label>
      </div>
      <label className="field">
        <span>
          What <em>required</em>
        </span>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Book the go-live comms slot" />
      </label>
      <div className="field-row">
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
