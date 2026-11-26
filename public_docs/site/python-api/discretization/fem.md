---
title: FEM
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: FEM, FemLinearSolverPolicy, PerObjectMeshRecipe, StudyBuilder mesh facades, shared-domain target resolution, and Control Room mesh resources
---

(public-docs-python-api-discretization-fem)=
# FEM discretization and mesh authoring

:::{admonition} Requested mesh policy is not the realized mesh
:class: important

Python and Control Room author **mesh intent**. Gmsh produces a concrete shared-domain asset, and
MFEM/native extraction turns that asset into the solver mesh. Scientific provenance must preserve
both layers: requested values, resolved values, build mode, fallbacks, region markers, element
families, quality statistics, and the final mesh digest.
:::

(python-api-discretization-fem-problem-statement)=
## Contract and ownership hierarchy

Fullmag FEM meshing has four policy levels:

1. `FEM(...)` supplies the study-level finite-element order, default maximum element size, optional
   imported mesh reference, optional demagnetization linear-solver policy (`FemLinearSolverPolicy`),
   and optional FEM GPU Barzilai–Borwein preconditioning policy (`gpu_bb_preconditioner`).
2. `study.universe.mesh(...)` controls the nonmagnetic exterior/airbox size field and the global
   meshing envelope.
3. `object.mesh(...)`, `object.mesh.thin_film(...)`, `object.mesh.swept(...)`, or
   `PerObjectMeshRecipe(...)` override the policy for one magnetic object.
4. The mesh builder resolves all geometry, region, interface, edge, corner, boundary-layer, swept,
   periodic, and airbox constraints into one conforming solver mesh.

The precedence for an object maximum-size target is, from highest to lowest:

1. explicit `PerObjectMeshRecipe.maximum_element_size` or `hmax`;
2. per-geometry mesh-workflow target;
3. mesh-workflow object default;
4. study-level `FEM.maximum_element_size` or `hmax`.

The realized mesh report derives provenance from the field that supplied the effective maximum-size
target, not merely from the presence of an object recipe. It reports `recipe_override`,
`local_override`, `workflow_default`, or `study_default` for the four levels above. An inherited
value in the UI is therefore not equivalent to a numeric zero or to deleting the mesh policy.

(python-api-discretization-fem-governing-equations)=
## Numerical meaning

This API page introduces no new physical interaction. It selects the finite-element trial/test
space used by all enabled operators. For standard `tet4` and mixed prism–pyramid–tetrahedron
meshes, both magnetization components and the scalar magnetic potential $\phi$ use nodal linear P1
bases (`order=1`). On certified pure-prism thin-film meshes authored with
`transition="pure_prism"` (`pure_prism_p2`), magnetization remains P1 nodal while the native FEM
backend automatically elevates the magnetostatic scalar potential $\phi$ to quadratic
`H1_WedgeElement(2)` (P2) elements on both CPU and GPU to eliminate the P1 prism aspect-ratio
demagnetization bias. User-authored `FEM.order` remains `1` in current production planners; higher
user-authored magnetization orders are planned capability and are rejected before execution.
Geometry order, field order, quadrature, material attributes, and airbox closure remain separate
numerical choices.

Changing the mesh changes the discrete exchange, DMI, anisotropy, demagnetization, mass, tangent,
and response operators. Results from two meshes are not the same discrete problem even when their
CAD geometry and nominal `hmax` match. For GPU demagnetization, time-stepping, and thin-film
realization details see {ref}`numerical-methods-performance-fem-gpu-demag`, and for GPU relaxation
preconditioning and short-range kernel acceleration see
{ref}`numerical-methods-performance-fem-gpu-kernels`.

(python-api-discretization-fem-symbols-and-si-units)=
## Symbols and SI units

| Quantity | Meaning | SI unit |
|---|---|---|
| `maximum_element_size`, `hmax` | requested upper element-size target | $\mathrm{m}$ |
| `minimum_element_size`, `hmin` | requested lower element-size target | $\mathrm{m}$ |
| airbox `padding`, `size`, `center` | exterior-domain geometry | $\mathrm{m}$ |
| interface/edge/corner distances and thicknesses | local refinement zones | $\mathrm{m}$ |
| `order`, layer counts, algorithm IDs, `max_iterations`, `print_level` | integer controls | $1$ |
| growth, stretching, ratios, curvature factor, `rtol`, `atol` | dimensionless policy factors and solver tolerances | $1$ |
| quality metrics | metric-dependent; always named in the report | $1$ |

All public lengths are SI metres. Control Room displays the same canonical values; it does not
apply an implicit nanometre conversion when writing the backend resource.

(python-api-discretization-fem-assumptions-and-validity)=
## Assumptions and validity

- `FEM.order` is an integer greater than or equal to one.
- Current production FEM CPU/GPU planners require `FEM.order == 1` for magnetization; on certified
  pure-prism thin-film meshes (`transition="pure_prism"`), the scalar potential automatically uses
  `pure_prism_p2` (`H1_WedgeElement(2)`), while `tet4` and mixed meshes use P1 for both fields.
  Higher user-authored magnetization orders fail planner capability validation.
- `FEM.maximum_element_size` is required and strictly positive; `hmax` is a compatibility spelling
  for the same value.
- When both `maximum_element_size` and `hmax` are supplied, their floating-point values must be
  equal.
- `FEM.mesh`, when present, is a nonempty imported/prebuilt mesh reference. Import does not bypass
  region, boundary, unit, order, orientation, and compatibility validation.
- `FEM.gpu_bb_preconditioner` accepts `None`, `"auto"`, `"none"`, or `"exchange_mass"`. Explicit
  non-`None` values are accepted only for explicit FEM GPU `projected_gradient_bb` relaxation runs
  and raise `ValueError` outside that scope. On eligible FEM GPU `projected_gradient_bb` runs,
  `"auto"` (and omission) resolves to the qualified `exchange_mass` preconditioner by default;
  `"none"` forces raw tangent-gradient BB steps; explicit `"exchange_mass"` fails closed if the
  device preconditioner cannot be constructed.
- `FemLinearSolverPolicy.gpu_strategy` accepts `"auto"`, `"cg_amg"`, or `"cudss"`. Under `"auto"`,
  the GPU Poisson solver selects direct `cuDSS` when compiled, available, and within the device
  memory budget, and falls back to `hypre` CG+AMG with explicit provenance otherwise; `"cg_amg"`
  forces Krylov AMG, and `"cudss"` requires direct cuDSS fail-closed.
- A valid FEM mesh is conforming across shared material and magnetic/air interfaces unless an
  explicitly different formulation owns a discontinuous trace.
- A mesh accepted on CPU is usable on GPU only when every realized element family, polynomial
  order, interaction, and auxiliary operator has a qualified GPU implementation.

## Complete FEM mode matrix

| Requested mode | Python authoring | Control Room authoring | Realized topology | Reviewed support boundary |
|---|---|---|---|---|
| inherited/automatic | omit object override or use `mesh_strategy="auto"` | `Use object policy` off or `Mesh strategy = Inherited` | planner/build-mode dependent | executable only after resolved build report is inspected |
| free tetrahedral | `mesh_strategy="free_tetrahedral"` or ordinary `object.mesh(...)` | `Free tetrahedral` | unstructured tetrahedra | primary general-purpose shared-domain path |
| thin-film tetrahedral | `mesh_strategy="thin_film_tetrahedral"` or thin-film helper with tetrahedral topology | advanced authored JSON / Python round-trip | thickness-aware tetrahedra | geometry- and build-mode dependent |
| exact layered prism (mixed) | complete `swept_prism` recipe with `transition="pyramid_to_tetrahedra"` | `Layered prism (exact)` | prism film, pyramid transition, tetrahedral exterior (Chebyshev mixed-tet untangler for `layers >= 2`) | bounded, certificate-driven production route; UI capability-gated; no silent free-tetra fallback |
| exact layered prism (pure prism P2) | `object.mesh.thin_film(..., topology="prismatic", transition="pure_prism")` or `swept_prism` with `transition_policy="pure_prism"` | advanced authored JSON / Python round-trip | pure-prism shared domain with automatic `pure_prism_p2` (`H1_WedgeElement(2)`) potential | certified CPU & GPU thin-film route (including CSR DMI, CG+AMG and cuDSS Poisson) |
| swept hex | complete `swept_hex` recipe | visible but disabled as unsupported | hexahedra, where a conforming route exists | represented by the Python schema (rejects both `"pyramid_to_tetrahedra"` and `"pure_prism"`) but not production-enabled |
| boundary-layer fields | `boundary_layer_count`/`thickness`/`stretching` plus selectors/tags | boundary-layer controls in `ObjectMeshSpecPanel.tsx` | near-wall Gmsh `BoundaryLayer` field (`boundary_layer_thickness` = first-layer `hwall_n`) | requires explicit selectors/tags; `MeshOperation(kind="boundary_layers", ...)` currently fails closed |
| imported/prebuilt mesh | `FEM(mesh=...)` or `study.mesh.import_(...)`; per-object `source=...` is rejected | study-level advanced JSON only | asset-defined | only study-level shared-domain import is consumed and validated |

`mesh_strategy` describes requested topology. `build_mode` and `operation_statuses` describe what
actually ran. They must not be collapsed into one field.

(python-api-discretization-fem-python-api)=
## Python API

### `FEM` constructor

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---:|---:|---|---|---|---|
| `FEM.order` | `int` | required | $1$ | integer >= 1; production planners require 1 (`pure_prism_p2` automatically uses P2 `H1_WedgeElement(2)` scalar potential on certified pure-prism meshes) | study-level finite-element field order | FEM CPU/GPU production: P1 magnetization (`pure_prism_p2` potential on pure-prism meshes); higher user-authored order planned | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required unless `hmax` is supplied | $\mathrm{m}$ | finite and > 0 | canonical study-level maximum-size target | FEM | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.hmax` | `float \| None` | `None` | $\mathrm{m}$ | alias; must equal `maximum_element_size` when both are present | compatibility spelling of the same target | FEM | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.mesh` | `str \| None` | `None` | $1$ | nonempty when present | imported/prebuilt mesh reference | FEM import/extraction path | `backend_policy.discretization_hints.fem.mesh` |
| `FEM.demag_solver_policy` | `FemLinearSolverPolicy \| None` | `None` | $1$ | typed policy | Poisson/demag algebraic solver request; does not alter mesh geometry | FEM demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy` |
| `FEM.gpu_bb_preconditioner` | `Literal["auto", "none", "exchange_mass"] \| None` | `None` | $1$ | `None`, `"auto"`, `"none"`, or `"exchange_mass"`; explicit values require FEM GPU `projected_gradient_bb` relaxation | GPU BB search-direction preconditioner; `"auto"` and omission resolve to qualified `exchange_mass` default | FEM GPU `projected_gradient_bb` qualified | `backend_policy.discretization_hints.fem.gpu_bb_preconditioner` |

### `FemLinearSolverPolicy` and stage-first solver helpers

Configure algebraic FEM Poisson demagnetization and GPU BB preconditioning through either
`FemLinearSolverPolicy` / `FEM(...)` or the stage-first helpers `fm.fem_demag_solver(...)` /
`study.fem_demag_solver(...)` and `fm.fem_bb_preconditioner(policy)` /
`study.fem_bb_preconditioner(policy)`:

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---:|---:|---|---|---|---|
| `FemLinearSolverPolicy.solver` | `Literal["CG", "GMRES"]` | `"CG"` | $1$ | `"CG"` or `"GMRES"` | Krylov linear solver for the FEM Poisson system | FEM CPU/GPU demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG", "JACOBI", "NONE"]` | `"AMG"` | $1$ | `"AMG"`, `"JACOBI"`, or `"NONE"` | Krylov preconditioner for the FEM Poisson system | FEM CPU/GPU demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | $1$ | finite and > 0 | relative residual tolerance | FEM CPU/GPU demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.atol` | `float \| None` | `None` | $1$ | finite and > 0 when supplied | optional absolute residual floor | FEM CPU/GPU demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy.atol` |
| `FemLinearSolverPolicy.max_iterations` | `int` | `500` | $1$ | integer >= 1 | maximum Krylov iteration count | FEM CPU/GPU demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy.max_iterations` |
| `FemLinearSolverPolicy.print_level` | `int` | `0` | $1$ | integer >= 0 | native linear-solver diagnostic verbosity level | FEM CPU/GPU demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy.print_level` |
| `FemLinearSolverPolicy.gpu_strategy` | `Literal["auto", "cg_amg", "cudss"]` | `"auto"` | $1$ | `"auto"`, `"cg_amg"`, or `"cudss"` | GPU Poisson realization strategy (`"auto"` chooses cuDSS when available within VRAM budget, else hypre CG+AMG; `"cg_amg"` forces Krylov; `"cudss"` forces direct cuDSS) | FEM GPU demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy.gpu_strategy` |

Both `fm.fem_demag_solver(*, solver="CG", preconditioner="AMG", rtol=1e-8, atol=None, max_iterations=500, print_level=0, gpu_strategy="auto")` and `study.fem_demag_solver(...)` accept the exact same keyword arguments and construct a validated `FemLinearSolverPolicy`. Likewise, `fm.fem_bb_preconditioner(policy)` and `study.fem_bb_preconditioner(policy)` validate `policy in ("auto", "none", "exchange_mass")` and lower it to `backend_policy.discretization_hints.fem.gpu_bb_preconditioner`.

### Related typed objects

These types are exported from `fullmag.model`, not from the top-level `fullmag` namespace:

```python
from fullmag.model import MeshOperation, MeshSizeControls, PerObjectMeshRecipe, SharedMeshAssemblyPolicy
```

| Object | Owned controls | Purpose |
|---|---|---|
| `PerObjectMeshRecipe` | object sizes, algorithms, topology, layers, boundary layers, quality, size fields, operation sequence | overrides one magnetic object's inherited mesh intent |
| `MeshOperation` | `kind`, `params`, `enabled` | ordered COMSOL-like meshing operation (currently fail-closed at build time) |
| `MeshSizeControls` | calibration, preset, hmin/hmax, growth, curvature, narrow-region resolution | standalone compatibility payload; currently unattached to ProblemIR |
| `SweepDistribution` | `kind`, `num_layers`, `growth_rate` | typed through-thickness distribution |
| `SweptMeshControls` | distribution, direction, family, transition (`pyramid_to_tetrahedra`, `pure_prism`, `reject`), exact-layer flag | strict typed swept-mesh intent |
| `SharedMeshAssemblyPolicy` | interface factor, conformity, airbox factor | low-level shared-domain assembly policy |
| `FemLinearSolverPolicy` | `solver`, `preconditioner`, `rtol`, `atol`, `max_iterations`, `print_level`, `gpu_strategy` | Poisson/demag algebraic policy, not a meshing control |

### Complete stage-first scenario

```python
# %% Shared-domain FEM with an exact layered film, graded airbox, and solver policies
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_mesh_reference")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(1.2e-6, 600 * nm, 550 * nm))
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=100 * nm,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.mesh.thin_film(
    minimum_element_size=3 * nm,
    maximum_element_size=5 * nm,
    layers=2,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-10,
    atol=1.0e-14,
    max_iterations=500,
    print_level=0,
    gpu_strategy="auto",
)
study.fem_bb_preconditioner("auto")
study.build_domain_mesh()
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="projected_gradient_bb",
    tolT=1.0e-6,
    max_steps=50_000,
)
```

This exact block passed an authoring-contract execution check during review with only the
expensive mesh materialization mocked; domain, policy, and stage construction completed without
exception. The repository integration pattern is
`tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`; this
documentation snippet preserves the stage-first contract for the shared domain, film, demagnetization,
and relaxation stage.

The explicit `study.build_domain_mesh()` request materializes the authored geometry and mesh policy.
A later geometry or mesh-policy change invalidates that mesh; the UI marks the current realization
stale until it is rebuilt.

## Control Room mapping

The active FEM mesh controls are split by semantic owner:

| UI selection/panel | What it edits | Backend resource/command |
|---|---|---|
| `Mesh` root (`MeshRootSpec.tsx`) | study discretization summary and mesh root controls | study mesh root resource |
| selected magnetic object -> `Object Mesh Policy` (`ObjectMeshSpecPanel.tsx`) | one object override and local refinement | object mesh policy replace resource |
| selected universe/airbox -> `UniverseAndAirboxSpec.tsx`, `AirboxMeshOverviewSpec.tsx`, `AirboxMeshSizingSpecs.tsx` | shared exterior geometry and FEM air size policy | universe mesh policy replace resource |
| `Apply Policy` | commits the object draft only | updates authored policy; current mesh becomes stale |
| `Build Mesh` / `Apply & Build Mesh` | builds the selected object's shared-domain mesh context | `mesh.build-selected` |
| `Apply Airbox Policy` | commits exterior policy only | updates universe policy; current mesh becomes stale |
| `Apply & Build Shared-Domain Mesh` | commits draft then requests meshing | `mesh.build-shared-domain` |
| mesh report/quality tabs | read-only realized topology, quality, fallbacks, selectors, and digests | current/latest-successful mesh resources |

Control Room preserves authored and backend-effective values separately. The advanced JSON editor is
part of the round-trip contract, not permission to bypass validation. Unknown keys may be retained
as authored JSON, but only source-backed keys are guaranteed to affect meshing.

(python-api-discretization-fem-problem-ir)=
## ProblemIR and resolved execution

The canonical request contains study-level discretization hints plus derived mesh-workflow metadata.
The object and universe resources preserve their own revision numbers. Resolved execution adds:

- effective object and airbox targets and the source of each value;
- requested and actual meshing algorithms;
- shared-domain build mode and ordered fallback history;
- region, boundary, periodic-pair, selector, and magnetic-submesh identities;
- element and facet counts by family, order, region, and role (including `pure_prism_p2` potential
  order and topology certificate);
- requested and realized layer count, node planes, sweep direction, and transition topology;
- resolved GPU Poisson linear solver (`hypre_krylov` vs `cudss_direct`) and fallback reason, plus
  resolved GPU BB direction policy (`device_exchange_mass_preconditioned` vs unpreconditioned);
- applied/ignored/degraded size fields and mesh operations;
- Jacobian, SICN, gamma/radius, volume, and edge-size statistics;
- Gmsh/native extraction versions, deterministic inputs, and mesh digest.

Only the resolved report can establish whether a requested mode executed without degradation.

(python-api-discretization-fem-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is the canonical Python or Control Room policy stored before meshing.
**Resolved execution** is the backend-effective policy and the concrete Gmsh/native result. Public
**validation errors** reject malformed requests before build, while **unsupported combinations**
fail capability validation rather than being replaced silently by a different topology or device.

The public boundary rejects malformed values before build. The mesh builder additionally fails or
marks degradation for nonconformal assembly, empty regions, inverted/collapsed elements, unresolved
selectors, unsupported topology combinations, marker loss, invalid periodic pairs, and requested/
resolved topology mismatch.

Strict mode forbids hidden substitution. In particular:

- exact layered prism does not silently become free tetrahedral;
- a spherical airbox does not silently become a box without a degradation record;
- a requested optimizer/size field does not silently disappear;
- a GPU request does not silently rebuild a different CPU mesh;
- explicit `gpu_strategy="cudss"` or `gpu_bb_preconditioner="exchange_mass"` fails closed when
  unavailable instead of silently downgrading;
- an imported mesh does not bypass unit or semantic-marker validation.

(python-api-discretization-fem-discrete-realization)=
## Device and solver realization

| Solver | Device | Mesh contract |
|---|---|---|
| FEM | CPU | generated/imported shared-domain mesh extracted into native/MFEM host structures (P1 on `tet4`/mixed meshes; automatic `pure_prism_p2` scalar potential on certified pure-prism meshes) |
| FEM | GPU | the identical content-addressed mesh is consumed by supported device operators (including qualified `exchange_mass` BB preconditioning, `cg_amg`/`cudss` Poisson strategies, and `pure_prism_p2`); element-family and order coverage remain capability-gated |
| FDM | CPU/GPU | not applicable to this page; FDM uses object-owned Cartesian grids and masks |

Meshing itself is generally a host/Gmsh operation. A final FEM GPU simulation does not imply that
CAD construction, Gmsh generation, selector resolution, or quality analysis ran on the GPU.

(python-api-discretization-fem-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| study-level schema and lowering | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L484) | [`class FEM`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L484) |
| FEM Poisson linear-solver policy | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L161) | [`class FemLinearSolverPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L161) |
| per-object schema and topology validation | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | [`class PerObjectMeshRecipe`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) |
| operation sequence | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L583) | [`class MeshOperation`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L583) |
| typed swept controls | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L413) | `SweepDistribution`, [`class SweptMeshControls`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L413) |
| stage-first mesh and solver facades | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | [`class StudyBuilder`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439), `fem_demag_solver`, `fem_bb_preconditioner` |
| target precedence | [`packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py#L576) | [`resolve_shared_domain_targets`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py#L576) |
| Gmsh shared-domain generation | `packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py` | shared assembly owner |
| swept generation | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | sweepability, `pure_prism`, and Chebyshev mixed-tet untangler |
| size-field composition | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | size-field plan owner |
| extraction | `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | native extraction owner |
| realization/degradation report | [`packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py#L32) | [`_build_shared_domain_build_report`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py#L32) |
| object UI and request canonicalization | [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts#L504) | [`buildObjectMeshPolicyReplaceRequest`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts#L504) |
| mesh root and object mesh inspectors | [`apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx#L52), [`apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/mesh-details/ObjectMeshSpecPanel.tsx#L181) | `MeshRootInspectorSpecPanel`, `ObjectMeshInspectorSpecPanel` |
| universe and airbox mesh inspectors | [`apps/control-room/src/modules/inspector/inspectors/universe/UniverseAndAirboxSpec.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/universe/UniverseAndAirboxSpec.tsx#L81), [`apps/control-room/src/modules/inspector/inspectors/universe/AirboxMeshOverviewSpec.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/universe/AirboxMeshOverviewSpec.tsx#L63), [`apps/control-room/src/modules/inspector/inspectors/universe/AirboxMeshSizingSpecs.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/universe/AirboxMeshSizingSpecs.tsx#L61) | `AirboxRootInspectorSpecPanel`, `AirboxMeshInspectorSpecPanel`, `AirboxMeshParametersInspectorSpecPanel` |
| airbox request canonicalization | [`apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts#L291) | [`buildAirboxMeshPolicyReplaceRequest`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts#L291) |

(python-api-discretization-fem-validation)=
## Verification and scientific qualification

A production mesh study should include:

1. geometry bounds, volume, region connectivity, and marker validation;
2. positive Jacobians and acceptable lower-tail quality for every element family;
3. constant/affine interpolation and operator null-case tests;
4. at least three controlled h-refinement levels for the target observable where feasible;
5. independent layer-count convergence for thin-film modes;
6. independent airbox-extent, closure, grading, and Poisson-tolerance studies;
7. branch/mode correspondence for equilibria, eigenmodes, and response peaks;
8. CPU/GPU comparison using the exact same mesh digest;
9. archived authored policy, resolved report, and generated mesh asset.

(python-api-discretization-fem-limitations)=
## Limitations

- `hmax` is a mesher target, not a guaranteed realized maximum.
- High field order does not repair low-order geometry automatically.
- Exact layered prism support is intentionally narrow and capability-gated.
- Swept hex is represented in schemas but disabled in the reviewed Control Room production gate.
- General multi-object and general airbox-plus-swept workflows remain scenario-dependent.
- Boundary layers and semantic selectors can degrade when CAD/component identities are lost.
- The current contract does not claim universal automatic a posteriori adaptivity.

(python-api-discretization-fem-scientific-bibliography)=
## Scientific bibliography

1. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM Classics, 2002,
   [doi:10.1137/1.9780898719208](https://doi.org/10.1137/1.9780898719208).
2. S. C. Brenner and L. R. Scott, *The Mathematical Theory of Finite Element Methods*, 3rd ed.,
   Springer, 2008, [doi:10.1007/978-0-387-75934-0](https://doi.org/10.1007/978-0-387-75934-0).
3. C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with
   built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in
   Engineering* **79**, 1309–1331 (2009),
   [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
4. R. Anderson et al., “MFEM: a modular finite element methods library,” *Computers & Mathematics
   with Applications* **81**, 42–74 (2021),
   [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).
5. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(python-api-discretization-fem-source-code-index)=
## Source-code index

| Claim | Lane | Path | Stable symbol | Responsibility | Evidence | Evidence status | Immutable revision |
|---|---|---|---|---|---|---|---|
| constructor and aliases | FEM CPU/GPU authoring | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` (`FEM.__init__`, `FEM.to_ir`) | Study-level FEM constructor, validation, aliases, GPU BB policy, and IR lowering | signature/round-trip tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L484) |
| Poisson linear-solver policy | FEM CPU/GPU demag | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | Krylov/preconditioner tolerances, verbosity, and `gpu_strategy` validation and lowering | API and GPU Poisson contract tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L161) |
| complete object recipe | FEM CPU/GPU authoring | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class PerObjectMeshRecipe` (`PerObjectMeshRecipe.__post_init__`, `PerObjectMeshRecipe.to_ir`) | Complete object-owned mesh recipe and topology legality | unit and meshing tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) |
| mesh operation schema | FEM CPU/GPU authoring | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class MeshOperation` | Ordered COMSOL-like meshing operation schema | unit and meshing tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L583) |
| swept controls schema | FEM CPU/GPU authoring | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class SweptMeshControls` | Typed swept direction, element family, transition, and exact-layer policy | unit and meshing tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L413) |
| stage-first mesh facade | FEM CPU/GPU authoring | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Stage-first universe, object, build, and solver authoring surface | stage-first authoring tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) |
| target precedence | FEM CPU/GPU shared mesh | `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` | `resolve_shared_domain_targets` | Study/workflow/object target precedence and effective target resolution | target precedence tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py#L576) |
| realized report | FEM CPU/GPU shared mesh | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_shared_domain_build_report` | requested/resolved provenance | meshing fallback and report tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py#L32) |
| Control Room canonicalization | Control Room, FEM | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts` | `buildObjectMeshPolicyReplaceRequest` | typed draft to canonical JSON | model/DOM tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts#L504) |
| airbox transaction | Control Room, FEM | `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts` | `buildAirboxMeshPolicyReplaceRequest` | universe policy and FEM-only filtering | panel/model tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts#L291) |
