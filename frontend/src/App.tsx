import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api/client";
import { CommitDialog } from "./components/CommitDialog";
import { FinishMeetingDialog } from "./components/FinishMeetingDialog";
import { ContextMenu, QuickPrompt, type MenuEntry, type MenuRequest, type PromptRequest } from "./components/ContextMenu";
import { DetailsCard, type DetailsTab } from "./components/DetailsCard";
import { KnowledgeDialog } from "./components/KnowledgeDialog";
import { MeetingsView } from "./components/MeetingsView";
import { PeopleView } from "./components/PeopleView";
import { ProjectNav, initials } from "./components/ProjectNav";
import { ProjectSettings } from "./components/ProjectSettings";
import { RegisterView } from "./components/RegisterView";
import { TabIcon } from "./components/TabIcon";
import { SurpriseIndex } from "./components/Trail";
import { StagedChangesDrawer } from "./components/StagedChangesDrawer";
import { ComparePanel, type CompareRange } from "./history/ComparePanel";
import { describeEvents } from "./history/describe";
import { HistoryPanel, categoryLabel } from "./history/HistoryPanel";
import { MetricsPanel } from "./history/MetricsPanel";
import { PlaybackControls } from "./history/PlaybackControls";
import { addDays, formatTimestamp, todayIso } from "./state/dates";
import { itemsFromNotes, parseNotes } from "./state/notes";
import { moveLane, moveRow, orderLanes, orderRows } from "./state/lanes";
import { newId, stagedEntityIds } from "./state/staging";
import { useMeetings } from "./state/useMeetings";
import { useProject } from "./state/useProject";
import { PHASE_COLORS, phaseNameOrder } from "./state/phases";
import { deliverableStatus, type StatusKind } from "./state/status";
import { deliverableMenu, emptyMenu, laneMenu, promptNewWorkstream, type LinkRole, type MenuContext } from "./timeline/menus";
import { TimelineCanvas, type ColorBy } from "./timeline/TimelineCanvas";
import type { Account, Category, Meeting, OrgRoster, PlanState, Project } from "./types";

/** The plan (swimlanes above, register below) belongs to the open project; Settings to the organisation and the open project. */
type View = "plan" | "settings";
type SettingsTab = "people" | "projects" | "project";
type Tab = "changes" | "meetings" | "history" | "insights";
const VIEWS: View[] = ["plan", "settings"];
const SETTINGS_TABS: SettingsTab[] = ["people", "projects", "project"];
/** Opening a meeting widens the panel to at least this, so the notes have room. */
const MEETING_PANEL_MIN = 640;
const ZOOMS = [6, 10, 16, 26, 40];
const SIDEBAR_DEFAULT = 380;
const SIDEBAR_MIN = 300;
const REGISTER_MIN = 120;
const TIMELINE_MIN_HEIGHT = 160;
/** The timeline keeps at least this much room when the sidebar is widened. */
const TIMELINE_MIN = 360;

const navWidth = () => document.querySelector(".project-nav")?.getBoundingClientRect().width ?? 0;
const clampSidebar = (w: number) => Math.round(Math.max(SIDEBAR_MIN, Math.min(w, window.innerWidth - navWidth() - TIMELINE_MIN)));
const PLAY_INTERVAL_MS = 1800;

function stored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}

interface AppProps {
  account: Account;
  /** Re-read who is signed in, e.g. after Settings renames them or changes their admin rights. */
  onAccountChanged: () => void;
  onSignOut: () => void;
}

export default function App({ account, onAccountChanged, onSignOut }: AppProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(() => stored("backstroke:project", "") || null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [org, setOrg] = useState<OrgRoster | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => {
    const t = stored("backstroke:settingsTab", "people") as SettingsTab;
    return SETTINGS_TABS.includes(t) ? t : "people";
  });
  const [navCollapsed, setNavCollapsed] = useState(() => stored("backstroke:navCollapsed", "0") === "1");
  const [focusNewProject, setFocusNewProject] = useState(0);
  /** Everyone's sign-ins, for admins managing People. */
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [othersOpen, setOthersOpen] = useState(() => stored("backstroke:othersOpen", "0") === "1");
  // Everything is recorded under the signed-in person; the server ignores any other name.
  const author = account.name;
  const [zoom, setZoom] = useState(() => Number(stored("backstroke:zoom", "2")));
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebar(Number(stored("backstroke:sidebar", String(SIDEBAR_DEFAULT))) || SIDEBAR_DEFAULT));
  const [colorBy, setColorBy] = useState<ColorBy>(() => (stored("backstroke:colorBy", "lane") === "phase" ? "phase" : "lane"));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<View>(() => {
    const v = stored("backstroke:view", "plan") as View;
    return VIEWS.includes(v) ? v : "plan";
  });
  const [tab, setTab] = useState<Tab>("changes");
  const [historyMode, setHistoryMode] = useState<"commits" | "compare">("commits");
  const [sidebarOpen, setSidebarOpen] = useState(() => stored("backstroke:sidebarOpen", "1") === "1");
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [details, setDetails] = useState<{ id: string; tab: DetailsTab; focusName: boolean } | null>(null);
  const [linking, setLinking] = useState<{ id: string; role: LinkRole } | null>(null);
  const [tipSeen, setTipSeen] = useState(() => stored("backstroke:tipSeen", "") === "1");
  const menuAt = useRef({ x: 200, y: 200 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [compare, setCompare] = useState<CompareRange | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [openMeetingId, setOpenMeetingId] = useState<number | null>(null);
  const [mentionRequest, setMentionRequest] = useState<{ name: string; nonce: number } | null>(null);
  const [finishing, setFinishing] = useState<Meeting | null>(null);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const p = useProject(projectId);
  const meetings = useMeetings(projectId);
  const today = todayIso();
  const live = viewVersion === null;

  useEffect(() => {
    Promise.all([api.projects(), api.categories(), api.orgPeople()])
      .then(([ps, cs, people]) => {
        setProjects(ps);
        setCategories(cs);
        setOrg(people);
        // Otherwise open the first project you're on, or the first there is.
        const mine = ps.find((x) => x.members.includes(account.name));
        setProjectId((cur) => (cur && ps.some((x) => x.id === cur) ? cur : ((mine ?? ps[0])?.id ?? null)));
      })
      .catch(() => setBootError("Can't reach the backend. Start it with `uvicorn app.main:app --reload` in backend/."));
  }, []);

  useEffect(() => {
    if (projectId) store("backstroke:project", projectId);
    setViewVersion(null);
    setCompare(null);
    setSelectedId(null);
    setPlaying(false);
    setExpanded(new Set());
    setOpenMeetingId(null);
    setDetails(null);
    setLinking(null);
  }, [projectId]);
  useEffect(() => store("backstroke:view", view), [view]);
  useEffect(() => store("backstroke:settingsTab", settingsTab), [settingsTab]);
  useEffect(() => {
    if (view === "settings" && account.is_admin) api.accounts().then(setAccounts, () => setAccounts(null));
  }, [view, account.is_admin]);
  useEffect(() => store("backstroke:othersOpen", othersOpen ? "1" : "0"), [othersOpen]);
  useEffect(() => {
    store("backstroke:navCollapsed", navCollapsed ? "1" : "0");
    setSidebarWidth((w) => clampSidebar(w));
  }, [navCollapsed]);
  // Floating details and link mode belong to the layout they were opened in.
  useEffect(() => {
    setDetails(null);
    setLinking(null);
    setMenu(null);
  }, [view]);
  useEffect(() => store("backstroke:sidebarOpen", sidebarOpen ? "1" : "0"), [sidebarOpen]);
  useEffect(() => store("backstroke:zoom", String(zoom)), [zoom]);
  useEffect(() => store("backstroke:sidebar", String(sidebarWidth)), [sidebarWidth]);
  useEffect(() => {
    const onResize = () => setSidebarWidth((w) => clampSidebar(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** Drag the line between the swimlanes and the register. Its height is null until dragged: the register then takes the room its rows need. */
  const registerPane = useRef<HTMLDivElement>(null);
  const [registerHeight, setRegisterHeight] = useState<number | null>(() => Number(stored("backstroke:registerHeight", "")) || null);
  useEffect(() => store("backstroke:registerHeight", registerHeight ? String(registerHeight) : ""), [registerHeight]);
  const clampRegister = (h: number) => {
    const total = registerPane.current?.parentElement?.clientHeight ?? window.innerHeight;
    return Math.round(Math.max(REGISTER_MIN, Math.min(h, total - TIMELINE_MIN_HEIGHT)));
  };
  const startRegisterResize = (e: React.PointerEvent) => {
    if (e.button !== 0 || !registerPane.current) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = registerPane.current.offsetHeight;
    document.body.classList.add("resizing", "rows");
    const onMove = (ev: PointerEvent) => setRegisterHeight(clampRegister(startHeight + startY - ev.clientY));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("resizing", "rows");
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const startSidebarResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    document.body.classList.add("resizing");
    const onMove = (ev: PointerEvent) => setSidebarWidth(clampSidebar(startWidth + startX - ev.clientX));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("resizing");
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };
  useEffect(() => store("backstroke:colorBy", colorBy), [colorBy]);
  const toggleExpand = useCallback((id: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }, []);

  /** Show the plan with a side panel tab open. */
  const showTab = useCallback((t: Tab) => {
    setView("plan");
    setTab(t);
    setSidebarOpen(true);
  }, []);
  const showCompare = useCallback(
    (range: CompareRange) => {
      setCompare(range);
      setViewVersion(null);
      setHistoryMode("compare");
      showTab("history");
    },
    [showTab],
  );

  // --- Which versions are on screen -------------------------------------------------
  const shownVersion = compare ? compare.to : viewVersion;
  const ghostVersion = compare ? compare.from : !live && showChanges && viewVersion! > 0 ? viewVersion! - 1 : null;
  const showingLive = shownVersion === null || (compare !== null && compare.to === p.version && live);
  const editable = showingLive && !playing;

  useEffect(() => {
    if (shownVersion !== null) p.stateAt(shownVersion);
    if (ghostVersion !== null) p.stateAt(ghostVersion);
    if (playing && viewVersion !== null && viewVersion < p.version) p.stateAt(viewVersion + 1);
  }, [shownVersion, ghostVersion, playing, viewVersion, p.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastShown = useRef<PlanState>(p.proposed);
  const shownPlan: PlanState = showingLive ? p.proposed : (p.cachedStateAt(shownVersion!) ?? lastShown.current);
  lastShown.current = shownPlan;
  // Lanes are shown in the project's saved order, a display setting outside the plan's history.
  const laneOrder = useMemo(() => projects.find((x) => x.id === projectId)?.lane_order ?? [], [projects, projectId]);
  const displayed: PlanState = useMemo(() => ({ ...shownPlan, workstreams: orderLanes(shownPlan.workstreams, laneOrder) }), [shownPlan, laneOrder]);
  /** Move a lane and save the new order at once: no staged change, no commit. */
  const moveLaneTo = (id: string, beforeId: string | null) => {
    const next = projectId ? moveLane(displayed.workstreams.map((w) => w.id), id, beforeId) : null;
    if (!projectId || !next) return;
    const pid = projectId;
    setProjects((ps) => ps.map((x) => (x.id === pid ? { ...x, lane_order: next } : x)));
    api.setLaneOrder(pid, next).catch((e: ApiError) => {
      window.alert(`Couldn't save the lane order: ${e.errors?.length ? e.errors.map((x) => x.message).join(" ") : e.message}`);
      void reloadDirectory();
    });
  };
  const ghost = ghostVersion !== null ? (p.cachedStateAt(ghostVersion) ?? null) : null;

  // Row order: the project's saved order, then the persisted plan's start dates, so rows don't
  // jump while dragging or replaying.
  const rowOrder = useMemo(() => projects.find((x) => x.id === projectId)?.row_order ?? [], [projects, projectId]);
  const order = useMemo(() => orderRows(p.persisted.deliverables, rowOrder), [p.persisted, rowOrder]);
  /**
   * A bar dragged up or down. Its place in the lane is saved at once (no commit); dropping it in
   * another lane also stages the workstream change, which is committed like any other.
   */
  const moveRowTo = (id: string, workstreamId: string, beforeId: string | null) => {
    const d = displayed.deliverables.find((x) => x.id === id);
    if (!projectId || !d) return;
    if (d.workstream_id !== workstreamId) p.stage({ entity_type: "deliverable", entity_id: id, operation: "update", fields: { workstream_id: workstreamId } });
    const all = [...order, ...displayed.deliverables.map((x) => x.id).filter((x) => !order.includes(x))];
    const laneIds = displayed.deliverables.filter((x) => x.workstream_id === workstreamId).map((x) => x.id);
    const next = moveRow(all, id, beforeId, laneIds);
    if (!next) return;
    const pid = projectId;
    setProjects((ps) => ps.map((x) => (x.id === pid ? { ...x, row_order: next } : x)));
    api.setRowOrder(pid, next).catch((e: ApiError) => {
      window.alert(`Couldn't save the row order: ${e.errors?.length ? e.errors.map((x) => x.message).join(" ") : e.message}`);
      void reloadDirectory();
    });
  };
  const stagedIds = useMemo(() => (showingLive ? stagedEntityIds(p.staged) : new Set<string>()), [p.staged, showingLive]);
  const conflicts = showingLive ? (p.preview?.conflicts ?? []) : [];

  // --- Playback ---------------------------------------------------------------------
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setViewVersion((v) => {
        const cur = v ?? p.version;
        if (cur >= p.version) {
          setPlaying(false);
          return v;
        }
        return cur + 1;
      });
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, p.version]);

  const showVersion = useCallback((seq: number | null) => {
    setCompare(null);
    setViewVersion(seq);
  }, []);
  const play = () => {
    setCompare(null);
    setShowChanges(true);
    if (viewVersion === null || viewVersion >= p.version) setViewVersion(1);
    setPlaying(true);
  };

  // --- Keyboard ---------------------------------------------------------------------
  const meetingsShown = view === "plan" && sidebarOpen && tab === "meetings";
  const takingNotes = meetingsShown && openMeetingId !== null;
  const timelineShown = view === "plan";
  const barRect = (id: string) => document.querySelector(`[data-item-id="${CSS.escape(id)}"]`)?.getBoundingClientRect() ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (commitOpen || finishing || menu || prompt || !timelineShown || isTyping(e)) return;
      if ((e.target as HTMLElement).closest?.(".details-card")) return;
      if (e.key === "Escape") {
        if (linking) setLinking(null);
        else if (details) setDetails(null);
        else if (selectedId && stagedIds.has(selectedId)) p.revert("deliverable", selectedId);
        else setSelectedId(null);
      } else if (e.key === "ArrowLeft" && p.version > 0 && view === "plan") {
        e.preventDefault();
        setPlaying(false);
        showVersion(Math.max(0, (viewVersion ?? p.version) - 1));
      } else if (e.key === "ArrowRight" && viewVersion !== null && view === "plan") {
        e.preventDefault();
        setPlaying(false);
        showVersion(viewVersion + 1 >= p.version ? null : viewVersion + 1);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId && editable) {
        p.stage({ entity_type: "deliverable", entity_id: selectedId, operation: "delete", fields: {} });
        setSelectedId(null);
        setDetails(null);
      } else if (e.key === "Enter" && selectedId) {
        e.preventDefault();
        openDetails(selectedId);
      } else if (e.key === "F2" && selectedId && editable) {
        e.preventDefault();
        const d = displayed.deliverables.find((x) => x.id === selectedId);
        const r = barRect(selectedId);
        if (d && r) {
          menuAt.current = { x: r.left, y: r.bottom + 6 };
          openPrompt({ label: "Name", value: d.name, onSubmit: (name) => p.stage({ entity_type: "deliverable", entity_id: d.id, operation: "update", fields: { name } }) });
        }
      } else if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && selectedId) {
        e.preventDefault();
        const r = barRect(selectedId);
        if (r) openItemMenu(selectedId, null, r.left, r.bottom + 4);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // --- Actions ----------------------------------------------------------------------
  const addDeliverable = (workstreamId: string, date?: string, type: "task" | "milestone" = "task") => {
    if (!editable) return;
    const start = date ?? today;
    const id = newId("deliverable");
    p.stage({
      entity_type: "deliverable",
      entity_id: id,
      operation: "create",
      fields: {
        workstream_id: workstreamId,
        name: type === "milestone" ? "New milestone" : "New deliverable",
        type,
        start_date: start,
        end_date: type === "milestone" ? start : addDays(start, 4),
      },
    });
    setSelectedId(id);
    // Open the card once the new bar is drawn, so it sits beside it.
    requestAnimationFrame(() => setDetails({ id, tab: "details", focusName: true }));
  };

  const applySuggestions = () => {
    const suggestions = p.preview?.suggestions ?? [];
    p.stageMany(
      suggestions.map((s) => ({ entity_type: "deliverable", entity_id: s.deliverable_id, operation: "update", fields: { start_date: s.start_date, end_date: s.end_date } })),
    );
    flash(`Staged ${suggestions.length} downstream move${suggestions.length === 1 ? "" : "s"}`);
  };

  const revertCommit = async (seq: number) => {
    const c = p.commits.find((x) => x.seq === seq);
    if (!c) return;
    const who = author;
    const reason = window.prompt(`Undo #${seq} as a new commit. Reason:`, `Revert #${seq}: ${c.reason}`);
    if (reason === null) return;
    try {
      const commit = await p.revertCommit(seq, who, reason.trim() || undefined);
      showVersion(null);
      flash(`Undo recorded as #${commit.seq}`);
    } catch (e) {
      const err = e as ApiError;
      window.alert(err.errors?.length ? err.errors.map((x) => x.message).join("\n") : err.message);
    }
  };

  const tagBaseline = async (seq: number) => {
    const name = window.prompt(`Name for the baseline at #${seq}:`, `Baseline #${seq}`);
    if (!name?.trim()) return;
    try {
      await p.createBaseline(name.trim(), seq);
      flash(`Baseline “${name.trim()}” → #${seq}`);
    } catch (e) {
      window.alert((e as Error).message);
    }
  };

  const createProject = async (name: string, description: string, groups: string[]) => {
    const created = await api.createProject(name, description, groups);
    await reloadDirectory();
    openProject(created.id);
  };
  /** A new project needs its groups chosen, so it's made in Settings → Projects. */
  const newProject = () => {
    openSettings("projects");
    setFocusNewProject(Date.now());
  };
  const openProject = (id: string) => {
    setProjectId(id);
    if (view === "settings") setView("plan");
  };
  const openSettings = (t?: SettingsTab) => {
    if (t) setSettingsTab(t);
    setView("settings");
  };
  /** After Settings saves: projects and people changed, and so may the open project's roster. */
  const reloadDirectory = async () => {
    const [ps, people] = await Promise.all([api.projects(), api.orgPeople()]);
    setProjects(ps);
    setOrg(people);
    onAccountChanged();
    await meetings.reload();
  };
  const currentProject = projects.find((x) => x.id === projectId) ?? null;

  // An open details card follows the selection, and closes when nothing is selected.
  const select = (id: string | null) => {
    setSelectedId(id);
    setDetails((cur) => (cur && id ? (cur.id === id ? cur : { ...cur, id, focusName: false }) : null));
  };
  const openDetails = (id: string, t: DetailsTab = "details") => {
    setSelectedId(id);
    setDetails({ id, tab: t, focusName: false });
  };
  /** Select a deliverable from elsewhere (register, notes, metrics) and show it on the plan. */
  const focusDeliverable = (id: string) => {
    if (!timelineShown) setView("plan");
    requestAnimationFrame(() => {
      document.querySelector(`[data-item-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
      window.setTimeout(() => openDetails(id), 250);
    });
    setSelectedId(id);
  };

  const link = (from: string, role: LinkRole, to: string) => {
    const [predecessor_id, successor_id] = role === "predecessor" ? [to, from] : [from, to];
    const exists = displayed.dependencies.some(
      (d) => (d.predecessor_id === predecessor_id && d.successor_id === successor_id) || (d.predecessor_id === successor_id && d.successor_id === predecessor_id),
    );
    setLinking(null);
    if (exists) return flash("Those two are already linked");
    p.stage({ entity_type: "dependency", entity_id: newId("dependency"), operation: "create", fields: { predecessor_id, successor_id, type: "FS" } });
    const name = (x: string) => displayed.deliverables.find((d) => d.id === x)?.name ?? "?";
    flash(`Staged: ${name(successor_id)} depends on ${name(predecessor_id)}`);
  };
  const pick = (id: string) => {
    if (linking) return link(linking.id, linking.role, id);
    const d = displayed.deliverables.find((x) => x.id === id);
    if (takingNotes && d) setMentionRequest({ name: d.name, nonce: Date.now() });
  };

  const viewCommit = (seq: number) => {
    setPlaying(false);
    showVersion(seq === p.version ? null : seq);
    p.stateAt(seq);
    if (seq > 0) p.stateAt(seq - 1);
  };

  // --- Narration for the version on screen ----------------------------------------
  const narratedSeq = !showingLive && shownVersion ? shownVersion : null;
  const narrated = narratedSeq ? p.commits.find((c) => c.seq === narratedSeq) : undefined;
  const narratedLines = narrated?.events ? describeEvents(narrated.events, [p.cachedStateAt(narrated.seq), p.cachedStateAt(narrated.seq - 1)].filter(Boolean) as PlanState[]) : [];

  const phaseNames = useMemo(() => phaseNameOrder(displayed.deliverables), [displayed.deliverables]);
  // With no phases to colour by, the Lane/Phase toggle is hidden, so bars take their lane's colour
  // rather than all turning grey (the remembered choice comes back once there are phases).
  const barColorBy: ColorBy = phaseNames.length > 0 ? colorBy : "lane";

  // Status is judged as of today when live, or as of the commit's date when replaying history.
  const shownCommit = !showingLive && shownVersion ? p.commits.find((c) => c.seq === shownVersion) : undefined;
  const asOf = shownCommit ? shownCommit.created_at.slice(0, 10) : today;
  const statusCounts = useMemo(() => {
    const counts: Record<StatusKind, number> = { done: 0, progress: 0, behind: 0, overdue: 0, todo: 0 };
    for (const d of displayed.deliverables) {
      const s = deliverableStatus(d, asOf);
      if (s) counts[s.kind]++;
    }
    return counts;
  }, [displayed.deliverables, asOf]);

  const recordProgress = async (id: string, phase: number | null, finishedOn: string | null) => {
    const who = author;
    try {
      const commit = await p.recordProgress(who, id, phase, finishedOn);
      flash(`#${commit.seq}: ${commit.reason}`);
    } catch (e) {
      const err = e as ApiError;
      window.alert(err.errors?.length ? err.errors.map((x) => x.message).join("\n") : err.message);
    }
  };

  // --- Right-click menus ----------------------------------------------------------
  const openPrompt = (req: Omit<PromptRequest, "x" | "y">) => setPrompt({ ...req, ...menuAt.current });
  const menuContext: MenuContext = {
    state: displayed,
    persisted: p.persisted,
    editable,
    asOf,
    stage: p.stage,
    progress: (id, phase, finishedOn) => void recordProgress(id, phase, finishedOn),
    prompt: openPrompt,
    openDetails,
    startLink: (id, role) => {
      setLinking({ id, role });
      setDetails(null);
    },
    select,
    addDeliverable,
    moveLane: moveLaneTo,
  };
  const showMenu = (items: MenuEntry[], x: number, y: number, heading?: string) => {
    if (!items.length) return;
    menuAt.current = { x, y };
    setPrompt(null);
    setMenu({ x, y, items, heading });
  };
  const openItemMenu = (id: string, phase: number | null, x: number, y: number) => {
    const d = displayed.deliverables.find((x) => x.id === id);
    const phaseName = phase !== null && d?.phases ? d.phases[phase]?.name : null;
    showMenu(deliverableMenu(menuContext, id, phase), x, y, d ? `${d.name}${phaseName ? ` · ${phaseName}` : ""}` : undefined);
  };

  const baseline = p.project?.baselines[0];
  const staged = p.staged.length;
  // Trail, pre-read and surprise index reload when the plan, the register or a finished meeting changes.
  const recordsKey = `${p.version}|${meetings.register.map((i) => `${i.id}:${i.status}`).join(",")}|${meetings.meetings.filter((m) => m.finished_at).length}`;
  const openMeetingNotes = (id: number | null) => {
    setOpenMeetingId(id);
    setLinking(null);
    if (id !== null) setSidebarWidth((w) => Math.max(w, clampSidebar(MEETING_PANEL_MIN)));
  };
  const openMeeting = (id: number) => {
    showTab("meetings");
    openMeetingNotes(id);
  };
  const liveMeeting = openMeetingId !== null ? meetings.meetings.find((m) => m.id === openMeetingId && !m.finished_at) : undefined;
  const unlistedPeople = [
    ...new Set([...meetings.meetings.flatMap((m) => m.attendees.map((a) => a.name)), ...meetings.register.flatMap((i) => (i.owner ? [i.owner] : []))]),
  ].filter((n) => !meetings.people.some((x) => x.name.toLowerCase() === n.toLowerCase()) && !meetings.groups.some((g) => g.toLowerCase() === n.toLowerCase()));

  if (bootError) return <div className="boot-error">{bootError}</div>;

  const timeline = (
    <section className="timeline-wrap">
      {!showingLive && (
        <div className="history-banner">
          {compare ? (
            <>
              Comparing <b>#{compare.from}</b> → <b>#{compare.to}</b> · read-only
            </>
          ) : (
            <>
              Viewing <b>#{viewVersion}</b> of {p.version} · read-only
            </>
          )}
          {!compare && (
            <label className="toggle">
              <input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} /> show what changed
            </label>
          )}
          <button className="small" onClick={() => showVersion(null)}>
            Return to current
          </button>
        </div>
      )}
      {showingLive && compare && (
        <div className="history-banner compare">
          Ghost bars show <b>#{compare.from}</b>
          <button className="small" onClick={() => setCompare(null)}>
            Hide
          </button>
        </div>
      )}
      {linking && (
        <div className="history-banner linking">
          Click the deliverable that <b>{displayed.deliverables.find((d) => d.id === linking.id)?.name}</b> {linking.role === "predecessor" ? "depends on" : "blocks"}
          <button className="small" onClick={() => setLinking(null)}>
            Cancel (Esc)
          </button>
        </div>
      )}
      <TimelineCanvas
        state={displayed}
        ghost={ghost}
        order={order}
        dayWidth={ZOOMS[zoom] ?? 16}
        today={today}
        editable={editable}
        animate={!showingLive || playing}
        stagedIds={stagedIds}
        conflicts={conflicts}
        selectedId={selectedId}
        focusKey={projectId ?? ""}
        asOf={asOf}
        expanded={expanded}
        colorBy={barColorBy}
        linkingFrom={linking?.id ?? null}
        onToggleExpand={toggleExpand}
        onSelect={select}
        onPick={pick}
        onStage={(c) => {
          p.stage(c);
        }}
        onAddDeliverable={addDeliverable}
        onItemMenu={openItemMenu}
        onLaneMenu={(id, date, x, y) => showMenu(laneMenu(menuContext, id, date), x, y, displayed.workstreams.find((w) => w.id === id)?.name)}
        onEmptyMenu={(x, y) => showMenu(emptyMenu(menuContext), x, y)}
        onMoveLane={moveLaneTo}
        onMoveRow={moveRowTo}
        onAddWorkstream={(x, y) => {
          menuAt.current = { x, y };
          promptNewWorkstream(menuContext);
        }}
        onOpenDetails={openDetails}
        onLink={(from, to) => link(from, "successor", to)}
      />
      {narrated && (
        <aside className="narration" key={narrated.seq}>
          <div className="commit-meta">
            <span className="seq">#{narrated.seq}</span>
            <span className="muted">{formatTimestamp(narrated.created_at)}</span>
            {narrated.category && <span className={`cat cat-${narrated.category}`}>{categoryLabel(categories, narrated.category)}</span>}
          </div>
          <div className="narration-reason">“{narrated.reason}”</div>
          <div className="muted small">
            {narrated.author}
            {narrated.reference && <> · {narrated.reference}</>}
          </div>
          {showChanges && (
            <ul className="event-lines">
              {narratedLines.slice(0, 8).map((l) => (
                <li key={l.key} className={l.delta ? (l.delta > 0 ? "later" : "earlier") : ""}>
                  {l.text}
                </li>
              ))}
              {narratedLines.length > 8 && <li className="muted">+{narratedLines.length - 8} more</li>}
            </ul>
          )}
        </aside>
      )}
      {!tipSeen && editable && view === "plan" && displayed.workstreams.length > 0 && (
        <div className="timeline-tip small">
          Right-click a bar or a lane for actions. Double-click a bar (or press Enter) for its details.
          <button
            className="link small"
            onClick={() => {
              setTipSeen(true);
              store("backstroke:tipSeen", "1");
            }}
          >
            Got it
          </button>
        </div>
      )}
      {p.loading && <div className="loading">Loading…</div>}
      {p.error && <div className="callout error floating">{p.error}</div>}
    </section>
  );

  // Icon tabs: the name is the tooltip; staged edits and a live meeting show as a badge.
  const tabs: { key: Tab; label: string; badge: string | null; title: string }[] = [
    { key: "changes", label: "Changes", badge: staged ? String(staged) : null, title: staged ? `Changes · ${staged} staged` : "Changes" },
    { key: "meetings", label: "Meetings", badge: liveMeeting ? "" : null, title: liveMeeting ? `Meetings · ${liveMeeting.title} in progress` : "Meetings" },
    { key: "history", label: "History", badge: null, title: "History and compare" },
    { key: "insights", label: "Insights", badge: null, title: "Insights: metrics and surprises" },
  ];
  const tabButton = (t: (typeof tabs)[number], onClick: () => void, className = "") => (
    <button key={t.key} role="tab" aria-selected={tab === t.key} aria-label={t.title} title={t.title} className={`icon-tab ${className}`} onClick={onClick}>
      <TabIcon name={t.key} />
      {t.badge !== null && <span className={`tab-badge ${t.badge ? "count" : "dot"}`}>{t.badge}</span>}
    </button>
  );

  return (
    <div className={`shell ${navCollapsed ? "nav-collapsed" : ""}`}>
      <ProjectNav
        projects={projects}
        projectId={projectId}
        inSettings={view === "settings"}
        account={account}
        collapsed={navCollapsed}
        othersOpen={othersOpen}
        onToggleCollapsed={() => setNavCollapsed((c) => !c)}
        onToggleOthers={() => setOthersOpen((o) => !o)}
        onOpen={openProject}
        onNewProject={newProject}
        onSettings={() => openSettings()}
      />
      <div className="app">
        <header className="topbar">
          <div className="topbar-row">
            {view === "settings" ? (
              <div className="project-title">
                <h1>Settings</h1>
                <span className="muted">People, projects and the open project</span>
              </div>
            ) : (
              <div className="project-title">
                <h1>{currentProject?.name ?? "No project"}</h1>
                {currentProject?.description && <span className="muted project-description">{currentProject.description}</span>}
              </div>
            )}
            <div className="spacer" />
            <div className="topbar-account">
              <span className="nav-initials" aria-hidden="true">
                {initials(account.name)}
              </span>
              <span className="topbar-account-who" title={[account.username, account.email].filter(Boolean).join(" · ")}>
                <b>{account.name}</b>
                {account.is_admin && <span className="muted small">Admin</span>}
              </span>
              <button className="small" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </div>
          <div className="toolbar">
            {view === "settings" ? (
              <nav className="view-nav" aria-label="Settings">
                {(
                  [
                    ["people", "People", org ? String(org.people.length) : null],
                    ["projects", "Projects", String(projects.length)],
                    ...(currentProject ? [["project", currentProject.name, null] as [SettingsTab, string, null]] : []),
                  ] as [SettingsTab, string, string | null][]
                ).map(([key, label, count]) => (
                  <button key={key} aria-current={settingsTab === key ? "page" : undefined} className={settingsTab === key ? "active" : ""} onClick={() => setSettingsTab(key)}>
                    {label}
                    {count && <span className="muted small">{count}</span>}
                  </button>
                ))}
              </nav>
            ) : null}
            {timelineShown && (
              <>
                <div className="versions">
                  {baseline && (
                    <button className="version-chip" title="Compare baseline with current" onClick={() => showCompare({ from: baseline.version, to: p.version })}>
                      Baseline: <b>{baseline.name}</b> (#{baseline.version})
                    </button>
                  )}
                  <span className="version-chip">
                    Current: <b>#{p.version}</b>
                  </span>
                </div>
                <div className="status-counts" title={`Status as of ${asOf}`}>
                  {statusCounts.done > 0 && <span className="st done">{statusCounts.done} done</span>}
                  {statusCounts.progress > 0 && <span className="st">{statusCounts.progress} in progress</span>}
                  {statusCounts.behind > 0 && <span className="st behind">{statusCounts.behind} behind</span>}
                  {statusCounts.overdue > 0 && <span className="st overdue">{statusCounts.overdue} overdue</span>}
                  {statusCounts.todo > 0 && <span className="st">{statusCounts.todo} not started</span>}
                </div>
                <div className="spacer" />
                {staged > 0 && (
                  <button className="staged-badge" onClick={() => showTab("changes")}>
                    <span className="count">{staged}</span> staged · Review & commit
                  </button>
                )}
                {phaseNames.length > 0 && (
                  <div className="color-by" role="group" aria-label="Colour bars by">
                    <span className="muted small">Colour</span>
                    <div className="seg-toggle">
                      {(["lane", "phase"] as ColorBy[]).map((c) => (
                        <button key={c} aria-pressed={colorBy === c} onClick={() => setColorBy(c)}>
                          {c === "lane" ? "Lane" : "Phase"}
                        </button>
                      ))}
                    </div>
                    {colorBy === "phase" && (
                      <span className="phase-legend">
                        {phaseNames.map((name, i) => (
                          <span key={name}>
                            <i style={{ background: PHASE_COLORS[i % PHASE_COLORS.length] }} />
                            {name}
                          </span>
                        ))}
                        <span>
                          <i style={{ background: "var(--plain-bar)" }} />
                          No phases
                        </span>
                      </span>
                    )}
                  </div>
                )}
                <div className="zoom" role="group" aria-label="Zoom">
                  <button className="icon" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))} title="Zoom out">
                    −
                  </button>
                  <button className="icon" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} title="Zoom in">
                    +
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        {view === "plan" && projectId && (
          <main className={`workspace ${sidebarOpen ? "" : "panel-closed"}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
            <div className="plan-main">
              {liveMeeting && !meetingsShown && (
                <div className="meeting-return">
                  <span>
                    <span className="live-dot" /> <b>{liveMeeting.title}</b> is in progress
                  </span>
                  <button className="small" onClick={() => showTab("meetings")}>
                    Back to notes
                  </button>
                </div>
              )}
              {timeline}
              <div
                className="register-resizer"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the register"
                tabIndex={0}
                title="Drag to resize. Double-click to fit the register."
                onPointerDown={startRegisterResize}
                onDoubleClick={() => setRegisterHeight(null)}
                onKeyDown={(e) => {
                  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && registerPane.current) {
                    e.preventDefault();
                    const h = registerPane.current.offsetHeight;
                    setRegisterHeight(clampRegister(h + (e.key === "ArrowUp" ? 24 : -24)));
                  }
                }}
              />
              <div ref={registerPane} className={`register-pane ${registerHeight ? "sized" : ""}`} style={registerHeight ? { height: registerHeight } : undefined}>
                <RegisterView
                  projectId={projectId}
                  author={author}
                  register={meetings.register}
                  deliverables={p.persisted.deliverables}
                  today={today}
                  onSelectDeliverable={focusDeliverable}
                  people={meetings.people}
                  onCreate={meetings.createItem}
                  onUpdate={meetings.updateItem}
                />
              </div>
            </div>

            {sidebarOpen ? (
              <aside className="sidebar">
                <div
                  className="sidebar-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize sidebar"
                  aria-valuenow={sidebarWidth}
                  aria-valuemin={SIDEBAR_MIN}
                  tabIndex={0}
                  title="Drag to resize. Double-click to reset."
                  onPointerDown={startSidebarResize}
                  onDoubleClick={() => setSidebarWidth(clampSidebar(SIDEBAR_DEFAULT))}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      e.preventDefault();
                      setSidebarWidth((w) => clampSidebar(w + (e.key === "ArrowLeft" ? 24 : -24)));
                    }
                  }}
                />
                <nav className="tabs" role="tablist">
                  {tabs.map((t) => tabButton(t, () => setTab(t.key), tab === t.key ? "active" : ""))}
                  <span className="tab-name">{tabs.find((t) => t.key === tab)?.label}</span>
                  <span className="spacer" />
                  <button className="icon collapse" title="Hide the panel" aria-label="Hide the panel" onClick={() => setSidebarOpen(false)}>
                    »
                  </button>
                </nav>
                <div className="tab-body">
                  {tab === "changes" && (
                    <StagedChangesDrawer
                      staged={p.staged}
                      persisted={p.persisted}
                      proposed={p.proposed}
                      preview={p.preview}
                      selection={p.selection}
                      selectionPreview={p.selectionPreview}
                      excluded={p.excluded}
                      editable={live}
                      onToggle={p.toggleSelected}
                      onSelectAll={p.selectAll}
                      onUnstage={p.unstage}
                      onDiscard={() => window.confirm(`Discard ${staged} staged change${staged === 1 ? "" : "s"}?`) && p.discard()}
                      onSelect={(id) => {
                        showVersion(null);
                        openDetails(id);
                      }}
                      onApplySuggestions={applySuggestions}
                      onCommit={() => setCommitOpen(true)}
                    />
                  )}
                  {tab === "history" && (
                    <>
                      <div className="seg-toggle history-mode" role="group" aria-label="History">
                        <button aria-pressed={historyMode === "commits"} onClick={() => setHistoryMode("commits")}>
                          Commits
                        </button>
                        <button aria-pressed={historyMode === "compare"} onClick={() => setHistoryMode("compare")}>
                          Compare versions
                        </button>
                      </div>
                      {historyMode === "commits" ? (
                        <HistoryPanel
                          commits={p.commits}
                          version={p.version}
                          viewVersion={compare ? null : viewVersion}
                          categories={categories}
                          stateFor={p.cachedStateAt}
                          onView={(seq) => {
                            setPlaying(false);
                            showVersion(seq);
                            if (seq !== null) {
                              p.stateAt(seq);
                              if (seq > 0) p.stateAt(seq - 1);
                            }
                          }}
                          onCompareWithCurrent={(seq) => showCompare({ from: seq, to: p.version })}
                          onRevert={revertCommit}
                          onBaseline={tagBaseline}
                        />
                      ) : (
                        projectId && (
                          <ComparePanel
                            projectId={projectId}
                            commits={p.commits}
                            baselines={p.project?.baselines ?? []}
                            version={p.version}
                            range={compare}
                            onChange={(r) => {
                              setPlaying(false);
                              setCompare(r);
                              setViewVersion(r && r.to !== p.version ? r.to : null);
                            }}
                            onSelect={openDetails}
                          />
                        )
                      )}
                    </>
                  )}
                  {tab === "meetings" && projectId && (
                    <MeetingsView
                      projectId={projectId}
                      refreshKey={recordsKey}
                      store={meetings}
                      deliverables={p.proposed.deliverables}
                      today={today}
                      openId={openMeetingId}
                      onOpen={openMeetingNotes}
                      mentionRequest={mentionRequest}
                      stagedCount={p.selection.changes.length}
                      onReviewChanges={() => setTab("changes")}
                      onFinish={setFinishing}
                      onViewCommit={viewCommit}
                      onSelectDeliverable={focusDeliverable}
                    />
                  )}
                  {tab === "insights" && projectId && (
                    <>
                      <MetricsPanel projectId={projectId} version={p.version} baselines={p.project?.baselines ?? []} categories={categories} onSelect={openDetails} />
                      <SurpriseIndex projectId={projectId} refreshKey={recordsKey} onViewCommit={viewCommit} />
                    </>
                  )}
                </div>
              </aside>
            ) : (
              <aside className="sidebar-rail" aria-label="Panel">
                <button className="icon" title="Show the panel" aria-label="Show the panel" onClick={() => setSidebarOpen(true)}>
                  «
                </button>
                {tabs.map((t) =>
                  tabButton(t, () => {
                    setTab(t.key);
                    setSidebarOpen(true);
                  }),
                )}
              </aside>
            )}
          </main>
        )}

        {view === "settings" && (
          <main className="workspace single">
            {settingsTab === "project" && currentProject ? (
              <div className="page">
                <div className="page-inner">
                  <header className="page-head">
                    <div>
                      <h2>{currentProject.name}</h2>
                      <p className="muted">Who works on this project, and the ways to take it elsewhere.</p>
                    </div>
                  </header>
                  <section className="card project-extras">
                    <h3>
                      Members <span className="muted small">{currentProject.members.length}</span>
                    </h3>
                    {currentProject.members.length ? (
                      <p>{currentProject.members.join(", ")}</p>
                    ) : (
                      <p className="muted">No members yet. Members come from the groups the project takes, under Projects.</p>
                    )}
                    <button className="small link" onClick={() => setSettingsTab("projects")}>
                      Change groups
                    </button>
                  </section>
                  <section className="card project-extras">
                    <h3>Knowledge base</h3>
                    <p className="muted">The project as one Markdown file to paste into an assistant.</p>
                    <button className="small" onClick={() => setKnowledgeOpen(true)}>
                      Open knowledge base
                    </button>
                  </section>
                  <section className="card project-extras">
                    <h3>Export</h3>
                    <p className="muted">The project's full commit history as JSON.</p>
                    <a className="small button-link" href={api.exportUrl(currentProject.id)} download={`${currentProject.id}-history.json`}>
                      Download history
                    </a>
                  </section>
                </div>
              </div>
            ) : settingsTab === "people" || (settingsTab === "project" && !currentProject) ? (
              org && (
                <PeopleView
                  roster={org}
                  projects={projects}
                  unlisted={currentProject && unlistedPeople.length ? { names: unlistedPeople, project: currentProject } : null}
                  onSave={async (roster) => {
                    setOrg(await api.saveOrgPeople(roster));
                    await reloadDirectory();
                    if (account.is_admin) setAccounts(await api.accounts());
                  }}
                  readOnly={!account.is_admin}
                  accounts={account.is_admin ? accounts : null}
                  me={account}
                  onSetAdmin={async (id, isAdmin) => {
                    await api.setAdmin(id, isAdmin);
                    setAccounts(await api.accounts());
                  }}
                  onRevoke={async (a) => {
                    await api.removeAccount(a.id);
                    setAccounts(await api.accounts());
                  }}
                />
              )
            ) : (
              org && (
                <ProjectSettings
                  readOnly={!account.is_admin}
                  projects={projects}
                  org={org}
                  focusNew={focusNewProject}
                  onSaved={reloadDirectory}
                  onOpen={openProject}
                  onCreate={createProject}
                />
              )
            )}
          </main>
        )}

        {view !== "settings" && !projectId && (
          <main className="workspace single">
            <div className="page">
              <div className="page-inner empty-project">
                <h2>No project open</h2>
                {account.is_admin ? (
                  <>
                    <p className="muted">Pick a project on the left, or start one. A project holds a plan of swimlanes, its meetings and its register.</p>
                    <button className="primary" onClick={newProject}>
                      New project
                    </button>
                  </>
                ) : (
                  <p className="muted">None of your groups works on a project yet. Ask an admin to add one of your groups to a project in Settings.</p>
                )}
              </div>
            </div>
          </main>
        )}

        {view === "plan" && projectId && (
          <footer>
            <PlaybackControls
              version={p.version}
              viewVersion={compare ? (compare.to === p.version && live ? null : compare.to) : viewVersion}
              commits={p.commits}
              playing={playing}
              hasStaged={staged > 0}
              onView={(seq) => {
                setPlaying(false);
                showVersion(seq === p.version && viewVersion === null ? null : seq);
              }}
              onPlay={play}
              onPause={() => setPlaying(false)}
            />
          </footer>
        )}

        {timelineShown && details && displayed.deliverables.some((d) => d.id === details.id) && projectId && (
          <DetailsCard
            id={details.id}
            tab={details.tab}
            onTab={(t) => setDetails({ ...details, tab: t, focusName: false })}
            focusName={details.focusName}
            state={displayed}
            persisted={p.persisted}
            editable={editable}
            stagedIds={stagedIds}
            asOf={asOf}
            projectId={projectId}
            hasHistory={showingLive && p.persisted.deliverables.some((d) => d.id === details.id)}
            refreshKey={recordsKey}
            onStage={p.stage}
            onRevert={(id) => p.revert("deliverable", id)}
            onSelect={(id) => (id ? openDetails(id) : (setSelectedId(null), setDetails(null)))}
            onProgress={recordProgress}
            onViewCommit={viewCommit}
            onOpenMeeting={openMeeting}
            onClose={() => setDetails(null)}
          />
        )}
        {menu && <ContextMenu request={menu} onClose={() => setMenu(null)} />}
        {prompt && <QuickPrompt request={prompt} onClose={() => setPrompt(null)} />}

        {commitOpen && (
          <CommitDialog
            staged={p.selection.changes}
            remaining={p.staged.length - p.selection.changes.length}
            persisted={p.persisted}
            proposed={p.proposed}
            preview={p.selectionPreview}
            categories={categories}
            version={p.version}
            author={author}
            onReload={p.refresh}
            onClose={() => setCommitOpen(false)}
            onCommit={async (input) => {
              const left = p.staged.length - p.selection.changes.length;
              const commit = await p.commit(input);
              setCommitOpen(false);
              if (left > 0) {
                flash(`Committed #${commit.seq}: ${commit.reason} · ${left} change${left === 1 ? "" : "s"} still staged`);
              } else {
                setTab("history");
                setHistoryMode("commits");
                flash(`Committed #${commit.seq}: ${commit.reason}`);
              }
            }}
          />
        )}
        {finishing && (
          <FinishMeetingDialog
            meeting={meetings.meetings.find((m) => m.id === finishing.id) ?? finishing}
            deliverables={p.proposed.deliverables}
            people={meetings.people}
            staged={p.selection.changes}
            persisted={p.persisted}
            proposed={p.proposed}
            preview={p.selectionPreview}
            categories={categories}
            version={p.version}
            author={author}
            onReload={p.refresh}
            onClose={() => setFinishing(null)}
            onFinish={async ({ author: who, withCommit, reason, category }) => {
              const m = meetings.meetings.find((x) => x.id === finishing.id) ?? finishing;
              const items = itemsFromNotes(parseNotes(m.notes, p.proposed.deliverables, m.held_on, meetings.people)).map(({ line: _line, ...item }) => item);
              const result = await p.finishMeeting(m.id, { author: who, items, commit: withCommit ? { reason, category } : null });
              await meetings.finished(result.meeting);
              setFinishing(null);
              flash(`Finished ${m.title}: ${items.length} item${items.length === 1 ? "" : "s"} recorded` + (result.commit ? `, plan commit #${result.commit.seq}` : ""));
            }}
          />
        )}
        {knowledgeOpen && projectId && <KnowledgeDialog projectId={projectId} projectName={currentProject?.name ?? projectId} onClose={() => setKnowledgeOpen(false)} />}
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  );
}
