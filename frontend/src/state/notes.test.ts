import { describe, expect, it } from "vitest";
import type { Deliverable } from "../types";
import { itemsFromNotes, parseDue, parseLine, parseNotes, reasonFromDecisions, setLineTag } from "./notes";

const d = (id: string, name: string): Deliverable => ({ id, name, workstream_id: "w", type: "task", start_date: "2026-10-01", end_date: "2026-10-09" });
const DELIVERABLES = [d("data-mapping", "Data Mapping"), d("go-live", "Go-Live"), d("uat", "UAT")];
const MEETING = "2026-10-08"; // a Thursday

describe("notes markup", () => {
  it("reads an action with an owner, a deliverable and a due date", () => {
    const line = parseLine("!action @Ravi freeze schema v3 for @[Data Mapping] by Fri", 0, DELIVERABLES, MEETING);
    expect(line).toMatchObject({
      kind: "action",
      owner: "Ravi",
      due_on: "2026-10-09",
      deliverable_ids: ["data-mapping"],
      text: "Freeze schema v3 for Data Mapping by Fri",
    });
  });

  it("reads an issue, which is not mistaken for an action", () => {
    const line = parseLine("!issue test environment is down @[UAT] by Fri", 0, DELIVERABLES, MEETING);
    expect(line).toMatchObject({ kind: "issue", deliverable_ids: ["uat"], due_on: null, text: "Test environment is down UAT by Fri" });
    expect(setLineTag("!issue env down", 0, "risk")).toBe("?risk env down");
  });

  it("treats lines without a tag as plain notes", () => {
    const line = parseLine("Ravi: vendor pushed schema v3 on Monday", 0, DELIVERABLES, MEETING);
    expect(line.kind).toBeNull();
    expect(itemsFromNotes([line])).toEqual([]);
    expect(line.text).toBe("Ravi: vendor pushed schema v3 on Monday");
  });

  it("matches a bare mention to a deliverable with its spaces removed, otherwise to a person", () => {
    const line = parseLine("?risk @datamapping could slip, says @Ravi; @UAT shrinks", 0, DELIVERABLES, MEETING);
    expect(line.deliverable_ids).toEqual(["data-mapping", "uat"]);
    expect(line.owner).toBe("Ravi");
  });

  it("flags bracketed names that match no deliverable", () => {
    const line = parseLine("=decision drop @[Data Migration]", 0, DELIVERABLES, MEETING);
    expect(line.unknown).toEqual(["Data Migration"]);
    expect(line.deliverable_ids).toEqual([]);
    expect(line.text).toBe("Drop Data Migration");
  });

  it("keeps an action without a deliverable as programme-level", () => {
    const [item] = itemsFromNotes(parseNotes("!action @Priya book the comms slot by 16 Oct", DELIVERABLES, MEETING));
    expect(item).toMatchObject({ kind: "action", owner: "Priya", text: "Book the comms slot by 16 Oct", due_on: "2026-10-16", deliverable_ids: [] });
  });

  it("only gives actions a due date", () => {
    expect(parseLine("?risk vendor late by Fri", 0, DELIVERABLES, MEETING).due_on).toBeNull();
  });

  it("ignores a tag line with nothing after it", () => {
    expect(itemsFromNotes(parseNotes("!action\n=decision ", DELIVERABLES, MEETING))).toEqual([]);
  });
});

describe("due dates", () => {
  it("reads weekdays as the next one after the meeting", () => {
    expect(parseDue("by Friday", MEETING)).toBe("2026-10-09");
    expect(parseDue("by Thu", MEETING)).toBe("2026-10-15");
    expect(parseDue("by mon", MEETING)).toBe("2026-10-12");
  });

  it("reads day-month in either order and rolls into next year when needed", () => {
    expect(parseDue("by 14 Oct", MEETING)).toBe("2026-10-14");
    expect(parseDue("by Oct 14", MEETING)).toBe("2026-10-14");
    expect(parseDue("by 9 January", MEETING)).toBe("2027-01-09");
    expect(parseDue("by 2026-11-02", MEETING)).toBe("2026-11-02");
  });

  it("returns null without a date", () => {
    expect(parseDue("soon", MEETING)).toBeNull();
    expect(parseDue("by 40 Oct", MEETING)).toBeNull();
  });
});

describe("editing helpers", () => {
  it("sets, changes and clears a line's tag", () => {
    const notes = "first\n!action @Ravi chase";
    expect(setLineTag(notes, 0, "risk")).toBe("?risk first\n!action @Ravi chase");
    expect(setLineTag(notes, 1, "decision")).toBe("first\n=decision @Ravi chase");
    expect(setLineTag(notes, 1, null)).toBe("first\n@Ravi chase");
  });

  it("builds a commit reason from the decisions", () => {
    const items = itemsFromNotes(parseNotes("=decision Accept the slip.\n!action chase\n=decision Hold @[Go-Live]", DELIVERABLES, MEETING));
    expect(reasonFromDecisions(items)).toBe("Accept the slip. Hold Go-Live");
  });
});
