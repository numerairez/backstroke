import type { Account, Project } from "../types";

interface Props {
  projects: Project[];
  projectId: string | null;
  /** Settings is open, so no project is highlighted. */
  inSettings: boolean;
  /** Who is signed in. Admins see every project, with the ones they're not on under Other projects. */
  account: Account;
  collapsed: boolean;
  othersOpen: boolean;
  onToggleCollapsed: () => void;
  onToggleOthers: () => void;
  onOpen: (projectId: string) => void;
  onNewProject: () => void;
  onSettings: () => void;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : (words[0]?.[1] ?? ""))).toUpperCase();
}

function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className="nav-brand">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="3" y="7" width="18" height="6" rx="2" fill="var(--accent)" />
        <rect x="11" y="19" width="18" height="6" rx="2" fill="var(--accent-soft)" />
      </svg>
      {!compact && <span>Backstroke</span>}
    </div>
  );
}

/** The left sidebar: the projects you're on, then everything else, and Settings. */
export function ProjectNav(props: Props) {
  const { account } = props;
  // The server only lists projects you're on, unless you're an admin.
  const mine = props.projects.filter((p) => p.members.includes(account.name));
  const others = props.projects.filter((p) => !mine.includes(p));
  const newButton = account.is_admin && (
    <button className="icon small" title="New project" aria-label="New project" onClick={props.onNewProject}>
      +
    </button>
  );

  const item = (p: Project) => {
    const current = !props.inSettings && p.id === props.projectId;
    return (
      <li key={p.id}>
        <button className={`nav-project ${current ? "active" : ""}`} aria-current={current ? "page" : undefined} title={p.description || p.name} onClick={() => props.onOpen(p.id)}>
          <span className="nav-initials" aria-hidden="true">
            {initials(p.name)}
          </span>
          {!props.collapsed && <span className="nav-project-name">{p.name}</span>}
        </button>
      </li>
    );
  };

  if (props.collapsed) {
    return (
      <nav className="project-nav collapsed" aria-label="Projects">
        <button className="nav-expand" title="Show project list" aria-label="Show project list" onClick={props.onToggleCollapsed}>
          <Brand compact />
        </button>
        <ul className="nav-projects">{[...mine, ...others].map(item)}</ul>
        <span className="spacer" />
        {account.is_admin && (
          <button className="icon nav-icon" title="New project" aria-label="New project" onClick={props.onNewProject}>
            +
          </button>
        )}
        <button className={`icon nav-icon ${props.inSettings ? "active" : ""}`} title="Settings" aria-label="Settings" onClick={props.onSettings}>
          <GearIcon />
        </button>
      </nav>
    );
  }

  return (
    <nav className="project-nav" aria-label="Projects">
      <div className="nav-head">
        <Brand />
        <span className="spacer" />
        <button className="icon" title="Collapse the sidebar" aria-label="Collapse the sidebar" onClick={props.onToggleCollapsed}>
          «
        </button>
      </div>

      <div className="nav-section">
        <div className="nav-label">
          <span>Your projects</span>
          {newButton}
        </div>
        {mine.length ? (
          <ul className="nav-projects">{mine.map(item)}</ul>
        ) : (
          <p className="muted small nav-empty">
            {account.is_admin ? "None of your groups is on a project yet. Projects take groups in Settings." : "None of your groups is on a project yet. Ask an admin to add one."}
          </p>
        )}
      </div>

      {others.length > 0 && (
        <div className="nav-section">
          <button
            className="nav-label nav-toggle"
            aria-expanded={props.othersOpen}
            title="Projects none of your groups work on. You see them because you're an admin."
            onClick={props.onToggleOthers}
          >
            <span>
              <span className="nav-caret" aria-hidden="true">
                {props.othersOpen ? "▾" : "▸"}
              </span>
              Other projects <span className="muted">{others.length}</span>
            </span>
          </button>
          {props.othersOpen && <ul className="nav-projects">{others.map(item)}</ul>}
        </div>
      )}

      <span className="spacer" />

      <div className="nav-foot">
        <button className={`nav-settings ${props.inSettings ? "active" : ""}`} aria-current={props.inSettings ? "page" : undefined} onClick={props.onSettings}>
          <GearIcon />
          Settings
        </button>
      </div>
    </nav>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
