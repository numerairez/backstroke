import { useEffect, useState } from "react";
import { api, type KnowledgeOptions } from "../api/client";

interface Props {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

const QUESTIONS = [
  "Why has the go-live date moved since the original plan, and who agreed each move?",
  "Draft this week's status update for the sponsor.",
  "Which open risks are on the path to the next milestone?",
  "What did we commit to at the last steering committee, and is any of it overdue?",
];

export function KnowledgeDialog(props: Props) {
  const [options, setOptions] = useState<KnowledgeOptions>({ history: true, notes: true, closed: true });
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCopied(null);
    api
      .knowledge(props.projectId, options)
      .then((t) => !cancelled && (setText(t), setError(null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [props.projectId, options]);

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied("Copied. Paste it into your assistant, then ask a question.");
    } catch {
      setCopied("Couldn't copy. Download the file instead.");
    }
  };

  const option = (key: keyof KnowledgeOptions, label: string, hint: string) => (
    <label className="kb-option">
      <input type="checkbox" checked={options[key]} onChange={(e) => setOptions((o) => ({ ...o, [key]: e.target.checked }))} />
      <span>
        {label}
        <span className="muted small"> · {hint}</span>
      </span>
    </label>
  );

  const slug = props.projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal kb-modal" role="dialog" aria-modal="true" aria-labelledby="kb-title" onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
        <h2 id="kb-title">Knowledge base</h2>
        <p className="muted">
          {props.projectName} as one Markdown file: the plan and each deliverable's status, every change and its reason, meetings, and the register. Paste it into any
          assistant and ask about the programme. Nothing leaves Backstroke until you do.
        </p>
        <div className="kb-options">
          {option("history", "Change history", "every commit with its reason")}
          {option("notes", "Meeting notes", "as written")}
          {option("closed", "Closed items", "done actions, closed risks and issues, superseded decisions")}
        </div>
        {error && <p className="callout error small">{error}</p>}
        <pre className="kb-preview" tabIndex={0}>
          {text ?? "Building…"}
        </pre>
        <div className="kb-footer">
          <span className="muted small">{text ? `${text.split("\n").length} lines · about ${Math.round(text.length / 4).toLocaleString()} tokens` : ""}</span>
          <div className="row-actions">
            <a className="small link" href={api.knowledgeUrl(props.projectId, options)} download={`${slug}-knowledge.md`}>
              Download .md
            </a>
            <button className="primary" disabled={!text} onClick={copy}>
              Copy to clipboard
            </button>
          </div>
        </div>
        {copied && <p className="muted small right">{copied}</p>}
        <details className="kb-questions">
          <summary className="small">Questions to ask with it</summary>
          <ul className="small">
            {QUESTIONS.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </details>
        <div className="modal-actions">
          <button className="secondary" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
