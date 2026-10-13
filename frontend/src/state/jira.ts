/** The ticket key from a JIRA link: what follows the last slash, e.g. MNL-418. */
export function jiraKey(url: string): string {
  const path = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return path.slice(path.lastIndexOf("/") + 1) || url;
}
