import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ItemUpdate } from "../api/client";
import type { Attendee, ItemInput, Meeting, Person, RegisterItem } from "../types";

export type SaveState = "saved" | "saving" | "failed";

export interface MeetingsStore {
  meetings: Meeting[];
  register: RegisterItem[];
  /** The project's members, offered when adding attendees and owners. Edited in Settings. */
  people: Person[];
  /** The groups the project's members are in, in the organisation's order. */
  groups: string[];
  error: string | null;
  saveState: SaveState;
  reload: () => Promise<void>;
  create: (title: string, heldOn: string) => Promise<Meeting>;
  /** Edits show at once and are saved shortly after the last one. */
  edit: (meetingId: number, fields: { title?: string; held_on?: string; attendees?: Attendee[]; notes?: string }) => void;
  /** Save pending edits now (before finishing a meeting or leaving it). */
  flush: () => Promise<void>;
  remove: (meetingId: number) => Promise<void>;
  /** Put a finished meeting in place and reload the register its items went into. */
  finished: (meeting: Meeting) => Promise<void>;
  createItem: (input: ItemInput & { author?: string }) => Promise<RegisterItem>;
  updateItem: (itemId: number, input: ItemUpdate) => Promise<RegisterItem>;
}

const SAVE_DELAY_MS = 700;

export function useMeetings(projectId: string | null): MeetingsStore {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [register, setRegister] = useState<RegisterItem[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const pending = useRef(new Map<number, Record<string, unknown>>());
  const timer = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    if (!projectId) return;
    const [ms, items, ps] = await Promise.all([api.meetings(projectId), api.register(projectId), api.people(projectId)]);
    setMeetings(ms);
    setRegister(items);
    setPeople(ps.people);
    setGroups(ps.groups);
  }, [projectId]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!projectId || pending.current.size === 0) return;
    const batch = [...pending.current];
    pending.current.clear();
    setSaveState("saving");
    try {
      for (const [id, fields] of batch) await api.updateMeeting(projectId, id, fields);
      setSaveState(pending.current.size ? "saving" : "saved");
    } catch (e) {
      // Keep the edits so the next change or flush retries them.
      for (const [id, fields] of batch) pending.current.set(id, { ...fields, ...pending.current.get(id) });
      setSaveState("failed");
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    setMeetings([]);
    setRegister([]);
    setPeople([]);
    setGroups([]);
    setError(null);
    pending.current.clear();
    reload().catch((e: Error) => setError(e.message));
  }, [reload]);

  // Don't lose the last keystrokes when switching project or closing the tab.
  useEffect(() => {
    const onLeave = () => void flush();
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      void flush();
    };
  }, [flush]);

  const edit = useCallback(
    (meetingId: number, fields: { title?: string; held_on?: string; attendees?: Attendee[]; notes?: string }) => {
      setMeetings((ms) => ms.map((m) => (m.id === meetingId ? { ...m, ...fields } : m)));
      pending.current.set(meetingId, { ...pending.current.get(meetingId), ...fields });
      setSaveState("saving");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  const create = useCallback(
    async (title: string, heldOn: string) => {
      if (!projectId) throw new Error("no project");
      const meeting = await api.createMeeting(projectId, { title, held_on: heldOn });
      setMeetings((ms) => [meeting, ...ms].sort((a, b) => b.held_on.localeCompare(a.held_on) || b.id - a.id));
      return meeting;
    },
    [projectId],
  );

  const remove = useCallback(
    async (meetingId: number) => {
      if (!projectId) return;
      pending.current.delete(meetingId);
      await api.deleteMeeting(projectId, meetingId);
      setMeetings((ms) => ms.filter((m) => m.id !== meetingId));
    },
    [projectId],
  );

  const finished = useCallback(
    async (meeting: Meeting) => {
      setMeetings((ms) => ms.map((m) => (m.id === meeting.id ? meeting : m)));
      if (projectId) setRegister(await api.register(projectId));
    },
    [projectId],
  );

  const createItem = useCallback(
    async (input: ItemInput & { author?: string }) => {
      if (!projectId) throw new Error("no project");
      const item = await api.createItem(projectId, input);
      setRegister((r) => [...r, item]);
      return item;
    },
    [projectId],
  );

  const updateItem = useCallback(
    async (itemId: number, input: ItemUpdate) => {
      if (!projectId) throw new Error("no project");
      const item = await api.updateItem(projectId, itemId, input);
      // A risk that happens raises or links an issue, and reopening unlinks it: other rows change too.
      if (item.kind === "risk" && (input.outcome || input.status)) setRegister(await api.register(projectId));
      else setRegister((r) => r.map((x) => (x.id === item.id ? item : x)));
      setMeetings((ms) => ms.map((m) => ({ ...m, items: m.items.map((x) => (x.id === item.id ? item : x)) })));
      return item;
    },
    [projectId],
  );

  return { meetings, register, people, groups, error, saveState, reload, create, edit, flush, remove, finished, createItem, updateItem };
}
