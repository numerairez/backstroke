import { useMemo, useState } from "react";
import { ApiError } from "../api/client";
import { formatDate } from "../state/dates";
import { itemsFromNotes, parseNotes, reasonFromDecisions } from "../state/notes";
import { describeChange } from "../state/staging";
import type { Category, Change, Deliverable, Meeting, PlanState, Preview, Person } from "../types";
import { KindTag } from "./RegisterView";

interface Props {
  meeting: Meeting;
  deliverables: Deliverable[];
  /** The project's people, so @handles read as their names. */
  people: Person[];
  /** The staged changes selected for the next commit. */
  staged: Change[];
  persisted: PlanState;
  proposed: PlanState;
  preview: Preview | null;
  categories: Category[];
  version: number;
  author: string;
  onAuthorChange: (author: string) => void;
  onFinish: (input: { author: string; withCommit: boolean; reason: string; category: string | null }) => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
}

export function FinishMeetingDialog(props: Props) {
  const items = useMemo(
    () => itemsFromNotes(parseNotes(props.meeting.notes, props.deliverables, props.meeting.held_on, props.people)),
    [props.meeting, props.deliverables, props.people],
  );
  const hasChanges = props.staged.length > 0;
  const [withCommit, setWithCommit] = useState(hasChanges);
  const [reason, setReason] = useState(() => reasonFromDecisions(items));
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const committing = withCommit && hasChanges;
  const conflicts = props.preview?.conflicts.length ?? 0;
  const ready = props.author.trim() && !busy && (!committing || (reason.trim() && props.preview?.valid));
  const isStale = error instanceof ApiError && error.code === "VERSION_CONFLICT";
  const absent = props.meeting.attendees.filter((a) => !a.present).map((a) => a.name);

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await props.onFinish({ author: props.author.trim(), withCommit: committing, reason: reason.trim(), category: category || null });
    } catch (e) {
      setError(e as Error);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="finish-title" onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
        <h2 id="finish-title">
          Finish {props.meeting.title}, {formatDate(props.meeting.held_on)}
        </h2>
        <p className="muted">
          Records {items.length} item{items.length === 1 ? "" : "s"} in the register
          {committing ? (
            <>
              {" "}
              and commits {props.staged.length} plan change{props.staged.length === 1 ? "" : "s"} as <b>#{props.version + 1}</b>, in one step.
            </>
          ) : (
            "."
          )}{" "}
          Notes stay editable afterwards.
        </p>

        {items.length > 0 && (
          <ul className="commit-summary">
            {items.map((i) => (
              <li key={i.line}>
                <KindTag kind={i.kind} /> {i.text}
                <span className="muted">
                  {i.owner && ` · ${i.owner}`}
                  {i.due_on && ` · due ${formatDate(i.due_on)}`}
                  {i.deliverable_ids.length === 0 && " · programme-level"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {absent.length > 0 && (
          <p className="callout warn small">
            Absent: {absent.join(", ")}. They'll need to hear about these outcomes.
          </p>
        )}

        {hasChanges ? (
          <label className="toggle finish-commit">
            <input type="checkbox" checked={withCommit} onChange={(e) => setWithCommit(e.target.checked)} />
            Commit the {props.staged.length} selected plan change{props.staged.length === 1 ? "" : "s"} with this meeting
          </label>
        ) : (
          <p className="muted small">No plan changes are staged, so the plan stays as it is.</p>
        )}

        {committing && (
          <>
            <ul className="commit-summary">
              {props.staged.map((c, i) => {
                const d = describeChange(c, props.persisted, props.proposed);
                return (
                  <li key={i}>
                    <span className={`op ${d.kind}`}>{d.kind === "create" ? "add" : d.kind === "delete" ? "remove" : "edit"}</span> {d.title}
                    {d.lines.length > 0 && <span className="muted"> · {d.lines.join(" · ")}</span>}
                  </li>
                );
              })}
            </ul>
            {props.preview && !props.preview.valid && (
              <div className="callout error small">
                <ul>
                  {props.preview.errors.map((e) => (
                    <li key={e.code + e.message}>{e.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {conflicts > 0 && (
              <div className="callout warn small">
                {conflicts} dependency conflict{conflicts === 1 ? "" : "s"} will remain after this commit.
              </div>
            )}
            <label className="field">
              <span>
                Why is the plan changing? <em>required</em>
              </span>
              <textarea rows={3} value={reason} placeholder="Filled in from the meeting's decisions" onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="field-row">
              <label className="field">
                <span>Category</span>
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">—</option>
                  {props.categories
                    .filter((c) => c.selectable !== false)
                    .map((c) => (
                      <option key={c.code} value={c.code} title={c.description}>
                        {c.label}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Reference</span>
                <input value={props.meeting.reference} readOnly />
              </label>
            </div>
          </>
        )}

        <label className="field">
          <span>Author</span>
          <input value={props.author} placeholder="Your name" onChange={(e) => props.onAuthorChange(e.target.value)} />
        </label>

        {error && (
          <div className="callout error">
            {isStale ? (
              <>
                {error.message}{" "}
                <button
                  className="link"
                  onClick={async () => {
                    await props.onReload();
                    setError(null);
                  }}
                >
                  Load the latest version
                </button>{" "}
                (your staged changes are kept and re-checked).
              </>
            ) : error instanceof ApiError && error.errors.length ? (
              <ul>
                {error.errors.map((e) => (
                  <li key={e.message}>{e.message}</li>
                ))}
              </ul>
            ) : (
              error.message
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="secondary" onClick={props.onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!ready} onClick={submit}>
            {busy ? "Finishing…" : "Finish meeting"}
          </button>
        </div>
      </div>
    </div>
  );
}
