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

`demag_solver_policy` configures the algebraic Poisson solve (including `gpu_strategy`: `"auto"`, `"cg_amg"`, or `"cudss"`); `gpu_bb_preconditioner` configures FEM GPU `projected_gradient_bb` search-direction preconditioning (qualified `auto` -> `exchange_mass` default). Neither changes element geometry. See {ref}`numerical-methods-performance-fem-gpu-demag` and {ref}`numerical-methods-performance-fem-gpu-kernels`.

(python-api-meshing-fem-study-defaults-symbols-and-si-units)=
## Symbols and SI units
All geometric lengths use $\mathrm{m}$; dimensionless selectors use $1$.

(python-api-meshing-fem-study-defaults-assumptions-and-validity)=
## Assumptions and validity
Authoring validation does not prove mesh generation or solver qualification; the realized report is authoritative.

(python-api-meshing-fem-study-defaults-problem-statement)=
## 1. What it is and when to use it

`FEM` stores study-level finite-element defaults. Use it as the lowest-
precedence FEM policy; explicit object recipes, airbox settings, and workflow
overrides take precedence where defined.

(python-api-meshing-fem-study-defaults-governing-equations)=
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
study.objects.mesh.defaults(order=1, maximum_element_size=20 * nm)
body = study.geometry(fm.Box(80 * nm, 40 * nm, 4 * nm), name="film")
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

(python-api-meshing-fem-study-defaults-python-api)=
## 4. Exact API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FEM.order` | `int` | required | $1$ | integer `>= 1` | finite-element order | FEM CPU/GPU | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required | $\mathrm{m}$ | strictly positive | global hmax target | FEM CPU/GPU | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.hmax` | `float \| None` | `None` | $\mathrm{m}$ | compatibility alias equal to `maximum_element_size` when both provided | compatibility spelling of global hmax | FEM CPU/GPU | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.demag_solver_policy` | `FemLinearSolverPolicy \| None` | `None` | $1$ | typed `FemLinearSolverPolicy` | algebraic Poisson solver request | FEM CPU/GPU demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy` |
| `FEM.gpu_bb_preconditioner` | `str \| None` | `None` | $1$ | `"auto"`, `"none"`, or `"exchange_mass"`; explicit values require FEM GPU `projected_gradient_bb` | GPU BB search-direction preconditioner (`"auto"` and omission resolve to qualified `exchange_mass` default) | FEM GPU `projected_gradient_bb` qualified | `backend_policy.discretization_hints.fem.gpu_bb_preconditioner` |
| `FemLinearSolverPolicy.gpu_strategy` | `Literal["auto", "cg_amg", "cudss"]` | `"auto"` | $1$ | one of `"auto"`, `"cg_amg"`, or `"cudss"` | GPU Poisson realization strategy (`"auto"` chooses cuDSS when available within VRAM budget, else hypre CG+AMG) | FEM GPU demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy.gpu_strategy` |
| `StudyBuilder.fem_demag_solver` | `(*, solver="CG", preconditioner="AMG", rtol=1e-8, atol=None, max_iterations=500, print_level=0, gpu_strategy="auto") -> StudyBuilder` | defaults | $1$ | delegates to `FemLinearSolverPolicy` | stage-first FEM Poisson solver policy setter (`fm.fem_demag_solver` mirrors the same kwargs) | FEM CPU/GPU demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy` |
| `StudyBuilder.fem_bb_preconditioner` | `(policy: str) -> StudyBuilder` | `None` | $1$ | `"auto"`, `"none"`, or `"exchange_mass"` | stage-first GPU BB preconditioner setter (`fm.fem_bb_preconditioner` mirrors the same signature) | FEM GPU `projected_gradient_bb` qualified | `backend_policy.discretization_hints.fem.gpu_bb_preconditioner` |
| `StudyBuilder.fem_order` | `(order_value: int) -> StudyBuilder` | current state | $1$ | delegated validation | stage-first order setter | FEM CPU/GPU | `backend_policy.discretization_hints.fem.order` |
| `StudyBuilder.hmax` | `(value: float \| str) -> StudyBuilder` | current state | $\mathrm{m}$ | delegated validation | stage-first size setter | FEM CPU/GPU | `backend_policy.discretization_hints.fem.hmax` |

Full low-level constructor:
`FEM(order, maximum_element_size=None, *, hmax=None, mesh=None, demag_solver_policy=None, gpu_bb_preconditioner=None)`.
Supplying both size aliases requires equal values; missing size, booleans, or
invalid order fail during construction. Solver policy and GPU BB preconditioning
are serialized separately from mesh geometry.

(python-api-meshing-fem-study-defaults-problem-ir)=
## ProblemIR
The request lowers to `backend_policy.discretization_hints.fem.*`; requested intent remains distinct from the resolved mesh asset and provenance report.

(python-api-meshing-fem-study-defaults-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is the Python policy; resolved execution is the realized mesh report. Validation errors identify the violated domain rule, and unsupported combinations fail explicitly without silent fallback.

(python-api-meshing-fem-study-defaults-discrete-realization)=
## Discrete realization
The backend consumes the realized finite-element asset, including topology, markers, quality, resolved Poisson solver (`hypre_krylov` vs `cudss_direct`), and resolved BB preconditioner provenance where available.

## 5. How to set it in Control Room

Route: `Model Explorer -> Universe / Airbox -> Mesh` (`apps/control-room/src/modules/inspector/inspectors/universe/AirboxMeshSizingSpecs.tsx`, `AirboxMeshParametersInspectorSpecPanel`) and
`Model Explorer -> Mesh` / `Objects -> <object> -> Mesh` (`apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx`, `apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx`) author exterior air sizing and per-object
FEM sizing/order before executing **Apply & Build Shared-Domain Mesh** (`mesh.build-shared-domain`). See
{doc}`/frontend/meshing/index`, {doc}`/frontend/meshing/object-mesh`, and {doc}`/frontend/meshing/airbox-mesh` for
supported UI fields; low-level `FEM(mesh=...)` or solver-policy fields (`gpu_strategy`, `gpu_bb_preconditioner`) not rendered in Control Room remain Python-only.
See [Control Room capability register](/frontend/capability-register).

```{image} /_static/images/ui/inspector-fem-mesh-and-airbox.png
:alt: Semantic Inspector panel showing FEM object mesh and airbox parameters in Control Room
:width: 92%
```

(python-api-meshing-fem-study-defaults-implementation-mapping)=
## 6. Backend and frontend support

| Lane | Status | Notes |
|---|---|---|
| FEM CPU/GPU | authoring implemented; runtime-gated | Defaults are planner-resolved; `gpu_strategy` and `gpu_bb_preconditioner` target FEM GPU. |
| FDM CPU/GPU | not applicable | Use FDM cell policies. |
| Control Room | partial | Core order/size fields are exposed; low-level aliases and GPU solver policies remain Python-only. |

(python-api-meshing-fem-study-defaults-validation)=
## Validation
Focused constructor, lowering, and mesh-report tests are the evidence boundary for this page.

(python-api-meshing-fem-study-defaults-limitations)=
## 7. Limitations and known pitfalls

- Study defaults have lower precedence than explicit object/workflow policies.
- `hmax` is an alias, not a second independent value.
- A policy object does not materialize or qualify a mesh by itself.

(python-api-meshing-fem-study-defaults-scientific-bibliography)=
## 8. Scientific bibliography

1. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM, 2002.
2. C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element
   mesh generator,” *International Journal for Numerical Methods in Engineering*
   **79**, 1309-1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(python-api-meshing-fem-study-defaults-source-code-index)=
## 9. Source-code index

| Claim | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| study-level FEM mesh policy | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L484) | [`class FEM`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L484) | constructor and API tests |
| FEM Poisson linear-solver policy | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L161) | [`class FemLinearSolverPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L161) | API and GPU Poisson contract tests |
| shared-domain assembly defaults | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L1050) | [`class SharedMeshAssemblyPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L1050) | assembly and API tests |
| stage-first solver and default setters | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) (`fem_demag_solver`, `fem_bb_preconditioner`, `fem_order`, `hmax`, `build_domain_mesh`) | builder delegation and round-trip tests |
