import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Baseline, Category, Metrics } from "../types";
import { formatDate, signedDays } from "../state/dates";
import { categoryLabel } from "./HistoryPanel";

interface Props {
  projectId: string;
  version: number;
  baselines: Baseline[];
  categories: Category[];
  onSelect: (id: string) => void;
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** Diverging bars: days moved earlier (left) vs later (right), per reason category. */
function ReasonAttribution({ rows, categories }: { rows: Metrics["by_category"]; categories: Category[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const moving = rows.filter((r) => r.later_days || r.earlier_days);
  if (moving.length === 0) return <p className="hint">No date movement yet.</p>;
  const max = Math.max(...moving.map((r) => Math.max(r.later_days, r.earlier_days)), 1);
  return (
    <div className="attribution" role="table" aria-label="Movement by reason category">
      <div className="legend">
        <span>
          <i className="swatch earlier" /> moved earlier
        </span>
        <span>
          <i className="swatch later" /> moved later
        </span>
      </div>
      {moving.map((r) => (
        <div
          key={r.category}
          role="row"
          className={`attr-row ${hover === r.category ? "hover" : ""}`}
          onMouseEnter={() => setHover(r.category)}
          onMouseLeave={() => setHover(null)}
        >
          <span role="rowheader" className="attr-label">
            {categoryLabel(categories, r.category) || "Uncategorized"}
          </span>
          <span className="attr-bars">
            <span className="half left">
              {r.earlier_days > 0 && <span className="bar earlier" style={{ width: `${(r.earlier_days / max) * 100}%` }} />}
            </span>
            <span className="half right">
              {r.later_days > 0 && <span className="bar later" style={{ width: `${(r.later_days / max) * 100}%` }} />}
            </span>
          </span>
          <span role="cell" className="attr-values">
            {r.earlier_days > 0 && <span>−{r.earlier_days}d</span>}
            {r.later_days > 0 && <span>+{r.later_days}d</span>}
          </span>
          {hover === r.category && (
            <span className="attr-tip" role="tooltip">
              {r.commit_count} commit{r.commit_count === 1 ? "" : "s"} · {r.movements} date move{r.movements === 1 ? "" : "s"} · {r.later_days}d later · {r.earlier_days}d earlier
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function MetricsPanel({ projectId, version, baselines, categories, onSelect }: Props) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [baseline, setBaseline] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .metrics(projectId, baseline)
      .then((m) => !cancelled && (setMetrics(m), setError(null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId, version, baseline]);

  if (error) return <div className="callout error">{error}</div>;
  if (!metrics) return <p className="hint">Loading…</p>;
  const s = metrics.summary;

  return (
    <div className="metrics">
      <div className="field-grid compact">
        <label>Measured from</label>
        <select value={baseline ?? metrics.baseline_version} onChange={(e) => setBaseline(Number(e.target.value))}>
          {baselines.map((b) => (
            <option key={b.id} value={b.version}>
              ⚑ {b.name} (#{b.version})
            </option>
          ))}
          {!baselines.some((b) => b.version === metrics.baseline_version) && <option value={metrics.baseline_version}>#{metrics.baseline_version}</option>}
        </select>
      </div>

      <div className="stats">
        <Stat label="commits" value={s.commits} hint="Commits in the project's history" />
        <Stat label="gross churn" value={`${s.gross_churn_days}d`} hint="Sum of absolute end-date movements across all commits" />
        <Stat label="recovered" value={`${s.recovery_days}d`} hint="Days regained after an earlier slip of the same deliverable" />
        <Stat label="late-stage churn" value={`${s.late_stage_churn_days}d`} hint={`Movement made within ${metrics.late_stage_window_days} days of the date being moved`} />
        <Stat label="propagated" value={s.propagated_movements} hint="Successor slips committed together with their predecessor's slip" />
        <Stat label="max slip vs baseline" value={signedDays(s.max_net_movement_days)} hint="Largest current-minus-baseline end date movement" />
      </div>

      <h4>Milestones vs baseline</h4>
      <table className="diff-table">
        <thead>
          <tr>
            <th>Milestone</th>
            <th>Baseline</th>
            <th>Current</th>
            <th className="num">Net</th>
          </tr>
        </thead>
        <tbody>
          {metrics.milestones.map((m) => (
            <tr key={m.id}>
              <td>
                <button className="link" onClick={() => onSelect(m.id)}>
                  {m.name}
                </button>
              </td>
              <td className="muted">{m.baseline_date ? formatDate(m.baseline_date) : "new"}</td>
              <td>{formatDate(m.current_date)}</td>
              <td className={`num ${m.net_movement_days! > 0 ? "later" : m.net_movement_days! < 0 ? "earlier" : ""}`}>{m.net_movement_days === null ? "—" : signedDays(m.net_movement_days)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Movement by reason</h4>
      <ReasonAttribution rows={metrics.by_category} categories={categories} />

      <h4>Deliverables</h4>
      <table className="diff-table">
        <thead>
          <tr>
            <th>Deliverable</th>
            <th className="num" title="Commits that touched it">Commits</th>
            <th className="num" title="Gross end-date churn">Churn</th>
            <th className="num" title="Current end vs baseline end">Net</th>
            <th className="num" title="Days since its dates last changed">Stable</th>
          </tr>
        </thead>
        <tbody>
          {metrics.deliverables.map((d) => (
            <tr key={d.id}>
              <td>
                <button className="link" onClick={() => onSelect(d.id)}>
                  {d.name}
                </button>
              </td>
              <td className="num">{d.commit_count}</td>
              <td className="num">{d.gross_churn_days ? `${d.gross_churn_days}d` : "—"}</td>
              <td className={`num ${d.net_movement_days! > 0 ? "later" : d.net_movement_days! < 0 ? "earlier" : ""}`}>{d.net_movement_days === null ? "new" : d.net_movement_days ? signedDays(d.net_movement_days) : "—"}</td>
              <td className="num muted">{d.unchanged_for_days === null ? "—" : `${d.unchanged_for_days}d`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Metrics describe how the plan changed. They are not a score: a plan that adapts to new information will show churn.</p>
    </div>
  );
}
