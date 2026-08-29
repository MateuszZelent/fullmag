---
title: Boolean Operations
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-boolean-operations)=
# Boolean Operations

(python-api-geometry-boolean-operations-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Boolean operations combine two geometries into CSG difference, union, or intersection.

(python-api-geometry-boolean-operations-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; booleans are boundary-representation semantics.

(python-api-geometry-boolean-operations-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All fields are geometry references or names.

(python-api-geometry-boolean-operations-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Names must be non-empty; operand geometries are validated independently.

(python-api-geometry-boolean-operations-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Meaning | ProblemIR |
|---|---|---|---|---|
| `A - B` | `Difference` | base `A`, tool `B` | CSG difference | `kind="difference"` |
| `A + B` | `Union` | operands `a`, `b` | CSG union | `kind="union"` |
| `A & B` | `Intersection` | operands `a`, `b` | CSG intersection | `kind="intersection"` |

### Complete stage-first example

```python
# %% Box with a cylindrical hole
import fullmag as fm

nm = 1.0e-9

study = fm.study("boolean_operations_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
body = fm.Box(100 * nm, 100 * nm, 20 * nm) - fm.Cylinder(radius=30 * nm, height=20 * nm)
film = study.geometry(body, name="perforated_film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-geometry-boolean-operations-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
Each operation emits its `kind` plus the operand IR trees (`base`/`tool` or `a`/`b`).

(python-api-geometry-boolean-operations-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Malformed operand names fail immediately; degenerate boolean results are resolved at mesh time.

(python-api-geometry-boolean-operations-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
FDM voxelization and FEM meshing both consume the same CSG tree.

(python-api-geometry-boolean-operations-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/geometry.py` (`Difference`, `Union`,
`Intersection`).

(python-api-geometry-boolean-operations-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-geometry-boolean-operations-limitations)=
<!-- (limitations)= -->
## Limitations
Boolean topology must be waterproof for FEM meshing; FDM voxelization applies its own
discretization boundary.

(python-api-geometry-boolean-operations-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-geometry-boolean-operations-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Basic object/shape fields are partial; advanced boolean, imported, auxiliary, and transform parameters remain TODO.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Objects -> <object> -> Geometry` | `partial` | Apply geometry draft; object resources become stale |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Geometry` | `TODO` | Python-only until implemented |

TODO: frontend support for every geometry parameter not rendered by GeometryObjectPanel.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx (GeometryObjectPanel)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| CSG operations | `packages/fullmag-py/src/fullmag/model/geometry.py` | `Difference`, `Union`, `Intersection` | Boolean geometry lowering | Ownership test |
