---
title: Mesh Controls
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
reviewed_revision: 043201a94f769307c6b6e0db971da9a8a5eec57c
source_of_truth: MeshSizeControls, SharedMeshAssemblyPolicy, stage-first mesh facades, Control Room object/region/airbox panels, and realized mesh reports
---

(public-docs-python-api-discretization-mesh-controls)=
# Mesh controls: Python, Control Room, and realized FEM mesh

:::{admonition} Three states must never be confused
:class: important

Fullmag distinguishes **authored policy**, **backend-effective policy**, and **realized mesh**.
Applying a policy does not rebuild the mesh. A geometry or policy change makes the current FEM mesh
stale. Only a successful mesh-build command publishes a new mesh asset and realization report.
:::

(python-api-discretization-mesh-controls-problem-statement)=
## Control hierarchy

FEM meshing is controlled at several nested scopes:

| Scope | Python owner | Control Room owner | Numerical role |
|---|---|---|---|
| study default | `FEM(...)` | resolved session/backend policy | default order, hmax, imported mesh, demag linear policy |
| universe/airbox | `study.universe(...)` and `study.universe.mesh(...)` | `Airbox Mesh Parameters` | exterior geometry, air hmin/hmax, growth, grading |
| magnetic object | `object.mesh(...)`, `object.mesh.thin_film(...)`, or `PerObjectMeshRecipe` | `Object Mesh Policy` | object target, topology, layers, local fields, operations |
| authored object region | region mesh policy | `Region Mesh` | regional hmin/hmax, transition distance, order |
| shared assembly | `SharedMeshAssemblyPolicy` and mesh workflow | backend-effective/read-only reports | conformity, interface and airbox assembly |
| realized asset | `study.build_domain_mesh()` result | Mesh Build monitor/report/quality | exact nodes, elements, markers, quality, fallbacks, digest |

A lower scope overrides only the keys it owns. Empty/`None` values inherit; they do not write zero.
The final shared-domain builder must satisfy all active scopes simultaneously.

(python-api-discretization-mesh-controls-governing-equations)=
## Numerical interpretation

A size field defines a requested metric-like target, schematically

```{math}
:label: eq-python-api-mesh-controls-min-field
h_{\mathrm{target}}(\mathbf x)
=\min_{s\in\mathcal S(\mathbf x)}h_s(\mathbf x),
```

followed by growth, conformity, geometry, and mesher constraints. Therefore:

- the smallest overlapping field wins locally;
- requested `hmax` is not a guaranteed measured maximum;
- transition and grading controls can propagate refinement beyond the selected feature;
- a local object or region request can increase the airbox element count through conformity;
- the realized size distribution must be inspected in the build report and quality histogram.

(python-api-discretization-mesh-controls-symbols-and-si-units)=
## Symbols and SI units

| Control | SI unit |
|---|---|
| hmin, hmax, padding, size, center, interface/edge/corner distances | m |
| boundary-layer thickness and region transition distance | m |
| growth, curvature, stretching, size factor, element ratio | 1 |
| element order, layers, algorithms, iterations, smoothing | 1 |
| quality statistics | metric-specific, named by the report |
| $h_{\mathrm{target}}(\mathbf x)$ | resolved local target element size before mesher/conformity constraints | $\mathrm{m}$ |
| $\mathcal S(\mathbf x)$ | active size fields at the spatial point | $1$ |

All Control Room length inputs are canonical SI metres. The interface does not silently convert a
number entered as `5` into five nanometres.

(python-api-discretization-mesh-controls-assumptions-and-validity)=
## Authoring state machine

```text
geometry + authored policies
          |
          v
backend-effective policy  -- capability and inheritance resolution
          |
          v
mesh build command        -- Gmsh generation, extraction, validation
          |
          +--> failure: current/latest successful mesh remains unchanged
          |
          v
realized mesh + report + quality + digest
```

### Object transaction

1. edit structured fields or advanced JSON;
2. `Apply Policy` writes the object policy resource;
3. object, report, quality, scene, current-build, and latest-successful resource views are
   invalidated;
4. the UI reports: `Policy saved. Current solver mesh is stale until a mesh build completes.`;
5. `Build Mesh` executes `mesh.build-selected`;
6. `Apply & Build Mesh` applies a dirty draft first, then executes the same command.

### Airbox transaction

1. edit canonical Airbox geometry or FEM air sizing;
2. `Apply Airbox Policy` writes the universe policy resource;
3. `Build Shared-Domain Mesh` or `Apply & Build Shared-Domain Mesh` executes
   `mesh.build-shared-domain`;
4. FDM exposes only structured-grid universe geometry here; FEM-only air sizing fields are removed
   from an FDM request.

### Region transaction

The FEM `Region Mesh` panel can enable one region policy and edit regional maximum size, minimum
size, transition distance, and element order. FDM region mesh is read-only cell membership because
the structured grid is owned by the execution plan.

## Calibration families

The public calibration vocabulary is:

- `general_physics`;
- `micromagnetics_static`;
- `micromagnetics_relaxation`;
- `micromagnetics_frequency_domain`;
- `magnetostatics_dominated`;
- `imported_surface_cleanup`.

A calibration name selects policy defaults. It is not evidence that the resulting mesh is converged
for a particular observable.

## Size presets

When the corresponding numeric control is absent, the reviewed preset resolver supplies these
fallbacks:

| Preset | Maximum growth | Curvature factor | Narrow-region resolution |
|---|---:|---:|---:|
| `extremely_fine` | 1.2 | 0.20 | 1.00 |
| `extra_fine` | 1.3 | 0.25 | 0.85 |
| `finer` | 1.4 | 0.40 | 0.70 |
| `fine` | 1.5 | 0.50 | 0.60 |
| `normal` | 1.6 | 0.60 | 0.50 |
| `coarse` | 1.8 | 0.80 | 0.30 |
| `coarser` | 2.0 | 1.00 | 0.20 |
| `extra_coarse` | 2.2 | 1.20 | 0.15 |
| `extremely_coarse` | 2.4 | 1.50 | 0.10 |

Explicit numeric values override preset fallbacks. `size_factor` then scales preset-derived targets
where the active mesh workflow applies that factor.

(python-api-discretization-mesh-controls-python-api)=
## `MeshSizeControls`

| Python field | Type | Default | SI unit | Validation / meaning | ProblemIR |
|---|---|---:|---:|---|---|
| `MeshSizeControls.calibrate_for` | `str or None` | `None` | 1 | supported calibration family | size policy `calibrate_for` |
| `MeshSizeControls.size_preset` | `str or None` | `None` | 1 | supported preset name | size policy `size_preset` |
| `MeshSizeControls.maximum_element_size` | `float or None` | `None` | m | positive upper target | size policy `maximum_element_size` |
| `MeshSizeControls.minimum_element_size` | `float or None` | `None` | m | positive lower target | size policy `minimum_element_size` |
| `MeshSizeControls.maximum_element_growth_rate` | `float or None` | `None` | 1 | positive; stage-first public facade accepts the practical range through 2.5 | size policy `maximum_element_growth_rate` |
| `MeshSizeControls.curvature_factor` | `float or None` | `None` | 1 | positive curvature size factor | size policy `curvature_factor` |
| `MeshSizeControls.narrow_region_resolution` | `float or None` | `None` | 1 | positive narrow-feature target | size policy `narrow_region_resolution` |

## `SharedMeshAssemblyPolicy`

| Python field | Default | Validation | Meaning |
|---|---:|---|---|
| `SharedMeshAssemblyPolicy.interface_hmax_factor` | `0.5` | in `(0, 1]` | interface size relative to local object maximum |
| `SharedMeshAssemblyPolicy.enforce_conforming` | `True` | Boolean | require shared vertices/traces through conforming assembly |
| `SharedMeshAssemblyPolicy.airbox_hmax_factor` | `3.0` | positive | airbox size relative to global maximum |

This low-level policy does not replace explicit interface or airbox targets. The resolved target
report records which value actually controlled each partition.

## Stage-first commands

| Python command | Scope | Effect |
|---|---|---|
| `study.engine("fem")` | study | selects FEM semantics; unresolved/FDM UI lanes withhold FEM writes |
| `study.universe(mode=..., size=...)` | universe | authors exterior-domain mode and geometry |
| `study.universe.mesh(...)` | universe | authors airbox hmin/hmax, growth, grading, calibration and preset |
| `object.mesh(...)` | object | authors ordinary object size, order, algorithms, quality and refinements |
| `object.mesh.thin_film(...)` | object | authors thickness layers and tetrahedral/prismatic thin-film topology |
| region mesh policy | region | authors regional size/order/transition override |
| `study.build_domain_mesh()` | shared domain | explicitly requests mesh materialization |
| `study.fem_demag_solver(...)` | algebraic solver | configures Poisson/demag solve; it does not change mesh geometry |

### Complete stage-first example

```python
# %% Global, airbox, object, and exact thin-film mesh controls
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_mesh_controls")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(mode="manual", size=(1.0e-6, 500 * nm, 400 * nm))
study.universe.mesh(
    minimum_element_size=8 * nm,
    maximum_element_size=90 * nm,
    maximum_element_growth_rate=1.3,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(400 * nm, 120 * nm, 4 * nm), name="film"),
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

## Control Room crosswalk

### Airbox Mesh Parameters

| UI label | Canonical JSON key | Meaning |
|---|---|---|
| Maximum element size | `airbox_hmax` | far-field/air upper target |
| Minimum element size | `airbox_hmin` | near/interface lower target |
| Maximum element growth rate | `airbox_growth_rate` | requested grading growth |
| Curvature factor | `curvature_factor` | curved-boundary refinement |
| Resolution of narrow regions | `narrow_region_resolution` | small-gap/thin-feature resolution |
| Element grading | `airbox_grading` | `auto`, `geometric`, or `linear` |
| Domain mode | `mode` | inherited, `auto`, or `manual` |
| Padding X/Y/Z | `padding` | exterior clearance vector in metres |
| Size X/Y/Z | `size` | explicit exterior size vector in metres |
| Center X/Y/Z | `center` | explicit exterior centre in metres |

The panel shows backend-effective values separately. Unknown effective keys are counted rather than
silently presented as structured fields.

### Object Mesh Policy

| UI family | Canonical keys |
|---|---|
| presets | `calibrate_for`, `size_preset`, `size_factor` |
| element size | `maximum_element_size`, `minimum_element_size`, `maximum_element_growth_rate`, `curvature_factor`, `size_from_curvature`, `narrow_regions`, `narrow_region_resolution`, `order`, `source` |
| topology/layers | `mesh_strategy`, `topology`, `element_family`, `through_thickness_*`, `sweep_*`, `transition_policy`, `exact_layer_count` |
| interface | `interface_hmax`, `interface_thickness`, `transition_distance`, `transition_growth` |
| edge | `edge_maximum_element_size`, `edge_thickness`, `edge_transition_distance` |
| corner | `corner_maximum_element_size`, `corner_extent`, `corner_transition_distance` |
| backend | `algorithm_2d`, `algorithm_3d`, `smoothing_steps`, `optimize`, `optimize_iterations` |
| quality | `compute_quality`, `per_element_quality` |
| boundary layer | count, thickness, stretching, semantic selectors or raw entity tags |
| advanced | complete object policy JSON |

Transition distance accepts a positive SI length or the sentinel `airbox_boundary` in the object,
edge, and corner structured editors.

### Region Mesh

| UI label | Meaning |
|---|---|
| Enable mesh policy | activate/deactivate the regional override |
| Max element size | regional upper target in metres |
| Min element size | regional lower target in metres |
| Transition distance | distance over which the region target blends to its parent policy |
| Order | regional finite-element order where supported |

Region quality distributions are read from the realized region membership and quality resources,
not synthesized from the authored policy.

## Explicit size fields

### Manual Box field

The object inspector can author one explicit box size field with:

- x/y/z minimum and maximum bounds in metres;
- `VIn`, the target inside the box;
- `VOut`, the target outside the box;
- a source marker distinguishing the structured object-policy editor from unmarked advanced JSON.

### Object-core relaxation field

`ObjectCoreRelaxation` can grade from fine surface/edge targets toward a coarser object core. The UI
exposes geometry name, core maximum size, surface and edge distances, surface and edge maximum
sizes, and sampling controls. The field is valid only when its geometry/selector resolution is
published in the realization report.

## Ordered mesh operations

| Operation | Intended effect | Qualification boundary |
|---|---|---|
| `free_tetrahedral` | unstructured volume fill | general FEM path |
| `boundary_layers` | layered elements on selected surfaces/curves | selector/topology dependent |
| `refine` | uniform h-refinement pass | operation status must confirm execution |
| `adapt` | adaptive refinement intent | no universal production solve–estimate–remesh loop is claimed |
| `swept` | structured extrusion | geometry and capability dependent |
| `size_field` | inject an additional size field | field kind and selectors must resolve |

The operation schema is representable, but the current public build boundary rejects every authored
operation with `mesh operation executor unavailable` before mesh generation, including entries with
`enabled=False`. Therefore no operation is currently classified as applied, ignored, skipped,
degraded, or failed in a build report. The table above describes intended families, not executable
public capability.

(python-api-discretization-mesh-controls-problem-ir)=
## ProblemIR and provenance

A reproducible mesh record contains:

- study, universe, object, and region authored policies with revisions;
- backend-effective values and inheritance source;
- geometry and material digests;
- requested and actual algorithms, topology, order, layers, and transitions;
- ordered size fields and operations with realization status;
- selector-to-native-tag resolution;
- build mode, fallback list, degradation flag, and exact failure reason;
- nodes/elements/facets by family, order, region, and boundary role;
- bounds, volumes, surfaces, connected components, and periodic pairs;
- Jacobian, SICN, gamma/radius, volume, edge-size, and histogram statistics;
- Gmsh/native versions, deterministic inputs, mesh/submesh digests;
- current versus latest-successful mesh identity.

(python-api-discretization-mesh-controls-round-trip-and-failure-semantics)=
## Validation and failure semantics

Structured Python/UI controls reject invalid numeric values, unsupported vocabulary, inconsistent
hmin/hmax, invalid layer tuples, and unresolved FEM/FDM lane selection before build. The mesh build
then rejects or explicitly degrades:

- nonconformal or failed CAD assembly;
- empty magnetic or air partitions;
- inverted, collapsed, orphan, duplicate, or nonmanifold entities;
- missing material/boundary attributes;
- invalid periodic pairing;
- unresolved semantic selectors;
- unsupported family/order/device combinations;
- requested-versus-realized topology mismatch in strict mode.

A failed build must not overwrite the latest successful mesh. A green policy request without a green
mesh build is not a usable solver discretization.

### Round-trip contract

The exported Python preserves **requested intent**. ProblemIR and the build report preserve
**resolved execution** separately. Invalid values produce explicit **validation errors**, while
**unsupported combinations** are rejected before meshing rather than silently degraded.

(python-api-discretization-mesh-controls-discrete-realization)=
## Discrete realization

FEM mesh generation is normally host/Gmsh work. CPU and GPU solvers must consume the same
content-addressed extracted asset when parity is claimed. FDM uses a different structured-grid
contract and exposes object/region mesh membership read-only in the Control Room.

(python-api-discretization-mesh-controls-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| reusable size policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class MeshSizeControls` |
| shared assembly policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class SharedMeshAssemblyPolicy` |
| public normalization and validation | `packages/fullmag-py/src/fullmag/world.py` | `_normalize_mesh_calibration`, `_normalize_mesh_preset`, `_validate_mesh_control_values` |
| resolved preset values and quality schemas | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `resolve_user_mesh_size_controls`, `MeshQualityReport`, `MeshStatisticsReport` |
| size-field composition | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | size-field plan owner |
| target precedence | `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` | `resolve_shared_domain_targets` |
| operation/fallback reporting | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_mesh_operation_statuses`, `_build_shared_domain_build_report` |
| object UI transaction | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx` | `ObjectMeshPolicyPanel` |
| object request | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts` | `buildObjectMeshPolicyReplaceRequest` |
| airbox UI transaction | `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx` | `AirboxMeshParametersPanel` |
| airbox request | `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts` | `buildAirboxMeshPolicyReplaceRequest` |
| region UI | `apps/control-room/src/modules/inspector/panels/region/ObjectRegionMeshPanel.tsx` | `ObjectRegionMeshPanel` |

(python-api-discretization-mesh-controls-validation)=
## Scientific mesh-convergence workflow

1. choose a target observable and physical parameter range;
2. make temporal, equilibrium, algebraic, and airbox errors smaller than the expected spatial
   change;
3. retain the exact authored/effective policy and realized mesh for at least three controlled
   levels where possible;
4. compare geometry volume and marker topology independently of field error;
5. compare fields on a common space and modes by complex overlap;
6. refine thickness layers, geometry order, airbox extent, and h/p independently;
7. inspect worst elements and lower quality percentiles, not only averages;
8. verify CPU/GPU on the identical mesh digest;
9. archive every build report and acceptance decision.

(python-api-discretization-mesh-controls-limitations)=
## Limitations

- presets are convenience policies, not accuracy grades;
- advanced JSON can contain keys not consumed by the active backend;
- raw Gmsh tags are not stable geometry identifiers;
- region/object requests may be altered by conformity and shared-domain constraints;
- exact prism, boundary-layer, swept, and adaptive operations have bounded support scopes;
- this contract does not claim universal automatic adaptive remeshing.

(python-api-discretization-mesh-controls-scientific-bibliography)=
## Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with
   built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in
   Engineering* **79**, 1309–1331 (2009),
   [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
2. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*, SIAM Classics, 2002,
   [doi:10.1137/1.9780898719208](https://doi.org/10.1137/1.9780898719208).
3. R. Anderson et al., “MFEM: a modular finite element methods library,” *Computers & Mathematics
   with Applications* **81**, 42–74 (2021),
   [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).

(python-api-discretization-mesh-controls-source-code-index)=
### Exhaustive public-API and Python-to-ProblemIR mapping

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| MeshSizeControls.calibrate_for | str | None | None | $1$ | Supported calibration vocabulary at the stage-first boundary. | Physics/workflow calibration family. | FEM/Gmsh policy | mesh_size_controls.calibrate_for |
| MeshSizeControls.size_preset | str | None | None | $1$ | Supported preset vocabulary at the stage-first boundary. | Named size-policy preset. | FEM/Gmsh policy | mesh_size_controls.size_preset |
| MeshSizeControls.maximum_element_size | float | None | None | $\mathrm{m}$ | Finite and positive when authored. | Requested upper element-size target. | FEM | mesh_size_controls.maximum_element_size |
| MeshSizeControls.minimum_element_size | float | None | None | $\mathrm{m}$ | Finite and positive and no larger than effective maximum when authored. | Requested lower element-size target. | FEM | mesh_size_controls.minimum_element_size |
| MeshSizeControls.maximum_element_growth_rate | float | None | None | $1$ | Finite and positive; stage-first public authoring limits the practical range through 2.5. | Requested maximum growth between refinement regions. | FEM/Gmsh | mesh_size_controls.maximum_element_growth_rate |
| MeshSizeControls.curvature_factor | float | None | None | $1$ | Finite and positive when authored. | Curvature-derived sizing factor. | FEM/Gmsh | mesh_size_controls.curvature_factor |
| MeshSizeControls.narrow_region_resolution | float | None | None | $1$ | Finite and positive when authored. | Resolution target for narrow regions. | FEM/Gmsh | mesh_size_controls.narrow_region_resolution |
| SharedMeshAssemblyPolicy.interface_hmax_factor | float | 0.5 | $1$ | Strictly greater than zero and no greater than one. | Interface size relative to the local object maximum. | FEM shared-domain assembly | shared_mesh_assembly_policy.interface_hmax_factor |
| SharedMeshAssemblyPolicy.enforce_conforming | bool | True | $1$ | Boolean. | Require a conforming shared-domain mesh. | FEM shared-domain assembly | shared_mesh_assembly_policy.enforce_conforming |
| SharedMeshAssemblyPolicy.airbox_hmax_factor | float | 3.0 | $1$ | Finite and positive. | Airbox target relative to the global maximum element size. | FEM shared-domain assembly | shared_mesh_assembly_policy.airbox_hmax_factor |

## Source-code index

| Claim | Lane | Path | Stable symbol | Evidence | Evidence status | Immutable revision |
|---|---|---|---|---|---|---|
| size-control fields | FEM CPU/GPU authoring | `packages/fullmag-py/src/fullmag/model/discretization.py` | `MeshSizeControls.to_ir` | source/round-trip tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/043201a94f769307c6b6e0db971da9a8a5eec57c/packages/fullmag-py/src/fullmag/model/discretization.py) |
| UI object lifecycle | Control Room, FEM | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx` | `applyPolicy`, `buildMesh` | component tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/043201a94f769307c6b6e0db971da9a8a5eec57c/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx) |
| UI airbox lifecycle | Control Room, FEM | `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx` | `submitAirboxPolicyDraft`, `build` | panel/model tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/043201a94f769307c6b6e0db971da9a8a5eec57c/apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx) |
| UI region controls | Control Room, FEM | `apps/control-room/src/modules/inspector/panels/region/ObjectRegionMeshPanel.tsx` | `ObjectRegionMeshPanel` | component tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/043201a94f769307c6b6e0db971da9a8a5eec57c/apps/control-room/src/modules/inspector/panels/region/ObjectRegionMeshPanel.tsx) |
| final provenance | FEM CPU/GPU shared mesh | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_shared_domain_build_report` | fallback/report tests | source-backed | [reviewed source](https://github.com/MateuszZelent/fullmag/blob/043201a94f769307c6b6e0db971da9a8a5eec57c/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py) |
