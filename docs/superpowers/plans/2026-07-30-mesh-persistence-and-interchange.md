# Mesh Persistence and Interchange Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lossless FEM mesh persistence through `study.mesh.save/load/save_or_load` and explicit Gmsh `.msh` interchange through `study.mesh.export/import_`.

**Architecture:** Keep `MeshData` as the only topology model. Add a native ZIP artifact and Gmsh conversion layer in one focused meshing module, then expose it through a `StudyMeshHandle` that binds loaded topology into the existing explicit shared-domain asset path.

**Tech Stack:** Python 3, NumPy, meshio/Gmsh 4.1, existing Fullmag Python DSL and Rust `MeshIR` validation, unittest/pytest, container-backed `just` FEM verification.

## Global Constraints

- Native `.fullmag-mesh` is lossless and authoritative for reuse; `.msh` is interchange only.
- Mesh authoring configuration remains distinct from the derived solver mesh.
- Every loaded/imported topology passes Python strict validation and Rust `validate_mesh_ir`.
- Imported geometry source identity uses content SHA-256 rather than mtime alone.
- `load()` never regenerates; only `save_or_load()` rebuilds for missing or mismatched artifacts.
- Corrupt or unsupported artifacts fail closed and are never silently overwritten.
- Native FEM runtime proof uses repository container-backed `just` recipes.

---

### Task 1: Native artifact and authoring fingerprint

**Files:**
- Create: `packages/fullmag-py/src/fullmag/meshing/persistence.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/__init__.py`
- Test: `packages/fullmag-py/tests/test_mesh_persistence.py`

**Interfaces:**
- Produces: `MeshArtifact`, `MeshArtifactManifest`, `MeshConfigurationMismatch`, `mesh_authoring_document(...)`, `mesh_authoring_fingerprint(...)`, `save_mesh_artifact(...)`, `load_mesh_artifact(...)`.

- [ ] Write tests constructing a typed mixed mesh and asserting native round-trip of topology, region maps, object-region maps, build report, quality payloads, digests, and fingerprints.
- [ ] Run `python3 -m pytest packages/fullmag-py/tests/test_mesh_persistence.py -k 'native or fingerprint' -q` and confirm failure because the persistence API is absent.
- [ ] Implement canonical JSON normalization and SHA-256 fingerprinting over geometry IR, imported-source content, FEM/universe/workflow/object-region inputs.
- [ ] Implement deterministic ZIP members `manifest.json`, `topology.npz`, and optional `build-report.json`, using temporary sibling files plus `os.replace()` for atomic publication.
- [ ] Implement strict schema, member digest, semantic-map, topology-fingerprint, `MeshData`, and Rust `MeshIR` validation on load.
- [ ] Extend `MeshData.save/load` so `quality` and `per_domain_quality` round-trip through native serialization.
- [ ] Re-run the focused tests and expect all selected tests to pass.

### Task 2: Gmsh interchange

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/meshing/persistence.py`
- Test: `packages/fullmag-py/tests/test_mesh_persistence.py`

**Interfaces:**
- Produces: `export_gmsh_mesh(artifact, path) -> Path`, `import_gmsh_mesh(path, *, region_map, boundary_map, coordinate_unit) -> MeshArtifact`.

- [ ] Add failing tests for tet and mixed prism/pyramid/tet export/import, Physical Group recovery, sidecar digest validation, marker renumbering, missing units, missing maps, and unsupported higher-order elements.
- [ ] Run the interchange subset and confirm expected failures from missing functions.
- [ ] Convert canonical CSR cell/facet blocks to meshio blocks with `gmsh:physical` and `gmsh:geometrical` data plus `field_data` names.
- [ ] Write Gmsh 4.1 and `<mesh>.fullmag.json` atomically; include marker/name maps, units, topology fingerprint, global ordinals, mesh parts, periodic descriptors, and `.msh` digest.
- [ ] Import supported linear blocks through the existing `_read_mesh_file()` ingress, resolve semantic mappings from sidecar/Physical Groups/explicit arguments, derive new ordinals and fingerprint, and reject ambiguous or unsupported inputs.
- [ ] Re-run the interchange tests and expect them to pass.

### Task 3: Public `study.mesh` API and materialization binding

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py`
- Test: `packages/fullmag-py/tests/test_api.py`
- Test: `packages/fullmag-py/tests/test_mesh_persistence.py`

**Interfaces:**
- Produces: `StudyMeshHandle.save`, `load`, `save_or_load`, `export`, `import_`; `MeshPersistenceResult(action, path, topology_fingerprint, authoring_fingerprint, mismatch_reasons)`.

- [ ] Add failing public-API tests that configure a small shared-domain study and exercise all five methods, including a second `save_or_load()` call that proves the mesher is not invoked.
- [ ] Run the focused API tests and confirm failure because `study.mesh` still raises the migration error.
- [ ] Replace the `StudyBuilder.mesh()` migration method with a `StudyMeshHandle` attribute while keeping per-object sizing under existing APIs.
- [ ] Refactor `_build_explicit_mesh_assets()` to return/cache the realized asset, and add a single helper that builds the current normalized authoring document.
- [ ] On native load/import, bind the accepted artifact as an explicit shared-domain source with semantic maps and provenance; ensure later Problem construction consumes it without Gmsh.
- [ ] Implement save/load/save-or-load error behavior and result objects exactly as specified.
- [ ] Re-run focused API and persistence tests and expect them to pass.

### Task 4: Scientific and round-trip documentation

**Files:**
- Modify: `docs/physics/0100-mesh-and-region-discretization.md`
- Create: `docs/physics/0100-mesh-and-region-discretization.source-map.json`
- Modify: `docs/specs/mesh-roundtrip-semantics-v1.md`
- Test: `.agents/skills/scientific-documentation-contract/scripts/test_*.py`

**Interfaces:**
- Documents the exact Python API, native/interchange split, fingerprint inputs, ProblemIR mapping, provenance, support matrix, limitations, and source symbols.

- [ ] Update the canonical physics page with required labels, SI symbol table, complete API parameter table, executable `# %%` example, FDM/FEM CPU/GPU matrix, failure semantics, and source index.
- [ ] Add/update its source map with stable path-plus-symbol identities for every implementation claim.
- [ ] Correct the round-trip spec's obsolete v1 route and add native/interchange semantics.
- [ ] Run the scientific documentation validator and unit tests; expect zero validation errors.

### Task 5: Regression and managed verification

**Files:**
- Test: `packages/fullmag-py/tests/test_mesh_persistence.py`
- Test: `packages/fullmag-py/tests/test_api.py`
- Verify: repository `justfile`

**Interfaces:**
- Consumes all preceding tasks; produces evidence for the full public contract.

- [ ] Run `python3 -m pytest packages/fullmag-py/tests/test_mesh_persistence.py packages/fullmag-py/tests/test_api.py -q` and resolve every relevant failure.
- [ ] Run `python3 -m pytest packages/fullmag-py/tests/test_meshing.py -q` to detect topology and shared-domain regressions.
- [ ] Run `python3 -m py_compile` for every modified Python source.
- [ ] Run the matching container-backed `just verify-fem-meshing-production` contract and a small managed build/load runtime smoke, confirming the second run contains no Gmsh meshing phase.
- [ ] Audit the design requirement by requirement, inspect `git diff --check`, and report any unsupported COMSOL subset explicitly rather than overclaiming it.
