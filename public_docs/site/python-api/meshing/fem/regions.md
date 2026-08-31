---
title: FEM Region Mesh API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-regions)=
# FEM Region Mesh API

Object-owned regions can carry a local mesh policy with maximum/minimum element size, transition
distance, order, priority, and realization policy.

Region policy participates in the same shared-domain mesh; it does not create an independent
overlapping submesh. Conflicts are resolved by explicit priority/conflict policy and recorded in the
realization report.

(python-api-meshing-fem-regions-python-api)=
<!-- (python-api)= -->
## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

(python-api-meshing-fem-regions-problem-statement)=
<!-- (problem-statement)= -->
(python-api-meshing-fem-regions-governing-equations)=
<!-- (governing-equations)= -->
(python-api-meshing-fem-regions-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fem-regions-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

## 1. What it is and when to use it

An object-owned region mesh policy refines a named region inside the shared
FEM domain. Use it for local size/order/transition control; it does not create
an independent solver mesh.

## 2. Physical and mathematical explanation

The region policy selects a local finite-element resolution. It has no own
physical equation; its effect is through the local discrete space and shared-
domain conformity constraints.

## 3. Example - complete Python script

```python
# %% Region-local FEM mesh policy
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_region_mesh")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
body = study.geometry(fm.Box(80 * nm, 40 * nm, 4 * nm), name="film")
region = body.regions.add_box("core", size=(40 * nm, 20 * nm, 4 * nm))
region.mesh(maximum_element_size=3 * nm, minimum_element_size=1.5 * nm,
            transition_distance=5 * nm, order=1)
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    tolA=1.0e-4,
    max_steps=1_000,
)
```

## 4. Exact API

| Parameter/function | Type | Default | SI unit | Validation | Meaning |
|---|---|---|---|---|---|
| `ObjectRegion.mesh` | `mesh(*, maximum_element_size=None, minimum_element_size=None, transition_distance=None, order=None)` | inherited | mixed | hmin <= hmax; positive sizes; supported order | local mesh policy |
| `maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | strictly positive | upper local target |
| `minimum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | strictly positive | lower local target |
| `transition_distance` | `float \| None` | `None` | $\mathrm{m}$ | non-negative | blend distance |
| `order` | `int \| None` | `None` | $1$ | backend-supported order | local order request |

`ObjectRegion.mesh` rejects `minimum_element_size > maximum_element_size` and
invalid positive-value constraints. The policy is serialized into the owning
object's region mesh specification.

(python-api-meshing-fem-regions-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The request lowers to the mesh-workflow or discretization subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-regions-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fem-regions-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The backend consumes the realized Cartesian or finite-element asset, including topology, markers, quality, and provenance where available.

## 5. How to set it in Control Room

Route: `Model Explorer -> Objects -> <object> -> Regions -> <region> -> Mesh`.
Enable the regional override, set maximum/minimum size, transition distance,
and order, then press **Apply**. **Build Shared-Domain Mesh** materializes the
conforming result and refreshes region resources. See [Control Room capability register](/frontend/capability-register).

## 6. Backend and frontend support

| Lane | Status | Notes |
|---|---|---|
| FEM CPU/GPU | partial/planner-gated | Region policy is shared-domain input. |
| FDM CPU/GPU | not applicable | FDM regions are structured-cell membership. |
| Control Room | partial | Typed region fields are exposed; advanced conflict policies remain not implemented. |

(python-api-meshing-fem-regions-validation)=
<!-- (validation)= -->
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-regions-limitations)=
<!-- (limitations)= -->
## 7. Limitations and known pitfalls

- A region policy cannot create an overlapping independent submesh.
- Selector and native marker resolution must succeed before it affects elements.
- Final conformity and values belong to the build report.

(python-api-meshing-fem-regions-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 8. Scientific bibliography

1. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM, 2002.
2. C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element
   mesh generator,” *International Journal for Numerical Methods in Engineering*
   **79**, 1309-1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(python-api-meshing-fem-regions-implementation-mapping)=
<!-- (implementation-mapping)= -->
(python-api-meshing-fem-regions-source-code-index)=
<!-- (source-code-index)= -->
## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| region mesh signature and validation | `packages/fullmag-py/src/fullmag/model/structure.py` | `ObjectRegion.mesh` | source implementation |
| region policy resolution | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | region mesh policy builder | shared-domain lowering |
| region UI | `apps/control-room/src/modules/inspector/panels/region/ObjectRegionMeshPanel.tsx` | `ObjectRegionMeshPanel` | frontend component |
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Backend realization is in the relevant `backends/fdm` or `backends/fem` lane named by the page.


### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Region markers and typed mesh realization. | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `class MeshData` | Region markers and typed mesh realization. | Source-map validator and focused API tests |
