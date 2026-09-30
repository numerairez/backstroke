import { describe, expect, it } from "vitest";
import type { Change, PlanState } from "../types";
import { applyChanges, describeChange, revertEntity, stageChange } from "./staging";

const persisted: PlanState = {
  workstreams: [{ id: "data", name: "Data", order_index: 0 }],
  deliverables: [
    { id: "map", workstream_id: "data", type: "task", name: "Mapping", start_date: "2026-09-28", end_date: "2026-10-09" },
    { id: "uat", workstream_id: "data", type: "task", name: "UAT", start_date: "2026-10-12", end_date: "2026-10-16" },
  ],
  dependencies: [{ id: "d1", predecessor_id: "map", successor_id: "uat", type: "FS" }],
};

const move = (id: string, fields: Record<string, unknown>): Change => ({ entity_type: "deliverable", entity_id: id, operation: "update", fields });

describe("staging", () => {
  it("never mutates the persisted state", () => {
    const snapshot = JSON.stringify(persisted);
    const staged = stageChange([], move("uat", { end_date: "2026-10-23" }), persisted);
    applyChanges(persisted, staged);
    expect(JSON.stringify(persisted)).toBe(snapshot);
  });

  it("merges repeated edits of the same entity into one change", () => {
    let staged = stageChange([], move("uat", { start_date: "2026-10-13", end_date: "2026-10-17" }), persisted);
    staged = stageChange(staged, move("uat", { start_date: "2026-10-19", end_date: "2026-10-23" }), persisted);
    expect(staged).toHaveLength(1);
    expect(staged[0].fields).toEqual({ start_date: "2026-10-19", end_date: "2026-10-23" });
  });

  it("drops a change that returns to the persisted value", () => {
    let staged = stageChange([], move("uat", { end_date: "2026-10-23" }), persisted);
    staged = stageChange(staged, move("uat", { end_date: "2026-10-16" }), persisted);
    expect(staged).toEqual([]);
  });

  it("folds edits of a staged-created entity into its create", () => {
    const create: Change = { entity_type: "deliverable", entity_id: "new", operation: "create", fields: { workstream_id: "data", name: "New", start_date: "2026-10-01", end_date: "2026-10-02" } };
    let staged = stageChange([], create, persisted);
    staged = stageChange(staged, move("new", { name: "Renamed" }), persisted);
    expect(staged).toHaveLength(1);
    expect(staged[0].fields.name).toBe("Renamed");
  });

  it("deleting a staged-created entity removes it and its staged links", () => {
    const create: Change = { entity_type: "deliverable", entity_id: "new", operation: "create", fields: { workstream_id: "data", name: "New", start_date: "2026-10-01", end_date: "2026-10-02" } };
    const link: Change = { entity_type: "dependency", entity_id: "dx", operation: "create", fields: { predecessor_id: "new", successor_id: "uat" } };
    let staged = stageChange(stageChange([], create, persisted), link, persisted);
    staged = stageChange(staged, { entity_type: "deliverable", entity_id: "new", operation: "delete", fields: {} }, persisted);
    expect(staged).toEqual([]);
  });

  it("applies deletes with dependency cascade like the server", () => {
    const staged = stageChange([], { entity_type: "deliverable", entity_id: "map", operation: "delete", fields: {} }, persisted);
    const proposed = applyChanges(persisted, staged);
    expect(proposed.deliverables.map((d) => d.id)).toEqual(["uat"]);
    expect(proposed.dependencies).toEqual([]);
  });

  it("revert restores the persisted value", () => {
    const staged = stageChange([], move("uat", { end_date: "2026-10-23" }), persisted);
    const reverted = revertEntity(staged, "deliverable", "uat");
    expect(applyChanges(persisted, reverted)).toEqual(applyChanges(persisted, []));
  });

  it("describes date movement with signed day deltas", () => {
    const staged = stageChange([], move("uat", { start_date: "2026-10-19", end_date: "2026-10-23" }), persisted);
    const d = describeChange(staged[0], persisted, applyChanges(persisted, staged));
    expect(d.title).toBe("Deliverable “UAT”");
    expect(d.lines).toEqual(["start: 12 Oct → 19 Oct (+7d)", "end: 16 Oct → 23 Oct (+7d)"]);
  });
});
