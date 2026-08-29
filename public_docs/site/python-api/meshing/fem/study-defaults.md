---
title: FEM Study Defaults
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-study-defaults)=
# FEM Study Defaults

The typed low-level constructor is:

```text
fm.FEM(order=1, maximum_element_size=20e-9)
```

`hmax=` is an alias for `maximum_element_size=`. The stage-first facade usually captures equivalent
intent through study and object mesh methods. Study defaults have the lowest precedence below
explicit object recipes and mesh-workflow overrides.

`demag_solver_policy` configures the algebraic Poisson solve; it does not change element geometry.

## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

## 1. What it is and when to use it

`FEM` stores study-level finite-element defaults. Use it as the lowest-
precedence FEM policy; explicit object recipes, airbox settings, and workflow
overrides take precedence where defined.

## 2. Physical and mathematical explanation

This is an authoring policy and introduces no new physical equation. `order`
and `maximum_element_size` select the finite-element approximation and global
target; `demag_solver_policy` configures the algebraic solve separately.

## 3. Example - complete Python script

```python
# %% FEM study defaults through the stage-first builder
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_study_defaults")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.fem_order(1)
study.hmax(20 * nm)
body = study.geometry(fm.Box(80 * nm, 40 * nm, 4 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.build_domain_mesh()
```

## 4. Exact API

| Parameter/function | Signature or type | Default | SI unit | Validation | Meaning |
|---|---|---|---|---|---|
| `FEM` | `FEM(order, maximum_element_size=None, *, hmax=None, mesh=None, demag_solver_policy=None)` | size required | mixed | order >= 1; positive size; matching aliases | low-level FEM policy |
| `FEM.order` | `int` | required | $1$ | integer >= 1 | finite-element order |
| `FEM.maximum_element_size` | `float` | required | $\mathrm{m}$ | strictly positive | global hmax target |
| `FEM.hmax` | property `float` | derived | $\mathrm{m}$ | mirrors maximum size | compatibility alias |
| `StudyBuilder.fem_order` | `fem_order(order_value) -> StudyBuilder` | current state | $1$ | delegated validation | stage-first order setter |
| `StudyBuilder.hmax` | `hmax(value) -> StudyBuilder` | current state | $\mathrm{m}$ or preset | delegated validation | stage-first size setter |

Supplying both size aliases requires equal values; missing size, booleans, or
invalid order fail during construction. Solver policy is serialized separately
from mesh geometry.

## 5. How to set it in Control Room

Route: `Model Explorer -> Study -> Discretization -> FEM defaults`. Set global
order and maximum element size, press **Apply**, then **Build Shared-Domain
Mesh**. Object and airbox overrides are edited in their own Mesh panels.
`TODO: frontend support` for low-level `FEM(mesh=...)` or solver-policy fields
not rendered by the study editor. See [Control Room capability register](/frontend/capability-register).

## 6. Backend and frontend support

| Lane | Status | Notes |
|---|---|---|
| FEM CPU/GPU | authoring implemented; runtime-gated | Defaults are planner-resolved. |
| FDM CPU/GPU | not applicable | Use FDM cell policies. |
| Control Room | partial | Core order/size fields are exposed; all aliases are not guaranteed. |

## 7. Limitations and known pitfalls

- Study defaults have lower precedence than explicit object/workflow policies.
- `hmax` is an alias, not a second independent value.
- A policy object does not materialize or qualify a mesh by itself.

## 8. Scientific bibliography

1. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM, 2002.
2. C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element
   mesh generator,” *International Journal for Numerical Methods in Engineering*
   **79**, 1309-1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| FEM constructor and aliases | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FEM.__init__`, `FEM.hmax` | source implementation |
| stage-first setters | `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder.fem_order`, `StudyBuilder.hmax` | builder delegation |
| mesh materialization | `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder.build_domain_mesh` | public build entrypoint |
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Backend realization is in the relevant `backends/fdm` or `backends/fem` lane named by the page.

