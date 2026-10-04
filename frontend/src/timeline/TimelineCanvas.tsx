import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Change, Conflict, Deliverable, PlanState } from "../types";
import { addDays, daysBetween, formatDate, formatMonth, signedDays } from "../state/dates";
import { PHASE_COLORS, hasPhases, minDuration, moveEnd, moveStart, phaseDeltas, phaseLengths, phaseNameOrder, phaseSpans, refitPhases, samePhases } from "../state/phases";
import { deliverableStatus, phaseStatuses, statusLabel } from "../state/status";
import { BAR_HEIGHT, HEADER_HEIGHT, PHASE_ROW_HEIGHT, ROW_HEIGHT, buildTimelineModel, monthTicks, weekTicks, type TimelineItem, type TimelineModel } from "./model";

export const LANE_COLORS = ["#4f6bed", "#0e9384", "#d97706", "#9b51e0", "#db2777", "#0284c7", "#65a30d", "#dc5a2c"];
const LABEL_WIDTH = 188;
const EDGE_GRAB = 7;

type DragMode = "move" | "start" | "end" | "boundary";
interface DragState {
  id: string;
  mode: DragMode;
  originX: number;
  delta: number;
  boundary?: number; // for "boundary": the phase whose edge is being moved
  edge?: "start" | "end"; // for "boundary": which edge of that phase
  push: boolean; // for "boundary": later phases keep their lengths and the end date moves (Shift)
}

export type ColorBy = "lane" | "phase";

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
  /** The day status is judged against: today when live, the commit's date when replaying. */
  asOf: string;
  expanded: Set<string>;
  colorBy: ColorBy;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string | null) => void;
  /** A bar was clicked without being dragged. */
  onPick?: (id: string) => void;
  onStage: (change: Change) => void;
  onAddDeliverable: (workstreamId: string, date?: string) => void;
}

function applyDrag(d: Deliverable, drag: DragState | null): Deliverable {
  if (!drag || drag.id !== d.id || drag.delta === 0) return d;
  if (drag.mode === "move" || d.type === "milestone") {
    return { ...d, start_date: addDays(d.start_date, drag.delta), end_date: addDays(d.end_date, drag.delta) };
  }
  if (drag.mode === "boundary") {
    const move = drag.edge === "start" ? moveStart : moveEnd;
    return { ...d, ...move(d, drag.boundary!, drag.delta, drag.push) };
  }
  if (drag.mode === "start") {
    // The first phase absorbs the change; the bar can't get shorter than one day per phase.
    const latest = addDays(d.end_date, 1 - minDuration(d));
    const start = addDays(d.start_date, drag.delta);
    const clamped = start > latest ? latest : start;
    return { ...d, start_date: clamped, phases: refitPhases(d, clamped, d.end_date) };
  }
  // The last phase absorbs the change, so the end can't move before the last boundary.
  const lengths = phaseLengths(d);
  const earliest = hasPhases(d) ? addDays(d.end_date, 1 - lengths[lengths.length - 1]) : d.start_date;
  const end = addDays(d.end_date, drag.delta);
  return { ...d, end_date: end < earliest ? earliest : end };
}

/** Fill for phase `index` of `count`: shades of the lane colour, or one hue per phase name. */
function phaseFill(colorBy: ColorBy, laneColor: string, index: number, count: number, name: string, order: string[]): { fill: string; solid: boolean } {
  if (colorBy === "phase") return { fill: PHASE_COLORS[Math.max(0, order.indexOf(name)) % PHASE_COLORS.length], solid: true };
  const pct = count <= 1 ? 100 : Math.round(100 - index * (58 / (count - 1)));
  return { fill: pct === 100 ? laneColor : `color-mix(in srgb, ${laneColor} ${pct}%, var(--surface))`, solid: index === 0 };
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
  const { state, ghost, order, dayWidth, today, editable, animate, stagedIds, conflicts, selectedId, expanded, colorBy } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const model = useMemo(() => buildTimelineModel({ state, ghost, order, expanded, dayWidth, today }), [state, ghost, order, expanded, dayWidth, today]);
  const phaseOrder = useMemo(() => phaseNameOrder(state.deliverables), [state.deliverables]);
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
    if (!editable || item.status === "removed") {
      props.onPick?.(item.id);
      return;
    }
    const d = item.deliverable;
    const g = geometry(model, d, item.rowY);
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!;
    const localX = e.clientX - svg.getBoundingClientRect().left;
    let mode: DragMode = "move";
    const handle = e.target as Element;
    let boundary: number | undefined;
    let edge: "start" | "end" | undefined;
    if (handle.hasAttribute("data-boundary")) {
      mode = "boundary";
      boundary = Number(handle.getAttribute("data-boundary"));
      edge = handle.getAttribute("data-edge") === "start" ? "start" : "end";
      // Alt on a boundary with no gap moves only the next phase's start, opening a gap.
      if (edge === "end" && handle.hasAttribute("data-joint") && e.altKey) {
        boundary += 1;
        edge = "start";
      }
    }
    if (mode === "move" && d.type === "task" && g.w >= EDGE_GRAB * 3) {
      if (localX - g.x <= EDGE_GRAB) mode = "start";
      else if (g.x + g.w - localX <= EDGE_GRAB) mode = "end";
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ id: item.id, mode, originX: e.clientX, delta: 0, boundary, edge, push: e.shiftKey });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.originX) / dayWidth);
    if (delta !== drag.delta || e.shiftKey !== drag.push) setDrag({ ...drag, delta, push: e.shiftKey });
  }

  function onPointerUp() {
    if (!drag) return;
    const item = model.items.get(drag.id);
    setDrag(null);
    if (item && drag.delta === 0) props.onPick?.(item.id);
    if (!item || drag.delta === 0) return;
    const before = item.deliverable;
    const after = applyDrag(before, drag);
    const fields: Record<string, unknown> = {};
    if (after.start_date !== before.start_date) fields.start_date = after.start_date;
    if (after.end_date !== before.end_date) fields.end_date = after.end_date;
    if (!samePhases(after.phases, before.phases)) fields.phases = after.phases ?? null;
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
            <pattern id="overrun-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" className="overrun-bg" />
              <rect width="2.5" height="6" className="overrun-stripe" />
            </pattern>
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
            if (item.ghost.type === "milestone") return <path key={`ghost-${item.id}`} d={`M${g.x},${g.cy - 8} l8,8 l-8,8 l-8,-8 z`} className="ghost" />;
            // A thin strip under the bar shows the comparison version's phases.
            const ghostSpans = phaseSpans(item.ghost);
            const laneColor = LANE_COLORS[(laneIndex.get(item.ghost.workstream_id) ?? 0) % LANE_COLORS.length];
            return (
              <g key={`ghost-${item.id}`}>
                <rect x={g.x} y={g.cy - BAR_HEIGHT / 2} width={g.w} height={BAR_HEIGHT} rx={4} className="ghost" />
                {ghostSpans.map((sp) => (
                  <rect
                    key={sp.index}
                    x={model.x(sp.start)}
                    y={g.cy + BAR_HEIGHT / 2 + 2}
                    width={Math.max(1, sp.days * dayWidth - 1)}
                    height={4}
                    rx={1.5}
                    className="ghost-phase"
                    style={{ fill: phaseFill(colorBy, laneColor, sp.index, ghostSpans.length, sp.name, phaseOrder).fill }}
                  >
                    <title>{`Before: ${sp.name} ${formatDate(sp.start)} – ${formatDate(sp.end)} (${sp.days}d)`}</title>
                  </rect>
                ))}
              </g>
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
            const laneColor = LANE_COLORS[lane % LANE_COLORS.length];
            const spans = d.type === "task" ? phaseSpans(d) : [];
            const phased = spans.length > 0;
            // Colouring by phase greys out bars that have no phases.
            const color = colorBy === "phase" && !phased && d.type === "task" ? "var(--plain-bar)" : laneColor;
            const staged = stagedIds.has(item.id);
            const selected = selectedId === item.id;
            const removed = item.status === "removed";
            const conflict = conflictSuccessors.has(item.id);
            const status = removed ? null : deliverableStatus(d, props.asOf);
            const phaseStates = phased && !removed ? phaseStatuses(d, props.asOf) : [];
            const rx = (day: string) => model.x(day) - g.x; // relative to the bar's left edge
            const overrunEnd = status?.kind === "overdue" ? rx(addDays(props.asOf, 1)) : 0;
            const checkX = status?.kind === "done" ? rx(status.finishedOn!) + dayWidth / 2 : null;
            const classes = ["item", d.type, phased && "phased", status && `st-${status.kind}`, staged && "staged", selected && "selected", removed && "removed", editable && !removed && "editable", conflict && "conflict", animate && !drag && "animate"]
              .filter(Boolean)
              .join(" ");
            const labelInside = d.type === "task" && !phased && g.w > d.name.length * 6.6 + 16;
            const delta = item.endDelta || item.startDelta;
            let title = d.type === "milestone" ? `${d.name} · ${formatDate(d.start_date)}` : `${d.name} · ${formatDate(d.start_date)} – ${formatDate(d.end_date)} (${daysBetween(d.start_date, d.end_date) + 1}d)`;
            if (phased) title += "\n" + phaseStates.map(({ span: sp, status: ps }) => `${sp.name}: ${formatDate(sp.start)} – ${formatDate(sp.end)} (${sp.days}d) · ${statusLabel(ps)}`).join("\n");
            if (status) title += `\n${statusLabel(status)}`;

            // Everything inside the group is positioned relative to the bar's left edge (or the
            // milestone's centre), so moving between versions is a single animatable transform.
            const barTop = -BAR_HEIGHT / 2;
            let afterX = Math.max(g.right - g.x, overrunEnd, checkX === null ? 0 : checkX + 8) + 6;
            const chips: { text: string; cls: string }[] = [];
            if (staged) chips.push({ text: "pending", cls: "pending" });
            if (status?.kind === "done") chips.push({ text: `done ${formatDate(status.finishedOn!)}${status.delta ? ` · ${signedDays(status.delta)}` : ""}`, cls: "done" });
            if (status?.kind === "overdue") chips.push({ text: `overdue ${status.days}d`, cls: "overdue" });
            if (status?.kind === "behind") chips.push({ text: `behind · ${status.current!.name} ${status.days}d late`, cls: "behind" });
            if (item.status === "added") chips.push({ text: "Added", cls: "added" });
            if (removed) chips.push({ text: "Removed", cls: "removed" });
            if (item.status === "changed" && delta) chips.push({ text: signedDays(delta), cls: delta > 0 ? "later" : "earlier" });
            if (item.laneChanged) chips.push({ text: "lane moved", cls: "lane" });
            if (item.ghost && item.status === "changed" && !samePhases(item.ghost.phases, d.phases)) chips.push({ text: "phases", cls: "phases" });
            if (conflict) chips.push({ text: "⚠ conflict", cls: "conflict" });
            // Phased bars get an expand toggle right after the bar, clear of incoming dependency arrows.
            const toggleX = afterX + 10;
            if (phased && !removed) afterX += 22;
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
                    {/* Overdue: hatched from the planned end to today. */}
                    {overrunEnd > g.w && <rect x={g.w} y={barTop} width={overrunEnd - g.w} height={BAR_HEIGHT} rx={3} className="overrun" />}
                    {phased && (
                      <>
                        <clipPath id={`phase-clip-${item.id}`}>
                          <rect x={0} y={barTop} width={g.w} height={BAR_HEIGHT} rx={4} />
                        </clipPath>
                        <g clipPath={`url(#phase-clip-${item.id})`} className="segments">
                          {spans.map((sp) => {
                            const sx = daysBetween(d.start_date, sp.start) * dayWidth;
                            const sw = sp.days * dayWidth;
                            const f = phaseFill(colorBy, laneColor, sp.index, spans.length, sp.name, phaseOrder);
                            const done = phaseStates[sp.index]?.status.kind === "done";
                            const full = (done ? "✓ " : "") + sp.name;
                            const label = sw > full.length * 6.2 + 12 ? full : sw >= 16 ? (done ? "✓" : sp.name[0]) : "";
                            const gx = sx - sp.gap * dayWidth;
                            return (
                              <g key={sp.index}>
                                {sp.gap > 0 && (
                                  <>
                                    <rect x={gx} y={barTop} width={sp.gap * dayWidth} height={BAR_HEIGHT} className="seg-gap">
                                      <title>{`${sp.gap}d gap before ${sp.name}`}</title>
                                    </rect>
                                    <line x1={gx} x2={sx} y1={0} y2={0} className="seg-gap-line" />
                                  </>
                                )}
                                <rect x={sx} y={barTop} width={sw} height={BAR_HEIGHT} className={`seg ${done ? "done" : ""}`} style={{ fill: f.fill }} />
                                {label && (
                                  <text x={sx + sw / 2} y={4} textAnchor="middle" className={`seg-label ${f.solid ? "solid" : "tint"}`}>
                                    {label}
                                  </text>
                                )}
                                {sp.index > 0 && sp.gap === 0 && <line x1={sx} x2={sx} y1={barTop} y2={barTop + BAR_HEIGHT} className="seg-sep" />}
                              </g>
                            );
                          })}
                        </g>
                      </>
                    )}
                    <rect x={0} y={barTop} width={g.w} height={BAR_HEIGHT} rx={4} style={{ width: g.w }} className="shape" />
                    {/* A phase past its end and not done: red underline from its end to today. */}
                    {phaseStates
                      .filter((p) => p.status.kind === "overdue")
                      .map((p) => {
                        const x = rx(addDays(p.span.end, 1));
                        return (
                          <rect key={`late-${p.span.index}`} x={x} y={-barTop + 2} width={Math.max(2, rx(addDays(props.asOf, 1)) - x)} height={3} rx={1.5} className="phase-overrun">
                            <title>{`${p.span.name} ${p.status.days}d late`}</title>
                          </rect>
                        );
                      })}
                    {/* Done: a check on the actual finish date, linked back to the bar when it finished late. */}
                    {checkX !== null && (
                      <g className="finish">
                        {checkX > g.w + 7 && <line x1={g.w} x2={checkX - 7} y1={0} y2={0} className="finish-link" />}
                        <circle cx={checkX} cy={0} r={7} />
                        <path d={`M${checkX - 3.2},0 l2.2,2.3 l4.2,-4.6`} />
                      </g>
                    )}
                    {staged && <rect x={0} y={barTop} width={g.w} height={BAR_HEIGHT} rx={4} style={{ width: g.w }} fill="url(#staged-stripes)" className="stripes" />}
                    {editable && !removed && g.w >= EDGE_GRAB * 3 && (
                      <>
                        <rect x={0} y={barTop} width={EDGE_GRAB} height={BAR_HEIGHT} className="handle start" />
                        <rect x={g.w - EDGE_GRAB} y={barTop} width={EDGE_GRAB} height={BAR_HEIGHT} className="handle end" />
                      </>
                    )}
                    {editable &&
                      !removed &&
                      spans.slice(1).flatMap((sp) => {
                        const prev = spans[sp.index - 1];
                        const endX = (daysBetween(d.start_date, prev.end) + 1) * dayWidth;
                        const startX = daysBetween(d.start_date, sp.start) * dayWidth;
                        if (sp.gap === 0) {
                          return [
                            <rect key={`j${sp.index}`} x={endX - 4} y={barTop - 2} width={8} height={BAR_HEIGHT + 4} className="handle boundary" data-boundary={prev.index} data-edge="end" data-joint="">
                              <title>{`Drag to move the end of ${prev.name}. Shift pushes the later phases; Alt moves only the start of ${sp.name}, leaving a gap.`}</title>
                            </rect>,
                          ];
                        }
                        return [
                          <rect key={`e${prev.index}`} x={endX - 4} y={barTop - 2} width={8} height={BAR_HEIGHT + 4} className="handle boundary" data-boundary={prev.index} data-edge="end">
                            <title>{`Drag to move the end of ${prev.name}. Shift pushes the later phases.`}</title>
                          </rect>,
                          <rect key={`s${sp.index}`} x={startX - 4} y={barTop - 2} width={8} height={BAR_HEIGHT + 4} className="handle boundary" data-boundary={sp.index} data-edge="start">
                            <title>{`Drag to move the start of ${sp.name}. Shift pushes the later phases.`}</title>
                          </rect>,
                        ];
                      })}
                    {phased && !removed && (
                      <g
                        className="phase-toggle"
                        transform={`translate(${toggleX}, 0)`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          props.onToggleExpand(item.id);
                        }}
                      >
                        <title>{expanded.has(item.id) ? "Hide phase rows" : "Show phases as rows"}</title>
                        <rect x={-7} y={-9} width={14} height={18} rx={4} />
                        <path d={expanded.has(item.id) ? "M-3.5,-1.5 L0,2 L3.5,-1.5" : "M-1.5,-3.5 L2,0 L-1.5,3.5"} />
                      </g>
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

          {[...model.items.values()].map((item) => {
            if (!item.phaseRows) return null;
            const d = drawn(item);
            const spans = phaseSpans(d);
            const ghostSpans = item.ghost ? phaseSpans(item.ghost) : [];
            const comparable = !!phaseDeltas(item.ghost, d);
            const laneColor = LANE_COLORS[(laneIndex.get(d.workstream_id) ?? 0) % LANE_COLORS.length];
            const top = item.rowY + ROW_HEIGHT;
            const guideX = model.x(d.start_date) - 13;
            return (
              <g key={`phases-${item.id}`} className="phase-rows">
                <line x1={guideX} x2={guideX} y1={top - 4} y2={top + spans.length * PHASE_ROW_HEIGHT - 6} className="phase-guide" />
                {spans.map((sp) => {
                  const y = top + sp.index * PHASE_ROW_HEIGHT;
                  const x = model.x(sp.start);
                  const w = sp.days * dayWidth;
                  const gs = comparable ? ghostSpans[sp.index] : undefined;
                  const delta = gs ? sp.days - gs.days : 0;
                  const labelX = Math.max(x + w, gs ? model.x(gs.start) + gs.days * dayWidth : 0) + 8;
                  return (
                    <g key={sp.index}>
                      {gs && <rect x={model.x(gs.start)} y={y + 3} width={gs.days * dayWidth} height={10} rx={3} className="phase-row-ghost" />}
                      <rect x={x} y={y + 4} width={w} height={8} rx={3} style={{ fill: phaseFill(colorBy, laneColor, sp.index, spans.length, sp.name, phaseOrder).fill }} />
                      <text x={labelX} y={y + 11.5} className="phase-row-label">
                        {`${sp.name} · ${formatDate(sp.start)} – ${formatDate(sp.end)} · ${sp.days}d${sp.gap ? ` · after ${sp.gap}d gap` : ""}`}
                        {delta !== 0 && <tspan className={delta > 0 ? "later" : "earlier"}>{`  ${signedDays(delta)}`}</tspan>}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}

          {dragPreview && dragging && drag && drag.delta !== 0 && drag.mode === "boundary" && (() => {
            const spans = phaseSpans(dragPreview);
            const sp = spans[drag.boundary!];
            const pushed = drag.push ? ` · pushes end to ${formatDate(dragPreview.end_date)}` : "";
            let text: string;
            let anchor: string;
            if (drag.edge === "start") {
              text = `${sp.name} starts ${formatDate(sp.start)} · ${sp.gap ? `${sp.gap}d gap before` : "no gap"} · ${sp.days}d${pushed}`;
              anchor = sp.start;
            } else {
              const next = spans[drag.boundary! + 1];
              const after = next.gap ? `${next.gap}d gap` : `${next.name} ${next.days}d`;
              text = `${sp.name} ${sp.days}d · ends ${formatDate(sp.end)}${drag.push ? pushed : ` · ${after}`}`;
              anchor = addDays(sp.end, 1);
            }
            return (
              <g className="drag-tip" transform={`translate(${model.x(anchor)}, ${dragging.rowY - 4})`}>
                <rect x={-4} y={-18} width={text.length * 6.3 + 12} height={20} rx={5} />
                <text x={4} y={-4}>
                  {text}
                </text>
              </g>
            );
          })()}

          {dragPreview && dragging && drag && drag.delta !== 0 && drag.mode !== "boundary" && (
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
