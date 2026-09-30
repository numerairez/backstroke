import { useEffect, useState } from "react";
import type { Change, Deliverable, PlanState } from "../types";
import { addDays, daysBetween, formatDate } from "../state/dates";
import { DEFAULT_WORKFLOW, addPhase, hasPhases, minDuration, moveEnd, moveStart, phaseSpans, refitPhases, removePhase, renamePhase, splitIntoPhases } from "../state/phases";
import { newId } from "../state/staging";
import { deliverableStatus, phaseStatuses, spanStatus, statusLabel, type Status } from "../state/status";
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
  /** Status is judged as of this day. */
  asOf: string;
  /** Mark a deliverable (phase null) or one of its phases done, or reopen it (finishedOn null). */
  onProgress: (id: string, phase: number | null, finishedOn: string | null) => Promise<void>;
}

function StatusChip({ status }: { status: Status }) {
  return <span className={`status-chip ${status.kind}`}>{statusLabel(status)}</span>;
}

/** Mark done (with a finish date, default today) or Reopen. Recorded immediately, no staging. */
function ProgressAction({ id, status, asOf, onDone, onReopen, reopenTitle }: { id: string; status: Status; asOf: string; onDone: (day: string) => void; onReopen: () => void; reopenTitle?: string }) {
  const [day, setDay] = useState(asOf);
  useEffect(() => setDay(asOf), [asOf]);
  if (status.kind === "done") {
    return (
      <div className="progress-action">
        <span className="muted small">Finished {formatDate(status.finishedOn!)}</span>
        <button className="small secondary" title={reopenTitle} onClick={onReopen}>
          Reopen
        </button>
      </div>
    );
  }
  return (
    <div className="progress-action">
      <input type="date" id={`finish-${id}`} value={day} max={asOf} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Finish date" />
      <button className="small done-btn" onClick={() => onDone(day)}>
        Mark done
      </button>
    </div>
  );
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

interface ProgressProps {
  asOf: string;
  /** Progress can be recorded: live view, and the deliverable is saved (not a staged new one). */
  canRecord: boolean;
  onProgress: (phase: number | null, finishedOn: string | null) => void;
}

function PhasesSection({ d, persisted, editable, update, progress }: { d: Deliverable; persisted: Deliverable | undefined; editable: boolean; update: (fields: Record<string, unknown>) => void; progress: ProgressProps }) {
  const statuses = phaseStatuses(d, progress.asOf);
  const nextIndex = statuses.findIndex((p) => p.status.kind !== "done");
  const spans = phaseSpans(d);
  if (spans.length === 0) {
    const split = splitIntoPhases(d);
    return (
      <>
        <h4>Phases</h4>
        <p className="hint">No phases. Break it into {DEFAULT_WORKFLOW.join(", ")} to plan each step and see which one moves.</p>
        {editable && (
          <div className="phase-actions">
            <button className="small" disabled={!split} onClick={() => split && update({ phases: split })}>
              Break into phases
            </button>
            {!split && <span className="muted small">Needs at least {DEFAULT_WORKFLOW.length} days.</span>}
          </div>
        )}
      </>
    );
  }

  const names = spans.map((sp) => sp.name);
  const wasSpans = persisted && hasPhases(persisted) && persisted.phases.map((p) => p.name).join("\u0000") === names.join("\u0000") ? phaseSpans(persisted) : null;
  const last = spans[spans.length - 1];
  const setStart = (i: number, start: string) => update(moveStart(d, i, daysBetween(spans[i].start, start), false));
  const setDays = (i: number, days: number) => update(moveEnd(d, i, days - spans[i].days, false));
  const add = () => {
    let n = names.length + 1;
    while (names.some((x) => x.toLowerCase() === `phase ${n}`)) n++;
    const phases = addPhase(d, `Phase ${n}`);
    if (phases) update({ phases });
  };

  return (
    <>
      <h4>Phases</h4>
      <ol className="phase-list">
        {spans.map((sp) => {
          const isLast = sp.index === spans.length - 1;
          const prevEnd = sp.index > 0 ? spans[sp.index - 1].end : null;
          const was = wasSpans?.[sp.index];
          return (
            <li key={sp.index}>
              {sp.gap > 0 && (
                <div className="phase-gap">
                  {sp.gap}d gap
                  {editable && (
                    <button className="link small" onClick={() => setStart(sp.index, addDays(prevEnd!, 1))}>
                      Close gap
                    </button>
                  )}
                </div>
              )}
              <div className="phase-row">
                <CommitOnBlurInput value={sp.name} disabled={!editable} onCommit={(name) => update({ phases: renamePhase(d, sp.index, name) })} aria-label={`Phase ${sp.index + 1} name`} />
                {editable && (
                  <button className="icon" title={names.length <= 2 ? "Remove (leaves one phase, so the bar becomes plain)" : `Remove ${sp.name}`} onClick={() => update({ phases: removePhase(d, sp.index) })}>
                    ×
                  </button>
                )}
              </div>
              <div className="phase-dates">
                <label>
                  Starts
                  {sp.index === 0 ? (
                    <span className="static" title="The first phase starts with the deliverable">
                      {formatDate(sp.start)}
                    </span>
                  ) : (
                    <input
                      type="date"
                      value={sp.start}
                      min={addDays(prevEnd!, 1)}
                      max={sp.end}
                      disabled={!editable}
                      onChange={(e) => e.target.value && setStart(sp.index, e.target.value)}
                    />
                  )}
                </label>
                <span className="muted">ends {formatDate(sp.end)}</span>
                <label className="days">
                  {isLast || !editable ? (
                    <span title={isLast ? "The last phase runs to the end date" : undefined}>{sp.days}d</span>
                  ) : (
                    <>
                      <input
                        type="number"
                        className="days-input"
                        min={1}
                        value={sp.days}
                        aria-label={`${sp.name} days`}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isInteger(v) && v >= 1) setDays(sp.index, v);
                        }}
                      />
                      d
                    </>
                  )}
                </label>
              </div>
              <div className="phase-progress">
                {statuses[sp.index] && <StatusChip status={statuses[sp.index].status} />}
                {progress.canRecord && (statuses[sp.index]?.status.kind === "done" || sp.index === nextIndex) ? (
                  <ProgressAction
                    id={`${d.id}-${sp.index}`}
                    status={statuses[sp.index].status}
                    asOf={progress.asOf}
                    onDone={(day) => progress.onProgress(sp.index, day)}
                    onReopen={() => progress.onProgress(sp.index, null)}
                    reopenTitle={sp.index < spans.length - 1 ? "Also reopens the phases after it" : undefined}
                  />
                ) : (
                  progress.canRecord && sp.index > nextIndex && nextIndex >= 0 && <span className="muted small">After {spans[sp.index - 1].name}</span>
                )}
              </div>
              {was && (was.days !== sp.days || was.start !== sp.start) && (
                <div className="muted small">
                  was {formatDate(was.start)} – {formatDate(was.end)} · {was.days}d
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {editable && (
        <div className="phase-actions">
          <button className="small secondary" disabled={last.days < 2} title={last.days < 2 ? "The last phase needs at least 2 days to split" : "Split the last phase in two"} onClick={add}>
            + Add phase
          </button>
          <button className="small secondary" onClick={() => update({ phases: null })}>
            Remove phases
          </button>
        </div>
      )}
      <p className="muted small">
        A phase starts the day after the previous one ends. Set a later start to leave a gap. On the timeline, drag a boundary to move it (the next phase or gap absorbs the change), hold Shift to push the later phases, or hold Alt to open a gap.
      </p>
    </>
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
  const progress: ProgressProps = {
    asOf: props.asOf,
    canRecord: editable && !!persisted,
    onProgress: (phase, finishedOn) => void props.onProgress(d.id, phase, finishedOn),
  };
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
            update(type === "milestone" ? { type, end_date: d.start_date, ...(hasPhases(d) ? { phases: null } : {}) } : { type, end_date: addDays(d.start_date, 4) });
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
            <input
              type="date"
              value={d.start_date}
              max={addDays(d.end_date, 1 - minDuration(d))}
              disabled={!editable}
              onChange={(e) => e.target.value && update({ start_date: e.target.value, ...(hasPhases(d) ? { phases: refitPhases(d, e.target.value, d.end_date) } : {}) })}
            />
            <label>End</label>
            <input
              type="date"
              value={d.end_date}
              min={addDays(d.start_date, minDuration(d) - 1)}
              disabled={!editable}
              onChange={(e) => e.target.value && update({ end_date: e.target.value, ...(hasPhases(d) ? { phases: refitPhases(d, d.start_date, e.target.value) } : {}) })}
            />
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

      {d.type === "task" && !hasPhases(d) && (
        <>
          <h4>Progress</h4>
          <div className="phase-progress">
            <StatusChip status={spanStatus({ start: d.start_date, end: d.end_date, finishedOn: d.finished_on }, props.asOf)} />
            {progress.canRecord && (
              <ProgressAction
                id={d.id}
                status={deliverableStatus(d, props.asOf)!}
                asOf={props.asOf}
                onDone={(day) => progress.onProgress(null, day)}
                onReopen={() => progress.onProgress(null, null)}
              />
            )}
          </div>
        </>
      )}
      {d.type === "task" && <PhasesSection d={d} persisted={persisted} editable={editable} update={update} progress={progress} />}

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
