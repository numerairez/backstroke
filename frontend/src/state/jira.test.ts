import { describe, expect, it } from "vitest";
import { jiraKey } from "./jira";

describe("jiraKey", () => {
  it("takes what follows the last slash", () => {
    expect(jiraKey("https://acme.atlassian.net/browse/MNL-418")).toBe("MNL-418");
    expect(jiraKey("https://acme.atlassian.net/browse/MNL-418/")).toBe("MNL-418");
    expect(jiraKey("https://acme.atlassian.net/browse/MNL-418?focusedCommentId=1")).toBe("MNL-418");
  });
});
