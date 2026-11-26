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

(python-api-meshing-fem-regions-symbols-and-si-units)=
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fem-regions-assumptions-and-validity)=
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

(python-api-meshing-fem-regions-problem-statement)=
## 1. What it is and when to use it

An object-owned region mesh policy refines a named region inside the shared
FEM domain. Use it for local size/order/transition control; it does not create
an independent solver mesh.

(python-api-meshing-fem-regions-governing-equations)=
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
region = body.add_region("core", fm.Box(40 * nm, 20 * nm, 4 * nm))
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
    dt=5.0e-13,
    tolA=1.0e-4,
    max_steps=1_000,
)
```

(python-api-meshing-fem-regions-python-api)=
## 4. Exact API

| Parameter/function | Type | Default | SI unit | Validation | Meaning |
|---|---|---|---|---|---|
| `ObjectRegion.mesh` | `mesh(*, maximum_element_size=None, minimum_element_size=None, transition_distance=None, order=None)` | inherited | mixed | `hmin <= hmax`; positive sizes; supported order | local mesh policy |
| `maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | strictly positive | upper local target |
| `minimum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | strictly positive | lower local target |
| `transition_distance` | `float \| None` | `None` | $\mathrm{m}$ | non-negative | blend distance |
| `order` | `int \| None` | `None` | $1$ | backend-supported order | local order request |

`ObjectRegion.mesh` rejects `minimum_element_size > maximum_element_size` and
invalid positive-value constraints. The policy is serialized into the owning
object's region mesh specification.

(python-api-meshing-fem-regions-problem-ir)=
## ProblemIR
The request lowers to the mesh-workflow or discretization subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-regions-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fem-regions-discrete-realization)=
## Discrete realization
The backend consumes the realized Cartesian or finite-element asset, including topology, markers, quality, and provenance where available.

## 5. How to set it in Control Room

Route: `Model Explorer -> Objects -> <object> -> Regions -> <region> -> Mesh` (`apps/control-room/src/modules/inspector/inspectors/objects/regions/RegionMeshSpec.tsx`, `ObjectRegionMeshInspectorPanel`).
When the region is committed on a FEM study, enable the region mesh override, set maximum/minimum element size,
transition distance, and finite-element order, then press **Apply**; **Apply & Build Shared-Domain Mesh** materializes
the conforming domain mesh and refreshes membership and quality resources (under FDM, the same panel becomes a read-only
structured-cell membership inspector). See {doc}`/frontend/meshing/region-mesh`,
[Control Room capability register](/frontend/capability-register), and
{ref}`numerical-methods-performance-fem-gpu-demag` for FEM GPU solver realization details.

```{image} /_static/images/ui/inspector-material-and-regions.png
:alt: Semantic Inspector region panel showing object-owned region configuration and overrides
:width: 92%
```

```{image} /_static/images/ui/inspector-fem-mesh-and-airbox.png
:alt: Semantic Inspector FEM mesh and airbox policy controls paired with region sizing
:width: 92%
```

(python-api-meshing-fem-regions-implementation-mapping)=
## 6. Backend and frontend support

| Lane | Status | Notes |
|---|---|---|
| FEM CPU/GPU | partial/planner-gated | Region policy is shared-domain input. |
| FDM CPU/GPU | not applicable | FDM regions are structured-cell membership. |
| Control Room | partial | Typed region fields are exposed; advanced conflict policies remain Python-only. |

(python-api-meshing-fem-regions-validation)=
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-regions-limitations)=
## 7. Limitations and known pitfalls

- A region policy cannot create an overlapping independent submesh.
- Selector and native marker resolution must succeed before it affects elements.
- Final conformity and values belong to the build report.

(python-api-meshing-fem-regions-scientific-bibliography)=
## 8. Scientific bibliography

1. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM, 2002.
2. C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element
   mesh generator,” *International Journal for Numerical Methods in Engineering*
   **79**, 1309-1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(python-api-meshing-fem-regions-source-code-index)=
## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| region markers and typed mesh realization | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L2358) | [`class MeshData`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L2358) | mesh realization and API tests |
| region mesh signature and validation | [`packages/fullmag-py/src/fullmag/model/structure.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L374) | `ObjectRegion.mesh` | source implementation |
| region policy resolution | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | region mesh policy builder | shared-domain lowering |
| region UI | [`apps/control-room/src/modules/inspector/inspectors/objects/regions/RegionMeshSpec.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/objects/regions/RegionMeshSpec.tsx#L71) | [`ObjectRegionMeshInspectorPanel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/objects/regions/RegionMeshSpec.tsx#L71) | frontend component |
