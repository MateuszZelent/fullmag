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

(python-api-meshing-fdm-grid-python-api)=
<!-- (python-api)= -->
## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

(python-api-meshing-fdm-grid-problem-statement)=
<!-- (problem-statement)= -->
(python-api-meshing-fdm-grid-governing-equations)=
<!-- (governing-equations)= -->
(python-api-meshing-fdm-grid-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fdm-grid-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

## 1. What it is and when to use it

The default grid defines the Cartesian cell size inherited by FDM objects
without a per-magnet override. Use it for a common regular grid; use
per-magnet grids when objects need different native resolutions.

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

## 4. Exact API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `study.objects.mesh.defaults(cell_size=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three positive values | stage-first default cell | FDM CPU/GPU; FEM not applicable to Cartesian grid authoring | `mesh_workflow.build` |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three positive values | low-level default cell | FDM CPU/GPU; FEM not applicable to Cartesian grid authoring | `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | legacy alias; cannot coexist with `default_cell` | compatibility spelling | FDM CPU/GPU; FEM not applicable to Cartesian grid authoring | `backend_policy.discretization_hints.fdm.cell` |

Invalid length or non-positive values raise during authoring. The selected
values lower to `backend_policy.discretization_hints.fdm`.

(python-api-meshing-fdm-grid-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The request lowers to the mesh-workflow or discretization subtree; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fdm-grid-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fdm-grid-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The backend consumes the realized Cartesian or finite-element asset, including topology, markers, quality, and provenance where available.

## 5. How to set it in Control Room

Route: `Model Explorer -> Objects -> <object> -> Mesh` (`FdmObjectMeshPolicySection` in `ObjectMeshPolicyPanel.tsx`, backed by `resolveFdmObjectMeshInspectorModel` in `fdmMeshInspectorModel.ts`). Under the FDM lane, Control Room exposes grid origin, spacing, integer shape, active cell count, participation, and grid fingerprint as a **read-only** resource while `FdmCuboidLayer` renders structured cells and region masks (`FMRM` / `FMBM`) in the 3D viewport. FEM mesh-build controls are withheld, and authoring `dx`, `dy`, and `dz` remains Python-only (`not implemented` in the browser). See {doc}`/frontend/meshing/fdm-grid-view` and [Control Room capability register](/frontend/capability-register).

```{image} /_static/images/ui/viewport-3d-interactive.png
:alt: 3D Viewport rendering FDM structured grid cells, vector glyphs, and domain frame
:width: 92%
```

## 6. Backend and frontend support

| Lane | Status | Notes |
|---|---|---|
| FDM CPU/GPU | authoring implemented | Planner and runtime still gate execution. |
| FEM CPU/GPU | not applicable | FEM uses element-size policies. |
| Control Room | inspection-only | `FdmObjectMeshPolicySection` and `FdmCuboidLayer` display realized grid metadata and cells; interactive grid editing is not implemented. |

(python-api-meshing-fdm-grid-validation)=
<!-- (validation)= -->
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fdm-grid-limitations)=
<!-- (limitations)= -->
## 7. Limitations and known pitfalls

- Cell size is not rounded to fit object extents.
- Prefer `default_cell` or the stage-first mesh facade over `FDM(cell=...)`.
- Construction does not prove a generated grid or solver run.

(python-api-meshing-fdm-grid-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 8. Scientific bibliography

1. C. Abert, “Micromagnetics and spintronics: models and numerical methods,”
   *European Physical Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(python-api-meshing-fdm-grid-implementation-mapping)=
<!-- (implementation-mapping)= -->
(python-api-meshing-fdm-grid-source-code-index)=
<!-- (source-code-index)= -->
## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| stage-first default cell | `packages/fullmag-py/src/fullmag/world.py` | `StudyObjectsMeshDefaultsBuilder.defaults` | builder implementation |
| low-level aliases and validation | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDM.__init__` | constructor and IR implementation |
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Backend realization is in the relevant `backends/fdm` or `backends/fem` lane named by the page.


### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Per-magnet Cartesian grid contract. | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/discretization.py#L19) | [`class FDMGrid`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/discretization.py#L19) | Per-magnet Cartesian grid contract. | Source-map validator and focused API tests |
