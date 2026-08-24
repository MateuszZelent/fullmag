---
title: FEM Meshing API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-root)=
# FEM Meshing API

(python-api-meshing-fem-problem-statement)=
## Problem statement

`FEM(...)` supplies study-level finite-element defaults. Universe, ferromagnet, region, and build
facades add their own policy before the backend creates one conforming shared-domain mesh.

(python-api-meshing-fem-governing-equations)=
## Governing equations

This API introduces no independent interaction equation. It selects the finite-element space and
mesh asset used by weak-form operators, scalar-potential domains, eigenproblems, and response solves.

(python-api-meshing-fem-symbols-and-si-units)=
## Symbols and SI units

Element sizes, airbox geometry, layer thicknesses, interface distances, and transition distances are
SI metres. Orders, counts, algorithms, ratios, and quality controls are dimensionless.

(python-api-meshing-fem-assumptions-and-validity)=
## Assumptions and validity

Order must compare as at least one, but the low-level constructor does not currently reject Boolean
or non-integral numeric values. A positive maximum element size is required. `hmax` is an alias and must agree
with `maximum_element_size` when both are present. Imported mesh references are nonempty and remain
subject to native validation. Element-family/device support is capability-gated.

(python-api-meshing-fem-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---:|---:|---|---|---|---|
| `FEM.order` | `int` | required | 1 | Must compare as at least one; Boolean and non-integral numeric values are not rejected by this constructor. | Study-level finite-element field order. | FEM CPU; GPU element/order capability-gated | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float \| None` | `None` | m | Finite and positive; required unless hmax is supplied. | Canonical study-level maximum-size target. | FEM | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.hmax` | `float \| None` | `None` | m | Finite positive alias; equal to maximum_element_size when both are supplied. | Compatibility spelling of the same target. | FEM | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.mesh` | `str \| None` | `None` | 1 | Nonempty when present; asset is revalidated during extraction. | Imported or prebuilt FEM mesh reference. | FEM import/extraction path | `backend_policy.discretization_hints.fem.mesh` |
| `FEM.demag_solver_policy` | `FemLinearSolverPolicy \| None` | `None` | 1 | No explicit `FEM` constructor type check; lowering requires `to_ir()`. | Algebraic Poisson/demag solver request; not mesh geometry. | FEM demagnetization lanes | `backend_policy.discretization_hints.fem.demag_solver_policy` |

```python
# %% Complete stage-first FEM mesh scenario
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_meshing_api")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

film = study.geometry(fm.Box(300 * nm, 100 * nm, 5 * nm), name="film")
film.mesh(
    minimum_element_size=2.5 * nm,
    maximum_element_size=5 * nm,
    order=1,
    compute_quality=True,
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

(python-api-meshing-fem-problem-ir)=
## ProblemIR

The table covers constructor-owned request fields. Object/universe/region policies are separate
canonical resources. Resolved execution adds effective targets, element/facet families, markers,
selectors, fallbacks, quality statistics, versions, and the final mesh digest.

(python-api-meshing-fem-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent and resolved execution remain separate. Validation errors reject malformed sizes,
orders, and contradictory topology fields. Unsupported combinations fail capability checks.
Strict mode forbids silent replacement of requested prism, airbox shape, periodic, selector, or GPU
semantics.

(python-api-meshing-fem-discrete-realization)=
## Discrete realization

| Solver | Device | Contract |
|---|---|---|
| FEM | CPU | Gmsh/imported mesh extracted into native/MFEM host structures |
| FEM | GPU | identical content-addressed mesh; element/order/operator coverage is capability-gated |
| FDM | CPU/GPU | not applicable; use the FDM meshing API |

Meshing itself is normally a host/Gmsh operation even when the simulation executes on GPU.

(python-api-meshing-fem-implementation-mapping)=
## Implementation mapping

`FEM` owns study defaults. `PerObjectMeshRecipe`, `MeshOperation`, and `SweptMeshControls` own
ferromagnet topology. Universe and region facades add airbox and local-region policy. Backend reports
are authoritative for what ran.

`PerObjectMeshRecipe` and `MeshOperation` are internal model/lowering classes, not exports from the
top-level `fullmag` namespace. Public scripts configure their equivalent state through `body.mesh`
and its `thin_film`, `swept`, operation, and size-field helpers.

(python-api-meshing-fem-validation)=
## Validation

Validate geometry/volume, conformity, markers, selectors, Jacobians, quality tails, topology
certificates, mesh and layer convergence, airbox convergence, and CPU/GPU identity using one mesh
digest.

(python-api-meshing-fem-limitations)=
## Limitations

`hmax` is a target, exact layered support is intentionally bounded, swept hex is not production
enabled in the reviewed UI gate, and general multi-object or airbox-plus-swept support is
scenario-dependent.

(python-api-meshing-fem-scientific-bibliography)=
## Scientific bibliography

1. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM, 2002.
2. C. Geuzaine and J.-F. Remacle, “Gmsh,” *Int. J. Numer. Methods Eng.* **79**, 1309–1331 (2009).
3. R. Anderson et al., “MFEM,” *Comput. Math. Appl.* **81**, 42–74 (2021).

(python-api-meshing-fem-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| study defaults | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` | order, hmax alias, imported mesh, demag solver policy | signature and IR tests |
| object recipe | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class PerObjectMeshRecipe` | sizes, algorithms, topology, layers, fields, operations | validation and meshing tests |
| operation sequence | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class MeshOperation` | ordered mesh operations | serialization tests |
| typed swept controls | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class SweptMeshControls` | distribution, direction, family, transition, exact layers | validation tests |

```{toctree}
:maxdepth: 3

../../discretization/fem
study-defaults
../../discretization/mesh-controls
ferromagnet/index
airbox/index
regions
build-and-quality
```
