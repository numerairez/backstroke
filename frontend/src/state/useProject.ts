import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type CommitInput, type FinishMeetingInput } from "../api/client";
import type { Change, CommitSummary, EntityType, Meeting, PlanState, Preview, Project } from "../types";
import { applyChanges, changeKey, rebaseProgress, revertEntity, selectChanges, stageChange, type Selection } from "./staging";

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
  /** What the next commit will contain: checked changes plus the staged creates they need. */
  selection: Selection;
  /** Dry run of just the selection (the same as `preview` when everything is selected). */
  selectionPreview: Preview | null;
  excluded: Set<string>;
  toggleSelected: (key: string) => void;
  selectAll: (selected: boolean) => void;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  stage: (change: Change) => void;
  stageMany: (changes: Change[]) => void;
  unstage: (index: number) => void;
  revert: (type: EntityType, id: string) => void;
  discard: () => void;
  /** Commit the selection; unselected changes stay staged for a later commit. */
  commit: (input: Omit<CommitInput, "changes" | "base_version">) => Promise<CommitSummary>;
  revertCommit: (seq: number, author: string, reason?: string) => Promise<CommitSummary>;
  /** Finish a meeting: record its items and, when `commit` is given, commit the selection with it. */
  finishMeeting: (
    meetingId: number,
    input: Omit<FinishMeetingInput, "commit"> & { commit: { reason: string; category: string | null } | null },
  ) => Promise<{ meeting: Meeting; commit: CommitSummary | null }>;
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
  const [subsetPreview, setSubsetPreview] = useState<Preview | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
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
    setExcluded(new Set());
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

  // Forget unchecked marks for changes that are no longer staged, so re-staging them starts checked.
  useEffect(() => {
    setExcluded((prev) => {
      const keys = new Set(staged.map(changeKey));
      const next = new Set([...prev].filter((k) => keys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [staged]);

  const selection = useMemo(() => selectChanges(staged, excluded), [staged, excluded]);
  const partial = selection.changes.length !== staged.length;

  // A partial commit is validated on its own: it may lack a change the full set relies on.
  useEffect(() => {
    if (!projectId || !project || !partial || selection.changes.length === 0) {
      setSubsetPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .preview(projectId, selection.changes)
        .then((p) => !cancelled && setSubsetPreview(p))
        .catch(() => !cancelled && setSubsetPreview(null));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, project, partial, selection, version]);

  const selectionPreview = partial ? subsetPreview : preview;

  const toggleSelected = useCallback(
    (key: string) =>
      setExcluded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  const selectAll = useCallback(
    (selected: boolean) => setExcluded(selected ? new Set() : new Set(staged.map(changeKey))),
    [staged],
  );

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
      const changes = selection.changes;
      const result = await api.commit(projectId, { ...input, base_version: version, changes });
      const committed = new Set(changes.map(changeKey));
      setStaged((s) => s.filter((c) => !committed.has(changeKey(c))));
      await refresh();
      return result.commit;
    },
    [projectId, version, selection, refresh],
  );

  const finishMeeting = useCallback(
    async (meetingId: number, input: Omit<FinishMeetingInput, "commit"> & { commit: { reason: string; category: string | null } | null }) => {
      if (!projectId) throw new Error("no project");
      const changes = selection.changes;
      const result = await api.finishMeeting(projectId, meetingId, {
        ...input,
        commit: input.commit ? { ...input.commit, base_version: version, changes } : null,
      });
      if (result.commit) {
        const committed = new Set(changes.map(changeKey));
        setStaged((s) => s.filter((c) => !committed.has(changeKey(c))));
        await refresh();
      }
      return { meeting: result.meeting, commit: result.commit?.commit ?? null };
    },
    [projectId, version, selection, refresh],
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
    selection,
    selectionPreview,
    excluded,
    toggleSelected,
    selectAll,
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
    finishMeeting,
    recordProgress,
    createBaseline,
    stateAt,
    cachedStateAt,
  };
}

export function isVersionConflict(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === "VERSION_CONFLICT";
}
