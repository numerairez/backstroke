// Lane order, and the order of bars within a lane, are display settings saved on the project,
// outside the plan's history: reordering is saved at once for everyone and never becomes a staged
// change or a commit. Which lane a bar is in is part of the plan, so that is still committed.

import type { Deliverable, Workstream } from "../types";

/** Lanes in the project's saved order; any it doesn't list follow, in plan order. */
export function orderLanes(workstreams: Workstream[], laneOrder: string[]): Workstream[] {
  const rank = new Map(laneOrder.map((id, i) => [id, i]));
  const at = (w: Workstream) => rank.get(w.id) ?? laneOrder.length;
  return [...workstreams].sort((a, b) => at(a) - at(b) || a.order_index - b.order_index);
}

/** The lane ids with `id` moved to just before `beforeId` (null: to the end), or null if that changes nothing. */
export function moveLane(ids: string[], id: string, beforeId: string | null): string[] | null {
  if (!ids.includes(id) || beforeId === id) return null;
  const rest = ids.filter((x) => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  if (at < 0) return null;
  rest.splice(at, 0, id);
  return rest.every((x, i) => x === ids[i]) ? null : rest;
}

/** Deliverable ids in display order: the project's saved row order, then the rest by start date. */
export function orderRows(deliverables: Deliverable[], rowOrder: string[]): string[] {
  const rank = new Map(rowOrder.map((id, i) => [id, i]));
  const at = (d: Deliverable) => rank.get(d.id) ?? rowOrder.length;
  return [...deliverables].sort((a, b) => at(a) - at(b) || a.start_date.localeCompare(b.start_date) || a.id.localeCompare(b.id)).map((d) => d.id);
}

/**
 * The row order with `id` moved to just before `beforeId`, or (for null) just after the last of
 * `laneIds`, the bars in the lane it's dropped in. Null if that lane's order wouldn't change.
 */
export function moveRow(order: string[], id: string, beforeId: string | null, laneIds: string[]): string[] | null {
  if (beforeId === id) return null;
  const lane = new Set(laneIds);
  const rest = order.filter((x) => x !== id);
  let at: number;
  if (beforeId !== null) at = rest.indexOf(beforeId);
  else {
    const last = rest.reduce((found, x, i) => (lane.has(x) ? i : found), -1);
    at = last < 0 ? rest.length : last + 1;
  }
  if (at < 0) return null;
  rest.splice(at, 0, id);
  const inLane = (ids: string[]) => ids.filter((x) => lane.has(x)).join("\n");
  return lane.has(id) && inLane(rest) === inLane(order) ? null : rest;
}
