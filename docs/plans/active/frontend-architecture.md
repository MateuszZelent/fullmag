# Fullmag Frontend Architecture Plan

- Status: active
- Parent target architecture: `docs/specs/fullmag-application-architecture-v2.md`
- Role: subordinate implementation plan for the run-first control room

## 1. Purpose

This document plans the frontend as part of one application model:

- Python is the only authoring surface,
- Rust is the runtime owner,
- `session` is the runtime spine,
- the browser is the live and historical control room.

The frontend must not define a second architecture.

## 2. Target workflow

The product workflow is:

```text
fullmag script.py
```

Target execution ownership:

1. Rust host binary receives the CLI request.
2. Rust spawns a Python helper in the active user environment.
3. The Python helper loads the script and returns canonical `ProblemIR`.
4. Rust validates and plans.
5. Rust creates a session.
6. Rust starts execution and the local API.
7. Rust opens the browser to `/runs/<session_id>`.
8. The browser watches the run through session and run endpoints.

The browser is not only a post-run dashboard.
It is the normal live observability surface for local runs.

## 3. Non-negotiable rules

1. The browser never interprets physics.
2. The browser never parses Python for semantic truth.
3. Problem summary, capability status, and planner diagnostics come from Rust/API.
4. The first real screen is `/runs/[id]`, not an editor.
5. The same session model must work for local and future remote runs.
6. Current JSON/CSV artifacts are bootstrap compatibility only; the long-term contract remains
   `.zarr` and `.h5`.
7. OVF interoperability is a snapshot/export concern, not the native frontend storage contract.

## 4. Current repo reality

Current code is still earlier than the target product shell:

- `apps/web` is still mostly a bootstrap shell,
- `apps/web` now includes `/runs/[id]` as the first target route,
- `fullmag-api` now exposes bootstrap session/run endpoints,
- the Rust host and Python helper path now exist in code,
- there is still no live browser-opened local session loop yet,
- the executable solver slice is still narrow:
  - `Box`
  - one ferromagnet
  - `Exchange`
  - `LLG(heun)`
  - `fdm/strict`
  - CPU reference runner

Bootstrap artifacts already available:

- `metadata.json`
- `scalars.csv`
- `m_initial.json`
- `m_final.json`
- `fields/m/*.json`
- `fields/H_ex/*.json`

That is enough to build the first honest control-room slice, but not enough to pretend
the full application shell already exists.

## 5. Frontend responsibilities

The frontend is responsible for:

- session status presentation,
- planner diagnostics display,
- scalar charts,
- field visualization,
- logs,
- provenance panels,
- artifact browsing,
- rendering `docs/physics/`.

The frontend is not responsible for:

- script loading,
- Python execution,
- `ProblemIR` construction,
- capability decisions,
- backend selection,
- artifact semantics.

## 6. Canonical frontend topology

```text
Rust host: fullmag script.py
    |
    +--> spawn Python helper -> ProblemIR
    |
    +--> validation + planning
    |
    +--> session manager
    |      |
    |      +--> runner task
    |      +--> logs
    |      +--> step stats
    |      +--> snapshot availability
    |      +--> artifact index
    |
    +--> local API
    |      |
    |      +--> /v1/sessions/*
    |      +--> /v1/runs/*
    |      +--> /v1/docs/physics/*
    |
    +--> browser opener
           |
           +--> Next.js /runs/[id]
```

## 7. Minimum API contract the frontend depends on

### Session endpoints

```text
GET    /v1/sessions
POST   /v1/sessions
GET    /v1/sessions/:id
GET    /v1/sessions/:id/events
POST   /v1/sessions/:id/cancel
```

### Run endpoints

```text
GET    /v1/runs/:id/summary
GET    /v1/runs/:id/metadata
GET    /v1/runs/:id/scalars
GET    /v1/runs/:id/fields/:name/latest
GET    /v1/runs/:id/fields/:name?step=N
GET    /v1/runs/:id/artifacts
GET    /v1/runs/:id/artifacts/:path
```

### Docs endpoints

```text
GET    /v1/docs/physics
GET    /v1/docs/physics/:slug
```

### Event stream contract

The event stream is metadata-only.
Heavy field payloads are fetched on demand.

Required event families:

- `session_state_changed`
- `plan_ready`
- `log_line`
- `step_stats`
- `snapshot_available`
- `artifact_written`
- `run_completed`
- `run_failed`

## 8. First real frontend slice

The first meaningful frontend milestone is:

```text
/runs/[id]
```

Phase-1 run page contents:

- session status
- backend, mode, and precision badges
- normalized problem summary
- planner diagnostics
- live or historical `E_ex(t)` chart
- latest `m` snapshot view
- latest `H_ex` snapshot selector
- logs
- artifact browser
- provenance panel

The landing page remains secondary.
The browser editor remains later.

## 9. Data adapter rule

The UI must use a normalized view model, but artifact schema is backend-owned.

That means the frontend must have an explicit adapter layer:

```text
runner artifacts -> frontend view model
```

Short-term inputs:

- bootstrap JSON field files
- bootstrap CSV scalar files

Long-term inputs:

- `.zarr`
- `.h5`

The frontend must not treat its internal view model as the canonical artifact schema.

## 10. Implementation phases

### Phase A0 - contract freeze

Deliver:

- written session/run API contract,
- event stream contract,
- artifact-to-view-model adapter contract,
- route contract for `/runs/[id]`.

Do not build feature UI before this is frozen.

### Phase A1 - historical run page

Deliver:

- `/runs/[id]` route,
- artifact-backed rendering of completed runs,
- scalar chart from current `scalars.csv`,
- field viewer backed by current JSON field snapshots,
- logs and provenance panels.

This phase may use polling or static fetches first.

### Phase A2 - live local session page

Deliver:

- Rust-created session ids,
- session event stream,
- browser auto-open from `fullmag script.py`,
- live updates for status, logs, scalar chart, and snapshot availability.

### Phase A3 - docs integration

Deliver:

- physics docs route,
- navigation from runs to relevant physics notes,
- stable rendering of `docs/physics/`.

### Phase A4 - richer shell

Deliver later:

- editor workflow,
- multi-run compare views,
- remote session views,
- richer 3D viewers,
- tetrahedral viewers after FEM runtime/artifact contracts are real.

## 11. Out of scope for this plan

Do not mix these into the frontend effort:

- new physics terms,
- CUDA kernel work,
- FEM execution,
- backend capability decisions in the browser,
- notebook UX redesign,
- multi-GPU monitoring,
- remote scheduling stack.

## 12. Acceptance criteria

This plan is fulfilled when:

1. `/runs/[id]` is the first real product screen,
2. the page is driven by session/run API data,
3. the browser never infers physics semantics on its own,
4. the local workflow `fullmag script.py` opens a live run page through the Rust-owned session
   model,
5. completed runs can still be viewed without a live stream,
6. the plan remains honest about current bootstrap artifact formats versus target `.zarr` and `.h5`.
