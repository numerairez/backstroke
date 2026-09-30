import type { CommitSummary } from "../types";

interface Props {
  version: number;
  viewVersion: number | null;
  commits: CommitSummary[];
  playing: boolean;
  hasStaged: boolean;
  onView: (seq: number | null) => void;
  onPlay: () => void;
  onPause: () => void;
}

export function PlaybackControls({ version, viewVersion, commits, playing, hasStaged, onView, onPlay, onPause }: Props) {
  const shown = viewVersion ?? version;
  const live = viewVersion === null;
  const go = (seq: number) => onView(Math.max(0, Math.min(version, seq)));
  const baselineSeqs = commits.filter((c) => c.baselines.length).map((c) => c.seq);

  return (
    <div className={`playback ${live ? "" : "is-history"}`}>
      <div className="playback-buttons">
        <button className="icon" title="First version" disabled={shown <= 1 && !live} onClick={() => go(1)}>
          ⏮
        </button>
        <button className="icon" title="Previous version (←)" disabled={shown <= 0} onClick={() => go(shown - 1)}>
          ◀
        </button>
        {playing ? (
          <button className="icon play" title="Pause" onClick={onPause}>
            ⏸
          </button>
        ) : (
          <button className="icon play" title="Play history" disabled={version === 0} onClick={onPlay}>
            ▶
          </button>
        )}
        <button className="icon" title="Next version (→)" disabled={live || shown >= version} onClick={() => go(shown + 1)}>
          ▶︎
        </button>
        <button className="icon" title="Latest version" disabled={live} onClick={() => onView(null)}>
          ⏭
        </button>
      </div>
      <div className="playback-label">
        Commit <b>{shown}</b> / {version}
      </div>
      <div className="scrubber">
        <input
          type="range"
          min={0}
          max={Math.max(version, 1)}
          value={shown}
          disabled={version === 0}
          onChange={(e) => {
            const v = Number(e.target.value);
            onView(v === version && live ? null : v);
          }}
          aria-label="History position"
        />
        <div className="scrubber-marks">
          {baselineSeqs.map((seq) => (
            <span key={seq} className="mark" style={{ left: `${(seq / Math.max(version, 1)) * 100}%` }} title="Baseline">
              ⚑
            </span>
          ))}
        </div>
      </div>
      {live ? (
        <span className="mode-pill live">{hasStaged ? "Editing · uncommitted changes" : "Live · editable"}</span>
      ) : (
        <button className="mode-pill history" onClick={() => onView(null)}>
          Read-only history · Return to current
        </button>
      )}
    </div>
  );
}
