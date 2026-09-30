import { describe, expect, it } from "vitest";
import type { Deliverable, PlanState } from "../types";
import { moveEnd } from "./phases";
import { rebaseProgress } from "./staging";
import { deliverableStatus, statusLabel } from "./status";

const plain: Deliverable = { id: "p", workstream_id: "w", type: "task", name: "Security review", start_date: "2026-09-14", end_date: "2026-09-25" };

// Dev 14–26 Sep, Review 27 Sep – 1 Oct, UAT 2–16 Oct.
const ticket: Deliverable = {
  id: "t",
  workstream_id: "w",
  type: "task",
  name: "ACC-88",
  start_date: "2026-09-14",
  end_date: "2026-10-16",
  phases: [{ name: "Dev", days: 13 }, { name: "Review", days: 5 }, { name: "UAT" }],
};

const kind = (d: Deliverable, today: string) => deliverableStatus(d, today)?.kind;

describe("status", () => {
  it("follows the plan for a deliverable without phases", () => {
    expect(kind(plain, "2026-09-13")).toBe("todo");
    expect(kind(plain, "2026-09-14")).toBe("progress");
    expect(deliverableStatus(plain, "2026-09-25")).toMatchObject({ kind: "progress", left: 0 });
    expect(deliverableStatus(plain, "2026-09-30")).toMatchObject({ kind: "overdue", days: 5 });
    expect(statusLabel(deliverableStatus(plain, "2026-09-30")!)).toBe("Overdue 5d");
  });

  it("is done from the finish date on, early or late", () => {
    const late = { ...plain, finished_on: "2026-09-27" };
    expect(deliverableStatus(late, "2026-09-30")).toMatchObject({ kind: "done", delta: 2 });
    expect(statusLabel(deliverableStatus(late, "2026-09-30")!)).toBe("Done · 2 days late");
    // As of a day before the finish, it wasn't done yet.
    expect(kind(late, "2026-09-26")).toBe("overdue");
    expect(deliverableStatus({ ...plain, finished_on: "2026-09-24" }, "2026-09-30")).toMatchObject({ kind: "done", delta: -1 });
  });

  it("is behind when a phase is late but the end date is still ahead", () => {
    const s = deliverableStatus(ticket, "2026-09-30")!;
    expect(s).toMatchObject({ kind: "behind", days: 4 });
    expect(s.current?.name).toBe("Dev");
    expect(s.planned?.name).toBe("Review");
    expect(statusLabel(s)).toBe("Behind · Dev 4d late");
  });

  it("is in progress when the finished phases keep it on plan", () => {
    const onTrack = { ...ticket, phases: [{ name: "Dev", days: 13, finished_on: "2026-09-26" }, { name: "Review", days: 5 }, { name: "UAT" }] };
    expect(deliverableStatus(onTrack, "2026-09-30")).toMatchObject({ kind: "progress", left: 16 });
  });

  it("is overdue, not behind, once the end date has passed", () => {
    expect(deliverableStatus(ticket, "2026-10-20")).toMatchObject({ kind: "overdue", days: 4 });
  });

  it("is done when the last phase is done", () => {
    const done = { ...ticket, phases: ticket.phases!.map((p, i) => ({ ...p, finished_on: ["2026-09-26", "2026-10-01", "2026-10-18"][i] })) };
    expect(deliverableStatus(done, "2026-10-20")).toMatchObject({ kind: "done", delta: 2 });
  });

  it("has no status for milestones", () => {
    expect(deliverableStatus({ ...plain, type: "milestone", end_date: plain.start_date }, "2026-09-30")).toBeNull();
  });

  it("keeps finish dates on staged phase edits", () => {
    const done = { ...ticket, phases: [{ name: "Dev", days: 13, finished_on: "2026-09-26" }, { name: "Review", days: 5 }, { name: "UAT" }] };
    // Plan edits carry the finish along.
    expect(moveEnd(done, 1, 1, false).phases[0].finished_on).toBe("2026-09-26");
    // An edit staged before Mark done picks up the new finish once it's saved.
    const staged = [{ entity_type: "deliverable" as const, entity_id: "t", operation: "update" as const, fields: { phases: moveEnd(ticket, 1, 1, false).phases } }];
    const persisted: PlanState = { workstreams: [], deliverables: [done], dependencies: [] };
    const rebased = rebaseProgress(staged, persisted);
    expect((rebased[0].fields.phases as { finished_on?: string }[])[0].finished_on).toBe("2026-09-26");
  });
});
