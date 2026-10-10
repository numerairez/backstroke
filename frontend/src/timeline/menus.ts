// Right-click menus for the timeline: a bar (and the phase under the cursor), a lane, empty space.
// Each builder returns plain entries; the caller supplies what the entries do.

import type { MenuEntry, PromptRequest } from "../components/ContextMenu";
import { addDays, formatDate } from "../state/dates";
import { DEFAULT_WORKFLOW, addPhase, hasPhases, phaseSpans, removePhase, renamePhase, splitIntoPhases } from "../state/phases";
import { newId } from "../state/staging";
import { deliverableStatus, phaseStatuses } from "../state/status";
import type { Change, Deliverable, PlanState } from "../types";

export type LinkRole = "predecessor" | "successor";

export interface MenuContext {
  state: PlanState;
  persisted: PlanState;
  editable: boolean;
  /** Status is judged as of this day. */
  asOf: string;
  stage: (change: Change) => void;
  progress: (id: string, phase: number | null, finishedOn: string | null) => void;
  prompt: (request: Omit<PromptRequest, "x" | "y">) => void;
  openDetails: (id: string, tab?: "details" | "history") => void;
  /** Pick another bar to link to this one. */
  startLink: (id: string, role: LinkRole) => void;
  select: (id: string | null) => void;
  addDeliverable: (workstreamId: string, date?: string, type?: "task" | "milestone") => void;
}

const updateOf = (ctx: MenuContext, d: Deliverable) => (fields: Record<string, unknown>) =>
  ctx.stage({ entity_type: "deliverable", entity_id: d.id, operation: "update", fields });

function doneEntries(ctx: MenuContext, label: string, onDone: (day: string) => void): MenuEntry {
  return {
    label,
    submenu: [
      { label: `Today, ${formatDate(ctx.asOf)}`, onSelect: () => onDone(ctx.asOf) },
      { label: `Yesterday, ${formatDate(addDays(ctx.asOf, -1))}`, onSelect: () => onDone(addDays(ctx.asOf, -1)) },
      {
        label: "Pick a date…",
        onSelect: () => ctx.prompt({ label: "Finished on", value: ctx.asOf, type: "date", max: ctx.asOf, submitLabel: "Mark done", onSubmit: onDone }),
      },
    ],
  };
}

/** Mark done or reopen: the bar itself, or its next phase and any finished ones. */
function progressEntries(ctx: MenuContext, d: Deliverable, phase: number | null): MenuEntry[] {
  if (d.type !== "task" || !ctx.persisted.deliverables.some((x) => x.id === d.id)) return [];
  if (!hasPhases(d)) {
    const status = deliverableStatus(d, ctx.asOf);
    return status?.kind === "done"
      ? [{ label: "Reopen", hint: `done ${formatDate(status.finishedOn!)}`, onSelect: () => ctx.progress(d.id, null, null) }]
      : [doneEntries(ctx, "Mark done", (day) => ctx.progress(d.id, null, day))];
  }
  const states = phaseStatuses(d, ctx.asOf);
  const next = states.findIndex((p) => p.status.kind !== "done");
  const out: MenuEntry[] = [];
  if (next >= 0) out.push(doneEntries(ctx, `Mark ${states[next].span.name} done`, (day) => ctx.progress(d.id, next, day)));
  if (phase !== null && phase > next && next >= 0) {
    out.push({ label: `Mark ${states[phase].span.name} done`, disabled: true, title: `After ${states[phase - 1].span.name}` });
  }
  // Reopen the finished phase under the cursor, or else the last finished one.
  const lastDone = next < 0 ? states.length - 1 : next - 1;
  const reopen = phase !== null && states[phase]?.status.kind === "done" ? phase : lastDone;
  if (reopen >= 0) {
    out.push({
      label: `Reopen ${states[reopen].span.name}`,
      title: reopen < states.length - 1 ? "Also reopens the phases after it" : undefined,
      onSelect: () => ctx.progress(d.id, reopen, null),
    });
  }
  return out;
}

function phaseMenu(ctx: MenuContext, d: Deliverable, phase: number | null): MenuEntry[] {
  const update = updateOf(ctx, d);
  const spans = phaseSpans(d);
  if (spans.length === 0) {
    const split = splitIntoPhases(d);
    return [
      {
        label: `Break into ${DEFAULT_WORKFLOW.join(", ")}`,
        disabled: !split,
        title: split ? undefined : `Needs at least ${DEFAULT_WORKFLOW.length} days`,
        onSelect: () => split && update({ phases: split }),
      },
    ];
  }
  const names = spans.map((s) => s.name);
  const last = spans[spans.length - 1];
  const out: MenuEntry[] = [];
  if (phase !== null && spans[phase]) {
    const sp = spans[phase];
    out.push(
      {
        label: `Rename ${sp.name}…`,
        onSelect: () => ctx.prompt({ label: "Phase name", value: sp.name, onSubmit: (name) => update({ phases: renamePhase(d, phase, name) }) }),
      },
      { label: `Remove ${sp.name}`, title: names.length <= 2 ? "Leaves one phase, so the bar becomes plain" : undefined, onSelect: () => update({ phases: removePhase(d, phase) }) },
      "separator",
    );
  }
  out.push(
    {
      label: "Add phase",
      disabled: last.days < 2,
      title: last.days < 2 ? "The last phase needs at least 2 days to split" : "Split the last phase in two",
      onSelect: () => {
        let n = names.length + 1;
        while (names.some((x) => x.toLowerCase() === `phase ${n}`)) n++;
        const phases = addPhase(d, `Phase ${n}`);
        if (phases) update({ phases });
      },
    },
    { label: "Edit phase dates…", onSelect: () => ctx.openDetails(d.id) },
    { label: "Remove all phases", onSelect: () => update({ phases: null }) },
  );
  return out;
}

export function deliverableMenu(ctx: MenuContext, id: string, phase: number | null): MenuEntry[] {
  const d = ctx.state.deliverables.find((x) => x.id === id);
  if (!d) return [];
  const details: MenuEntry[] = [
    { label: "Details…", hint: "Enter", onSelect: () => ctx.openDetails(d.id) },
    { label: "History", disabled: !ctx.persisted.deliverables.some((x) => x.id === d.id), title: "Not committed yet", onSelect: () => ctx.openDetails(d.id, "history") },
  ];
  if (!ctx.editable) return details;

  const update = updateOf(ctx, d);
  const linked = new Set([d.id]);
  for (const dep of ctx.state.dependencies) {
    if (dep.successor_id === d.id) linked.add(dep.predecessor_id);
    if (dep.predecessor_id === d.id) linked.add(dep.successor_id);
  }
  const byId = new Map(ctx.state.deliverables.map((x) => [x.id, x]));
  const deps = ctx.state.dependencies.filter((dep) => dep.successor_id === d.id || dep.predecessor_id === d.id);
  const canLink = ctx.state.deliverables.some((x) => !linked.has(x.id));
  const progress = progressEntries(ctx, d, phase);

  return [
    { label: "Rename…", hint: "F2", onSelect: () => ctx.prompt({ label: "Name", value: d.name, onSubmit: (name) => update({ name }) }) },
    ...progress,
    "separator",
    {
      label: "Type",
      submenu: [
        { label: "Task", checked: d.type === "task", onSelect: () => d.type !== "task" && update({ type: "task", end_date: addDays(d.start_date, 4) }) },
        {
          label: "Milestone",
          checked: d.type === "milestone",
          onSelect: () => d.type !== "milestone" && update({ type: "milestone", end_date: d.start_date, ...(hasPhases(d) ? { phases: null } : {}) }),
        },
      ],
    },
    {
      label: "Move to lane",
      submenu: ctx.state.workstreams.map((w) => ({ label: w.name, checked: w.id === d.workstream_id, onSelect: () => w.id !== d.workstream_id && update({ workstream_id: w.id }) })),
    },
    ...(d.type === "task" ? [{ label: "Phases", submenu: phaseMenu(ctx, d, phase) }] : []),
    {
      label: "Dependencies",
      submenu: [
        { label: "Depends on… (pick a bar)", disabled: !canLink, onSelect: () => ctx.startLink(d.id, "predecessor") },
        { label: "Blocks… (pick a bar)", disabled: !canLink, onSelect: () => ctx.startLink(d.id, "successor") },
        ...(deps.length ? (["separator"] as MenuEntry[]) : []),
        ...deps.map((dep): MenuEntry => {
          const other = dep.successor_id === d.id ? byId.get(dep.predecessor_id) : byId.get(dep.successor_id);
          return {
            label: `Remove: ${dep.successor_id === d.id ? "depends on" : "blocks"} ${other?.name ?? "?"}`,
            onSelect: () => ctx.stage({ entity_type: "dependency", entity_id: dep.id, operation: "delete", fields: {} }),
          };
        }),
      ],
    },
    "separator",
    ...details,
    "separator",
    {
      label: `Delete ${d.type === "milestone" ? "milestone" : "deliverable"}`,
      hint: "Del",
      danger: true,
      onSelect: () => {
        ctx.stage({ entity_type: "deliverable", entity_id: d.id, operation: "delete", fields: {} });
        ctx.select(null);
      },
    },
  ];
}

function addWorkstream(ctx: MenuContext): MenuEntry {
  return {
    label: "Add workstream…",
    onSelect: () =>
      ctx.prompt({
        label: "New workstream",
        value: "",
        submitLabel: "Add",
        onSubmit: (name) => ctx.stage({ entity_type: "workstream", entity_id: newId("workstream"), operation: "create", fields: { name } }),
      }),
  };
}

export function laneMenu(ctx: MenuContext, workstreamId: string, date?: string): MenuEntry[] {
  const lanes = ctx.state.workstreams;
  const i = lanes.findIndex((w) => w.id === workstreamId);
  const w = lanes[i];
  if (!w || !ctx.editable) return [];
  const count = ctx.state.deliverables.filter((d) => d.workstream_id === w.id).length;
  const swap = (j: number) => {
    const b = lanes[j];
    ctx.stage({ entity_type: "workstream", entity_id: w.id, operation: "update", fields: { order_index: b.order_index } });
    ctx.stage({ entity_type: "workstream", entity_id: b.id, operation: "update", fields: { order_index: w.order_index } });
  };
  const here = date ? ` on ${formatDate(date)}` : "";
  return [
    { label: `Add deliverable${here}`, onSelect: () => ctx.addDeliverable(w.id, date) },
    { label: `Add milestone${here}`, onSelect: () => ctx.addDeliverable(w.id, date, "milestone") },
    "separator",
    {
      label: "Rename workstream…",
      onSelect: () => ctx.prompt({ label: "Workstream name", value: w.name, onSubmit: (name) => ctx.stage({ entity_type: "workstream", entity_id: w.id, operation: "update", fields: { name } }) }),
    },
    { label: "Move up", disabled: i === 0, onSelect: () => swap(i - 1) },
    { label: "Move down", disabled: i === lanes.length - 1, onSelect: () => swap(i + 1) },
    addWorkstream(ctx),
    "separator",
    {
      label: "Delete workstream",
      danger: true,
      disabled: count > 0,
      title: count ? "Move or delete its deliverables first" : undefined,
      onSelect: () => ctx.stage({ entity_type: "workstream", entity_id: w.id, operation: "delete", fields: {} }),
    },
  ];
}

/** Below the last lane, or a plan with no lanes. */
export function emptyMenu(ctx: MenuContext): MenuEntry[] {
  return ctx.editable ? [addWorkstream(ctx)] : [];
}
