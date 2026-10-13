# Backstroke: Project Deliverables Tracker

Version-controlled project planning. Every timeline edit is staged, then committed with a reason. The full history is kept, so you can replay the plan, compare any two versions, and see why dates moved.

The design is in [projectplan.md](projectplan.md). This is the v0.1 MVP it describes.

## Run it

Requirements: Python 3.11+ and Node 20+.

```bash
# Backend (API on :8000; seeds an example project on first start)
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload

# Frontend (dev server on :5173, proxies /api to :8000)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

**Single-process mode:** after `npm run build`, the backend serves `frontend/dist`, so http://localhost:8000 runs the whole app.

| Setting | Default | Notes |
|---|---|---|
| `TRACKER_DB_URL` | `sqlite:///backend/tracker.db` | SQLite file |
| `TRACKER_SEED` | `1` | Seed the example project when the DB has no projects |

Reset the demo data with `cd backend && .venv/bin/python -m app.seed --reset`.

## Try the Appendix A scenario

1. Drag the right edge of **Data Mapping** 7 days later (9 Oct → 16 Oct).
2. Open **Changes**. It flags a dependency conflict and suggests moving Data Ready and UAT +7d. Click **Stage suggested moves**.
3. Double-click **Go-Live** and set its date to 6 Nov in its details card.
4. Click **Commit 4 changes…**, enter a reason, pick *Dependency*, and commit.
5. Press **←** to step back to the previous version (read-only, with ghost bars). Press **→** to return.
6. Click the **Baseline** chip to compare v1 with current, or press **▶** to play back the whole history.

## Layout

## Sign-in

Everyone signs in with an email and password. The first person to open a fresh install sets it up: their account is the **admin**, and they're added to People if they aren't listed yet. After that, only someone an admin has listed in **Settings → People** can register, using their name as listed there.

- **Admins** change Settings (people, groups, projects), see every project, make others admins, and **Reset** someone's sign-in (signing them out so they can register again, e.g. after a forgotten password). Removing someone from People removes their sign-in too.
- **Everyone else** sees only the projects their groups work on (others answer 404), and Settings read-only.
- Commits, meetings and register changes are recorded under the signed-in person; an `author` in a request is ignored.

Passwords are hashed with scrypt; a session is a random token in an HttpOnly, SameSite=Lax cookie (Secure over HTTPS), kept for 30 days, with only its SHA-256 stored. There's no email verification, password-reset email or rate limiting yet.

A **project** is a plan of swimlanes, its meetings and its register. People belong to the organisation, not to a project:

- **Left sidebar**: **Your projects** (the ones your groups work on); admins also get **Other projects**, folded away. **+** (admins) opens the new-project form in Settings. Your account and **Sign out** are at the bottom. **«** collapses the sidebar to project initials.
- **Settings** (bottom of the sidebar): **People** lists everyone once with their groups (and, read-only, the projects those put them on); **Projects** renames a project, describes it, and chooses the groups working on it. Everyone in those groups is a member: offered as an attendee and owner there, and shown the project in their sidebar.

Inside a project the top bar switches between two views, and Meetings lives beside the plan:

- **Plan**: the timeline, with a side panel whose icon tabs are **Changes** (staged edits and commit; a badge counts them), **Meetings** (a dot while one is in progress), **History** (commits, or compare two versions) and **Insights** (metrics and the surprise index). Hover an icon for its name. Hide the panel with **»** to give the timeline the full width.
- **Meetings** (in the Plan's side panel): the meeting list, or one meeting's participants (one line of names, click to mark absent), notes, picked-up items, pre-read and open actions. Opening a meeting widens the panel to at least 640px; widen it further and the meeting shows as three columns (pre-read | notes | participants). Clicking a bar mentions it in the notes.
- **Register**: actions, risks, issues and decisions as one table, filtered by type, owner (a person or a group) and text. Nothing is ever deleted: **Close…** asks why (an action is done or dropped; a risk mitigated, passed, accepted or happened; an issue resolved or accepted; a decision superseded by a newer one or withdrawn), and **Open only** hides what's closed. A risk that happened becomes an issue, either a new one carrying over its text, owner and deliverables or one already raised. Click an item's ref for its history: every edit, closure and reopening, with who, the meeting it happened in, and why. Write an issue in meeting notes as `!issue`.

Edit the plan from the timeline itself:

- **Right-click a bar** (or select it and press Shift+F10, or click its **⋯**) to rename it, mark it or a phase done, change its type or lane, manage phases and dependencies, or delete it. Right-clicking a phase offers that phase's actions.
- **Double-click a bar**, or press Enter, for its details card: dates, phases, dependencies, and a **History** tab showing why it is where it is. Drag the card's header to move it.
- **Right-click a lane** to add a deliverable or milestone on the day under the cursor, rename or reorder the lane, add another, or delete an empty one.
- **Link two bars:** select one and drag the dot at its end onto the bar that depends on it. Or use **Dependencies → Depends on… / Blocks…** in the menu and click the other bar. Esc cancels either.

## Phases

A bar can optionally be broken into ordered phases, such as a Jira ticket's Dev, Review and UAT. Bars without phases work exactly as before. The seeded **Checkout Revamp** project mixes both.

- **Add or remove:** right-click a bar and use **Phases → Break into Dev, Review, UAT**. The same menu renames, adds and removes phases, and the details card resizes them.
- **Gaps:** a phase starts the day after the previous one ends. Give it a later **Starts** date in the details card to leave a gap, for example while the team works on something else. Gaps show as a dotted stretch inside the bar.
- **Move a boundary:** drag the line between two phases. The next phase, or the gap if there is one, absorbs the change, so the end date holds. Hold **Shift** to push the later phases and the end date instead. Hold **Alt** to move only the next phase's start, opening a gap.
- **See them:** the arrow after a phased bar lists its phases on rows of their own. **Colour → Phase** in the top bar gives each phase one colour across all lanes, and greys out bars without phases.
- **Compare:** the thin strip under a bar shows the comparison version's phases. Compare lists each phase's change (for example *Dev +5d, gap before Review +2d*), and **Metrics → Where the time went** adds those changes up per phase since the baseline, with gaps totalled as *between phases*.

Phases are stored on the deliverable as lengths: `[{"name": "Dev", "days": 12}, {"name": "Review", "days": 3, "gap": 2}, {"name": "UAT"}]`. A phase starts the day after the previous one ends plus its optional `gap`, and the last runs to the end date. Moving a bar never changes its phases. Adding, editing or removing phases is an ordinary `phases` field event, so it is staged, committed with a reason and undone like any other edit.

Existing databases get the new projection column on startup. To see Checkout Revamp, reset the demo data.

## Progress

Plans say when work should finish; progress records when it did. Right-click a bar and use **Mark done** (today, yesterday, or pick a date), or use the details card. For a bar with phases, mark each phase done: phases finish in order, and the bar is done when its last phase is. **Reopen** undoes it (reopening a phase also reopens the ones after it). Milestones aren't marked done.

Status is worked out from the plan, the finish dates and today, and shown on the bar and in the top bar:

| Status | When |
|---|---|
| Not started | Today is before the start |
| In progress | Started, not done, end date not passed |
| **Behind** | A phase is past its end and not done, but the bar's end date is still ahead: an early warning |
| **Overdue** | The end date has passed and it isn't done (red hatch from the planned end to today) |
| Done | Finished; the check sits on the actual date, so a late finish stays visible |

Marking done doesn't move the plan. It's recorded straight away as its own commit (category *Progress*, automatic reason, no staging), so replaying history shows what was done at each version, judged as of that commit's date. Plan commits can't change finish dates, and editing phases keeps them. Progress isn't counted as churn or slip. **Metrics → Finishes vs plan** compares each finish with the plan at the moment it was marked done, and with the baseline.

## How it works

- **History is the source of truth.** A commit is an ordered list of field-level events (`create` / `update` / `delete`). The current plan is a projection of those events. Every historical version is rebuilt by replaying them.
- **One write path.** `POST /api/projects/{id}/commits` validates the whole change set on the server, computes old values itself, checks `base_version` (stale clients get `409 VERSION_CONFLICT`), then appends the commit and its events and updates the projection, all in one transaction.
- **Append-only.** SQLite triggers reject `UPDATE`/`DELETE` on `commits` and `events`. Undo creates a new compensating commit.
- **Preview before commit.** `POST /api/projects/{id}/preview` runs the same validation as a dry run. It returns errors, finish-to-start conflicts, and suggested downstream moves. The UI calls it every time the staged set changes.
- **Staging is local.** Staged changes live in the browser, and are kept in localStorage per project, until committed.

```
backend/app/
  domain/     events.py (pure apply/replay), commands.py (change set → events), validators.py, models.py
  services/   commit, projection, version, history, diff, dependency, metrics, project
  api/        routes.py
frontend/src/
  timeline/   model.ts (renderer-independent layout), TimelineCanvas.tsx (SVG)
  state/      staging.ts (staged-change model), useProject.ts, dates.ts
  timeline/   menus.ts (right-click menus for bars, phases and lanes)
  components/ ContextMenu, DetailsCard, DeliverableDetails, StagedChangesDrawer, CommitDialog,
              MeetingsView (list and one meeting, in the side panel), RegisterView, PeopleView
  history/    HistoryPanel, PlaybackControls, ComparePanel, MetricsPanel
```

## API

| Method / endpoint | Purpose |
|---|---|
| `GET /api/projects` · `POST /api/projects` | List or create projects |
| `GET /api/projects/{id}/state` | Current projection |
| `GET /api/projects/{id}/versions/{seq}` | State reconstructed at a commit |
| `GET /api/projects/{id}/commits[?include_events=true]` | History |
| `GET /api/projects/{id}/commits/{seq}` | Commit detail and events |
| `POST /api/projects/{id}/preview` | Dry-run a change set |
| `POST /api/projects/{id}/commits` | Commit a change set |
| `POST /api/projects/{id}/progress` | Mark a deliverable or phase done, or reopen it |
| `POST /api/projects/{id}/commits/{seq}/revert` | Undo as a compensating commit |
| `GET /api/projects/{id}/diff?from=&to=` | Field-level diff of two versions |
| `GET/POST /api/projects/{id}/baselines` | Named pointers to commits |
| `GET /api/projects/{id}/metrics[?baseline=]` | Churn, net movement, recovery, reason attribution, propagation |
| `GET /api/auth/me`, `POST /api/auth/register`, `/login`, `/logout` | Sign-in; register and login set the session cookie. Every other route needs it (401 without) |
| `GET /api/auth/accounts`, `PATCH`/`DELETE /api/auth/accounts/{id}` | Admins: list sign-ins, grant or take admin, reset one |
| `GET/PUT /api/people` | Everyone in the organisation (`{people: [{name, groups, projects}], groups, projects_by_group}`), saved whole; `projects` is derived from groups; leave out `projects_by_group` and each group keeps its projects |
| `GET /api/projects/{id}/people` | The project's members and the groups they're in (`{people: [{name, groups}], groups}`) |
| `PUT /api/projects/{id}/groups` | Set the groups working on a project (`{groups: [...]}`); their people are its members |
| `PATCH /api/projects/{id}` | Rename or re-describe a project |
| `GET/POST /api/projects/{id}/register`, `PATCH .../register/{item}` | Register items; closing takes an `outcome`, and every change is kept |
| `GET /api/projects/{id}/register/{item}/history` | One item's history, oldest first |
| `GET /api/projects/{id}/export` | Full history as JSON |

Interactive docs are at http://localhost:8000/docs.

## Tests

```bash
cd backend && .venv/bin/python -m pytest       # replay = projection, atomicity, conflicts, undo, Appendix A, diff, metrics
cd frontend && npm test                         # staging model
```

## Not in v0.1

- Alembic migrations (the schema is created on startup)
- Importing from an export
- Scenario branches
- Dependency types other than finish-to-start
- Dragging a bar to another lane (right-click it and use **Move to lane**)
- Authentication (the author is a free-text name)
