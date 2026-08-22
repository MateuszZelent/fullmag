---
title: Per-Object Meshing
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: 043201a94f769307c6b6e0db971da9a8a5eec57c
source_of_truth: PerObjectMeshRecipe, MeshOperation, object mesh facades, Control Room ObjectMeshPolicyPanel, and shared-domain realization reports
---

(public-docs-python-api-discretization-per-object-meshing)=
# Per-object FEM meshing

:::{admonition} Object policy is an override, not an independent mesh
:class: important

Each magnetic object may own a mesh recipe, but FEM execution still consumes one conforming
shared-domain mesh. Object policies are combined with the universe/airbox policy, interfaces,
periodicity, and topology constraints before Gmsh generation. An object recipe cannot be qualified
without the final shared-domain report.
:::

(python-api-discretization-per-object-meshing-problem-statement)=
## Authoring model

`PerObjectMeshRecipe` contains every typed object-level FEM mesh field. All optional values default
to inheritance. The stage-first object facade writes the same canonical recipe through
`object.mesh(...)` and its specialized helpers such as `object.mesh.thin_film(...)`.

The effective policy is assembled in this order:

1. study-level `FEM` default;
2. mesh-workflow object default;
3. per-geometry workflow target;
4. explicit object recipe;
5. region/interface/edge/corner and ordered size-field operations;
6. shared-domain conformity and airbox constraints;
7. capability and strict-mode gates.

The final item is decisive: a representable Python object does not prove that a topology can be
realized for the selected geometry and device lane.

(python-api-discretization-per-object-meshing-governing-equations)=
## Numerical meaning

Per-object policy changes the local approximation space, geometry resolution, element anisotropy,
and conditioning of every FEM operator. It does not define a new physical energy. Local refinement
must be assessed by an observable and by the realized element-size distribution, not only by the
requested input value.

(python-api-discretization-per-object-meshing-symbols-and-si-units)=
## SI units

| Parameter family | SI unit |
|---|---|
| element sizes, interface/edge/corner extents, transition distances | m |
| boundary-layer total thickness | m |
| layer/iteration/smoothing counts and Gmsh algorithm IDs | 1 |
| growth, stretching, size factors, curvature factors, element ratios | 1 |
| selectors, source paths, topology names, optimizer names | 1 |

Control Room writes the same SI values. A displayed value such as `5e-9` is five nanometres because
the stored value is already in metres.

(python-api-discretization-per-object-meshing-assumptions-and-validity)=
## Inheritance and null semantics

- `None` means inherit or omit; it is not numeric zero.
- `Use object policy` disabled in Control Room sends `config: null`, restoring inheritance.
- empty text in a normal UI field removes that canonical key from the authored JSON.
- `configText` is merged with structured controls; structured controls overwrite their owned keys.
- object policy revision and effective target are separate from the current mesh revision.
- applying a policy invalidates the current mesh; the mesh becomes trustworthy only after a
  successful rebuild and report publication.

## Supported strategies

| `mesh_strategy` | Purpose | Required/derived topology | Current Control Room exposure |
|---|---|---|---|
| `None` / `auto` | inherit or let the planner choose | build-mode dependent | `Inherited` |
| `free_tetrahedral` | general unstructured volume mesh | layered fields are removed | selectable |
| `thin_film_tetrahedral` | thickness-aware tetrahedral film | tetrahedral topology | Python or advanced JSON; not a normal strategy option in the reviewed panel |
| `swept_prism` | exact layered triangular sweep | P1 prisms, fixed layers, pyramid-to-tetra transition | selectable only when all mixed-P1 capabilities pass |
| `swept_hex` | quadrilateral swept hexahedra | hex family and quadrilateral source faces | displayed disabled as unsupported |

### Exact layered-prism canonical tuple

Selecting `Layered prism (exact)` in Control Room writes the following invariant tuple:

| Key | Canonical value |
|---|---|
| `mesh_strategy` | `swept_prism` |
| `topology` | `prismatic` |
| `element_family` | `prism` |
| `order` | `1` |
| `sweep_direction` | `auto` |
| `sweep_face_meshing` | `triangular` |
| `through_thickness_distribution` | `fixed` |
| `through_thickness_element_ratio` | `1` |
| `through_thickness_symmetric` | `false` |
| `transition_policy` | `pyramid_to_tetrahedra` |
| `exact_layer_count` | `true` |

The reviewed UI capability gate accepts exactly one, two, or three through-thickness element layers.
The corresponding number of nodal planes is the layer count plus one. These values describe the
qualified UI scope, not a mathematical limit of prism meshes in general.

(python-api-discretization-per-object-meshing-python-api)=
## Complete `PerObjectMeshRecipe` parameter inventory

### Element size and source

| Python field | Type | Default | SI unit | Meaning / validation | ProblemIR key |
|---|---|---:|---:|---|---|
| `PerObjectMeshRecipe.maximum_element_size` | `float or None` | `None` | m | canonical local upper target | `maximum_element_size`, compatibility `hmax` |
| `PerObjectMeshRecipe.minimum_element_size` | `float or None` | `None` | m | canonical local lower target | `minimum_element_size`, compatibility `hmin` |
| `PerObjectMeshRecipe.hmax` | `float or None` | `None` | m | compatibility spelling used when canonical value is absent | `hmax` and resolved `maximum_element_size` |
| `PerObjectMeshRecipe.hmin` | `float or None` | `None` | m | compatibility spelling used when canonical value is absent | `hmin` and resolved `minimum_element_size` |
| `PerObjectMeshRecipe.order` | `int or None` | `None` | 1 | object finite-element order; prismatic route accepts only 1 | `order` |
| `PerObjectMeshRecipe.source` | `str or None` | `None` | 1 | imported/prebuilt object mesh source | `source` |
| `PerObjectMeshRecipe.calibrate_for` | `str or None` | `None` | 1 | calibration family | `calibrate_for` |
| `PerObjectMeshRecipe.size_preset` | `str or None` | `None` | 1 | named size preset | `size_preset` |

### Gmsh algorithms, sizing, and smoothing

| Python field | Type | Default | Unit | Meaning | ProblemIR key |
|---|---|---:|---:|---|---|
| `PerObjectMeshRecipe.algorithm_2d` | `int or None` | `None` | 1 | Gmsh surface algorithm ID | `algorithm_2d` |
| `PerObjectMeshRecipe.algorithm_3d` | `int or None` | `None` | 1 | Gmsh volume algorithm ID | `algorithm_3d` |
| `PerObjectMeshRecipe.size_factor` | `float or None` | `None` | 1 | multiplier applied to preset-derived sizes | `size_factor` |
| `PerObjectMeshRecipe.size_from_curvature` | `int or None` | `None` | 1 | Gmsh curvature-sizing control; zero disables in the UI defaults | `size_from_curvature` |
| `PerObjectMeshRecipe.curvature_factor` | `float or None` | `None` | 1 | curvature-derived local size factor | `curvature_factor` |
| `PerObjectMeshRecipe.growth_rate` | `float or None` | `None` | 1 | maximum requested local size growth | `growth_rate` |
| `PerObjectMeshRecipe.narrow_regions` | `int or None` | `None` | 1 | Gmsh narrow-region control | `narrow_regions` |
| `PerObjectMeshRecipe.narrow_region_resolution` | `float or None` | `None` | 1 | requested narrow-region resolution | `narrow_region_resolution` |
| `PerObjectMeshRecipe.smoothing_steps` | `int or None` | `None` | 1 | post-generation smoothing passes | `smoothing_steps` |

### Optimization and boundary layers

| Python field | Type | Default | Unit | Meaning | ProblemIR key |
|---|---|---:|---:|---|---|
| `PerObjectMeshRecipe.optimize` | `str or None` | `None` | 1 | optimizer name, for example `Netgen`, `HighOrder`, or `Relocate3D` | `optimize` |
| `PerObjectMeshRecipe.optimize_iters` | `int or None` | `None` | 1 | optimizer iteration count | `optimize_iters` |
| `PerObjectMeshRecipe.boundary_layer_count` | `int or None` | `None` | 1 | number of boundary-layer elements | `boundary_layer_count` |
| `PerObjectMeshRecipe.boundary_layer_thickness` | `float or None` | `None` | m | total physical layer-stack thickness | `boundary_layer_thickness` |
| `PerObjectMeshRecipe.boundary_layer_stretching` | `float or None` | `None` | 1 | consecutive-layer growth ratio | `boundary_layer_stretching` |

Semantic selectors and raw Gmsh tags used by the Control Room boundary-layer editor are stored in
advanced object-policy JSON as `boundary_layer_target_surface_selectors`,
`boundary_layer_target_curve_selectors`, `boundary_layer_target_surface_tags`, and
`boundary_layer_target_curve_tags`. Semantic selectors are preferred because raw tags are not stable
across geometry rebuilds.

### Through-thickness and topology controls

| Python field | Type | Default | Unit | Meaning / validation | ProblemIR key |
|---|---|---:|---:|---|---|
| `PerObjectMeshRecipe.mesh_strategy` | `str or None` | `None` | 1 | one of `auto`, `free_tetrahedral`, `thin_film_tetrahedral`, `swept_prism`, `swept_hex` | `mesh_strategy` |
| `PerObjectMeshRecipe.through_thickness_elements` | `int or None` | `None` | 1 | positive element-layer count | `through_thickness_elements` |
| `PerObjectMeshRecipe.through_thickness_distribution` | `str or None` | `None` | 1 | `fixed`, `linear`, or `exponential` | `through_thickness_distribution` |
| `PerObjectMeshRecipe.through_thickness_element_ratio` | `float or None` | `None` | 1 | layer-size ratio | `through_thickness_element_ratio` |
| `PerObjectMeshRecipe.through_thickness_symmetric` | `bool` | `False` | 1 | symmetric thickness grading request | `through_thickness_symmetric` |
| `PerObjectMeshRecipe.sweep_face_meshing` | `str or None` | `None` | 1 | `triangular` or `quadrilateral` | `sweep_face_meshing` |
| `PerObjectMeshRecipe.topology` | `str or None` | `None` | 1 | `tetrahedral` or `prismatic` | `topology` |
| `PerObjectMeshRecipe.sweep_direction` | `str or None` | `None` | 1 | `auto`, `x`, `y`, or `z` | `sweep_direction` |
| `PerObjectMeshRecipe.element_family` | `str or None` | `None` | 1 | `prism` or `hex` | `element_family` |
| `PerObjectMeshRecipe.transition_policy` | `str or None` | `None` | 1 | `pyramid_to_tetrahedra` or `reject` | `transition_policy` |
| `PerObjectMeshRecipe.exact_layer_count` | `bool or None` | `None` | 1 | exact layer preservation | `exact_layer_count` |

A layered request is valid only when all required layer, distribution, source-face, direction,
family, transition, and exact-count fields are present. Tetrahedral topology contradicts swept
family/direction/transition intent. Prism requires `swept_prism`, order 1, triangular source faces,
and exact layers. Hex requires `swept_hex` and quadrilateral source faces and rejects the
pyramid-to-tetra transition.

### Quality, size fields, and operation sequence

| Python field | Type | Default | Meaning | ProblemIR key |
|---|---|---:|---|---|
| `PerObjectMeshRecipe.compute_quality` | `bool` | `False` | aggregate quality report | `compute_quality` |
| `PerObjectMeshRecipe.per_element_quality` | `bool` | `False` | per-element arrays in addition to aggregates | `per_element_quality` |
| `PerObjectMeshRecipe.size_fields` | `list[dict]` | empty | ordered extra Gmsh size-field descriptions | `size_fields` |
| `PerObjectMeshRecipe.operations` | `list[MeshOperation]` | empty | ordered COMSOL-like meshing sequence | `operations` |

### `MeshOperation`

| Field | Type | Default | Contract |
|---|---|---:|---|
| `MeshOperation.kind` | enum string | required | `free_tetrahedral`, `boundary_layers`, `refine`, `adapt`, `swept`, or `size_field` |
| `MeshOperation.params` | `dict[str, object]` | empty | operation-specific backend parameters preserved in IR |
| `MeshOperation.enabled` | `bool` | `True` | disabled operations remain authored but are not executed |

`adapt` is representable as operation intent. The public documentation does not claim a universal
production solve–estimate–remesh–transfer loop for every Fullmag study.

### Complete stage-first example

```python
# %% Object-specific exact layered mesh inside a graded shared domain
import fullmag as fm

nm = 1.0e-9
study = fm.study("per_object_fem_mesh")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(900 * nm, 450 * nm, 350 * nm))
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(300 * nm, 100 * nm, 4 * nm), name="film"),
    name="film",
)
film.mesh.thin_film(
    minimum_element_size=2 * nm,
    maximum_element_size=4 * nm,
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
study.build_domain_mesh()
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="nonlinear_cg",
    tolT=1.0e-6,
    max_steps=50_000,
)
```

## Control Room object-mesh editor

The selected FEM object opens `Object Mesh Policy`. The panel is divided into authored controls and
read-only realization resources.

### Main groups

| Inspector group | Structured controls |
|---|---|
| `Override` | `Use object policy` |
| `Mesh Size Presets` | calibration, size preset, size factor |
| `Element Size Parameters` | hmax, hmin, growth, curvature, curvature sizing, narrow regions, order, imported source |
| `Thin-Film Sweep Strategy` | strategy, exact layers, source/destination, read-only topology/capability summary |
| `Interface And Transition Refinement` | interface hmax, interface thickness, transition distance, transition growth |
| `Backend Mesh Parameters` | Gmsh algorithms, smoothing, optimizer, quality, boundary layers and targets |
| edge/corner refinement groups | edge/corner size, extent/thickness, transition distance |
| manual box size field | explicit `Box` field bounds and inner/outer target values |
| object-core relaxation | distance-based relaxation from fine surface/edge sizing to coarse core sizing |
| advanced JSON | complete authored object policy JSON |
| report/quality tabs | resolved target, build status, operation status, selectors, topology, histograms and quality |

### UI defaults before inheritance/effective-target merge

| Key | Default |
|---|---:|
| `algorithm_2d` | 6 |
| `algorithm_3d` | 1 |
| `build_requested` | `false` |
| `compute_quality` | `true` |
| `mode` | `inherit` |
| `narrow_regions` | 0 |
| `optimize_iterations` | 1 |
| `per_element_quality` | `true` |
| `size_factor` | 1 |
| `size_from_curvature` | 0 |
| `smoothing_steps` | 1 |
| `through_thickness_symmetric` | `false` |

These are editor defaults used to construct the draft. The resource's authored config, effective
config, and resolved target then overwrite them. The backend build report remains authoritative.

### Transition-distance syntax

The object, edge, and corner transition fields accept either:

- a positive SI distance in metres; or
- the sentinel `airbox_boundary`, requesting a transition that extends to the resolved exterior
  boundary where the backend supports it.

### Capability gates

The UI enables exact layered prism only when all of these capabilities are executable:

- `mesh.topology.mixed_p1`;
- `mesh.swept.prism`;
- `mesh.transition.pyramid_tet`;
- `mesh.exact_layer_count` with `supported_layer_counts=[1,2,3]`.

A missing, unsupported, or invalid-scope capability disables the option and publishes the backend
reason. Swept hex remains disabled independently.

(python-api-discretization-per-object-meshing-problem-ir)=
## ProblemIR and resource lifecycle

The recipe lowers all fields, including explicit `None` values, into the object mesh workflow. The
Control Room resource carries authored `config`, backend `effective_config`, and a revision. Applying
an object policy invalidates current and latest mesh-dependent resources. A build produces a new
mesh asset and report; a failed build must not replace the latest successful asset.

The report records requested and actual topology, algorithm, layer count, selectors, size fields,
operations, fallbacks, quality, region markers, and mesh digest. Consumers must not infer actual
execution from the authored JSON alone.

(python-api-discretization-per-object-meshing-round-trip-and-failure-semantics)=
## Failure semantics

Immediate authoring failures include unsupported strategy/distribution/family values, incomplete
layered recipes, contradictory tetrahedral/swept intent, invalid prism/hex combinations, and invalid
exact-layer types/counts. UI numeric parsing additionally rejects nonfinite, nonpositive, or
noninteger values according to each field.

Build-time failures include selector resolution failure, nonextrudable geometry, incompatible shared
interfaces, marker collisions, inverted/collapsed elements, unsupported element family/order,
invalid periodic pairing, and strict requested/resolved mismatch. A degraded fallback is visible in
`operation_statuses` and `fallbacks_triggered`; it is not silently reported as the requested mode.

(python-api-discretization-per-object-meshing-discrete-realization)=
## Realization boundary

| Lane | Status |
|---|---|
| FEM CPU free tetrahedral | general source-backed path |
| FEM CPU thin-film tetrahedral | geometry/build-mode dependent |
| FEM CPU exact prism mixed topology | bounded certificate-driven path |
| FEM CPU swept hex | represented but not production-enabled by the reviewed UI capability gate |
| FEM GPU | consumes the same mesh asset only where all realized element families/orders/operators are supported |
| FDM CPU/GPU | different model: per-magnet Cartesian grids, not this FEM recipe |

(python-api-discretization-per-object-meshing-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| recipe and topology validation | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe.__post_init__` |
| recipe lowering | `packages/fullmag-py/src/fullmag/model/discretization.py` | `PerObjectMeshRecipe.to_ir` |
| operation schema | `packages/fullmag-py/src/fullmag/model/discretization.py` | `MeshOperation.to_ir` |
| stage-first object mesh facade | `packages/fullmag-py/src/fullmag/world.py` | magnetic object mesh authoring surface |
| target precedence | `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` | `resolve_shared_domain_targets` |
| size fields | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | size-field plan owner |
| swept construction | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | swept generation owner |
| realized operation/fallback report | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_mesh_operation_statuses`, `_build_shared_domain_build_report` |
| UI controls | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx` | `ObjectMeshPolicyPanel` |
| UI canonicalization | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts` | `buildObjectMeshPolicyReplaceRequest` |
| topology capability gate | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts` | `resolveObjectMeshTopologyCapabilities` |

(python-api-discretization-per-object-meshing-validation)=
## Verification

Qualification requires geometry/volume checks, exact region and selector coverage, positive
Jacobians, family-specific quality tails, target-size realization, layer-plane verification,
operation-status inspection, and observable convergence. Exact prism studies additionally require
layer convergence rather than treating one layer as universally sufficient.

(python-api-discretization-per-object-meshing-limitations)=
## Limitations

- object policies do not create independent nonconforming meshes;
- advanced JSON may preserve keys that the active backend does not consume;
- raw Gmsh tags are fragile across geometry rebuilds;
- general multi-object swept and general airbox-plus-swept support are scenario-dependent;
- swept hex is not production-enabled by the reviewed Control Room gate;
- `adapt` is authoring vocabulary, not a universal production adaptive-remeshing claim.

(python-api-discretization-per-object-meshing-scientific-bibliography)=
## Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with
   built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in
   Engineering* **79**, 1309–1331 (2009),
   [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
2. S. C. Brenner and L. R. Scott, *The Mathematical Theory of Finite Element Methods*, 3rd ed.,
   Springer, 2008, [doi:10.1007/978-0-387-75934-0](https://doi.org/10.1007/978-0-387-75934-0).
3. R. Anderson et al., “MFEM: a modular finite element methods library,” *Computers & Mathematics
   with Applications* **81**, 42–74 (2021),
   [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).

(python-api-discretization-per-object-meshing-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Evidence |
|---|---|---|---|
| complete typed field inventory | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class PerObjectMeshRecipe` | source and constructor tests |
| exact prism canonical tuple | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts` | `buildObjectMeshPolicyReplaceRequest` | model and DOM tests |
| capability scope | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts` | `resolveObjectMeshTopologyCapabilities` | capability tests |
| rendered groups and transactions | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx` | `ObjectMeshPolicyPanel` | component tests |
| realized topology and fallback | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_shared_domain_build_report` | meshing fallback/report tests |
