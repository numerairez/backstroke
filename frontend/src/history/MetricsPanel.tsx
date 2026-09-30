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

/** Where the time went: how much longer or shorter each phase got since the baseline. */
function PhaseMovement({ data }: { data: Metrics["by_phase"] }) {
  const gaps = data.gaps;
  const rows = [
    ...data.phases.filter((p) => p.longer_days || p.shorter_days),
    // Gaps are time between phases, spent on other work.
    ...(gaps.longer_days || gaps.shorter_days ? [{ name: "Gaps", ...gaps, deliverables: data.compared, isGap: true }] : []),
  ];
  const max = Math.max(1, ...rows.map((r) => Math.max(r.longer_days, r.shorter_days)));
  return (
    <>
      {rows.length === 0 ? (
        <p className="hint">No phase has changed length since the baseline.</p>
      ) : (
        <div className="attribution" role="table" aria-label="Change in phase length">
          <div className="legend">
            <span>
              <i className="swatch earlier" /> got shorter
            </span>
            <span>
              <i className="swatch later" /> got longer
            </span>
          </div>
          {rows.map((r) => (
            <div key={r.name} role="row" className="attr-row" title={`${r.deliverables} deliverable${r.deliverables === 1 ? "" : "s"} · net ${signedDays(r.net_days)}`}>
              <span role="rowheader" className={`attr-label ${"isGap" in r ? "muted" : ""}`}>
                {"isGap" in r ? <i>between phases</i> : r.name}
              </span>
              <span className="attr-bars">
                <span className="half left">{r.shorter_days > 0 && <span className="bar earlier" style={{ width: `${(r.shorter_days / max) * 100}%` }} />}</span>
                <span className="half right">{r.longer_days > 0 && <span className="bar later" style={{ width: `${(r.longer_days / max) * 100}%` }} />}</span>
              </span>
              <span role="cell" className="attr-values">
                {r.shorter_days > 0 && <span>−{r.shorter_days}d</span>}
                {r.longer_days > 0 && <span>+{r.longer_days}d</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="muted small">
        Change in phase length across the {data.compared} deliverable{data.compared === 1 ? "" : "s"} that had the same phases at the baseline.
        {data.not_compared > 0 && ` ${data.not_compared} other${data.not_compared === 1 ? " was" : "s were"} added or re-phased since, so ${data.not_compared === 1 ? "it isn't" : "they aren't"} counted.`}
      </p>
    </>
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

      {metrics.by_phase.compared + metrics.by_phase.not_compared > 0 && (
        <>
          <h4>Where the time went</h4>
          <PhaseMovement data={metrics.by_phase} />
        </>
      )}

      {metrics.finishes.total > 0 && (
        <>
          <h4>Finishes vs plan</h4>
          <table className="diff-table">
            <thead>
              <tr>
                <th>Finished</th>
                <th className="num" title="Planned end when it was marked done">Planned</th>
                <th className="num">Actual</th>
                <th className="num" title="Actual minus planned end">Δ</th>
                <th className="num" title="Actual minus the baseline's planned end">vs baseline</th>
              </tr>
            </thead>
            <tbody>
              {metrics.finishes.rows.map((r) => (
                <tr key={`${r.deliverable_id}-${r.phase ?? ""}`}>
                  <td>
                    <button className="link" onClick={() => onSelect(r.deliverable_id)}>
                      {r.name}
                    </button>
                    {r.phase && <span className="muted"> · {r.phase}</span>}
                  </td>
                  <td className="num muted">{formatDate(r.planned_end)}</td>
                  <td className="num">{formatDate(r.finished_on)}</td>
                  <td className={`num ${r.delta_days > 0 ? "later" : r.delta_days < 0 ? "earlier" : ""}`}>{r.delta_days ? signedDays(r.delta_days) : "±0"}</td>
                  <td className="num muted">{r.baseline_delta_days === null ? "—" : signedDays(r.baseline_delta_days)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            {metrics.finishes.on_time} of {metrics.finishes.total} finished on or before the planned end. Each finish is measured against the plan when it was marked done, so a later replan can't hide a late finish.
          </p>
        </>
      )}

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
