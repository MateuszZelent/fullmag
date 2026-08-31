---
title: Boundary-Layer API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-boundary-layers)=
# Boundary-Layer API

(python-api-meshing-fem-ferromagnet-boundary-layers-python-api)=
<!-- (python-api)= -->
## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

(python-api-meshing-fem-ferromagnet-boundary-layers-problem-statement)=
<!-- (problem-statement)= -->
(python-api-meshing-fem-ferromagnet-boundary-layers-governing-equations)=
<!-- (governing-equations)= -->
(python-api-meshing-fem-ferromagnet-boundary-layers-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fem-ferromagnet-boundary-layers-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

## 1. What it is and when to use it

Boundary layers are anisotropic element refinement near selected object
surfaces/edges. In Fullmag you author them through recipe fields
(`boundary_layer_count/thickness/stretching`) or an explicit
`MeshOperation(kind="boundary_layers", params=...)` in an advanced recipe.

When to use it:

- strong field/energy gradients at surfaces (EASA, surface anisotropy,
  interface layers),
- normal-to-wall resolution without global refinement.

Impact on the simulation: layers improve normal resolution at controlled cost;
excessive `stretching` degrades Jacobian quality and can harm convergence.

## 2. Physical and mathematical explanation

This page introduces no equation of its own; it controls discretization
anisotropy. A typical layer thickness distribution is geometric:

$$
t_i \;=\; t_1\,s^{\,i-1}, \qquad T \;=\; \sum_{i=1}^{N} t_i,
$$

where $t_i$ — thickness of the $i$-th layer ($\mathrm{m}$), $s$ — stretching
ratio ($1$, usually $1{<}s{\le}2$), $T$ — total package thickness ($\mathrm{m}$),
$N$ — layer count ($1$).

| Symbol | Meaning | SI unit |
|---|---|---|
| $t_i$ | thickness of the $i$-th layer | $\mathrm{m}$ |
| $s$ | stretching (thickness growth) | $1$ |
| $T$ | total boundary-layer thickness | $\mathrm{m}$ |
| $N$ | number of layers | $1$ |

## 3. Example — complete Python script

```python
# %% Boundary layers on a film surface via advanced recipe fields
import fullmag as fm

nm = 1.0e-9

study = fm.study("boundary_layer_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
film = study.geometry(fm.Box(300 * nm, 100 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film.mesh(
    minimum_element_size=2.5 * nm,
    maximum_element_size=5 * nm,
    order=1,
    boundary_layer_count=2,
    boundary_layer_thickness=1.0 * nm,
    boundary_layer_stretching=1.5,
)

study.exchange()
study.demag(model="airbox", variant="robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

## 4. Exact API

Two equivalent authoring levels:

**Recipe fields** (`object.mesh(...)` / `PerObjectMeshRecipe`):

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `boundary_layer_count` | `int \| None` | `None` | $1$ | positive | layer count | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `boundary_layer_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive | total package thickness | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `boundary_layer_stretching` | `float \| None` | `None` | $1$ | in $(1, 2]$ | thickness growth between layers | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `boundary_layer_target_surface_selectors` | `Sequence[Mapping] \| None` | `None` | $1$ | semantic selectors | target surfaces | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `boundary_layer_target_curve_selectors` | `Sequence[Mapping] \| None` | `None` | $1$ | semantic selectors | target edges | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `boundary_layer_target_surface_tags` / `_curve_tags` | `Sequence[int] \| None` | `None` | $1$ | Gmsh tags | raw numeric targets | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |

**Ordered operation**: `MeshOperation(kind="boundary_layers", params=...)`
inside `PerObjectMeshRecipe.operations`; `params` keys cover count, total
thickness, stretching, and the same selectors/tags.

Prefer **semantic selectors**: numeric Gmsh tags are not stable across geometry
rebuilds.

Failure behavior: non-positive count/thickness, stretching outside $(1,2]$ →
`ValueError`; unknown `params` keys → operation validation error.

ProblemIR mapping: fields land in the object recipe (`PerObjectMeshRecipe`) and in
the ordered mesh-operation list.

(python-api-meshing-fem-ferromagnet-boundary-layers-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The request lowers to the mesh-workflow or discretization subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-ferromagnet-boundary-layers-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fem-ferromagnet-boundary-layers-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The backend consumes the realized Cartesian or finite-element asset, including topology, markers, quality, and provenance where available.

## 5. How to set it in Control Room

```
Model Explorer
└── Objects
    └── <object>
        └── Mesh            → selection kind: object.mesh
```

The **Object Mesh Policy** inspector: the *Backend Mesh Parameters* group holds
the boundary-layer fields; the *Advanced JSON* group accepts the full canonical
recipe payload (including `operations`). Full panel description:
{doc}`../../../../frontend/meshing/object-mesh`.

## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | partial | realized through Gmsh boundary layers; selector targets depend on geometry |
| FEM | GPU | capability-gated | identical content-addressed mesh |
| FDM | CPU/GPU | not applicable | no boundary-layer concept on a Cartesian grid |

(python-api-meshing-fem-ferromagnet-boundary-layers-validation)=
<!-- (validation)= -->
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-ferromagnet-boundary-layers-limitations)=
<!-- (limitations)= -->
## 7. Limitations and known pitfalls

- Numeric Gmsh tags are unstable across geometry rebuilds — use semantic
  selectors.
- Stretching close to $2$ can produce poor-Jacobian elements; check quality
  statistics after the build.

(python-api-meshing-fem-ferromagnet-boundary-layers-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 8. Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh,” *Int. J. Numer. Methods Eng.* **79**, 1309–1331 (2009).

(python-api-meshing-fem-ferromagnet-boundary-layers-implementation-mapping)=
<!-- (implementation-mapping)= -->
(python-api-meshing-fem-ferromagnet-boundary-layers-source-code-index)=
<!-- (source-code-index)= -->
## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| boundary-layer fields | `packages/fullmag-py/src/fullmag/world.py` | `GeometryMeshHandle.configure` | signature (`boundary_layer_*`) |
| mesh operation spec | `packages/fullmag-py/src/fullmag/world.py` | `_MeshOperationSpec` | class definition |
| object recipe | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe.boundary_layer_count` | validation tests |
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Backend realization is in the relevant `backends/fdm` or `backends/fem` lane named by the page.


### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Object boundary-layer policy and lowering. | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class PerObjectMeshRecipe` | Object boundary-layer policy and lowering. | Source-map validator and focused API tests |
