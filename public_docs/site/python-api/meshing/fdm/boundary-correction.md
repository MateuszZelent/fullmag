---
title: FDM Boundary-Correction API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fdm-boundary-correction)=
# FDM Boundary-Correction API

`FDM.boundary_correction` accepts `none`, `volume`, or `full`.

| Field | Unit | Constraint |
|---|---|---|
| `boundary_correction` | 1 | supported name |
| `boundary_phi_floor` | 1 | value in `(0, 1)` |
| `boundary_delta_min` | m | nonnegative |

These values request a policy. The result provenance must state the resolved interaction/device
coverage. Do not infer that every CUDA or DMI kernel applied the correction from successful Python
construction alone.

## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

## 1. What it is and when to use it

`FDM.boundary_correction` selects the embedded-boundary policy used by FDM
operators: `none` is the binary-mask baseline, `volume` is the T0
volume-fraction correction, and `full` is the T1 boundary-stencil and
demagnetization correction when the selected lane advertises it.

## 2. Physical and mathematical explanation

This is a numerical correction policy, not a new physical interaction. It
changes how partially occupied boundary cells contribute to the discrete
operator while leaving authored geometry and cell size unchanged.

## 3. Example - complete Python script

```python
# %% FDM boundary correction policy
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_boundary_correction")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.fdm(
    default_cell=(2 * nm, 2 * nm, 2 * nm),
    boundary_correction="volume",
    boundary_phi_floor=0.05,
    boundary_delta_min=0.2 * nm,
)
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", max_steps=100)
```

`study.fdm(...)` is the source-backed route for these low-level fields;
ordinary uniform sizing should use `study.objects.mesh.defaults(...)`.

## 4. Exact API

| Parameter | Type | Default | SI unit | Validation | Meaning |
|---|---|---|---|---|---|
| `boundary_correction` | `str \| None` | `None` | $1$ | `none`, `volume`, or `full` | embedded-boundary policy |
| `boundary_phi_floor` | `float \| None` | `None` | $1$ | `0 < value < 1` | minimum occupied-volume fraction |
| `boundary_delta_min` | `float \| None` | `None` | $\mathrm{m}$ | non-negative | minimum T1 stencil distance |

`FDM.__init__(*, cell=None, default_cell=None, per_magnet=None, demag=None,
projection_policy=None, boundary_correction=None, boundary_phi_floor=None,
boundary_delta_min=None)` rejects conflicting cell aliases, invalid modes,
non-positive cells, out-of-range phi floors, and negative delta minima.

## 5. How to set it in Control Room

Route: `Model Explorer -> Study -> Discretization -> FDM`. The current global
authoring route is partial. Apply the FDM policy only where the draft exposes
the correction keys; mesh and dependent solver resources then become stale.
`TODO: frontend support` for a dedicated typed editor for
`boundary_phi_floor` and `boundary_delta_min` when they are absent from the
current draft. See [Control Room capability register](/frontend/capability-register).

## 6. Backend and frontend support

| Lane | Status | Notes |
|---|---|---|
| FDM CPU | planner-gated | Source policy exists; execution requires lane qualification. |
| FDM GPU | planner-gated | Source presence is not CUDA qualification. |
| FEM CPU/GPU | not applicable | This policy belongs to FDM discretization. |
| Control Room | partial | Global FDM authoring exists; correction subfields may be TODO. |

## 7. Limitations and known pitfalls

- Construction does not prove that a correction kernel executed.
- `full` may be rejected by interaction, geometry, precision, or device capability.
- A rejected correction must not silently become `none` or a CPU fallback.

## 8. Scientific bibliography

1. C. Abert, “Micromagnetics and spintronics: models and numerical methods,”
   *European Physical Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| FDM fields and validation | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDM.__init__` | constructor and IR implementation |
| stage-first attachment | `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder.fdm` | builder delegation |
| accepted correction modes | `packages/fullmag-py/src/fullmag/world.py` | `boundary_correction` | mode validation and state update |
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Backend realization is in the relevant `backends/fdm` or `backends/fem` lane named by the page.

