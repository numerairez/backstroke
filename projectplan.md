# Project Deliverables Tracker

**Version-Controlled Planning with Swimlanes, Commits, Diffs, and Playback**

_Implementation Plan_

> **Core product idea**
>
> A lightweight project-planning application where every meaningful
> timeline edit is committed with a reason. The system preserves the full
> evolution of the plan so users can compare versions, replay changes, and
> understand why dates moved.

**Stack:** Python backend · React/TypeScript UI · SQLite first · Event-sourced history

# 1. Executive Summary

The application will be a lightweight, visual project tracker centered
on a swimlane timeline. Its distinguishing behavior is that project-plan
edits are not silent mutations: each meaningful edit must be grouped
into a commit that records what changed, who changed it, when it
changed, and why.

> **Architectural invariant**
>
> The event/commit history is the source of truth. The visible project
> plan is a projection reconstructed from that history. The frontend must
> never directly overwrite deliverable state.

## 1.1 Product goals

- Make project timelines easy to understand and edit through a
  swimlane/Gantt-like interface.

- Require a human-readable reason for meaningful changes, similar to a
  Git commit message.

- Preserve every historical version of the plan without maintaining
  manual copies.

- Allow users to replay plan evolution and compare any two versions.

- Make downstream schedule effects and dependency-driven changes
  visible.

- Remain lightweight enough for an internal team: minimal
  infrastructure, simple deployment, low operational overhead.

## 1.2 Non-goals for the first release

- Replacing enterprise portfolio-management systems.

- Full resource-capacity planning, budgeting, timesheets, or cost
  accounting.

- Complex Jira/Azure DevOps synchronization.

- AI-generated planning decisions. AI can be added later for narration
  and summarization, but not as the source of project facts.

# 2. Product Principles

| **Principle**            | **Implementation consequence**                                                                      |
|--------------------------|-----------------------------------------------------------------------------------------------------|
| History first            | Every mutation belongs to a commit; audit history is append-only.                                   |
| Explain change           | A commit reason is mandatory for timeline-affecting edits.                                          |
| Current state is derived | The latest timeline is a projection, not the authoritative record.                                  |
| Visual before verbose    | The swimlane is the primary workspace; history/diff panels support it.                              |
| Batch related edits      | Multiple related changes can be staged and committed together.                                      |
| Deterministic facts      | Dates, diffs, dependency impacts, and metrics are computed from data; narration can be added later. |
| Low friction             | Routine edits should take seconds: drag, review staged changes, enter reason, commit.               |

# 3. Core User Experience

## 3.1 Main workspace

```text
┌──────────────────────────────────────────────────────────────────────┐

│ Project: Example Program Baseline: v1.0 Current: v1.17 │

├──────────────┬───────────────────────────────────────────────────────┤

│ Workstream │ Sep Oct Nov │

├──────────────┼───────────────────────────────────────────────────────┤

│ Data │ █████ Data Model │

│ │ █████ Mapping ◆ Data Ready │

│ AI │ █████████ Agent Build │

│ UI │ █████ Prototype █████ Prod UI │

│ Testing │ █████ UAT │

├──────────────┴───────────────────────────────────────────────────────┤

│ History: ◀ Commit 7 / 17 ▶ Compare Playback │

└──────────────────────────────────────────────────────────────────────┘
```

The center panel is a horizontally scrollable timeline. Workstreams
appear as lanes; deliverables appear as bars; milestones appear as
markers. Dragging or resizing an item creates a staged change rather
than immediately writing the new value to the canonical project state.

## 3.2 Edit → stage → commit

**1.** User drags/resizes a deliverable or edits one of its
plan-relevant fields.

**2.** The UI places the change in a local/staged change set and shows
the before/after values.

**3.** The user can make additional related edits before committing.

**4.** The commit drawer requires a reason and optional reason
category/reference.

**5.** The backend validates the entire change set atomically.

**6.** A Commit record and one or more Event records are appended.

**7.** The current-state projection is updated and the UI refreshes.

> **Example commit**
>
> “Move UAT by seven days because data mapping completion moved to 16
> October.”
>
> Category: Dependency
>
> Changes: Data Mapping end +7d; UAT start/end +7d; Go-Live milestone
> +7d.

## 3.3 Playback and time travel

A history slider reconstructs the plan at any commit. In playback mode,
the application advances commit by commit, animating affected items and
showing the corresponding reason, author, timestamp, and diff.

## 3.4 Compare mode

- Baseline vs current.

- Any commit vs current.

- Any two arbitrary commits.

- Optional ghost bars to overlay the earlier version behind the current
  plan.

- Summary of net movement by deliverable and milestone.

# 4. MVP Scope

| **Area**     | **MVP behavior**                                                    | **Deferred**                            |
|--------------|---------------------------------------------------------------------|-----------------------------------------|
| Projects     | Create/open one or more projects; project name, description, dates. | Portfolio hierarchy.                    |
| Workstreams  | Create, rename, reorder lanes.                                      | Cross-project shared lanes.             |
| Deliverables | Create/edit/delete task bars and milestones.                        | Resource assignments and cost.          |
| Timeline     | Drag, resize, horizontal zoom, today marker.                        | Advanced critical-path engine.          |
| Dependencies | Finish-to-start links; visual arrows; conflict warning.             | All dependency types and lag calendars. |
| Staging      | Collect pending edits before persistence.                           | Selective hunk-level staging.           |
| Commit       | Mandatory reason; optional category/reference.                      | Approval workflow.                      |
| History      | Chronological commit log with affected entities.                    | Branch merge visualization.             |
| Playback     | Move backward/forward through commit history.                       | Video export.                           |
| Diff         | Before/after values; baseline/current overlay.                      | Semantic AI explanation.                |
| Persistence  | SQLite database.                                                    | PostgreSQL multi-team scale.            |
| Users        | Simple local identity/configurable user name.                       | Enterprise SSO/RBAC in first release.   |

# 5. Functional Requirements

| **ID** | **Requirement**                                                                                   |
|--------|---------------------------------------------------------------------------------------------------|
| FR-01  | The system shall display deliverables grouped by workstream on a time-scaled swimlane.            |
| FR-02  | The system shall support drag and resize operations for planned start/end dates.                  |
| FR-03  | Timeline-affecting changes shall enter a staged state and shall not be persisted until committed. |
| FR-04  | A commit shall require a non-empty human-readable reason.                                         |
| FR-05  | A commit may contain multiple changes across multiple entities.                                   |
| FR-06  | The backend shall persist an immutable ordered history of commits and events.                     |
| FR-07  | The system shall reconstruct project state at any historical commit.                              |
| FR-08  | The system shall compare any two project versions and return field-level differences.             |
| FR-09  | The system shall support tagging a commit as a named baseline.                                    |
| FR-10  | The system shall display dependency conflicts before commit.                                      |
| FR-11  | The system shall record author and timestamp for each commit.                                     |
| FR-12  | The system shall support undo as a new compensating commit, not by deleting history.              |
| FR-13  | The system shall expose deterministic metrics derived from commit history.                        |

# 6. Data Model and Event-Sourcing Design

## 6.1 Core entities

| **Entity**  | **Purpose**                           | **Important fields**                                                          |
|-------------|---------------------------------------|-------------------------------------------------------------------------------|
| Project     | Top-level planning container.         | id, name, description, created_at                                             |
| Workstream  | Swimlane grouping.                    | id, project_id, name, order_index                                             |
| Deliverable | Logical task/milestone identity.      | id, project_id, workstream_id, type, name                                     |
| Dependency  | Relationship between deliverables.    | id, predecessor_id, successor_id, type                                        |
| Commit      | Human unit of project-plan change.    | id, project_id, seq_no, author, reason, category, timestamp                   |
| Event       | Atomic change inside a commit.        | id, commit_id, entity_type, entity_id, operation, field, old_value, new_value |
| Baseline    | Named pointer to a commit.            | id, project_id, name, commit_id                                               |
| Projection  | Current derived state for fast reads. | project_id + materialized workstream/deliverable state                        |

## 6.2 Event examples

```text
Commit #17

reason: "UAT moved because mapping delivery moved one week"

category: dependency



Events:

1. deliverable:DATA_MAPPING end_date 2026-10-09 → 2026-10-16

2. deliverable:UAT start_date 2026-10-12 → 2026-10-19

3. deliverable:UAT end_date 2026-10-16 → 2026-10-23

4. milestone:GO_LIVE date 2026-10-30 → 2026-11-06
```

## 6.3 State reconstruction

For a project version V, reconstruction starts from the initial state
(or an optional checkpoint/snapshot) and applies all events with commit
sequence ≤ V in order. For the MVP, the number of events will be small
enough that straightforward replay is acceptable. A materialized
current-state projection is maintained for responsive day-to-day reads.

> **Undo rule**
>
> Never erase or modify a historical commit. “Undo” generates a new commit
> whose events restore prior values. This preserves the audit
> narrative.

## 6.4 Recommended relational schema

```text
projects(id, name, description, created_at)

workstreams(id, project_id, name, order_index, created_commit_id)

deliverables(id, project_id, type, created_commit_id)

dependencies(id, project_id, created_commit_id)

commits(id, project_id, seq_no, author, reason, category, reference,
created_at)

events(id, commit_id, ordinal, entity_type, entity_id, operation,

field_name, old_value_json, new_value_json)

baselines(id, project_id, name, commit_id)



# Read-optimized projection tables

project_workstream_state(...)

project_deliverable_state(...)

project_dependency_state(...)
```

# 7. Application Architecture

```text
┌────────────────────────────── Browser
──────────────────────────────┐

│ React + TypeScript │

│ Timeline/Swimlane │ Staging Drawer │ History │ Diff │ Playback │

└───────────────────────────────┬───────────────────────────────────────┘

│ REST (JSON)

▼

┌──────────────────────────── FastAPI
─────────────────────────────────┐

│ Project API │ Commit API │ History API │ Diff API │ Playback API
│

├───────────────────────────────────────────────────────────────────────┤

│ Domain layer │

│ Command validation │ Event creation │ Dependency checks │

│ Projection builder │ Version reconstruction │ Metrics │

├───────────────────────────────────────────────────────────────────────┤

│ SQLAlchemy / SQLModel │

└───────────────────────────────┬───────────────────────────────────────┘

▼

SQLite database

(migrate to PostgreSQL if needed)
```

## 7.1 Backend modules

| **Module**         | **Responsibility**                                                 |
|--------------------|--------------------------------------------------------------------|
| project_service    | Project/workstream/deliverable identity and read models.           |
| commit_service     | Validate staged commands, create one atomic commit and its events. |
| projection_service | Apply events to current-state projection tables.                   |
| history_service    | Commit log, detail, filtering, affected entities.                  |
| version_service    | Reconstruct state at any commit or baseline.                       |
| diff_service       | Compute structural and field-level differences between versions.   |
| dependency_service | Validate dependency graph and detect schedule conflicts.           |
| metrics_service    | Schedule churn, movement, recovery, stability, reason attribution. |

## 7.2 Frontend modules

| **Component**       | **Responsibility**                                                  |
|---------------------|---------------------------------------------------------------------|
| TimelineCanvas      | Swimlanes, bars, milestones, dates, dependency arrows, zoom/scroll. |
| StagedChangesDrawer | List pending edits; remove/revert individual staged items.          |
| CommitDialog        | Reason, category, reference; commit all staged changes.             |
| HistoryPanel        | Chronological commits; click to inspect or time-travel.             |
| DiffOverlay         | Ghost earlier bars, movement labels, created/deleted indicators.    |
| PlaybackControls    | Previous/next/play/scrub through versions.                          |
| InspectorPanel      | Selected deliverable metadata and dependencies.                     |

# 8. API Contract

The most important API design rule is that plan mutations are committed
through a single command endpoint. A generic PATCH endpoint that
silently overwrites plan state should not exist for timeline-affecting
fields.

| **Method / endpoint**             | **Purpose**                                     |
|-----------------------------------|-------------------------------------------------|
| GET /projects/{id}/state          | Current materialized project state.             |
| GET /projects/{id}/versions/{seq} | Project state reconstructed at commit sequence. |
| GET /projects/{id}/commits        | Commit history.                                 |
| GET /projects/{id}/commits/{seq}  | Commit metadata and events.                     |
| POST /projects/{id}/commits       | Atomically validate and persist staged changes. |
| GET /projects/{id}/diff?from=&to= | Diff two versions.                              |
| POST /projects/{id}/baselines     | Create a named baseline pointing to a commit.   |
| GET /projects/{id}/metrics        | Derived planning-history metrics.               |

## 8.1 Commit request

```text
POST /projects/{project_id}/commits

{

"reason": "Move UAT because data mapping moved one week",

"category": "dependency",

"reference": "Meeting 2026-10-03",

"author": "user@example",

"changes": [

{

"entity_type": "deliverable",

"entity_id": "uat-01",

"operation": "update",

"fields": {

"start_date": "2026-10-19",

"end_date": "2026-10-23"

}

}

]

}
```

## 8.2 Commit transaction

**1.** Load the current projection and verify the client base version.

**2.** Validate entity existence, date rules, and dependency
constraints.

**3.** Compute old values server-side; do not trust old values supplied
by the browser.

**4.** Create the Commit row.

**5.** Create ordered Event rows.

**6.** Apply the events to projection tables.

**7.** Commit the database transaction.

**8.** Return the new version number, normalized events, and refreshed
affected entities.

# 9. Timeline Interaction Design

## 9.1 Timeline behaviors

- Bars represent deliverables with start/end dates; diamonds represent
  milestones.

- Drag bar = shift dates while preserving duration.

- Resize left/right edge = change start or end date.

- Click = open inspector; right-click/context action can add dependency,
  set milestone, or compare history.

- Every drag/resize remains visually marked as “uncommitted” until
  committed.

- A small badge shows the number of staged changes.

- Escape/revert action restores the item from the current persisted
  projection.

## 9.2 Visual language

| **State**                        | **Suggested treatment**                           |
|----------------------------------|---------------------------------------------------|
| Persisted current                | Solid bar.                                        |
| Staged/uncommitted               | Striped or outlined bar + small “pending” marker. |
| Earlier comparison version       | Low-opacity ghost bar behind current.             |
| Moved later                      | Arrow/label showing +N days.                      |
| Moved earlier                    | Arrow/label showing −N days.                      |
| Created after comparison version | “Added” badge.                                    |
| Deleted after comparison version | Ghost item with “Removed” badge.                  |
| Dependency conflict              | Warning icon and highlighted dependency arrow.    |

## 9.3 Dependency movement policy

For the MVP, moving a predecessor does not silently move successors. The
system calculates affected successors and asks the user whether to move
only the selected item or stage suggested downstream adjustments. Any
accepted set of movements is committed as one coherent change set.

# 10. History, Diff, and Playback

## 10.1 Commit history panel

```text
#17 03 Oct 14:31 Dependency

UAT moved because mapping delivery moved one week

4 changes • 3 deliverables affected



#16 01 Oct 10:12 Scope

Deferred export feature to Phase 2

3 changes • 2 deliverables affected
```

## 10.2 Version comparison

| **Diff type**   | **Example**                          |
|-----------------|--------------------------------------|
| Date movement   | UAT end: 16 Oct → 23 Oct (+7d)       |
| Duration change | Integration: 5d → 8d (+3d)           |
| Lane change     | Prototype: AI → UI                   |
| Creation        | Security Review added in v12         |
| Deletion        | Manual Reconciliation removed in v15 |
| Dependency      | Data Mapping → UAT dependency added  |

## 10.3 Playback implementation

**1.** Fetch ordered commit metadata for the project.

**2.** Maintain a selected version sequence in frontend state.

**3.** On scrub/next/previous, request or locally cache the
reconstructed version.

**4.** Compute the diff from the prior displayed version.

**5.** Animate only changed deliverables and show the commit explanation
alongside.

**6.** Playback mode is read-only; editing returns the user to the
current version.

# 11. Derived Metrics

The history model enables metrics that are difficult to produce when
systems overwrite dates. Metrics are deterministic and computed from
event history.

| **Metric**             | **Definition / intent**                                   |
|------------------------|-----------------------------------------------------------|
| Net milestone movement | Current date minus baseline date.                         |
| Gross schedule churn   | Sum of absolute date movements across commits.            |
| Change frequency       | Number of commits affecting a deliverable or workstream.  |
| Planning stability     | How long a planned date remains unchanged.                |
| Recovery               | Days regained after a previous delay.                     |
| Late-stage churn       | Schedule movement occurring close to planned delivery.    |
| Reason attribution     | Movement grouped by dependency/scope/resource/etc.        |
| Causal propagation     | Downstream movements associated with predecessor changes. |

> **Keep metrics descriptive**
>
> Metrics should explain plan behavior rather than automatically judge
> project teams. A high-change project may be appropriately adapting to
> new information.

# 12. Change-Reason Taxonomy

| **Code**   | **Category** | **Typical use**                                              |
|------------|--------------|--------------------------------------------------------------|
| dependency | Dependency   | Upstream deliverable, system, vendor, or prerequisite moved. |
| scope      | Scope        | Requirement added, removed, expanded, or deferred.           |
| resource   | Resource     | Availability or capacity changed.                            |
| estimate   | Estimate     | Team revised expected duration based on new evidence.        |
| priority   | Priority     | Sequence changed due to business prioritization.             |
| risk       | Risk         | Mitigation or control work inserted.                         |
| approval   | Approval     | Waiting for review, sign-off, or governance.                 |
| external   | External     | Regulatory, vendor, infrastructure, or other outside factor. |
| correction | Correction   | Previous plan entry was incorrect.                           |
| other      | Other        | Free-form explanation when no category applies.              |

# 13. Repository and Code Organization

```text
project-tracker/

├── backend/

│ ├── app/

│ │ ├── main.py

│ │ ├── api/

│ │ ├── domain/

│ │ │ ├── commands.py

│ │ │ ├── events.py

│ │ │ ├── validators.py

│ │ │ └── models.py

│ │ ├── services/

│ │ │ ├── commit_service.py

│ │ │ ├── projection_service.py

│ │ │ ├── version_service.py

│ │ │ ├── diff_service.py

│ │ │ └── metrics_service.py

│ │ ├── persistence/

│ │ └── tests/

│ └── pyproject.toml

├── frontend/

│ ├── src/

│ │ ├── components/

│ │ ├── timeline/

│ │ ├── history/

│ │ ├── api/

│ │ ├── state/

│ │ └── types/

│ └── package.json

├── migrations/

├── docs/

└── README.md
```

# 14. Implementation Phases

| **Phase**                        | **Deliverable**                                                                                                                           |
|----------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| Phase 0 — Foundation             | Create repository; FastAPI skeleton; React/TypeScript shell; SQLite; migration setup; shared IDs/date conventions; seed project.          |
| Phase 1 — Domain + commit engine | Implement Project, Workstream, Deliverable, Commit, Event, Baseline; commit transaction; projection builder; unit tests for event replay. |
| Phase 2 — Read-only swimlane     | Render workstreams, bars, milestones, timeline scale, horizontal navigation; load current projection via API.                             |
| Phase 3 — Editing + staging      | Drag/resizing; local staged-change model; revert; staged-change drawer; commit dialog; backend validation.                                |
| Phase 4 — History + time travel  | Commit history; version reconstruction; select historical version; read-only historical timeline.                                         |
| Phase 5 — Diff + baseline        | Named baselines; compare endpoint; ghost bars; movement labels; before/after detail.                                                      |
| Phase 6 — Dependencies           | Dependency CRUD through commits; arrows; conflict checking; suggested downstream movement.                                                |
| Phase 7 — Playback + metrics     | Animated step-through; change narration panel; schedule movement/churn/reason metrics.                                                    |
| Phase 8 — Hardening              | Concurrency/version checks; export/import; backup; accessibility; browser testing; deployment packaging.                                  |

# 15. First Build Sequence

The implementation should prove the event model before investing heavily
in the visual layer. The first vertical slice should be intentionally
small but complete.

**1.** Create a project with two workstreams and three deliverables
using seed data.

**2.** Implement POST /commits for a single deliverable date change.

**3.** Persist Commit + Event rows and update the current projection in
one transaction.

**4.** Implement GET current state and GET state at version N.

**5.** Write tests proving that replay produces the same state as the
materialized projection.

**6.** Build a simple read-only React swimlane from the current-state
endpoint.

**7.** Enable dragging one deliverable and keep the change staged
locally.

**8.** Add a commit drawer requiring a reason; submit the staged edit.

**9.** Add a two-button Previous/Next history control to reconstruct
prior/current versions.

**10.** Only after this vertical slice works, expand to multi-edit
commits, dependencies, diff overlays, and playback.

> **Definition of the first successful prototype**
>
> A user can drag one bar, enter a reason, commit it, move backward to the
> previous version, and move forward to see the bar return to its new
> date. No historical record is overwritten.

# 16. Testing Strategy

| **Layer**         | **Critical tests**                                                                                              |
|-------------------|-----------------------------------------------------------------------------------------------------------------|
| Domain unit tests | Date validation; event generation; dependency constraints; reason required; undo generates compensating events. |
| Replay tests      | Applying events from zero to N yields expected state; replay equals current projection.                         |
| Transaction tests | Commit + events + projection succeed or fail atomically.                                                        |
| API tests         | Optimistic version check; invalid entity; malformed date; history order; diff correctness.                      |
| Frontend tests    | Staging does not persist; cancel/revert restores; commit clears staging; historical mode is read-only.          |
| End-to-end        | Drag → stage → commit → history → previous version → current version → compare.                                 |

# 17. Concurrency and Data Integrity

Even a lightweight internal tool should prevent one user from committing
on top of an unseen newer version. Each commit request should include
the client’s base version. If the current server version differs, return
a conflict response and require refresh/reconciliation.

```text
Client edits version: 17

Server current version: 18



POST /commits { base_version: 17, ... }

→ HTTP 409 VERSION_CONFLICT

→ UI: "The project changed since you started editing. Review v18 before
committing."
```

# 18. Future Enhancements

| **Enhancement**          | **How it extends the core model**                                                       |
|--------------------------|-----------------------------------------------------------------------------------------|
| Scenario branches        | Create an alternate sequence of commits from a chosen baseline; compare with main plan. |
| Merge/adopt scenario     | Convert selected scenario differences into a main-plan commit.                          |
| AI project narrative     | Summarize deterministic commits and diffs into a human-readable project story.          |
| Meeting/email references | Attach links or IDs to commits to preserve decision evidence.                           |
| Jira/Azure integration   | Import execution status while preserving the plan-history model.                        |
| Comments/approvals       | Discussion or governance around proposed commits.                                       |
| Snapshots/checkpoints    | Persist reconstructed state periodically if event volume becomes large.                 |
| Enterprise identity      | SSO and role-based access when moving beyond a small team.                              |

# 19. Decisions Locked for v0.1

| **Decision**    | **Choice**                                                                                        |
|-----------------|---------------------------------------------------------------------------------------------------|
| Backend         | Python + FastAPI                                                                                  |
| Persistence     | SQLite + SQLAlchemy/SQLModel + migrations                                                         |
| Frontend        | React + TypeScript                                                                                |
| Visual approach | Custom SVG-based timeline preferred for flexibility; keep timeline model independent of renderer. |
| Mutation model  | Commit/event based; no direct plan-state PATCH for timeline fields.                               |
| History         | Append-only. Undo is a compensating commit.                                                       |
| Edit UX         | Stage locally, then commit one or more changes with a mandatory reason.                           |
| Historical view | Read-only reconstruction at any commit.                                                           |
| Baseline        | Named pointer to a commit.                                                                        |
| AI              | Not required for MVP; later used for narrative, never as source of facts.                         |

> **Implementation checkpoint**
>
> Do not proceed to advanced analytics or AI until the core invariant is
> demonstrated end-to-end: edit → stage → commit with reason → reconstruct
> previous version → replay forward.

# Appendix A — Example End-to-End Scenario

**1.** Baseline v1 has Data Mapping ending 9 Oct, UAT 12–16 Oct, and
Go-Live 30 Oct.

**2.** A dependency issue moves Data Mapping to 16 Oct.

**3.** The UI warns that UAT now overlaps its predecessor and offers a
suggested +7 day movement.

**4.** The user accepts the UAT movement and manually moves Go-Live by
+7 days.

**5.** Three staged changes appear in the drawer.

**6.** The user enters: “Data mapping completion moved one week after
source-system access delay.” Category: Dependency.

**7.** One commit is created containing all generated atomic events.

**8.** Current state becomes v2. Baseline v1 is unchanged.

**9.** Compare v1 → v2 shows three moved items and +7 day net Go-Live
movement.

**10.** Playback v1 → v2 animates the three changes and displays the
commit reason.

# Appendix B — Acceptance Criteria for MVP

| **ID** | **Acceptance criterion**                                                                         |
|--------|--------------------------------------------------------------------------------------------------|
| AC-01  | No timeline-affecting edit can be persisted without a commit reason.                             |
| AC-02  | One commit can atomically contain multiple changes.                                              |
| AC-03  | Historical commits cannot be edited or deleted through normal product flows.                     |
| AC-04  | Project state can be reconstructed at every commit sequence.                                     |
| AC-05  | Current projection and full event replay produce equivalent state.                               |
| AC-06  | A user can compare baseline and current versions visually and textually.                         |
| AC-07  | Playback shows commits in sequence with the associated reason and changed entities.              |
| AC-08  | A stale client commit is rejected with a version conflict.                                       |
| AC-09  | Undo produces a new visible commit.                                                              |
| AC-10  | The complete application can run locally with a Python backend, browser UI, and SQLite database. |
