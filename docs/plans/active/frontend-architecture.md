# Fullmag Frontend Architecture Plan

## North star

The primary frontend experience is a **live local control room** started from the CLI:

```text
$ fullmag script.py
```

This command should:

1. load the Python script,
2. build `ProblemIR`,
3. validate and plan it in Rust,
4. start the local run,
5. start a local API/web session,
6. open the browser automatically,
7. stream logs, scalar diagnostics, and field snapshots into the UI while the run is executing.

The web app is therefore not only a post-run dashboard. It is the live observability and interaction surface for local and later remote runs.

## Product rules

- **Python remains the only public scripting surface.** The browser must not become a second physics authoring language.
- **The frontend is a control room, not a physics interpreter.** Problem summaries, validation, and executable capability status must come from Rust/API, not browser-side parsing of Python source.
- **Live visualization is first-class.** The first meaningful frontend slice must support watching a running simulation, not only opening finished artifacts.
- **One session model for local and remote.** Local `fullmag script.py` and future cluster jobs should expose the same run/session concepts and as much of the same API as possible.
- **Physics docs stay canonical in `docs/physics/`.** The frontend renders them; it does not re-author them.

## Desired user experience

### Local run experience

```text
$ fullmag exchange_relax.py
```

Expected behavior:

- CLI prints a concise local session banner:
  - session id
  - local API URL
  - local web URL
  - selected backend/mode/precision
- Browser opens automatically to the run page.
- The page shows:
  - script metadata
  - normalized problem summary
  - execution mode and precision
  - step progress
  - live `E_ex(t)` chart
  - latest 3D magnetization view
  - artifacts and logs as they appear
- If the browser is closed, the run continues unless explicitly cancelled.
- If `--headless` is used, the run behaves like a pure CLI execution and still writes artifacts.

### Future remote experience

```text
$ fullmag submit script.py --target cluster-a
```

The browser should reuse the same session/run UI, only backed by a remote API instead of a local ephemeral server.

## Relationship to the rest of the architecture

This plan must stay compatible with the core repository rules:

- Python builds the declarative problem model.
- Rust validates, normalizes, plans, and runs.
- Native backends stay behind Rust/C ABI seams.
- The browser consumes session/run data produced by the control plane.

That means the frontend must never:

- infer solver semantics from Python AST,
- define its own capability matrix,
- guess field layout rules that differ from runner artifacts,
- invent backend status independent of the planner.

## Current repo reality

- `apps/web` is still a minimal Next.js scaffold.
- `fullmag-api` currently exposes only health/vision endpoints.
- The current executable solver slice is narrow:
  - `Box`
  - `Exchange`
  - `LLG(heun)`
  - `fdm/strict`
  - CPU reference runner
- The runner already writes enough artifacts to support an initial live/post-run FDM viewer:
  - `metadata.json`
  - `scalars.csv`
  - `m_initial.json`
  - `m_final.json`
  - `fields/m/*.json`
  - `fields/H_ex/*.json`

Because of that, the frontend should start with a **realistic live FDM control room** for the current executable subset, not with a speculative all-backend UI.

## Architectural model

## Control-room topology

```text
Python script
    |
    v
fullmag CLI
    |
    +--> Python loader -> ProblemIR
    |
    +--> Rust validation + planning
    |
    +--> Session manager
            |
            +--> Runner task
            |      |
            |      +--> step stats stream
            |      +--> log stream
            |      +--> field snapshot stream
            |      +--> artifact writer
            |
            +--> Local API server
            |      |
            |      +--> REST for metadata/artifacts
            |      +--> WebSocket or SSE for live updates
            |
            +--> Browser opener
                   |
                   +--> Next.js control room
```

## Session-oriented design

The frontend should be built around a **session** abstraction, not only static runs.

- A **session** is a live or historical execution context.
- A **run** is the execution payload inside that session.
- A session can be:
  - `starting`
  - `planning`
  - `running`
  - `completed`
  - `failed`
  - `cancelled`

For local CLI-driven execution, each `fullmag script.py` creates one local session.

## Browser responsibilities

The browser is responsible for:

- presenting run/session state,
- rendering fields and charts,
- showing logs and provenance,
- letting the user inspect artifacts,
- later initiating runs through API calls.

The browser is not responsible for:

- physics parsing,
- capability decisions,
- step integration,
- backend selection logic beyond displaying user-selected policy and backend results.

## API contract needed for the frontend

The current frontend plan only becomes real when the control plane exposes a minimal run/session API. The first coherent contract should look like this.

### Session endpoints

```text
GET    /v1/sessions
GET    /v1/sessions/:id
GET    /v1/sessions/:id/events
POST   /v1/sessions/:id/cancel
```

`/v1/sessions/:id/events` should be WebSocket or SSE and carry:

- lifecycle state changes,
- planner diagnostics,
- log lines,
- step stats,
- snapshot availability events.

### Run/artifact endpoints

```text
GET    /v1/runs/:id/metadata
GET    /v1/runs/:id/scalars
GET    /v1/runs/:id/fields/:observable/latest
GET    /v1/runs/:id/fields/:observable?step=N
GET    /v1/runs/:id/artifacts
GET    /v1/runs/:id/artifacts/:path
```

### Compile/summary endpoints

These are useful for the editor flow, but they must return backend-authored diagnostics:

```text
POST   /v1/compile/script
POST   /v1/validate/script
POST   /v1/plan/script
```

The frontend may display:

- normalized problem summary,
- validation errors,
- capability status,
- selected backend plan,

but it must receive these from Rust/API, not from browser-side Python analysis.

## Live data flow

## Minimum viable live flow

```text
fullmag script.py
   |
   +--> CLI starts local API and web bridge
   |
   +--> runner begins execution
   |
   +--> each step emits StepStats
   |
   +--> scheduled field snapshots are written and announced
   |
   +--> browser subscribes to session events
   |
   +--> browser updates chart, status, and latest 3D scene
```

## Streaming policy

Not every solver step should force a heavy field payload into the browser.

The control plane should separate:

- **high-frequency lightweight events**
  - status
  - progress
  - step number
  - time
  - `E_ex`
  - `max_dm_dt`
  - `max_h_eff`
- **lower-frequency heavy payloads**
  - field snapshots
  - mesh/geometry payloads
  - final artifacts

That implies two channels:

- event stream for session updates,
- pull endpoint for the actual snapshot payload referenced by event metadata.

## Snapshot policy for the first live viewer

For the initial FDM live control room:

- stream step stats continuously or at coarse cadence,
- expose latest available `m` snapshot,
- optionally expose latest `H_ex` snapshot,
- never push the full field at every time step by default.

The planner or runner should own sampling cadence. The frontend only consumes what is produced.

## Frontend data model

The frontend needs a **normalized view model**, but it must be explicitly adapted from backend artifacts rather than treated as the native artifact schema.

### Raw artifact reality today

Current field JSON contains:

- `observable`
- `unit`
- `step`
- `time`
- `solver_dt`
- `layout`
- `provenance`
- `values`

Current FDM layout contains:

- `backend`
- `grid_cells`
- `cell_size`

### Recommended frontend adapter layer

Keep a browser-side normalized type, but introduce it explicitly as an adapter product:

```typescript
interface FieldData {
  observable: string;
  unit: string;
  step: number;
  time: number;
  solverDt: number;
  precision: "single" | "double" | "unknown";
  layout: CartesianLayout | TetLayout;
  values: Float32Array | Float64Array;
  provenance: FieldProvenance;
}

interface CartesianLayout {
  type: "cartesian";
  cells: [number, number, number];
  cellSize: [number, number, number];
}

interface TetLayout {
  type: "tetrahedral";
  vertices: Float32Array | Float64Array;
  tetrahedra: Uint32Array;
  surfaceTriangles?: Uint32Array;
}
```

Important rule:

- artifact schema is backend-owned,
- `FieldData` is frontend-owned,
- the conversion between them lives in `lib/field-data.ts`.

That keeps the UI stable while allowing artifact evolution.

## Visualization design

## First viewer target: FDM live magnetization

The first meaningful viewer should support:

- 3D voxel-like magnetization rendering for the current FDM slice,
- arrow rendering on a decimated grid,
- XY/XZ/YZ slice heatmaps,
- scalar chart for `E_ex(t)`,
- timeline selection for saved snapshots,
- display of backend/mode/precision/provenance.

This is enough to support the first real user story:

```text
write Python script -> run fullmag script.py -> browser opens -> watch exchange relaxation live
```

## Second viewer target: historical run exploration

The same page should work after completion:

- session stream disconnects,
- page falls back to artifact-backed historical mode,
- user can scrub snapshots and inspect final state.

## Later viewer targets

Later phases may add:

- FEM tetrahedral rendering,
- FDM vs FEM comparison,
- cut-plane interaction,
- marching-cubes isosurface,
- topography mode,
- playback controls,
- diff maps,
- advanced overlays.

But these are intentionally not Phase 1 frontend blockers.

## Component architecture

```text
apps/web/
  app/
    page.tsx
    runs/
      [id]/page.tsx
    problems/
      [id]/page.tsx
    docs/
      physics/page.tsx
  components/
    session/
      SessionStatusCard.tsx
      LiveLogPanel.tsx
      RunSummaryCard.tsx
    viewer/
      FieldViewer.tsx
      CartesianRenderer.tsx
      SliceView.tsx
      ScalarChart.tsx
      ViewerControls.tsx
      ColorBar.tsx
    editor/
      ScriptEditor.tsx
      ProblemSummaryPanel.tsx
      PlannerDiagnosticsPanel.tsx
    artifacts/
      ArtifactBrowser.tsx
  lib/
    api.ts
    session-events.ts
    field-data.ts
    cartesian-utils.ts
    color-maps.ts
```

Notes:

- `TetRenderer.tsx` should exist only when FEM execution has a stable artifact/API contract.
- `ProblemSummaryPanel` must display server-produced normalized summaries.
- `PlannerDiagnosticsPanel` must display server-produced diagnostics.

## UX decisions

## Frontend entrypoints

There should be two main browser entrypoints:

### `Runs`

This is the primary surface.

- When a CLI-driven local run starts, the browser should open directly to `/runs/:id`.
- This page must work for both live and completed runs.

### `Problems`

This is secondary and later.

- It can host the Monaco editor and problem management UI.
- It must not be required for the core local UX.

This ordering matters because the user workflow starts in the terminal, not in the browser.

## Editor behavior

Monaco is still valid, but the editor should be treated as a later convenience layer.

- Users may already have their own editor.
- The core promise is not “write code in browser”.
- The core promise is “run Python locally and see the simulation live”.

Therefore:

- live run page comes before browser editing,
- compile/validate summary comes from backend,
- red squiggles require server diagnostics, not client inference.

## Local CLI integration

The CLI should eventually support:

```text
fullmag script.py
fullmag script.py --no-browser
fullmag script.py --headless
fullmag script.py --port 3210
fullmag script.py --open /runs/latest
```

Behavioral contract:

- default: open browser automatically,
- `--no-browser`: start local control room but do not open it,
- `--headless`: do not start UI server at all,
- `--port`: choose local web/API port,
- `--open`: override initial route.

This is more important than a separate `fullmag serve` command for the first user experience.

## Phased delivery

### Frontend Phase A0: control-plane contract

- Define local session model.
- Define REST + event-stream contract.
- Define artifact-to-view-model adapter contract.
- Define browser-open behavior for CLI runs.

Deliverable:

- written API/session contract
- no guesswork in the UI

### Frontend Phase A1: live FDM run page

- `/runs/[id]` page
- live status card
- live `E_ex(t)` chart
- latest `m` snapshot viewer for Cartesian FDM
- artifact browser
- docs/physics renderer route

Prerequisite:

- current CPU/FDM reference runner and artifact writer

### Frontend Phase A2: local launcher integration

- CLI starts local API server
- CLI opens browser automatically
- run page connects to live session stream
- completed runs remain browsable

### Frontend Phase B: editor and planning UX

- Monaco-based script editor
- template gallery
- compile/validate/plan endpoints
- problem summary panel
- planner diagnostics panel

### Frontend Phase C: richer observability

- `max_dm_dt(t)` and other charts once emitted by the runner
- better provenance panels
- precision/device/runtime badges
- snapshot playback

### Frontend Phase D: FEM and comparison

- tetrahedral field adapters
- FEM renderer
- FDM vs FEM comparison views
- shared compare tooling

## Design language

The overall visual direction can stay “scientific control room”, but product semantics matter more than mockups right now.

Priority order:

1. trustworthy state and diagnostics
2. smooth live run visibility
3. readable scientific plots
4. only then higher-end visual polish

The current dark control-room direction is still fine, but the architecture should not depend on any specific visual skin.

## Immediate next actions

1. Define the minimal local session API for live runs.
2. Align CLI behavior around `fullmag script.py` as the main frontend entrypoint.
3. Build the `/runs/[id]` page before the in-browser editor.
4. Add a frontend adapter for current FDM field JSON artifacts.
5. Use the existing `docs/physics/` notes as the first real documentation route.

## Non-goals for the current slice

- browser-side Python execution,
- browser-side physics parsing,
- browser-first workflow,
- FEM live rendering before FEM execution exists,
- WebGPU-first rendering,
- standalone visualization package,
- Jupyter widget integration.
