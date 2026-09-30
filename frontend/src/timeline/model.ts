// Renderer-independent timeline model: date scale, lane/row layout, and diff decoration.

import type { Deliverable, PlanState, Workstream } from "../types";
import { daysBetween, fromDay, toDay } from "../state/dates";

export const ROW_HEIGHT = 34;
export const LANE_PADDING = 8;
export const BAR_HEIGHT = 20;
export const HEADER_HEIGHT = 50;
export const EMPTY_LANE_ROWS = 1;

export type ItemStatus = "same" | "changed" | "added" | "removed";

export interface TimelineItem {
  id: string;
  deliverable: Deliverable; // what is drawn solid (for removed items: the ghost's last version)
  ghost: Deliverable | null; // comparison version, if different
  status: ItemStatus;
  startDelta: number;
  endDelta: number;
  laneChanged: boolean;
  rowY: number; // top of row
}

export interface TimelineLane {
  workstream: Workstream;
  removed: boolean;
  y: number;
  height: number;
  items: TimelineItem[];
}

export interface TimelineModel {
  startDay: number;
  endDay: number;
  dayWidth: number;
  width: number;
  height: number;
  lanes: TimelineLane[];
  items: Map<string, TimelineItem>;
  x: (iso: string) => number;
  dayAt: (x: number) => string;
}

export interface ModelInput {
  state: PlanState;
  ghost: PlanState | null;
  /** Deliverable order within lanes; keeps rows stable while items are being dragged. */
  order: string[];
  dayWidth: number;
  today: string;
}

function monthStart(day: number): number {
  const iso = fromDay(day);
  return toDay(`${iso.slice(0, 7)}-01`);
}

function nextMonthStart(day: number): number {
  const [y, m] = fromDay(day).split("-").map(Number);
  return toDay(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`);
}

export function buildTimelineModel({ state, ghost, order, dayWidth, today }: ModelInput): TimelineModel {
  const ghostById = new Map((ghost?.deliverables ?? []).map((d) => [d.id, d]));
  const currentById = new Map(state.deliverables.map((d) => [d.id, d]));

  const allDates = [today];
  for (const d of state.deliverables) allDates.push(d.start_date, d.end_date);
  for (const d of ghost?.deliverables ?? []) allDates.push(d.start_date, d.end_date);
  const days = allDates.map(toDay);
  const startDay = monthStart(Math.min(...days) - 7);
  const endDay = nextMonthStart(Math.max(...days) + 14) - 1;

  const lanesSource: { workstream: Workstream; removed: boolean }[] = state.workstreams.map((w) => ({ workstream: w, removed: false }));
  for (const w of ghost?.workstreams ?? []) {
    if (!state.workstreams.some((s) => s.id === w.id)) lanesSource.push({ workstream: w, removed: true });
  }

  const rank = new Map(order.map((id, i) => [id, i]));
  const sortKey = (d: Deliverable) => rank.get(d.id) ?? Number.MAX_SAFE_INTEGER;

  const items = new Map<string, TimelineItem>();
  const lanes: TimelineLane[] = [];
  let y = 0;
  for (const { workstream, removed } of lanesSource) {
    const members: { deliverable: Deliverable; ghost: Deliverable | null; removedItem: boolean }[] = [];
    for (const d of state.deliverables) {
      if (d.workstream_id === workstream.id) members.push({ deliverable: d, ghost: ghostById.get(d.id) ?? null, removedItem: false });
    }
    if (ghost) {
      for (const g of ghost.deliverables) {
        if (g.workstream_id === workstream.id && !currentById.has(g.id)) members.push({ deliverable: g, ghost: g, removedItem: true });
      }
    }
    members.sort((a, b) => sortKey(a.deliverable) - sortKey(b.deliverable) || a.deliverable.start_date.localeCompare(b.deliverable.start_date) || a.deliverable.id.localeCompare(b.deliverable.id));

    const laneItems: TimelineItem[] = members.map((m, i) => {
      const g = m.ghost;
      let status: ItemStatus = "same";
      if (ghost && m.removedItem) status = "removed";
      else if (ghost && !g) status = "added";
      else if (g && JSON.stringify(g) !== JSON.stringify(m.deliverable)) status = "changed";
      const item: TimelineItem = {
        id: m.deliverable.id,
        deliverable: m.deliverable,
        ghost: status === "changed" || status === "removed" ? g : null,
        status,
        startDelta: g && status === "changed" ? daysBetween(g.start_date, m.deliverable.start_date) : 0,
        endDelta: g && status === "changed" ? daysBetween(g.end_date, m.deliverable.end_date) : 0,
        laneChanged: !!g && g.workstream_id !== m.deliverable.workstream_id,
        rowY: y + LANE_PADDING + i * ROW_HEIGHT,
      };
      items.set(item.id, item);
      return item;
    });
    const height = LANE_PADDING * 2 + Math.max(laneItems.length, EMPTY_LANE_ROWS) * ROW_HEIGHT;
    lanes.push({ workstream, removed, y, height, items: laneItems });
    y += height;
  }

  return {
    startDay,
    endDay,
    dayWidth,
    width: (endDay - startDay + 1) * dayWidth,
    height: y,
    lanes,
    items,
    x: (iso: string) => (toDay(iso) - startDay) * dayWidth,
    dayAt: (px: number) => fromDay(startDay + Math.floor(px / dayWidth)),
  };
}

export interface HeaderTick {
  x: number;
  label: string;
  iso: string;
}

export function monthTicks(model: TimelineModel): HeaderTick[] {
  const ticks: HeaderTick[] = [];
  for (let day = model.startDay; day <= model.endDay; day = nextMonthStart(day)) {
    const iso = fromDay(day);
    ticks.push({ x: (day - model.startDay) * model.dayWidth, label: iso, iso });
  }
  return ticks;
}

export function weekTicks(model: TimelineModel): HeaderTick[] {
  const ticks: HeaderTick[] = [];
  // Mondays
  let day = model.startDay;
  while ((day + 4) % 7 !== 1) day++;
  for (; day <= model.endDay; day += 7) {
    const iso = fromDay(day);
    ticks.push({ x: (day - model.startDay) * model.dayWidth, label: String(Number(iso.slice(8))), iso });
  }
  return ticks;
}
