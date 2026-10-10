/** Line icons for the side panel's tabs, drawn in the current text colour. */
export type TabIconName = "changes" | "meetings" | "history" | "insights";

const PATHS: Record<TabIconName, React.ReactNode> = {
  // A commit on a line: staged edits waiting to be committed.
  changes: (
    <>
      <circle cx="12" cy="12" r="3.25" />
      <path d="M3 12h5.75M15.25 12H21" />
    </>
  ),
  // A speech bubble with lines of notes.
  meetings: (
    <>
      <path d="M20 15.5a2 2 0 0 1-2 2H8.5L4 21V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
      <path d="M8 9h8M8 12.5h5" />
    </>
  ),
  // A clock turning back.
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" />
      <path d="M3.5 3.5v5h5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  // Bars of a chart.
  insights: (
    <>
      <path d="M5 20v-7M12 20V5M19 20v-10" />
      <path d="M3 20h18" />
    </>
  ),
};

export function TabIcon({ name, size = 18 }: { name: TabIconName; size?: number }) {
  return (
    <svg className="tab-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
