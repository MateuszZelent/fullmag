---
title: Live Session
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-live-session)=
# Live Session

(python-api-runtime-live-session-problem-statement)=
<!-- (problem-statement)= -->
## Contract
`fm.connect()` turns a plain Python process into a client of a running Fullmag instance. A script
started with `python script.py`, an interactive interpreter, or Jupyter cells then program the
current session of a Docker DEV group: every DSL call that changes the model is committed to the
session at once, and `fm.relax()` / `fm.run()` become runtime commands. This is the Fullmag
counterpart of driving Boris Spintronics through `NetSocks.py`; the vocabulary stays the ordinary
DSL. Without a connection the same script keeps its `eager` behaviour, and `fullmag script.py`
keeps capturing it into ProblemIR.

(python-api-runtime-live-session-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This page introduces no physical equation; it owns the transport and execution lifecycle of a live
session. Continuing the magnetization from one command to the next reuses the exact final state of
the previous command when the discretization is unchanged; it adds no field equation.

(python-api-runtime-live-session-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
`until` in `fm.run(until)` and `chunk_time` in `fm.run_until(...)` are durations in seconds ($\mathrm{s}$).
Tolerances keep the units of {doc}`../studies/relaxation`. Other parameters are identifiers ($1$).

(python-api-runtime-live-session-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
- One Docker DEV group owns one current session; the script and the Control Room share it, and
  conflicting edits are reported as `StaleRevisionError` instead of being overwritten.
- In Docker accepted mode `pause` and `skip` are rejected by the server
  (`UnsupportedCapabilityError`); edit the model between commands.
- Operations without live semantics raise `fm.LiveModeError`: stage declarations
  (`relax_stage`, `run_stage`, …), eigenmode and frequency-response studies, and writers of
  local result files (`save`, `save_response`, `snapshot`).

(python-api-runtime-live-session-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fm.connect(url)` | `str \| None` | `$FULLMAG_URL`, else `http://127.0.0.1:3197` | $1$ | `http(s)://host[:port]` without query | Origin of the DEV group frontend, which forwards `/v2/*` and the event socket | FEM/FDM CPU/GPU; runtime capability checks remain authoritative | none (transport) |
| `fm.connect(new_session=...)` | `bool` | `False` | $1$ | boolean | Replace the current session instead of attaching | FEM/FDM CPU/GPU | none |
| `fm.connect(events=...)` | `bool` | `True` | $1$ | boolean | Start the realtime event stream | FEM/FDM CPU/GPU | none |
| `fm.connect(retry_budget_s=...)` | `float` | `60.0` | $\mathrm{s}$ | `>= 0` | Retry budget for requests that provably did not apply | FEM/FDM CPU/GPU | none |
| `fm.transaction()` | context manager | — | $1$ | live session required | Group several DSL calls into one transaction | FEM/FDM CPU/GPU | scene revision |
| `fm.paused()` | context manager | — | $1$ | live session required | Pause, apply edits, resume (interactive host only) | Not in Docker accepted mode | scene revision |
| `fm.run_until(predicate, chunk_time=...)` | callable, `float` | `required` | $\mathrm{s}$ | `chunk_time > 0`; one guard of `max_time`/`max_chunks` | Run in chunks until the predicate holds | FEM/FDM CPU/GPU | `study.stages` run stage |
| `fm.field(quantity)` | `str` | `required` | field SI unit | quantity id of the session catalog | Current samples as `numpy` | FEM/FDM CPU/GPU | none (read) |
| `fm.sweep(function, groups=[...], **lists)` | callable, `list[str]` | `required` | $1$ | distinct group URLs; equal-length lists | Run points across several DEV groups | FEM/FDM CPU/GPU | one session per group |

### The model as a stage-first study

Live mode programs the same model that a batch script authors. The batch form
below is executed by the documentation build; `fullmag script.py` captures its
stages and runs them in order:

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

### Complete live example

In a live session the same calls are sent one by one: `fm.relax(...)` and
`fm.run(...)` (or `study.relax(...)` and `study.run(...)`) become runtime
commands, and each command starts from the final state of the previous one.
A live session is typed into a running Python interpreter or Jupyter kernel,
so it is shown as an interactive transcript. It needs a running DEV group and
is not executed by the documentation build.

```pycon
>>> import fullmag as fm
>>> fm.connect("http://127.0.0.1:3197")   # or set FULLMAG_URL
>>> fm.engine("fdm")                       # each statement is committed at once
>>> fm.device("cpu")
>>> fm.cell(5e-9, 5e-9, 10e-9)
>>> fm.solver(fix_dt=1e-13)                # executable stages need an explicit timestep
>>> layer = fm.geometry(fm.Box(400e-9, 100e-9, 10e-9), name="layer")
>>> layer.Ms, layer.Aex, layer.alpha = 800e3, 13e-12, 0.02
>>> layer.m = fm.texture.uniform(1, 0.1, 0)
>>> fm.relax(dt=1e-13, tolT=1e-5, max_steps=20_000)   # a runtime command
>>> fm.m.average()                         # results come back as numpy
>>> m = fm.field("m").to_numpy()
>>> with fm.transaction():                 # several edits, one revision
...     fm.b_ext(0.02, 0.0, 0.0)
...     layer.alpha = 0.01
>>> fm.run(1e-9)
>>> print(fm.export_script())
```

The same session is shipped as the script `examples/live_session_basics.py`.

(python-api-runtime-live-session-examples)=
### Example scripts and notebooks

`examples/live/` holds runnable examples of the live API. Each one is a `.py` script with
`# %%` cells and a notebook with the same code (`.ipynb`, regenerated by
`examples/live/sync_notebooks.py`). Run them against a DEV group with
`FULLMAG_URL=http://127.0.0.1:<port> python examples/live/<name>.py`; each one starts a new
session in that group (`new_session=True`).

| Example | Covers | Lane |
| --- | --- | --- |
| `01_fdm_relax_read_m` | `fm.connect`, flat DSL model, `fm.relax`, `fm.field("m")` with `to_numpy()` and `as_grid()` | FDM CPU |
| `02_fem_airbox_demag_fields` | `fm.study(...).universe(...)` as the Airbox, Poisson-Robin demag, `fm.field("H_demag", scope_kind="airbox")` and `H_eff` | FEM CPU |
| `03_transaction_dynamics` | `fm.transaction()`, `fm.run`, `fm.run_until`, `fm.on`, `fm.export_script()` | FDM CPU |
| `04_parameter_sweep` | `fullmag.live.sweep.sweep` over the groups in `FULLMAG_SWEEP_GROUPS` | FDM CPU |
| `05_jupyter_monitor` | `fullmag.live.jupyter.monitor()` in a notebook cell, `m` plotted from the field route | FDM CPU |

(python-api-runtime-live-session-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
Live mode does not author ProblemIR directly. Each synchronisation lowers the world with the same
converters as `fullmag script.py` into a SceneDocument; the server derives ProblemIR from that
document when a command runs. Like `study.stages.add_relax`/`add_run`, they need an explicit
timestep (`fm.solver(fix_dt=...)`, `fm.relax(dt=...)`, or an adaptive policy with `dt_max`);
without one the call raises `ValueError` before anything is sent. `fm.relax()` and `fm.run()` add one authored stage to
`scene.study.stages` and run it with a `stage_index` target, so `fm.export_script()` reproduces the
executed sequence.

(python-api-runtime-live-session-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in ProblemIR; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

The first complete world replaces the session scene (`replace_scene`); later changes are sent as
`patch_material`, `assign_study_execution` or one `merge_patch`. Commands carry a
`scene_revision` precondition. Failed, rejected or cancelled commands raise `CommandFailedError`;
unreachable groups raise `FullmagConnectionError`.

(python-api-runtime-live-session-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Execution is the accepted runtime of the DEV group; see the backend pages for solver detail. Live
mode adds no numerical method.

(python-api-runtime-live-session-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/live/__init__.py` (`def connect`).

(python-api-runtime-live-session-validation)=
<!-- (validation)= -->
## Validation
`packages/fullmag-py/tests/test_live_dsl_mode.py`, `test_live_events.py`, `test_live_sweep.py`,
`test_live_client_core.py` and `test_live_client_data.py` run in the CI job
`python-live-client-contracts` against a stateful fake API and a real WebSocket server.

(python-api-runtime-live-session-limitations)=
<!-- (limitations)= -->
## Limitations
Runtime qualification in a Docker DEV group is pending. Pause and skip are unavailable in Docker
accepted mode. Magnetization continuation between commands depends on the server version.

(python-api-runtime-live-session-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-runtime-live-session-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: The Control Room shows every change made by a live script as ordinary scene revisions and runs.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Scene edits from `fm.connect()` scripts | `Model Explorer` | `inspection-only` | Authoring transactions committed by the script |
| Commands `fm.relax()` / `fm.run()` | `Runtime` | `inspection-only` | Runtime commands with `stage_index` target |
| Indicator that a script is connected | — | `not implemented` | Python-only until implemented |

not implemented: frontend indicator for connected live scripts.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx (RuntimeExplorerInspectorPanels)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Live connection | [`packages/fullmag-py/src/fullmag/live/__init__.py`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/live/__init__.py#L86) | [`connect`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/live/__init__.py#L86) | Switch the DSL to live mode | `test_live_dsl_mode.py` |
| Synchronisation | [`packages/fullmag-py/src/fullmag/live/_scene.py`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/live/_scene.py#L108) | [`def plan_transactions`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/live/_scene.py#L108) | Scene diff to transactions | `test_live_dsl_mode.py` |
| Commands | [`packages/fullmag-py/src/fullmag/live/_session.py`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/live/_session.py#L45) | [`class LiveSession`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/live/_session.py#L45) | Sync, commands, reads | `test_live_dsl_mode.py` |
| Events | [`packages/fullmag-py/src/fullmag/client/events.py`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/client/events.py#L224) | [`class EventStream`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/client/events.py#L224) | Realtime events with resume | `test_live_events.py` |
| Sweeps | [`packages/fullmag-py/src/fullmag/live/sweep.py`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/live/sweep.py#L44) | [`def sweep`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/live/sweep.py#L44) | Points across groups | `test_live_sweep.py` |

### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Switch the DSL to live mode. | [`packages/fullmag-py/src/fullmag/live/__init__.py`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/live/__init__.py#L86) | [`connect`](https://github.com/MateuszZelent/fullmag/blob/751fc177ee0f445d5a2cd2b0887d769a6ce95df6/packages/fullmag-py/src/fullmag/live/__init__.py#L86) | Switch the DSL to live mode. | Source-map validator and focused API tests |
