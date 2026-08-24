---
title: Swept Meshes
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: 88c7160080bc1e8519950df283d2dd02087cc3da
source_of_truth: SweptMeshControls, PerObjectMeshRecipe, _gmsh_swept, shared-domain build report, and mixed-layer topology certificate
---

(public-docs-numerical-methods-meshing-swept-meshes)=
# Swept and mixed-layer meshes

:::{admonition} Swept intent is not universal shared-domain support
:class: important

Fullmag has typed swept-mesh intent and a strict mixed prism/pyramid/tetrahedron certificate, but
not every geometry composition is executable. The reviewed shared-domain path rejects or reports a
fallback for general multi-object and ordinary airbox-plus-swept requests. Requested topology,
actual topology, layer count, sweep axis, and fallback reason must be read from realization evidence.
:::

(numerical-methods-swept-problem-statement)=
## Purpose

A thin magnetic body often has in-plane dimensions much larger than thickness. Free tetrahedral
meshing can then create many elements, poorly resolved thickness layers, or high aspect ratios with
uncontrolled node placement. A swept mesh starts from a two-dimensional source-face mesh and
extrudes it along a sweep direction.

Let a body occupy

```{math}
:label: eq-numerical-swept-domain
\Omega=\left\{\mathbf x_s+z\mathbf n:
\mathbf x_s\in S,
0\leq z\leq t\right\},
```

where $S$ is a source surface, $\mathbf n$ the sweep direction, and $t$ the physical thickness.
Layer planes satisfy

```{math}
:label: eq-numerical-swept-layer-planes
0=z_0<z_1<\cdots<z_{N_z}=t,
\qquad
h_j=z_{j+1}-z_j.
```

Triangular source faces produce prisms; quadrilateral source faces can produce hexahedra. A conforming
connection to an unstructured tetrahedral air region may require pyramids and a transition shell.

(numerical-methods-swept-distributions)=
## Through-thickness distributions

`SweepDistribution` supports:

| Kind | Layer policy | Public parameters |
|---|---|---|
| `uniform` | equal thickness | `num_layers` |
| `arithmetic` | linearly changing thickness | `num_layers`, positive `growth_rate` |
| `geometric` | multiplicative change | `num_layers`, positive `growth_rate` |

For a uniform distribution,

```{math}
:label: eq-numerical-swept-uniform
h_j=\frac{t}{N_z}.
```

For a geometric ratio $r>0$,

```{math}
:label: eq-numerical-swept-geometric
h_j=h_0r^j,
\qquad
h_0=t\frac{r-1}{r^{N_z}-1}
\quad(r\neq1).
```

An arithmetic distribution can be represented by $h_j=h_0+j\Delta h$ with positive layer sizes and
sum $t$. The exact native realization and symmetry policy belong to the generated mesh report; these
equations define the requested distribution family.

`exact_layer_count=True` is accepted only with the typed uniform distribution. In the stricter
per-object prism workflow, exact layer count is mandatory. A generated mesh must report the actual
plane coordinates, not only the requested integer.

(numerical-methods-swept-axis)=
## Sweep direction

`SweptMeshControls.sweep_direction` accepts `auto`, `x`, `y`, or `z`. `auto` resolves from geometry,
with the shortest bounding-box axis as the documented intent for the typed control. This heuristic
is not sufficient for every curved/extrudable body. The realized source/destination faces and axis
must be certified.

For a unit direction $\mathbf n$, the projected coordinate is

```{math}
:label: eq-numerical-swept-coordinate
z(\mathbf x)=\mathbf n\cdot(\mathbf x-\mathbf x_{\mathrm{ref}}).
```

All magnetic layer nodes should lie on the certified planes $z_j$ within the recorded absolute and
relative tolerances. A mesh with the correct number of elements but drifting layer planes does not
satisfy exact through-thickness intent.

(numerical-methods-swept-topology)=
## Topology families and transitions

The reviewed typed vocabulary is:

| Control | Values | Contract |
|---|---|---|
| `element_family` | `prism`, `hex` | source-face and transition requirements differ |
| `transition_policy` | `pyramid_to_tetrahedra`, `reject` | allow a certified mixed transition or reject it |
| `exact_layer_count` | Boolean | requested and realized layers must agree under strict topology |
| per-object `mesh_strategy` | `swept_prism`, `swept_hex`, `thin_film_tetrahedral`, `free_tetrahedral`, `auto` | selects requested topology route |
| `sweep_face_meshing` | `triangular`, `quadrilateral` | triangular for prism, quadrilateral for hex |
| `topology` | `prismatic`, `tetrahedral` | high-level topology constraint |

The Python schema rejects contradictory combinations:

- `hex` with `pyramid_to_tetrahedra`;
- `exact_layer_count=True` with a nonuniform typed distribution;
- prismatic intent with order other than one;
- prism without `mesh_strategy="swept_prism"`;
- prism without triangular source faces;
- strict prism with `exact_layer_count=False`;
- `topology="prismatic"` without `pyramid_to_tetrahedra`;
- hex without `mesh_strategy="swept_hex"` and quadrilateral source faces;
- tetrahedral topology combined with swept-specific axis/family/transition controls.

This is fail-closed validation. Invalid topology intent is not converted silently into free
tetrahedra.

(numerical-methods-swept-mixed-topology)=
## Certified prism–pyramid–tetrahedron shared domain

The mixed shared-domain route connects a layered magnetic prism region to a tetrahedral air region
through pyramids. The accepted `MixedLayerTopologyCertificate` records and enforces:

- requested and resolved sweep direction are equal;
- requested and realized layer counts are equal;
- exactly $N_z+1$ strictly increasing magnetic plane coordinates;
- positive plane tolerance and transition-shell thickness;
- at least one triangular interface facet in the transition shell;
- distinct positive interface and outer-boundary markers;
- magnetic and airbox authored bounds within a relative-error limit of $10^{-8}$;
- positive magnetic, air, and shared-domain volumes;
- magnetic/shared volume relative errors not exceeding $10^{-8}$;
- complete marker coverage;
- zero nonconforming, orphan, nonmanifold, and coincident interface faces;
- topology fingerprint with an accepted version and SHA-256 form;
- cell-family counts by marker and part;
- facet-family counts by role and marker;
- Jacobian and scaled-Jacobian statistics by family;
- deterministic mesher inputs and all fallbacks.

The supported linear cell/facet vocabulary in `_gmsh_types.py` is `tet4`, `prism6`, `pyramid5`,
`hex8`, `tri3`, and `quad4`. Compatible-looking prefixes of higher-order connectivity are not
accepted as these linear types.

The mixed quality metric is explicitly identified as
`tetra_decomposition_scaled_jacobian.v1`. The source-defined 5th-percentile scaled-Jacobian gate is
$0.1$ for the deterministic mixed route. This threshold qualifies only that named certificate and
must not be generalized to all meshes or element families without a separate criterion.

(numerical-methods-swept-current-boundaries)=
## Current executable boundaries

`mesh_build_report.py` makes the reviewed support boundary explicit:

| Shared-domain scenario | Current reported behavior |
|---|---|
| single `Box` with `build_mode="single_geometry_geo_mixed"` | eligible for the strict mixed shared-domain route |
| single `ArchWaveguide` in the component-aware path | source-visible specialized handling; reported actual method may be `layered_surface_tetrahedral` rather than requested swept volume family |
| airbox combined with the ordinary shared-domain swept workflow | reported unsupported: `airbox combined-domain swept workflow is not implemented` |
| multiple magnetic objects with general shared-domain swept intent | reported unsupported: `multi-object shared-domain swept workflow is not implemented` |
| generic component/concatenated STL path | reports free tetrahedral meshing or a degraded/fallback method rather than claiming swept topology |

The strict mixed box/airbox certificate is a distinct implementation from the broad ordinary
shared-domain swept request. Documentation and UI must not infer universal airbox+swept support from
the certificate type alone.

(numerical-methods-swept-element-quality)=
## Element quality and anisotropy

A swept element may be intentionally anisotropic, but it must remain nondegenerate. For every
mapping $F_e$,

```{math}
:label: eq-numerical-swept-jacobian
\det\nabla F_e(\boldsymbol\xi)>0
```

at all required evaluation points. Relevant diagnostics include:

- signed inverse condition number and gamma/radius quality;
- family-specific minimum Jacobian;
- scaled-Jacobian minimum and lower percentile;
- in-plane edge lengths and layer thicknesses;
- prism/hex warpage and skewness;
- pyramid apex position and transition-face conformity;
- element volume range and ratio;
- exact layer-plane deviations.

High aspect ratio can be physically appropriate when the solution is nearly constant across the
long directions, but it can worsen conditioning and interpolation error when the mode varies along
the stretched axis. Layer count is therefore selected from physical through-thickness scales, not
only geometry thickness.

(numerical-methods-swept-physics-resolution)=
## Choosing the layer count

A one-layer prism represents a P1 field whose nodal values may still vary between the two boundary
planes, unlike a one-cell FDM thickness average. It nevertheless has limited ability to represent
curvature of the through-thickness profile. Increase $N_z$ for:

- perpendicular standing spin-wave modes;
- asymmetric surface fields or surface anisotropy;
- depth-dependent DMI, torque, current, or material coefficients;
- vortex/domain-wall structures varying across thickness;
- dynamic demagnetizing fields with thickness structure;
- coupled multilayers or nonuniform interfaces.

A layer-refinement study holds in-plane mesh, geometry, airbox, time/linear tolerance, and output
observable controlled while increasing $N_z$.

(numerical-methods-swept-python-api)=
## Python API

### Stage-first thin-film recipe

```python
# %% Strict single-layer prism request for an eligible shared-domain route
import fullmag as fm

nm = 1.0e-9
study = fm.study("single_layer_prism")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(320 * nm, 320 * nm, 120 * nm))

# The equivalent typed sweep request can be inspected independently of execution.
sweep = fm.SweptMeshControls(
    distribution=fm.SweepDistribution(kind="uniform", num_layers=2),
    sweep_direction="z",
    element_family="prism",
    transition_policy="pyramid_to_tetrahedra",
    exact_layer_count=True,
)

film = study.geometry(fm.Box(300 * nm, 300 * nm, 2 * nm), name="film")
film.mesh.thin_film(
    minimum_element_size=4 * nm,
    maximum_element_size=6 * nm,
    layers=2,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="nonlinear_cg",
    tolT=1.0e-6,
    max_steps=50_000,
)
```

The exact stage helper lowers to per-object mesh intent. The realization report/certificate decides
whether the request executed unchanged.

### Public typed parameters

| Field | Default | Validation | Meaning |
|---|---:|---|---|
| `SweepDistribution.kind` | `uniform` | `uniform`, `arithmetic`, `geometric` | layer-size family |
| `SweepDistribution.num_layers` | `1` | positive integer, Boolean rejected | element-layer count |
| `SweepDistribution.growth_rate` | `1.0` | positive for nonuniform kinds | arithmetic/geometric grading |
| `SweptMeshControls.sweep_direction` | `auto` | `auto`, `x`, `y`, `z` | requested axis |
| `SweptMeshControls.element_family` | `prism` | `prism`, `hex` | swept cell family |
| `SweptMeshControls.transition_policy` | `reject` | `pyramid_to_tetrahedra`, `reject` | shared-domain transition |
| `SweptMeshControls.exact_layer_count` | `False` | Boolean; typed true requires uniform distribution | strict layer preservation |

Per-object recipes add `through_thickness_elements`, distribution, ratio, symmetry, source-face
meshing, topology, and strict consistency gates.

(numerical-methods-swept-problem-ir)=
## ProblemIR and provenance

Record requested and resolved:

- mesh strategy, topology, cell family, source-face family;
- sweep axis, source/destination selectors, and physical thickness;
- distribution kind, growth/ratio, symmetry, and layer count;
- exact layer plane coordinates and tolerances;
- transition policy, shell thickness, interface/outer markers;
- cell/facet family counts by region and role;
- quality/Jacobian statistics by family;
- magnetic/air/shared volumes and expected-value errors;
- nonconforming/orphan/nonmanifold/coincident-face counters;
- build mode, fallback/degradation reason;
- topology fingerprint, deterministic inputs, mesher version/thread count;
- requested/resolved element order and device lane.

`MeshRealizationReport.v1` requires requested/resolved topology, layers, axis, and order to match when
no fallback marker is present. A changed topology without a fallback is invalid provenance.

(numerical-methods-swept-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Fail for contradictory controls, nonextrudable geometry under strict intent, invalid selectors,
layer-plane collapse, negative Jacobian, missing transition facets, marker collision, incomplete
coverage, nonconforming/orphan interfaces, unsupported higher-order family, or requested/resolved
mismatch without fallback.

Fallback is legal only when the authoring mode permits it and the report identifies the actual
method. `strict` production intent should reject free-tetrahedral replacement of a requested prism
or hex mesh.

(numerical-methods-swept-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | partial-production-executable | bounded strict P1 lane: one axis-aligned box, one airbox, exactly 1, 2, or 3 layers, with prism6/pyramid5/tet4 cells |
| FEM | GPU | partial-production-executable | the same bounded certified P1 mesh and layer set; every enabled operator must support all realized cell families |
| FDM | CPU | not applicable | use Cartesian cells and explicit thickness count |
| FDM | GPU | not applicable | use Cartesian cells and explicit thickness count |

A GPU FEM claim additionally requires device kernels for every realized family (`prism6`,
`pyramid5`, `tet4`, or `hex8`) and every enabled interaction. A valid CPU mesh is not sufficient.
The current executable mixed-prism slice is double precision with explicit CPU or GPU selection;
`auto`, `single`, extended-mode fallback, additional magnetic bodies, and layer counts outside
`{1, 2, 3}` fail closed. Its implemented status is not a production-validation claim.

(numerical-methods-swept-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol/owner |
|---|---|---|
| Typed distribution and sweep controls | `packages/fullmag-py/src/fullmag/model/discretization.py` | `SweepDistribution`, `SweptMeshControls` |
| Per-object strict consistency | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe.__post_init__` |
| Geometry classification/generation | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `classify_sweepability`, swept module owner |
| Shared-domain support/fallback status | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_shared_domain_swept_fallback_reason`, `_shared_domain_swept_actual_method` |
| Realization report | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `MeshRealizationReport` |
| Mixed topology certificate | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `MixedLayerTopologyCertificate` |
| Linear cell/facet dispatch | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `SUPPORTED_VOLUME_ELEMENTS`, `SUPPORTED_BOUNDARY_ELEMENTS` |

(numerical-methods-swept-validation)=
## Verification and convergence

1. Verify requested and realized layer planes and axis exactly under strict intent.
2. Integrate magnetic/shared volumes and compare with authored geometry.
3. Require positive family-specific Jacobians and accepted quality tails.
4. Verify every interface face has exactly the intended adjacent families/markers.
5. Require zero nonconforming, orphan, nonmanifold, and coincident interface faces.
6. Reconstruct the topology fingerprint deterministically.
7. Interpolate constant and linear through-thickness fields.
8. Compare prism/pyramid/tet and free-tetrahedral meshes on the same observable and converged
   resolution.
9. Perform layer-count, in-plane-size, and transition-shell refinements independently.
10. Test all declared unsupported scenarios and require explicit rejection/fallback status.
11. For CPU/GPU parity, consume the identical certified mixed mesh and verify operator-family
   coverage before comparing physics.

(numerical-methods-swept-limitations)=
## Limitations

- General multi-object shared-domain swept meshing is not implemented in the reviewed ordinary path.
- General airbox-plus-swept operation is not universally implemented; strict mixed box topology is a
  separate bounded route.
- Current strict mixed dispatch is for linear element families.
- One prism layer does not establish through-thickness convergence.
- Anisotropic elements can degrade conditioning and mode accuracy.
- `auto` axis resolution is heuristic and must be confirmed by realized selectors/planes.
- Specialized arch handling may report a tetrahedral layered method rather than a true prism sweep.
- A source-visible certificate class does not qualify every geometry, device, or interaction.

(numerical-methods-swept-scientific-bibliography)=
## Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh: A three-dimensional finite element mesh generator with
   built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in
   Engineering* **79**, 1309--1331 (2009),
   [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
2. R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics
   with Applications* **81**, 42--74 (2021),
   [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).

(numerical-methods-swept-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Typed legality | `packages/fullmag-py/src/fullmag/model/discretization.py` | `SweptMeshControls.__post_init__`, `PerObjectMeshRecipe.__post_init__` | contradictory-request rejection | Python tests |
| Current support boundary | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_shared_domain_swept_fallback_reason` | airbox/multi-object/component limitations | fallback tests |
| Requested/actual topology | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `MeshRealizationReport` | fallback-aware provenance | serialization tests |
| Strict mixed acceptance | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `MixedLayerTopologyCertificate.__post_init__` | layer, marker, volume, topology and quality gates | mixed-element tests |
