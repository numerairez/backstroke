import type { Deliverable, Phase, PlanEvent, PlanState } from "../types";
import { daysBetween, formatDate, signedDays } from "../state/dates";
import { jiraKey } from "../state/jira";
import { phaseDeltas, samePhases } from "../state/phases";

const FIELD_LABELS: Record<string, string> = {
  start_date: "start",
  end_date: "end",
  workstream_id: "lane",
  order_index: "position",
  name: "name",
  type: "type",
};

function nameOf(states: PlanState[], collection: "workstreams" | "deliverables", id: string): string {
  for (const s of states) {
    const hit = (s[collection] as { id: string; name: string }[]).find((e) => e.id === id);
    if (hit) return hit.name;
  }
  return id;
}

export interface EventLine {
  key: string;
  text: string;
  delta?: number;
}

/**
 * Collapse a commit's events into readable lines. `states` are looked up in order for names
 * (pass the version after the commit first, then the one before, so deleted items still resolve).
 */
export function describeEvents(events: PlanEvent[], states: PlanState[]): EventLine[] {
  const lines: EventLine[] = [];
  const milestoneDateSeen = new Set<string>();
  events.forEach((e, i) => {
    const key = `${i}`;
    if (e.entity_type === "dependency") {
      const v = (e.operation === "delete" ? e.old_value : e.new_value) as { predecessor_id: string; successor_id: string } | null;
      const label = v ? `${nameOf(states, "deliverables", v.predecessor_id)} → ${nameOf(states, "deliverables", v.successor_id)}` : e.entity_id;
      if (e.operation === "create") lines.push({ key, text: `Linked ${label}` });
      else if (e.operation === "delete") lines.push({ key, text: `Unlinked ${label}` });
      else lines.push({ key, text: `Changed link ${label}` });
      return;
    }
    const collection = e.entity_type === "workstream" ? "workstreams" : "deliverables";
    const noun = e.entity_type === "workstream" ? "lane" : "";
    if (e.operation === "create") {
      const v = e.new_value as { name: string; start_date?: string; end_date?: string; type?: string };
      const when = v.start_date ? (v.type === "milestone" ? ` on ${formatDate(v.start_date)}` : ` ${formatDate(v.start_date)} – ${formatDate(v.end_date!)}`) : "";
      lines.push({ key, text: `Added ${noun ? noun + " " : ""}${v.name}${when}` });
      return;
    }
    if (e.operation === "delete") {
      const v = e.old_value as { name: string };
      lines.push({ key, text: `Removed ${noun ? noun + " " : ""}${v.name}` });
      return;
    }
    const name = nameOf(states, collection, e.entity_id);
    const field = e.field_name ?? "";
    if (field.endsWith("_date")) {
      // Milestones move start and end together; report once as "date".
      const isMilestone = states.some((s) => s.deliverables.find((d) => d.id === e.entity_id)?.type === "milestone");
      if (isMilestone) {
        if (milestoneDateSeen.has(e.entity_id)) return;
        milestoneDateSeen.add(e.entity_id);
      }
      const delta = daysBetween(String(e.old_value), String(e.new_value));
      const label = isMilestone ? "date" : FIELD_LABELS[field];
      lines.push({ key, text: `${name} ${label} ${formatDate(String(e.old_value))} → ${formatDate(String(e.new_value))} (${signedDays(delta)})`, delta });
      return;
    }
    if (field === "finished_on") {
      lines.push({ key, text: e.new_value ? `${name} done ${formatDate(String(e.new_value))}` : `${name} reopened` });
      return;
    }
    if (field === "phases") {
      // states[0] is the version after the commit, states[1] the one before.
      const after = states[0]?.deliverables.find((d) => d.id === e.entity_id);
      const before = states[1]?.deliverables.find((d) => d.id === e.entity_id) ?? after;
      const oldPhases = e.old_value as Phase[] | null;
      const newPhases = e.new_value as Phase[] | null;
      // Mark done / Reopen change only finish dates.
      const finishes = (newPhases ?? []).flatMap((p) => {
        const was = oldPhases?.find((o) => o.name === p.name)?.finished_on;
        if (was === p.finished_on) return [];
        return [p.finished_on ? `${p.name} done ${formatDate(p.finished_on)}` : `${p.name} reopened`];
      });
      if (oldPhases && newPhases && samePhases(oldPhases, newPhases)) {
        lines.push({ key, text: `${name} ${finishes.join(", ") || "phases changed"}` });
        return;
      }
      if (!oldPhases) lines.push({ key, text: `${name} broken into ${(newPhases ?? []).map((p) => p.name).join(" · ")}` });
      else if (!newPhases) lines.push({ key, text: `${name} phases removed` });
      else {
        const deltas = before && after ? phaseDeltas({ ...before, phases: oldPhases } as Deliverable, { ...after, phases: newPhases } as Deliverable) : null;
        const parts = (deltas ?? []).flatMap((p) => [
          ...(p.gapDelta ? [`gap before ${p.name} ${signedDays(p.gapDelta)}`] : []),
          ...(p.delta ? [`${p.name} ${signedDays(p.delta)}`] : []),
        ]);
        lines.push({ key, text: parts.length ? `${name} ${parts.join(", ")}` : `${name} phases changed` });
      }
      return;
    }
    if (field === "workstream_id") {
      lines.push({ key, text: `${name} lane ${nameOf(states, "workstreams", String(e.old_value))} → ${nameOf(states, "workstreams", String(e.new_value))}` });
      return;
    }
    if (field === "jira_url") {
      lines.push({ key, text: e.new_value ? `${name} JIRA ${jiraKey(String(e.new_value))}` : `${name} JIRA link removed` });
      return;
    }
    if (field === "name") {
      lines.push({ key, text: `Renamed ${noun ? noun + " " : ""}“${String(e.old_value)}” → “${String(e.new_value)}”` });
      return;
    }
    lines.push({ key, text: `${name} ${FIELD_LABELS[field] ?? field}: ${String(e.old_value)} → ${String(e.new_value)}` });
  });
  return lines;
}
