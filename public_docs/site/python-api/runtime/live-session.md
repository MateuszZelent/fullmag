---
title: Live Session
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-live-session)=
# Live Session

(python-api-runtime-live-session-problem-statement)=
## Contract

`fm.connect()` turns a plain Python process—an interactive interpreter, a standalone script, or a
Jupyter notebook—into a live client of a running FullMag instance. Once connected, every DSL call
that modifies the scene commits an incremental transaction to the active server session, and
`fm.relax()`, `fm.run()`, and `fm.run_until(...)` execute as live runtime commands while Control Room
visualizes the evolving geometry, scalar time series, and field maps in real time.

When `$FULLMAG_URL` is exported in the environment, the first live-synced DSL call automatically
attaches once per Python context without an explicit `fm.connect()` call. Without a connection, the
same vocabulary retains its standard `eager` batch behavior, and `fullmag script.py` captures it
deterministically into `ProblemIR`. Calling `fm.disconnect()` closes the live session attachment and
restores ordinary eager DSL semantics in the current Python process.

```{image} /_static/images/ui/start-screen-python-live-connect.png
:alt: Control Room Start Screen surfacing an active Python live session created via fm.connect() under Active simulations
:align: center
:width: 100%
```

(python-api-runtime-live-session-governing-equations)=
## Governing equations

This page introduces no physical equation; it defines the transport, synchronization, presence, and
command execution contract for driving a live session. Continuing magnetization from one executed
command to the next reuses the previous command's final state when the spatial discretization is
unchanged; it adds no PDE or energy term.

(python-api-runtime-live-session-symbols-and-si-units)=
## Symbols and SI units

`until` in `fm.run(until)` and `chunk_time` / `max_time` in `fm.run_until(...)` are durations in
seconds ($\mathrm{s}$). `retry_budget_s`, `timeout`, `command_timeout`, and `min_interval_s` are
client-side wall-clock durations in seconds ($\mathrm{s}$). Stopping tolerances follow
{doc}`../studies/relaxation`. Field vectors and table columns return quantities in their canonical SI
units (for example $\mathrm{A}/\mathrm{m}$ for magnetization/fields or dimensionless normalized
$\mathbf{m}$, $\mathrm{J}/\mathrm{m}^3$ for energy densities, and $\mathrm{s}$ for simulation time).
Identifiers, counts, and flags are dimensionless ($1$).

(python-api-runtime-live-session-assumptions-and-validity)=
## Assumptions and validity

- **Single shared current session per instance**: One running FullMag instance (typically a Docker DEV
  group) owns one current session shared between Python and Control Room. Conflicting concurrent edits
  between Python and the browser fail with `StaleRevisionError` (`409`) unless explicitly reconciled
  via `fm.sync(reconcile=True)`.
- **Presence heartbeats and lease**: `LiveSession` (`fullmag.live._session`) starts a background
  `"fullmag-live-presence"` thread on connect that emits client heartbeats every $10.0\ \mathrm{s}$ to
  `PUT /v2/sessions/current/clients/{client_id}` (kind `"python_live"`, labeled with
  `source_path.name` when known or `"python-live"`). The server maintains active entries for a
  $30\ \mathrm{s}$ presence TTL (up to 64 clients) and `fm.disconnect()` / `close()` cleanly issues a
  `DELETE` leave request.
- **Docker accepted mode command limits**: In Docker accepted mode, `fm.pause()`, `fm.paused()`, and
  `fm.skip()` are rejected by server capability policy with `UnsupportedCapabilityError`; modify model
  parameters between commands or use `fm.transaction()` instead.
- **Timestep prerequisite**: Like `study.stages.add_relax` and `study.stages.add_run`, live
  `fm.relax(...)` and `fm.run(...)` require an explicit timestep (`fm.solver(fix_dt=...)`,
  `fm.relax(dt=...)`, or an adaptive policy providing `dt_max`); otherwise `ValueError` is raised
  client-side before sending a request.
- **Live-hook exclusions (`LiveModeError`)**: Operations that do not map to incremental live commands—
  such as declarative `relax_stage` / `run_stage` batch builders, standalone eigenmode or
  frequency-response study constructors, or local file writers (`save`, `save_response`,
  `snapshot`)—raise `fm.LiveModeError`. Calling `fm.connect()` while capturing (`fullmag script.py`)
  likewise raises `fm.LiveModeError`.

(python-api-runtime-live-session-python-api)=
## Python API

All live entry points are re-exported on top-level `fullmag` (`import fullmag as fm`), with notebook
plotting in `fullmag.live.jupyter`.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fm.connect(url)` | `str \| None` | `$FULLMAG_URL`, else `http://127.0.0.1:3197` | $1$ | `http(s)://host[:port]` without query | Origin of the DEV group frontend | FEM/FDM CPU/GPU; runtime capability checks remain authoritative | none (transport) |
| `fm.connect(new_session=...)` | `bool` | `False` | $1$ | boolean | Replace the current session instead of attaching | FEM/FDM CPU/GPU | none |
| `fm.connect(events=...)` | `bool` | `True` | $1$ | boolean | Start the realtime event stream | FEM/FDM CPU/GPU | none |
| `fm.connect(retry_budget_s=...)` | `float` | `60.0` | $\mathrm{s}$ | `>= 0` | Retry budget for requests that provably did not apply | FEM/FDM CPU/GPU | none |
| `fm.disconnect()` | function | — | $1$ | safe when disconnected | Leave client presence, close the WebSocket stream, and return DSL to eager mode | FEM/FDM CPU/GPU | none (transport) |
| `fm.sync(reconcile=...)` | function (`bool`) | `False` | $1$ | live session required | Commit pending DSL changes; reconcile merges disjoint Control Room edits after conflict | FEM/FDM CPU/GPU | scene revision |
| `fm.transaction()` | context manager | — | $1$ | live session required | Group several DSL calls into one transaction | FEM/FDM CPU/GPU | scene revision |
| `fm.paused()` | context manager | — | $1$ | live session required | Pause, apply edits, resume (interactive host only) | Not in Docker accepted mode | scene revision |
| `fm.relax(...) / fm.run(...)` | runtime commands | `required` stage timing | $\mathrm{s}$ | explicit timestep (`fix_dt`, `dt`, or adaptive `dt_max`) required | Append a live stage and execute with `stage_index` target | FEM/FDM CPU/GPU | `study.stages` stage entry |
| `fm.run_until(predicate, chunk_time=...)` | callable, `float` | `required` | $\mathrm{s}$ | `chunk_time > 0`; one guard of `max_time`/`max_chunks` | Run in chunks until the predicate holds | FEM/FDM CPU/GPU | `study.stages` run stage |
| `fm.pause() / fm.resume() / fm.stop() / fm.skip()` | runtime commands | — | $1$ | live session required | Submit session control commands (`stop`/`resume`/`pause`/`skip`) | `stop` supported across modes; `pause` and `skip` rejected in Docker accepted mode | none (command) |
| `fm.field(quantity)` | `str` | `required` | field SI unit | quantity id of the session catalog | Fetch FMVP binary field vector (`.to_numpy()`, `.as_grid()`, `.as_complex()`) | FEM/FDM CPU/GPU | none (read) |
| `fm.table(table_id)` | `str` | `required` | table column SI units | valid table id (`scalars` default) | Fetch FMTB binary rows (`.to_numpy()`, `.column()`, `.to_pandas()`) | FEM/FDM CPU/GPU | none (read) |
| `fm.on(event_type, callback)` | `str`, callable | `required` | $1$ | live session with `events=True` | Subscribe to WebSocket `LiveEvent` stream (`scalar.sample`, `resource.batch_changed`, `*`) | FEM/FDM CPU/GPU | none (stream) |
| `fm.export_script()` | function | — | $1$ | live session required | Sync and render canonical editable Python script from the server model | FEM/FDM CPU/GPU | round-trip script |
| `fm.sweep(function, groups=[...], **lists)` | callable, `list[str]` | `required` | $1$ | distinct group URLs; equal-length lists | Run points across several DEV groups | FEM/FDM CPU/GPU | one session per group |
| `fullmag.live.jupyter.monitor(...)` | helper | `columns=('mx', 'my', 'mz')` | $1$ | live session with event stream | Stream scalar samples into a live notebook plot or `.samples` buffer | FEM/FDM CPU/GPU | none (read) |

### Full signature notes

- `fm.connect(url=None, *, new_session=False, backend=None, token=None, timeout=30.0, retry_budget_s=60.0, command_timeout=None, source_path=None, events=True) -> LiveSession`:
  - `backend`: `"fdm"` or `"fem"` when starting or replacing a session (defaults to the local world's configured backend or `"fdm"`).
  - `token`: optional bearer token (falls back to `$FULLMAG_TOKEN`).
  - `timeout` / `command_timeout`: HTTP request timeout and command completion wait bound (when unset, long relax/run commands wait cleanly without timing out early).
  - `source_path`: explicit script path whose filename is published as the presence heartbeat label.
  - Session reuse vs. replacement: attaches to the active non-terminal session if present; replaces automatically if the session is in a terminal state (`stopping`, `stopped`, `cancelled`, `failed`, `completed`, `closed`) or when `new_session=True`.
- `fm.field(quantity_id, **query) -> Optional[FieldVector]`:
  Fetches FMVP v2–v6 binary vectors (`FieldVector` with `.to_numpy()` shape `(point_count, n_comp)`, `.as_grid()` shape `(nz, ny, nx, n_comp)` for `full_domain`/`legacy_count_only` ordering with $x$ varying fastest, `.as_complex()`, and `.point_count`). Transparently handles HTTP `202` retry, `204` (`None`), and `304` ETag caching; when `quantity_id == "m"` without extra query parameters and no plan quantity registry applies, falls back to observation-frame magnetization endpoints.
- `fm.table(table_id, *, columns=None, **query) -> TableRows`:
  Fetches FMTB v1 binary tabular streams with `.to_numpy()`, `.column(name)`, and optional `.to_pandas()` (requires `pandas`).
- `fm.on(event_type, callback) -> Subscription`:
  Registers `callback(event: LiveEvent)` on the background WebSocket `EventStream` (`"scalar.sample"`, `"resource.batch_changed"`, `"*"`), returning a `Subscription` whose `.cancel()` method detaches the callback.
- `fm.run_until(predicate, *, chunk_time, max_time=None, max_chunks=None) -> Optional[LiveCommandResult]`:
  Advances simulation in chunks of `chunk_time` until `predicate(step)` returns truthy or one of `max_time` / `max_chunks` terminates the loop. `step` exposes scalar columns (`step.time`, `step.mx`, `step.my`, `step.mz`, falling back to domain-averaged `fm.field("m")` if scalar rows are absent).
- `fm.sweep(function, *, groups, points=None, new_session=False, raise_on_error=True, token=None, command_timeout=None, connect_retry_s=5.0, **parameters) -> list[SweepResult]`:
  Assigns one thread and isolated `fm.ExecutionContext()` per distinct URL in `groups`, calls `fm.reset()` between sweep points, and returns `SweepResult(index, point, group, value, run_id, error, traceback)` objects with `.ok` status. Set `raise_on_error=False` to inspect partial failures instead of raising `SweepError`.
- `fullmag.live.jupyter.monitor(columns=("mx", "my", "mz"), *, x_column="time", min_interval_s=0.25) -> ScalarMonitor`:
  Subscribes to scalar samples for live notebook visualization (requires `pip install "fullmag[jupyter]"` for inline IPython/matplotlib widgets, falling back cleanly to headless `.samples` buffering and text table summaries in non-notebook environments). Expose `.start()`, `.stop()`, and `.samples`.

### The model as a stage-first study

Live mode programs the exact same physical model that a stage-first batch script authors. The batch
form below is executed directly by documentation verification; `fullmag script.py` lowers its stages
deterministically into `ProblemIR`:

```python
# %% Model
import fullmag as fm

study = fm.study("live_session_basics")
study.engine("fdm")
study.device("cpu", precision="double")
study.cell(5e-9, 5e-9, 10e-9)
study.solver(fix_dt=1e-13)

layer = study.geometry(fm.Box(size=(400e-9, 100e-9, 10e-9), name="layer"), name="layer")
layer.Ms = 800e3
layer.Aex = 13e-12
layer.alpha = 0.02
layer.m = fm.texture.uniform(1, 0.1, 0)

# %% Stages: relax, then dynamics in a bias field
study.b_ext(0.02, 0.0, 0.0)
study.stages.add_relax(algorithm="llg_overdamped", dt=1e-13, tolT=1e-5, max_steps=20_000)
study.stages.add_run(1e-9)
```

### Complete live workflow (interactive transcript)

In a live session, the same statements commit incrementally and each `fm.relax(...)`, `fm.run(...)`,
or `fm.run_until(...)` resumes from the final magnetization of the preceding command. Because live
transcripts require a running FullMag instance, they use `pycon` syntax:

```pycon
>>> import fullmag as fm
>>> session = fm.connect("http://127.0.0.1:3197", new_session=True)
>>> fm.engine("fdm")                       # commits on each DSL call
>>> fm.device("cpu", precision="double")
>>> fm.cell(5e-9, 5e-9, 10e-9)
>>> fm.solver(fix_dt=1e-13)                # explicit timestep required for live stages
>>> layer = fm.geometry(fm.Box(400e-9, 100e-9, 10e-9), name="layer")
>>> layer.Ms, layer.Aex, layer.alpha = 800e3, 13e-12, 0.02
>>> layer.m = fm.texture.uniform(1, 0.1, 0)
>>> fm.relax(dt=1e-13, tolT=1e-5, max_steps=20_000)
>>> m_vec = fm.field("m").to_numpy()       # shape: (N_cells, 3)
>>> m_grid = fm.field("m").as_grid()       # shape: (nz, ny, nx, 3)
>>> sub = fm.on("scalar.sample", lambda ev: print(ev.data))
>>> with fm.transaction():                 # atomic multi-property delta
...     fm.b_ext(0.02, 0.0, 0.0)
...     layer.alpha = 0.01
>>> fm.run_until(lambda s: s.mx > 0.99, chunk_time=2e-11, max_time=5e-10)
>>> rows = fm.table("scalars", columns=("time", "mx", "my", "mz"))
>>> script_text = fm.export_script()       # reproducible stage-first script
>>> sub.cancel()
>>> fm.disconnect()
```

### Multi-instance sweeps and Control Room monitoring

```{image} /_static/images/ui/multi-instance-session-tabs.png
:alt: Control Room multi-instance tab strip switching across concurrent Docker DEV group ports
:align: center
:width: 100%
```

When running parameter sweeps (`fm.sweep(...)`) across multiple local DEV groups, Control Room's
multi-instance tab strip (`/home` -> **Other instances on this computer** and session tabs) lets you
monitor each port's live session concurrently. Inside an active workspace, **File -> Save canonical
copy as...** exports the current session state as an editable stage-first Python script matching
`fm.export_script()` (experimental `preview: true` ribbon tabs such as **Automation** are stripped from
the active toolbar):

```{image} /_static/images/ui/ribbon-tabs-automation-python.png
:alt: Control Room File menu showing Save canonical copy as... for canonical Python script export while experimental preview ribbon tabs remain hidden
:align: center
:width: 100%
```

### Interactive stage re-execution with Control Room

Because `fm.relax()` and `fm.run()` append stages cleanly into `scene.study.stages` and target them
by `stage_index`, any authored stage remains inspectable—and re-executable—from the **Study** and
**Stage** Inspector panels:

```{image} /_static/images/ui/inspector-study-stages-and-rerun.png
:alt: Control Room Study and Stage Inspectors showing authored stage cards, initial-state selector, and Compute / re-run controls
:align: center
:width: 100%
```

When you modify a stage draft or select an explicit initial state in Control Room and trigger stage
re-execution (`executeStageAfterApply`), the UI pins `(scene_revision, solver_profile, domain)`,
verifies `sessions/current/status` and `model/readiness`, aborts safely if a live Python script
mutated the scene concurrently, and submits a targeted stage run. If Python subsequently commits
another change on top of a Control Room edit, call `fm.sync(reconcile=True)` to merge disjoint
updates cleanly rather than failing with a stale-revision error.

```{image} /_static/images/ui/status-bar-footer.png
:alt: Control Room bottom status bar showing session state, mesh freshness, realtime WebSocket status, and active compute engine
:align: center
:width: 100%
```

(python-api-runtime-live-session-examples)=
### Example scripts and notebooks

`examples/live/` ships five runnable reference scripts (`# %%` cells) and mirrored `.ipynb` notebooks
(regenerated by `examples/live/sync_notebooks.py`). Run any example against a running DEV group with
`FULLMAG_URL=http://127.0.0.1:<port> python examples/live/<name>.py`; each connects with
`new_session=True`:

| Example | API surface exercised | Lane |
| --- | --- | --- |
| `01_fdm_relax_read_m.py` | `fm.connect(new_session=True, backend="fdm")`, flat DSL model, `fm.relax`, `fm.field("m").to_numpy()` & `.as_grid()`, `fm.disconnect()` | FDM CPU |
| `02_fem_airbox_demag_fields.py` | `fm.study(...).universe(...)` (Airbox), Poisson-Robin demag (`study.demag()`), `fm.relax()`, `fm.field("H_demag", scope_kind="airbox")` and `H_eff` | FEM CPU |
| `03_transaction_dynamics.py` | `fm.on("scalar.sample", ...)`, `with fm.transaction():`, `fm.run()`, `fm.run_until(...)`, `fm.export_script()` | FDM CPU |
| `04_parameter_sweep.py` | `fullmag.live.sweep.sweep` (`fm.sweep`) dispatching parameter sweeps across `FULLMAG_SWEEP_GROUPS` | FDM CPU |
| `05_jupyter_monitor.py` | `fullmag.live.jupyter.monitor(...)` live notebook scalar monitor with `fm.field("m")` readout | FDM CPU |

(python-api-runtime-live-session-problem-ir)=
## ProblemIR

Live mode does not mutate raw `ProblemIR` directly. Each synchronization serializes the world with the
same lowering converters used by `fullmag script.py` into a `SceneDocument`, and the server derives
validated `ProblemIR` from that scene before planning any command. Like `study.stages.add_relax` and
`study.stages.add_run`, live `fm.relax()` and `fm.run()` append one stage record to `scene.study.stages`
and submit a command targeting `stage_index`, so `fm.export_script()` reconstructs the exact authored
stage sequence cleanly.

(python-api-runtime-live-session-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent remains the Python-authored configuration serialized into `SceneDocument`/`ProblemIR`;
resolved execution records the planner's concrete backend, device, precision, mesh/grid realization, and
capability decisions without rewriting requested intent.

The initial synchronization replaces the session scene (`replace_scene`); subsequent delta updates plan
minimal `patch_material`, `assign_study_execution`, or RFC 7386 `merge_patch` transactions. Commands
carry a `scene_revision` precondition (`reason="python_live"`). Failed or cancelled runtime commands
raise `CommandFailedError`; unreachable hosts raise `FullmagConnectionError`; concurrent browser/script
scene mutations raise `StaleRevisionError` (`409`). Validation errors report the rejected domain or
timing rule client-side (`ValueError`) or before execution, and unsupported combinations fail closed via
`LiveModeError` or `UnsupportedCapabilityError` rather than falling back silently.

(python-api-runtime-live-session-discrete-realization)=
## Discrete realization

All numerical execution runs inside the attached session's backend runtime (FDM CPU/GPU or FEM CPU/GPU);
live mode introduces no separate solver implementation. See {doc}`runtime-selection`, {doc}`backend-policy`,
and backend-specific physics pages for solver-lane guarantees and device qualification gates.

(python-api-runtime-live-session-implementation-mapping)=
## Implementation mapping

Primary owners under `packages/fullmag-py/src/fullmag/`:

- `live/__init__.py` — top-level DSL entry points (`connect`, `disconnect`, `sync`, `transaction`,
  `paused`, `relax`, `run`, `run_until`, `pause`, `resume`, `stop`, `skip`, `field`, `table`, `on`,
  `export_script`, `sweep`) and auto-connect logic.
- `live/_session.py` — `LiveSession`, `"fullmag-live-presence"` heartbeat thread (`10.0 s` interval),
  delta synchronization, conflict reconciliation, stage execution, `run_until`, binary reads, and
  `export_script`.
- `live/_scene.py` — `plan_transactions` (`replace_scene`, `patch_material`, `assign_study_execution`,
  `merge_patch`), live stage recording (`AssignmentScope`), and revision conflict reconciliation.
- `live/_hooks.py` — handle/module wrappers (`_LIVE_SYNCED_FUNCTIONS`) forwarding live mutations cleanly.
- `live/sweep.py` & `live/jupyter.py` — concurrent multi-group `sweep` runner and `ScalarMonitor`.
- `client/` — typed HTTP client, WebSocket `EventStream`, FMVP binary field decoder, and FMTB table decoder.

(python-api-runtime-live-session-validation)=
## Validation

Contract suites `packages/fullmag-py/tests/test_live_dsl_mode.py`, `test_live_events.py`,
`test_live_sweep.py`, `test_live_client_core.py`, and `test_live_client_data.py` verify connection
lifecycles, presence heartbeats and leaves, transaction planning and reconciliation, WebSocket cursor
resume, FMVP/FMTB decoding, `run_until`, `sweep`, and `jupyter.monitor` against a stateful mock API and
real WebSocket server. Reference live scripts live under `examples/live/01..05`. Live transport checks
verify Python client behavior against the server API contract; physics accuracy and device parity are
governed by the dedicated suites under {doc}`/validation/index`.

(python-api-runtime-live-session-limitations)=
## Limitations

- `fm.pause()`, `fm.paused()`, and `fm.skip()` are rejected in Docker accepted mode (`UnsupportedCapabilityError`); edit parameters between commands or start a fresh stage instead.
- Magnetization continuation between consecutive `fm.relax()` / `fm.run()` commands requires keeping the discretization unchanged across those stages.
- Control Room exposes active Python-created sessions on Start Screen (**Active simulations**) and in multi-instance tabs, and the backend maintains `/v2/sessions/current/clients` (`30 s` presence TTL, max `64` clients); rendering a dedicated per-client live-script badge directly from `SESSION_CLIENTS_PATH` in the Control Room workspace bar is not yet wired.
- `fullmag[jupyter]` is required for inline matplotlib widgets in `fullmag.live.jupyter.monitor()`; core live mode otherwise degrades cleanly to headless `.samples` buffering.

(python-api-runtime-live-session-scientific-bibliography)=
## Scientific bibliography

No independent physical equation is introduced by the live session protocol. Transport and binary payload
contracts reference the server API and solver documentation directly.

## Control Room support

Status: Control Room displays every scene revision, authored stage, run telemetry trace, and field output driven by `fm.connect()` in real time.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Scene edits & `fm.transaction()` | `Model Explorer` & active Inspectors | `inspection-only` for script writes; bidirectional when reconciled | Python authoring transactions (`replace_scene`, `patch_material`, `assign_study_execution`, `merge_patch`) and `fm.sync(reconcile=True)` |
| `fm.relax()` / `fm.run()` / `fm.run_until()` | `Model Explorer -> Stages -> <stage>` & `Footer` | `implemented` (`stage_index` re-execution in Stage Inspector) | Runtime `stage_index` commands pinned to `scene_revision` (`reason="python_live"` vs UI `executeStageAfterApply`) |
| `fm.field()` / `fm.table()` / `fm.on()` | `3D Viewport`, `Field Map (2D)`, & `Live Charts` | `implemented` (`inspection-only` overlays/plots) | Binary `/v2/sessions/current/data/*` (FMVP/FMTB) and `/v2/sessions/current/events/ws` stream |
| Multi-group `fm.sweep()` monitoring | `Start Screen -> Other instances` & top instance tab strip | `implemented` (per-instance view) | Host instance discovery (`PLATFORM_INSTANCES_PATH`) and instance tabs |
| Script presence (`LiveSession` heartbeat) | `Start Screen -> Active simulations` (`ActiveSessions`) | `partial` | Server `/v2/sessions/current/clients` (`10 s` heartbeat / `30 s` TTL); `SESSION_CLIENTS_PATH` typed in `apiPaths.ts`; per-client workspace-bar badge remains Python/API-only |

See [Control Room capability register](/frontend/capability-register) for the UI support matrix.
Frontend source owners: `apps/control-room/src/modules/start/home/ActiveSessions.tsx`, `apps/control-room/src/kernel/layout/InstanceTabStrip.tsx`, `apps/control-room/src/modules/inspector/panels/studyStageApplyAndRun.ts`, `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx`, and `apps/control-room/src/modules/status-bar/StatusBarModule.tsx`.

(python-api-runtime-live-session-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Live connection | [`packages/fullmag-py/src/fullmag/live/__init__.py`](https://github.com/MateuszZelent/fullmag/blob/4c9424ca0/packages/fullmag-py/src/fullmag/live/__init__.py) | `connect` | Switch the DSL to live mode | `test_live_dsl_mode.py` |
| Session, presence & IO | [`packages/fullmag-py/src/fullmag/live/_session.py`](https://github.com/MateuszZelent/fullmag/blob/4c9424ca0/packages/fullmag-py/src/fullmag/live/_session.py) | `class LiveSession` | Manage live session sync, heartbeats, commands, fields, tables, and script export | `test_live_dsl_mode.py`, `test_live_client_data.py` |
| Synchronisation | [`packages/fullmag-py/src/fullmag/live/_scene.py`](https://github.com/MateuszZelent/fullmag/blob/4c9424ca0/packages/fullmag-py/src/fullmag/live/_scene.py) | `plan_transactions` | Plan atomic scene transactions between the local DSL state and server revision | `test_live_dsl_mode.py` |
| Events | [`packages/fullmag-py/src/fullmag/client/events.py`](https://github.com/MateuszZelent/fullmag/blob/4c9424ca0/packages/fullmag-py/src/fullmag/client/events.py) | `class EventStream` | Maintain WebSocket realtime subscriptions with cursor resume | `test_live_events.py` |
| Sweeps | [`packages/fullmag-py/src/fullmag/live/sweep.py`](https://github.com/MateuszZelent/fullmag/blob/4c9424ca0/packages/fullmag-py/src/fullmag/live/sweep.py) | `sweep` | Dispatch parameter sweep points concurrently across running groups | `test_live_sweep.py` |
| Jupyter monitor | [`packages/fullmag-py/src/fullmag/live/jupyter.py`](https://github.com/MateuszZelent/fullmag/blob/4c9424ca0/packages/fullmag-py/src/fullmag/live/jupyter.py) | `monitor` | Stream scalar telemetry for live notebook plots and headless capture | `test_live_client_data.py` |
| Server presence store | `crates/fullmag-api/src/router_v2/handlers/sessions/clients.rs` | `SESSION_CLIENT_TTL_MS` | Track live client heartbeats within 30 s TTL and emit `"session-clients"` invalidations | `live` presence API handler |
