---
title: FEM
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: ec6f2374e04cbd0d1e75b94c81da07af50da3789
source_of_truth: FEM, PerObjectMeshRecipe, StudyBuilder mesh facades, shared-domain target resolution, and Control Room mesh resources
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
   imported mesh reference, and optional demagnetization linear-solver policy.
2. `study.universe.mesh(...)` controls the nonmagnetic exterior/airbox size field and the global
   meshing envelope.
3. `object.mesh(...)`, `object.mesh.thin_film(...)`, or `PerObjectMeshRecipe(...)` override the
   policy for one magnetic object.
4. the mesh builder resolves all geometry, region, interface, edge, corner, boundary-layer, swept,
   periodic, and airbox constraints into one conforming solver mesh.

The precedence for an object maximum-size target is, from highest to lowest:

1. explicit `PerObjectMeshRecipe.maximum_element_size` or `hmax`;
2. per-geometry mesh-workflow target;
3. mesh-workflow object default;
4. study-level `FEM.maximum_element_size` or `hmax`.

The realized mesh report records which level supplied every effective target. An inherited value in
the UI is therefore not equivalent to a numeric zero or to deleting the mesh policy.

(python-api-discretization-fem-governing-equations)=
## Numerical meaning

This API page introduces no new physical interaction. It selects the finite-element trial/test
space used by all enabled operators. For a scalar P1 basis `phi_a`, each component of reduced
magnetization is represented by nodal coefficients. The public schema can represent higher `order`
values, but every current production native FEM planner accepts only `order=1`; higher orders are
planned capability and are rejected before execution. Geometry order, field order,
quadrature, material attributes, and airbox closure remain separate numerical choices.

Changing the mesh changes the discrete exchange, DMI, anisotropy, demagnetization, mass, tangent,
and response operators. Results from two meshes are not the same discrete problem even when their
CAD geometry and nominal `hmax` match.

(python-api-discretization-fem-symbols-and-si-units)=
## Symbols and SI units

| Quantity | Meaning | SI unit |
|---|---|---|
| `maximum_element_size`, `hmax` | requested upper element-size target | m |
| `minimum_element_size`, `hmin` | requested lower element-size target | m |
| airbox `padding`, `size`, `center` | exterior-domain geometry | m |
| interface/edge/corner distances and thicknesses | local refinement zones | m |
| `order`, layer counts, algorithm IDs | integer controls | 1 |
| growth, stretching, ratios, curvature factor | dimensionless policy factors | 1 |
| quality metrics | metric-dependent; always named in the report | 1 |

All public lengths are SI metres. Control Room displays the same canonical values; it does not
apply an implicit nanometre conversion when writing the backend resource.

(python-api-discretization-fem-assumptions-and-validity)=
## Assumptions and validity

- `FEM.order` is an integer greater than or equal to one.
- current production FEM CPU/GPU execution is P1-only (`FEM.order == 1`); higher integer values are
  representable authoring intent but fail planner capability validation.
- `FEM.maximum_element_size` is required and strictly positive; `hmax` is a compatibility spelling
  for the same value.
- when both `maximum_element_size` and `hmax` are supplied, their floating-point values must be
  equal.
- `FEM.mesh`, when present, is a nonempty imported/prebuilt mesh reference. Import does not bypass
  region, boundary, unit, order, orientation, and compatibility validation.
- a valid FEM mesh is conforming across shared material and magnetic/air interfaces unless an
  explicitly different formulation owns a discontinuous trace.
- a mesh accepted on CPU is usable on GPU only when every realized element family, polynomial
  order, interaction, and auxiliary operator has a qualified GPU implementation.

## Complete FEM mode matrix

| Requested mode | Python authoring | Control Room authoring | Realized topology | Reviewed support boundary |
|---|---|---|---|---|
| inherited/automatic | omit object override or use `mesh_strategy="auto"` | `Use object policy` off or `Mesh strategy = Inherited` | planner/build-mode dependent | executable only after resolved build report is inspected |
| free tetrahedral | `mesh_strategy="free_tetrahedral"` or ordinary `object.mesh(...)` | `Free tetrahedral` | unstructured tetrahedra | primary general-purpose shared-domain path |
| thin-film tetrahedral | `mesh_strategy="thin_film_tetrahedral"` or thin-film helper with tetrahedral topology | advanced authored JSON / Python round-trip | thickness-aware tetrahedra | geometry- and build-mode dependent |
| exact layered prism | complete `swept_prism` recipe | `Layered prism (exact)` | prisms in the film plus certified transition elements | UI capability-gated; exact 1/2/3 element layers in the reviewed scope |
| swept hex | complete `swept_hex` recipe | visible but disabled as unsupported | hexahedra, where a conforming route exists | represented by the Python schema but not production-enabled in the reviewed Control Room gate |
| boundary-layer sequence | `MeshOperation("boundary_layers", ...)` or boundary-layer fields | boundary-layer count/thickness/stretching plus semantic selectors or raw tags | prismatic layers adjacent to selected entities | requires successful selector resolution and compatible shared-domain topology |
| imported/prebuilt mesh | `FEM(mesh=...)` or object `source=...` | `Mesh source` / advanced JSON | asset-defined | source asset must pass extraction and semantic validation |
| strict mixed prism–pyramid–tetrahedron | complete exact prism request with `pyramid_to_tetrahedra` | canonicalized automatically by `Layered prism (exact)` | prism film, pyramid transition, tetrahedral exterior | bounded, certificate-driven production route; no silent free-tetra fallback |

`mesh_strategy` describes requested topology. `build_mode` and `operation_statuses` describe what
actually ran. They must not be collapsed into one field.

(python-api-discretization-fem-python-api)=
## Python API

### `FEM` constructor

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---:|---:|---|---|---|---|
| `FEM.order` | `int` | required | 1 | integer >= 1; production planners require 1 | study-level finite-element field order | FEM CPU/GPU production: P1 only; higher order planned | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required unless `hmax` is supplied | m | finite and > 0 | canonical study-level maximum-size target | FEM | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.hmax` | `float or None` | `None` | m | alias; must equal `maximum_element_size` when both are present | compatibility spelling of the same target | FEM | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.mesh` | `str or None` | `None` | 1 | nonempty when present | imported/prebuilt mesh reference | FEM import/extraction path | `backend_policy.discretization_hints.fem.mesh` |
| `FEM.demag_solver_policy` | `FemLinearSolverPolicy or None` | `None` | 1 | typed policy | Poisson/demag algebraic solver request; does not alter mesh geometry | FEM demag lanes | `backend_policy.discretization_hints.fem.demag_solver_policy` |

### Related typed objects

These types are exported from `fullmag.model`, not from the top-level `fullmag` namespace:

```python
from fullmag.model import MeshOperation, MeshSizeControls, PerObjectMeshRecipe, SharedMeshAssemblyPolicy
```

| Object | Owned controls | Purpose |
|---|---|---|
| `PerObjectMeshRecipe` | object sizes, algorithms, topology, layers, boundary layers, quality, size fields, operation sequence | overrides one magnetic object's inherited mesh intent |
| `MeshOperation` | `kind`, `params`, `enabled` | ordered COMSOL-like meshing operation |
| `MeshSizeControls` | calibration, preset, hmin/hmax, growth, curvature, narrow-region resolution | standalone compatibility payload; currently unattached to ProblemIR |
| `SweepDistribution` | `kind`, `num_layers`, `growth_rate` | typed through-thickness distribution |
| `SweptMeshControls` | distribution, direction, family, transition, exact-layer flag | strict typed swept-mesh intent |
| `SharedMeshAssemblyPolicy` | interface factor, conformity, airbox factor | low-level shared-domain assembly policy |
| `FemLinearSolverPolicy` | solver, preconditioner, tolerances, budget, print level | Poisson/demag algebraic policy, not a meshing control |

### Complete stage-first scenario

```python
# %% Shared-domain FEM with an exact layered film and graded airbox
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_mesh_reference")
study.engine("fem")
study.device("cpu", precision="double")
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
    max_iterations=500,
)
study.build_domain_mesh()
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="nonlinear_cg",
    tolT=1.0e-6,
    max_steps=50_000,
)
```

The explicit `study.build_domain_mesh()` request materializes the authored geometry and mesh policy.
A later geometry or mesh-policy change invalidates that mesh; the UI marks the current realization
stale until it is rebuilt.

## Control Room mapping

The active FEM mesh controls are split by semantic owner:

| UI selection/panel | What it edits | Backend resource/command |
|---|---|---|
| selected magnetic object -> `Object Mesh Policy` | one object override and local refinement | object mesh policy replace resource |
| selected universe/airbox -> `Airbox Mesh Parameters` | shared exterior geometry and FEM air size policy | universe mesh policy replace resource |
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
- element and facet counts by family, order, region, and role;
- requested and realized layer count, node planes, sweep direction, and transition topology;
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
- an imported mesh does not bypass unit or semantic-marker validation.

(python-api-discretization-fem-discrete-realization)=
## Device and solver realization

| Solver | Device | Mesh contract |
|---|---|---|
| FEM | CPU | generated/imported shared-domain mesh extracted into native/MFEM host structures |
| FEM | GPU | the identical content-addressed mesh is consumed by supported device operators; element-family and order coverage are capability-gated |
| FDM | CPU/GPU | not applicable to this page; FDM uses object-owned Cartesian grids and masks |

Meshing itself is generally a host/Gmsh operation. A final FEM GPU simulation does not imply that
CAD construction, Gmsh generation, selector resolution, or quality analysis ran on the GPU.

(python-api-discretization-fem-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| study-level schema and lowering | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` |
| per-object schema and topology validation | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class PerObjectMeshRecipe` |
| operation sequence | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class MeshOperation` |
| typed swept controls | `packages/fullmag-py/src/fullmag/model/discretization.py` | `SweepDistribution`, `SweptMeshControls` |
| stage-first mesh authoring | `packages/fullmag-py/src/fullmag/world.py` | mesh facades on `StudyBuilder` and magnetic object handles |
| target precedence | `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` | `resolve_shared_domain_targets` |
| Gmsh shared-domain generation | `packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py` | shared assembly owner |
| swept generation | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | sweepability and swept construction owners |
| size-field composition | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | size-field plan owner |
| extraction | `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | native extraction owner |
| realization/degradation report | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_shared_domain_build_report` |
| object UI and request canonicalization | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts` | `buildObjectMeshPolicyReplaceRequest` |
| object mesh inspector | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx` | `ObjectMeshPolicyPanel` |
| airbox UI and transaction | `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx` | `AirboxMeshParametersPanel` |
| airbox request canonicalization | `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts` | `buildAirboxMeshPolicyReplaceRequest` |

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
- high field order does not repair low-order geometry automatically.
- exact layered prism support is intentionally narrow and capability-gated.
- swept hex is represented in schemas but disabled in the reviewed Control Room production gate.
- general multi-object and general airbox-plus-swept workflows remain scenario-dependent.
- boundary layers and semantic selectors can degrade when CAD/component identities are lost.
- the current contract does not claim universal automatic a posteriori adaptivity.

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
| constructor and aliases | FEM CPU/GPU authoring | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FEM.__init__`, `FEM.to_ir` | validation and canonical lowering | signature/round-trip tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/ec6f2374e04cbd0d1e75b94c81da07af50da3789/packages/fullmag-py/src/fullmag/model/discretization.py) |
| complete object recipe | FEM CPU/GPU authoring | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe.__post_init__`, `PerObjectMeshRecipe.to_ir` | topology legality and object policy | unit and meshing tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/ec6f2374e04cbd0d1e75b94c81da07af50da3789/packages/fullmag-py/src/fullmag/model/discretization.py) |
| Control Room canonicalization | Control Room, FEM | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts` | `buildObjectMeshPolicyReplaceRequest` | typed draft to canonical JSON | model/DOM tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/ec6f2374e04cbd0d1e75b94c81da07af50da3789/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts) |
| airbox transaction | Control Room, FEM | `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts` | `buildAirboxMeshPolicyReplaceRequest` | universe policy and FEM-only filtering | panel/model tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/ec6f2374e04cbd0d1e75b94c81da07af50da3789/apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts) |
| realized report | FEM CPU/GPU shared mesh | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_shared_domain_build_report` | requested/resolved provenance | meshing fallback and report tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/ec6f2374e04cbd0d1e75b94c81da07af50da3789/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py) |
