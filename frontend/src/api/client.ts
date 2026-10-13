import type { Account, Attendee, Baseline, Category, Change, CommitSummary, DeliverableTrail, Diff, ItemEvent, ItemInput, Me, Meeting, Metrics, OrgRoster, PlanState, PreRead, Preview, Project, RegisterItem, Roster, Surprises, ValidationError } from "../types";

export class ApiError extends Error {
  status: number;
  code: string;
  errors: ValidationError[];
  body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    const errors = (body.errors as ValidationError[] | undefined) ?? [];
    super((body.message as string) ?? (errors.length ? errors.map((e) => e.message).join("; ") : `HTTP ${status}`));
    this.status = status;
    this.code = (body.code as string) ?? "HTTP_ERROR";
    this.errors = errors;
    this.body = body;
  }
}

/** Fired on window when a request comes back 401. */
export const SIGNED_OUT = "backstroke:signed-out";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  // Signed out (or the session expired): the app goes back to the sign-in page.
  if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event(SIGNED_OUT));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });

export interface VersionedState {
  version: number;
  state: PlanState;
}

export interface CommitResult {
  version: number;
  commit: CommitSummary;
  state: PlanState;
}

export interface CommitInput {
  reason: string;
  category: string | null;
  reference: string | null;
  author: string;
  base_version: number;
  changes: Change[];
}

export interface FinishMeetingInput {
  author: string;
  items: ItemInput[];
  commit: { reason: string; category: string | null; base_version: number; changes: Change[] } | null;
}

export interface ItemUpdate {
  text?: string;
  owner?: string | null;
  due_on?: string | null;
  deliverable_ids?: string[];
  status?: string;
  outcome?: string;
  closed_on?: string | null;
  superseded_by?: string;
  /** The issue a risk that happened became; left out, a new issue is raised from the risk. */
  became?: string;
  /** Kept in the item's history. */
  note?: string;
  author?: string;
  meeting_id?: number;
}

export interface KnowledgeOptions {
  history: boolean;
  notes: boolean;
  closed: boolean;
}

const knowledgePath = (id: string, o: KnowledgeOptions) => `/api/projects/${id}/export/knowledge?history=${o.history}&notes=${o.notes}&closed=${o.closed}`;

export const api = {
  me: () => request<Me>("/auth/me"),
  signUp: (name: string, email: string, password: string) => post<Me>("/auth/register", { name, email, password }),
  signIn: (email: string, password: string) => post<Me>("/auth/login", { email, password }),
  signOut: () => post<void>("/auth/logout", {}),
  accounts: () => request<Account[]>("/auth/accounts"),
  setAdmin: (accountId: number, isAdmin: boolean) => patch<Account>(`/auth/accounts/${accountId}`, { is_admin: isAdmin }),
  removeAccount: (accountId: number) => request<void>(`/auth/accounts/${accountId}`, { method: "DELETE" }),
  categories: () => request<Category[]>("/categories"),
  projects: () => request<Project[]>("/projects"),
  createProject: (name: string, description = "", groups: string[] = []) => post<Project>("/projects", { name, description, groups }),
  project: (id: string) => request<Project>(`/projects/${id}`),
  updateProject: (id: string, fields: { name?: string; description?: string }) => patch<Project>(`/projects/${id}`, fields),
  setProjectGroups: (id: string, groups: string[]) => put<Roster>(`/projects/${id}/groups`, { groups }),
  orgPeople: () => request<OrgRoster>("/people"),
  saveOrgPeople: (roster: OrgRoster) => put<OrgRoster>("/people", roster),
  state: (id: string) => request<VersionedState>(`/projects/${id}/state`),
  version: (id: string, version: number) => request<VersionedState>(`/projects/${id}/versions/${version}`),
  commits: (id: string) => request<CommitSummary[]>(`/projects/${id}/commits?include_events=true`),
  preview: (id: string, changes: Change[]) => post<Preview>(`/projects/${id}/preview`, { changes }),
  commit: (id: string, input: CommitInput) => post<CommitResult>(`/projects/${id}/commits`, input),
  progress: (id: string, input: { author: string; base_version: number; deliverable_id: string; phase: number | null; finished_on: string | null }) =>
    post<CommitResult>(`/projects/${id}/progress`, input),
  revert: (id: string, seq: number, input: { author: string; base_version: number; reason?: string }) =>
    post<CommitResult>(`/projects/${id}/commits/${seq}/revert`, input),
  diff: (id: string, from: number, to: number) => request<Diff>(`/projects/${id}/diff?from=${from}&to=${to}`),
  createBaseline: (id: string, name: string, version: number) => post<Baseline>(`/projects/${id}/baselines`, { name, version }),
  metrics: (id: string, baseline?: number) =>
    request<Metrics>(`/projects/${id}/metrics${baseline !== undefined ? `?baseline=${baseline}` : ""}`),
  exportUrl: (id: string) => `/api/projects/${id}/export`,
  knowledgeUrl: knowledgePath,
  knowledge: async (id: string, o: KnowledgeOptions) => {
    const res = await fetch(knowledgePath(id, o));
    if (!res.ok) throw new ApiError(res.status, { message: `Couldn't build the knowledge base (HTTP ${res.status})` });
    return res.text();
  },
  people: (id: string) => request<Roster>(`/projects/${id}/people`),
  meetings: (id: string) => request<Meeting[]>(`/projects/${id}/meetings`),
  createMeeting: (id: string, input: { title: string; held_on: string; attendees?: Attendee[] }) => post<Meeting>(`/projects/${id}/meetings`, input),
  updateMeeting: (id: string, meetingId: number, input: { title?: string; held_on?: string; attendees?: Attendee[]; notes?: string }) =>
    patch<Meeting>(`/projects/${id}/meetings/${meetingId}`, input),
  deleteMeeting: (id: string, meetingId: number) => request<void>(`/projects/${id}/meetings/${meetingId}`, { method: "DELETE" }),
  finishMeeting: (id: string, meetingId: number, input: FinishMeetingInput) =>
    post<{ meeting: Meeting; commit: CommitResult | null }>(`/projects/${id}/meetings/${meetingId}/finish`, input),
  register: (id: string) => request<RegisterItem[]>(`/projects/${id}/register`),
  preread: (id: string, meetingId: number) => request<PreRead>(`/projects/${id}/meetings/${meetingId}/preread`),
  trail: (id: string, deliverableId: string) => request<DeliverableTrail>(`/projects/${id}/deliverables/${encodeURIComponent(deliverableId)}/trail`),
  surprises: (id: string) => request<Surprises>(`/projects/${id}/surprises`),
  createItem: (id: string, input: ItemInput & { author?: string }) => post<RegisterItem>(`/projects/${id}/register`, input),
  itemHistory: (id: string, itemId: number) => request<ItemEvent[]>(`/projects/${id}/register/${itemId}/history`),
  updateItem: (id: string, itemId: number, input: ItemUpdate) => patch<RegisterItem>(`/projects/${id}/register/${itemId}`, input),
};
