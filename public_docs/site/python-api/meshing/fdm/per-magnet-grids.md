---
title: FDM Per-Magnet Grids
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fdm-per-magnet-grids)=
# FDM Per-Magnet Grids

Per-magnet native grids are authored with `FDMGrid` values:

```text
fm.FDM(
    default_cell=(4e-9, 4e-9, 1e-9),
    per_magnet={
        "free": fm.FDMGrid(cell=(2e-9, 2e-9, 1e-9)),
        "reference": fm.FDMGrid(cell=(4e-9, 4e-9, 1e-9)),
    },
)
```

Keys are nonempty object names. Values must be `FDMGrid` instances with positive SI cell triples.
Local interactions remain native-grid owned. Any nonlocal communication grid and transfer is
configured separately by `FDMDemag`.

## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

## 1. What it is and when to use it

Per-magnet grids let separate magnetic objects use distinct native Cartesian
cell triples while retaining canonical object names. Use them for multilayer
or strongly different length scales; use a default grid for a uniform model.

## 2. Physical and mathematical explanation

This page has no own physical equation. Each `FDMGrid.cell` selects the local
discrete support; demagnetization coupling and any common communication grid
are separate `FDMDemag` policies.

## 3. Example - complete Python script

```python
# %% Per-magnet FDM grids
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_per_magnet_grids")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.fdm(
    default_cell=(4 * nm, 4 * nm, 1 * nm),
    per_magnet={
        "free": fm.FDMGrid(cell=(2 * nm, 2 * nm, 1 * nm)),
        "reference": fm.FDMGrid(cell=(4 * nm, 4 * nm, 1 * nm)),
    },
)
free = study.geometry(fm.Box(40 * nm, 20 * nm, 2 * nm), name="free")
reference = study.geometry(fm.Box(40 * nm, 20 * nm, 2 * nm), name="reference")
for body in (free, reference):
    body.Ms = 800.0e3
    body.Aex = 13.0e-12
    body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", max_steps=100)
```

## 4. Exact API

| Parameter | Type | Default | SI unit | Validation | Meaning |
|---|---|---|---|---|---|
| `FDMGrid.cell` | `Sequence[float]` | required | $\mathrm{m}$ | exactly three positive values | one native object grid |
| `FDM.per_magnet` | `dict[str, FDMGrid] \| None` | `None` | $1$ | non-empty string keys and `FDMGrid` values | object-name keyed overrides |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | required when the map is incomplete | fallback grid |
| `FDMDemag` | `FDMDemag \| None` | `None` | $1$ | planner validates strategy/mode/grid policy | nonlocal coupling policy |

`FDMGrid.__init__(cell)` rejects malformed or non-positive triples. `FDM.__init__`
rejects empty names, non-`FDMGrid` values, and a missing default when no
per-magnet grid can cover the authored objects.

## 5. How to set it in Control Room

Route: `Model Explorer -> Study -> Discretization -> FDM per-magnet grids`.
The route is partial and keyed by canonical geometry names. Apply the global
study draft, then inspect the resolved grid resource. `TODO: frontend support`
for a dedicated typed editor when only advanced JSON is available. See
[Control Room capability register](/frontend/capability-register).

## 6. Backend and frontend support

| Lane | Status | Notes |
|---|---|---|
| FDM CPU/GPU | planner-gated | Native grids are representable; multilayer coupling needs capability evidence. |
| FEM CPU/GPU | not applicable | This is an FDM grid contract. |
| Control Room | partial | Global/per-magnet draft support is not the full low-level surface. |

## 7. Limitations and known pitfalls

- Mapping keys must equal authored geometry names.
- A local grid does not define the nonlocal demagnetization communication grid.
- Per-magnet authoring is not runtime or CPU/GPU parity evidence.

## 8. Scientific bibliography

1. C. Abert, “Micromagnetics and spintronics: models and numerical methods,”
   *European Physical Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| per-magnet validation | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDMGrid.__init__` | constructor implementation |
| map lowering | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDM.__init__`, `FDM.to_ir` | source-backed IR contract |
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Backend realization is in the relevant `backends/fdm` or `backends/fem` lane named by the page.

