# Mesh and region discretization

- Status: implemented for FEM linear-mesh persistence, COMSOL MPHTXT v4, and Gmsh 4.1 interchange
- Owners: Fullmag core
- Last updated: 2026-07-30
- Related specs: `docs/specs/mesh-roundtrip-semantics-v1.md`, `docs/specs/geometry-policy-v0.md`, `docs/specs/material-assignment-and-spatial-fields-v0.md`

(problem-statement)=
## 1. Problem statement

Geometry, regions, material ownership, and boundary selections must survive
numerical realization without becoming backend-specific public semantics. FEM
mesh generation can dominate startup time, so Fullmag supports a lossless native
mesh artifact for repeated execution, COMSOL-native text (`.mphtxt`) exchange,
and a separate Gmsh 4.1 interchange path for other mesh tools. Gmsh `.msh` is
not described as a directly supported COMSOL import format.

The persisted solver mesh remains a derived artifact. It does not replace the
authored universe, geometry, object-region, or mesh-size configuration.

(governing-equations)=
## 2. Governing equations

Mesh persistence introduces no new micromagnetic equation. It preserves the
discrete domain on which the documented exchange, demagnetization, anisotropy,
Zeeman, torque, relaxation, dynamics, and frequency-domain weak forms operate.
Loading is legal only when the current mesh-producing authoring document has
the same canonical fingerprint as the saved artifact.

(symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{x}_i$ | Coordinate of mesh node i | $\mathrm{m}$ |
| $m_e$ | Canonical Fullmag volume marker of element $e$ | $1$ |
| $b_f$ | Canonical Fullmag boundary marker of facet $f$ | $1$ |
| $g_e$ | Immutable Fullmag global ordinal of element $e$ inside one native mesh identity | $1$ |
| $g_f$ | Immutable Fullmag global ordinal of facet $f$ inside one native mesh identity | $1$ |
| $H_A$ | Mesh authoring fingerprint | $1$ |
| $H_T$ | Mesh topology fingerprint | $1$ |
| $\epsilon_{V,P}$ | Relative volume error recorded by the Python mixed-mesh certificate producer | $1$ |
| $\epsilon_{V,R}$ | Relative volume error independently recomputed by the Rust validator | $1$ |
| $\tau_V$ | Physical relative-volume acceptance limit for mixed-mesh certificates | $1$ |

(assumptions-and-validity)=
## 4. Assumptions and validity

- Coordinates in native artifacts are always metres.
- The first interchange version supports linear `tet4`, `prism6`, `pyramid5`,
  `hex8`, `tri3`, and `quad4` cells/facets.
- Gmsh or COMSOL may renumber nodes, elements, Physical Groups, or geometric
  entities. External
  import therefore creates a new topology identity.
- An `.msh` or `.mphtxt` file is not a lossless Fullmag cache. Fullmag-only ordinals, mesh
  parts, periodic descriptors, and semantic maps are recorded in the adjacent
  `.fullmag.json` sidecar and are revalidated on import.
- Higher-order external elements and ambiguous or incomplete Physical Groups
  fail closed.

(python-api)=
## 5. Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `study.mesh.save.path` | `str \| Path` | required | $1$ | Must end in .fullmag-mesh and resolve to a strictly valid shared-domain FEM mesh. | Native artifact destination. | FEM CPU/GPU | `geometry_assets.fem_domain_mesh_asset` |
| `study.mesh.load.path` | `str \| Path` | required | $1$ | Schema, digests, authoring fingerprint, topology fingerprint, markers, and certificates must validate. | Native artifact source. | FEM CPU/GPU | `geometry_assets.fem_domain_mesh_asset` |
| `study.mesh.save_or_load.path` | `str \| Path` | required | $1$ | Corrupt and unsupported artifacts fail closed; only missing or authoring-stale artifacts rebuild. | Reusable native artifact path. | FEM CPU/GPU | `geometry_assets.fem_domain_mesh_asset` |
| `study.mesh.export.path` | `str \| Path` | required | $1$ | Must end in .mphtxt for COMSOL or .msh for Gmsh; every marker must have a semantic name. | Interchange destination. | FEM CPU/GPU | `not stored; external artifact` |
| `study.mesh.export.format` | `str` | auto | $1$ | auto, comsol, or gmsh; auto resolves from suffix. | Interchange format selector. | FEM CPU/GPU | `not stored; external artifact` |
| `study.mesh.import_.path` | `str \| Path` | required | $1$ | Must be a supported COMSOL .mphtxt v4 or Gmsh .msh file. | External mesh source. | FEM CPU/GPU | `geometry_assets.fem_domain_mesh_asset` |
| `study.mesh.import_.region_map` | `Mapping[str, int] \| None` | None | $1$ | Required when a matching sidecar or unambiguous Physical Volume names are absent. | External volume name to canonical marker mapping. | FEM CPU/GPU | `geometry_assets.fem_domain_mesh_asset.region_markers` |
| `study.mesh.import_.boundary_map` | `Mapping[str, int] \| None` | None | $1$ | Required for boundary selections not recoverable from sidecar or Physical Surface names. | External surface name to canonical marker mapping. | FEM CPU/GPU | `geometry_assets.fem_domain_mesh_asset.mesh.boundary_markers` |
| `study.mesh.import_.region_entity_map` | `Mapping[int, int] \| None` | None | $1$ | COMSOL only; required without a matching sidecar. | COMSOL domain entity to canonical Fullmag volume marker. | FEM CPU/GPU | `geometry_assets.fem_domain_mesh_asset.element_markers` |
| `study.mesh.import_.boundary_entity_map` | `Mapping[int, int] \| None` | None | $1$ | COMSOL only; required without a matching sidecar. | COMSOL boundary entity to canonical Fullmag boundary marker. | FEM CPU/GPU | `geometry_assets.fem_domain_mesh_asset.mesh.boundary_markers` |
| `study.mesh.import_.coordinate_unit` | `str \| None` | None | $1$ | m, mm, um, or nm; required when no valid sidecar supplies the unit. | Unit of imported node coordinates. | FEM CPU/GPU | `normalized to geometry_assets.fem_domain_mesh_asset.mesh.nodes in metres` |

```python
# %%
import fullmag as fm

study = fm.study("cached_relaxation")
study.engine("fem")
study.universe(mode="auto", padding=(100e-9, 100e-9, 100e-9))
study.universe.mesh(maximum_element_size=100e-9)

film = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="film_geom"),
    name="film",
)
film.mesh(maximum_element_size=3e-9)

# %%
# First run builds and saves. Matching later runs load without Gmsh.
mesh_result = study.mesh.save_or_load("film.fullmag-mesh")

# %%
# COMSOL-native interchange is explicit and separate from native reuse.
study.mesh.export("film.mphtxt")

# Gmsh remains available for general mesh-tool interchange.
study.mesh.export("film.msh", format="gmsh")
```

(problem-ir)=
## 6. ProblemIR

No second mesh representation is introduced. A generated, native-loaded, or
externally imported mesh converges to the existing
`geometry_assets.fem_domain_mesh_asset` contract:

```json
{
  "mesh_source": "film.fullmag-mesh",
  "mesh": {
    "mesh_name": "study_domain",
    "nodes": [],
    "cells": {
      "types": [],
      "offsets": [],
      "nodes": [],
      "global_ordinals": [],
      "mesh_parts": []
    },
    "element_markers": [],
    "facets": {
      "types": [],
      "roles": [],
      "offsets": [],
      "nodes": [],
      "global_ordinals": []
    },
    "boundary_markers": []
  },
  "region_markers": [],
  "object_region_markers": [],
  "build_report": null
}
```

The abbreviated empty arrays above show field placement, not an executable
mesh. Runtime materialization supplies the validated arrays. Requested mesh
intent stays in `runtime_metadata.mesh_workflow`; resolved mesh provenance is
recorded separately under `runtime_metadata.mesh_persistence`.

(round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

`H_A` and `H_T` answer different questions. `H_A` changes when geometry,
imported source content, universe, FEM hints, object regions, size fields,
periodicity, or topology-producing mesher options change. Materials, initial
magnetization, solver tolerances, outputs, and visualization are excluded.
`H_T` changes when canonical coordinates, typed connectivity, markers, roles,
ordinals, mesh parts, or periodic pairs change.

`load()` rejects an $H_A$ mismatch and reports the differing normalized paths.
`save_or_load()` rebuilds only for absence or an $H_A$ mismatch. Digest failure,
schema incompatibility, invalid topology, stale certificates, and ambiguous
external groups never trigger a silent overwrite.

Requested intent remains in the authored mesh configuration, while resolved execution
remains planner-owned. Validation errors reject malformed artifacts,
and unsupported combinations fail explicitly without CPU/GPU or FDM/FEM
fallback.

(discrete-realization)=
## 8. Discrete realization

### 8.1 FDM CPU and GPU

FDM continues to use its resolved Cartesian grid certificate. The FEM mesh API
is not applicable and does not alter FDM CPU or GPU execution.

### 8.2 FEM CPU and GPU

The same typed `MeshIR` is consumed by FEM CPU and GPU realizations. Persistence
does not change operators, precision, signs, units, or memory residency. Rust
planner/runtime validation remains authoritative after Python container
validation.

| Solver | Device | Status | Qualification |
|---|---|---|---|
| FDM | CPU | not applicable | Uses the separate FDM grid certificate |
| FDM | GPU | not applicable | Uses the separate FDM grid certificate |
| FEM | CPU | implemented | Native reuse, COMSOL MPHTXT v4, and Gmsh interchange feed the existing validated `MeshIR` path |
| FEM | GPU | implemented | Same mesh contract; runtime/device qualification remains owned by each GPU workflow |

(implementation-mapping)=
## 9. Implementation mapping

- `StudyMeshHandle` owns the public study facade.
- `save_mesh_artifact()` and `load_mesh_artifact()` own the native container.
- `export_comsol_mesh()` and `import_comsol_mesh()` own COMSOL MPHTXT v4 interchange.
- `export_gmsh_mesh()` and `import_gmsh_mesh()` own general Gmsh interchange.
- `MeshData` remains the only Python typed-topology owner.
- `build_geometry_assets_for_request()` inlines persisted topology into the
  existing `FemDomainMeshAssetIR` route.

(validation)=
## 10. Validation

Tests prove native round-trip, digest rejection, authoring mismatch reporting,
quality-report preservation, no-builder reuse, ProblemIR materialization,
COMSOL and Gmsh export/import, explicit external-entity mapping, sidecar unit
enforcement, and Fullmag air marker zero round-trip. Final FEM execution evidence uses the repository container-backed
`just` verification route.

For an accepted mixed prism/pyramid/tetrahedron certificate, Python records a
relative volume error $\epsilon_{V,P}$ and Rust independently recomputes
$\epsilon_{V,R}$. NumPy/LAPACK determinant evaluation and reduction order are
not bitwise identical to Rust scalar determinant arithmetic and sequential
summation. The cross-language evidence comparison is therefore

```{math}
:label: mixed-mesh-volume-evidence-comparison

\left|\epsilon_{V,P}-\epsilon_{V,R}\right|
\leq
\max\!\left(
10^{-12}\max\!\left(\left|\epsilon_{V,P}\right|,
                     \left|\epsilon_{V,R}\right|\right),
4\times10^{-12}
\right).
```

This comparison tolerance is not the physical mesh-acceptance tolerance. Both
implementations still require the relative volume error itself to remain below
$\tau_{V}=10^{-8}$, and dimensional volumes, authored bounds, topology,
markers, conformity, and quality evidence retain their existing stricter
checks. The comparison applies identically before FEM CPU and FEM GPU planning;
FDM CPU and FDM GPU use the separate structured-grid certificate.

(limitations)=
## 11. Limitations

- Proprietary COMSOL mesh-operation history is not preserved.
- COMSOL import supports Mesh serialization version 4. In COMSOL 6.4, export a
  returned mesh with `fileversion=v44`; v64 Mesh serialization is rejected.
- Complete COMSOL exports may include `vtx` and `edg` blocks. The importer
  validates and consumes those blocks, then intentionally omits them from
  `MeshData`, whose canonical solver topology begins at boundary facets and
  volume cells. A provenance-pinned fixture created by COMSOL qualifies this
  complete-file ingress.
- When a COMSOL round-trip invalidates or omits the Fullmag sidecar, the caller
  must provide both semantic name maps and external geometric-entity maps.
- Higher-order curved elements are rejected.
- An external mesh without names requires explicit maps; Fullmag does not guess
  geometric equivalence.
- Partial stale-mesh reuse remains the separate frozen-magnetic-submesh
  workflow.

(scientific-bibliography)=
## 12. Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh
  generator with built-in pre- and post-processing facilities,” *International
  Journal for Numerical Methods in Engineering* 79(11), 2009,
  <https://doi.org/10.1002/nme.2579>.
- Gmsh 4.1 file-format reference, <https://gmsh.info/doc/texinfo/gmsh.html#MSH-file-format>.
- COMSOL Multiphysics Programming Reference Manual, “Mesh” native text
  serialization and mesh element type documentation.

(source-code-index)=
## 13. Source-code index

| Claim | Path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public API | `packages/fullmag-py/src/fullmag/world.py` | `class StudyMeshHandle` | `save`, `load`, `save_or_load`, `export`, `import_` | FEM CPU/GPU | `test_mesh_persistence.py` |
| Native artifact | `packages/fullmag-py/src/fullmag/meshing/persistence.py` | `save_mesh_artifact` | Atomic container writer | FEM CPU/GPU | Native round-trip and corruption tests |
| Native validation | `packages/fullmag-py/src/fullmag/meshing/persistence.py` | `load_mesh_artifact` | Digest, fingerprint, topology, and semantic validation | FEM CPU/GPU | Mismatch/corruption tests |
| COMSOL export | `packages/fullmag-py/src/fullmag/meshing/persistence.py` | `export_comsol_mesh` | COMSOL MPHTXT v4 and sidecar writer | FEM CPU/GPU | COMSOL interchange tests |
| COMSOL import | `packages/fullmag-py/src/fullmag/meshing/persistence.py` | `import_comsol_mesh` | MPHTXT v4 parser, entity mapping, validation, and new identity | FEM CPU/GPU | COMSOL interchange tests |
| Mixed volume evidence | `crates/fullmag-ir/src/mesh_assets.rs` | `validate_mixed_certificate_evidence_against_mesh` | Recomputes certificate evidence and distinguishes cross-language rounding tolerance from the physical volume-acceptance limit | FEM CPU/GPU | `fullmag-ir` mixed-certificate regression tests and managed SP4 two-stage smoke |
| Gmsh export | `packages/fullmag-py/src/fullmag/meshing/persistence.py` | `export_gmsh_mesh` | Gmsh 4.1 and sidecar writer | FEM CPU/GPU | Interchange tests |
| Gmsh import | `packages/fullmag-py/src/fullmag/meshing/persistence.py` | `import_gmsh_mesh` | Unit conversion, group mapping, new identity | FEM CPU/GPU | Interchange and air-marker tests |
| Typed topology | `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py` | `class MeshData` | Canonical arrays, validation, fingerprints, quality serialization | FEM CPU/GPU | Persistence and meshing tests |
| IR ingress | `packages/fullmag-py/src/fullmag/model/problem.py` | `build_geometry_assets_for_request` | Inline persisted mesh in `FemDomainMeshAssetIR` | FEM CPU/GPU | Materialization test |
