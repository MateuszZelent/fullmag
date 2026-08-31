---
title: Eigenmodes
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-eigenmodes)=
# Eigenmodes

(python-api-studies-eigenmodes-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the public Python authoring contract and canonical lowering for the
spin-wave eigenmode study type. Operator mathematics and modal validation are owned by
{doc}`../../numerical-methods/eigensolvers/index`.

(python-api-studies-eigenmodes-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Eigenmodes solve the linearized magnetization operator about an equilibrium; the implemented
operator identifiers are `linearized_llg` and `full_2x2`. Mathematical formulation and the
demagnetization inclusion contract are documented under the numerical eigensolver pages.

(python-api-studies-eigenmodes-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Frequencies are authored and reported in hertz; wave-vector sampling is in $\mathrm{m^{-1}}$.
$1$ denotes dimensionless data.

(python-api-studies-eigenmodes-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check equilibrium-source
validity, operator/target constraints, mesh cardinality, capability, and backend legality.

(python-api-studies-eigenmodes-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Eigenmodes.outputs` | `Sequence[EigenOutputSpec]` | `required` | $1$ | At least one; `SaveResponse` is rejected | Mode/spectrum/dispersion/diagnostic outputs | FDM/FEM CPU/GPU; planner checks materialization | `sampling.outputs` |
| `Eigenmodes.count` | `int` | `20` | $1$ | Positive | Number of eigenvectors requested | FEM/FDM CPU/GPU | `count` |
| `Eigenmodes.target` | `str` | `"lowest"` | $1$ | `lowest`, `nearest`, or `frequency_window` | Eigenvalue selection policy | FEM/FDM CPU/GPU | `target` |
| `Eigenmodes.target_frequency` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive; required for `nearest` | Frequency target for nearest modes | FEM/FDM CPU/GPU | `target.frequency_hz` |
| `Eigenmodes.frequency_min` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive lower bound; required with `frequency_window` | Lower frequency-window bound | FEM/FDM CPU/GPU | `target.frequency_min_hz` |
| `Eigenmodes.frequency_max` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive upper bound; `min < max`; required with `frequency_window` | Upper frequency-window bound | FEM/FDM CPU/GPU | `target.frequency_max_hz` |
| `Eigenmodes.operator` | `str` | `"linearized_llg"` | $1$ | `linearized_llg` or `full_2x2` | Linearized operator | FEM/FDM CPU/GPU | `operator.kind` |
| `Eigenmodes.include_demag` | `bool` | `True` | $1$ | Boolean | Include the dynamic demagnetization term | FEM/FDM CPU/GPU | `operator.include_demag` |
| `Eigenmodes.equilibrium_source` | `str` | `"relax"` (stage entry default) | $1$ | `provided`, `relax`, or `artifact` | Equilibrium acquisition | FEM/FDM CPU/GPU | `equilibrium` |
| `Eigenmodes.k_sampling` | `object \| None` | `None` | $\mathrm{m^{-1}}$ | Valid k sampling or k vector | Wave-vector sampling | FEM/FDM CPU/GPU | `k_sampling` |
| `Eigenmodes.normalization` | `str` | `"unit_l2"` | $1$ | `unit_l2` or `unit_max_amplitude` | Mode normalization | FEM/FDM CPU/GPU | `normalization` |
| `Eigenmodes.damping_policy` | `str` | `"ignore"` | $1$ | `ignore` or `include` | Damping treatment | FEM/FDM CPU/GPU | `damping_policy` |
| `Eigenmodes.spin_wave_bc` | `str \| mapping \| PeriodicBC \| FloquetBC` | `"free"` | $1$ | One of `free`, `pinned`, `periodic`, `floquet`, `surface_anisotropy` | Spin-wave boundary condition | FEM/FDM CPU/GPU | `spin_wave_bc` |

### Complete stage-first example

Eigenmode analysis is authored as a stage; the equilibrium is either relaxed first or imported
from an artifact.

```python
# %% Spin-wave eigenmodes about a relaxed equilibrium
import fullmag as fm

nm = 1.0e-9

# %% Study and execution lane
study = fm.study("eigenmodes_api_example")
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

# %% Relax to equilibrium, then solve for the lowest modes
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8)
study.stages.add_eigenmodes(
    count=8,
    target="lowest",
    operator="linearized_llg",
    include_demag=True,
    equilibrium_source="relax",
    bc="free",
)
```

(python-api-studies-eigenmodes-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`Eigenmodes.to_ir()` emits `{"kind": "eigenmodes", ...}` with `dynamics`, `operator`,
`count`, `target`, `equilibrium`, `k_sampling`, `normalization`, `damping_policy`,
`spin_wave_bc`, and `sampling`.

(python-api-studies-eigenmodes-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR; resolved execution is selected by the planner.
Validation errors reject empty outputs, non-positive counts, invalid operator/target/normalization/
damping values, and mismatched target bounds. Unsupported combinations fail capability checks
without silent fallback.

(python-api-studies-eigenmodes-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only. Operator discretization and modal validation are
documented under {doc}`../../numerical-methods/eigensolvers/index`.

(python-api-studies-eigenmodes-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/study.py` (`class
Eigenmodes`) and `packages/fullmag-py/src/fullmag/world.py` (`StudyStagesBuilder.add_eigenmodes`).

(python-api-studies-eigenmodes-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures and validate the adjacent source map.

(python-api-studies-eigenmodes-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every operator/equilibrium/boundary-condition combination
executable on every backend; planner and eigensolver capability resolution are authoritative.

(python-api-studies-eigenmodes-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Operator and validation references belong to the eigensolver numerical pages.

(python-api-studies-eigenmodes-source-code-index)=
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
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/study.py` | `class Eigenmodes` | Canonical Python API behavior | Ownership test and source-map validator |
| k-vector normalization | `packages/fullmag-py/src/fullmag/model/eigen.py` | `coerce_k_sampling` | k sampling alias resolution | Ownership test |
| Stage surface | `packages/fullmag-py/src/fullmag/world.py` | `StudyStagesBuilder.add_eigenmodes` | Stage-first authoring entrypoint | Ownership test |

### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Eigenmode study parameters and IR lowering. | `packages/fullmag-py/src/fullmag/model/study.py` | `class Eigenmodes` | Eigenmode study parameters and IR lowering. | Source-map validator and focused API tests |
