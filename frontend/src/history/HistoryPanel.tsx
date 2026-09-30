import { useState } from "react";
import type { Category, CommitSummary, PlanState } from "../types";
import { formatTimestamp } from "../state/dates";
import { describeEvents } from "./describe";

interface Props {
  commits: CommitSummary[];
  version: number;
  viewVersion: number | null;
  categories: Category[];
  stateFor: (seq: number) => PlanState | undefined;
  onView: (seq: number | null) => void;
  onCompareWithCurrent: (seq: number) => void;
  onRevert: (seq: number) => void;
  onBaseline: (seq: number) => void;
}

export function categoryLabel(categories: Category[], code: string | null): string {
  if (!code) return "";
  return categories.find((c) => c.code === code)?.label ?? code;
}

export function HistoryPanel(props: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const shown = props.viewVersion ?? props.version;
  const ordered = [...props.commits].reverse();

  return (
    <div className="history">
      {ordered.length === 0 && <p className="hint">No commits yet.</p>}
      <ol className="commit-list">
        {ordered.map((c) => {
          const isShown = c.seq === shown;
          const isOpen = expanded === c.seq || (isShown && props.viewVersion !== null);
          const after = props.stateFor(c.seq);
          const before = props.stateFor(c.seq - 1);
          const lines = isOpen && c.events ? describeEvents(c.events, [after, before].filter(Boolean) as PlanState[]) : [];
          return (
            <li key={c.seq} className={`commit ${isShown ? "shown" : ""} ${c.seq > shown ? "future" : ""}`}>
              <button
                className="commit-main"
                onClick={() => {
                  props.onView(c.seq === props.version ? null : c.seq);
                  setExpanded(c.seq);
                }}
              >
                <div className="commit-meta">
                  <span className="seq">#{c.seq}</span>
                  <span className="muted">{formatTimestamp(c.created_at)}</span>
                  {c.category && <span className={`cat cat-${c.category}`}>{categoryLabel(props.categories, c.category)}</span>}
                  {c.seq === props.version && <span className="badge current">current</span>}
                  {c.baselines.map((b) => (
                    <span key={b} className="badge baseline" title="Baseline">
                      ⚑ {b}
                    </span>
                  ))}
                </div>
                <div className="commit-reason">{c.reason}</div>
                <div className="commit-stats muted">
                  {c.change_count} change{c.change_count === 1 ? "" : "s"} • {c.deliverables_affected} deliverable{c.deliverables_affected === 1 ? "" : "s"} affected • {c.author}
                  {c.reference && <> • {c.reference}</>}
                </div>
              </button>
              {isOpen && (
                <div className="commit-detail">
                  <ul className="event-lines">
                    {lines.map((l) => (
                      <li key={l.key} className={l.delta ? (l.delta > 0 ? "later" : "earlier") : ""}>
                        {l.text}
                      </li>
                    ))}
                  </ul>
                  <div className="commit-actions">
                    {c.seq !== props.version && (
                      <button className="small" onClick={() => props.onCompareWithCurrent(c.seq)}>
                        Compare with current
                      </button>
                    )}
                    <button className="small" onClick={() => props.onBaseline(c.seq)}>
                      Tag baseline
                    </button>
                    <button className="small" onClick={() => props.onRevert(c.seq)} title="Creates a new commit that restores the previous values">
                      Undo…
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
