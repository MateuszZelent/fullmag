---
title: Relaxation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-relaxation)=
# Relaxation

(python-api-studies-relaxation-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the public Python authoring contract and canonical lowering for the
energy-minimization study type; physical algorithms and numerical realizations belong to the
relaxation numerical pages.

(python-api-studies-relaxation-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Relaxation drives the magnetization toward $\mathbf m\times\mathbf H_{\mathrm{eff}}\approx 0$
under the constraint $|\mathbf m|=1$; the underlying equation is LLG with precession disabled for
the overdamped lane and the sphere-product descent condition for direct minimizers. Equations are
owned by {doc}`../../numerical-methods/relaxation/index`.

(python-api-studies-relaxation-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data. Torque tolerance is
accepted and reported in tesla, with the derived A/m value recorded in the stop contract.

(python-api-studies-relaxation-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check algorithm support,
mesh cardinality, capability, stop-contract consistency, and backend legality.

(python-api-studies-relaxation-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Relaxation.outputs` | `Sequence[TimeOutputSpec]` | `required` | $1$ | Field/scalar outputs; an empty sequence is valid | Output requests recorded during relaxation | FEM/FDM CPU/GPU; planner checks materialization | `sampling.outputs` |
| `Relaxation.algorithm` | `str` | `"llg_overdamped"` | $1$ | One of `llg_overdamped`, `projected_gradient_bb`, `nonlinear_cg`, `tangent_plane_implicit` | Relaxation algorithm identifier | See algorithm lanes below; `tangent_plane_implicit` is FEM-only and not yet executable | `algorithm` |
| `Relaxation.stop` | `RelaxStop` | `RelaxStop()` | mixed | Positive tolerances and step counts; one time bound at most | Canonical stop contract | FEM/FDM CPU/GPU | `stop` |
| `Relaxation.torque_tolerance` | `float \| None` | `1e-5` (legacy alias) | $\mathrm{T}$ | Positive; conflicts with `stop.torque_tolerance_apm` are rejected | Convergence threshold on torque | FEM/FDM CPU/GPU | `stop.torque_tolerance_apm` |
| `Relaxation.energy_tolerance` | `float \| None` | `None` | $\mathrm{J}$ | Positive when set | Energy-delta stop bound | FEM/FDM CPU/GPU | `stop.energy_tolerance_j` |
| `Relaxation.max_steps` | `int \| None` | `50000` (legacy alias) | $1$ | Positive integer | Maximum relaxation iterations | FEM/FDM CPU/GPU | `stop.max_steps` |
| `Relaxation.dynamics` | `LLG \| None` | `None` | mixed | Required by `llg_overdamped` only; direct minimizers reject it | LLG parameters for the overdamped lane | FDM/FEM CPU/GPU | `dynamics` |
| `Relaxation.table_autosave` | `TableAutosave \| None` | `None` | mixed | See {doc}`../outputs/autosave` | Tabular autosave policy | FEM/FDM CPU/GPU | `sampling.table_autosave` |

### Algorithm lanes

| Algorithm | Lane | Status |
|---|---|---|
| `llg_overdamped` | Damping-only LLG; precession disabled during relax | FDM/FEM CPU/GPU where LLG runs |
| `projected_gradient_bb` | Projected steepest descent with Barzilai–Borwein step selection | FDM/FEM CPU/GPU |
| `nonlinear_cg` | Nonlinear conjugate gradient, Polak–Ribière+, tangent-space transport | FDM/FEM CPU/GPU |
| `tangent_plane_implicit` | FEM-only linearly implicit tangent-plane relaxation | planned; not executable |

### Complete stage-first example

Relaxation is authored as an ordered stage, not as a standalone `Relaxation(...)` object in a user
script.

```python
# %% Zero-field projected-gradient relaxation
import fullmag as fm

nm = 1.0e-9

# %% Study and execution lane
study = fm.study("relaxation_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

# %% Geometry, material, initial state, and interactions
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 1.0
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.exchange()

# %% Relaxation stage with table autosave
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=2000,
    tolT=5.8349e-9,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=["step", "mx", "my", "mz", "e_ex", "e_total", "max_torque_T"],
        ),
        fields=[],
    )
)
```

The torque tolerance keywords are unit-suffixed (`tolT`, `tolA`) to avoid unit ambiguity; the
resolved stop contract records both the authored scale and the canonical A/m value.

(python-api-studies-relaxation-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`Relaxation.to_ir()` emits `{"kind": "relaxation", ...}` with `algorithm`, `stop`, `sampling`,
and, for the overdamped lane, `dynamics`. The final column above gives each serialized
destination.

(python-api-studies-relaxation-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent (algorithm choice, authored tolerances, time bound) is preserved in Python and
IR. Resolved execution (backend, device, precision, solver) is selected by the planner. Validation
errors reject unsupported algorithms, non-positive tolerances/step counts, conflicting legacy and
`RelaxStop` values, and `dynamics` supplied to a direct minimizer. Unsupported combinations fail
capability checks without silent fallback.

(python-api-studies-relaxation-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only. Numerical realization is documented in
{doc}`../../numerical-methods/relaxation/index`.

(python-api-studies-relaxation-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/study.py` (`class
Relaxation`, `RelaxStop`, `RelaxStep`) and the stage surface in
`packages/fullmag-py/src/fullmag/world.py` (`StudyStagesBuilder.add_relax`).

(python-api-studies-relaxation-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures and validate the adjacent source map.
The canonical scenario `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`
is the executed style reference.

(python-api-studies-relaxation-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable. `tangent_plane_implicit` is
a reserved FEM-only identifier and is not yet executable; planner capabilities are authoritative.

(python-api-studies-relaxation-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Algorithm references are owned by the relaxation numerical pages; no independent physical model is
introduced here.

(python-api-studies-relaxation-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/study.py` | `class Relaxation` | Canonical Python API behavior | Ownership test and source-map validator |
| Stop contract | `packages/fullmag-py/src/fullmag/model/study.py` | `class RelaxStop` | Tolerance and step normalization | Ownership test |
| Stage surface | `packages/fullmag-py/src/fullmag/world.py` | `StudyStagesBuilder.add_relax` | Stage-first authoring entrypoint | Ownership test |
