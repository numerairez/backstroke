import type { Baseline, Category, Change, CommitSummary, Diff, Metrics, PlanState, Preview, Project, ValidationError } from "../types";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

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

export const api = {
  categories: () => request<Category[]>("/categories"),
  projects: () => request<Project[]>("/projects"),
  createProject: (name: string, description = "") => post<Project>("/projects", { name, description }),
  project: (id: string) => request<Project>(`/projects/${id}`),
  state: (id: string) => request<VersionedState>(`/projects/${id}/state`),
  version: (id: string, version: number) => request<VersionedState>(`/projects/${id}/versions/${version}`),
  commits: (id: string) => request<CommitSummary[]>(`/projects/${id}/commits?include_events=true`),
  preview: (id: string, changes: Change[]) => post<Preview>(`/projects/${id}/preview`, { changes }),
  commit: (id: string, input: CommitInput) => post<CommitResult>(`/projects/${id}/commits`, input),
  revert: (id: string, seq: number, input: { author: string; base_version: number; reason?: string }) =>
    post<CommitResult>(`/projects/${id}/commits/${seq}/revert`, input),
  diff: (id: string, from: number, to: number) => request<Diff>(`/projects/${id}/diff?from=${from}&to=${to}`),
  createBaseline: (id: string, name: string, version: number) => post<Baseline>(`/projects/${id}/baselines`, { name, version }),
  metrics: (id: string, baseline?: number) =>
    request<Metrics>(`/projects/${id}/metrics${baseline !== undefined ? `?baseline=${baseline}` : ""}`),
  exportUrl: (id: string) => `/api/projects/${id}/export`,
};
