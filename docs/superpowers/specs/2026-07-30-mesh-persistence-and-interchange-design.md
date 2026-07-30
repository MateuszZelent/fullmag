# Mesh Persistence and Interchange Design

**Status:** implemented; COMSOL qualification corrected against official 6.4 formats
**Date:** 2026-07-30  
**Scope:** FEM solver meshes, including shared magnetic-domain and airbox meshes

## 1. Goal

Avoid repeating an unchanged FEM mesh build while preserving enough topology,
semantic markers, provenance, and validation evidence to execute the loaded mesh
exactly as a newly materialized mesh. Keep the lossless Fullmag persistence
contract separate from the Gmsh/COMSOL interchange contract.

The public script surface is:

```python
study.mesh.save("mesh.fullmag-mesh")
study.mesh.load("mesh.fullmag-mesh")
study.mesh.save_or_load("mesh.fullmag-mesh")

study.mesh.export("mesh.mphtxt")       # direct COMSOL interchange
study.mesh.export("mesh.msh")          # general Gmsh interchange
study.mesh.import_("mesh.mphtxt")
study.mesh.import_("mesh.msh", region_map={...}, boundary_map={...})
```

`save_or_load()` loads only when the saved authoring fingerprint matches the
current script. A missing or stale file triggers one ordinary mesh build and an
atomic replacement of the native artifact.

## 2. Existing seams to preserve

The implementation extends rather than replaces these current contracts:

- `MeshData` already owns typed variable-arity FEM topology, strict validation,
  topology fingerprints, native `.npz`/`.json` serialization, periodic data,
  realization reports, and mixed-layer certificates in
  `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`.
- `_fem_mesh_cache_key()` and `_fem_mesh_cache_dir()` already provide an
  internal generated-mesh cache in
  `packages/fullmag-py/src/fullmag/model/problem.py`.
- `StudyBuilder.domain_mesh()` already declares an explicit shared-domain mesh
  plus region-marker maps in `packages/fullmag-py/src/fullmag/world.py`.
- `FemDomainMeshAssetIR` already transports the mesh, geometry-region markers,
  object-region markers, and shared-domain build report in
  `crates/fullmag-ir/src/mesh_assets.rs`.
- `MeshIR` is the execution topology contract in
  `crates/fullmag-ir/src/mesh_hints.rs`.
- `docs/specs/mesh-roundtrip-semantics-v1.md` keeps authoring configuration
  distinct from the derived solver mesh. Persistence must not replace or erase
  the authored universe and per-object mesh settings.

The existing cache currently covers per-geometry realization but does not
provide a user-named, portable shared-domain artifact with a manifest. The new
feature makes that capability explicit without introducing a second topology
model.

## 3. Public API ownership

`StudyBuilder` gains one `StudyMeshHandle` at `study.mesh`. It owns persistence
and interchange for the single solver mesh of the current study. It does not
own per-object sizing; `body.mesh(...)`, `study.universe.mesh(...)`, and
`study.objects.mesh.defaults(...)` remain the authoring controls.

### 3.1 `study.mesh.save(path)`

- Requires a realized mesh. If no explicit `study.build_domain_mesh()` has run,
  it materializes the current study mesh once before saving.
- Writes a native `.fullmag-mesh` artifact atomically.
- Returns the resolved `Path`.
- Never exports `.msh`; a `.msh` suffix is rejected with guidance to use
  `study.mesh.export()`.

### 3.2 `study.mesh.load(path)`

- Loads only the native `.fullmag-mesh` contract.
- Validates schema compatibility, payload digests, topology, markers,
  certificates, and current authoring fingerprint before accepting the mesh.
- On fingerprint mismatch, raises a structured `MeshConfigurationMismatch`
  that reports which canonical input sections differ.
- Never silently regenerates and never partially reuses a mismatched mesh.
- Binds the accepted mesh as the current study's explicit shared-domain asset,
  preserving the authored configuration separately for round-trip and
  provenance.

### 3.3 `study.mesh.save_or_load(path)`

- If the native artifact exists and matches, loads it without invoking Gmsh.
- If it is absent or its authoring fingerprint differs, builds once and
  atomically saves/replaces it.
- Corruption, unsupported schema versions, invalid topology, missing marker
  maps, and failed certificates are hard errors. They do not trigger automatic
  overwrite, because replacing a damaged scientific artifact would hide the
  failure.
- Returns a result with `action` equal to `"loaded"` or `"saved"`, the native
  path, topology fingerprint, authoring fingerprint, and mismatch reasons when
  regeneration occurred.

### 3.4 `study.mesh.export(path, format="auto")`

- Exports `.mphtxt` as COMSOL Multiphysics native text Mesh serialization v4.
- Exports `.msh` as Gmsh 4.1 for general mesh-tool interchange; `.msh` is not
  claimed as a directly supported COMSOL import format.
- Writes linear supported volume cells (`tet4`, `prism6`, `pyramid5`, `hex8`)
  and boundary facets (`tri3`, `quad4`) without changing node coordinates or
  connectivity.
- Encodes named Physical Volumes and Physical Surfaces derived from canonical
  Fullmag semantic maps.
- Writes `<path>.fullmag.json` as an interchange sidecar containing stable
  Fullmag names, global ordinals, units, topology fingerprint, marker mapping,
  mesh-part mapping, periodic-pair descriptors, source native-artifact identity,
  and a digest of the `.msh` payload.
- Export is not a solver-cache operation. Lossless reload continues to use the
  native artifact.

### 3.5 `study.mesh.import_(path, ...)`

- Imports COMSOL `.mphtxt` Mesh serialization v4 or Gmsh 4.1 `.msh`.
- Requires explicit `region_map` and `boundary_map` when stable semantic names
  cannot be recovered unambiguously from Physical Groups or a matching sidecar.
- Treats connectivity, node ordering, element ordering, marker IDs, and boundary
  topology as potentially changed. It assigns a new Fullmag mesh identity and
  recomputes global ordinals and topology fingerprint.
- Re-derives facet roles and mesh parts, then runs the same strict execution
  validation as a generated mesh.
- Invalidates generation-specific periodic and mixed-layer certificates unless
  they can be recomputed and proven against the imported topology. It never
  copies stale certificates from the sidecar.
- Produces a native `.fullmag-mesh` artifact only when the caller subsequently
  invokes `save()` or requests an explicit native destination.

## 4. Native artifact contract

`.fullmag-mesh` is a ZIP container with deterministic member names:

```text
mesh.fullmag-mesh
├── manifest.json
├── topology.npz
└── build-report.json
```

`build-report.json` is omitted only when the source mesh legitimately has no
Gmsh build report, such as a validated external import. The manifest records
that absence explicitly.

### 4.1 `topology.npz`

This member uses the existing `MeshData` typed arrays and metadata:

- node coordinates in metres;
- cell types, CSR offsets/connectivity, immutable global ordinals, semantic
  mesh-part classification, and element markers;
- facet types, roles, CSR offsets/connectivity, immutable global ordinals, and
  boundary markers;
- periodic boundary and node pairs;
- periodic mesh certificate when valid;
- mesh realization report when available;
- mixed-layer topology certificate when valid;
- quality and per-domain quality payloads when available.

The implementation must first close the current serialization gap: native
`MeshData.save/load` must round-trip quality and per-domain quality rather than
dropping them.

### 4.2 `manifest.json`

The manifest uses `fullmag.mesh-artifact.v1` and contains:

- artifact schema and minimum reader version;
- SI coordinate unit fixed to `m`;
- creation timestamp as provenance, excluded from deterministic identity;
- artifact, authoring, and topology-fingerprint schema versions;
- mesh name and topology identity;
- SHA-256 digest and byte length of every member;
- topology fingerprint and its version;
- authoring fingerprint and the normalized input document used to compute it;
- `region_markers` mapping geometry/object names to volume markers;
- `object_region_markers` for authored subregions;
- boundary semantic map for outer, interface, periodic, and selected surfaces;
- mesh-part semantics and periodic certificates inside `topology.npz`;
- build-report presence;
- provenance identifying generated, native-loaded, or external-imported origin.

Digest failures, incomplete or colliding semantic maps, unsupported major schema
versions, and invalid strict `MeshData`/Rust `MeshIR` topology fail closed.

## 5. Authoring fingerprint

The authoring fingerprint is distinct from the topology fingerprint:

- the topology fingerprint answers whether two realized meshes are byte-level
  equivalent under the canonical typed topology contract;
- the authoring fingerprint answers whether the current script requested the
  same mesh-producing inputs.

`fullmag.mesh-authoring-fingerprint.v1` is SHA-256 over canonical JSON containing:

1. canonical geometry IR for every participating object;
2. content SHA-256 for imported geometry sources, never only path or mtime;
3. requested backend/discretization and FEM mesh source/order settings;
4. universe bounds, centre, padding, and airbox mesh policy;
5. per-object and default mesh controls;
6. size fields, region-local controls, operations, selectors, swept/mixed mesh
   policies, and periodic pairing intent;
7. authored object-region topology relevant to element markers;
8. mesher algorithm options that can change topology;
9. schema and mesher compatibility versions.

Materials, initial magnetization, solver tolerances, output schedules,
visualization settings, and study stages are excluded because they do not
determine the mesh. Changing any included section makes `load()` fail and makes
`save_or_load()` rebuild.

The manifest stores the normalized input document as well as its digest so the
user receives a section-level mismatch report instead of only two unrelated
hashes.

## 6. Materialization and provenance flow

```text
Python mesh authoring
        |
        v
normalized mesh input document -> authoring fingerprint
        |
        +---- native artifact exists ---- validate container/digests/topology
        |                                      |
        |                               compare fingerprint
        |                                      |
        |                                accept or reject
        |
        +---- missing/stale under save_or_load ---- Gmsh build
                                                   |
                                                   v
                              FemDomainMeshAssetIR + atomic native save
```

The accepted native mesh enters the existing `fem_domain_mesh_asset` path. The
Rust planner and runner still validate `MeshIR`; Python-side container
validation is not a substitute for execution validation. Runtime provenance
must state whether the mesh was generated, loaded from a native artifact, or
imported from interchange, and record both fingerprints.

## 7. COMSOL interoperability boundary

COMSOL `.mphtxt` Mesh serialization v4 is the direct interoperability baseline.
COMSOL 6.4 officially lists `.mphtxt` and `.mphbin`, but not Gmsh `.msh`, as
native mesh import formats. Gmsh remains a separate open interchange option.
For a mesh returned by current COMSOL, export MPHTXT with `fileversion=v44`;
Mesh serialization v64 is rejected until a dedicated parser and fixture exist.
The design does not claim preservation of proprietary mesh-operation history,
curved higher-order elements, or solver features.

The first production slice supports linear 3D volume cells and linear boundary
facets already represented by `MeshData`. Higher-order elements fail with an
enumerated unsupported-element diagnostic. Unit conversion is explicit on
import; absent unit metadata defaults are forbidden.

Round-trip acceptance requires:

- node coordinates remain finite and expressed in metres after conversion;
- every volume cell has exactly one resolved Fullmag region;
- magnetic and air domains remain mutually exclusive and collectively complete;
- required magnetic-air interfaces are present and conforming;
- every boundary selection referenced by the script resolves after import;
- all supported elements have positive orientation after canonical reordering;
- the imported topology passes Rust `MeshIR` validation and focused managed FEM
  runtime smoke verification.

COMSOL may renumber nodes, cells, and geometric entities. Without a matching
sidecar the import requires semantic maps plus explicit external-entity maps.
Equality after COMSOL round-trip
is therefore semantic and geometric within declared tolerances, not identity of
the original topology fingerprint.

## 8. Failure behavior

- Missing native file in `load()`: `FileNotFoundError`.
- Wrong suffix/format: explicit API guidance, never format guessing between
  native persistence and interchange.
- Authoring mismatch: `MeshConfigurationMismatch` with normalized section diff.
- Truncated member or digest mismatch: `MeshArtifactCorruptionError`.
- Unsupported schema: `MeshArtifactVersionError`.
- Missing/ambiguous external Physical Groups: `MeshSemanticMappingError`.
- Unsupported or higher-order external cells: existing
  `UnsupportedGmshElementError` enriched with block and physical-group context.
- Invalid topology, markers, orientation, periodicity, or certificate:
  validation error before the artifact reaches the planner.

No failure silently falls back to regeneration except the documented stale or
missing case inside `save_or_load()`.

## 9. Validation strategy

### 9.1 Pure-data tests

- Native save/load preserves every `MeshData` field, marker map, report,
  certificate, fingerprint, and digest.
- Mutating each mesh-producing input section changes the authoring fingerprint;
  mutating materials, initial state, outputs, or solver tolerances does not.
- Corruption, schema drift, missing maps, and stale certificates fail closed.
- `save_or_load()` proves that a matching second run never calls the mesher.
- Atomic replacement leaves the previous valid artifact intact when writing
  fails.

### 9.2 Interchange tests

- Fullmag -> Gmsh -> Fullmag preserves supported cell/facet families, coordinates,
  region names, boundary names, and semantic partitioning.
- Fixtures cover tetrahedral and mixed prism/pyramid/tetrahedron shared-domain
  meshes.
- Renumbered but semantically equivalent `.msh` imports successfully with a new
  identity.
- Missing units, missing Physical Groups, marker collisions, and higher-order
  elements fail with actionable diagnostics.
- A checked-in provenance-pinned Mesh serialization v4 fixture created by
  COMSOL covers complete `vtx`, `edg`, `tri`, and `tet` output. It qualifies the
  importer against actual COMSOL output, but does not by itself prove execution
  of a Fullmag-to-COMSOL-to-Fullmag round-trip in the proprietary application.

### 9.3 End-to-end proof

Use the repository container-backed `just` route for FEM verification. A small
shared-domain example must demonstrate:

1. first run builds and saves;
2. second run loads without Gmsh meshing logs;
3. generated and loaded plans have the same canonical topology fingerprint,
   region partition, boundary semantics, and solver result within the existing
   deterministic tolerance;
4. changing one mesh size causes `save_or_load()` to rebuild;
5. native-loaded, Gmsh-imported, and Fullmag-produced MPHTXT-imported meshes each
   pass the managed FEM runtime smoke appropriate to their supported topology.

Step 5 and the COMSOL-created fixture qualify Fullmag's serializer/parser and
runtime binding. They do not claim that the proprietary COMSOL application was
executed during Fullmag CI.

## 10. Documentation and compatibility

- Update `docs/physics/0100-mesh-and-region-discretization.md` as the canonical
  scientific owner of persistence and interchange semantics.
- Update `docs/specs/mesh-roundtrip-semantics-v1.md` to replace its removed v1
  endpoint language and add native-artifact versus interchange round-trip.
- Document complete Python examples, parameter tables, `ProblemIR` mapping,
  source map, backend support matrix, provenance, limitations, and COMSOL
  qualification under the scientific documentation contract.
- Existing automatic cache behaviour remains enabled. Native user artifacts are
  explicit and portable; internal cache entries remain disposable and private.
- Legacy standalone `.npz` and MeshIR `.json` inputs remain supported at their
  existing lower-level seams but are not accepted as `.fullmag-mesh` without an
  explicit migration/import operation.

## 11. Non-goals for the first implementation

- Persisting FDM grids through this FEM mesh API.
- Preserving proprietary COMSOL mesh-operation history or named selections not
  represented as Physical Groups.
- Higher-order curved elements.
- Automatic geometric equivalence matching when region names are absent.
- Reusing only part of a stale shared-domain mesh; frozen magnetic-submesh reuse
  remains its existing separate workflow.
- Making the persisted solver mesh the source of authoring truth.

## 12. Design decision

Use one lossless native artifact plus one explicit interchange format. A single
`.msh` file cannot safely serve both roles because standard Gmsh containers do
not carry every Fullmag certificate, provenance field, authoring input, and
semantic round-trip invariant. The native container is authoritative for
`save/load/save_or_load`; `.mphtxt` and `.msh` plus their sidecars are
authoritative only for their documented interchange subsets.
