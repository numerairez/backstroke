export type EntityType = "workstream" | "deliverable" | "dependency";
export type Operation = "create" | "update" | "delete";
export type DeliverableType = "task" | "milestone";

export interface Workstream {
  id: string;
  name: string;
  order_index: number;
}

/**
 * A step inside a deliverable. Every phase but the last has `days`; the last runs to the end date.
 * A phase starts the day after the previous one ends, unless `gap` leaves days free before it.
 */
export interface Phase {
  name: string;
  days?: number;
  gap?: number;
  finished_on?: string; // set by Mark done; phases finish in order
}

export interface Deliverable {
  id: string;
  workstream_id: string;
  type: DeliverableType;
  name: string;
  start_date: string;
  end_date: string;
  phases?: Phase[] | null;
  /** When a deliverable without phases was marked done (phased ones use their phases). */
  finished_on?: string | null;
}

export interface Dependency {
  id: string;
  predecessor_id: string;
  successor_id: string;
  type: "FS";
}

export interface PlanState {
  workstreams: Workstream[];
  deliverables: Deliverable[];
  dependencies: Dependency[];
}

export interface Change {
  entity_type: EntityType;
  entity_id: string;
  operation: Operation;
  fields: Record<string, unknown>;
}

export interface PlanEvent {
  entity_type: EntityType;
  entity_id: string;
  operation: Operation;
  field_name: string | null;
  old_value: unknown;
  new_value: unknown;
}

export interface Baseline {
  id: number;
  name: string;
  version: number;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  version: number;
  baselines: Baseline[];
}

export interface CommitSummary {
  seq: number;
  author: string;
  reason: string;
  category: string | null;
  reference: string | null;
  created_at: string;
  change_count: number;
  deliverables_affected: number;
  affected: Partial<Record<EntityType, string[]>>;
  baselines: string[];
  events?: PlanEvent[];
}

export interface Category {
  code: string;
  label: string;
  description: string;
  /** false for categories the app records itself (Progress). */
  selectable?: boolean;
}

export interface ValidationError {
  change_index: number | null;
  code: string;
  message: string;
}

export interface Conflict {
  dependency_id: string;
  predecessor_id: string;
  successor_id: string;
  overlap_days: number;
  message: string;
}

export interface Suggestion {
  deliverable_id: string;
  shift_days: number;
  start_date: string;
  end_date: string;
  because_of: string[];
}

export interface Preview {
  base_version: number;
  valid: boolean;
  errors: ValidationError[];
  events: PlanEvent[];
  conflicts: Conflict[];
  suggestions: Suggestion[];
}

export interface EntityDiff<T> {
  id: string;
  status: "added" | "removed" | "changed";
  before: T | null;
  after: T | null;
  changes?: { field: string; old: unknown; new: unknown }[];
}

export interface DeliverableDiff extends EntityDiff<Deliverable> {
  start_delta_days?: number;
  end_delta_days?: number;
  duration_delta_days?: number;
  lane_change?: { from: string; to: string };
  phase_deltas?: {
    name: string;
    before_days: number;
    after_days: number;
    delta_days: number;
    before_gap_days: number;
    after_gap_days: number;
    start_delta_days: number;
    end_delta_days: number;
  }[];
  progress?: { phase: string | null; before: string | null; after: string | null }[];
}

export interface Diff {
  from: number;
  to: number;
  workstreams: EntityDiff<Workstream>[];
  deliverables: DeliverableDiff[];
  dependencies: EntityDiff<Dependency>[];
  summary: {
    moved: number;
    added: number;
    removed: number;
    changed: number;
    later: number;
    earlier: number;
    dependencies_added: number;
    dependencies_removed: number;
  };
}

export interface Metrics {
  version: number;
  baseline_version: number;
  late_stage_window_days: number;
  summary: {
    commits: number;
    events: number;
    gross_churn_days: number;
    recovery_days: number;
    late_stage_churn_days: number;
    slip_days: number;
    net_movement_days: number;
    max_net_movement_days: number;
    propagated_movements: number;
  };
  milestones: { id: string; name: string; baseline_date: string | null; current_date: string; net_movement_days: number | null }[];
  deliverables: {
    id: string;
    name: string;
    type: DeliverableType;
    workstream_id: string;
    commit_count: number;
    gross_churn_days: number;
    slip_days: number;
    recovery_days: number;
    baseline_end_date: string | null;
    current_end_date: string;
    net_movement_days: number | null;
    unchanged_for_days: number | null;
  }[];
  by_category: { category: string; commit_count: number; later_days: number; earlier_days: number; movements: number }[];
  by_workstream: { id: string; name: string; commit_count: number; gross_churn_days: number }[];
  propagation: { seq: number; predecessor_id: string; successor_id: string; predecessor_delta_days: number; successor_delta_days: number }[];
  by_phase: {
    compared: number;
    not_compared: number;
    phases: { name: string; net_days: number; longer_days: number; shorter_days: number; deliverables: number }[];
    gaps: { net_days: number; longer_days: number; shorter_days: number };
  };
  finishes: {
    on_time: number;
    total: number;
    rows: {
      deliverable_id: string;
      name: string;
      phase: string | null;
      finished_on: string;
      planned_end: string;
      delta_days: number;
      baseline_end: string | null;
      baseline_delta_days: number | null;
    }[];
  };
}

export type ItemKind = "action" | "risk" | "decision";

export interface Attendee {
  name: string;
  present: boolean;
}

/** An action, risk or decision. `ref` is its register number, e.g. "A-7". */
export interface RegisterItem {
  id: number;
  ref: string;
  kind: ItemKind;
  text: string;
  owner: string | null;
  due_on: string | null;
  /** Empty for a programme-level item. */
  deliverable_ids: string[];
  meeting: { id: number; title: string; held_on: string } | null;
  status: string;
  open: boolean;
  closed_on: string | null;
  superseded_by: string | null;
  created_at: string;
}

export interface Meeting {
  id: number;
  title: string;
  held_on: string;
  attendees: Attendee[];
  notes: string;
  finished_at: string | null;
  /** The plan commit made when the meeting finished, if it changed the plan. */
  commit_seq: number | null;
  plan_version: number | null;
  /** What its commit's reference says, e.g. "Steering committee 2026-10-08". */
  reference: string;
  items: RegisterItem[];
  created_at: string;
  updated_at: string;
}

export interface ItemInput {
  kind: ItemKind;
  text: string;
  owner: string | null;
  due_on: string | null;
  deliverable_ids: string[];
}

/** How a date move came about: agreed at a meeting, raised beforehand, or a surprise. */
export interface MoveSignal {
  kind: "agreed" | "foreseen" | "surprise";
  /** The meeting or register item (e.g. "R-3") that raised it. */
  by: string | null;
  moved: string[];
}

export interface TrailCommit {
  seq: number;
  date: string;
  author: string;
  reason: string;
  category: string | null;
  reference: string | null;
  meeting: string | null;
  lines: string[];
  signal: MoveSignal | null;
}

export interface TrailItem {
  ref: string;
  kind: ItemKind;
  text: string;
}

export type TrailEntry =
  | ({ type: "commit" } & TrailCommit)
  | { type: "meeting"; date: string; meeting: string; meeting_id: number; items: TrailItem[]; notes: string[] }
  | { type: "item"; date: string; items: TrailItem[] };

export interface DeliverableTrail {
  deliverable_id: string;
  name: string;
  recent_days: number;
  entries: TrailEntry[];
}

export interface Surprises {
  recent_days: number;
  total: number;
  agreed: number;
  foreseen: number;
  surprise: number;
  commits: (MoveSignal & { seq: number; date: string; reason: string; deliverables: string[] })[];
}

export interface PreReadItem {
  ref: string;
  kind: ItemKind;
  text: string;
  owner: string | null;
  due_on: string | null;
  overdue: boolean;
  deliverables: string[];
}

export interface PreRead {
  as_of: string;
  since: { meeting: string | null; date: string; version: number | null };
  version: number;
  commits: TrailCommit[];
  finished: string[];
  attention: { id: string; name: string; kind: "behind" | "overdue"; status: string; risks: string[] }[];
  coming_up: { date: string; id: string; text: string }[];
  lookahead_days: number;
  actions: PreReadItem[];
  risks: PreReadItem[];
  decisions: PreReadItem[];
  agenda: string[];
}
