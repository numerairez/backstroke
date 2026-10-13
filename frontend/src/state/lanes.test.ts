import { describe, expect, it } from "vitest";
import { moveLane, moveRow, orderLanes, orderRows } from "./lanes";

const lanes = [
  { id: "a", name: "A", order_index: 0 },
  { id: "b", name: "B", order_index: 1 },
  { id: "c", name: "C", order_index: 2 },
  { id: "d", name: "D", order_index: 3 },
];
const ids = (ws: { id: string }[]) => ws.map((w) => w.id);

describe("orderLanes", () => {
  it("follows the plan's order until the project saves its own", () => {
    expect(ids(orderLanes(lanes, []))).toEqual(["a", "b", "c", "d"]);
    expect(ids(orderLanes(lanes, ["c", "a"]))).toEqual(["c", "a", "b", "d"]); // unlisted lanes follow
    expect(ids(orderLanes(lanes, ["gone", "d"]))).toEqual(["d", "a", "b", "c"]);
  });
});

describe("moveLane", () => {
  const order = ["a", "b", "c", "d"];
  it("moves a lane up, down or to the end", () => {
    expect(moveLane(order, "c", "a")).toEqual(["c", "a", "b", "d"]);
    expect(moveLane(order, "a", "c")).toEqual(["b", "a", "c", "d"]);
    expect(moveLane(order, "b", null)).toEqual(["a", "c", "d", "b"]);
  });

  it("is null when the lane wouldn't move", () => {
    expect(moveLane(order, "b", "b")).toBeNull();
    expect(moveLane(order, "b", "c")).toBeNull();
    expect(moveLane(order, "d", null)).toBeNull();
    expect(moveLane(order, "x", "a")).toBeNull();
  });
});

describe("orderRows", () => {
  const bar = (id: string, start_date: string) => ({ id, workstream_id: "w", type: "task" as const, name: id, start_date, end_date: start_date });
  const bars = [bar("late", "2026-11-01"), bar("early", "2026-10-01"), bar("mid", "2026-10-15")];
  it("goes by start date until rows are reordered, then puts new bars last", () => {
    expect(orderRows(bars, [])).toEqual(["early", "mid", "late"]);
    expect(orderRows(bars, ["late", "early"])).toEqual(["late", "early", "mid"]);
  });
});

describe("moveRow", () => {
  // Lane X holds a, b, c; lane Y holds d, e.
  const order = ["a", "d", "b", "e", "c"];
  it("moves a bar above another, in its lane or another", () => {
    expect(moveRow(order, "c", "a", ["a", "b", "c"])).toEqual(["c", "a", "d", "b", "e"]);
    expect(moveRow(order, "a", "e", ["d", "e"])).toEqual(["d", "b", "a", "e", "c"]);
  });

  it("drops a bar after the last one in the lane", () => {
    expect(moveRow(order, "a", null, ["a", "b", "c"])).toEqual(["d", "b", "e", "c", "a"]);
    expect(moveRow(order, "a", null, ["d", "e"])).toEqual(["d", "b", "e", "a", "c"]);
    expect(moveRow(order, "a", null, [])).toEqual(["d", "b", "e", "c", "a"]); // an empty lane
  });

  it("is null when the order wouldn't change", () => {
    expect(moveRow(order, "b", "b", ["a", "b", "c"])).toBeNull();
    expect(moveRow(order, "b", "c", ["a", "b", "c"])).toBeNull();
    expect(moveRow(order, "c", null, ["a", "b", "c"])).toBeNull();
  });
});
