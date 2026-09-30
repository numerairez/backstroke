import { useEffect, useState } from "react";
import type { Change, Deliverable, PlanState } from "../types";
import { addDays, daysBetween, formatDate } from "../state/dates";
import { newId } from "../state/staging";
import { LANE_COLORS } from "../timeline/TimelineCanvas";

interface Props {
  state: PlanState;
  persisted: PlanState;
  selectedId: string | null;
  editable: boolean;
  stagedIds: Set<string>;
  onStage: (change: Change) => void;
  onRevert: (id: string) => void;
  onSelect: (id: string | null) => void;
  onAddDeliverable: (workstreamId: string) => void;
}

/** Text input that stages its value on blur/Enter instead of on every keystroke. */
function CommitOnBlurInput({ value, onCommit, disabled, ...rest }: { value: string; onCommit: (v: string) => void; disabled?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() && draft !== value) onCommit(draft.trim());
    else setDraft(value);
  };
  return (
    <input
      {...rest}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          e.stopPropagation();
        }
      }}
    />
  );
}

function DeliverableInspector({ d, props }: { d: Deliverable; props: Props }) {
  const { state, editable, onStage } = props;
  const update = (fields: Record<string, unknown>) => onStage({ entity_type: "deliverable", entity_id: d.id, operation: "update", fields });
  const byId = new Map(state.deliverables.map((x) => [x.id, x]));
  const preds = state.dependencies.filter((dep) => dep.successor_id === d.id);
  const succs = state.dependencies.filter((dep) => dep.predecessor_id === d.id);
  const linked = new Set([d.id, ...preds.map((p) => p.predecessor_id), ...succs.map((s) => s.successor_id)]);
  const candidates = state.deliverables.filter((x) => !linked.has(x.id)).sort((a, b) => a.name.localeCompare(b.name));
  const persisted = props.persisted.deliverables.find((x) => x.id === d.id);
  const duration = daysBetween(d.start_date, d.end_date) + 1;

  const link = (predecessor_id: string, successor_id: string) =>
    onStage({ entity_type: "dependency", entity_id: newId("dependency"), operation: "create", fields: { predecessor_id, successor_id, type: "FS" } });
  const unlink = (id: string) => onStage({ entity_type: "dependency", entity_id: id, operation: "delete", fields: {} });

  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className={`type-dot ${d.type}`} />
        <CommitOnBlurInput className="title-input" value={d.name} disabled={!editable} onCommit={(name) => update({ name })} aria-label="Name" />
      </div>
      {props.stagedIds.has(d.id) && (
        <div className="staged-note">
          <span>Uncommitted edits</span>
          <button className="link" onClick={() => props.onRevert(d.id)}>
            Revert (Esc)
          </button>
        </div>
      )}

      <div className="field-grid">
        <label>Type</label>
        <select
          value={d.type}
          disabled={!editable}
          onChange={(e) => {
            const type = e.target.value;
            update(type === "milestone" ? { type, end_date: d.start_date } : { type, end_date: addDays(d.start_date, 4) });
          }}
        >
          <option value="task">Task</option>
          <option value="milestone">Milestone</option>
        </select>

        <label>Lane</label>
        <select value={d.workstream_id} disabled={!editable} onChange={(e) => update({ workstream_id: e.target.value })}>
          {state.workstreams.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>

        {d.type === "milestone" ? (
          <>
            <label>Date</label>
            <input type="date" value={d.start_date} disabled={!editable} onChange={(e) => e.target.value && update({ start_date: e.target.value, end_date: e.target.value })} />
          </>
        ) : (
          <>
            <label>Start</label>
            <input type="date" value={d.start_date} max={d.end_date} disabled={!editable} onChange={(e) => e.target.value && update({ start_date: e.target.value })} />
            <label>End</label>
            <input type="date" value={d.end_date} min={d.start_date} disabled={!editable} onChange={(e) => e.target.value && update({ end_date: e.target.value })} />
            <label>Duration</label>
            <div className="static">
              {duration} day{duration === 1 ? "" : "s"}
              {persisted && persisted.type === "task" && daysBetween(persisted.start_date, persisted.end_date) + 1 !== duration && (
                <span className="muted"> (was {daysBetween(persisted.start_date, persisted.end_date) + 1})</span>
              )}
            </div>
          </>
        )}
      </div>

      <h4>Depends on</h4>
      <ul className="dep-list">
        {preds.length === 0 && <li className="muted">Nothing</li>}
        {preds.map((dep) => {
          const p = byId.get(dep.predecessor_id);
          return (
            <li key={dep.id}>
              <button className="link" onClick={() => props.onSelect(dep.predecessor_id)}>
                {p?.name ?? dep.predecessor_id}
              </button>
              <span className="muted">ends {p ? formatDate(p.end_date) : "?"}</span>
              {editable && (
                <button className="icon" title="Remove dependency" onClick={() => unlink(dep.id)}>
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {editable && candidates.length > 0 && (
        <select className="add-dep" value="" onChange={(e) => e.target.value && link(e.target.value, d.id)}>
          <option value="">+ Add predecessor…</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}

      <h4>Blocks</h4>
      <ul className="dep-list">
        {succs.length === 0 && <li className="muted">Nothing</li>}
        {succs.map((dep) => {
          const s = byId.get(dep.successor_id);
          return (
            <li key={dep.id}>
              <button className="link" onClick={() => props.onSelect(dep.successor_id)}>
                {s?.name ?? dep.successor_id}
              </button>
              <span className="muted">starts {s ? formatDate(s.start_date) : "?"}</span>
              {editable && (
                <button className="icon" title="Remove dependency" onClick={() => unlink(dep.id)}>
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {editable && candidates.length > 0 && (
        <select className="add-dep" value="" onChange={(e) => e.target.value && link(d.id, e.target.value)}>
          <option value="">+ Add successor…</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}

      {editable && (
        <div className="danger-row">
          <button
            className="danger"
            onClick={() => {
              onStage({ entity_type: "deliverable", entity_id: d.id, operation: "delete", fields: {} });
              props.onSelect(null);
            }}
          >
            Delete {d.type === "milestone" ? "milestone" : "deliverable"}
          </button>
        </div>
      )}
    </div>
  );
}

function PlanInspector({ props }: { props: Props }) {
  const { state, editable, onStage } = props;
  const [newLane, setNewLane] = useState("");
  const lanes = state.workstreams;

  const addLane = () => {
    if (!newLane.trim()) return;
    onStage({ entity_type: "workstream", entity_id: newId("workstream"), operation: "create", fields: { name: newLane.trim() } });
    setNewLane("");
  };

  const swap = (i: number, j: number) => {
    const a = lanes[i];
    const b = lanes[j];
    onStage({ entity_type: "workstream", entity_id: a.id, operation: "update", fields: { order_index: b.order_index } });
    onStage({ entity_type: "workstream", entity_id: b.id, operation: "update", fields: { order_index: a.order_index } });
  };

  return (
    <div className="inspector">
      <p className="hint">
        {editable ? (
          <>
            Drag a bar to move it, drag its edges to change dates, or double-click a lane to add a deliverable. Edits are <b>staged</b> until you commit them with a reason.
          </>
        ) : (
          <>You are viewing a historical version. It is read-only.</>
        )}
      </p>
      <h4>Workstreams</h4>
      <ul className="lane-list">
        {lanes.map((w, i) => {
          const count = state.deliverables.filter((d) => d.workstream_id === w.id).length;
          return (
            <li key={w.id} style={{ ["--lane-color" as string]: LANE_COLORS[i % LANE_COLORS.length] }}>
              <span className="lane-swatch" />
              <CommitOnBlurInput value={w.name} disabled={!editable} onCommit={(name) => onStage({ entity_type: "workstream", entity_id: w.id, operation: "update", fields: { name } })} aria-label="Workstream name" />
              <span className="muted count">{count}</span>
              {editable && (
                <span className="lane-actions">
                  <button className="icon" title="Move up" disabled={i === 0} onClick={() => swap(i, i - 1)}>
                    ↑
                  </button>
                  <button className="icon" title="Move down" disabled={i === lanes.length - 1} onClick={() => swap(i, i + 1)}>
                    ↓
                  </button>
                  <button className="icon" title="Add deliverable" onClick={() => props.onAddDeliverable(w.id)}>
                    +
                  </button>
                  <button
                    className="icon"
                    title={count ? "Move or delete its deliverables first" : "Delete workstream"}
                    disabled={count > 0}
                    onClick={() => onStage({ entity_type: "workstream", entity_id: w.id, operation: "delete", fields: {} })}
                  >
                    ×
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {editable && (
        <div className="inline-form">
          <input placeholder="New workstream name" value={newLane} onChange={(e) => setNewLane(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addLane()} />
          <button onClick={addLane} disabled={!newLane.trim()}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

export function InspectorPanel(props: Props) {
  const d = props.selectedId ? props.state.deliverables.find((x) => x.id === props.selectedId) : undefined;
  return d ? <DeliverableInspector key={d.id} d={d} props={props} /> : <PlanInspector props={props} />;
}
