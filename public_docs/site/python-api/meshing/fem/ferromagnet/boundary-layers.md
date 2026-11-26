---
title: Boundary-Layer API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-boundary-layers)=
# Boundary-Layer API

(python-api-meshing-fem-ferromagnet-boundary-layers-symbols-and-si-units)=
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless counts, ratios, and selectors use $1$.

(python-api-meshing-fem-ferromagnet-boundary-layers-assumptions-and-validity)=
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized mesh report (`MeshOperationStatus`) is authoritative.

(python-api-meshing-fem-ferromagnet-boundary-layers-problem-statement)=
## 1. What it is and when to use it

Boundary layers are anisotropic near-wall refinement layers seeded from selected
object surfaces or curves through a Gmsh `BoundaryLayer` field. In Fullmag,
executable boundary layers are authored via object recipe fields
(`boundary_layer_count`, `boundary_layer_thickness`,
`boundary_layer_stretching`) together with explicit target selectors
(`boundary_layer_target_surface_selectors`,
`boundary_layer_target_curve_selectors`) or raw Gmsh entity tags
(`boundary_layer_target_surface_tags`, `boundary_layer_target_curve_tags`).

Although `PerObjectMeshRecipe.operations` accepts
`MeshOperation(kind="boundary_layers", params=...)` in the authoring schema,
the shared-domain realization pipeline has no validated executor for authored
`operations` sequences and fails closed with `ValueError` at build time. Use
the `boundary_layer_*` recipe fields for executable boundary-layer requests.

When to use it:

- strong field or energy gradients at surfaces (surface anisotropy, interface
  layers, edge-resolved domains),
- normal-to-wall resolution without uniform global refinement.

Impact on the simulation: layers improve normal resolution near targeted
boundaries at controlled cost; excessive `boundary_layer_stretching` degrades
element Jacobian quality and can harm solver convergence. If explicit target
surfaces or curves are omitted (or match zero entities), the mesher records the
boundary-layer request as `ignored` rather than silently applying it to the
entire model.

(python-api-meshing-fem-ferromagnet-boundary-layers-governing-equations)=
## 2. Physical and mathematical explanation

This page introduces no PDE of its own; it controls near-wall discretization
anisotropy. In `_add_boundary_layer_field`, `boundary_layer_thickness` sets the
**first-layer wall thickness** $t_1$ (passed to Gmsh as `hwall_n` and
`thickness`), and successive layers grow geometrically by the stretching ratio
$s$:

$$
t_i \;=\; t_1\,s^{\,i-1}, \qquad T \;=\; \sum_{i=1}^{N} t_i,
$$

where $t_1$ is the first-layer wall thickness (`boundary_layer_thickness`,
$\mathrm{m}$), $t_i$ is the thickness of the $i$-th layer ($\mathrm{m}$), $s$
is the stretching ratio (`boundary_layer_stretching`, $1$; runtime fallback
$1.2$ when omitted, typically $1 < s \le 2$), $T$ is the resulting total stack
thickness ($\mathrm{m}$), and $N$ is the layer count (`boundary_layer_count`,
$1$).

| Symbol | Meaning | SI unit |
|---|---|---|
| $t_1$ | first-layer wall thickness (`boundary_layer_thickness`, Gmsh `hwall_n`) | $\mathrm{m}$ |
| $t_i$ | thickness of the $i$-th layer | $\mathrm{m}$ |
| $s$ | stretching ratio (`boundary_layer_stretching`) | $1$ |
| $T$ | resulting total boundary-layer stack thickness | $\mathrm{m}$ |
| $N$ | number of layers (`boundary_layer_count`) | $1$ |

## 3. Example — complete Python script

```python
# %% Boundary layers on a targeted film surface via recipe fields
import fullmag as fm

nm = 1.0e-9

study = fm.study("boundary_layer_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
study.universe.mesh(maximum_element_size=100 * nm)
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
    boundary_layer_target_surface_selectors=[
        {
            "kind": "nearest_surface_to_point",
            "point": [150 * nm, 50 * nm, 5 * nm],
            "count": 1,
        }
    ],
)

study.exchange()
study.demag(model="airbox", variant="robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", algorithm="projected_gradient_bb", tolT=1.0e-6)
```

(python-api-meshing-fem-ferromagnet-boundary-layers-python-api)=
## 4. Exact API

**Executable recipe fields** (`object.mesh(...)` / `GeometryMeshHandle.configure(...)` / `PerObjectMeshRecipe`):

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `boundary_layer_count` | `int \| None` | `None` | $1$ | integer >= 1 | layer count | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `boundary_layer_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive finite float | first-layer wall thickness (`hwall_n`) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `boundary_layer_stretching` | `float \| None` | `None` | $1$ | positive finite float (runtime fallback 1.2) | thickness growth ratio between layers | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `boundary_layer_target_surface_selectors` | `Sequence[Mapping[str, object]] \| None` | `None` | $1$ | semantic selector dicts | target surfaces (converted to boundary curves) | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `boundary_layer_target_curve_selectors` | `Sequence[Mapping[str, object]] \| None` | `None` | $1$ | semantic selector dicts | target edges / curves | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `boundary_layer_target_surface_tags` | `Sequence[int] \| None` | `None` | $1$ | Gmsh surface tags | raw numeric surface targets | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |
| `boundary_layer_target_curve_tags` | `Sequence[int] \| None` | `None` | $1$ | Gmsh curve tags | raw numeric curve targets | FEM CPU/GPU; FDM not applicable to this mesh policy | `mesh_workflow` |

**Non-executable operation schema (`PerObjectMeshRecipe.operations`)**:
`MeshOperation(kind="boundary_layers", params=...)` is accepted by the
`PerObjectMeshRecipe` dataclass schema, but shared-domain mesh realization
(`_validate_declared_mesh_operations` and
`_validate_per_object_recipe_operations`) fails closed with
`ValueError("mesh operation executor unavailable: kind='boundary_layers' ...")`
for any declared operation entry. Do not author `operations` expecting
boundary-layer execution; use the recipe fields in the table above.

Prefer **semantic selectors**: numeric Gmsh tags are not stable across geometry
rebuilds.

Failure behavior:

- `boundary_layer_count < 1`, or non-positive / non-finite
  `boundary_layer_thickness` or `boundary_layer_stretching`, raises
  `ValueError` (or `TypeError` for non-numeric / boolean values) at authoring
  time.
- Omitting all target selectors and tags — or supplying selectors that match
  zero geometry entities — does not raise at authoring time; instead
  `_add_boundary_layer_field` marks the operation `status="ignored"` in
  `MeshOperationStatus(kind="boundary_layer", ...)` with an explicit reason.
- Declaring any `MeshOperation` entry in `operations` raises `ValueError`
  before mesh generation starts.

ProblemIR mapping: the `boundary_layer_*` recipe fields lower into
`mesh_workflow.per_geometry[*]` (and `mesh_workflow.mesh_options` /
`default_mesh` when set at defaults scope). Realization reports
`MeshOperationStatus(kind="boundary_layer", ...)` with
`details={"first_layer_thickness": ..., "stretching": ..., "experimental": True}`.

(python-api-meshing-fem-ferromagnet-boundary-layers-problem-ir)=
## ProblemIR
The request lowers to the `mesh_workflow` subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-ferromagnet-boundary-layers-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, missing targets are reported explicitly as `ignored`, and unsupported combinations (including authored operation sequences) fail closed without silent fallback.

(python-api-meshing-fem-ferromagnet-boundary-layers-discrete-realization)=
## Discrete realization
The backend consumes the realized finite-element asset, including topology, markers, quality, and `MeshOperationStatus` provenance (`applied`, `degraded`, or `ignored`). Surface targets are converted to boundary curves via Gmsh `getBoundary` before configuring `BoundaryLayer`.

## 5. How to set it in Control Room

```
Model Explorer
└── Objects
    └── <object>
        └── Mesh            → selection kind: object.mesh
```

The **Object Mesh Policy** inspector (`ObjectMeshInspectorSpecPanel` in
`apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx`)
exposes the boundary-layer recipe fields under *Backend Mesh Parameters*, while
*Advanced JSON* edits the canonical recipe payload (note that authoring
`operations` entries fails closed at shared-domain build time). Full panel
description: {doc}`../../../../frontend/meshing/object-mesh`.

(python-api-meshing-fem-ferromagnet-boundary-layers-implementation-mapping)=
## 6. Backend support

| Solver | Device | Status | Notes |
|---|---|---|---|
| FEM | CPU | partial (experimental) | realized through Gmsh `BoundaryLayer` field (`first_layer_thickness`); requires explicit target selectors or tags; `MeshOperation(kind="boundary_layers")` fails closed |
| FEM | GPU | capability-gated | consumes the identical content-addressed mesh; see {ref}`numerical-methods-performance-fem-gpu-demag` |
| FDM | CPU/GPU | not applicable | no boundary-layer concept on a Cartesian grid |

(python-api-meshing-fem-ferromagnet-boundary-layers-validation)=
## Validation
Focused constructor, lowering, selector-resolution, fail-closed operation validation, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-ferromagnet-boundary-layers-limitations)=
## 7. Limitations and known pitfalls

- `boundary_layer_thickness` specifies the **first-layer** wall thickness
  (`hwall_n`), not the total stack thickness $T$; verify
  $T = t_1 \sum_{i=0}^{N-1} s^i$ against film thickness before requesting
  multiple layers.
- `MeshOperation(kind="boundary_layers", params=...)` in
  `PerObjectMeshRecipe.operations` has no validated shared-domain executor and
  fails closed with `ValueError`.
- Omitting target selectors/tags causes `_add_boundary_layer_field` to return
  `status="ignored"` instead of applying globally.
- Numeric Gmsh tags are unstable across geometry rebuilds — use semantic
  selectors.
- Stretching close to or above $2$ can produce poor-Jacobian elements; check
  mesh quality statistics after the build.

(python-api-meshing-fem-ferromagnet-boundary-layers-scientific-bibliography)=
## 8. Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh,” *Int. J. Numer. Methods Eng.* **79**, 1309–1331 (2009).

(python-api-meshing-fem-ferromagnet-boundary-layers-source-code-index)=
## 9. Source-code index

| Claim | Path | Symbol | Evidence |
|---|---|---|---|
| object boundary-layer recipe validation and lowering | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | [`class PerObjectMeshRecipe`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | recipe validation tests |
| mesh operation dataclass schema (fail-closed at build) | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L583) | [`class MeshOperation`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L583) | fail-closed operation tests |
| boundary-layer authoring handle | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1811) | [`GeometryMeshHandle.configure`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1811) | signature (`boundary_layer_*`) |
| Gmsh `BoundaryLayer` field (`hwall_n` first-layer thickness, explicit targets) | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py#L703) | [`_add_boundary_layer_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py#L703) | boundary-layer field tests |
| fail-closed validation of declared mesh operations | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L927) | [`_validate_declared_mesh_operations`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L927) | fallback and rejection tests |
| boundary-layer `MeshOperationStatus` reporting | [`packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py#L518) | [`MeshOperationStatus`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py#L585) | mesh build report tests |
| Control Room object mesh inspector | [`apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx#L181) | [`ObjectMeshInspectorSpecPanel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx#L181) | frontend inspector component |
