---
title: Periodic Boundary Conditions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-boundary-conditions-periodic-boundary-conditions)=
# Periodic Boundary Conditions

(python-api-boundary-conditions-periodic-boundary-conditions-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Periodic boundary conditions repeat the domain along one or more axes and select a periodic
demagnetization policy.

(python-api-boundary-conditions-periodic-boundary-conditions-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Periodic demag mathematics belongs to {doc}`../../physics/interactions/demagnetization/periodic-demag`.

(python-api-boundary-conditions-periodic-boundary-conditions-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All fields are booleans, identifiers, or image counts.

(python-api-boundary-conditions-periodic-boundary-conditions-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
At least one axis must be periodic when a periodic demag policy or image count is requested.

(python-api-boundary-conditions-periodic-boundary-conditions-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `study.pbc(x, y, z, demag, images)` | method | axes all `False`, `demag="open"` | One axis required for periodic policy | PBC declaration | `pbc` |
| `PeriodicBC.pair_ids` | `Sequence[str]` | `required` | Non-empty pair ids | Mesh pair reference | `spin_wave_bc` / mesh pairs |
| `FdmPbc.axes` | `tuple[bool,bool,bool]` | required | Boolean per axis | Periodic axes | `pbc.axes` |

### Complete stage-first example

```python
# %% Periodic FDM slab with truncated-image demag
import fullmag as fm

nm = 1.0e-9

study = fm.study("periodic_bc_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
study.pbc(x=True, y=True, demag="truncated_images", images=(4, 4, 1))
film = study.geometry(fm.Box(100 * nm, 100 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-boundary-conditions-periodic-boundary-conditions-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
Problem-level PBC lowers to `pbc` with `axes`, `demag`, and optional `image_counts`; the planner
enforces FDM/FEM policy legality.

(python-api-boundary-conditions-periodic-boundary-conditions-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Image counts without a periodic axis and FEM-only policies on FDM fail immediately.

(python-api-boundary-conditions-periodic-boundary-conditions-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
FDM uses image-summation demag; FEM uses periodic mesh pairs or a k=0 airbox policy.

(python-api-boundary-conditions-periodic-boundary-conditions-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchors: `packages/fullmag-py/src/fullmag/world.py` (`pbc`) and
`packages/fullmag-py/src/fullmag/model/problem.py` (`FdmPbc`).

(python-api-boundary-conditions-periodic-boundary-conditions-validation)=
<!-- (validation)= -->
## Validation
Ownership and PBC capability tests cover policy legality.

(python-api-boundary-conditions-periodic-boundary-conditions-limitations)=
<!-- (limitations)= -->
## Limitations
`periodic_airbox_k0` is FEM-only; FDM supports `open` and `truncated_images`.

(python-api-boundary-conditions-periodic-boundary-conditions-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Demag policy references belong to the periodic-demag page.

(python-api-boundary-conditions-periodic-boundary-conditions-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| PBC declaration | `packages/fullmag-py/src/fullmag/world.py` | `pbc` | Problem-level PBC | Ownership and capability tests |
| PBC IR | `packages/fullmag-py/src/fullmag/model/problem.py` | `FdmPbc` | PBC lowering | Ownership test |
