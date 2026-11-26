---
title: FDM Default Grid
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fdm-grid)=
# FDM Default Grid

Use the study/object mesh facade for ordinary scripts:

```text
study.objects.mesh.defaults(cell_size=(dx, dy, dz))
```

The tuple is the native cell size in metres. Object extents, integer shape, origin, active mask, and
padding are resolved later. The lower-level equivalent is `FDM(default_cell=(dx, dy, dz))`; the
legacy `cell=` alias is accepted only when `default_cell=` is absent.

Choose cell size from physical length scales and verify convergence. The API does not round an
invalid request into a silently different scientific model.

(python-api-meshing-fdm-grid-symbols-and-si-units)=
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fdm-grid-assumptions-and-validity)=
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

(python-api-meshing-fdm-grid-problem-statement)=
## 1. What it is and when to use it

The default grid defines the Cartesian cell size inherited by FDM objects
without a per-magnet override. Use it for a common regular grid; use
per-magnet grids when objects need different native resolutions.

(python-api-meshing-fdm-grid-governing-equations)=
## 2. Physical and mathematical explanation

This is an authoring policy and has no independent equation. The tuple
$(\Delta x,\Delta y,\Delta z)$ selects the discrete FDM space; integer shape,
origin, padding, and active-cell membership are resolved later.

## 3. Example - complete Python script

```python
# %% FDM default grid
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_default_grid")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 4 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", dt=5e-13, max_steps=100)
```

(python-api-meshing-fdm-grid-python-api)=
## 4. Exact API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fullmag.world.StudyObjectsMeshDefaultsHandle.__call__` | `Sequence[float] \| None` (`cell_size`) | `None` | $\mathrm{m}$ | exactly three positive values | stage-first default cell (`study.objects.mesh.defaults(cell_size=...)`) | FDM CPU/GPU; FEM not applicable to Cartesian grid authoring | `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three positive values | low-level default cell | FDM CPU/GPU; FEM not applicable to Cartesian grid authoring | `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | legacy alias; cannot coexist with `default_cell` | compatibility spelling | FDM CPU/GPU; FEM not applicable to Cartesian grid authoring | `backend_policy.discretization_hints.fdm.cell` |

Invalid length or non-positive values raise during authoring. The selected
values lower to `backend_policy.discretization_hints.fdm`. For FDM CPU/CUDA
acceleration details see {ref}`numerical-methods-performance-fdm-core`.

(python-api-meshing-fdm-grid-problem-ir)=
## ProblemIR
The request lowers to `backend_policy.discretization_hints.fdm`; requested intent remains distinct from the resolved grid descriptor and provenance report.

(python-api-meshing-fdm-grid-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fdm-grid-discrete-realization)=
## Discrete realization
The backend consumes the realized Cartesian grid asset, including origin, spacing, active mask, and provenance where available.

## 5. How to set it in Control Room

Route: `Model Explorer -> Mesh` (`apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx`, `MeshRootInspectorSpecPanel`) provides interactive FDM default grid sizing: switch between cell size ($\Delta x, \Delta y, \Delta z$) and cell count ($N_x, N_y, N_z$), toggle Single 3-D vs Multilayer Z-slices, review live $l_{\mathrm{ex}}$ resolution guards and quick-fix actions, snap counts to 7-smooth FFT dimensions, and execute **Save & Build Grid**. Detailed realized grid properties and region cell masks remain inspectable via `apps/control-room/src/modules/inspector/inspectors/mesh/fdm/FdmGridSpec.tsx` (`FdmGridInspectorSpecPanel`) while `FdmCuboidLayer` renders structured cells and region masks (`FMRM` / `FMBM`) in the 3D viewport. See {doc}`/frontend/meshing/fdm-grid-view` and [Control Room capability register](/frontend/capability-register).

```{image} /_static/images/ui/viewport-3d-interactive.png
:alt: 3D Viewport rendering FDM structured grid cells, vector glyphs, and domain frame
:width: 92%
```

(python-api-meshing-fdm-grid-implementation-mapping)=
## 6. Backend and frontend support

| Lane | Status | Notes |
|---|---|---|
| FDM CPU/GPU | authoring implemented | Planner and runtime still gate execution. |
| FEM CPU/GPU | not applicable | FEM uses element-size policies. |
| Control Room | interactive default sizing | `MeshRootInspectorSpecPanel` edits default FDM cell size/count and builds the grid; `FdmGridInspectorSpecPanel` and `FdmCuboidLayer` inspect realized grid metadata and cells. |

(python-api-meshing-fdm-grid-validation)=
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fdm-grid-limitations)=
## 7. Limitations and known pitfalls

- Cell size is not rounded to fit object extents.
- Prefer `default_cell` or the stage-first mesh facade over `FDM(cell=...)`.
- Construction does not prove a generated grid or solver run.

(python-api-meshing-fdm-grid-scientific-bibliography)=
## 8. Scientific bibliography

1. C. Abert, “Micromagnetics and spintronics: models and numerical methods,”
   *European Physical Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(python-api-meshing-fdm-grid-source-code-index)=
## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| FDM default grid policy and lowering | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L220) | [`class FDM`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L220) | constructor and IR tests |
| per-magnet Cartesian grid contract | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L19) | [`class FDMGrid`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L19) | constructor and API tests |
| stage-first default cell | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5799) | [`class StudyObjectsMeshDefaultsHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5799) | builder implementation |
| Control Room interactive FDM sizing | [`apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx#L52) | [`MeshRootInspectorSpecPanel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx#L52) | Control Room mesh inspector tests |
