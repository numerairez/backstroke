import { useEffect, useState } from "react";
import { api } from "../api/client";
import { formatDate } from "../state/dates";
import type { DeliverableTrail, MoveSignal, PreRead, Surprises, TrailCommit } from "../types";
import { KindTag } from "./RegisterPanel";

export function SignalTag({ signal }: { signal: MoveSignal | null }) {
  if (!signal) return null;
  const text =
    signal.kind === "agreed" ? `Agreed at ${signal.by}` : signal.kind === "foreseen" ? `Raised before · ${signal.by}` : "Not raised beforehand";
  return <span className={`signal-tag ${signal.kind}`}>{text}</span>;
}

function CommitBlock({ c, onViewCommit }: { c: TrailCommit; onViewCommit: (seq: number) => void }) {
  return (
    <>
      <div className="trail-meta">
        <button className="link" onClick={() => onViewCommit(c.seq)}>
          #{c.seq}
        </button>
        <span className="muted">{formatDate(c.date)}</span>
        <SignalTag signal={c.signal} />
      </div>
      <ul className="trail-lines">
        {c.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p className="trail-quote">“{c.reason}”</p>
      {!c.meeting && c.reference && <p className="muted small">{c.reference}</p>}
    </>
  );
}

/** Every commit, meeting and register item that explains where a deliverable is. */
export function DeliverableHistory(props: {
  projectId: string;
  deliverableId: string;
  refreshKey: string;
  onViewCommit: (seq: number) => void;
  onOpenMeeting: (meetingId: number) => void;
}) {
  const [trail, setTrail] = useState<DeliverableTrail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .trail(props.projectId, props.deliverableId)
      .then((t) => !cancelled && (setTrail(t), setError(null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [props.projectId, props.deliverableId, props.refreshKey]);

  if (error) return <p className="callout error small">{error}</p>;
  if (!trail || trail.deliverable_id !== props.deliverableId) return null;

  return (
    <section className="trail">
      <h3>Why it's here</h3>
      <p className="muted small">
        Commits, meetings and register items, oldest first. A date move counts as raised beforehand when an open risk or action was on it, or a meeting discussed it in
        the {trail.recent_days} days before.
      </p>
      <ol className="trail-list">
        {trail.entries.map((e, i) => (
          <li key={i} className={`trail-entry ${e.type}`}>
            <span className="trail-node" aria-hidden="true" />
            {e.type === "commit" ? (
              <CommitBlock c={e} onViewCommit={props.onViewCommit} />
            ) : e.type === "meeting" ? (
              <>
                <div className="trail-meta">
                  <button className="link" onClick={() => props.onOpenMeeting(e.meeting_id)}>
                    {e.meeting.replace(/ \d{4}-\d{2}-\d{2}$/, "")}
                  </button>
                  <span className="muted">{formatDate(e.date)}</span>
                </div>
                {e.items.map((it) => (
                  <p key={it.ref} className="trail-item">
                    <KindTag kind={it.kind}>{it.ref}</KindTag> {it.text}
                  </p>
                ))}
                {e.items.length === 0 &&
                  e.notes.slice(0, 2).map((n) => (
                    <p key={n} className="trail-quote">
                      “{n}”
                    </p>
                  ))}
              </>
            ) : (
              <>
                <div className="trail-meta">
                  <span>Added in the register</span>
                  <span className="muted">{formatDate(e.date)}</span>
                </div>
                {e.items.map((it) => (
                  <p key={it.ref} className="trail-item">
                    <KindTag kind={it.kind}>{it.ref}</KindTag> {it.text}
                  </p>
                ))}
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** How many date moves were raised before they were committed. */
export function SurpriseIndex(props: { projectId: string; refreshKey: string; onViewCommit: (seq: number) => void }) {
  const [data, setData] = useState<Surprises | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.surprises(props.projectId).then((d) => !cancelled && setData(d)).catch(() => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
  }, [props.projectId, props.refreshKey]);
  if (!data) return null;
  const share = (n: number) => (data.total ? `${Math.round((n / data.total) * 100)}%` : "–");
  return (
    <section className="surprise-index">
      <h4>Surprise index</h4>
      {data.total === 0 ? (
        <p className="hint">No dates have moved yet.</p>
      ) : (
        <>
          <p className="small">
            <b>
              {data.surprise} of {data.total}
            </b>{" "}
            date moves weren't raised before they were committed: no open risk or action on the deliverable, and no meeting discussed it in the {data.recent_days} days
            before.
          </p>
          <div className="signal-bar" role="img" aria-label={`${data.agreed} agreed at a meeting, ${data.foreseen} raised beforehand, ${data.surprise} not raised`}>
            {(["agreed", "foreseen", "surprise"] as const).map((k) =>
              data[k] ? <span key={k} className={`seg ${k}`} style={{ flexGrow: data[k] }} title={`${data[k]} ${k}`} /> : null,
            )}
          </div>
          <div className="signal-legend small">
            <span>
              <i className="seg agreed" /> agreed at a meeting {share(data.agreed)}
            </span>
            <span>
              <i className="seg foreseen" /> raised beforehand {share(data.foreseen)}
            </span>
            <span>
              <i className="seg surprise" /> not raised {share(data.surprise)}
            </span>
          </div>
          <ul className="surprise-list">
            {data.commits
              .filter((c) => c.kind === "surprise")
              .reverse()
              .map((c) => (
                <li key={c.seq}>
                  <button className="link" onClick={() => props.onViewCommit(c.seq)}>
                    #{c.seq}
                  </button>{" "}
                  <span className="muted">{formatDate(c.date)}</span> {c.deliverables.join(", ")}: <span className="muted">{c.reason}</span>
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}

function preReadMarkdown(title: string, p: PreRead): string {
  const out = [`# Pre-read: ${title}, ${p.as_of}`, ""];
  out.push(p.since.meeting ? `Since ${p.since.meeting}.` : `Since ${p.since.date}.`, "");
  out.push("## Draft agenda", ...p.agenda.map((a, i) => `${i + 1}. ${a}`), "");
  if (p.commits.length) {
    out.push("## Plan changes");
    for (const c of p.commits) {
      const how = c.signal ? (c.signal.kind === "agreed" ? ` (agreed at ${c.signal.by})` : c.signal.kind === "foreseen" ? ` (raised before: ${c.signal.by})` : " (not raised beforehand)") : "";
      out.push(`- #${c.seq}, ${c.date}: ${c.reason}${how}`, ...c.lines.map((l) => `  - ${l}`));
    }
    out.push("");
  }
  if (p.finished.length) out.push("## Finished", ...p.finished.map((f) => `- ${f}`), "");
  if (p.attention.length) out.push("## Needs attention", ...p.attention.map((a) => `- ${a.name}: ${a.status}`), "");
  if (p.coming_up.length) out.push(`## Next ${p.lookahead_days} days`, ...p.coming_up.map((c) => `- ${c.date}: ${c.text}`), "");
  if (p.actions.length)
    out.push("## Open actions", ...p.actions.map((a) => `- ${a.ref} ${a.text}${a.owner ? ` (${a.owner})` : ""}${a.due_on ? `, due ${a.due_on}${a.overdue ? ", overdue" : ""}` : ""}`), "");
  if (p.risks.length) out.push("## Open risks", ...p.risks.map((r) => `- ${r.ref} ${r.text}${r.owner ? ` (${r.owner})` : ""}`), "");
  return out.join("\n");
}

/** Changes since the series last met, what needs attention, what's next, and a draft agenda. */
export function PreReadPanel(props: {
  projectId: string;
  meetingId: number;
  title: string;
  refreshKey: string;
  onViewCommit: (seq: number) => void;
  onSelectDeliverable: (id: string) => void;
}) {
  const [data, setData] = useState<PreRead | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.preread(props.projectId, props.meetingId).then((d) => !cancelled && setData(d)).catch(() => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
  }, [props.projectId, props.meetingId, props.refreshKey]);
  if (!data) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(preReadMarkdown(props.title, data));
      setCopied("Copied as Markdown.");
    } catch {
      setCopied("Couldn't copy.");
    }
  };

  return (
    <details className="preread" open>
      <summary>
        Pre-read <span className="muted small">since {data.since.meeting ?? formatDate(data.since.date)}</span>
      </summary>
      <div className="preread-body">
        <h4>Draft agenda</h4>
        {data.agenda.length ? (
          <ol className="agenda">
            {data.agenda.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ol>
        ) : (
          <p className="muted small">Nothing open. Look at the next {data.lookahead_days} days.</p>
        )}

        <h4>Plan changes since then</h4>
        {data.commits.length === 0 ? (
          <p className="muted small">None.</p>
        ) : (
          <ul className="trail-list compact">
            {data.commits.map((c) => (
              <li key={c.seq} className="trail-entry commit">
                <CommitBlock c={c} onViewCommit={props.onViewCommit} />
              </li>
            ))}
          </ul>
        )}
        {data.finished.length > 0 && (
          <>
            <h4>Finished</h4>
            <ul className="plain-list small">
              {data.finished.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </>
        )}
        {data.attention.length > 0 && (
          <>
            <h4>Needs attention</h4>
            <ul className="plain-list small">
              {data.attention.map((a) => (
                <li key={a.id}>
                  <button className="deliv-chip" onClick={() => props.onSelectDeliverable(a.id)}>
                    {a.name}
                  </button>{" "}
                  <span className={a.kind === "overdue" ? "overdue-text" : "behind-text"}>{a.status}</span>
                  {a.risks.length > 0 && <span className="muted"> · {a.risks.join(", ")}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        {data.coming_up.length > 0 && (
          <>
            <h4>Next {data.lookahead_days} days</h4>
            <ul className="plain-list small">
              {data.coming_up.map((c) => (
                <li key={c.date + c.text}>
                  <span className="muted">{formatDate(c.date)}</span> {c.text}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="row-actions">
          <button className="small" onClick={copy}>
            Copy pre-read
          </button>
          {copied && <span className="muted small">{copied}</span>}
        </div>
      </div>
    </details>
  );
}
