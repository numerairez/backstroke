// Local staged-change model. Staged changes are the only way the UI proposes plan edits;
// nothing here is persisted until the server accepts a commit containing them.

import type { Change, Deliverable, Dependency, EntityType, Phase, PlanState, Workstream } from "../types";
import { daysBetween, formatDate, signedDays } from "./dates";
import { carryProgress, describePhases, hasPhases } from "./phases";

const COLLECTION = { workstream: "workstreams", deliverable: "deliverables", dependency: "dependencies" } as const;

type Entity = Workstream | Deliverable | Dependency;

export function newId(entityType: EntityType): string {
  const prefix = { workstream: "ws", deliverable: "dl", dependency: "dep" }[entityType];
  return `${prefix}-${Math.random().toString(16).slice(2, 12).padEnd(10, "0")}`;
}

function find(state: PlanState, type: EntityType, id: string): Entity | undefined {
  return (state[COLLECTION[type]] as Entity[]).find((e) => e.id === id);
}

/** Field values are strings, numbers, null or (for phases) plain JSON. */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function referencesDeliverable(change: Change, deliverableId: string): boolean {
  return (
    change.entity_type === "dependency" &&
    change.operation === "create" &&
    (change.fields.predecessor_id === deliverableId || change.fields.successor_id === deliverableId)
  );
}

/** Add `change` to `staged`, folding it into earlier staged edits of the same entity. */
export function stageChange(staged: Change[], change: Change, persisted: PlanState): Change[] {
  const { entity_type: type, entity_id: id } = change;
  const sameEntity = (c: Change) => c.entity_type === type && c.entity_id === id;
  const existing = staged.find(sameEntity);

  if (change.operation === "create") return [...staged, change];

  if (change.operation === "update") {
    if (existing?.operation === "delete") return staged;
    if (existing?.operation === "create") {
      return staged.map((c) => (c === existing ? { ...c, fields: { ...c.fields, ...change.fields } } : c));
    }
    const base = find(persisted, type, id) as Record<string, unknown> | undefined;
    const merged = { ...(existing?.fields ?? {}), ...change.fields };
    for (const [key, value] of Object.entries(merged)) {
      if (base && sameValue(base[key], value)) delete merged[key];
    }
    const rest = staged.filter((c) => !sameEntity(c));
    if (Object.keys(merged).length === 0) return rest;
    const updated: Change = { entity_type: type, entity_id: id, operation: "update", fields: merged };
    if (!existing) return [...staged, updated];
    return staged.map((c) => (c === existing ? updated : c));
  }

  // delete
  let next = staged.filter((c) => !sameEntity(c));
  if (type === "deliverable") next = next.filter((c) => !referencesDeliverable(c, id));
  if (existing?.operation === "create") return next;
  return [...next, change];
}

/**
 * After Mark done lands, staged phase edits made earlier still hold the old finish dates.
 * Refresh them from the saved plan, as the server does when they are committed.
 */
export function rebaseProgress(staged: Change[], persisted: PlanState): Change[] {
  let changed = false;
  const next = staged.map((c) => {
    if (c.entity_type !== "deliverable" || c.operation !== "update" || !Array.isArray(c.fields.phases)) return c;
    const saved = persisted.deliverables.find((d) => d.id === c.entity_id);
    const phases = carryProgress(saved?.phases, c.fields.phases as Phase[]);
    if (sameValue(phases, c.fields.phases)) return c;
    changed = true;
    return { ...c, fields: { ...c.fields, phases } };
  });
  return changed ? next : staged;
}

/** Drop every staged change for one entity (Escape / revert). */
export function revertEntity(staged: Change[], type: EntityType, id: string): Change[] {
  return staged.filter((c) => {
    if (c.entity_type === type && c.entity_id === id) return false;
    if (type === "deliverable") {
      const createdHere = staged.some((s) => s.entity_type === "deliverable" && s.entity_id === id && s.operation === "create");
      if (createdHere && referencesDeliverable(c, id)) return false;
    }
    return true;
  });
}

/** Apply staged changes to the persisted state, mirroring the server's event rules. */
export function applyChanges(persisted: PlanState, staged: Change[]): PlanState {
  const state: PlanState = {
    workstreams: persisted.workstreams.map((w) => ({ ...w })),
    deliverables: persisted.deliverables.map((d) => ({ ...d })),
    dependencies: persisted.dependencies.map((d) => ({ ...d })),
  };
  for (const change of staged) {
    const key = COLLECTION[change.entity_type];
    const list = state[key] as Entity[];
    const index = list.findIndex((e) => e.id === change.entity_id);
    if (change.operation === "create") {
      if (index !== -1) continue;
      const fields = { ...change.fields };
      if (change.entity_type === "workstream" && fields.order_index === undefined) {
        fields.order_index = Math.max(-1, ...state.workstreams.map((w) => w.order_index)) + 1;
      }
      if (change.entity_type === "deliverable" && !fields.type) fields.type = "task";
      if (change.entity_type === "dependency" && !fields.type) fields.type = "FS";
      list.push({ id: change.entity_id, ...fields } as Entity);
    } else if (change.operation === "update") {
      if (index !== -1) list[index] = { ...list[index], ...change.fields } as Entity;
    } else if (index !== -1) {
      list.splice(index, 1);
      if (change.entity_type === "deliverable") {
        state.dependencies = state.dependencies.filter(
          (d) => d.predecessor_id !== change.entity_id && d.successor_id !== change.entity_id,
        );
      }
    }
  }
  state.workstreams.sort((a, b) => a.order_index - b.order_index);
  return state;
}

export function stagedEntityIds(staged: Change[]): Set<string> {
  return new Set(staged.map((c) => c.entity_id));
}

const FIELD_LABELS: Record<string, string> = {
  start_date: "start",
  end_date: "end",
  workstream_id: "lane",
  order_index: "order",
  predecessor_id: "predecessor",
  successor_id: "successor",
};

export interface ChangeDescription {
  title: string;
  kind: Change["operation"];
  lines: string[];
}

function entityName(state: PlanState, type: EntityType, id: string): string {
  const e = find(state, type, id) as { name?: string } | undefined;
  return e?.name ?? id;
}

function depLabel(state: PlanState, pred: unknown, succ: unknown): string {
  return `${entityName(state, "deliverable", String(pred))} → ${entityName(state, "deliverable", String(succ))}`;
}

function formatValue(state: PlanState, field: string, value: unknown): string {
  if (field.endsWith("_date") && typeof value === "string") return formatDate(value);
  if (field === "workstream_id") return entityName(state, "workstream", String(value));
  return String(value);
}

/** Human-readable before/after for one staged change. */
export function describeChange(change: Change, persisted: PlanState, proposed: PlanState): ChangeDescription {
  const { entity_type: type, entity_id: id, operation } = change;
  if (type === "dependency") {
    const dep = (find(proposed, type, id) ?? find(persisted, type, id)) as Dependency | undefined;
    const label = dep ? depLabel(proposed, dep.predecessor_id, dep.successor_id) : depLabel(proposed, change.fields.predecessor_id, change.fields.successor_id);
    return { title: `Dependency ${label}`, kind: operation, lines: [] };
  }
  const name = entityName(proposed, type, id) === id ? entityName(persisted, type, id) : entityName(proposed, type, id);
  const noun = type === "workstream" ? "Lane" : ((find(proposed, type, id) ?? find(persisted, type, id)) as Deliverable | undefined)?.type === "milestone" ? "Milestone" : "Deliverable";

  if (operation === "create") {
    const d = find(proposed, type, id) as Deliverable | undefined;
    const lines = type === "deliverable" && d ? [d.type === "milestone" ? formatDate(d.start_date) : `${formatDate(d.start_date)} – ${formatDate(d.end_date)}`] : [];
    return { title: `${noun} “${name}”`, kind: operation, lines };
  }
  if (operation === "delete") return { title: `${noun} “${name}”`, kind: operation, lines: [] };

  const before = find(persisted, type, id) as Record<string, unknown> | undefined;
  const lines: string[] = [];
  const fields = change.fields;
  const isMilestone = before?.type === "milestone";
  for (const [field, value] of Object.entries(fields)) {
    if (isMilestone && field === "end_date" && "start_date" in fields) continue;
    const old = before?.[field];
    if (field === "phases") {
      const oldD = before as unknown as Deliverable;
      const newD = (find(proposed, type, id) ?? before) as Deliverable;
      if (!hasPhases(oldD)) lines.push(`broken into ${describePhases(newD)}`);
      else if (!hasPhases(newD)) lines.push("phases removed");
      else lines.push(`phases: ${describePhases(oldD)} → ${describePhases(newD)}`);
      continue;
    }
    const label = isMilestone && field === "start_date" ? "date" : (FIELD_LABELS[field] ?? field);
    let line = `${label}: ${formatValue(persisted, field, old)} → ${formatValue(proposed, field, value)}`;
    if (field.endsWith("_date") && typeof old === "string" && typeof value === "string") {
      line += ` (${signedDays(daysBetween(old, value))})`;
    }
    lines.push(line);
  }
  return { title: `${noun} “${name}”`, kind: operation, lines };
}
