import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Change, PlanState } from "../types";
import { DeliverableDetails } from "./DeliverableDetails";
import { DeliverableHistory } from "./Trail";

export type DetailsTab = "details" | "history";

interface Props {
  id: string;
  tab: DetailsTab;
  onTab: (tab: DetailsTab) => void;
  /** Focus and select the name, for a deliverable just added. */
  focusName: boolean;
  state: PlanState;
  persisted: PlanState;
  editable: boolean;
  stagedIds: Set<string>;
  asOf: string;
  projectId: string;
  /** The history trail can be shown: live view and the deliverable is committed. */
  hasHistory: boolean;
  refreshKey: string;
  onStage: (change: Change) => void;
  onRevert: (id: string) => void;
  onSelect: (id: string | null) => void;
  onProgress: (id: string, phase: number | null, finishedOn: string | null) => Promise<void>;
  onViewCommit: (seq: number) => void;
  onOpenMeeting: (meetingId: number) => void;
  onClose: () => void;
}

const WIDTH = 380;
const GAP = 10;

/** Where the card goes: beside the bar if there's room, else below or above it, always in the window. */
function placeBeside(anchor: DOMRect | null, height: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampTop = (t: number) => Math.max(GAP, Math.min(t, vh - height - GAP));
  const clampLeft = (l: number) => Math.max(GAP, Math.min(l, vw - WIDTH - GAP));
  if (!anchor) return { left: vw - WIDTH - 24, top: clampTop(120) };
  const right = Math.min(anchor.right, vw * 0.7);
  if (right + GAP + WIDTH <= vw - GAP) return { left: right + GAP, top: clampTop(anchor.top - 40) };
  if (anchor.bottom + GAP + height <= vh) return { left: clampLeft(anchor.left), top: anchor.bottom + GAP };
  if (anchor.top - GAP - height >= 0) return { left: clampLeft(anchor.left), top: anchor.top - GAP - height };
  return { left: clampLeft(anchor.left - WIDTH - GAP), top: clampTop(anchor.top - 40) };
}

/** A floating card with one deliverable's details, opened from the bar. It can be dragged by its header. */
export function DetailsCard(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const moved = useRef(false);
  const d = props.state.deliverables.find((x) => x.id === props.id);

  // Re-anchor to the bar when another one is opened, unless the card was moved by hand.
  useLayoutEffect(() => {
    if (moved.current && pos) return;
    const bar = document.querySelector(`[data-item-id="${CSS.escape(props.id)}"]`);
    setPos(placeBeside(bar?.getBoundingClientRect() ?? null, ref.current?.offsetHeight ?? 420));
  }, [props.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A deliverable just added: put the cursor in its name once the card is visible.
  const placed = pos !== null;
  useEffect(() => {
    if (!placed || !props.focusName) return;
    const input = ref.current?.querySelector<HTMLInputElement>(".title-input");
    input?.focus();
    input?.select();
  }, [placed, props.focusName, props.id]);

  useEffect(() => {
    const onResize = () => setPos((p) => p && { left: Math.min(p.left, window.innerWidth - WIDTH - GAP), top: Math.min(p.top, window.innerHeight - 80) });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest("button") || !pos) return;
    e.preventDefault();
    const head = e.currentTarget as HTMLElement;
    head.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, ...pos };
    const onMove = (ev: PointerEvent) => {
      moved.current = true;
      setPos({
        left: Math.max(0, Math.min(start.left + ev.clientX - start.x, window.innerWidth - 80)),
        top: Math.max(0, Math.min(start.top + ev.clientY - start.y, window.innerHeight - 40)),
      });
    };
    const onUp = () => {
      head.removeEventListener("pointermove", onMove);
      head.removeEventListener("pointerup", onUp);
    };
    head.addEventListener("pointermove", onMove);
    head.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={ref}
      className="details-card"
      role="dialog"
      aria-label={d ? `${d.name} details` : "Details"}
      style={pos ? { left: pos.left, top: pos.top, width: WIDTH } : { visibility: "hidden", width: WIDTH }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !(e.target as HTMLElement).matches("input, select, textarea")) {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div className="details-card-head" onPointerDown={startMove} title="Drag to move">
        <div className="seg-toggle" role="tablist">
          <button role="tab" aria-pressed={props.tab === "details"} onClick={() => props.onTab("details")}>
            Details
          </button>
          <button role="tab" aria-pressed={props.tab === "history"} disabled={!props.hasHistory} title={props.hasHistory ? undefined : "Not committed yet"} onClick={() => props.onTab("history")}>
            History
          </button>
        </div>
        <span className="spacer" />
        {!props.editable && <span className="muted small">read-only</span>}
        <button className="icon" aria-label="Close" title="Close (Esc)" onClick={props.onClose}>
          ×
        </button>
      </div>
      <div className="details-card-body">
        {props.tab === "history" && props.hasHistory ? (
          <DeliverableHistory projectId={props.projectId} deliverableId={props.id} refreshKey={props.refreshKey} onViewCommit={props.onViewCommit} onOpenMeeting={props.onOpenMeeting} />
        ) : (
          <DeliverableDetails
            state={props.state}
            persisted={props.persisted}
            selectedId={props.id}
            editable={props.editable}
            stagedIds={props.stagedIds}
            asOf={props.asOf}
            onProgress={props.onProgress}
            onStage={props.onStage}
            onRevert={props.onRevert}
            onSelect={props.onSelect}
          />
        )}
      </div>
    </div>
  );
}
