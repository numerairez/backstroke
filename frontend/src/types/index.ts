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
}

export interface Deliverable {
  id: string;
  workstream_id: string;
  type: DeliverableType;
  name: string;
  start_date: string;
  end_date: string;
  phases?: Phase[] | null;
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
}
