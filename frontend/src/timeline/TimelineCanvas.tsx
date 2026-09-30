import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Change, Conflict, Deliverable, PlanState } from "../types";
import { addDays, daysBetween, formatDate, formatMonth, signedDays } from "../state/dates";
import { BAR_HEIGHT, HEADER_HEIGHT, ROW_HEIGHT, buildTimelineModel, monthTicks, weekTicks, type TimelineItem, type TimelineModel } from "./model";

export const LANE_COLORS = ["#4f6bed", "#0e9384", "#d97706", "#9b51e0", "#db2777", "#0284c7", "#65a30d", "#dc5a2c"];
const LABEL_WIDTH = 188;
const EDGE_GRAB = 7;

type DragMode = "move" | "start" | "end";
interface DragState {
  id: string;
  mode: DragMode;
  originX: number;
  delta: number;
}

interface Props {
  state: PlanState;
  ghost: PlanState | null;
  order: string[];
  dayWidth: number;
  today: string;
  editable: boolean;
  animate: boolean;
  stagedIds: Set<string>;
  conflicts: Conflict[];
  selectedId: string | null;
  focusKey: string;
  onSelect: (id: string | null) => void;
  onStage: (change: Change) => void;
  onAddDeliverable: (workstreamId: string, date?: string) => void;
}

function applyDrag(d: Deliverable, drag: DragState | null): Deliverable {
  if (!drag || drag.id !== d.id || drag.delta === 0) return d;
  if (drag.mode === "move" || d.type === "milestone") {
    return { ...d, start_date: addDays(d.start_date, drag.delta), end_date: addDays(d.end_date, drag.delta) };
  }
  if (drag.mode === "start") {
    const start = addDays(d.start_date, drag.delta);
    return { ...d, start_date: start > d.end_date ? d.end_date : start };
  }
  const end = addDays(d.end_date, drag.delta);
  return { ...d, end_date: end < d.start_date ? d.start_date : end };
}

interface Geometry {
  x: number;
  w: number;
  cy: number;
  left: number; // where an incoming arrow lands
  right: number; // where an outgoing arrow leaves
}

function geometry(model: TimelineModel, d: Deliverable, rowY: number): Geometry {
  const cy = rowY + ROW_HEIGHT / 2;
  if (d.type === "milestone") {
    const cx = model.x(d.start_date) + model.dayWidth / 2;
    return { x: cx, w: 0, cy, left: cx - 8, right: cx + 8 };
  }
  const x = model.x(d.start_date);
  const w = (daysBetween(d.start_date, d.end_date) + 1) * model.dayWidth;
  return { x, w, cy, left: x, right: x + w };
}

function arrowPath(a: Geometry, b: Geometry): string {
  const x1 = a.right;
  const x2 = b.left;
  if (x2 - x1 >= 14) {
    const mid = x1 + 7;
    return `M${x1},${a.cy} H${mid} V${b.cy} H${x2 - 2}`;
  }
  const dir = b.cy >= a.cy ? 1 : -1;
  const midY = b.cy - dir * (ROW_HEIGHT / 2);
  return `M${x1},${a.cy} h7 V${midY} H${x2 - 9} V${b.cy} H${x2 - 2}`;
}

export function TimelineCanvas(props: Props) {
  const { state, ghost, order, dayWidth, today, editable, animate, stagedIds, conflicts, selectedId } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const model = useMemo(() => buildTimelineModel({ state, ghost, order, dayWidth, today }), [state, ghost, order, dayWidth, today]);
  const laneIndex = useMemo(() => new Map(state.workstreams.map((w, i) => [w.id, i])), [state.workstreams]);
  const conflictDeps = useMemo(() => new Set(conflicts.map((c) => c.dependency_id)), [conflicts]);
  const conflictSuccessors = useMemo(() => new Set(conflicts.map((c) => c.successor_id)), [conflicts]);

  // Scroll so "today" (or the start of the plan) is in view when a project opens.
  const scrolledFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || scrolledFor.current === props.focusKey || model.lanes.length === 0) return;
    scrolledFor.current = props.focusKey;
    const visible = el.clientWidth - LABEL_WIDTH;
    const firstStart = state.deliverables.reduce((min, d) => (d.start_date < min ? d.start_date : min), today);
    const planStart = Math.max(0, model.x(firstStart) - 24);
    const todayX = model.x(today);
    el.scrollLeft = todayX >= planStart && todayX < planStart + visible * 0.85 ? planStart : Math.max(0, todayX - visible * 0.3);
  }, [props.focusKey, model, today]);

  // Keep the day under the cursor fixed when zooming.
  const prevDayWidth = useRef(dayWidth);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || prevDayWidth.current === dayWidth) return;
    const center = (el.scrollLeft + el.clientWidth / 2 - LABEL_WIDTH) / prevDayWidth.current;
    el.scrollLeft = center * dayWidth - el.clientWidth / 2 + LABEL_WIDTH;
    prevDayWidth.current = dayWidth;
  }, [dayWidth]);

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrag(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag]);

  const drawn = (item: TimelineItem) => applyDrag(item.deliverable, drag);

  function onPointerDown(e: React.PointerEvent, item: TimelineItem) {
    if (e.button !== 0) return;
    e.stopPropagation();
    props.onSelect(item.id);
    if (!editable || item.status === "removed") return;
    const d = item.deliverable;
    const g = geometry(model, d, item.rowY);
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!;
    const localX = e.clientX - svg.getBoundingClientRect().left;
    let mode: DragMode = "move";
    if (d.type === "task" && g.w >= EDGE_GRAB * 3) {
      if (localX - g.x <= EDGE_GRAB) mode = "start";
      else if (g.x + g.w - localX <= EDGE_GRAB) mode = "end";
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ id: item.id, mode, originX: e.clientX, delta: 0 });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.originX) / dayWidth);
    if (delta !== drag.delta) setDrag({ ...drag, delta });
  }

  function onPointerUp() {
    if (!drag) return;
    const item = model.items.get(drag.id);
    setDrag(null);
    if (!item || drag.delta === 0) return;
    const before = item.deliverable;
    const after = applyDrag(before, drag);
    const fields: Record<string, string> = {};
    if (after.start_date !== before.start_date) fields.start_date = after.start_date;
    if (after.end_date !== before.end_date) fields.end_date = after.end_date;
    if (Object.keys(fields).length) props.onStage({ entity_type: "deliverable", entity_id: before.id, operation: "update", fields });
  }

  const months = monthTicks(model);
  const weeks = weekTicks(model);
  const todayX = model.x(today);
  const showWeekends = dayWidth >= 10;
  const weekendRects: number[] = [];
  if (showWeekends) {
    for (let day = model.startDay; day <= model.endDay; day++) {
      const wd = (day + 4) % 7;
      if (wd === 6) weekendRects.push((day - model.startDay) * dayWidth);
    }
  }

  const dragging = drag ? model.items.get(drag.id) : null;
  const dragPreview = dragging ? drawn(dragging) : null;

  return (
    <div className={`timeline ${drag ? "is-dragging" : ""}`} ref={scrollRef}>
      <div className="tl-grid" style={{ gridTemplateColumns: `${LABEL_WIDTH}px ${model.width}px` }}>
        <div className="tl-corner" style={{ height: HEADER_HEIGHT }}>
          <span>Workstream</span>
        </div>

        <svg className="tl-header" width={model.width} height={HEADER_HEIGHT} role="presentation">
          {months.map((m) => (
            <g key={m.iso}>
              <line x1={m.x} x2={m.x} y1={0} y2={HEADER_HEIGHT} className="tick-month" />
              <text x={m.x + 8} y={19} className="month-label">
                {formatMonth(m.iso)}
              </text>
            </g>
          ))}
          {weeks.map((w) => (
            <g key={w.iso}>
              <line x1={w.x} x2={w.x} y1={30} y2={HEADER_HEIGHT} className="tick-week" />
              {dayWidth * 7 >= 28 && (
                <text x={w.x + 4} y={44} className="week-label">
                  {w.label}
                </text>
              )}
            </g>
          ))}
          <g transform={`translate(${todayX + dayWidth / 2}, 0)`}>
            <rect x={-20} y={25} width={40} height={14} rx={7} className="today-pill" />
            <text x={0} y={35.5} textAnchor="middle" className="today-label">
              Today
            </text>
          </g>
        </svg>

        <div className="tl-labels">
          {model.lanes.map((lane, i) => (
            <div
              key={lane.workstream.id}
              className={`lane-label ${lane.removed ? "removed" : ""}`}
              style={{ height: lane.height, ["--lane-color" as string]: LANE_COLORS[i % LANE_COLORS.length] }}
            >
              <span className="lane-swatch" />
              <span className="lane-name" title={lane.workstream.name}>
                {lane.workstream.name}
              </span>
              {lane.removed ? (
                <span className="badge removed">Removed</span>
              ) : (
                <span className="lane-count">{lane.items.filter((it) => it.status !== "removed").length}</span>
              )}
              {editable && !lane.removed && (
                <button className="lane-add" title={`Add a deliverable to ${lane.workstream.name}`} onClick={() => props.onAddDeliverable(lane.workstream.id)}>
                  +
                </button>
              )}
            </div>
          ))}
        </div>

        <svg
          className="tl-body"
          width={model.width}
          height={Math.max(model.height, 1)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDrag(null)}
          onPointerDown={() => props.onSelect(null)}
        >
          <defs>
            <pattern id="staged-stripes" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="transparent" />
              <line x1="0" y1="0" x2="0" y2="6" className="stripe" strokeWidth="3" />
            </pattern>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="arrow-head" />
            </marker>
            <marker id="arrow-conflict" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="arrow-head conflict" />
            </marker>
          </defs>

          {weekendRects.map((x) => (
            <rect key={x} x={x} y={0} width={dayWidth * 2} height={model.height} className="weekend" />
          ))}
          {months.map((m) => (
            <line key={m.iso} x1={m.x} x2={m.x} y1={0} y2={model.height} className="grid-month" />
          ))}
          {model.lanes.map((lane, i) => (
            <rect
              key={lane.workstream.id}
              x={0}
              y={lane.y}
              width={model.width}
              height={lane.height}
              className={`lane-band ${i % 2 ? "odd" : ""}`}
              onDoubleClick={(e) => {
                if (!editable || lane.removed) return;
                const svg = (e.currentTarget as SVGElement).ownerSVGElement!;
                props.onAddDeliverable(lane.workstream.id, model.dayAt(e.clientX - svg.getBoundingClientRect().left));
              }}
            />
          ))}
          <line x1={todayX + dayWidth / 2} x2={todayX + dayWidth / 2} y1={0} y2={model.height} className="today-line" />

          {/* Ghost (comparison) bars sit behind everything else. */}
          {[...model.items.values()].map((item) => {
            if (!item.ghost) return null;
            const g = geometry(model, item.ghost, item.rowY);
            return item.ghost.type === "milestone" ? (
              <path key={`ghost-${item.id}`} d={`M${g.x},${g.cy - 8} l8,8 l-8,8 l-8,-8 z`} className="ghost" />
            ) : (
              <rect key={`ghost-${item.id}`} x={g.x} y={g.cy - BAR_HEIGHT / 2} width={g.w} height={BAR_HEIGHT} rx={4} className="ghost" />
            );
          })}

          {state.dependencies.map((dep) => {
            const a = model.items.get(dep.predecessor_id);
            const b = model.items.get(dep.successor_id);
            if (!a || !b) return null;
            const conflict = conflictDeps.has(dep.id);
            const hot = selectedId === a.id || selectedId === b.id;
            return (
              <path
                key={dep.id}
                d={arrowPath(geometry(model, drawn(a), a.rowY), geometry(model, drawn(b), b.rowY))}
                className={`dep ${conflict ? "conflict" : ""} ${hot ? "hot" : ""} ${stagedIds.has(dep.id) ? "staged" : ""}`}
                markerEnd={conflict ? "url(#arrow-conflict)" : "url(#arrow)"}
              />
            );
          })}

          {[...model.items.values()].map((item) => {
            const d = drawn(item);
            const g = geometry(model, d, item.rowY);
            const lane = laneIndex.get(d.workstream_id) ?? 0;
            const color = LANE_COLORS[lane % LANE_COLORS.length];
            const staged = stagedIds.has(item.id);
            const selected = selectedId === item.id;
            const removed = item.status === "removed";
            const conflict = conflictSuccessors.has(item.id);
            const classes = ["item", d.type, staged && "staged", selected && "selected", removed && "removed", editable && !removed && "editable", conflict && "conflict", animate && !drag && "animate"]
              .filter(Boolean)
              .join(" ");
            const labelInside = d.type === "task" && g.w > d.name.length * 6.6 + 16;
            const delta = item.endDelta || item.startDelta;
            const title = d.type === "milestone" ? `${d.name} · ${formatDate(d.start_date)}` : `${d.name} · ${formatDate(d.start_date)} – ${formatDate(d.end_date)} (${daysBetween(d.start_date, d.end_date) + 1}d)`;

            // Everything inside the group is positioned relative to the bar's left edge (or the
            // milestone's centre), so moving between versions is a single animatable transform.
            const barTop = -BAR_HEIGHT / 2;
            let afterX = g.right - g.x + 6;
            const chips: { text: string; cls: string }[] = [];
            if (staged) chips.push({ text: "pending", cls: "pending" });
            if (item.status === "added") chips.push({ text: "Added", cls: "added" });
            if (removed) chips.push({ text: "Removed", cls: "removed" });
            if (item.status === "changed" && delta) chips.push({ text: signedDays(delta), cls: delta > 0 ? "later" : "earlier" });
            if (item.laneChanged) chips.push({ text: "lane moved", cls: "lane" });
            if (conflict) chips.push({ text: "⚠ conflict", cls: "conflict" });
            const outsideLabelX = afterX;
            if (!labelInside) afterX += d.name.length * 6.6 + 8;

            return (
              <g
                key={item.id}
                className={classes}
                style={{ ["--bar" as string]: color, transform: `translate(${g.x}px, ${g.cy}px)` }}
                onPointerDown={(e) => onPointerDown(e, item)}
              >
                <title>{title}</title>
                {d.type === "milestone" ? (
                  <path d="M0,-9 l9,9 l-9,9 l-9,-9 z" className="shape" />
                ) : (
                  <>
                    <rect x={0} y={barTop} width={g.w} height={BAR_HEIGHT} rx={4} style={{ width: g.w }} className="shape" />
                    {staged && <rect x={0} y={barTop} width={g.w} height={BAR_HEIGHT} rx={4} style={{ width: g.w }} fill="url(#staged-stripes)" className="stripes" />}
                    {editable && !removed && g.w >= EDGE_GRAB * 3 && (
                      <>
                        <rect x={0} y={barTop} width={EDGE_GRAB} height={BAR_HEIGHT} className="handle start" />
                        <rect x={g.w - EDGE_GRAB} y={barTop} width={EDGE_GRAB} height={BAR_HEIGHT} className="handle end" />
                      </>
                    )}
                  </>
                )}
                <text x={labelInside ? 8 : outsideLabelX} y={4} className={`bar-label ${labelInside ? "inside" : ""}`}>
                  {d.name}
                </text>
                {chips.map((chip) => {
                  const w = chip.text.length * 6 + 12;
                  const x = afterX;
                  afterX += w + 4;
                  return (
                    <g key={chip.cls} className={`chip ${chip.cls}`}>
                      <rect x={x} y={-8} width={w} height={16} rx={8} />
                      <text x={x + w / 2} y={3.5} textAnchor="middle">
                        {chip.text}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}

          {dragPreview && dragging && drag && drag.delta !== 0 && (
            <g className="drag-tip" transform={`translate(${geometry(model, dragPreview, dragging.rowY).x}, ${dragging.rowY - 4})`}>
              <rect x={-4} y={-18} width={dragPreview.type === "milestone" ? 104 : 150} height={20} rx={5} />
              <text x={4} y={-4}>
                {dragPreview.type === "milestone"
                  ? `${formatDate(dragPreview.start_date)} (${signedDays(drag.delta)})`
                  : `${formatDate(dragPreview.start_date)} – ${formatDate(dragPreview.end_date)} · ${daysBetween(dragPreview.start_date, dragPreview.end_date) + 1}d`}
              </text>
            </g>
          )}
        </svg>
      </div>
      {model.lanes.length === 0 && <div className="timeline-empty">No workstreams yet. Add one from the Inspector to start planning.</div>}
    </div>
  );
}
