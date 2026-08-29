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

## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

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
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", max_steps=100)
```

## 4. Exact API

| Parameter | Type | Default | SI unit | Validation | Meaning |
|---|---|---|---|---|---|
| `study.objects.mesh.defaults(cell_size=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three positive values | stage-first default cell |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | exactly three positive values | low-level default cell |
| `FDM.cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | legacy alias; cannot coexist with `default_cell` | compatibility spelling |

Invalid length or non-positive values raise during authoring. The selected
values lower to `backend_policy.discretization_hints.fdm`.

## 5. How to set it in Control Room

Route: `Model Explorer -> Study -> Discretization -> FDM default cell`. Enter
`dx`, `dy`, and `dz` in metres and apply the study draft. The effective grid
and dependent grid resources are refreshed. Per-magnet overrides are a
separate partial route. See [Control Room capability register](/frontend/capability-register).

## 6. Backend and frontend support

| Lane | Status | Notes |
|---|---|---|
| FDM CPU/GPU | authoring implemented | Planner and runtime still gate execution. |
| FEM CPU/GPU | not applicable | FEM uses element-size policies. |
| Control Room | partial | Default cell fields are exposed; low-level aliases are not guaranteed. |

## 7. Limitations and known pitfalls

- Cell size is not rounded to fit object extents.
- Prefer `default_cell` or the stage-first mesh facade over `FDM(cell=...)`.
- Construction does not prove a generated grid or solver run.

## 8. Scientific bibliography

1. C. Abert, “Micromagnetics and spintronics: models and numerical methods,”
   *European Physical Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| stage-first default cell | `packages/fullmag-py/src/fullmag/world.py` | `StudyObjectsMeshDefaultsBuilder.defaults` | builder implementation |
| low-level aliases and validation | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDM.__init__` | constructor and IR implementation |
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Backend realization is in the relevant `backends/fdm` or `backends/fem` lane named by the page.

