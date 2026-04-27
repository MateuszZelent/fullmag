# Session and Run API v1

- Status: frozen for canonicalization program (boundary scope)
- Last updated: 2026-04-23
- Parent architecture: `docs/specs/fullmag-application-architecture-v2.md`
- Program plan: `docs/plans/active/fullmag-canonicalization-backbone-program-2026-04-23.md`
- Program ADR: `docs/adr/0012-canonicalization-backbone.md`
- Browser API note: public `/v1/live/current/*` has been removed; current
  browser resources live under `/v2/platform/...` and `/v2/sessions/current/...`.

## 1. Purpose

This document defines the canonical runtime contract between:

- the Rust host launcher,
- the control plane,
- the browser control room,
- local and future remote execution modes.

It exists to prevent the session model from being described only inside plans.

## 2. Scope

This spec covers:

- session identity and lifecycle,
- run identity and relationship to sessions,
- session and run endpoints,
- the relationship between session/run semantics and the local v2 control-room API,
- event stream semantics,
- browser/runtime ownership boundaries.

This spec does not define:

- Python authoring semantics,
- `ProblemIR`,
- backend-native ABI,
- artifact container schemas,
- detailed `.zarr`, `.h5`, or OVF layouts.

The concrete local resource-first browser contract is specified in:

- `docs/specs/resource-first-control-room-api-v2.md`

The v1 files remain historical compatibility references for removed public
`/v1/live/current/*` routes:

- `docs/specs/resource-first-control-room-api-v1.md`
- `docs/specs/control-room-api-endpoint-reference-v1.md`
- `docs/specs/control-room-api-tree-v1.md`

Cluster-specific scheduler/runtime semantics are expanded in:

- `docs/specs/hpc-cluster-execution-v1.md`

## 3. Core runtime model

### 3.1 Session

A **session** is the top-level runtime execution context.

A session owns:

- launcher context,
- normalized problem summary,
- plan summary,
- lifecycle state,
- diagnostics,
- logs,
- event stream,
- artifact index,
- cancellation state.

Every local invocation of:

```text
fullmag script.py
```

creates exactly one session.

Future remote execution must preserve the same session semantics.

### 3.2 Run

A **run** is the execution payload associated with a session.

A run owns:

- resolved backend,
- execution mode,
- execution precision,
- scalar traces,
- field frames,
- artifact set,
- provenance bundle,
- completion or failure result.

In v1, one session owns one run.
Future multi-run studies may expand this, but the browser contract should still be session-first.

## 4. Canonical identifiers

- `session_id`
  - unique identifier for the runtime session
- `run_id`
  - unique identifier for the execution payload within the session

Rules:

- IDs must be stable for the lifetime of the session/run.
- Every event emitted for a run must carry the owning `session_id`.
- Browser routes should be session-oriented first and may derive the run identity from session data.
- Remote execution must preserve identifier stability even when scheduler job ids or staging paths
  change underneath the session.

## 5. Session lifecycle

The canonical session states are:

- `starting`
- `loading_script`
- `validating`
- `planning`
- `running`
- `completed`
- `failed`
- `cancelled`

Remote-capable deployments may extend this with intermediate states such as:

- `staging_input`
- `submitting`
- `queued`
- `allocating`
- `staging_runtime`
- `running_remote`
- `staging_output`

Rules:

- A session may fail before entering `running`.
- `completed`, `failed`, and `cancelled` are terminal.
- Validation or planning failure still produces a real session record with diagnostics.
- Ad hoc lifecycle tokens are forbidden on frozen boundaries; new public lifecycle states
  require a typed-contract update and owner approval.

## 6. Session resource contract

The session resource must expose, at minimum:

- `session_id`
- `run_id`
- `status`
- `created_at`
- `updated_at`
- `problem_name`
- `script_path` when available
- `requested_backend`
- `resolved_backend` when known
- `execution_mode`
- `execution_precision`
- `problem_summary`
- `plan_summary`
- `diagnostics`
- `latest_artifacts`
- `cancel_allowed`

Remote-capable session resources should additionally expose, when relevant:

- `target_id`
- `scheduler`
- `scheduler_job_id`
- `remote_workdir`
- `runtime_image_id`

The exact JSON envelope may evolve, but these concepts are the stable contract.

## 7. Run resource contract

The run resource must expose, at minimum:

- `run_id`
- `session_id`
- `status`
- `resolved_backend`
- `execution_mode`
- `execution_precision`
- `metadata`
- `scalars`
- `field access`
- `artifact index`
- `provenance`

The browser must treat run resources as control-plane products, not as direct filesystem views.

## 8. Endpoint families

### 8.1 Session endpoints

```text
GET    /v1/sessions
POST   /v1/sessions
GET    /v1/sessions/:id
GET    /v1/sessions/:id/events
POST   /v1/sessions/:id/cancel
```

Meaning:

- `GET /v1/sessions`
  - list known sessions with lightweight summaries
- `POST /v1/sessions`
  - create a new session from a script/launch request when the API is the creator
- `GET /v1/sessions/:id`
  - fetch the canonical session summary
- `GET /v1/sessions/:id/events`
  - subscribe to the session event stream
- `POST /v1/sessions/:id/cancel`
  - request cancellation

### 8.2 Run endpoints

```text
GET    /v1/runs/:id/summary
GET    /v1/runs/:id/metadata
GET    /v1/runs/:id/scalars
GET    /v1/runs/:id/fields/:name/latest
GET    /v1/runs/:id/fields/:name?step=N
GET    /v1/runs/:id/artifacts
GET    /v1/runs/:id/artifacts/:path
```

Meaning:

- `summary`
  - resolved execution summary for the run
- `metadata`
  - provenance and stable metadata
- `scalars`
  - scalar traces such as `time`, `step`, `solver_dt`, `E_ex`
- `fields`
  - on-demand access to field frames
- `artifacts`
  - artifact index and direct artifact access

### 8.3 Related but separate endpoint families

These are important to the application but are not part of the core session/run contract:

```text
POST   /v1/compile/script
POST   /v1/validate/script
POST   /v1/plan/script
GET    /v1/docs/physics
GET    /v1/docs/physics/:slug
```

### 8.4 Current local-live resource-first endpoints

For the current singleton control room, the canonical local API is the resource-first family:

```text
GET    /v1/live/current/status
GET    /v1/live/current/domain/*
GET    /v1/live/current/quantities/catalog
GET    /v1/live/current/fields/*
GET    /v1/live/current/scalars
GET    /v1/live/current/runs/current
GET    /v1/live/current/stages/execution
GET    /v1/live/current/solver/status
GET    /v1/live/current/solver/energies/current
GET    /v1/live/current/solver/energies/history
GET    /v1/live/current/authoring/scene
GET    /v1/live/current/authoring/study/runtime
GET    /v1/live/current/authoring/model/materials/:material_id
GET    /v1/live/current/authoring/physics/objects/:object_id/interactions/:interaction_kind
POST   /v1/live/current/authoring/transactions
GET    /v1/live/current/authoring/script/source
POST   /v1/live/current/assets/import
GET    /v1/live/current/display
PUT    /v1/live/current/display
PATCH  /v1/live/current/display
PATCH  /v1/live/current/authoring/study/runtime
PATCH  /v1/live/current/authoring/model/materials/:material_id
PATCH  /v1/live/current/authoring/physics/objects/:object_id/interactions/:interaction_kind
POST   /v1/live/current/authoring/script/sync
POST   /v1/live/current/commands
GET    /v1/live/current/commands/status
GET    /v1/live/current/commands/:command_id
GET    /v1/live/current/artifacts*
GET    /v1/live/current/eigen/*
GET    /v1/live/current/logs/engine
GET    /v1/live/current/gpu/telemetry
POST   /v1/live/current/session/*
GET    /v1/capabilities
GET    /v1/openapi.json
GET    /v1/docs/swagger
```

Rules:

- it is the archived v1 compatibility local browser contract,
- new control-room API work targets `docs/specs/resource-first-control-room-api-v2.md`,
- it is resource-first and revision-driven,
- it is subordinate to the broader session/run model, not contradictory to it,
- the field-complete historical v1 endpoint inventory lives in
  `docs/specs/control-room-api-endpoint-reference-v1.md`.

## 9. Event stream contract

The event stream is the live runtime channel for one session.

### 9.1 Transport

SSE and WebSocket are both acceptable transports.
The semantic event model remains canonical even when a concrete deployment chooses one transport for
historical session/run streams and another for local current-live UX.

### 9.2 Required event fields

Every event must carry:

- `kind`
- `session_id`
- `run_id`
- `sequence`
- `timestamp`

### 9.3 Event kinds

Required event kinds:

- `session_state_changed`
- `plan_ready`
- `log_line`
- `step_stats`
- `snapshot_available`
- `artifact_written`
- `run_completed`
- `run_failed`

### 9.4 Streaming rule

Heavy field payloads must not be pushed through the event stream by default.

The stream carries:

- lifecycle updates,
- diagnostics,
- scalar step stats,
- log lines,
- snapshot availability notices,
- artifact availability notices.

Field data is fetched on demand through run endpoints.

### 9.5 Local current-live projection

Local interactive control-room deployments use a singleton resource-first projection such as:

```text
GET    /v1/live/current/status
GET    /v1/live/current/domain/*
GET    /v1/live/current/quantities/catalog
GET    /v1/live/current/fields/*
GET    /v1/live/current/scalars
GET    /v1/live/current/runs/current
GET    /v1/live/current/stages/execution
GET    /v1/live/current/solver/status
GET    /v1/live/current/solver/energies/current
GET    /v1/live/current/solver/energies/history
GET    /v1/live/current/authoring/scene
GET    /v1/live/current/authoring/study/runtime
GET    /v1/live/current/authoring/model/materials/:material_id
GET    /v1/live/current/authoring/physics/objects/:object_id/interactions/:interaction_kind
POST   /v1/live/current/authoring/transactions
GET    /v1/live/current/authoring/script/source
GET    /v1/live/current/display
PATCH  /v1/live/current/display
PATCH  /v1/live/current/authoring/study/runtime
PATCH  /v1/live/current/authoring/model/materials/:material_id
PATCH  /v1/live/current/authoring/physics/objects/:object_id/interactions/:interaction_kind
POST   /v1/live/current/authoring/script/sync
POST   /v1/live/current/commands
GET    /v1/live/current/commands/status
GET    /v1/live/current/commands/:command_id
PUT    /v1/live/current/display
GET    /v1/live/current/artifacts*
GET    /v1/live/current/logs/engine
GET    /v1/live/current/gpu/telemetry
POST   /v1/live/current/session/*
GET    /v1/live/current/ws
```

`POST /v1/live/current/commands` accepts only the structured discriminated
`kind` union request body documented in
`docs/specs/control-room-api-endpoint-reference-v1.md`.

Rules for this projection:

- it is a convenience view over the active local workspace, not a replacement for the canonical
  session/run resource model,
- the browser consumes thin status plus on-demand resources instead of one monolithic bootstrap
  blob,
- singleton local-live deployments may expose derived runtime read-models such as
  `runs/current`, `stages/execution`, `solver/status`, and `solver/energies/*` when the host can
  derive them honestly from the active workspace snapshot,
- singleton local-live deployments may also expose canonical authoring surfaces such as
  `authoring/scene`, `authoring/study/runtime`,
  `authoring/model/materials/:material_id`,
  `authoring/physics/objects/:object_id/interactions/:interaction_kind`, and
  `authoring/script/*` for the active workspace,
- `GET /v1/live/current/ws` is the canonical realtime notification bus for this singleton
  projection,
- heavy data still remains resource-fetched by default,
- the browser must not require URL-level `?session=` routing for this singleton local-live flow.

## 10. Browser contract

The browser:

- consumes session and run resources,
- consumes session events,
- fetches field frames on demand,
- renders planner diagnostics and provenance authored by the control plane.

The browser must not:

- parse Python to infer problem semantics,
- invent capability decisions,
- infer backend truth from artifact filenames alone,
- become the source of physics meaning.

## 11. Artifact access rule

Artifacts remain backend-owned and runner-authored, but session/run API is the browser-facing
contract.

This means:

- the browser should prefer session/run endpoints over ad hoc filesystem reads,
- direct artifact browsing is still allowed through `/v1/runs/:id/artifacts/*`,
- artifact transport details may evolve from bootstrap JSON/CSV to `.zarr` / `.h5` without changing
  the session/run model.

## 12. v1 assumptions

This spec assumes:

- one session maps to one run,
- local CLI execution is the first concrete deployment mode,
- current local control-room transport is thin JSON status plus on-demand resource fetching,
- long-term sampled scientific data still targets `.zarr` and `.h5`,
- session semantics must remain valid when remote execution is added later.
