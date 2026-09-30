import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Baseline, CommitSummary, Diff } from "../types";
import { formatDate, signedDays } from "../state/dates";

export interface CompareRange {
  from: number;
  to: number;
}

interface Props {
  projectId: string;
  commits: CommitSummary[];
  baselines: Baseline[];
  version: number;
  range: CompareRange | null;
  onChange: (range: CompareRange | null) => void;
  onSelect: (id: string) => void;
}

function versionLabel(c: CommitSummary): string {
  const tag = c.baselines.length ? ` ⚑ ${c.baselines.join(", ")}` : "";
  const reason = c.reason.length > 42 ? `${c.reason.slice(0, 40)}…` : c.reason;
  return `#${c.seq}${tag} — ${reason}`;
}

export function ComparePanel({ projectId, commits, baselines, version, range, onChange, onSelect }: Props) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!range) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    api
      .diff(projectId, range.from, range.to)
      .then((d) => !cancelled && (setDiff(d), setError(null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [projectId, range?.from, range?.to, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const baseline = baselines[0];

  const presets = [
    baseline && { label: `Baseline (${baseline.name}) → current`, range: { from: baseline.version, to: version } },
    version > 1 && { label: "Previous commit → current", range: { from: version - 1, to: version } },
    version > 0 && { label: "Empty plan → current", range: { from: 0, to: version } },
  ].filter(Boolean) as { label: string; range: CompareRange }[];

  const select = (which: "from" | "to", value: number) => {
    const next = { from: range?.from ?? baseline?.version ?? 0, to: range?.to ?? version, [which]: value };
    onChange(next);
  };

  const moved = diff?.deliverables.filter((d) => d.status === "changed") ?? [];
  const added = diff?.deliverables.filter((d) => d.status === "added") ?? [];
  const removed = diff?.deliverables.filter((d) => d.status === "removed") ?? [];

  return (
    <div className="compare">
      <div className="presets">
        {presets.map((p) => (
          <button key={p.label} className={`small ${range && range.from === p.range.from && range.to === p.range.to ? "active" : ""}`} onClick={() => onChange(p.range)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="field-grid compact">
        <label>From</label>
        <select value={range?.from ?? ""} onChange={(e) => select("from", Number(e.target.value))}>
          {!range && <option value="">Choose…</option>}
          <option value={0}>#0 — empty plan</option>
          {commits.map((c) => (
            <option key={c.seq} value={c.seq}>
              {versionLabel(c)}
            </option>
          ))}
        </select>
        <label>To</label>
        <select value={range?.to ?? ""} onChange={(e) => select("to", Number(e.target.value))}>
          {!range && <option value="">Choose…</option>}
          {commits.map((c) => (
            <option key={c.seq} value={c.seq}>
              {versionLabel(c)}
              {c.seq === version ? " (current)" : ""}
            </option>
          ))}
        </select>
      </div>
      {range && (
        <p className="muted small">
          The timeline shows #{range.to} with #{range.from} as ghost bars.{" "}
          <button className="link" onClick={() => onChange(null)}>
            Stop comparing
          </button>
        </p>
      )}
      {error && <div className="callout error">{error}</div>}

      {diff && range && (
        <>
          <div className="diff-summary">
            <span className="chip-inline">{diff.summary.moved} moved</span>
            <span className="chip-inline later">{diff.summary.later} later</span>
            <span className="chip-inline earlier">{diff.summary.earlier} earlier</span>
            <span className="chip-inline added">{diff.summary.added} added</span>
            <span className="chip-inline removed">{diff.summary.removed} removed</span>
          </div>

          {moved.length > 0 && (
            <>
              <h4>Changed</h4>
              <table className="diff-table">
                <thead>
                  <tr>
                    <th>Deliverable</th>
                    <th>Before</th>
                    <th>After</th>
                    <th className="num">End Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {moved.map((d) => {
                    const a = d.before!;
                    const b = d.after!;
                    const extra = (d.changes ?? []).filter((c) => !c.field.endsWith("_date")).map((c) => (c.field === "workstream_id" ? "lane changed" : `${c.field}: ${String(c.old)} → ${String(c.new)}`));
                    return (
                      <tr key={d.id}>
                        <td>
                          <button className="link" onClick={() => onSelect(d.id)}>
                            {b.name}
                          </button>
                          {!!d.duration_delta_days && <div className="muted small">duration {signedDays(d.duration_delta_days)}</div>}
                          {extra.map((x) => (
                            <div key={x} className="muted small">
                              {x}
                            </div>
                          ))}
                        </td>
                        <td className="muted">{a.type === "milestone" ? formatDate(a.start_date) : `${formatDate(a.start_date)} – ${formatDate(a.end_date)}`}</td>
                        <td>{b.type === "milestone" ? formatDate(b.start_date) : `${formatDate(b.start_date)} – ${formatDate(b.end_date)}`}</td>
                        <td className={`num ${d.end_delta_days! > 0 ? "later" : d.end_delta_days! < 0 ? "earlier" : ""}`}>{d.end_delta_days ? signedDays(d.end_delta_days) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
          {added.length > 0 && (
            <>
              <h4>Added</h4>
              <ul className="plain">
                {added.map((d) => (
                  <li key={d.id}>
                    <button className="link" onClick={() => onSelect(d.id)}>
                      {d.after!.name}
                    </button>{" "}
                    <span className="muted">
                      {formatDate(d.after!.start_date)}
                      {d.after!.type === "task" && ` – ${formatDate(d.after!.end_date)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {removed.length > 0 && (
            <>
              <h4>Removed</h4>
              <ul className="plain">
                {removed.map((d) => (
                  <li key={d.id} className="muted">
                    {d.before!.name}
                  </li>
                ))}
              </ul>
            </>
          )}
          {(diff.summary.dependencies_added > 0 || diff.summary.dependencies_removed > 0) && (
            <p className="muted small">
              Dependencies: {diff.summary.dependencies_added} added, {diff.summary.dependencies_removed} removed.
            </p>
          )}
          {diff.deliverables.length === 0 && <p className="hint">No deliverable differences between these versions.</p>}
        </>
      )}
    </div>
  );
}
