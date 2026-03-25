# Interactive Session Mode Plan

## Goal

Reach a product-grade interactive mode where:

```bash
fullmag -i script.py
```

or:

```python
fm.interactive(True)
```

starts a session that:

1. brings up the web UI before long compute starts,
2. keeps the solver session open for further commands,
3. allows staged commands such as `relax`, `run`, `break`, field changes, and later parameter edits,
4. behaves more like mumax3 / COMSOL session workflows than a one-shot batch runner.

## Current verified state

Implemented today:

- `fullmag script.py` is the main public workflow.
- the launcher creates a session and can auto-start the control room.
- flat scripts can now emit a **sequence of execution stages** such as:
  - `fm.relax()`
  - `fm.run(5e-10)`
- the Rust launcher executes those stages in one session and carries magnetization forward between stages.
- `-i` and `fm.interactive(True)` now keep the session alive after scripted stages and move it to `awaiting_command`.
- the CLI exposes a real session command loop backed by file-queued commands under `session_dir/commands/`.
- the API exposes `POST /v1/sessions/{id}/commands` for:
  - `run`
  - `relax`
  - `close`
- the control room has bootstrap interactive controls for:
  - `Run`
  - `Relax`
  - `Close Session`
- live state now keeps the final step, time, and magnetization of the last completed segment before entering `awaiting_command`.

Not implemented yet:

- `break` / `continue` / `pause` controls during an active solver segment,
- mutable runtime edits such as changing field, outputs, or material parameters after session start,
- command-history UI / console semantics beyond simple enqueue buttons,
- canonical command-sequence IR shared by flat API, Python object API, and future notebook/console flows.

## Problem statement

The old launcher contract assumed a single run block. That was already too weak for:

- `relax -> run`,
- hysteresis protocols,
- spin-wave excitation workflows,
- staged field schedules.

It is even more insufficient for true interactive mode.

Interactive mode must therefore build on the same core idea:

- **a session is a long-lived command stream, not a single run call**.

## Target architecture

### 1. Session command stream

The session owns an ordered stream of commands:

- `relax`
- `run(until=...)`
- `set_field(B=...)`
- `set_current(...)`
- `pause`
- `resume`
- `break`
- later:
  - `set_material(...)`
  - `set_output_policy(...)`
  - `snapshot(...)`

The launcher may seed this stream from the script, and then interactive mode may append more commands after startup.

### 2. Single session, multiple run segments

Each command that advances time or relaxation creates a run segment inside the same session.

The session must preserve:

- current magnetization state,
- solver time,
- cumulative step counter,
- artifacts and provenance,
- UI connection identity.

### 3. Host-owned control room

Production mode should be:

1. create session,
2. start host web UI,
3. print clickable URL,
4. start/continue compute,
5. accept further commands from UI and optional local console.

The separate developer-hosted control room stays valid, but it is not the final product UX.

## Required implementation slices

### Slice A: sequence model hardening

Status:

- bootstrap done for flat `relax -> run`

Still needed:

- formalize stage/command provenance in session events,
- support more than one magnet in continuation,
- move from ad-hoc flat-stage export toward a canonical command-sequence IR.

### Slice B: interactive session contract

Status:

- bootstrap done for `awaiting_command` + queued `run/relax/close`

Need new session-level control primitives:

- `pending`
- `running`
- `paused`
- `awaiting_command`
- `completed`
- `failed`

Need API endpoints such as:

- `POST /v1/sessions/{id}/commands`
- `POST /v1/sessions/{id}/break`
- `POST /v1/sessions/{id}/pause`
- `POST /v1/sessions/{id}/resume`

Need command payloads with strict validation and explicit compatibility checks against current session state.

### Slice C: runner interruption and continuation

Status:

- continuation between scripted stages works
- continuation between queued interactive commands works
- session state, time, and cumulative step counter stay in one session/run

Still needed:

- cooperative stop/break points,
- segment cancellation without killing the whole process,
- resumable in-flight solver segments for FDM first, then FEM.

For FDM and FEM this means:

- session-owned mutable state,
- command execution loop around solver calls,
- clean resumption semantics.

### Slice D: UI controls

Status:

- bootstrap `Run / Relax / Close Session` controls are wired to the session command API

Need control-room components for:

- `Break`
- `Pause`
- `Resume`
- command console / notebook-like command log

Need the UI to show:

- current session status,
- queued command count,
- current segment index,
- active backend/device,
- whether the session is waiting for user input.

### Slice E: Python authoring surface

Status:

- `fm.relax()` + `fm.run(...)` can now coexist as staged commands
- `fm.interactive(True)` correctly means “keep this session open for more commands”

Need public Python commands that can seed or append to the same execution model:

- `fm.relax()`
- `fm.run(t)`
- `fm.setB(...)`
- `fm.breakpoint()` or similar staged controls if needed

Need script-owned interactive declaration:

- `fm.interactive(True)`

Next step for this surface:

- expose field/material mutation commands in the same staged model,
- add a Python-side interactive console contract that maps to the same session queue instead of bypassing the launcher.

## Recommended rollout

1. keep the new multi-stage launcher and interactive queue stable,
2. add `pause/break/resume` for FDM first,
3. add command console/history UI,
4. add mutable field/material/session commands,
5. move from file-backed queue to a more canonical command-sequence/session-state contract if needed,
6. only then extend the same semantics deeply to FEM.

## Risks

- if interactive mode is bolted on top of one-shot run semantics, session state will fragment,
- if commands mutate solver state without canonical provenance, reproducibility will break,
- if UI controls arrive before runner interruption semantics, the product will look interactive but lie.

## Immediate next step

Implement **cooperative `pause/break/resume`** for FDM first, reusing the current `awaiting_command` session spine instead of inventing a parallel control path.
