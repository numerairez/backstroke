import { describe, expect, it } from "vitest";
import type { Deliverable, PlanState } from "../types";
import { moveEnd, moveStart, phaseDeltas, phaseLengths, phaseSpans, refitPhases, removePhase, splitIntoPhases } from "./phases";
import { stageChange } from "./staging";

// 7–26 Sep 2026: 20 days. Dev 12, Review 3, UAT the remaining 5.
const phased: Deliverable = {
  id: "t",
  workstream_id: "w",
  type: "task",
  name: "Ticket",
  start_date: "2026-09-07",
  end_date: "2026-09-26",
  phases: [{ name: "Dev", days: 12 }, { name: "Review", days: 3 }, { name: "UAT" }],
};

describe("phases", () => {
  it("lays phases end to end, the last running to the end date", () => {
    expect(phaseSpans(phased).map((s) => [s.name, s.start, s.end, s.days])).toEqual([
      ["Dev", "2026-09-07", "2026-09-18", 12],
      ["Review", "2026-09-19", "2026-09-21", 3],
      ["UAT", "2026-09-22", "2026-09-26", 5],
    ]);
    expect(phaseSpans({ ...phased, phases: null })).toEqual([]);
  });

  it("breaks a plain deliverable into the default workflow", () => {
    const phases = splitIntoPhases({ ...phased, phases: null })!;
    expect(phases).toEqual([{ name: "Dev", days: 12 }, { name: "Review", days: 3 }, { name: "UAT" }]);
    expect(splitIntoPhases({ ...phased, end_date: "2026-09-08", phases: null })).toBeNull();
  });

  it("absorbs a boundary move into the next phase by default", () => {
    const moved = moveEnd(phased, 0, 2, false);
    expect(moved.end_date).toBe(phased.end_date);
    expect(phaseLengths({ ...phased, ...moved })).toEqual([14, 1, 5]);
    // Can't squeeze Review below one day.
    expect(phaseLengths({ ...phased, ...moveEnd(phased, 0, 10, false) })).toEqual([14, 1, 5]);
  });

  it("pushes the later phases and the end date with push", () => {
    const moved = moveEnd(phased, 0, 2, true);
    expect(moved.end_date).toBe("2026-09-28");
    expect(phaseLengths({ ...phased, ...moved })).toEqual([14, 3, 5]);
  });

  it("keeps inner boundaries fixed when the start or end moves", () => {
    // Start 2 days earlier: Dev grows, Review and UAT keep their dates.
    const earlier = { ...phased, start_date: "2026-09-05", phases: refitPhases(phased, "2026-09-05", phased.end_date) };
    expect(phaseLengths(earlier)).toEqual([14, 3, 5]);
    // End 3 days later: UAT grows.
    const later = { ...phased, end_date: "2026-09-29", phases: refitPhases(phased, phased.start_date, "2026-09-29") };
    expect(phaseLengths(later)).toEqual([12, 3, 8]);
  });

  it("rescales when a date change would squeeze a phase out", () => {
    const phases = refitPhases(phased, "2026-09-20", phased.end_date)!;
    const lengths = phaseLengths({ ...phased, start_date: "2026-09-20", phases });
    expect(lengths.reduce((a, b) => a + b, 0)).toBe(7);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(1);
  });

  it("compares phases only when both versions have the same ones", () => {
    const after = { ...phased, end_date: "2026-09-30", phases: [{ name: "Dev", days: 16 }, { name: "Review", days: 3 }, { name: "UAT" }] };
    expect(phaseDeltas(phased, after)).toEqual([
      { name: "Dev", delta: 4, gapDelta: 0 },
      { name: "Review", delta: 0, gapDelta: 0 },
      { name: "UAT", delta: 0, gapDelta: 0 },
    ]);
    expect(phaseDeltas({ ...phased, phases: null }, after)).toBeNull();
    expect(phaseDeltas(phased, { ...after, phases: [{ name: "Build", days: 16 }, { name: "Test" }] })).toBeNull();
  });

  it("opens a gap by moving a phase's start, keeping its end", () => {
    const moved = moveStart(phased, 1, 2, false);
    expect(moved.end_date).toBe(phased.end_date);
    expect(moved.phases).toEqual([{ name: "Dev", days: 12 }, { name: "Review", days: 1, gap: 2 }, { name: "UAT" }]);
    expect(phaseSpans({ ...phased, ...moved }).map((s) => [s.name, s.start, s.end])).toEqual([
      ["Dev", "2026-09-07", "2026-09-18"],
      ["Review", "2026-09-21", "2026-09-21"],
      ["UAT", "2026-09-22", "2026-09-26"],
    ]);
    // Can't start before the previous phase ends.
    expect(moveStart(phased, 1, -3, false).phases).toEqual(phased.phases);
  });

  it("pushes everything after when a phase's start moves with push", () => {
    const moved = moveStart(phased, 1, 2, true);
    expect(moved.end_date).toBe("2026-09-28");
    expect(moved.phases).toEqual([{ name: "Dev", days: 12 }, { name: "Review", days: 3, gap: 2 }, { name: "UAT" }]);
  });

  it("lets the gap absorb a move of the previous phase's end", () => {
    const withGap = { ...phased, ...moveStart(phased, 1, 2, false) };
    const moved = moveEnd(withGap, 0, 1, false);
    expect(moved.phases).toEqual([{ name: "Dev", days: 13 }, { name: "Review", days: 1, gap: 1 }, { name: "UAT" }]);
    // The gap closes at zero; it doesn't eat into Review.
    expect(moveEnd(withGap, 0, 5, false).phases).toEqual([{ name: "Dev", days: 14 }, { name: "Review", days: 1 }, { name: "UAT" }]);
  });

  it("keeps gaps when the deliverable's dates move", () => {
    const withGap = { ...phased, ...moveStart(phased, 1, 2, false) };
    const phases = refitPhases(withGap, withGap.start_date, "2026-09-29");
    expect(phases).toEqual([{ name: "Dev", days: 12 }, { name: "Review", days: 1, gap: 2 }, { name: "UAT" }]);
  });

  it("removes a phase without moving the others", () => {
    const withGap = { ...phased, ...moveStart(phased, 1, 2, false) };
    // Removing Review: UAT takes over from Review's start and keeps the gap before it.
    expect(removePhase(withGap, 1)).toEqual([{ name: "Dev", days: 12 }, { name: "UAT", gap: 2 }]);
  });

  it("unstages a phases edit that returns to the persisted value", () => {
    const persisted: PlanState = { workstreams: [], deliverables: [phased], dependencies: [] };
    const change = (phases: unknown) => ({ entity_type: "deliverable" as const, entity_id: "t", operation: "update" as const, fields: { phases } });
    const staged = stageChange([], change([{ name: "Dev", days: 10 }, { name: "Review", days: 5 }, { name: "UAT" }]), persisted);
    expect(staged).toHaveLength(1);
    expect(stageChange(staged, change(phased.phases!.map((p) => ({ ...p }))), persisted)).toEqual([]);
  });
});
