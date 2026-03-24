# Session and Run API v1

- Status: draft stable runtime contract
- Last updated: 2026-03-23
- Parent architecture: `docs/specs/fullmag-application-architecture-v2.md`

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
- event stream semantics,
- browser/runtime ownership boundaries.

This spec does not define:

- Python authoring semantics,
- `ProblemIR`,
- backend-native ABI,
- artifact container schemas,
- detailed `.zarr`, `.h5`, or OVF layouts.

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

## 9. Event stream contract

The event stream is the live runtime channel for one session.

### 9.1 Transport

SSE is the baseline transport.
WebSocket may be added later, but the semantic event model should remain the same.

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
- current field and scalar access may be backed by bootstrap JSON/CSV,
- long-term sampled scientific data still targets `.zarr` and `.h5`,
- session semantics must remain valid when remote execution is added later.
