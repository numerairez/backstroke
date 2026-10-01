import type { Change, PlanState, Preview } from "../types";
import { formatDate, signedDays } from "../state/dates";
import { changeKey, describeChange, type Selection } from "../state/staging";

interface Props {
  staged: Change[];
  persisted: PlanState;
  proposed: PlanState;
  preview: Preview | null;
  selection: Selection;
  selectionPreview: Preview | null;
  excluded: Set<string>;
  editable: boolean;
  onToggle: (key: string) => void;
  onSelectAll: (selected: boolean) => void;
  onUnstage: (index: number) => void;
  onDiscard: () => void;
  onSelect: (id: string) => void;
  onApplySuggestions: () => void;
  onCommit: () => void;
}

export function StagedChangesDrawer({ staged, persisted, proposed, preview, selection, selectionPreview, excluded, editable, ...on }: Props) {
  const name = (id: string) => proposed.deliverables.find((d) => d.id === id)?.name ?? persisted.deliverables.find((d) => d.id === id)?.name ?? id;
  const errors = preview?.errors ?? [];
  const conflicts = preview?.conflicts ?? [];
  const suggestions = preview?.suggestions ?? [];
  const selected = selection.changes.length;
  const partial = selected !== staged.length;
  const canCommit = selected > 0 && selectionPreview?.valid === true;
  const subsetErrors = partial ? (selectionPreview?.errors ?? []) : [];
  const title = (c: Change) => describeChange(c, persisted, proposed).title;

  return (
    <div className="staged">
      {staged.length === 0 ? (
        <p className="hint">No staged changes. Edits you make on the timeline appear here before they are committed.</p>
      ) : (
        <>
        {editable && staged.length > 1 && (
          <div className="staged-select">
            <label>
              <input
                type="checkbox"
                checked={excluded.size === 0}
                ref={(el) => {
                  if (el) el.indeterminate = excluded.size > 0 && excluded.size < staged.length;
                }}
                onChange={(e) => on.onSelectAll(e.target.checked)}
              />
              {selected} of {staged.length} selected
            </label>
            <span className="muted small">Commit related changes together; the rest stay staged for their own reason.</span>
          </div>
        )}
        <ol className="staged-list">
          {staged.map((change, i) => {
            const d = describeChange(change, persisted, proposed);
            const errorsHere = errors.filter((e) => e.change_index === i);
            const key = changeKey(change);
            const neededBy = selection.required.get(key);
            const checked = !excluded.has(key) || !!neededBy;
            return (
              <li
                key={`${change.entity_type}-${change.entity_id}-${i}`}
                className={`staged-item ${d.kind} ${errorsHere.length ? "has-error" : ""} ${checked ? "" : "unselected"}`}
              >
                <div className="staged-row">
                  {editable && staged.length > 1 && (
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!!neededBy}
                      title={neededBy ? "Needed by another selected change" : checked ? "Leave out of this commit" : "Include in this commit"}
                      aria-label={`Include ${d.title} in this commit`}
                      onChange={() => on.onToggle(key)}
                    />
                  )}
                  <span className={`op ${d.kind}`}>{d.kind === "create" ? "add" : d.kind === "delete" ? "remove" : "edit"}</span>
                  <button className="link title" onClick={() => change.entity_type === "deliverable" && on.onSelect(change.entity_id)}>
                    {d.title}
                  </button>
                  <button className="icon" title="Unstage this change" onClick={() => on.onUnstage(i)}>
                    ×
                  </button>
                </div>
                {d.lines.map((line) => (
                  <div key={line} className="staged-line">
                    {line}
                  </div>
                ))}
                {neededBy && <div className="staged-line muted">included: needed by {neededBy.map(title).join(", ")}</div>}
                {errorsHere.map((e) => (
                  <div key={e.code + e.message} className="error-line">
                    {e.message}
                  </div>
                ))}
              </li>
            );
          })}
        </ol>
        </>
      )}

      {subsetErrors.length > 0 && errors.length === 0 && (
        <div className="callout error">
          <strong>The selected changes can't be committed on their own:</strong>
          <ul>
            {subsetErrors.map((e) => (
              <li key={e.code + e.message}>{e.message}</li>
            ))}
          </ul>
          Include the changes they depend on, or commit everything together.
        </div>
      )}

      {errors
        .filter((e) => e.change_index === null)
        .map((e) => (
          <div key={e.code + e.message} className="callout error">
            {e.message}
          </div>
        ))}

      {conflicts.length > 0 && (
        <div className="callout warn">
          <strong>
            {conflicts.length} dependency conflict{conflicts.length === 1 ? "" : "s"}
          </strong>
          <ul>
            {conflicts.map((c) => (
              <li key={c.dependency_id}>
                {c.message} <span className="muted">({c.overlap_days}d overlap)</span>
              </li>
            ))}
          </ul>
          {suggestions.length > 0 && editable && (
            <>
              <div className="suggest-title">Suggested downstream moves:</div>
              <ul>
                {suggestions.map((s) => (
                  <li key={s.deliverable_id}>
                    <button className="link" onClick={() => on.onSelect(s.deliverable_id)}>
                      {name(s.deliverable_id)}
                    </button>{" "}
                    {signedDays(s.shift_days)} → {formatDate(s.start_date)}
                    {s.start_date !== s.end_date && ` – ${formatDate(s.end_date)}`}
                    <span className="muted"> after {s.because_of.map(name).join(", ")}</span>
                  </li>
                ))}
              </ul>
              <button onClick={on.onApplySuggestions}>Stage suggested moves</button>
              <span className="muted small"> or leave them and commit as-is</span>
            </>
          )}
        </div>
      )}

      {staged.length > 0 && editable && (
        <div className="staged-actions">
          <button className="secondary" onClick={on.onDiscard}>
            Discard all
          </button>
          <button className="primary" disabled={!canCommit} onClick={on.onCommit}>
            {partial ? `Commit ${selected} of ${staged.length}…` : `Commit ${staged.length} change${staged.length === 1 ? "" : "s"}…`}
          </button>
        </div>
      )}
    </div>
  );
}
