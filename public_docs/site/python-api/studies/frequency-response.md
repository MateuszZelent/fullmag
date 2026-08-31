---
title: Frequency Response
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-frequency-response)=
# Frequency Response

(python-api-studies-frequency-response-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the public Python authoring contract and canonical lowering for the
linear-response study type. Solver mathematics and response qualification are owned by
{doc}`../../numerical-methods/frequency-domain/index`.

(python-api-studies-frequency-response-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Frequency response solves the linearized magnetization response to a small transverse excitation
field at prescribed frequencies. Equations, susceptibility definitions, and solver methods belong
to the frequency-domain numerical pages.

(python-api-studies-frequency-response-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Frequency is authored in hertz; the excitation field is in $\mathrm{A\,m^{-1}}$; phase is in
radians. $1$ denotes dimensionless data.

(python-api-studies-frequency-response-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check excitation
finite-ness, frequency positivity, equilibrium-source validity, solver-policy fallbacks, mesh
cardinality, capability, and backend legality.

(python-api-studies-frequency-response-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FrequencyResponse.outputs` | `Sequence[FrequencyOutputSpec]` | `required` | $1$ | At least one | Response observables | FEM/FDM CPU/GPU; planner checks materialization | `sampling.outputs` |
| `FrequencyResponse.frequencies_hz` | `Sequence[float]` | `required` | $\mathrm{Hz}$ | Non-empty, finite, positive | Sweep frequencies | FEM/FDM CPU/GPU | `frequencies_hz.values_hz` |
| `FrequencyResponse.excitation_field_au_per_m` | `tuple[float, float, float]` | `(0,0,1)` | $\mathrm{A\,m^{-1}}$ | Length-3 finite vector | Small transverse excitation field | FEM/FDM CPU/GPU | `excitation.field_au_per_m` |
| `FrequencyResponse.excitation_phase_rad` | `float` | `0.0` | $\mathrm{rad}$ | Finite | Excitation phase | FEM/FDM CPU/GPU | `excitation.phase_rad` |
| `FrequencyResponse.operator` | `str` | `"linearized_llg"` | $1$ | `linearized_llg` or `full_2x2` | Linearized operator | FEM/FDM CPU/GPU | `operator.kind` |
| `FrequencyResponse.include_demag` | `bool` | `True` | $1$ | Boolean | Include dynamic demagnetization | FEM/FDM CPU/GPU | `operator.include_demag` |
| `FrequencyResponse.equilibrium_source` | `str` | `"provided"` | $1$ | `provided`, `relax`, or `artifact` | Equilibrium acquisition | FEM/FDM CPU/GPU | `equilibrium` |
| `FrequencyResponse.magnetostatic_bc` | `str` | `"open"` | $1$ | `open`, `periodic_airbox_k0`, or `floquet_airbox` | Magnetostatic boundary condition | FEM/FDM CPU/GPU | `magnetostatic_bc` |
| `FrequencyResponse.solver_policy` | `FrequencyResponseSolverPolicy \| None` | `None` | mixed | Valid method/preconditioner/tolerance/iteration values | Solver method and preconditioner overrides | FEM/FDM CPU/GPU; several methods are planned | `solver_policy` |

### Supported solver methods

| Method | Status |
|---|---|
| `auto` | planner selects a supported method |
| `dense_reference`, `cpu_sparse_direct`, `full_coupled_field_split`, `schur_reduced`, `modal_reduced` | documented; execution state is backend-dependent |
| `gpu_operator_host_krylov`, `gpu_device_krylov` | planned device Krylov lanes |

### Complete stage-first example

Frequency response is authored as a stage after the equilibrium is provided or relaxed.

```python
# %% Linear-response frequency sweep
import fullmag as fm

nm = 1.0e-9

# %% Study and execution lane
study = fm.study("frequency_response_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

# %% Geometry, material, initial state, and interactions
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()

# %% Relax to equilibrium and solve a frequency sweep
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8)
study.stages.add_frequency_response(
    frequencies_hz=[1.0e9, 2.0e9, 3.0e9],
    excitation_field_au_per_m=(0.0, 1.0, 0.0),
    observable="susceptibility_tensor",
    equilibrium_source="relax",
    magnetostatic_bc="open",
)
```

(python-api-studies-frequency-response-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`FrequencyResponse.to_ir()` emits `{"kind": "frequency_response", ...}` with `dynamics`,
`operator`, `equilibrium`, `k_sampling`, `normalization`, `damping_policy`, `spin_wave_bc`,
`magnetostatic_bc`, `excitation`, `frequencies_hz`, `sampling`, and optional `solver_policy`.

(python-api-studies-frequency-response-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR; resolved execution and solver method are selected
by the planner. Validation errors reject empty sweeps, non-positive frequencies, malformed
excitation vectors, invalid operator/boundary-condition values, and inconsistent solver policy.
Unsupported combinations fail capability checks without silent fallback.

(python-api-studies-frequency-response-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only. Solver realizations are documented under
{doc}`../../numerical-methods/frequency-domain/index`.

(python-api-studies-frequency-response-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/study.py` (`class
FrequencyResponse`, `FrequencyResponseSolverPolicy`) and
`packages/fullmag-py/src/fullmag/world.py` (`StudyStagesBuilder.add_frequency_response`).

(python-api-studies-frequency-response-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures and validate the adjacent source map.

(python-api-studies-frequency-response-limitations)=
<!-- (limitations)= -->
## Limitations
Several solver methods and the GPU Krylov lanes are planned rather than production-qualified;
planner resolution is authoritative and must be reported as provenance.

(python-api-studies-frequency-response-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Solver and response-validation references belong to the frequency-domain numerical pages.

(python-api-studies-frequency-response-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Stage authoring and inspection are partial; the stage editor exposes only its advertised fields.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> Add stage -> <stage kind>` | `partial` | Submit stage draft; stage and downstream result resources are invalidated |
| Parameters without a named UI field | `Model Explorer -> Stages -> Add stage -> <stage kind>` | `not implemented` | Python-only until implemented |

not implemented: frontend support for study parameters not rendered by the stage editor.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx (StudyStageDraftEditor)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponse` | Canonical Python API behavior | Ownership test and source-map validator |
| Solver policy | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponseSolverPolicy` | Solver method/preconditioner normalization | Ownership test |
| Stage surface | `packages/fullmag-py/src/fullmag/world.py` | `StudyStagesBuilder.add_frequency_response` | Stage-first authoring entrypoint | Ownership test |

### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Frequency-response study parameters and IR lowering. | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponse` | Frequency-response study parameters and IR lowering. | Source-map validator and focused API tests |
| Frequency-response solver policy validation and lowering. | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponseSolverPolicy` | Frequency-response solver policy validation and lowering. | Source-map validator and focused API tests |
