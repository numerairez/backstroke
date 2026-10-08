import { describe, expect, it } from "vitest";
import type { Deliverable, Person } from "../types";
import { parseLine } from "./notes";
import { handle, knownNames, mentionAt, resolvePerson, suggestPeople } from "./people";

const PEOPLE: Person[] = [
  { name: "Ravi Kumar", group: "Data" },
  { name: "Ravi Shah", group: "Data" },
  { name: "Priya", group: "PMO" },
  { name: "Jo O'Neil", group: "AI agent" },
];
const UAT: Deliverable = { id: "uat", name: "UAT", workstream_id: "w", type: "task", start_date: "2026-10-01", end_date: "2026-10-09" };

describe("people", () => {
  it("tags by first name unless it is shared", () => {
    expect(handle("Priya", PEOPLE)).toBe("Priya");
    expect(handle("Jo O'Neil", PEOPLE)).toBe("Jo");
    expect(handle("Ravi Kumar", PEOPLE)).toBe("RaviKumar");
  });

  it("reads a tag back as the person or group it names", () => {
    expect(resolvePerson("RaviKumar", PEOPLE)).toBe("Ravi Kumar");
    expect(resolvePerson("jo", PEOPLE)).toBe("Jo O'Neil");
    expect(resolvePerson("Ravi", PEOPLE)).toBe("Ravi"); // ambiguous: left as written
    expect(resolvePerson("data", PEOPLE)).toBe("Data");
    expect(resolvePerson("AIagent", PEOPLE)).toBe("AI agent");
    expect(resolvePerson("Sam", PEOPLE)).toBe("Sam");
  });

  it("makes the owner of a note line the full name or the group", () => {
    const line = (text: string) => parseLine(text, 0, [UAT], "2026-10-08", PEOPLE);
    expect(line("!action @RaviKumar chase the vendor").owner).toBe("Ravi Kumar");
    expect(line("!action @Data fix the feed").owner).toBe("Data");
    expect(line("!action @UAT sign off").owner).toBeNull(); // deliverables win
  });

  it("suggests people by any word of their name, then groups", () => {
    expect(suggestPeople("sh", PEOPLE).map((s) => s.label)).toEqual(["Ravi Shah"]);
    expect(suggestPeople("a", PEOPLE).map((s) => s.label)).toEqual(["AI agent"]);
    expect(suggestPeople("da", PEOPLE)).toEqual([{ label: "Data", handle: "Data", detail: "group · 2" }]);
    expect(suggestPeople("", PEOPLE, 3)).toHaveLength(3);
  });

  it("finds the @word being typed", () => {
    expect(mentionAt("!action @Ra", 11)).toEqual({ start: 8, query: "Ra" });
    expect(mentionAt("hi @", 4)).toEqual({ start: 3, query: "" });
    expect(mentionAt("mail a@b", 8)).toBeNull();
    expect(mentionAt("@[Data", 6)).toBeNull();
    expect(mentionAt("@Ravi done", 10)).toBeNull();
  });

  it("lists the people first, then other names once", () => {
    expect(knownNames(PEOPLE.slice(2, 3), ["priya", "Dana", "Dana"])).toEqual(["Priya", "Dana"]);
  });
});
