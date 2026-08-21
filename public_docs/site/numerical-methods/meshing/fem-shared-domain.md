---
title: FEM Shared-Domain Mesh
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: 88c7160080bc1e8519950df283d2dd02087cc3da
source_of_truth: FEM and per-object mesh schemas, shared Gmsh assembly/extraction, target resolution, and SharedDomainBuildReport
---

(public-docs-numerical-methods-meshing-fem-shared-domain)=
# FEM shared-domain meshing

:::{admonition} One solver mesh, several physical regions
:class: important

Fullmag's FEM workflow builds one conforming mesh for magnetic objects and, when required, the
nonmagnetic air region. Region attributes determine where magnetization, material coefficients,
scalar potential, and boundary terms exist. Concatenating independently meshed objects is not
mathematically equivalent to a conforming shared domain.
:::

(numerical-methods-fem-shared-domain-problem-statement)=
## Discrete domain

Let

```{math}
:label: eq-numerical-fem-shared-domain
\Omega_h
=\left(\bigcup_{r=1}^{R}\Omega_{m,r,h}\right)
\cup\Omega_{a,h}
```

be the realized solver domain, with magnetic subdomains $\Omega_{m,r,h}$ and optional air region
$\Omega_{a,h}$. A conforming mesh $\mathcal T_h$ satisfies

```{math}
:label: eq-numerical-fem-shared-conformity
\overline T_i\cap\overline T_j
\in\{\varnothing,\text{shared vertex},\text{shared edge},\text{shared face},
\overline T_i=\overline T_j\}
```

for distinct elements, excluding invalid overlaps. At an internal material interface, neighbouring
elements share the same geometric trace rather than duplicate coincident nodes.

For a P1 scalar basis $\{\phi_a\}$, one component of reduced magnetization is

```{math}
:label: eq-numerical-fem-shared-field
m_q^h(\mathbf x)=\sum_{a\in\mathcal I_m}m_{q,a}\phi_a(\mathbf x),
\qquad q\in\{x,y,z\},
```

where $\mathcal I_m$ contains magnetic degrees of freedom. A demagnetizing scalar potential may be
defined on a larger index set spanning magnetic and air elements. The two fields therefore share a
geometric mesh without necessarily sharing their algebraic spaces.

(numerical-methods-fem-shared-region-semantics)=
## Region and boundary attributes

The native solver does not infer physics from display names or mesh colour. The realized mesh must
carry stable integer attributes for:

- every magnetic object/material region;
- nonmagnetic air;
- external airbox boundary;
- physical outer surfaces of magnetic bodies;
- selected interfaces, edges, or corners used by size fields;
- periodic source/target faces and their orientation/translation;
- any boundary subset used by Dirichlet, Robin, surface anisotropy, DMI, or coupling terms.

For a piecewise coefficient $c(\mathbf x)$,

```{math}
:label: eq-numerical-fem-shared-piecewise-coefficient
c_h(\mathbf x)
=\sum_r c_r\mathbf 1_{\Omega_{r,h}}(\mathbf x).
```

A wrong region marker therefore changes the assembled operator even when all nodes and elements are
geometrically correct. Production validation checks both topology and attribute ownership.

Air is not automatically a magnetic material with $M_s=0$. Magnetization integration and torque
reduction must use the magnetic mask/submesh explicitly; scalar-potential operators may use the
shared magnetic-plus-air space.

(numerical-methods-fem-shared-resolution-precedence)=
## Resolution precedence

Fullmag resolves each object's target size through one code-owned precedence chain. At the reviewed
revision, `_mesh_targets.py` specifies highest to lowest:

1. `PerObjectMeshRecipe.hmax`;
2. `mesh_workflow.per_geometry[...].hmax`;
3. `mesh_workflow.default_mesh.hmax`;
4. study-level `FEM.hmax` / `FEM.maximum_element_size`.

For object $r$, denote the resolved target by $h_{r,\max}^{\mathrm{req}}$. The airbox has its own
$h_{a,\max}^{\mathrm{req}}$, optional $h_{a,\min}^{\mathrm{req}}$, and growth target. These are
mesher targets, not guarantees. The build report records the source and effective value selected for
each partition.

The public `FEM` schema requires:

```{math}
:label: eq-numerical-fem-shared-order-size
p\geq1,
\qquad
h_{\max}>0.
```

`hmax` is a compatibility alias for `maximum_element_size`; when both are supplied they must agree.
A nonempty `mesh` path may select a prebuilt mesh, but that asset still requires region, boundary,
coordinate, order, and compatibility validation.

(numerical-methods-fem-shared-size-fields)=
## Local targets and transition zones

A shared mesh may combine:

- bulk object target `hmax`;
- explicit interface target and thickness;
- transition distance and growth;
- edge target and edge-zone thickness;
- corner target and extent;
- airbox near/far targets;
- boundary-layer, swept, or generic size-field operations.

The resolved target is conceptually a minimum over active fields,

```{math}
:label: eq-numerical-fem-shared-size-min
h_{\mathrm{target}}(\mathbf x)
=\min_s h_s(\mathbf x),
```

subject to mesher algorithms, conformity, and growth constraints. An unexpectedly small active
field can therefore refine a much larger region. Fullmag records realized size-field IDs, kinds,
targets, status, source, reason, Gmsh field ID, and parameters through
`_realized_size_field_report`.

Interface refinement is not auto-enabled by a hidden factor in the current target resolver. The
source explicitly avoids an older automatic `0.6 × bulk` rule because it throttled smooth growth
through the airbox. A fine interface target must therefore be requested and should appear in the
build report.

(numerical-methods-fem-shared-build-modes)=
## CAD assembly, fallback, and degradation

The preferred shared-domain path preserves conformal CAD/OCC identities. Runtime build mode and
fallback history are first-class provenance. `_build_shared_domain_build_report` marks a report
`degraded` when topology or identity was simplified, including
`build_mode="concatenated_stl_fallback"`, except for a bounded set of nondegrading algorithm retries
that preserve the conformal CAD path.

The report separates:

| Field | Meaning |
|---|---|
| `build_mode` | actual assembly/extraction route |
| `fallbacks_triggered` | ordered fallback/retry reasons |
| `degraded` | whether topology/identity semantics were simplified |
| `effective_airbox_target` | resolved airbox size/growth request |
| `effective_per_object_targets` | resolved object/interface/edge/corner targets and markers |
| `region_markers` | geometry-to-native attribute mapping |
| `size_fields_realized` | requested/applied/ignored/degraded size fields |
| `operation_statuses` | algorithm, optimizer, airbox shape, swept, boundary-layer and other outcomes |
| `thin_film_diagnostics` | requested versus actual thin-film topology/layers |
| `magnetic_submesh_signatures` | identities of extracted magnetic portions |
| `selector_resolution` | geometric selector to native-tag resolution |
| `orphan_entities` | entities not assigned to the intended region/topology |
| `authored_regions_count` / `realized_regions_count` | authoring-to-mesher coverage check |

A fallback is not necessarily invalid. It is invalid to present a degraded result as if it retained
all requested region, selector, airbox-shape, or swept-topology semantics.

(numerical-methods-fem-shared-extraction)=
## Native extraction and solver identity

After Gmsh generation, Fullmag extracts nodes, elements, attributes, and boundaries into the native
solver representation. The authoritative mesh identity is the extracted asset, not an in-memory
Gmsh preview. At minimum the digest covers:

- SI-scaled coordinates and coordinate dimension;
- element connectivity, type, order, and orientation;
- volume and boundary attributes;
- magnetic submesh selection;
- periodic pair map and translations;
- geometry and mesh-order metadata;
- build mode, generation options, and relevant Gmsh version.

The extraction must preserve positive element orientation. For an affine tetrahedron with mapping
Jacobian $J_T$,

```{math}
:label: eq-numerical-fem-shared-jacobian
\det J_T>0.
```

For curved/high-order elements, the Jacobian must remain positive at all required evaluation points,
not only at vertices.

(numerical-methods-fem-shared-interface-checks)=
## Interface and topology checks

A production shared-domain certificate verifies:

1. every expected magnetic object has at least one volume element and one stable region marker;
2. air and magnetic volumes are disjoint except at conforming interfaces;
3. shared interfaces contain no duplicate disconnected node layers unless the physical formulation
   explicitly requires them;
4. every internal face has the expected adjacent region tuple;
5. every external face belongs to exactly the intended boundary category;
6. no orphan volume/surface/curve entities remain after Boolean fragmentation and extraction;
7. material and boundary selectors resolve to nonempty native tags;
8. periodic faces have compatible topology and one-to-one algebraic pairing;
9. magnetic submesh signatures agree with the field/operator asset consumed by the solver;
10. reported physical bounds and volume agree with the intended geometry within the mesh tolerance.

A viewport can hide duplicate coincident interfaces, inverted elements, and wrong region attributes.
These checks must use mesh topology and native attributes.

(numerical-methods-fem-shared-python-api)=
## Python API

```python
# %% Shared FEM domain with independent air and object targets
import fullmag as fm

nm = 1.0e-9
study = fm.study("shared_domain")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(1.2e-6, 600 * nm, 550 * nm))
study.universe.mesh(
    minimum_element_size=10 * nm,
    maximum_element_size=110 * nm,
    maximum_element_growth_rate=1.9,
    grading="geometric",
)

film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.mesh(
    minimum_element_size=3 * nm,
    maximum_element_size=5 * nm,
    order=1,
    compute_quality=True,
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

A lower-level typed default can be represented by

```python
fem = fm.FEM(order=1, maximum_element_size=20 * nm)
```

and per-object recipes by `PerObjectMeshRecipe`. The stage-first helpers lower to the same mesh
workflow intent; the extracted mesh and build report remain authoritative.

### Core public parameters

| Python field | Default | SI unit | Validation and meaning |
|---|---:|---:|---|
| `FEM.order` | required | $1$ | integer $\geq1$; finite-element field order |
| `FEM.maximum_element_size` / `hmax` | required | $\mathrm m$ | positive study-level default target |
| `FEM.mesh` | `None` | path/ID | nonempty prebuilt asset reference when provided |
| `PerObjectMeshRecipe.maximum_element_size` / `hmax` | inherited | $\mathrm m$ | highest-precedence object target |
| `PerObjectMeshRecipe.minimum_element_size` / `hmin` | inherited | $\mathrm m$ | lower target bound |
| `PerObjectMeshRecipe.order` | inherited | $1$ | object-specific order where supported |
| interface/edge/corner fields | inherited | $\mathrm m$ or $1$ | local target and transition controls |
| `compute_quality` | `False` | $1$ | request quality summary |
| `per_element_quality` | `False` | $1$ | request per-element quality where supported |
| `operations` | empty | $1$ | ordered COMSOL-like mesh operations |

The exact per-object API inventory is documented under the Python discretization section; this page
owns the mathematical and runtime meaning of the realized shared mesh.

(numerical-methods-fem-shared-problem-ir)=
## ProblemIR and provenance

Requested intent stores geometry, universe, FEM defaults, object recipes, size fields, selectors,
and ordered operations. Resolved execution stores:

- exact source of every effective object/airbox target;
- native mesh digest and magnetic submesh signatures;
- Gmsh/build versions and generation options;
- build mode, fallbacks, degradation status, and reasons;
- node/element counts by type, order, and region;
- boundary-element counts by attribute;
- bounds, region volumes, surface areas, and connectivity components;
- Jacobian/quality statistics and rejected-element count;
- selector and periodic-pair certificates;
- requested/applied/ignored/degraded operation inventory;
- authored versus realized region/size-field counts.

A rerun from the same high-level size targets is not necessarily the same discrete problem after a
mesher-version or algorithm change. Save or content-address the realized asset.

(numerical-methods-fem-shared-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Invalid order/size/path values fail at the public boundary. Mesh construction fails or is explicitly
marked degraded for:

- Boolean fragmentation or conformal assembly failure;
- empty/missing magnetic partitions;
- inverted, collapsed, or unsupported elements;
- unresolved material/boundary selectors;
- duplicate or orphan entities;
- attribute loss during extraction;
- incompatible periodic faces;
- unsupported swept/boundary-layer operation;
- a fallback that violates strict-mode requested semantics.

Algorithm retry may be acceptable when the build report proves that region/topology identities were
preserved. `concatenated_stl_fallback` is explicitly degradation evidence and cannot be hidden by a
successful tetrahedral solve.

(numerical-methods-fem-shared-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | source-backed | Gmsh shared-domain asset extracted into MFEM/native host structures |
| FEM | GPU | mesh source-backed, execution-gated | the same content-addressed mesh uploaded/consumed by supported device operators |
| FDM | CPU | not applicable | use Cartesian grid and active-mask pages |
| FDM | GPU | not applicable | use Cartesian grid and active-mask pages |

CPU/GPU parity requires the same mesh digest, attributes, magnetic submesh, polynomial order, and
quadrature policy. Regenerating a nominally equivalent mesh separately invalidates strict parity.

(numerical-methods-fem-shared-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol/owner |
|---|---|---|
| Study FEM defaults | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` |
| Per-object mesh intent | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class PerObjectMeshRecipe`, `class MeshOperation` |
| Target precedence and typing | `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` | `resolve_shared_domain_targets`, `ResolvedSharedObjectTarget` |
| Shared CAD/Gmsh infrastructure | `packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py` | shared assembly owner |
| Native mesh extraction | `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | extraction owner |
| Build report and degradation | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_shared_domain_build_report` |
| Realized size-field reporting | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_realized_size_field_report` |

(numerical-methods-fem-shared-validation)=
## Verification and convergence

1. **Constant/affine interpolation:** reproduce the polynomial degree expected from the field space.
2. **Mass/volume:** integrate one over each attribute and compare with analytical/CAD volume.
3. **Region coefficients:** assemble a piecewise constant coefficient and verify element-wise values.
4. **Interface conformity:** compare face-node identities and adjacent region tuples.
5. **Operator null cases:** constant magnetization gives zero compatible exchange contribution.
6. **Quality:** enforce positive Jacobian and declared scaled-Jacobian/aspect/angle thresholds.
7. **Target realization:** compare requested and measured element sizes by region/interface/edge/corner.
8. **Fallback tests:** intentionally trigger algorithm retry and degraded STL fallback; verify status
   semantics and strict rejection.
9. **Mesh convergence:** refine $h$, optionally $p$, and geometry order independently for a declared
   observable.
10. **Backend identity:** CPU/GPU consume the same extracted mesh and marker digests.
11. **Application benchmarks:** validate equilibrium, switching, demag, and eigen/response cases on
    converged mesh families rather than one generated mesh.

(numerical-methods-fem-shared-limitations)=
## Limitations

- High-order field approximation does not automatically improve a low-order curved boundary.
- Mesher size values are targets, not exact realized bounds.
- Fallback can preserve solvability while degrading region, selector, airbox-shape, or swept intent.
- A shared mesh does not imply that all physical unknowns are defined on every region.
- Successful extraction does not by itself prove positive high-order Jacobians or good conditioning.
- Current swept support is geometry- and shared-domain-scenario-dependent; see
  {doc}`swept-meshes`.
- This page does not claim production adaptive remeshing or a posteriori error estimation.

(numerical-methods-fem-shared-scientific-bibliography)=
## Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh: A three-dimensional finite element mesh generator with
   built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in
   Engineering* **79**, 1309--1331 (2009),
   [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
2. R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics
   with Applications* **81**, 42--74 (2021),
   [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).
3. S. C. Brenner and L. R. Scott, *The Mathematical Theory of Finite Element Methods*, 3rd ed.,
   Springer, 2008, [doi:10.1007/978-0-387-75934-0](https://doi.org/10.1007/978-0-387-75934-0).

(numerical-methods-fem-shared-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Target precedence | `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` | `resolve_shared_domain_targets` | typed air/object target resolution | source/unit tests |
| Shared build report | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_shared_domain_build_report` | fallback/degradation and realized operations | source/tests |
| Native extraction | `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | extraction module | nodes/elements/attributes | meshing tests |
| Authoring contract | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FEM`, `PerObjectMeshRecipe` | defaults and per-object overrides | Python validation/IR tests |
