import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import type { Category, Change, PlanState, Preview } from "../types";
import { describeChange } from "../state/staging";

interface Props {
  /** The changes going into this commit (the selected part of the staged set). */
  staged: Change[];
  /** Staged changes left out of this commit; they stay staged afterwards. */
  remaining: number;
  persisted: PlanState;
  proposed: PlanState;
  preview: Preview | null;
  categories: Category[];
  version: number;
  /** The signed-in person, recorded as the author. */
  author: string;
  onCommit: (input: { reason: string; category: string | null; reference: string | null; author: string }) => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
}

export function CommitDialog(props: Props) {
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => reasonRef.current?.focus(), []);

  const conflicts = props.preview?.conflicts.length ?? 0;
  const ready = reason.trim().length > 0 && props.author.trim().length > 0 && props.preview?.valid && !busy;
  const isStale = error instanceof ApiError && error.code === "VERSION_CONFLICT";

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await props.onCommit({ reason: reason.trim(), category: category || null, reference: reference.trim() || null, author: props.author.trim() });
    } catch (e) {
      setError(e as Error);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="commit-title" onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
        <h2 id="commit-title">Commit {props.staged.length} change{props.staged.length === 1 ? "" : "s"}</h2>
        <p className="muted">
          Creates version <b>#{props.version + 1}</b>. Every change is kept in history; nothing is overwritten.
          {props.remaining > 0 && (
            <>
              {" "}
              <b>{props.remaining}</b> other staged change{props.remaining === 1 ? "" : "s"} will stay staged for a separate commit.
            </>
          )}
        </p>

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
          <textarea
            ref={reasonRef}
            rows={3}
            value={reason}
            placeholder="e.g. Move UAT by seven days because data mapping completion moved to 16 October."
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">—</option>
              {props.categories.filter((c) => c.selectable !== false).map((c) => (
                <option key={c.code} value={c.code} title={c.description}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Reference</span>
            <input value={reference} placeholder="Meeting, ticket, email…" onChange={(e) => setReference(e.target.value)} />
          </label>
          <label className="field">
            <span>Author</span>
            <input value={props.author} readOnly title="You're signed in as this person" />
          </label>
        </div>
        {category && <p className="muted small">{props.categories.find((c) => c.code === category)?.description}</p>}

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
            {busy ? "Committing…" : "Commit"}
          </button>
        </div>
        <p className="muted small right">⌘/Ctrl + Enter to commit</p>
      </div>
    </div>
  );
}
