import { describe, expect, it } from "vitest";
import type { Deliverable } from "../types";
import { itemsFromNotes, parseNotes } from "./notes";
import { appendToNotes, copilotPrompt, importRecap } from "./recap";

const d = (id: string, name: string): Deliverable => ({ id, name, workstream_id: "w", type: "task", start_date: "2026-10-01", end_date: "2026-10-09" });
const DELIVERABLES = [d("data", "Data"), d("data-mapping", "Data Mapping"), d("go-live", "Go-Live"), d("security-review", "Security Review")];
const PEOPLE = ["Priya", "Dana", "Ravi Kumar", "Marco"];

const RECAP = `Meeting notes
- Vendor schema: Ravi walked through how schema v3 affects Data Mapping.
- InfoSec: Security Review started Monday.
- Escalation tool: The group agreed to keep the escalation tool in scope.

**Follow-up tasks**
- Schema freeze: Ravi Kumar will get the vendor to freeze schema v3 for data mapping by Friday.
- [ ] Launch comms: Priya will book a comms slot with Internal Comms by 16 Oct.`;

describe("recap import", () => {
  const lines = importRecap(RECAP, DELIVERABLES, PEOPLE);

  it("keeps discussion as notes and links deliverable names", () => {
    expect(lines[0]).toEqual({ line: "Vendor schema: Ravi walked through how schema v3 affects @[Data Mapping].", why: "" });
    expect(lines[1].line).toBe("InfoSec: @[Security Review] started Monday.");
  });

  it("tags a discussion line that records an agreement as a decision", () => {
    expect(lines[2]).toEqual({ line: "=decision Escalation tool: The group agreed to keep the escalation tool in scope.", why: "says “agreed”" });
  });

  it("tags lines under a follow-up heading as actions owned by the first person named", () => {
    expect(lines[3].line).toBe("!action @Ravi Schema freeze: Ravi Kumar will get the vendor to freeze schema v3 for @[Data Mapping] by Friday.");
    expect(lines[3].why).toBe("under “Follow-up tasks”");
    expect(lines[4].line).toBe("!action @Priya Launch comms: Priya will book a comms slot with Internal Comms by 16 Oct.");
  });

  it("produces items the notes parser reads back", () => {
    const items = itemsFromNotes(parseNotes(appendToNotes("", lines), DELIVERABLES, "2026-10-08"));
    expect(items.map((i) => [i.kind, i.owner, i.due_on, i.deliverable_ids])).toEqual([
      ["decision", null, null, []],
      ["action", "Ravi", "2026-10-09", ["data-mapping"]],
      ["action", "Priya", "2026-10-16", []],
    ]);
  });

  it("passes lines already in Backstroke format through", () => {
    const out = importRecap("!action @Jo ship the fix by Fri\n=decision Hold @[Go-Live]\nPlain note", DELIVERABLES, PEOPLE);
    expect(out.map((l) => l.line)).toEqual(["!action @Jo ship the fix by Fri", "=decision Hold @[Go-Live]", "Plain note"]);
  });

  it("reads markdown headings for decisions and risks", () => {
    const out = importRecap("## Decisions\n- Go-Live stays on 30 Oct\n## Risks\n- Vendor may slip again", DELIVERABLES, PEOPLE);
    expect(out.map((l) => l.line)).toEqual(["=decision @[Go-Live] stays on 30 Oct", "?risk Vendor may slip again"]);
  });

  it("keeps short lines that aren't headings", () => {
    expect(importRecap("Budget OK\nRisks:\n- Vendor late", DELIVERABLES, PEOPLE).map((l) => l.line)).toEqual(["Budget OK", "?risk Vendor late"]);
  });

  it("does not link a short name inside a longer one", () => {
    expect(importRecap("Data quality is fine; Data Mapping is late.", DELIVERABLES, PEOPLE)[0].line).toBe("@[Data] quality is fine; @[Data Mapping] is late.");
  });
});

describe("appending", () => {
  it("adds a blank line between existing notes and the import", () => {
    expect(appendToNotes("first\n", [{ line: "second", why: "" }])).toBe("first\n\nsecond");
    expect(appendToNotes("", [{ line: "only", why: "" }])).toBe("only");
  });
});

describe("Copilot prompt", () => {
  it("lists the people by first name and the deliverables as mentions", () => {
    const prompt = copilotPrompt(DELIVERABLES.slice(1, 3), PEOPLE);
    expect(prompt).toContain("Use only these names: Priya, Dana, Ravi, Marco.");
    expect(prompt).toContain("@[Data Mapping], @[Go-Live]");
  });
});
