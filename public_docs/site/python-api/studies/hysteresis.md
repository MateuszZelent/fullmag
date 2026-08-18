---
title: Hysteresis
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-hysteresis)=
# Hysteresis

(python-api-studies-hysteresis-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the public Python authoring contract and canonical lowering for the field-sweep
hysteresis study type; magnetization dynamics and settle semantics are owned by the dynamics and
relaxation pages.

(python-api-studies-hysteresis-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Hysteresis sweeps an external field and settles the system between field points; it introduces no
independent governing equation. Field-to-H mapping and settle physics are owned by Zeeman and
relaxation/dynamics contracts.

(python-api-studies-hysteresis-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Field values are authored and displayed in millitesla and stored canonically with a
`field_unit_provenance` record that maps `mu0_h` / mT to canonical `h_ext` in $\mathrm{A\,m^{-1}}$.
$1$ denotes dimensionless data.

(python-api-studies-hysteresis-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check sweep monotonicity,
expected-branch scheduling, settle-step consistency, mesh cardinality, capability, and backend
legality.

(python-api-studies-hysteresis-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Hysteresis.outputs` | `Sequence[TimeOutputSpec]` | `required` | $1$ | Field/scalar outputs | Per-point sampling | FEM/FDM CPU/GPU | `sampling.outputs` |
| `Hysteresis.field_min_mT` / `field_max_mT` / `field_step_mT` | `float \| None` | `None` | $\mathrm{mT}$ | Finite; nonzero step | Uniform sweep definition | FEM/FDM CPU/GPU | `field_min_mT/max_mT/step_mT` |
| `Hysteresis.field_values_mT` | `Sequence[float] \| None` | `None` | $\mathrm{mT}$ | Non-empty, finite | Explicit field-point schedule | FEM/FDM CPU/GPU | `field_values_mT` |
| `Hysteresis.direction` | `tuple[float,float,float] \| None` | `None` | $1$ | Non-zero length-3 vector | Field sweep direction | FEM/FDM CPU/GPU | `direction` |
| `Hysteresis.measurement_axis` | `str \| MeasurementAxis` | `"field_axis"` | $1$ | `field_axis`, `sample_normal`, `easy_axis`, or custom | Projection axis for the loop | FEM/FDM CPU/GPU | `measurement_axis` |
| `Hysteresis.initial_protocol` | `str` | `"positive_saturation"` | $1$ | One of `as_authored`, `zero_field_relaxed`, `positive_saturation`, `negative_saturation`, `checkpoint` | Initial-state preparation | FEM/FDM CPU/GPU | `initial_protocol` |
| `Hysteresis.branch_mode` | `str` | `"major_loop"` | $1$ | `major_loop`, `major_with_minor_loops`, `virgin_curve`, `virgin_then_major_loop` | Loop topology | FEM/FDM CPU/GPU | `branch_mode` |
| `Hysteresis.settle_pipeline` | `SettlePipeline \| SettleTree \| None` | `None` | mixed | At least one step; `run_next_algorithm` needs a successor | Per-point settle program | FEM/FDM CPU/GPU | `settle_pipeline` |
| `Hysteresis.storage` | `HysteresisStorage \| None` | `None` | mixed | Valid magnetization storage mode | Storage policy | FEM/FDM CPU/GPU | `storage` |

The canonical stage entrypoint `add_hysteresis_sweep` exposes these fields by keyword; the sweep
is not constructed as a standalone `Hysteresis(...)` object in a user script.

### Complete stage-first example

```python
# %% Major hysteresis loop with per-point relaxation
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
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()

# %% Hysteresis stage over a swept external field
study.stages.add_hysteresis_sweep(
    field_min_mT=-50.0,
    field_max_mT=50.0,
    field_step_mT=2.0,
    direction=(0.0, 0.0, 1.0),
    initial_protocol="positive_saturation",
    branch_mode="major_loop",
)
```

(python-api-studies-hysteresis-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`Hysteresis.to_ir()` emits `{"kind": "hysteresis", ...}` including `field_unit_provenance`,
`measurement_axis`, `initial_protocol`, `branch_mode`, `sampling`, and the optional sweep/settle
extensions. The final column above gives each destination.

(python-api-studies-hysteresis-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent (field schedule, protocol, branch mode, storage) is preserved in Python and IR;
resolved execution and the actual settle algorithm are selected by the planner. Validation errors
reject zero field steps, non-monotonic schedules, invalid protocols/axes, and inconsistent settle
pipelines. Unsupported combinations fail capability checks without silent fallback.

(python-api-studies-hysteresis-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only. Settle and dynamics realizations are documented in the
relaxation and dynamics numerical pages.

(python-api-studies-hysteresis-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/study.py` (`class
Hysteresis` and its settle/storage helpers) and `packages/fullmag-py/src/fullmag/world.py`
(`StudyStagesBuilder.add_hysteresis_sweep`).

(python-api-studies-hysteresis-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures and validate the adjacent source map.

(python-api-studies-hysteresis-limitations)=
<!-- (limitations)= -->
## Limitations
Settle and storage policies are authoring contracts; executed qualification is backend-dependent
and must be reported per lane.

(python-api-studies-hysteresis-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Physical model references belong to the Zeeman and dynamics pages; no independent model is
introduced here.

(python-api-studies-hysteresis-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/study.py` | `class Hysteresis` | Canonical Python API behavior | Ownership test and source-map validator |
| Settle policy | `packages/fullmag-py/src/fullmag/model/study.py` | `SettlePipeline`, `SettleTree`, `RelaxStep`, `MinimizeStep` | Per-point settle program | Ownership test |
| Stage surface | `packages/fullmag-py/src/fullmag/world.py` | `StudyStagesBuilder.add_hysteresis_sweep` | Stage-first authoring entrypoint | Ownership test |
