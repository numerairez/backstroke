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
3. Select **Go-Live** and set its date to 6 Nov.
4. Click **Commit 4 changes…**, enter a reason, pick *Dependency*, and commit.
5. Press **←** to step back to the previous version (read-only, with ghost bars). Press **→** to return.
6. Click the **Baseline** chip to compare v1 with current, or press **▶** to play back the whole history.

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
  components/ InspectorPanel, StagedChangesDrawer, CommitDialog
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
| `POST /api/projects/{id}/commits/{seq}/revert` | Undo as a compensating commit |
| `GET /api/projects/{id}/diff?from=&to=` | Field-level diff of two versions |
| `GET/POST /api/projects/{id}/baselines` | Named pointers to commits |
| `GET /api/projects/{id}/metrics[?baseline=]` | Churn, net movement, recovery, reason attribution, propagation |
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
- Dragging a bar to another lane (change the lane in the Inspector)
- Authentication (the author is a free-text name)
