---
title: Hysteresis
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-hysteresis)=
# Hysteresis

(python-api-studies-hysteresis-problem-statement)=
## Contract
This page records the public Python authoring contract and canonical lowering for the field-sweep
hysteresis study type (`fm.Hysteresis`, `study.stages.add_hysteresis_sweep(...)`, and
`study.stages.add_hysteresis_branch(...)`); magnetization dynamics and settle semantics are owned by
the dynamics and relaxation pages.

(python-api-studies-hysteresis-governing-equations)=
## Governing equations
Hysteresis sweeps an external field and settles the system between field points; it introduces no
independent governing equation. Field-to-H mapping and settle physics are owned by Zeeman and
relaxation/dynamics contracts.

(python-api-studies-hysteresis-symbols-and-si-units)=
## Symbols and SI units
Field values are authored and displayed in millitesla ($\mathrm{mT}$) and stored canonically with a
`field_unit_provenance` record that maps `mu0_h` / $\mathrm{mT}$ to canonical `h_ext` in
$\mathrm{A\,m^{-1}}$. $1$ denotes dimensionless data.

(python-api-studies-hysteresis-assumptions-and-validity)=
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check sweep monotonicity,
expected-branch scheduling, settle-step consistency, mesh cardinality, capability, and backend
legality.

(python-api-studies-hysteresis-python-api)=
## Python API

### `Hysteresis` parameters

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Hysteresis.outputs` | `Sequence[TimeOutputSpec]` | `required` | $1$ | Field/scalar outputs | Per-point sampling | FEM/FDM CPU/GPU | `sampling.outputs` |
| `Hysteresis.field_min_mT` | `float \| None` | `None` | $\mathrm{mT}$ | Finite; required for a uniform sweep | Lower uniform-sweep field bound | FEM/FDM CPU/GPU | `field_min_mT` |
| `Hysteresis.field_max_mT` | `float \| None` | `None` | $\mathrm{mT}$ | Finite; required for a uniform sweep | Upper uniform-sweep field bound | FEM/FDM CPU/GPU | `field_max_mT` |
| `Hysteresis.field_step_mT` | `float \| None` | `None` | $\mathrm{mT}$ | Finite and nonzero; required for a uniform sweep | Uniform-sweep field increment | FEM/FDM CPU/GPU | `field_step_mT` |
| `Hysteresis.field_values_mT` | `Sequence[float] \| None` | `None` | $\mathrm{mT}$ | Non-empty, finite | Explicit field-point schedule | FEM/FDM CPU/GPU | `field_values_mT` |
| `Hysteresis.direction` | `tuple[float, float, float] \| None` | `None` | $1$ | Non-zero length-3 vector | Field sweep direction | FEM/FDM CPU/GPU | `direction` |
| `Hysteresis.orientation` | `FieldOrientation \| None` | `None` | $1$ | Validated `FieldOrientation` (spherical angles, preset, or vector) | Structured field-axis orientation | FEM/FDM CPU/GPU | `orientation` |
| `Hysteresis.measurement_axis` | `str \| MeasurementAxis` | `"field_axis"` | $1$ | `field_axis`, `sample_normal`, `easy_axis`, or `MeasurementAxis` | Projection axis for the loop | FEM/FDM CPU/GPU | `measurement_axis` |
| `Hysteresis.angular_family` | `HysteresisAngularFamily \| None` | `None` | $1$ | Non-empty sequence of `HysteresisAngularVariant` | Multi-angle family of hysteresis loops | FEM/FDM CPU/GPU | `angular_family` |
| `Hysteresis.initial_protocol` | `str` | `"positive_saturation"` | $1$ | `as_authored`, `zero_field_relaxed`, `positive_saturation`, `negative_saturation`, or `checkpoint` | Initial-state preparation | FEM/FDM CPU/GPU | `initial_protocol` |
| `Hysteresis.initial_state_ref` | `str \| None` | `None` | $1$ | Non-empty checkpoint reference when `initial_protocol="checkpoint"` | Saved checkpoint reference for initial state | FEM/FDM CPU/GPU | `initial_state_ref` |
| `Hysteresis.saturation` | `SaturationProbe \| None` | `None` | mixed | Validated `SaturationProbe` thresholds and failure policy | Automatic saturation verification probe | FEM/FDM CPU/GPU | `saturation` |
| `Hysteresis.branch_mode` | `str` | `"major_loop"` | $1$ | `major_loop`, `major_with_minor_loops`, `virgin_curve`, `virgin_then_major_loop` | Loop topology | FEM/FDM CPU/GPU | `branch_mode` |
| `Hysteresis.settle_pipeline` | `SettlePipeline \| SettleTree \| None` | `None` | mixed | At least one step; `run_next_algorithm` needs a successor | Per-point settle program | FEM/FDM CPU/GPU | `settle_pipeline` |
| `Hysteresis.storage` | `HysteresisStorage \| None` | `None` | mixed | Valid magnetization storage mode (`key_events`, `selected`, `every_n`, `every_step`, `none`) | Storage policy | FEM/FDM CPU/GPU | `storage` |
| `Hysteresis.field_schedule` | `PiecewiseFieldSchedule \| None` | `None` | $\mathrm{mT}$ | Non-empty `FieldSegment` sequence | Piecewise multi-resolution field schedule | FEM/FDM CPU/GPU | `field_schedule` |
| `Hysteresis.schedule_refinements` | `Sequence[FieldWindow] \| None` | `None` | $\mathrm{mT}$ | Validated `FieldWindow` list | Local static field-grid refinement windows | FEM/FDM CPU/GPU | `schedule_refinements` |
| `Hysteresis.adaptive_refinement` | `AdaptiveRefinement \| None` | `None` | mixed | Positive pass/insertion limits and step bounds | Adaptive susceptibility/coercivity refinement | FEM/FDM CPU/GPU | `adaptive_refinement` |
| `Hysteresis.minor_loops` | `Sequence[MinorLoop] \| None` | `None` | $\mathrm{mT}$ | Required/validated reversal loops when `branch_mode="major_with_minor_loops"` | Minor/recoil reversal loop specifications | FEM/FDM CPU/GPU | `minor_loops` |

### Companion schedule, settle, and storage schemas

| Class | Key parameters & defaults | Purpose |
| --- | --- | --- |
| `FieldOrientation` | `kind`, `preset_name=None`, `theta_deg=None`, `phi_deg=None`, `vector=None` | Structured applied-field orientation descriptor |
| `MeasurementAxis` | `kind`, `vector=None` | Custom projection axis for $M(B)$ hysteresis loops |
| `HysteresisAngularFamily` / `HysteresisAngularVariant` | `variants`, `family_id="angular_family"`, `label=""`; `variant_id`, `orientation`, `label=""`, `measurement_axis=None` | Sweep multiple field orientations in one hysteresis specification |
| `SaturationProbe` | `mode="auto"`, `max_field_mT=300.0`, `susceptibility_threshold=1e-3`, `transverse_threshold=1e-2`, `on_failure="continue_with_warning"` | Automated saturation certification before starting the loop |
| `PiecewiseFieldSchedule` / `FieldSegment` | `segments`; `start`, `stop`, `step`, `segment_id=""`, `label=""`, `endpoint_policy="include_stop"`, `reason=""` | Multi-segment nonuniform field schedule |
| `FieldWindow` | `center_mT`, `half_width_mT`, `step_mT`, `reason=""`, `priority=None` | Local refinement window around switching fields |
| `AdaptiveRefinement` | `enabled=True`, `max_passes=1`, `max_insertions_per_pass=16`, `dm_dh_threshold_per_mT=0.02`, `max_step_mT=5.0`, `min_step_mT=0.1`, `include_zero_crossings=True`, `include_high_susceptibility=True`, `include_in_metrics=False` | On-the-fly insertion of points near coercive/high-$\chi$ transitions |
| `MinorLoop` | `reversal_mT`, `return_mT`, `intermediate_fields_mT=None`, `continuation_policy="branch_only"` | Reversal/recoil minor loop definition |
| `SettlePipeline` / `SettleTree` / `SettleBranch` | `steps`; `default`, `branches`; `when`, `run` | Ordered fallback pipeline or branch-conditioned settle tree |
| `RelaxStep` / `MinimizeStep` / `DynamicsSettleStep` | `method` (`llg_overdamped` / `projected_gradient_bb` / `heun_dynamics_settle`), tolerances, `max_steps`, `applies_to`, `stop_criteria`, `timestep_s`, `max_pseudotime_s`, `max_physical_time_s`, `on_non_convergence`, `retry_timestep_scale`, `retry_max_attempts` | Per-point settle steps inside a pipeline or tree |
| `HysteresisStorage` | `scalar_history=True`, `magnetization="selected"`, `every_n=5`, `key_events=True`, `key_event_threshold_dm=0.02` | Snapshot retention policy across loop points |

The canonical stage entrypoints `study.stages.add_hysteresis_sweep(...)` and
`study.stages.add_hysteresis_branch(field_values_t=..., timestep=..., direction=..., settle=..., save_state=...)`
expose these fields directly by keyword.

### Complete stage-first example

```python
# %% Major hysteresis loop with per-point settle pipeline and storage policy
import fullmag as fm

nm = 1.0e-9

# %% Study and execution lane
study = fm.study("hysteresis_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

# %% Geometry, material, initial state, and interactions
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 1.0
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()

# %% Hysteresis stage over a swept external field
study.stages.add_hysteresis_sweep(
    field_min_mT=-50.0,
    field_max_mT=50.0,
    field_step_mT=2.0,
    direction=(0.0, 0.0, 1.0),
    initial_protocol="positive_saturation",
    branch_mode="major_loop",
    settle_pipeline=fm.SettlePipeline([
        fm.MinimizeStep(method="projected_gradient_bb", torque_tolerance=5.0e-5, max_steps=2000),
        fm.RelaxStep(method="llg_overdamped", torque_tolerance=1.0e-5, max_steps=10000),
    ]),
    storage=fm.HysteresisStorage(magnetization="selected", every_n=5, key_events=True),
)
```

(python-api-studies-hysteresis-problem-ir)=
## ProblemIR
`Hysteresis.to_ir()` emits `{"kind": "hysteresis", ...}` including `field_unit_provenance`,
`measurement_axis`, `initial_protocol`, `branch_mode`, `sampling`, and the optional sweep,
orientation, refinement, minor-loop, settle, and storage extensions.

(python-api-studies-hysteresis-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent (field schedule, protocol, branch mode, settle pipeline, storage) is preserved in
Python and `ProblemIR`; resolved execution and the actual settle algorithm are selected by the
planner. Validation errors reject zero field steps, non-monotonic schedules, invalid protocols/axes,
and inconsistent settle pipelines. Unsupported combinations fail capability checks without silent
fallback.

(python-api-studies-hysteresis-discrete-realization)=
## Discrete realization
This page owns authoring and lowering only. Settle and dynamics realizations are documented in the
relaxation and dynamics numerical pages, and GPU acceleration of per-point minimization is detailed
in {ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fem-gpu-kernels`.

(python-api-studies-hysteresis-implementation-mapping)=
## Implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Sweeps static bias fields using FEM relaxation/minimization settle steps. |
| FEM | GPU | `documented` | Sweeps static bias fields using FEM GPU settle steps (`bb_exchange_mass` PG-BB default under `auto`). |
| FDM | CPU | `documented` | Sweeps static bias fields using FDM relaxation/minimization settle steps. |
| FDM | GPU | `documented` | Sweeps static bias fields using CUDA settle steps (`native_cuda_pgbb` on single-layer PG-BB). |

(python-api-studies-hysteresis-validation)=
## Validation
Ownership tests compare this inventory with live Python signatures.

(python-api-studies-hysteresis-limitations)=
## Limitations
Settle and storage policies are authoring contracts; executed qualification is backend-dependent
and must be reported per lane.

(python-api-studies-hysteresis-scientific-bibliography)=
## Scientific bibliography
Physical model references belong to the Zeeman and dynamics pages; no independent model is
introduced here.

## Control Room support

Status: Stage authoring, $M(B)$ loop plotting, and snapshot replay are `partial`; the stage editor exposes core sweep bounds and settle controls, while nested `SettleTree` pipelines remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
| --- | --- | --- | --- |
| Sweep field bounds, steps, & settle tolerance (`HysteresisStageSpec`) | `Model Explorer -> Stages -> Add stage -> Hysteresis` (`HysteresisStageSpec`) | `partial` | Submit stage draft and trigger stage compute; downstream result resources are invalidated |
| Interactive $M(B)$ hysteresis curve & snapshot scrub | `Analysis Plots` (`HysteresisChart`) linked with `PlanarSnapshotNavigator` (2D) & `HysteresisReplayGlyphLayer` (3D) | `inspection-only` | Clicking any point updates `Selection` (`stageId`, `snapshotId`, `field_value_mT`, `branch_id`) for synchronized 2D/3D replay |
| Arbitrary `SettlePipeline` / `SettleTree` schedules | `Model Explorer -> Stages -> <stage>` | `Python-only` | Stage renders read-only metadata in UI; authored in Python |

```{image} /_static/images/ui/charts-hysteresis-loop-playback.png
:alt: Control Room hysteresis loop plot synchronized with field-sweep snapshot playback in 2D and 3D views
:align: center
:width: 100%
```

```{image} /_static/images/ui/inspector-study-stages-and-rerun.png
:alt: Control Room Study and Stage Inspectors for editing and re-running hysteresis stages
:align: center
:width: 100%
```

Study parameters and nested settle pipelines outside `HysteresisStageSpec` remain Python-only.
See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/studies-and-stages`.
Frontend source owners: `apps/control-room/src/modules/inspector/inspectors/study/StudyStagesSpec.tsx`, `apps/control-room/src/modules/inspector/inspectors/study/stages/HysteresisStageSpec.tsx`, and `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`.

(python-api-studies-hysteresis-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| Constructor, validation, lowering | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L2313) | [`class Hysteresis`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L2313) | Hysteresis study schedule, settle, and storage lowering | Ownership and API contract tests |
| Settle policy | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L2272) | `SettlePipeline`, `SettleTree`, `RelaxStep`, `MinimizeStep`, `DynamicsSettleStep` | Per-point settle program | Ownership test |
| Stage surface | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5363) | [`add_hysteresis_sweep`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5363) | Stage-first authoring entrypoint on `StudyStagesBuilder` | Ownership test |
