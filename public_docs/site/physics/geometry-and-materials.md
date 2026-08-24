---
title: Geometry, regions, materials and meshes
status: partial
doc_kind: overview
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0100-mesh-and-region-discretization.md
---

(public-docs-physics-geometry-and-materials)=
# Geometry, regions, materials and meshes

(geometry-materials-problem-statement)=
<!-- (problem-statement)= -->
## Problem statement

Geometry and material semantics are physics inputs, not renderer data. Authored objects, region
identity, material ownership, and boundary selections must survive lowering into either an FDM grid
or an FEM mesh without becoming backend-specific public meanings.

This is a non-terminal physics overview, not the exhaustive API reference for every geometry,
region, material field, or mesher option. Terminal constructor contracts live under
{doc}`../python-api/geometry/index`, {doc}`../python-api/materials/index`, and
{doc}`../python-api/meshing/index`. The table below is exhaustive for the physical-authoring
parameters exercised by this worked example and deliberately does not redefine those larger APIs.

(geometry-materials-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations

Meshing introduces no new micromagnetic interaction. It realizes a physical domain $\Omega$ and
magnetic subdomains $\Omega_i$ whose disjoint interiors form the authored magnetic support:

```{math}
:label: eq-geometry-region-partition
\Omega_m=\bigcup_{i=1}^{N_r}\Omega_i,
\qquad
\operatorname{int}(\Omega_i)\cap\operatorname{int}(\Omega_j)=\varnothing
\quad(i\ne j).
```

A discretization must preserve region membership, material assignment, and boundary identity. The
equation is a post-resolution partition contract, not permission for unresolved overlapping
authoring objects.

(geometry-materials-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\Omega_m$ | resolved magnetic domain | $\mathrm{m^3}$ |
| $\Omega_i$ | resolved magnetic region $i$ | $\mathrm{m^3}$ |
| $N_r$ | number of resolved magnetic regions | $1$ |
| $\mathbf x_k$ | coordinate of node or cell location $k$ | $\mathrm{m}$ |
| $m_e$ | canonical region marker of element or cell $e$ | $1$ |

(geometry-materials-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity

- Geometry coordinates are SI metres after import normalization.
- Object and region identities are explicit; physics is not inferred from display names or types.
- FDM cells/masks and FEM elements/markers are different realizations of the same authored intent.
- External FEM meshes require unambiguous units and semantic mappings; unsupported topology fails
  closed.

(geometry-materials-python-api)=
<!-- (python-api)= -->
## Python API

```python
# %% Geometry, material, and mesh intent
import fullmag as fm

nm = 1.0e-9
study = fm.study("geometry-material-foundation")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=20 * nm)
study.universe(mode="auto", padding=(100 * nm, 100 * nm, 100 * nm))
study.universe.mesh(maximum_element_size=40 * nm)
film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
film.mesh.thin_film(
    minimum_element_size=3 * nm,
    maximum_element_size=3 * nm,
    layers=1,
    topology="prismatic",
)
study.exchange()
study.stages.add_relax(stage_id="relax", dt=1.0e-15, max_steps=10, tolT=1.0e-6)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `study.objects.mesh.defaults(maximum_element_size=...)` | `float \| str \| None` | `None` | $\mathrm m$ | positive finite resolved size; cannot be mixed with FDM `cell_size` | default magnetic-object FEM size | FEM authoring; planner/generator checks realization | `problem_meta.runtime_metadata.mesh_workflow.default_mesh.maximum_element_size` |
| `study.universe(mode=...)` | `"auto" \| "manual" \| None` | `"auto"` | $1$ | manual mode requires explicit positive `size` | domain extent policy | FDM/FEM authoring; realization is lane-dependent | `problem_meta.runtime_metadata.study_universe.mode` |
| `study.universe(padding=...)` | `Sequence[float] \| None` | `(0, 0, 0)` | $\mathrm m$ | three finite non-negative components | padding around auto-resolved object bounds | FDM/FEM domain realization | `problem_meta.runtime_metadata.study_universe.padding` |
| `study.universe.mesh(maximum_element_size=...)` | `float \| None` | `None` | $\mathrm m$ | positive finite; mutually exclusive with universe `cell_size` | FEM airbox/domain target size | FEM authoring; generator checks topology and grading | `problem_meta.runtime_metadata.study_universe.airbox_hmax` |
| `fm.Box(x, y, z)` | three `float` values | required | $\mathrm m$ | positive finite extents | axis-aligned physical box size | FDM/FEM geometry authoring | `geometry.entries[].size` |
| `study.geometry(shape=...)` | geometry object | required | $1$ | supported geometry with unique lowered identity | magnetic object's physical shape | FDM/FEM subject to geometry realization | `geometry.entries[]` and `magnets[].region` |
| `study.geometry(name=...)` | `str` | `"body"` | $1$ | non-empty and unique in the study | user-facing magnetic object name | all authoring lanes | `magnets[].name` and `regions[].name` |
| `film.Ms` | `float` | required | $\mathrm{A\,m^{-1}}$ | positive finite | saturation magnetization | FDM/FEM CPU/GPU subject to planner capability | `materials[].saturation_magnetisation` |
| `film.Aex` | `float` | required | $\mathrm{J\,m^{-1}}$ | positive finite | exchange stiffness | FDM/FEM CPU/GPU subject to planner capability | `materials[].exchange_stiffness` |
| `film.alpha` | `float` | required | $1$ | finite and non-negative | Gilbert damping | FDM/FEM CPU/GPU subject to planner capability | `materials[].damping` |
| `film.m` | magnetization initializer | required | $1$ | valid initializer with finite vector data | initial reduced magnetization | FDM/FEM CPU/GPU subject to initializer support | `magnets[].initial_magnetization` |
| `film.mesh.thin_film(minimum_element_size=...)` | `float \| None` | `None` | $\mathrm m$ | positive and no greater than maximum size | minimum object mesh size | FEM authoring; generator checks realization | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].minimum_element_size` |
| `film.mesh.thin_film(maximum_element_size=...)` | `float \| str \| None` | inherited/`None` | $\mathrm m$ | positive finite resolved size | maximum object mesh size | FEM authoring; generator checks realization | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].maximum_element_size` |
| `film.mesh.thin_film(layers=...)` | `int` | `1` | $1$ | integer at least one | through-thickness element count | FEM thin-film generators | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].through_thickness_elements` |
| `film.mesh.thin_film(topology=...)` | `"tetrahedral" \| "prismatic" \| None` | `None` | $1$ | supported topology; prismatic mode requires compatible order/transition | requested element topology | FEM; planner/generator rejects unsupported combinations | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].topology` |

(geometry-materials-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR

Authored geometry, materials, regions, object-region assignments, and discretization hints remain
separate from derived `geometry_assets`. FDM materialization records a structured-grid asset; FEM
materialization records a validated typed `fem_domain_mesh_asset`. Requested mesh intent stays in
mesh workflow metadata while resolved mesh identity and build provenance remain derived evidence.

(geometry-materials-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent preserves immutable object identity, names, transforms, region/material ownership,
and mesh policies. Resolved execution records grid/mesh identity, markers, builder, backend, device,
precision, and certificates. Validation errors reject invalid geometry, ambiguous maps, stale
artifacts, and unsupported topology; unsupported combinations never silently change solver family
or infer physics from presentation metadata.

(geometry-materials-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization

| Solver | Device | Status | Qualification boundary |
|---|---|---|---|
| FDM | CPU | reference | structured cells, masks, and grid certificate |
| FDM | GPU | implemented | same grid contract; CUDA availability and parity remain explicit |
| FEM | CPU | implemented | typed linear mesh, markers, shared domains, persistence/import paths |
| FEM | GPU | implemented | same typed mesh contract; runtime/device qualification remains separate |

(geometry-materials-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping

`MagnetHandle` and `Material` own the worked material/initializer semantics. `StudyUniverseHandle`,
`StudyObjectsMeshDefaultsHandle`, and `GeometryMeshHandle` own the domain/default/object mesh
authoring shown above. `build_geometry_assets_for_request` materializes canonical assets, and
`MeshData` owns typed FEM topology and validation.

(geometry-materials-validation)=
<!-- (validation)= -->
## Validation

Validate geometry/region round-trip, material ownership, marker preservation, grid/mesh
fingerprints, stale/corrupt artifact rejection, coordinate-unit normalization, conformity, and
CPU/GPU consumption of the same resolved identity.

(geometry-materials-limitations)=
<!-- (limitations)= -->
## Limitations

Not every boolean operation, adaptive refinement policy, periodic combination, higher-order FEM
element, or mixed topology is qualified. The Python authoring surface may represent a request that
the planner or current mesh generator rejects; those boundaries must remain explicit.

(geometry-materials-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography

1. C. Geuzaine and J.-F. Remacle, "Gmsh: a three-dimensional finite element mesh generator with
   built-in pre- and post-processing facilities," *International Journal for Numerical Methods in
   Engineering* **79**, 1309–1331 (2009). [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(geometry-materials-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Material semantics | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | SI validation and lowering | Python API tests |
| Magnetic object facade | `packages/fullmag-py/src/fullmag/world.py` | `class MagnetHandle` | object identity, material aliases, initializer, and regions | Python API tests |
| Universe/domain authoring | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` | domain extent and airbox mesh intent | universe/round-trip tests |
| Study mesh defaults | `packages/fullmag-py/src/fullmag/world.py` | `class StudyObjectsMeshDefaultsHandle` | shared object mesh defaults | meshing/round-trip tests |
| Box primitive | `packages/fullmag-py/src/fullmag/model/geometry.py` | `class Box` | validates and lowers axis-aligned extents | geometry tests |
| Uniform initializer | `packages/fullmag-py/src/fullmag/init/magnetization.py` | `class UniformMagnetization` | validates and lowers reduced initial magnetization | initializer tests |
| Object mesh authoring | `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | per-object mesh intent | meshing/round-trip tests |
| Mesh persistence facade | `packages/fullmag-py/src/fullmag/world.py` | `class StudyMeshHandle` | save/load/import/export workflow | persistence tests |
| Asset materialization | `packages/fullmag-py/src/fullmag/model/problem.py` | `build_geometry_assets_for_request` | canonical FDM/FEM asset lowering | ProblemIR materialization tests |
| Typed FEM topology | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `class MeshData` | topology, markers, fingerprints, and strict validation | meshing/persistence tests |
