# COMSOL-Style Web Application Refactor For Local Fullmag

## Summary

- Refactor the default `fullmag script.py` workflow from a session/dashboard model into a local web-application model.
- The target user experience is closer to COMSOL with a web workspace and closer to mumax in runtime coupling:
  - one `fullmag` process owns solver state,
  - one live control-plane state exists in memory,
  - one browser workspace is opened at a stable root URL,
  - the live UI does not depend on `session.json`, `run.json`, `live_state.json`, `live_scalars.csv`, or `events.ndjson`.
- Existing session-based APIs and `/runs` pages remain as migration-only legacy/dev surfaces until the live app path fully replaces them.

## Product Target

- `fullmag my_problem.py` should feel like opening one scientific application, not bootstrapping a batch run plus a dashboard.
- The default public URL should be `http://localhost:<port>/`.
- The launcher must start the browser-facing experience before long compute starts.
- The browser must attach to live in-memory state through HTTP bootstrap plus WebSocket updates, not through file polling.
- The local server must bind on `0.0.0.0` so Windows browsers can reach a WSL-hosted run, while printed/opened URLs should prefer `localhost`.

## Runtime Refactor

### 1. Introduce an in-process live app spine

- Add `LocalLiveAppState` owned by the `fullmag` CLI process.
- Store in memory:
  - problem metadata,
  - execution-plan summary,
  - solver/app status,
  - current step/time/dt/energies,
  - current grid or FEM mesh layout,
  - latest field buffers required by the UI,
  - scalar history,
  - command history and console output,
  - artifact index for completed outputs.
- Replace the default launcher path:
  - from `CLI -> session files -> fullmag-api -> SSE -> Next`
  - to `CLI -> in-process live server -> HTTP bootstrap + WebSocket -> browser workspace`.

### 2. Add a direct live API contract

- `GET /api/live/bootstrap`
  - returns the full current workspace snapshot for initial load and reconnect.
- `WS /ws/live`
  - pushes state/log/command/result events directly from the live runtime.
- `POST /api/live/command`
  - accepts structured runtime commands.
- `POST /api/live/console/eval`
  - accepts mumax-style textual commands and maps them to canonical `LiveCommand` values.
- `GET /api/live/artifacts`
  - lists saved outputs and downloadable artifact files.

### 3. Replace file-backed control with in-memory commands

- Remove file-backed command queues from the default live path.
- Replace session status semantics with application status semantics:
  - `bootstrapping`
  - `materializing`
  - `ready`
  - `running`
  - `paused`
  - `interactive`
  - `completed`
  - `failed`
- Publish runner callback updates directly into the live app state at the reporting interval.
- Keep solver continuity in memory across commands.

### 4. Console and command semantics

- The console is not arbitrary Python eval.
- It is a direct runtime console with server-side parsing into `LiveCommand`.
- V1 command set:
  - `run`
  - `relax`
  - `pause`
  - `resume`
  - `break`
  - `close`
  - `setB`
  - `save`
  - `status`
- The runtime loop remains authoritative; browser commands never mutate disk state to drive execution.

## UI Refactor

### 1. Make the live workspace the root route

- The default route becomes `/`.
- Existing `/runs` and `/runs/:id` stay as legacy/dev pages during migration.
- The root workspace should present:
  - one persistent problem/workspace header,
  - one solver/control panel,
  - one live viewport,
  - one results/artifacts panel,
  - one command console with history and output log.

### 2. Reuse existing React UI pieces, but retarget the data flow

- Keep the current control-room UI components where possible.
- Replace `useSessionStream` on the default path with a live-workspace hook based on:
  - `GET /api/live/bootstrap`
  - `WS /ws/live`
- Remove session-id assumptions from the default workspace:
  - route params,
  - footer/session badges,
  - command posts,
  - artifact-import posts,
  - console copy.

## Artifacts And Persistence

- Keep requested simulation outputs and artifact files on disk.
- Keep `metadata.json`, final `scalars.csv`, field snapshots, and saved outputs as artifacts.
- The browser must never depend on these files for current live state.
- Final summary should come from in-memory state first and only then be mirrored to disk.

## Migration Strategy

1. Add the new in-process live app spine.
2. Switch the default local launcher path to the live app spine.
3. Retarget the default browser workspace to `/`.
4. Replace file-backed interactive commands with in-memory channels.
5. Freeze the current session-based path as legacy/dev.
6. Remove the legacy path only after the live app path reaches feature parity.

## Acceptance Criteria

- `fullmag examples/nanoflower_fdm.py` opens one root workspace URL before compute starts.
- The default local-live path does not create `session.json`, `run.json`, `live_state.json`, `live_scalars.csv`, or `events.ndjson`.
- A browser opened before compute sees step/status changes without polling files.
- A refreshed or late-opened browser gets the latest state from bootstrap and continues over WebSocket.
- Multiple browser tabs can attach simultaneously.
- `pause`, `resume`, `break`, `run`, `relax`, and `setB` operate within the same live process.
- Explicit `fm.save(...)` outputs still land on disk as artifacts.
- WSL-hosted runs remain accessible from Windows browsers because browser-facing servers bind on `0.0.0.0` and publish `localhost` URLs.

## Assumptions

- The default local-live UX is the new product path.
- The session-based API remains temporarily for migration only.
- The live control-plane server is owned by the `fullmag` process.
- The current React/Next UI remains the presentation layer during the first migration stage.
