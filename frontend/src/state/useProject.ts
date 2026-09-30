import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type CommitInput } from "../api/client";
import type { Change, CommitSummary, EntityType, PlanState, Preview, Project } from "../types";
import { applyChanges, rebaseProgress, revertEntity, stageChange } from "./staging";

const EMPTY: PlanState = { workstreams: [], deliverables: [], dependencies: [] };

function draftKey(projectId: string) {
  return `backstroke:draft:${projectId}`;
}

function loadDraft(projectId: string): Change[] {
  try {
    const raw = localStorage.getItem(draftKey(projectId));
    return raw ? (JSON.parse(raw) as Change[]) : [];
  } catch {
    return [];
  }
}

function saveDraft(projectId: string, staged: Change[]) {
  try {
    if (staged.length) localStorage.setItem(draftKey(projectId), JSON.stringify(staged));
    else localStorage.removeItem(draftKey(projectId));
  } catch {
    /* storage unavailable: staging still works for this session */
  }
}

export interface ProjectStore {
  project: Project | null;
  version: number;
  persisted: PlanState;
  proposed: PlanState;
  commits: CommitSummary[];
  staged: Change[];
  preview: Preview | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  stage: (change: Change) => void;
  stageMany: (changes: Change[]) => void;
  unstage: (index: number) => void;
  revert: (type: EntityType, id: string) => void;
  discard: () => void;
  commit: (input: Omit<CommitInput, "changes" | "base_version">) => Promise<CommitSummary>;
  revertCommit: (seq: number, author: string, reason?: string) => Promise<CommitSummary>;
  /** Mark a deliverable (phase null) or one of its phases done on a date, or reopen it (null). */
  recordProgress: (author: string, deliverableId: string, phase: number | null, finishedOn: string | null) => Promise<CommitSummary>;
  createBaseline: (name: string, version: number) => Promise<void>;
  stateAt: (version: number) => Promise<PlanState>;
  cachedStateAt: (version: number) => PlanState | undefined;
}

export function useProject(projectId: string | null): ProjectStore {
  const [project, setProject] = useState<Project | null>(null);
  const [version, setVersion] = useState(0);
  const [persisted, setPersisted] = useState<PlanState>(EMPTY);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [staged, setStaged] = useState<Change[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cacheTick, setCacheTick] = useState(0);
  const cache = useRef(new Map<number, PlanState>());

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const [p, s, c] = await Promise.all([api.project(projectId), api.state(projectId), api.commits(projectId)]);
    setProject(p);
    setVersion(s.version);
    setPersisted(s.state);
    setCommits(c);
    cache.current.set(s.version, s.state);
  }, [projectId]);

  useEffect(() => {
    cache.current = new Map();
    setProject(null);
    setPersisted(EMPTY);
    setCommits([]);
    setPreview(null);
    if (!projectId) return;
    setStaged(loadDraft(projectId));
    setLoading(true);
    setError(null);
    refresh()
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId, refresh]);

  useEffect(() => {
    if (projectId) saveDraft(projectId, staged);
  }, [projectId, staged]);

  // Server-side dry run of the staged set: validation, dependency conflicts, suggestions.
  useEffect(() => {
    if (!projectId || !project) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .preview(projectId, staged)
        .then((p) => !cancelled && setPreview(p))
        .catch(() => !cancelled && setPreview(null));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, project, staged, version]);

  useEffect(() => setStaged((s) => rebaseProgress(s, persisted)), [persisted]);

  const proposed = useMemo(() => applyChanges(persisted, staged), [persisted, staged]);

  const stage = useCallback((change: Change) => setStaged((s) => stageChange(s, change, persisted)), [persisted]);
  const stageMany = useCallback(
    (changes: Change[]) => setStaged((s) => changes.reduce((acc, c) => stageChange(acc, c, persisted), s)),
    [persisted],
  );
  const unstage = useCallback((index: number) => setStaged((s) => s.filter((_, i) => i !== index)), []);
  const revert = useCallback((type: EntityType, id: string) => setStaged((s) => revertEntity(s, type, id)), []);
  const discard = useCallback(() => setStaged([]), []);

  const commit = useCallback(
    async (input: Omit<CommitInput, "changes" | "base_version">) => {
      if (!projectId) throw new Error("no project");
      const result = await api.commit(projectId, { ...input, base_version: version, changes: staged });
      setStaged([]);
      await refresh();
      return result.commit;
    },
    [projectId, version, staged, refresh],
  );

  const revertCommit = useCallback(
    async (seq: number, author: string, reason?: string) => {
      if (!projectId) throw new Error("no project");
      const result = await api.revert(projectId, seq, { author, base_version: version, reason });
      await refresh();
      return result.commit;
    },
    [projectId, version, refresh],
  );

  const recordProgress = useCallback(
    async (author: string, deliverableId: string, phase: number | null, finishedOn: string | null) => {
      if (!projectId) throw new Error("no project");
      const input = { author, deliverable_id: deliverableId, phase, finished_on: finishedOn };
      let result;
      try {
        result = await api.progress(projectId, { ...input, base_version: version });
      } catch (e) {
        // Someone else committed meanwhile. Progress doesn't depend on the plan version, so retry once on the latest.
        if (!isVersionConflict(e)) throw e;
        result = await api.progress(projectId, { ...input, base_version: (e.body.current_version as number) ?? version });
      }
      await refresh();
      return result.commit;
    },
    [projectId, version, refresh],
  );

  const createBaseline = useCallback(
    async (name: string, v: number) => {
      if (!projectId) return;
      await api.createBaseline(projectId, name, v);
      await refresh();
    },
    [projectId, refresh],
  );

  const stateAt = useCallback(
    async (v: number) => {
      const hit = cache.current.get(v);
      if (hit) return hit;
      if (!projectId) return EMPTY;
      const res = await api.version(projectId, v);
      cache.current.set(v, res.state);
      setCacheTick((t) => t + 1);
      return res.state;
    },
    [projectId],
  );

  // cacheTick makes consumers re-read the cache after a background fetch lands.
  const cachedStateAt = useCallback((v: number) => cache.current.get(v), [cacheTick]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    project,
    version,
    persisted,
    proposed,
    commits,
    staged,
    preview,
    loading,
    error,
    refresh,
    stage,
    stageMany,
    unstage,
    revert,
    discard,
    commit,
    revertCommit,
    recordProgress,
    createBaseline,
    stateAt,
    cachedStateAt,
  };
}

export function isVersionConflict(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === "VERSION_CONFLICT";
}
